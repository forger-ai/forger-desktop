export const WHATSAPP_TOOL_ID = 'whatsapp';

export const WHATSAPP_AUTH_STATE_SECRET = 'whatsapp_auth_state';

export type WhatsAppChatType = 'direct' | 'group' | 'channel';

export interface WhatsAppStableMessageRef {
  remoteJid: string;
  id: string;
  fromMe: boolean;
  participant?: string;
}

export interface WhatsAppIndexedMessage {
  stableMessageRef: WhatsAppStableMessageRef;
  chatId: string;
  chatType: WhatsAppChatType;
  senderId?: string;
  senderDisplayName?: string;
  fromMe: boolean;
  timestamp?: number;
  text?: string;
  messageType: string;
  isGroup: boolean;
  isChannel: boolean;
  hasAttachments: boolean;
  attachments: WhatsAppMessageAttachment[];
}

export type WhatsAppAttachmentKind = 'image' | 'video' | 'audio' | 'document' | 'sticker' | 'other';

export type WhatsAppAttachmentDownloadStatus = 'not_downloaded' | 'downloaded' | 'failed';

export interface WhatsAppMessageAttachment {
  attachmentId: string;
  stableMessageRef: WhatsAppStableMessageRef;
  chatId: string;
  kind: WhatsAppAttachmentKind;
  messageType: string;
  mimeType?: string;
  fileName?: string;
  caption?: string;
  sizeBytes?: number;
  sha256?: string;
  downloaded: boolean;
  downloadStatus: WhatsAppAttachmentDownloadStatus;
  localPath?: string;
  downloadedAt?: string;
  error?: string;
  rawMessageJson?: string;
}

export interface WhatsAppIndexedChat {
  chatId: string;
  chatType: WhatsAppChatType;
  title?: string;
  aliases?: string[];
  phoneNumber?: string;
  lastMessageRef?: WhatsAppStableMessageRef;
  unreadCount?: number;
  isMuted?: boolean;
  updatedAt: string;
}

export interface WhatsAppConnectionStatus {
  connected: boolean;
  configured: boolean;
  qrAvailable: boolean;
  phoneNumber?: string;
  lastDisconnectReason?: string;
  needsReconnect?: boolean;
  storage?: WhatsAppStorageStatus;
}

export interface WhatsAppStorageStatus {
  chatCount: number;
  messageCount: number;
  attachmentCount: number;
  downloadedAttachmentCount: number;
  databaseBytes: number;
  downloadsBytes: number;
  lastMessageAt?: string;
  lastSyncAt?: string;
}

export interface WhatsAppPairingInput {
  method: 'qr' | 'pairing_code';
  phoneNumber?: string;
}

export interface WhatsAppListChatsInput {
  chatType?: WhatsAppChatType;
  query?: string;
  limit?: number;
  cursor?: string;
}

export interface WhatsAppReadMessagesInput {
  chatId: string;
  limit?: number;
  beforeMessageRef?: string;
}

export interface WhatsAppSendMessageInput {
  chatId: string;
  text: string;
  replyToMessageRef?: string;
}

export interface WhatsAppChatDetailsInput {
  chatId: string;
}

export interface WhatsAppDownloadAttachmentInput {
  attachmentId: string;
}
