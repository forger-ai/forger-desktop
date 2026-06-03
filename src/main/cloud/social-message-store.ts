import fs from 'node:fs/promises';
import path from 'node:path';
import type { CloudMessage } from '../../shared/types';

type BetterSqlite3Module = typeof import('better-sqlite3');
type Database = import('better-sqlite3').Database;

export type SocialMessageLocalState = 'pending' | 'sent' | 'failed' | 'received';

export type StoredSocialMessage = CloudMessage & {
  localState?: SocialMessageLocalState;
};

interface SocialMessageStoreOptions {
  BetterSqlite3: BetterSqlite3Module | null;
  filePath: string;
  accountStorageKey: () => string | undefined;
  currentUserId: () => number | undefined;
}

const serialize = (value: unknown): string => JSON.stringify(value ?? null);
const parseRecord = <T>(value: string | null | undefined, fallback: T): T => {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
};

export class SocialMessageStore {
  private db: Database | null = null;
  private dbPath: string | null = null;

  constructor(private readonly options: SocialMessageStoreOptions) {}

  async listMessages(friendUserId: number): Promise<StoredSocialMessage[]> {
    const db = await this.database();
    const rows = db.prepare(`
      SELECT * FROM social_messages
      WHERE friend_user_id = ?
      ORDER BY created_at ASC, id ASC
      LIMIT 1000
    `).all(friendUserId) as Array<Record<string, unknown>>;
    return rows.map((row) => this.rowToMessage(row)).filter((message): message is StoredSocialMessage => Boolean(message));
  }

  async upsertMessage(message: CloudMessage, localState?: SocialMessageLocalState): Promise<StoredSocialMessage> {
    const db = await this.database();
    const currentUserId = this.options.currentUserId();
    const friendUserId = this.friendUserId(message, currentUserId);
    const messageKey = this.messageKey(message);
    const state = localState ?? this.defaultLocalState(message, currentUserId);
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO social_messages (
        message_key, client_message_id, cloud_message_id, friend_user_id,
        type, sender_json, recipient_json, delivery_mode, source, source_app_id,
        source_app_name, status, local_state, metadata_json, app_share_json,
        plaintext, created_at, updated_at
      ) VALUES (
        @messageKey, @clientMessageId, @cloudMessageId, @friendUserId,
        @type, @senderJson, @recipientJson, @deliveryMode, @source, @sourceAppId,
        @sourceAppName, @status, @localState, @metadataJson, @appShareJson,
        @plaintext, @createdAt, @updatedAt
      )
      ON CONFLICT(message_key) DO UPDATE SET
        client_message_id = excluded.client_message_id,
        cloud_message_id = COALESCE(excluded.cloud_message_id, social_messages.cloud_message_id),
        friend_user_id = excluded.friend_user_id,
        type = excluded.type,
        sender_json = excluded.sender_json,
        recipient_json = excluded.recipient_json,
        delivery_mode = excluded.delivery_mode,
        source = excluded.source,
        source_app_id = excluded.source_app_id,
        source_app_name = excluded.source_app_name,
        status = excluded.status,
        local_state = excluded.local_state,
        metadata_json = excluded.metadata_json,
        app_share_json = excluded.app_share_json,
        plaintext = COALESCE(excluded.plaintext, social_messages.plaintext),
        created_at = excluded.created_at,
        updated_at = excluded.updated_at
    `).run({
      messageKey,
      clientMessageId: message.clientMessageId ?? null,
      cloudMessageId: message.id ?? null,
      friendUserId,
      type: message.type,
      senderJson: serialize(message.sender),
      recipientJson: serialize(message.recipient),
      deliveryMode: message.deliveryMode,
      source: message.source,
      sourceAppId: message.sourceAppId ?? null,
      sourceAppName: message.sourceAppName ?? null,
      status: message.status,
      localState: state,
      metadataJson: serialize(message.metadata),
      appShareJson: message.type === 'CloudAppShareMessage' ? serialize(message.appShare) : null,
      plaintext: message.plaintext ?? null,
      createdAt: message.createdAt,
      updatedAt: message.updatedAt ?? now,
    });
    return { ...message, localState: state };
  }

  async markState(clientMessageId: string, localState: SocialMessageLocalState): Promise<void> {
    const db = await this.database();
    db.prepare(`
      UPDATE social_messages
      SET local_state = ?, updated_at = ?
      WHERE client_message_id = ?
    `).run(localState, new Date().toISOString(), clientMessageId);
  }

  private async database(): Promise<Database> {
    if (this.db && this.dbPath === this.currentPath()) {
      return this.db;
    }
    if (!this.options.BetterSqlite3) {
      throw new Error('social_message_store_sqlite_unavailable');
    }
    const dbPath = this.currentPath();
    await fs.mkdir(path.dirname(dbPath), { recursive: true });
    const DatabaseCtor = this.options.BetterSqlite3 as unknown as new (filename: string) => Database;
    this.db = new DatabaseCtor(dbPath);
    this.dbPath = dbPath;
    this.migrate(this.db);
    return this.db;
  }

  private currentPath(): string {
    const accountStorageKey = this.options.accountStorageKey()?.replace(/[^a-zA-Z0-9_-]/g, '_') ?? 'default';
    const extension = path.extname(this.options.filePath);
    const basename = path.basename(this.options.filePath, extension);
    return path.join(path.dirname(this.options.filePath), `${basename}-${accountStorageKey}${extension || '.sqlite'}`);
  }

  private migrate(db: Database): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS social_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_key TEXT NOT NULL UNIQUE,
        client_message_id TEXT,
        cloud_message_id INTEGER,
        friend_user_id INTEGER NOT NULL,
        type TEXT NOT NULL,
        sender_json TEXT NOT NULL,
        recipient_json TEXT NOT NULL,
        delivery_mode TEXT NOT NULL,
        source TEXT NOT NULL,
        source_app_id TEXT,
        source_app_name TEXT,
        status TEXT NOT NULL,
        local_state TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        app_share_json TEXT,
        plaintext TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS index_social_messages_friend_created
        ON social_messages(friend_user_id, created_at, id);
      CREATE INDEX IF NOT EXISTS index_social_messages_client_message
        ON social_messages(client_message_id);
    `);
  }

  private rowToMessage(row: Record<string, unknown>): StoredSocialMessage | null {
    const type = row.type === 'CloudAppShareMessage' ? 'CloudAppShareMessage' : 'CloudTextMessage';
    const base = {
      id: typeof row.cloud_message_id === 'number' ? row.cloud_message_id : undefined,
      type,
      sender: parseRecord(String(row.sender_json ?? ''), { id: 0, username: '' }),
      recipient: parseRecord(String(row.recipient_json ?? ''), { id: 0, username: '' }),
      deliveryMode: row.delivery_mode === 'ephemeral' ? 'ephemeral' as const : 'persistent' as const,
      source: row.source === 'app' ? 'app' as const : 'user' as const,
      sourceAppId: typeof row.source_app_id === 'string' ? row.source_app_id : undefined,
      sourceAppName: typeof row.source_app_name === 'string' ? row.source_app_name : undefined,
      status: this.messageStatus(row.status),
      clientMessageId: typeof row.client_message_id === 'string' ? row.client_message_id : undefined,
      metadata: parseRecord(String(row.metadata_json ?? '{}'), {}),
      envelopes: [],
      plaintext: typeof row.plaintext === 'string' ? row.plaintext : undefined,
      createdAt: typeof row.created_at === 'string' ? row.created_at : new Date(0).toISOString(),
      updatedAt: typeof row.updated_at === 'string' ? row.updated_at : undefined,
      localState: this.localState(row.local_state),
    };
    if (type === 'CloudAppShareMessage') {
      const appShare = parseRecord(row.app_share_json as string | null, null);
      return appShare ? { ...base, type, appShare } as StoredSocialMessage : null;
    }
    return { ...base, type } as StoredSocialMessage;
  }

  private messageKey(message: CloudMessage): string {
    if (message.clientMessageId) return `client:${message.clientMessageId}`;
    if (message.id) return `cloud:${message.id}`;
    return `local:${message.sender.id}:${message.recipient.id}:${message.createdAt}`;
  }

  private friendUserId(message: CloudMessage, currentUserId?: number): number {
    if (message.sender.id === currentUserId) return message.recipient.id;
    return message.sender.id;
  }

  private defaultLocalState(message: CloudMessage, currentUserId?: number): SocialMessageLocalState {
    return message.sender.id === currentUserId ? 'sent' : 'received';
  }

  private localState(value: unknown): SocialMessageLocalState {
    return value === 'pending' || value === 'failed' || value === 'received' ? value : 'sent';
  }

  private messageStatus(value: unknown): CloudMessage['status'] {
    return value === 'delivered' || value === 'not_delivered' || value === 'pending_permission' || value === 'blocked'
      ? value
      : 'stored';
  }
}
