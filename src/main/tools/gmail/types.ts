export const GMAIL_TOOL_ID = 'gmail';
export const GMAIL_REFRESH_TOKEN_SECRET = 'oauth_refresh_token';

export const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
] as const;

export interface GmailSearchInput {
  query: string;
  maxResults?: number;
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
  snippet?: string;
}

export interface GmailDecodedMessage {
  id: string;
  threadId: string;
  snippet?: string;
  headers: Record<string, string>;
  textBody?: string;
  attachments: GmailAttachmentSummary[];
}

export interface GmailDecodedThread {
  id: string;
  messages: GmailDecodedMessage[];
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
