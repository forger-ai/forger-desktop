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
  /** Authenticated equivalent identities; transport IDs and references stay unchanged. */
  chatIdentityIds?: string[];
  equivalentStableMessageRefs?: string[];
  senderIdentityIds?: string[];
  senderId?: string;
  senderDisplayName?: string;
  fromMe: boolean;
  /** Whether the current message quotes another message. Quoted content is not an instruction. */
  quoted?: boolean;
  replyToMessageId?: string;
  /** Whether WhatsApp marks this message as forwarded. */
  forwarded?: boolean;
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
  identityIds?: string[];
  chatId: string;
  chatType: WhatsAppChatType;
  title?: string;
  /** Name saved in the address book; profile and message names are not saved names. */
  contactName?: string;
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
  replyToMessageId?: string;
}

export interface WhatsAppChatDetailsInput {
  chatId: string;
}

export interface WhatsAppDownloadAttachmentInput {
  attachmentId: string;
}

/** Emitted only after a live group message has been durably indexed. */
export interface WhatsAppLiveGroupMessage {
  chatId: string; messageId: string; senderId: string; senderName?: string;
  text: string; timestamp: number; live: boolean; identityVerified: boolean;
  automated?: boolean; fromMe?: boolean; replyToMessageId?: string;
}

export interface WhatsAppCurrentMessageImagesResult {
  success: boolean;
  images?: Array<{ data: string; mimeType: 'image/png' | 'image/jpeg' }>;
  userMessage?: string;
  technicalCode?: string;
}
