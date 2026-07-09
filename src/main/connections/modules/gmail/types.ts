export const GMAIL_TOOL_ID = 'gmail';
export const GMAIL_REFRESH_TOKEN_SECRET = 'oauth_refresh_token';
export const GMAIL_SELF_OAUTH_CLIENT_ID_SECRET = 'self_oauth_client_id';
export const GMAIL_SELF_OAUTH_CLIENT_SECRET_SECRET = 'self_oauth_client_secret';

export const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.compose',
] as const;

export interface GmailSearchInput {
  query: string;
  maxResults?: number;
  pageToken?: string;
}

export interface GmailListThreadsInput {
  query?: string;
  labelIds?: string[];
  maxResults?: number;
  pageToken?: string;
}

export interface GmailListChangesInput {
  startHistoryId: string;
  maxResults?: number;
  pageToken?: string;
}

export interface GmailModifyThreadInput {
  threadId: string;
  addLabelIds?: string[];
  removeLabelIds?: string[];
}

export interface GmailMoveThreadInput {
  threadId: string;
  destination: 'trash' | 'untrash';
}

export interface GmailListDraftsInput {
  maxResults?: number;
  pageToken?: string;
}

export interface GmailGetDraftInput {
  draftId: string;
}

export interface GmailSaveDraftInput extends GmailSendInput {
  draftId?: string;
  threadId?: string;
}

export interface GmailDeleteDraftInput {
  draftId: string;
}

export interface GmailSendDraftInput {
  draftId: string;
}

export interface GmailReadInput {
  threadId?: string;
  messageId?: string;
}

export interface GmailReadAttachmentInput {
  messageId: string;
  attachmentId?: string;
  filename?: string;
}

export interface GmailSendAttachmentInput {
  filePath: string;
  filename?: string;
  mimeType?: string;
}

export interface GmailSendInput {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  bodyHtml?: string;
  attachments?: GmailSendAttachmentInput[];
}

export interface GmailAttachmentSummary {
  attachmentId: string;
  filename: string;
  mimeType?: string;
  size?: number;
}

export interface GmailMessageSummary {
  id: string;
  threadId: string;
  subject?: string;
  from?: string;
  to?: string;
  date?: string;
  snippet?: string;
  labelIds?: string[];
  unread?: boolean;
  starred?: boolean;
  hasAttachments?: boolean;
}

export interface GmailDecodedMessage {
  id: string;
  threadId: string;
  snippet?: string;
  headers: Record<string, string>;
  labelIds: string[];
  textBody?: string;
  htmlBody?: string;
  attachments: GmailAttachmentSummary[];
}

export interface GmailDecodedThread {
  id: string;
  historyId?: string;
  messages: GmailDecodedMessage[];
}

export interface GmailProfile {
  emailAddress: string;
  messagesTotal?: number;
  threadsTotal?: number;
  historyId?: string;
}

export interface GmailLabelSummary {
  id: string;
  name: string;
  type?: string;
  messagesTotal?: number;
  messagesUnread?: number;
  threadsTotal?: number;
  threadsUnread?: number;
}

export interface GmailThreadSummary {
  threadId: string;
  latestMessageId?: string;
  historyId?: string;
  subject?: string;
  from?: string;
  participants: string[];
  snippet?: string;
  date?: string;
  labelIds: string[];
  unread: boolean;
  starred: boolean;
  hasAttachments: boolean;
}

export interface GmailListThreadsResult {
  threads: GmailThreadSummary[];
  nextPageToken?: string;
  resultSizeEstimate?: number;
}

export interface GmailHistoryChange {
  messageId: string;
  threadId?: string;
  labelIds?: string[];
  type: 'message_added' | 'label_added' | 'label_removed';
}

export interface GmailListChangesResult {
  historyId?: string;
  changes: GmailHistoryChange[];
  nextPageToken?: string;
}

export interface GmailDraftSummary {
  id: string;
  message?: GmailDecodedMessage;
}

export interface GmailListDraftsResult {
  drafts: GmailDraftSummary[];
  nextPageToken?: string;
  resultSizeEstimate?: number;
}

export interface GoogleTokenResponse {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
}
