import type {
  WhatsAppAttachmentKind,
  WhatsAppChatType,
  WhatsAppIndexedChat,
  WhatsAppIndexedMessage,
  WhatsAppMessageAttachment,
  WhatsAppStableMessageRef,
} from './types';

const DIRECT_SUFFIX = '@s.whatsapp.net';
const LID_SUFFIX = '@lid';
const GROUP_SUFFIX = '@g.us';
const NEWSLETTER_SUFFIX = '@newsletter';

export const normalizeWhatsAppJid = (value: unknown): string => (
  typeof value === 'string' ? value.trim() : ''
);

export const classifyWhatsAppJid = (jid: string): WhatsAppChatType => {
  if (jid.endsWith(GROUP_SUFFIX)) {
    return 'group';
  }
  if (jid.endsWith(NEWSLETTER_SUFFIX)) {
    return 'channel';
  }
  return 'direct';
};

export const phoneNumberFromJid = (jid: string): string | undefined => {
  if (!jid.endsWith(DIRECT_SUFFIX) && !jid.endsWith(LID_SUFFIX)) {
    return undefined;
  }
  const [raw] = jid.split('@');
  const digits = raw.replace(/\D/g, '');
  return digits || undefined;
};

export const encodeStableMessageRef = (ref: WhatsAppStableMessageRef): string =>
  Buffer.from(JSON.stringify(ref), 'utf8').toString('base64url');

export const decodeStableMessageRef = (value: unknown): WhatsAppStableMessageRef | null => {
  if (typeof value !== 'string' || !value.trim()) {
    return null;
  }
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Partial<WhatsAppStableMessageRef>;
    if (!parsed.remoteJid || !parsed.id || typeof parsed.fromMe !== 'boolean') {
      return null;
    }
    return {
      remoteJid: parsed.remoteJid,
      id: parsed.id,
      fromMe: parsed.fromMe,
      ...(parsed.participant ? { participant: parsed.participant } : {}),
    };
  } catch {
    return null;
  }
};

const extractMessageText = (message: Record<string, unknown> | undefined): string | undefined => {
  if (!message) {
    return undefined;
  }
  if (typeof message.conversation === 'string') {
    return message.conversation;
  }
  const extended = message.extendedTextMessage as { text?: unknown } | undefined;
  if (typeof extended?.text === 'string') {
    return extended.text;
  }
  const image = message.imageMessage as { caption?: unknown } | undefined;
  if (typeof image?.caption === 'string') {
    return image.caption;
  }
  const video = message.videoMessage as { caption?: unknown } | undefined;
  if (typeof video?.caption === 'string') {
    return video.caption;
  }
  return undefined;
};

const getMessageType = (message: Record<string, unknown> | undefined): string => {
  if (!message) {
    return 'unknown';
  }
  return Object.keys(message)[0] ?? 'unknown';
};

const getAttachmentKind = (messageType: string): WhatsAppAttachmentKind | null => {
  if (messageType === 'imageMessage') return 'image';
  if (messageType === 'videoMessage') return 'video';
  if (messageType === 'audioMessage') return 'audio';
  if (messageType === 'documentMessage') return 'document';
  if (messageType === 'stickerMessage') return 'sticker';
  return null;
};

const toNumber = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'bigint') {
    const numberValue = Number(value);
    return Number.isSafeInteger(numberValue) ? numberValue : undefined;
  }
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const numberValue = Number(value);
    return Number.isFinite(numberValue) ? numberValue : undefined;
  }
  if (typeof value === 'object' && value && 'toNumber' in value && typeof value.toNumber === 'function') {
    const numberValue = value.toNumber();
    return typeof numberValue === 'number' && Number.isFinite(numberValue) ? numberValue : undefined;
  }
  return undefined;
};

const toBase64 = (value: unknown): string | undefined => {
  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }
  if (Buffer.isBuffer(value)) {
    return value.toString('base64');
  }
  if (value instanceof Uint8Array) {
    return Buffer.from(value).toString('base64');
  }
  return undefined;
};

const safeRawMessageJson = (raw: unknown): string | undefined => {
  try {
    return JSON.stringify(raw);
  } catch {
    return undefined;
  }
};

const extractAttachments = (
  message: Record<string, unknown> | undefined,
  stableMessageRef: WhatsAppStableMessageRef,
  chatId: string,
  raw: unknown,
): WhatsAppMessageAttachment[] => {
  const messageType = getMessageType(message);
  const kind = getAttachmentKind(messageType);
  if (!message || !kind) {
    return [];
  }
  const payload = message[messageType];
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return [];
  }
  const media = payload as Record<string, unknown>;
  const attachmentId = encodeStableMessageRef({
    ...stableMessageRef,
    id: `${stableMessageRef.id}:${messageType}`,
  });
  const fileName = typeof media.fileName === 'string' && media.fileName.trim() ? media.fileName.trim() : undefined;
  const mimeType = typeof media.mimetype === 'string' && media.mimetype.trim() ? media.mimetype.trim() : undefined;
  const caption = typeof media.caption === 'string' && media.caption.trim() ? media.caption.trim() : undefined;
  return [{
    attachmentId,
    stableMessageRef,
    chatId,
    kind,
    messageType,
    ...(mimeType ? { mimeType } : {}),
    ...(fileName ? { fileName } : {}),
    ...(caption ? { caption } : {}),
    ...(toNumber(media.fileLength) ? { sizeBytes: toNumber(media.fileLength) } : {}),
    ...(toBase64(media.fileSha256) ? { sha256: toBase64(media.fileSha256) } : {}),
    downloaded: false,
    downloadStatus: 'not_downloaded',
    ...(safeRawMessageJson(raw) ? { rawMessageJson: safeRawMessageJson(raw) } : {}),
  }];
};

const toTimestamp = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'object' && value && 'toNumber' in value && typeof value.toNumber === 'function') {
    const numberValue = value.toNumber();
    return typeof numberValue === 'number' && Number.isFinite(numberValue) ? numberValue : undefined;
  }
  return undefined;
};

export const normalizeBaileysMessage = (raw: unknown): WhatsAppIndexedMessage | null => {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const candidate = raw as {
    key?: { remoteJid?: unknown; id?: unknown; fromMe?: unknown; participant?: unknown };
    message?: Record<string, unknown>;
    messageTimestamp?: unknown;
    pushName?: unknown;
  };
  const remoteJid = normalizeWhatsAppJid(candidate.key?.remoteJid);
  const id = typeof candidate.key?.id === 'string' ? candidate.key.id.trim() : '';
  if (!remoteJid || !id) {
    return null;
  }
  const chatType = classifyWhatsAppJid(remoteJid);
  const participant = normalizeWhatsAppJid(candidate.key?.participant);
  const fromMe = candidate.key?.fromMe === true;
  const stableMessageRef = {
    remoteJid,
    id,
    fromMe,
    ...(participant ? { participant } : {}),
  };
  const attachments = extractAttachments(candidate.message, stableMessageRef, remoteJid, raw);
  return {
    stableMessageRef,
    chatId: remoteJid,
    chatType,
    ...(participant ? { senderId: participant } : {}),
    ...(typeof candidate.pushName === 'string' && candidate.pushName.trim() ? { senderDisplayName: candidate.pushName.trim() } : {}),
    fromMe,
    ...(toTimestamp(candidate.messageTimestamp) ? { timestamp: toTimestamp(candidate.messageTimestamp) } : {}),
    ...(extractMessageText(candidate.message) ? { text: extractMessageText(candidate.message) } : {}),
    messageType: getMessageType(candidate.message),
    isGroup: chatType === 'group',
    isChannel: chatType === 'channel',
    hasAttachments: attachments.length > 0,
    attachments,
  };
};

export const chatFromMessage = (message: WhatsAppIndexedMessage): WhatsAppIndexedChat => ({
  chatId: message.chatId,
  chatType: message.chatType,
  ...(phoneNumberFromJid(message.chatId) ? { phoneNumber: phoneNumberFromJid(message.chatId) } : {}),
  lastMessageRef: message.stableMessageRef,
  updatedAt: new Date().toISOString(),
});

const firstText = (...values: unknown[]): string | undefined => {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
};

const uniqueTexts = (values: unknown[]): string[] | undefined => {
  const seen = new Set<string>();
  for (const value of values) {
    if (typeof value !== 'string') {
      continue;
    }
    const text = value.trim();
    if (text) {
      seen.add(text);
    }
  }
  return seen.size > 0 ? [...seen] : undefined;
};

const chatTimestamp = (value: unknown): string => {
  const timestamp = toTimestamp(value);
  if (timestamp) {
    return new Date(timestamp * 1000).toISOString();
  }
  return new Date().toISOString();
};

export const normalizeBaileysChat = (raw: unknown): WhatsAppIndexedChat | null => {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const candidate = raw as {
    id?: unknown;
    name?: unknown;
    notify?: unknown;
    verifiedName?: unknown;
    subject?: unknown;
    unreadCount?: unknown;
    muteEndTime?: unknown;
    conversationTimestamp?: unknown;
    lastMessageRecvTimestamp?: unknown;
  };
  const chatId = normalizeWhatsAppJid(candidate.id);
  if (!chatId) {
    return null;
  }
  const title = firstText(candidate.name, candidate.notify, candidate.verifiedName, candidate.subject);
  return {
    chatId,
    chatType: classifyWhatsAppJid(chatId),
    ...(title ? { title } : {}),
    ...(uniqueTexts([candidate.name, candidate.notify, candidate.verifiedName, candidate.subject]) ? { aliases: uniqueTexts([candidate.name, candidate.notify, candidate.verifiedName, candidate.subject]) } : {}),
    ...(phoneNumberFromJid(chatId) ? { phoneNumber: phoneNumberFromJid(chatId) } : {}),
    ...(typeof candidate.unreadCount === 'number' ? { unreadCount: candidate.unreadCount } : {}),
    ...(candidate.muteEndTime ? { isMuted: true } : {}),
    updatedAt: chatTimestamp(candidate.conversationTimestamp ?? candidate.lastMessageRecvTimestamp),
  };
};

export const normalizeBaileysContact = (raw: unknown): WhatsAppIndexedChat[] => {
  if (!raw || typeof raw !== 'object') {
    return [];
  }
  const candidate = raw as {
    id?: unknown;
    lid?: unknown;
    phoneNumber?: unknown;
    name?: unknown;
    notify?: unknown;
    username?: unknown;
    verifiedName?: unknown;
  };
  const ids = [
    normalizeWhatsAppJid(candidate.id),
    normalizeWhatsAppJid(candidate.lid),
    normalizeWhatsAppJid(candidate.phoneNumber),
  ].filter(Boolean);
  const uniqueIds = [...new Set(ids)];
  const title = firstText(candidate.name, candidate.notify, candidate.verifiedName, candidate.username);
  const aliases = uniqueTexts([candidate.name, candidate.notify, candidate.verifiedName, candidate.username]);
  return uniqueIds.map((chatId) => ({
    chatId,
    chatType: classifyWhatsAppJid(chatId),
    ...(title ? { title } : {}),
    ...(aliases ? { aliases } : {}),
    ...(phoneNumberFromJid(chatId) ? { phoneNumber: phoneNumberFromJid(chatId) } : {}),
    updatedAt: new Date().toISOString(),
  }));
};
