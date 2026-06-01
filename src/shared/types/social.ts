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
export type CloudMessageType = 'CloudTextMessage' | 'CloudAppShareMessage';
export type CloudAppShareKind = 'public_app' | 'friends_link' | 'friend_link';

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

export interface CloudAppShareMessageDetail {
  id: number;
  userAppId: number;
  userAppShareId?: number;
  shareKind: CloudAppShareKind;
  appVisibilityAtSend: SocialUserAppVisibility;
  appNameSnapshot: string;
  appSlugSnapshot: string;
  appOwnerUsernameSnapshot: string;
  app: {
    id: number;
    status: SocialUserAppStatus;
    visibility: SocialUserAppVisibility;
    available: boolean;
  };
  share?: {
    id: number;
    scope: string;
    code?: string;
    deepLink?: string;
    revokedAt?: string;
    expiresAt?: string;
    maxUses?: number;
    usedCount: number;
  };
}

interface CloudMessageBase {
  id?: number;
  type: CloudMessageType;
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

export interface CloudTextMessage extends CloudMessageBase {
  type: 'CloudTextMessage';
  appShare?: undefined;
}

export interface CloudAppShareMessage extends CloudMessageBase {
  type: 'CloudAppShareMessage';
  appShare: CloudAppShareMessageDetail;
}

export type CloudMessage = CloudTextMessage | CloudAppShareMessage;

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

export interface CloudSendAppShareInput {
  recipientUsername?: string;
  recipientUserId?: number;
  userAppId: number;
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

export type SocialUserAppVisibility = 'public' | 'friends' | 'private' | 'restricted';
export type SocialUserAppStatus = 'published' | 'suspended' | 'deleted';
export type SocialUserAppUploadAttemptStatus = 'pending_upload' | 'uploaded' | 'analyzing' | 'failed' | 'published';
export type SocialUserAppReviewState = 'not_reviewed' | 'reviewed' | 'skipped_review';
export type ForumParticipationStatus = 'opted_out' | 'opted_in' | 'suspended';

export interface ForumParticipationState {
  status: ForumParticipationStatus;
  firstPromptShownAt?: string;
  optedInAt?: string;
  optedOutAt?: string;
  suspendedAt?: string;
  suspensionReason?: string;
  isModerator: boolean;
}

export type ForumContentStatus = 'visible' | 'hidden' | 'deleted';

export interface ForumUserProfile {
  id: number;
  username: string;
  firstName?: string;
  lastInitial?: string;
}

interface ForumContentBase {
  id: number;
  status: ForumContentStatus;
  body?: string;
  author: ForumUserProfile;
  hiddenAt?: string;
  hiddenReason?: string;
  deletedAt?: string;
  canDelete: boolean;
  canModerate: boolean;
  createdAt: string;
  updatedAt?: string;
  editedAt?: string;
}

export interface ForumComment extends ForumContentBase {
  forumPostId: number;
  parentId?: number;
  depth: number;
  replies: ForumComment[];
}

export interface ForumPost extends ForumContentBase {
  commentsCount: number;
  comments?: ForumComment[];
}

export interface SocialUserProfile {
  id: number;
  username: string;
  firstName?: string;
  lastInitial?: string;
  socialBio?: string;
}

export interface SocialUserAppVersion {
  id: number;
  version: string;
  runtimeStack: string;
  supportedPlatforms: string[];
  capabilities: string[];
  tools?: Record<string, unknown>;
  agents?: unknown[];
  promptTemplates?: unknown[];
  checksumSha256: string;
  fileSizeBytes: number;
  zipEntryCount?: number;
  expandedSizeBytes?: number;
  publishedAt?: string;
}

export interface SocialUserApp {
  id: number;
  slug: string;
  name: string;
  shortDescription?: string;
  description?: string;
  category?: string;
  visibility: SocialUserAppVisibility;
  status: SocialUserAppStatus;
  owner: SocialUserProfile;
  averageReviewScore?: number;
  reviewsCount?: number;
  commentsCount?: number;
  latestVersion?: SocialUserAppVersion;
  uploadStatus?: SocialUserAppUploadAttemptStatus;
  activeUploadAttempt?: SocialUserAppUploadAttempt;
  createdAt?: string;
  updatedAt?: string;
}

export interface SocialUserAppUploadAttempt {
  id: number;
  userAppId?: number;
  slug: string;
  status: SocialUserAppUploadAttemptStatus;
  errorCode?: string;
  checksumSha256?: string;
  byteSize?: number;
  zipEntryCount?: number;
  expandedSizeBytes?: number;
  manifestDigest?: string;
  publishedVersion?: string;
  analysisStartedAt?: string;
  analysisFinishedAt?: string;
  publishedAt?: string;
  createdAt?: string;
  updatedAt?: string;
  app?: SocialUserApp;
}

export interface SocialUserAppList {
  usage?: {
    appCount: number;
    appCountLimit: number;
    versionSizeLimitBytes: number;
  };
  apps: SocialUserApp[];
}

export interface SocialUserAppShare {
  id: number;
  code: string;
  scope: string;
  expiresAt?: string;
  maxUses?: number;
  deepLink: string;
}

export interface SocialUserAppDownload {
  downloadUrl: string;
  app: {
    id: number;
    slug: string;
    name: string;
    ownerUsername: string;
  };
  version: SocialUserAppVersion;
  install: {
    id: number;
    installedAt: string;
    source: string;
    trustDecision: SocialUserAppReviewState;
  };
}

export interface SocialUserAppUploadInput {
  appId: string;
  visibility: Exclude<SocialUserAppVisibility, 'restricted'>;
}
