export type FriendshipStatus = 'pending' | 'accepted' | 'declined' | 'canceled';

export interface CloudFriendUser {
  id: number;
  username: string;
  firstName?: string;
  lastName?: string;
  online?: boolean;
  devices?: Array<{
    id: number;
    deviceUid: string;
    publicKey?: string;
    keyFingerprint?: string;
    online?: boolean;
  }>;
}

export interface CloudFriendship {
  id: number;
  status: FriendshipStatus;
  requesterId: number;
  addresseeId: number;
  friend: CloudFriendUser;
  createdAt: string;
  updatedAt: string;
  respondedAt?: string;
  lastMessageAt?: string;
  unreadCount?: number;
  lastReadAt?: string;
}

export type CloudMessageDeliveryMode = 'persistent' | 'ephemeral';
export type CloudMessageSource = 'user' | 'app';
export type CloudMessageStatus = 'stored' | 'delivered' | 'not_delivered' | 'pending_permission' | 'blocked';
export type CloudAppMessagePermissionDecision = 'allow_once' | 'allow_always' | 'decline_once' | 'decline_always';

export interface CloudMessageEnvelope {
  id?: number;
  recipientUserId?: number;
  cloudDeviceId?: number;
  deviceUid?: string;
  keyFingerprint?: string;
  ciphertext: string;
  metadata?: Record<string, unknown>;
  readAt?: string;
}

export interface CloudMessage {
  id?: number;
  sender: CloudFriendUser;
  recipient: CloudFriendUser;
  deliveryMode: CloudMessageDeliveryMode;
  source: CloudMessageSource;
  sourceAppId?: string;
  sourceAppName?: string;
  status: CloudMessageStatus;
  clientMessageId?: string;
  metadata: Record<string, unknown>;
  envelopes: CloudMessageEnvelope[];
  plaintext?: string;
  deliveredAt?: string;
  createdAt: string;
  updatedAt?: string;
}

export type CloudSocialEvent =
  | { type: 'friendship_changed'; friendship: CloudFriendship }
  | { type: 'cloud_message'; message: CloudMessage; unread?: boolean }
  | { type: 'ephemeral_cloud_message'; message: CloudMessage; unread?: boolean };

export interface CloudSendMessageInput {
  recipientUsername?: string;
  recipientUserId?: number;
  text: string;
  delivery?: CloudMessageDeliveryMode;
  source?: CloudMessageSource;
  sourceAppId?: string;
  sourceAppName?: string;
}

export interface FriendChatWindowOpenResult {
  action: 'opened' | 'focused-existing' | 'already-open';
  userMessage: string;
}

export interface CloudIdentityState {
  publicKey: string;
  keyFingerprint: string;
  secretKeyPreview: string;
  createdAt: string;
  updatedAt: string;
}
