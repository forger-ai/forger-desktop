import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import QRCode from 'qrcode';
import type { InternalToolContext } from '../types';
import type { OfficialToolRuntimeEvent, OfficialToolRuntimePhase } from '../../../shared/types';
import {
  chatFromMessage,
  decodeStableMessageRef,
  normalizeBaileysChat,
  normalizeBaileysContact,
  normalizeBaileysMessage,
  normalizeWhatsAppJid,
  phoneNumberFromJid,
} from './normalizer';
import { WhatsAppLocalStore } from './store';
import type {
  WhatsAppChatDetailsInput,
  WhatsAppConnectionStatus,
  WhatsAppDownloadAttachmentInput,
  WhatsAppIndexedMessage,
  WhatsAppListChatsInput,
  WhatsAppPairingInput,
  WhatsAppReadMessagesInput,
  WhatsAppSendMessageInput,
} from './types';

type BaileysModule = Record<string, unknown>;
type BaileysLogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
type BaileysLogger = Record<BaileysLogLevel | 'child', (...args: unknown[]) => BaileysLogger | void>;
type BaileysDownloadMediaMessage = (
  message: unknown,
  type: 'buffer',
  options: Record<string, unknown>,
  ctx?: Record<string, unknown>,
) => Promise<Buffer | Uint8Array>;
type BaileysSocket = {
  ev?: {
    on: (event: string, handler: (payload: unknown) => void) => void;
  };
  user?: { id?: string };
  requestPairingCode?: (phoneNumber: string) => Promise<string>;
  sendMessage?: (jid: string, content: unknown, options?: unknown) => Promise<unknown>;
  groupMetadata?: (jid: string) => Promise<unknown>;
  newsletterMetadata?: (kind: string, jid: string) => Promise<unknown>;
  updateMediaMessage?: (message: unknown) => Promise<unknown>;
  end?: (error?: Error) => void;
};

export class WhatsAppConnectionManager {
  private socket: BaileysSocket | null = null;
  private latestQr: string | null = null;
  private connected = false;
  private needsReconnect = false;
  private lastDisconnectReason: string | undefined;
  private starting: Promise<void> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly store: WhatsAppLocalStore) {}

  async status(context?: InternalToolContext): Promise<WhatsAppConnectionStatus> {
    await this.store.load();
    if (context && !this.connected && await this.hasAuthState()) {
      await this.ensureStarted(context);
      await this.waitForConnectionUpdate();
    }
    return {
      connected: this.connected,
      configured: await this.hasAuthState(),
      qrAvailable: Boolean(this.latestQr),
      ...(this.socket?.user?.id ? { phoneNumber: phoneNumberFromJid(this.socket.user.id) } : {}),
      ...(this.lastDisconnectReason ? { lastDisconnectReason: this.lastDisconnectReason } : {}),
      ...(this.needsReconnect ? { needsReconnect: true } : {}),
      storage: await this.store.storageStatus(),
    };
  }

  async startPairing(context: InternalToolContext, input: WhatsAppPairingInput): Promise<Record<string, unknown>> {
    if (!this.connected && await this.hasAuthState()) {
      await this.resetLocalSession(context);
    }
    await this.ensureStarted(context);
    if (input.method === 'pairing_code') {
      const phoneNumber = normalizePhoneForPairing(input.phoneNumber);
      if (!phoneNumber) {
        return { success: false, userMessage: 'Ingresa un numero de telefono valido para conectar WhatsApp.', technicalCode: 'whatsapp_pairing_phone_invalid' };
      }
      const pairingCode = await this.socket?.requestPairingCode?.(phoneNumber);
      if (!pairingCode) {
        return { success: false, userMessage: 'No pudimos generar el codigo de conexion de WhatsApp.', technicalCode: 'whatsapp_pairing_code_unavailable' };
      }
      this.emitRuntimeEvent(context, 'pairing_code_ready');
      return {
        status: 'pairing_code_ready',
        pairingCode,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      };
    }
    const qr = await this.waitForQr();
    if (!qr) {
      return { status: this.connected ? 'already_connected' : 'qr_pending' };
    }
    return {
      status: 'qr_ready',
      qrDataUrl: await QRCode.toDataURL(qr),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
  }

  async listChats(input: WhatsAppListChatsInput): Promise<Record<string, unknown>> {
    return this.store.listChats(input);
  }

  async readMessages(context: InternalToolContext, input: WhatsAppReadMessagesInput): Promise<Record<string, unknown>> {
    const chatId = normalizeWhatsAppJid(input.chatId);
    if (!chatId) {
      return { success: false, userMessage: 'Indica un chat de WhatsApp valido.', technicalCode: 'whatsapp_chat_id_required' };
    }
    if (await this.hasAuthState()) {
      await this.ensureStarted(context);
    }
    const messages = await this.store.readMessages({ ...input, chatId });
    return {
      messages: messages.map((message) => this.serializeMessage(message)),
    };
  }

  async sendMessage(context: InternalToolContext, input: WhatsAppSendMessageInput): Promise<Record<string, unknown>> {
    const chatId = normalizeWhatsAppJid(input.chatId);
    const text = typeof input.text === 'string' ? input.text.trim() : '';
    if (!chatId || !text || text.length > 4000) {
      return { success: false, userMessage: 'Completa un chat observado y un mensaje de WhatsApp valido.', technicalCode: 'whatsapp_send_input_invalid' };
    }
    const knownChat = await this.store.getChat(chatId);
    if (!knownChat) {
      return { success: false, userMessage: 'Primero lee o lista ese chat antes de enviar mensajes.', technicalCode: 'whatsapp_chat_not_observed' };
    }
    if (!await this.store.canSendNow()) {
      return { success: false, userMessage: 'Espera un momento antes de enviar otro mensaje de WhatsApp.', technicalCode: 'whatsapp_send_rate_limited' };
    }
    await this.ensureStarted(context);
    const quoted = decodeStableMessageRef(input.replyToMessageRef);
    const sent = await this.socket?.sendMessage?.(
      chatId,
      { text },
      quoted ? { quoted: { key: quoted } } : undefined,
    );
    const normalized = normalizeBaileysMessage(sent);
    if (normalized) {
      await this.store.upsertMessages([normalized]);
    }
    await this.store.rememberSend();
    return {
      sent: true,
      ...(normalized ? { stableMessageRef: this.store.encodeRef(normalized.stableMessageRef) } : {}),
      timestamp: Math.floor(Date.now() / 1000),
    };
  }

  async getChatDetails(context: InternalToolContext, input: WhatsAppChatDetailsInput): Promise<Record<string, unknown>> {
    const chatId = normalizeWhatsAppJid(input.chatId);
    const chat = chatId ? await this.store.getChat(chatId) : null;
    if (!chatId || !chat) {
      return { success: false, userMessage: 'Primero lee o lista ese chat antes de pedir detalles.', technicalCode: 'whatsapp_chat_not_observed' };
    }
    await this.ensureStarted(context);
    if (chat.chatType === 'group') {
      const metadata = await this.socket?.groupMetadata?.(chatId);
      return {
        chat,
        type: 'group',
        metadata: normalizeGroupMetadata(metadata),
      };
    }
    if (chat.chatType === 'channel') {
      const metadata = await this.socket?.newsletterMetadata?.('jid', chatId).catch(() => null);
      return {
        chat,
        type: 'channel',
        metadata,
        limitations: ['WhatsApp channels expose limited metadata through WhatsApp Web; participant lists may be unavailable.'],
      };
    }
    return {
      chat,
      type: 'direct',
      phoneNumber: chat.phoneNumber ?? phoneNumberFromJid(chat.chatId),
    };
  }

  async downloadAttachment(context: InternalToolContext, input: WhatsAppDownloadAttachmentInput): Promise<Record<string, unknown>> {
    const attachmentId = typeof input.attachmentId === 'string' ? input.attachmentId.trim() : '';
    if (!attachmentId) {
      return { success: false, userMessage: 'Indica un adjunto de WhatsApp valido.', technicalCode: 'whatsapp_attachment_id_required' };
    }
    const attachment = await this.store.getAttachment(attachmentId);
    if (!attachment) {
      return { success: false, userMessage: 'Ese adjunto de WhatsApp no fue observado por Forger.', technicalCode: 'whatsapp_attachment_not_observed' };
    }
    if (attachment.localPath && await fileExists(attachment.localPath)) {
      return {
        attachmentId,
        filePath: attachment.localPath,
        ...(attachment.fileName ? { fileName: attachment.fileName } : {}),
        ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}),
        ...(attachment.sizeBytes ? { sizeBytes: attachment.sizeBytes } : {}),
        ...(attachment.sha256 ? { sha256: attachment.sha256 } : {}),
        ...(attachment.downloadedAt ? { downloadedAt: attachment.downloadedAt } : {}),
      };
    }
    if (!attachment.rawMessageJson) {
      return { success: false, userMessage: 'No hay metadata suficiente para descargar ese adjunto.', technicalCode: 'whatsapp_attachment_raw_message_missing' };
    }
    await this.ensureStarted(context);
    const baileys = await importBaileys();
    const downloadMediaMessage = baileys.downloadMediaMessage as BaileysDownloadMediaMessage | undefined;
    if (!downloadMediaMessage) {
      return { success: false, userMessage: 'La version actual de Baileys no expone descarga de adjuntos.', technicalCode: 'whatsapp_attachment_download_unavailable' };
    }
    try {
      const rawMessage = JSON.parse(attachment.rawMessageJson) as unknown;
      const downloaded = await downloadMediaMessage(rawMessage, 'buffer', {}, {
        ...(this.socket?.updateMediaMessage ? { reuploadRequest: (message: unknown) => this.socket?.updateMediaMessage?.(message) } : {}),
      });
      const buffer = Buffer.isBuffer(downloaded) ? downloaded : Buffer.from(downloaded);
      const sha256 = createHash('sha256').update(buffer).digest('hex');
      const filePath = await this.writeAttachmentFile(attachmentId, attachment.fileName, buffer);
      const updated = await this.store.markAttachmentDownloaded({
        attachmentId,
        localPath: filePath,
        sizeBytes: buffer.length,
        sha256,
      });
      return {
        attachmentId,
        filePath,
        ...(updated?.fileName ? { fileName: updated.fileName } : {}),
        ...(updated?.mimeType ? { mimeType: updated.mimeType } : {}),
        sizeBytes: buffer.length,
        sha256,
        ...(updated?.downloadedAt ? { downloadedAt: updated.downloadedAt } : {}),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown_error';
      await this.store.markAttachmentFailed(attachmentId, message);
      return { success: false, userMessage: 'No pudimos descargar el adjunto de WhatsApp.', technicalCode: 'whatsapp_attachment_download_failed' };
    }
  }

  async disconnect(context?: InternalToolContext): Promise<void> {
    await this.resetLocalSession(context);
  }

  async stopListening(): Promise<void> {
    this.socket?.end?.(new Error('forger_whatsapp_stopped'));
    this.clearReconnectTimer();
    this.socket = null;
    this.connected = false;
    this.starting = null;
  }

  async resetLocalSession(context?: InternalToolContext): Promise<void> {
    this.socket?.end?.(new Error('forger_whatsapp_deactivated'));
    this.clearReconnectTimer();
    this.socket = null;
    this.connected = false;
    this.latestQr = null;
    this.needsReconnect = false;
    this.lastDisconnectReason = undefined;
    this.starting = null;
    await this.store.clear();
    if (context) {
      this.emitRuntimeEvent(context, 'reset');
    }
  }

  async ingestMessages(messages: unknown[], context?: InternalToolContext): Promise<void> {
    const normalized = messages
      .map((message) => normalizeBaileysMessage(message))
      .filter((message): message is WhatsAppIndexedMessage => Boolean(message));
    if (normalized.length === 0) {
      return;
    }
    await this.store.upsertMessages(normalized);
    for (const message of normalized) {
      await this.store.upsertChat(chatFromMessage(message));
    }
    if (context) {
      this.emitRuntimeEvent(context, 'messages_ingested', {
        counts: {
          messages: normalized.length,
          attachments: normalized.reduce((total, message) => total + message.attachments.length, 0),
        },
      });
    }
  }

  async ingestChats(chats: unknown[], context?: InternalToolContext): Promise<void> {
    const normalized = chats
      .map((chat) => normalizeBaileysChat(chat))
      .filter((chat): chat is NonNullable<ReturnType<typeof normalizeBaileysChat>> => Boolean(chat));
    for (const chat of normalized) {
      await this.store.upsertChat(chat);
    }
    if (context && normalized.length > 0) {
      this.emitRuntimeEvent(context, 'chats_ingested', { counts: { chats: normalized.length } });
    }
  }

  async ingestContacts(contacts: unknown[], context?: InternalToolContext): Promise<void> {
    const normalized = contacts.flatMap((contact) => normalizeBaileysContact(contact));
    for (const chat of normalized) {
      await this.store.upsertChat(chat);
    }
    if (context && normalized.length > 0) {
      this.emitRuntimeEvent(context, 'contacts_ingested', { counts: { contacts: normalized.length } });
    }
  }

  private async ensureStarted(context: InternalToolContext): Promise<void> {
    if (this.socket && !this.needsReconnect) {
      return;
    }
    if (!this.starting) {
      this.starting = this.start(context).finally(() => {
        this.starting = null;
      });
    }
    await this.starting;
  }

  private async start(context: InternalToolContext): Promise<void> {
    this.emitRuntimeEvent(context, 'starting');
    const baileys = await importBaileys();
    const useMultiFileAuthState = baileys.useMultiFileAuthState as ((folder: string) => Promise<{ state: unknown; saveCreds: () => Promise<void> }>) | undefined;
    const makeWASocket = (baileys.default ?? baileys.makeWASocket) as ((config: Record<string, unknown>) => BaileysSocket) | undefined;
    if (!useMultiFileAuthState || !makeWASocket) {
      throw new Error('whatsapp_baileys_api_unavailable');
    }
    const authDirectory = this.store.authDirectory();
    await fs.mkdir(authDirectory, { recursive: true, mode: 0o700 });
    const { state, saveCreds } = await useMultiFileAuthState(authDirectory);
    const socket = makeWASocket({
      auth: state,
      logger: createBaileysLogger(context),
      printQRInTerminal: false,
      syncFullHistory: false,
      markOnlineOnConnect: false,
    });
    this.socket = socket;
    this.needsReconnect = false;
    this.emitRuntimeEvent(context, 'connecting');
    socket.ev?.on('creds.update', () => {
      void saveCreds().then(() => chmodAuthFiles(authDirectory)).catch((error) => {
        void context.appendLog?.('official_tool:whatsapp_creds_save_failed', sanitizeErrorPayload(error));
      });
    });
    socket.ev?.on('connection.update', (payload) => {
      this.handleConnectionUpdate(payload, context);
    });
    socket.ev?.on('messages.upsert', (payload) => {
      const messages = isRecord(payload) && Array.isArray(payload.messages) ? payload.messages : [];
      void this.ingestMessages(messages, context).catch((error) => {
        void context.appendLog?.('official_tool:whatsapp_message_ingest_failed', sanitizeErrorPayload(error));
      });
    });
    socket.ev?.on('messaging-history.set', (payload) => {
      void this.ingestHistoryPayload(payload, context).catch((error) => {
        void context.appendLog?.('official_tool:whatsapp_history_ingest_failed', sanitizeErrorPayload(error));
      });
    });
    socket.ev?.on('chats.upsert', (payload) => {
      const chats = Array.isArray(payload) ? payload : [];
      void this.ingestChats(chats, context).catch((error) => {
        void context.appendLog?.('official_tool:whatsapp_chat_ingest_failed', sanitizeErrorPayload(error));
      });
    });
    socket.ev?.on('chats.update', (payload) => {
      const chats = Array.isArray(payload) ? payload : [];
      void this.ingestChats(chats, context).catch((error) => {
        void context.appendLog?.('official_tool:whatsapp_chat_ingest_failed', sanitizeErrorPayload(error));
      });
    });
    socket.ev?.on('contacts.upsert', (payload) => {
      const contacts = Array.isArray(payload) ? payload : [];
      void this.ingestContacts(contacts, context).catch((error) => {
        void context.appendLog?.('official_tool:whatsapp_contact_ingest_failed', sanitizeErrorPayload(error));
      });
    });
    socket.ev?.on('contacts.update', (payload) => {
      const contacts = Array.isArray(payload) ? payload : [];
      void this.ingestContacts(contacts, context).catch((error) => {
        void context.appendLog?.('official_tool:whatsapp_contact_ingest_failed', sanitizeErrorPayload(error));
      });
    });
    await chmodAuthFiles(authDirectory);
  }

  private handleConnectionUpdate(payload: unknown, context: InternalToolContext): void {
    if (!isRecord(payload)) {
      return;
    }
    if (typeof payload.qr === 'string') {
      this.latestQr = payload.qr;
      this.emitRuntimeEvent(context, 'qr_available');
    }
    if (payload.connection === 'open') {
      this.clearReconnectTimer();
      this.connected = true;
      this.needsReconnect = false;
      this.latestQr = null;
      this.lastDisconnectReason = undefined;
      this.emitRuntimeEvent(context, 'connected');
    }
    if (payload.connection === 'close') {
      const reconnecting = shouldAutoReconnect(payload);
      this.connected = false;
      this.needsReconnect = true;
      this.lastDisconnectReason = extractDisconnectReason(payload);
      this.socket = null;
      this.emitRuntimeEvent(context, reconnecting ? 'reconnecting' : 'disconnected', {
        reason: this.lastDisconnectReason,
      });
      if (reconnecting) {
        this.scheduleReconnect(context);
      }
    }
  }

  private async ingestHistoryPayload(payload: unknown, context: InternalToolContext): Promise<void> {
    const messages = isRecord(payload) && Array.isArray(payload.messages) ? payload.messages : [];
    const chats = isRecord(payload) && Array.isArray(payload.chats) ? payload.chats : [];
    const contacts = isRecord(payload) && Array.isArray(payload.contacts) ? payload.contacts : [];
    const counts = { messages: messages.length, chats: chats.length, contacts: contacts.length };
    this.emitRuntimeEvent(context, 'history_sync', { counts });
    await this.ingestMessages(messages, context);
    await this.ingestChats(chats, context);
    await this.ingestContacts(contacts, context);
    this.emitRuntimeEvent(context, 'sync_ready', { counts });
  }

  private emitRuntimeEvent(
    context: InternalToolContext,
    phase: OfficialToolRuntimePhase,
    details: { counts?: OfficialToolRuntimeEvent['counts']; reason?: string } = {},
  ): void {
    context.emitEvent?.({
      toolId: 'whatsapp',
      phase,
      timestamp: new Date().toISOString(),
      ...(details.reason ? { reason: details.reason } : {}),
      ...(details.counts ? { counts: details.counts } : {}),
      status: {
        connected: this.connected,
        qrAvailable: Boolean(this.latestQr),
        needsReconnect: this.needsReconnect,
        ...(this.lastDisconnectReason ? { lastDisconnectReason: this.lastDisconnectReason } : {}),
      },
    });
  }

  private scheduleReconnect(context: InternalToolContext): void {
    if (this.reconnectTimer) {
      return;
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.ensureStarted(context).catch((error) => {
        void context.appendLog?.('official_tool:whatsapp_reconnect_failed', sanitizeErrorPayload(error));
      });
    }, 1_500);
  }

  private clearReconnectTimer(): void {
    if (!this.reconnectTimer) {
      return;
    }
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private async waitForQr(): Promise<string | null> {
    if (this.latestQr) {
      return this.latestQr;
    }
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await new Promise((resolve) => {
        setTimeout(resolve, 250);
      });
      if (this.latestQr || this.connected) {
        return this.latestQr;
      }
    }
    return null;
  }

  private async waitForConnectionUpdate(): Promise<void> {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      if (this.connected || this.needsReconnect || this.latestQr) {
        return;
      }
      await new Promise((resolve) => {
        setTimeout(resolve, 250);
      });
    }
  }

  private async hasAuthState(): Promise<boolean> {
    try {
      const entries = await fs.readdir(this.store.authDirectory());
      return entries.length > 0;
    } catch {
      return false;
    }
  }

  private serializeMessage(message: WhatsAppIndexedMessage): Record<string, unknown> {
    return {
      ...message,
      stableMessageRef: this.store.encodeRef(message.stableMessageRef),
      attachments: message.attachments.map((attachment) => ({
        attachmentId: attachment.attachmentId,
        kind: attachment.kind,
        messageType: attachment.messageType,
        ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}),
        ...(attachment.fileName ? { fileName: attachment.fileName } : {}),
        ...(attachment.caption ? { caption: attachment.caption } : {}),
        ...(attachment.sizeBytes ? { sizeBytes: attachment.sizeBytes } : {}),
        ...(attachment.sha256 ? { sha256: attachment.sha256 } : {}),
        downloaded: attachment.downloaded,
        downloadStatus: attachment.downloadStatus,
      })),
    };
  }

  private async writeAttachmentFile(attachmentId: string, fileName: string | undefined, buffer: Buffer): Promise<string> {
    const safeName = sanitizePathSegment(fileName || `${attachmentId}.bin`);
    const safeId = sanitizePathSegment(attachmentId);
    const directory = path.join(this.store.downloadsDirectory(), safeId.slice(0, 24));
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const filePath = path.join(directory, `${safeId}-${safeName}`);
    if (!isInside(directory, filePath)) {
      throw new Error('whatsapp_attachment_path_invalid');
    }
    await fs.writeFile(filePath, buffer, { mode: 0o600 });
    await fs.chmod(filePath, 0o600).catch(() => undefined);
    return filePath;
  }
}

const importBaileys = async (): Promise<BaileysModule> => import('@whiskeysockets/baileys') as Promise<BaileysModule>;

const normalizePhoneForPairing = (value: unknown): string => {
  if (typeof value !== 'string') {
    return '';
  }
  const digits = value.replace(/\D/g, '');
  return digits.length >= 8 ? digits : '';
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const extractDisconnectReason = (payload: Record<string, unknown>): string => {
  const error = payload.lastDisconnect && isRecord(payload.lastDisconnect)
    ? payload.lastDisconnect.error
    : undefined;
  if (error instanceof Error) {
    return error.message;
  }
  return 'connection_closed';
};

const disconnectStatusCode = (payload: Record<string, unknown>): number | null => {
  const error = payload.lastDisconnect && isRecord(payload.lastDisconnect)
    ? payload.lastDisconnect.error
    : undefined;
  if (!isRecord(error)) {
    return null;
  }
  const output = isRecord(error.output) ? error.output : null;
  if (typeof output?.statusCode === 'number') {
    return output.statusCode;
  }
  if (typeof error.statusCode === 'number') {
    return error.statusCode;
  }
  return null;
};

const shouldAutoReconnect = (payload: Record<string, unknown>): boolean => {
  const reason = extractDisconnectReason(payload);
  if (reason === 'forger_whatsapp_deactivated' || /logged\s*out/i.test(reason)) {
    return false;
  }
  const statusCode = disconnectStatusCode(payload);
  return statusCode === 515 || /connection was lost/i.test(reason);
};

const sanitizeErrorPayload = (error: unknown): Record<string, unknown> => ({
  message: error instanceof Error ? error.message : 'unknown_error',
  ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
});

const createBaileysLogger = (context: InternalToolContext): BaileysLogger => {
  const logger = {} as BaileysLogger;
  const log = (level: BaileysLogLevel, args: unknown[]): void => {
    const payload = summarizeBaileysLogArgs(args);
    void context.appendLog?.('official_tool:whatsapp_baileys_log', {
      level,
      ...payload,
    });
  };
  for (const level of ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const) {
    logger[level] = (...args: unknown[]) => {
      log(level, args);
    };
  }
  logger.child = () => logger;
  return logger;
};

const summarizeBaileysLogArgs = (args: unknown[]): Record<string, unknown> => {
  const context: Record<string, unknown> = {};
  const messages: string[] = [];
  for (const arg of args) {
    if (typeof arg === 'string') {
      messages.push(arg);
      continue;
    }
    if (arg instanceof Error) {
      context.error = sanitizeErrorPayload(arg);
      continue;
    }
    if (isRecord(arg)) {
      Object.assign(context, summarizeBaileysLogObject(arg));
      continue;
    }
  }
  return {
    ...(messages.length > 0 ? { message: messages.join(' ') } : {}),
    context,
  };
};

const summarizeBaileysLogObject = (value: Record<string, unknown>): Record<string, unknown> => {
  const output: Record<string, unknown> = {};
  for (const key of ['class', 'msg', 'jid', 'addr', 'id', 'retryCount', 'sender', 'author', 'messageType']) {
    if (typeof value[key] === 'string' || typeof value[key] === 'number' || typeof value[key] === 'boolean') {
      output[key] = value[key];
    }
  }
  const error = value.error ?? value.err;
  if (error instanceof Error) {
    output.error = sanitizeErrorPayload(error);
  } else if (isRecord(error)) {
    output.error = {
      ...(typeof error.type === 'string' ? { type: error.type } : {}),
      ...(typeof error.message === 'string' ? { message: error.message } : {}),
      ...(typeof error.stack === 'string' ? { stack: error.stack } : {}),
    };
  }
  if (typeof value.trace === 'string') {
    output.trace = value.trace;
  }
  if (isRecord(value.node)) {
    output.node = summarizeBaileysNode(value.node);
  }
  if (isRecord(value.msgAttrs)) {
    output.msgAttrs = summarizeBaileysMessageAttrs(value.msgAttrs);
  }
  return output;
};

const summarizeBaileysNode = (node: Record<string, unknown>): Record<string, unknown> => ({
  ...(typeof node.passive === 'boolean' ? { passive: node.passive } : {}),
  ...(typeof node.connectType === 'string' ? { connectType: node.connectType } : {}),
  ...(typeof node.connectReason === 'string' ? { connectReason: node.connectReason } : {}),
  ...(typeof node.pull === 'boolean' ? { pull: node.pull } : {}),
});

const summarizeBaileysMessageAttrs = (attrs: Record<string, unknown>): Record<string, unknown> => ({
  ...(typeof attrs.from === 'string' ? { from: attrs.from } : {}),
  ...(typeof attrs.type === 'string' ? { type: attrs.type } : {}),
  ...(typeof attrs.id === 'string' ? { id: attrs.id } : {}),
  ...(typeof attrs.participant === 'string' ? { participant: attrs.participant } : {}),
  ...(typeof attrs.offline === 'string' ? { offline: attrs.offline } : {}),
  ...(typeof attrs.t === 'string' ? { timestamp: attrs.t } : {}),
});

const fileExists = async (filePath: string): Promise<boolean> => {
  const stat = await fs.stat(filePath).catch(() => null);
  return Boolean(stat?.isFile());
};

const sanitizePathSegment = (value: string): string => {
  const cleaned = value.trim().replace(/[/\\]/g, '-').replace(/[^a-zA-Z0-9._-]/g, '-').replace(/-+/g, '-');
  return cleaned.slice(0, 180) || 'attachment';
};

const isInside = (root: string, target: string): boolean => {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

const chmodAuthFiles = async (directory: string): Promise<void> => {
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
  await Promise.all(entries.map(async (entry) => {
    const entryPath = `${directory}/${entry.name}`;
    if (entry.isDirectory()) {
      await fs.chmod(entryPath, 0o700).catch(() => undefined);
      await chmodAuthFiles(entryPath);
      return;
    }
    await fs.chmod(entryPath, 0o600).catch(() => undefined);
  }));
};

const normalizeGroupMetadata = (metadata: unknown): Record<string, unknown> | null => {
  if (!isRecord(metadata)) {
    return null;
  }
  return {
    id: metadata.id,
    subject: metadata.subject,
    description: metadata.desc,
    owner: metadata.owner,
    announce: metadata.announce,
    restrict: metadata.restrict,
    joinApprovalMode: metadata.joinApprovalMode,
    memberAddMode: metadata.memberAddMode,
    ephemeralDuration: metadata.ephemeralDuration,
    size: metadata.size,
    participants: Array.isArray(metadata.participants)
      ? metadata.participants.map((participant) => isRecord(participant) ? ({
        id: participant.id,
        admin: participant.admin,
      }) : participant)
      : [],
  };
};

export const createWhatsAppConnectionManager = (context: InternalToolContext): WhatsAppConnectionManager =>
  new WhatsAppConnectionManager(new WhatsAppLocalStore(context.metadataRoot));
