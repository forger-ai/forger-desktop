import type { InternalToolContext } from '../../../tools/types';
import { refreshGmailAccessToken } from './oauth';
import type {
  GmailAttachmentSummary,
  GmailDecodedMessage,
  GmailDecodedThread,
  GmailMessageSummary,
} from './types';

const GMAIL_API_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';

export class GmailApiError extends Error {
  constructor(
    message: string,
    public readonly technicalCode = 'gmail_api_error',
  ) {
    super(message);
    this.name = 'GmailApiError';
  }
}

const gmailFetch = async (context: InternalToolContext, path: string, init?: RequestInit): Promise<unknown> => {
  const accessToken = await refreshGmailAccessToken(context);
  const response = await fetch(`${GMAIL_API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
  });
  const parsed = await response.json().catch(() => null) as unknown;
  if (!response.ok) {
    const detail = parsed && typeof parsed === 'object' && 'error' in parsed
      ? JSON.stringify((parsed as { error: unknown }).error)
      : `gmail_http_${response.status}`;
    throw new GmailApiError(detail, response.status === 403 ? 'gmail_api_permission_denied' : 'gmail_api_request_failed');
  }
  return parsed;
};

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

const decodeBase64Url = (value: string): string => {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  return Buffer.from(padded, 'base64').toString('utf8');
};

const headersFromPayload = (payload: Record<string, unknown>): Record<string, string> => {
  const headers = Array.isArray(payload.headers) ? payload.headers : [];
  const result: Record<string, string> = {};
  for (const header of headers) {
    const entry = asRecord(header);
    const name = typeof entry.name === 'string' ? entry.name : '';
    const value = typeof entry.value === 'string' ? entry.value : '';
    if (name && value) {
      result[name.toLowerCase()] = value;
    }
  }
  return result;
};

const findTextBody = (payload: Record<string, unknown>): string | undefined => {
  const body = asRecord(payload.body);
  if (payload.mimeType === 'text/plain' && typeof body.data === 'string') {
    return decodeBase64Url(body.data);
  }
  const parts = Array.isArray(payload.parts) ? payload.parts : [];
  for (const part of parts) {
    const text = findTextBody(asRecord(part));
    if (text) {
      return text;
    }
  }
  if (typeof body.data === 'string') {
    return decodeBase64Url(body.data);
  }
  return undefined;
};

const collectAttachments = (payload: Record<string, unknown>): GmailAttachmentSummary[] => {
  const attachments: GmailAttachmentSummary[] = [];
  const visit = (part: Record<string, unknown>): void => {
    const body = asRecord(part.body);
    const filename = typeof part.filename === 'string' ? part.filename.trim() : '';
    const attachmentId = typeof body.attachmentId === 'string' ? body.attachmentId : '';
    if (filename && attachmentId) {
      attachments.push({
        attachmentId,
        filename,
        mimeType: typeof part.mimeType === 'string' ? part.mimeType : undefined,
        size: typeof body.size === 'number' ? body.size : undefined,
      });
    }
    const parts = Array.isArray(part.parts) ? part.parts : [];
    for (const child of parts) {
      visit(asRecord(child));
    }
  };
  visit(payload);
  return attachments;
};

const decodeMessage = (value: unknown): GmailDecodedMessage => {
  const message = asRecord(value);
  const payload = asRecord(message.payload);
  return {
    id: String(message.id ?? ''),
    threadId: String(message.threadId ?? ''),
    snippet: typeof message.snippet === 'string' ? message.snippet : undefined,
    headers: headersFromPayload(payload),
    textBody: findTextBody(payload),
    attachments: collectAttachments(payload),
  };
};

export const validateConnection = async (context: InternalToolContext): Promise<void> => {
  await refreshGmailAccessToken(context);
};

export const searchMessages = async (
  context: InternalToolContext,
  query: string,
  maxResults = 10,
): Promise<GmailMessageSummary[]> => {
  const url = new URL('/messages', GMAIL_API_BASE);
  url.searchParams.set('q', query);
  url.searchParams.set('maxResults', String(Math.min(Math.max(Math.floor(maxResults), 1), 25)));
  const path = `/messages${url.search}`;
  const parsed = asRecord(await gmailFetch(context, path));
  const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
  const summaries = messages.map((message) => {
    const entry = asRecord(message);
    return {
      id: String(entry.id ?? ''),
      threadId: String(entry.threadId ?? ''),
    };
  }).filter((message) => message.id && message.threadId);
  return await Promise.all(summaries.map(async (message) => {
    const detail = asRecord(await gmailFetch(context, `/messages/${encodeURIComponent(message.id)}?format=metadata`));
    return {
      ...message,
      snippet: typeof detail.snippet === 'string' ? detail.snippet : undefined,
    };
  }));
};

export const readMessage = async (context: InternalToolContext, messageId: string): Promise<GmailDecodedMessage> => {
  return decodeMessage(await gmailFetch(context, `/messages/${encodeURIComponent(messageId)}?format=full`));
};

export const readThread = async (context: InternalToolContext, threadId: string): Promise<GmailDecodedThread> => {
  const parsed = asRecord(await gmailFetch(context, `/threads/${encodeURIComponent(threadId)}?format=full`));
  const messages = Array.isArray(parsed.messages) ? parsed.messages.map(decodeMessage) : [];
  return {
    id: String(parsed.id ?? threadId),
    messages,
  };
};

export const readAttachment = async (
  context: InternalToolContext,
  messageId: string,
  attachmentId: string,
): Promise<Buffer> => {
  const parsed = asRecord(await gmailFetch(
    context,
    `/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`,
  ));
  if (typeof parsed.data !== 'string') {
    throw new GmailApiError('gmail_attachment_data_missing', 'gmail_attachment_data_missing');
  }
  const normalized = parsed.data.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  return Buffer.from(padded, 'base64');
};

export const sendMessage = async (context: InternalToolContext, raw: string): Promise<{ id: string; threadId?: string }> => {
  const parsed = asRecord(await gmailFetch(context, '/messages/send', {
    method: 'POST',
    body: JSON.stringify({ raw }),
  }));
  return {
    id: String(parsed.id ?? ''),
    threadId: typeof parsed.threadId === 'string' ? parsed.threadId : undefined,
  };
};
