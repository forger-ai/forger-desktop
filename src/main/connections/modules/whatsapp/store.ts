import fs from 'node:fs/promises';
import path from 'node:path';
import type { Database as SqliteDatabase } from 'better-sqlite3';
import { loadOptionalBetterSqlite } from '../../../runtime/optional-better-sqlite';
import type {
  WhatsAppAttachmentDownloadStatus,
  WhatsAppAttachmentKind,
  WhatsAppChatType,
  WhatsAppIndexedChat,
  WhatsAppIndexedMessage,
  WhatsAppMessageAttachment,
  WhatsAppStableMessageRef,
  WhatsAppStorageStatus,
} from './types';
import { decodeStableMessageRef, encodeStableMessageRef, phoneNumberFromJid } from './normalizer';

interface ChatRow {
  chat_id: string;
  chat_type: WhatsAppChatType;
  title: string | null;
  contact_name: string | null;
  phone_number: string | null;
  last_message_ref: string | null;
  unread_count: number | null;
  is_muted: number | null;
  updated_at: string;
}

interface MessageRow {
  stable_ref: string;
  chat_id: string;
  chat_type: WhatsAppChatType;
  sender_id: string | null;
  sender_display_name: string | null;
  from_me: number;
  timestamp: number | null;
  text: string | null;
  message_type: string;
  is_group: number;
  is_channel: number;
  has_attachments: number;
}

interface AttachmentRow {
  attachment_id: string;
  stable_ref: string;
  chat_id: string;
  kind: WhatsAppAttachmentKind;
  message_type: string;
  mime_type: string | null;
  file_name: string | null;
  caption: string | null;
  size_bytes: number | null;
  sha256: string | null;
  download_status: WhatsAppAttachmentDownloadStatus;
  local_path: string | null;
  downloaded_at: string | null;
  error: string | null;
  raw_message_json: string | null;
}

export class WhatsAppLocalStore {
  private db: SqliteDatabase | null = null;
  private loaded = false;

  constructor(private readonly metadataRoot: string) {}

  async load(): Promise<void> {
    if (this.loaded) {
      return;
    }
    await fs.mkdir(this.dataDirectory(), { recursive: true, mode: 0o700 });
    await fs.mkdir(this.downloadsDirectory(), { recursive: true, mode: 0o700 });
    const BetterSqlite3 = loadOptionalBetterSqlite();
    if (!BetterSqlite3) {
      throw new Error('whatsapp_sqlite_unavailable');
    }
    this.db = new BetterSqlite3(this.databasePath());
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.migrate();
    this.loaded = true;
  }

  async listChats(input: { chatType?: WhatsAppChatType; query?: string; limit?: number; cursor?: string; identityAccountId?: string }): Promise<{ chats: WhatsAppIndexedChat[]; nextCursor?: string }> {
    await this.load();
    const limit = clampLimit(input.limit, 25, 100);
    const offset = parseCursor(input.cursor);
    const clauses: string[] = [];
    const params: Record<string, string | number> = { limit, offset };
    if (input.chatType) {
      clauses.push('chats.chat_type = @chatType');
      params.chatType = input.chatType;
    }
    const query = normalizeQuery(input.query);
    if (query) {
      // Keep text search intact; normalize only queries consisting of phone punctuation/digits.
      const phoneQuery = /^[+\d\s().-]+$/.test(query) ? query.replace(/\D/g, '') : '';
      clauses.push(`(
        lower(coalesce(chats.chat_id, '')) LIKE @query
        OR lower(coalesce(chats.title, '')) LIKE @query
        OR lower(coalesce(chats.contact_name, '')) LIKE @query
        OR lower(coalesce(chats.phone_number, '')) LIKE @query
        OR (@phoneQuery != '' AND chats.phone_number LIKE @phoneQuery)
        OR EXISTS (
          SELECT 1 FROM identity_pairs
          LEFT JOIN chats AS equivalent ON equivalent.chat_id = CASE
            WHEN identity_pairs.phone_id = chats.chat_id THEN identity_pairs.lid ELSE identity_pairs.phone_id END
          WHERE identity_pairs.account_id = @identityAccountId AND identity_pairs.valid = 1
          AND (identity_pairs.phone_id = chats.chat_id OR identity_pairs.lid = chats.chat_id)
          AND ((@phoneQuery != '' AND substr(identity_pairs.phone_id, 1, instr(identity_pairs.phone_id, '@') - 1) LIKE @phoneQuery)
            OR lower(coalesce(equivalent.contact_name, '')) LIKE @query)
        )
        OR EXISTS (
          SELECT 1 FROM chat_aliases
          WHERE chat_aliases.chat_id = chats.chat_id
          AND lower(chat_aliases.alias) LIKE @query
        )
      )`);
      params.query = `%${query}%`;
      params.phoneQuery = phoneQuery ? `%${phoneQuery}%` : '';
      params.identityAccountId = input.identityAccountId ?? '';
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.requireDb().prepare(`
      SELECT chats.*
      FROM chats
      ${where}
      ORDER BY chats.updated_at DESC
      LIMIT @limit OFFSET @offset
    `).all(params) as ChatRow[];
    const total = this.requireDb().prepare(`
      SELECT COUNT(*) AS count
      FROM chats
      ${where}
    `).get(params) as { count: number };
    const chats = rows.map((row) => this.rowToChat(row));
    const nextOffset = offset + chats.length;
    return {
      chats,
      ...(nextOffset < total.count ? { nextCursor: String(nextOffset) } : {}),
    };
  }

  async readMessages(input: { chatId: string; identityIds?: string[]; limit?: number; beforeMessageRef?: string }): Promise<WhatsAppIndexedMessage[]> {
    await this.load();
    const ids = [...new Set([input.chatId, ...(input.identityIds ?? [])])];
    const identityParams = Object.fromEntries(ids.map((id, index) => [`chat${index}`, id]));
    const chatScope = `chat_id IN (${ids.map((_, index) => `@chat${index}`).join(', ')})`;
    const limit = clampLimit(input.limit, 25, 500);
    const before = decodeStableMessageRef(input.beforeMessageRef);
    const beforeRow = before
      ? this.requireDb().prepare(`SELECT timestamp, stable_ref FROM messages WHERE stable_ref = @ref AND ${chatScope}`)
        .get({ ...identityParams, ref: encodeStableMessageRef(before) }) as { timestamp: number | null; stable_ref: string } | undefined
      : undefined;
    if (before && !beforeRow) return [];
    const params: Record<string, string | number | null> = {
      ...identityParams,
      limit,
      beforeTimestamp: beforeRow?.timestamp ?? null,
      beforeRef: beforeRow?.stable_ref ?? null,
    };
    const beforeClause = beforeRow
      ? 'AND (coalesce(timestamp, 0) < coalesce(@beforeTimestamp, 0) OR (coalesce(timestamp, 0) = coalesce(@beforeTimestamp, 0) AND stable_ref < @beforeRef))'
      : '';
    const rows = this.requireDb().prepare(`
      SELECT *
      FROM messages
      WHERE ${chatScope}
      ${beforeClause}
      ORDER BY coalesce(timestamp, 0) DESC, stable_ref DESC
      LIMIT @limit
    `).all(params) as MessageRow[];
    return rows.map((row) => this.rowToMessage(row));
  }

  /** A conflicting association is permanently quarantined until local connection data is reset. */
  async rememberIdentityPair(accountId: string, phoneId: string, lid: string): Promise<void> {
    await this.load();
    this.requireDb().transaction(() => {
      const conflicts = this.requireDb().prepare(`SELECT 1 FROM identity_pairs
        WHERE account_id = ? AND (phone_id = ? OR lid = ?)
        AND (phone_id != ? OR lid != ? OR valid = 0)`).get(accountId, phoneId, lid, phoneId, lid);
      this.requireDb().prepare(`INSERT OR IGNORE INTO identity_pairs (account_id, phone_id, lid, valid)
        VALUES (?, ?, ?, ?)`).run(accountId, phoneId, lid, conflicts ? 0 : 1);
      if (conflicts) this.requireDb().prepare(`UPDATE identity_pairs SET valid = 0
        WHERE account_id = ? AND (phone_id = ? OR lid = ?)`).run(accountId, phoneId, lid);
    })();
  }

  async invalidateIdentity(accountId: string, id: string): Promise<void> {
    await this.load();
    this.requireDb().prepare(`UPDATE identity_pairs SET valid = 0
      WHERE account_id = ? AND (phone_id = ? OR lid = ?)`).run(accountId, id, id);
  }

  async identityIds(accountId: string, id: string): Promise<string[]> {
    await this.load();
    const rows = this.requireDb().prepare(`SELECT phone_id, lid, valid FROM identity_pairs
      WHERE account_id = ? AND (phone_id = ? OR lid = ?)`)
      .all(accountId, id, id) as Array<{ phone_id: string; lid: string; valid: number }>;
    if (rows.length !== 1 || rows[0].valid !== 1) return [id];
    return [...new Set([id, rows[0].phone_id, rows[0].lid])];
  }

  async getChat(chatId: string): Promise<WhatsAppIndexedChat | null> {
    await this.load();
    const row = this.requireDb().prepare('SELECT * FROM chats WHERE chat_id = ?').get(chatId) as ChatRow | undefined;
    return row ? this.rowToChat(row) : null;
  }

  async upsertChat(chat: WhatsAppIndexedChat): Promise<void> {
    await this.load();
    this.requireDb().prepare(`
      INSERT INTO chats (chat_id, chat_type, title, contact_name, phone_number, last_message_ref, unread_count, is_muted, updated_at)
      VALUES (@chatId, @chatType, @title, @contactName, @phoneNumber, @lastMessageRef, @unreadCount, @isMuted, @updatedAt)
      ON CONFLICT(chat_id) DO UPDATE SET
        chat_type = excluded.chat_type,
        title = coalesce(excluded.title, chats.title),
        contact_name = coalesce(excluded.contact_name, chats.contact_name),
        phone_number = coalesce(excluded.phone_number, chats.phone_number),
        last_message_ref = coalesce(excluded.last_message_ref, chats.last_message_ref),
        unread_count = coalesce(excluded.unread_count, chats.unread_count),
        is_muted = coalesce(excluded.is_muted, chats.is_muted),
        updated_at = excluded.updated_at
    `).run({
      chatId: chat.chatId,
      chatType: chat.chatType,
      title: chat.title ?? null,
      contactName: chat.contactName ?? null,
      phoneNumber: chat.phoneNumber ?? null,
      lastMessageRef: chat.lastMessageRef ? encodeStableMessageRef(chat.lastMessageRef) : null,
      unreadCount: chat.unreadCount ?? null,
      isMuted: chat.isMuted === undefined ? null : boolToInt(chat.isMuted),
      updatedAt: chat.updatedAt || new Date().toISOString(),
    });
    this.upsertAliases(chat.chatId, [chat.title, chat.phoneNumber, ...(chat.aliases ?? [])]);
  }

  async upsertMessages(messages: WhatsAppIndexedMessage[]): Promise<string[]> {
    await this.load();
    const insert = this.requireDb().transaction((items: WhatsAppIndexedMessage[]) => {
      const insertedRefs: string[] = [];
      const existingMessage = this.requireDb().prepare('SELECT 1 FROM messages WHERE stable_ref = ?');
      for (const message of items) {
        const stableRef = encodeStableMessageRef(message.stableMessageRef);
        if (!existingMessage.get(stableRef)) insertedRefs.push(stableRef);
        this.requireDb().prepare(`
          INSERT INTO chats (chat_id, chat_type, title, phone_number, last_message_ref, unread_count, is_muted, updated_at)
          VALUES (@chatId, @chatType, NULL, NULL, @lastMessageRef, NULL, NULL, @updatedAt)
          ON CONFLICT(chat_id) DO UPDATE SET
            chat_type = excluded.chat_type,
            last_message_ref = excluded.last_message_ref,
            updated_at = excluded.updated_at
        `).run({
          chatId: message.chatId,
          chatType: message.chatType,
          lastMessageRef: stableRef,
          updatedAt: new Date().toISOString(),
        });
        this.requireDb().prepare(`
          INSERT INTO messages (
            stable_ref, chat_id, chat_type, sender_id, sender_display_name, from_me, timestamp,
            text, message_type, is_group, is_channel, has_attachments
          )
          VALUES (
            @stableRef, @chatId, @chatType, @senderId, @senderDisplayName, @fromMe, @timestamp,
            @text, @messageType, @isGroup, @isChannel, @hasAttachments
          )
          ON CONFLICT(stable_ref) DO UPDATE SET
            chat_id = excluded.chat_id,
            chat_type = excluded.chat_type,
            sender_id = coalesce(excluded.sender_id, messages.sender_id),
            sender_display_name = coalesce(excluded.sender_display_name, messages.sender_display_name),
            from_me = excluded.from_me,
            timestamp = coalesce(excluded.timestamp, messages.timestamp),
            text = coalesce(excluded.text, messages.text),
            message_type = excluded.message_type,
            is_group = excluded.is_group,
            is_channel = excluded.is_channel,
            has_attachments = excluded.has_attachments
        `).run({
          stableRef,
          chatId: message.chatId,
          chatType: message.chatType,
          senderId: message.senderId ?? null,
          senderDisplayName: message.senderDisplayName ?? null,
          fromMe: boolToInt(message.fromMe),
          timestamp: message.timestamp ?? null,
          text: message.text ?? null,
          messageType: message.messageType,
          isGroup: boolToInt(message.isGroup),
          isChannel: boolToInt(message.isChannel),
          hasAttachments: boolToInt(message.hasAttachments),
        });
        for (const attachment of message.attachments) {
          this.upsertAttachment(attachment);
        }
      }
      return insertedRefs;
    });
    return insert(messages);
  }

  async rememberSend(stableMessageRef?: string): Promise<void> {
    await this.load();
    const now = new Date().toISOString();
    this.requireDb().transaction(() => {
      const write = this.requireDb().prepare(`
        INSERT INTO kv (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `);
      write.run('last_send_at', now);
      if (stableMessageRef) write.run(`outbound_message:${stableMessageRef}`, now);
    })();
  }

  async isKnownOutboundMessageRef(stableMessageRef: string): Promise<boolean> {
    await this.load();
    return Boolean(this.requireDb().prepare('SELECT 1 FROM kv WHERE key = ?').get(`outbound_message:${stableMessageRef}`));
  }

  async canSendNow(): Promise<boolean> {
    await this.load();
    const row = this.requireDb().prepare('SELECT value FROM kv WHERE key = ?').get('last_send_at') as { value: string } | undefined;
    if (!row?.value) {
      return true;
    }
    return Date.now() - Date.parse(row.value) > 1500;
  }

  encodeRef(ref: WhatsAppStableMessageRef): string {
    return encodeStableMessageRef(ref);
  }

  async getMessageInChat(stableRef: string, chatIds: string[]): Promise<WhatsAppIndexedMessage | null> {
    await this.load();
    const row = this.requireDb().prepare('SELECT * FROM messages WHERE stable_ref = ?').get(stableRef) as MessageRow | undefined;
    return row && chatIds.includes(row.chat_id) ? this.rowToMessage(row) : null;
  }

  async getAttachment(attachmentId: string): Promise<WhatsAppMessageAttachment | null> {
    await this.load();
    const row = this.requireDb().prepare('SELECT * FROM attachments WHERE attachment_id = ?').get(attachmentId) as AttachmentRow | undefined;
    return row ? this.rowToAttachment(row) : null;
  }

  async markAttachmentDownloaded(input: {
    attachmentId: string;
    localPath: string;
    sizeBytes?: number;
    sha256?: string;
  }): Promise<WhatsAppMessageAttachment | null> {
    await this.load();
    this.requireDb().prepare(`
      UPDATE attachments
      SET download_status = 'downloaded',
          local_path = @localPath,
          size_bytes = coalesce(@sizeBytes, size_bytes),
          sha256 = coalesce(@sha256, sha256),
          downloaded_at = @downloadedAt,
          error = NULL
      WHERE attachment_id = @attachmentId
    `).run({
      attachmentId: input.attachmentId,
      localPath: input.localPath,
      sizeBytes: input.sizeBytes ?? null,
      sha256: input.sha256 ?? null,
      downloadedAt: new Date().toISOString(),
    });
    return this.getAttachment(input.attachmentId);
  }

  async markAttachmentFailed(attachmentId: string, error: string): Promise<void> {
    await this.load();
    this.requireDb().prepare(`
      UPDATE attachments
      SET download_status = 'failed', error = @error
      WHERE attachment_id = @attachmentId
    `).run({ attachmentId, error });
  }

  async storageStatus(): Promise<WhatsAppStorageStatus> {
    await this.load();
    const counts = this.requireDb().prepare(`
      SELECT
        (SELECT COUNT(*) FROM chats) AS chatCount,
        (SELECT COUNT(*) FROM messages) AS messageCount,
        (SELECT COUNT(*) FROM attachments) AS attachmentCount,
        (SELECT COUNT(*) FROM attachments WHERE download_status = 'downloaded') AS downloadedAttachmentCount,
        (SELECT MAX(timestamp) FROM messages) AS lastMessageTimestamp
    `).get() as {
      chatCount: number;
      messageCount: number;
      attachmentCount: number;
      downloadedAttachmentCount: number;
      lastMessageTimestamp: number | null;
    };
    const lastSync = this.requireDb().prepare('SELECT value FROM kv WHERE key = ?').get('last_sync_at') as { value: string } | undefined;
    return {
      chatCount: counts.chatCount,
      messageCount: counts.messageCount,
      attachmentCount: counts.attachmentCount,
      downloadedAttachmentCount: counts.downloadedAttachmentCount,
      databaseBytes: await fileSize(this.databasePath()),
      downloadsBytes: await directorySize(this.downloadsDirectory()),
      ...(counts.lastMessageTimestamp ? { lastMessageAt: new Date(counts.lastMessageTimestamp * 1000).toISOString() } : {}),
      ...(lastSync?.value ? { lastSyncAt: lastSync.value } : {}),
    };
  }

  async clear(): Promise<void> {
    this.db?.close();
    this.db = null;
    this.loaded = false;
    await fs.rm(this.getToolRoot(), { recursive: true, force: true });
  }

  authDirectory(): string {
    return path.join(this.getToolRoot(), 'auth');
  }

  downloadsDirectory(): string {
    return path.join(this.getToolRoot(), 'downloads');
  }

  databasePath(): string {
    return path.join(this.dataDirectory(), 'whatsapp.sqlite');
  }

  private dataDirectory(): string {
    return path.join(this.getToolRoot(), 'data');
  }

  private getToolRoot(): string {
    return path.join(this.metadataRoot, 'connections', 'whatsapp');
  }

  private migrate(): void {
    this.requireDb().exec(`
      CREATE TABLE IF NOT EXISTS identity_pairs (
        account_id TEXT NOT NULL,
        phone_id TEXT NOT NULL,
        lid TEXT NOT NULL,
        valid INTEGER NOT NULL,
        PRIMARY KEY (account_id, phone_id, lid)
      );
      CREATE INDEX IF NOT EXISTS idx_identity_pairs_phone ON identity_pairs(account_id, phone_id);
      CREATE INDEX IF NOT EXISTS idx_identity_pairs_lid ON identity_pairs(account_id, lid);
      CREATE TABLE IF NOT EXISTS chats (
        chat_id TEXT PRIMARY KEY,
        chat_type TEXT NOT NULL,
        title TEXT,
        contact_name TEXT,
        phone_number TEXT,
        last_message_ref TEXT,
        unread_count INTEGER,
        is_muted INTEGER,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS chat_aliases (
        chat_id TEXT NOT NULL,
        alias TEXT NOT NULL,
        PRIMARY KEY (chat_id, alias),
        FOREIGN KEY (chat_id) REFERENCES chats(chat_id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS messages (
        stable_ref TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        chat_type TEXT NOT NULL,
        sender_id TEXT,
        sender_display_name TEXT,
        from_me INTEGER NOT NULL,
        timestamp INTEGER,
        text TEXT,
        message_type TEXT NOT NULL,
        is_group INTEGER NOT NULL,
        is_channel INTEGER NOT NULL,
        has_attachments INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY (chat_id) REFERENCES chats(chat_id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS attachments (
        attachment_id TEXT PRIMARY KEY,
        stable_ref TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        message_type TEXT NOT NULL,
        mime_type TEXT,
        file_name TEXT,
        caption TEXT,
        size_bytes INTEGER,
        sha256 TEXT,
        download_status TEXT NOT NULL,
        local_path TEXT,
        downloaded_at TEXT,
        error TEXT,
        raw_message_json TEXT,
        FOREIGN KEY (stable_ref) REFERENCES messages(stable_ref) ON DELETE CASCADE,
        FOREIGN KEY (chat_id) REFERENCES chats(chat_id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS kv (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_chats_type_updated ON chats(chat_type, updated_at);
      CREATE INDEX IF NOT EXISTS idx_chats_phone ON chats(phone_number);
      CREATE INDEX IF NOT EXISTS idx_chat_aliases_alias ON chat_aliases(alias);
      CREATE INDEX IF NOT EXISTS idx_messages_chat_timestamp ON messages(chat_id, timestamp);
      CREATE INDEX IF NOT EXISTS idx_attachments_stable_ref ON attachments(stable_ref);
      CREATE INDEX IF NOT EXISTS idx_attachments_chat ON attachments(chat_id);
    `);
    const columns = this.requireDb().prepare('PRAGMA table_info(chats)').all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === 'contact_name')) {
      this.requireDb().exec('ALTER TABLE chats ADD COLUMN contact_name TEXT');
    }
  }

  private rowToChat(row: ChatRow): WhatsAppIndexedChat {
    const aliases = this.requireDb().prepare('SELECT alias FROM chat_aliases WHERE chat_id = ? ORDER BY alias ASC').all(row.chat_id) as { alias: string }[];
    const lastMessageRef = decodeStableMessageRef(row.last_message_ref);
    return {
      chatId: row.chat_id,
      chatType: row.chat_type,
      ...(row.title ? { title: row.title } : {}),
      ...(row.contact_name ? { contactName: row.contact_name } : {}),
      ...(aliases.length > 0 ? { aliases: aliases.map((alias) => alias.alias) } : {}),
      ...(phoneNumberFromJid(row.chat_id) ? { phoneNumber: phoneNumberFromJid(row.chat_id) } : {}),
      ...(lastMessageRef ? { lastMessageRef } : {}),
      ...(typeof row.unread_count === 'number' ? { unreadCount: row.unread_count } : {}),
      ...(row.is_muted !== null ? { isMuted: row.is_muted === 1 } : {}),
      updatedAt: row.updated_at,
    };
  }

  private rowToMessage(row: MessageRow): WhatsAppIndexedMessage {
    const stableMessageRef = decodeStableMessageRef(row.stable_ref);
    if (!stableMessageRef) {
      throw new Error('whatsapp_stored_message_ref_invalid');
    }
    const attachments = this.requireDb()
      .prepare('SELECT * FROM attachments WHERE stable_ref = ? ORDER BY attachment_id ASC')
      .all(row.stable_ref) as AttachmentRow[];
    return {
      stableMessageRef,
      chatId: row.chat_id,
      chatType: row.chat_type,
      ...(row.sender_id ? { senderId: row.sender_id } : {}),
      ...(row.sender_display_name ? { senderDisplayName: row.sender_display_name } : {}),
      fromMe: row.from_me === 1,
      ...(row.timestamp ? { timestamp: row.timestamp } : {}),
      ...(row.text ? { text: row.text } : {}),
      messageType: row.message_type,
      isGroup: row.is_group === 1,
      isChannel: row.is_channel === 1,
      hasAttachments: row.has_attachments === 1,
      attachments: attachments.map((attachment) => this.rowToAttachment(attachment)),
    };
  }

  private rowToAttachment(row: AttachmentRow): WhatsAppMessageAttachment {
    const stableMessageRef = decodeStableMessageRef(row.stable_ref);
    if (!stableMessageRef) {
      throw new Error('whatsapp_stored_attachment_ref_invalid');
    }
    return {
      attachmentId: row.attachment_id,
      stableMessageRef,
      chatId: row.chat_id,
      kind: row.kind,
      messageType: row.message_type,
      ...(row.mime_type ? { mimeType: row.mime_type } : {}),
      ...(row.file_name ? { fileName: row.file_name } : {}),
      ...(row.caption ? { caption: row.caption } : {}),
      ...(typeof row.size_bytes === 'number' ? { sizeBytes: row.size_bytes } : {}),
      ...(row.sha256 ? { sha256: row.sha256 } : {}),
      downloaded: row.download_status === 'downloaded',
      downloadStatus: row.download_status,
      ...(row.local_path ? { localPath: row.local_path } : {}),
      ...(row.downloaded_at ? { downloadedAt: row.downloaded_at } : {}),
      ...(row.error ? { error: row.error } : {}),
      ...(row.raw_message_json ? { rawMessageJson: row.raw_message_json } : {}),
    };
  }

  private upsertAliases(chatId: string, values: Array<string | undefined>): void {
    const aliases = [...new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value)))];
    for (const alias of aliases) {
      this.requireDb().prepare(`
        INSERT OR IGNORE INTO chat_aliases (chat_id, alias) VALUES (?, ?)
      `).run(chatId, alias);
    }
  }

  private upsertAttachment(attachment: WhatsAppMessageAttachment): void {
    this.requireDb().prepare(`
      INSERT INTO attachments (
        attachment_id, stable_ref, chat_id, kind, message_type, mime_type, file_name, caption,
        size_bytes, sha256, download_status, local_path, downloaded_at, error, raw_message_json
      )
      VALUES (
        @attachmentId, @stableRef, @chatId, @kind, @messageType, @mimeType, @fileName, @caption,
        @sizeBytes, @sha256, @downloadStatus, @localPath, @downloadedAt, @error, @rawMessageJson
      )
      ON CONFLICT(attachment_id) DO UPDATE SET
        stable_ref = excluded.stable_ref,
        chat_id = excluded.chat_id,
        kind = excluded.kind,
        message_type = excluded.message_type,
        mime_type = coalesce(excluded.mime_type, attachments.mime_type),
        file_name = coalesce(excluded.file_name, attachments.file_name),
        caption = coalesce(excluded.caption, attachments.caption),
        size_bytes = coalesce(excluded.size_bytes, attachments.size_bytes),
        sha256 = coalesce(excluded.sha256, attachments.sha256),
        raw_message_json = coalesce(excluded.raw_message_json, attachments.raw_message_json)
    `).run({
      attachmentId: attachment.attachmentId,
      stableRef: encodeStableMessageRef(attachment.stableMessageRef),
      chatId: attachment.chatId,
      kind: attachment.kind,
      messageType: attachment.messageType,
      mimeType: attachment.mimeType ?? null,
      fileName: attachment.fileName ?? null,
      caption: attachment.caption ?? null,
      sizeBytes: attachment.sizeBytes ?? null,
      sha256: attachment.sha256 ?? null,
      downloadStatus: attachment.downloadStatus,
      localPath: attachment.localPath ?? null,
      downloadedAt: attachment.downloadedAt ?? null,
      error: attachment.error ?? null,
      rawMessageJson: attachment.rawMessageJson ?? null,
    });
  }

  private requireDb(): SqliteDatabase {
    if (!this.db) {
      throw new Error('whatsapp_store_not_loaded');
    }
    return this.db;
  }
}

const clampLimit = (value: unknown, fallback: number, max: number): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(1, Math.min(max, Math.floor(value)));
};

const parseCursor = (value: unknown): number => {
  if (typeof value !== 'string') {
    return 0;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
};

const normalizeQuery = (value: unknown): string => (
  typeof value === 'string' ? value.trim().toLocaleLowerCase() : ''
);

const boolToInt = (value: boolean): number => value ? 1 : 0;

const fileSize = async (filePath: string): Promise<number> => {
  const stat = await fs.stat(filePath).catch(() => null);
  return stat?.isFile() ? stat.size : 0;
};

const directorySize = async (directory: string): Promise<number> => {
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
  let total = 0;
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      total += await directorySize(entryPath);
      continue;
    }
    total += await fileSize(entryPath);
  }
  return total;
};
