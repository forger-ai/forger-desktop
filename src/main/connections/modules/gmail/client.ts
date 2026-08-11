import type { InternalToolContext } from '../../../tools/types';
import { refreshGmailAccessToken } from './oauth';
import type {
  GmailDraftSummary,
  GmailAttachmentSummary,
  GmailDecodedMessage,
  GmailDecodedThread,
  GmailGetDraftInput,
  GmailHistoryChange,
  GmailLabelSummary,
  GmailListChangesInput,
  GmailListChangesResult,
  GmailListDraftsInput,
  GmailListDraftsResult,
  GmailListThreadsInput,
  GmailListThreadsResult,
  GmailMessageSummary,
  GmailModifyThreadInput,
  GmailMoveThreadInput,
  GmailProfile,
  GmailSaveDraftInput,
  GmailSendDraftInput,
  GmailThreadSummary,
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
    const technicalCode = response.status === 403 && /insufficient|scope|required|permission/i.test(detail)
      ? 'gmail_scope_required'
      : response.status === 403
        ? 'gmail_api_permission_denied'
        : response.status === 404 && path.startsWith('/history')
          ? 'gmail_history_expired'
          : 'gmail_api_request_failed';
    throw new GmailApiError(detail, technicalCode);
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

const cleanString = (value: unknown): string =>
  typeof value === 'string' ? value.trim() : '';

const stringArray = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean)
    : [];

const optionalNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

const clampLimit = (value: unknown, fallback: number, max: number): number => {
  const numeric = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return Math.min(Math.max(Math.floor(numeric), 1), max);
};

const buildQueryPath = (
  resource: string,
  params: Record<string, string | number | string[] | undefined>,
): string => {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item) query.append(key, item);
      }
      continue;
    }
    if (value !== undefined && value !== '') {
      query.set(key, String(value));
    }
  }
  return `${resource}?${query.toString()}`;
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

const findHtmlBody = (payload: Record<string, unknown>): string | undefined => {
  const body = asRecord(payload.body);
  if (payload.mimeType === 'text/html' && typeof body.data === 'string') {
    return decodeBase64Url(body.data);
  }
  const parts = Array.isArray(payload.parts) ? payload.parts : [];
  for (const part of parts) {
    const html = findHtmlBody(asRecord(part));
    if (html) {
      return html;
    }
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
  const labelIds = stringArray(message.labelIds);
  return {
    id: String(message.id ?? ''),
    threadId: String(message.threadId ?? ''),
    snippet: typeof message.snippet === 'string' ? message.snippet : undefined,
    headers: headersFromPayload(payload),
    labelIds,
    textBody: findTextBody(payload),
    htmlBody: findHtmlBody(payload),
    attachments: collectAttachments(payload),
  };
};

const metadataSummaryFromMessage = (value: unknown): GmailMessageSummary => {
  const message = asRecord(value);
  const payload = asRecord(message.payload);
  const headers = headersFromPayload(payload);
  const attachments = collectAttachments(payload);
  const labelIds = stringArray(message.labelIds);
  return {
    id: String(message.id ?? ''),
    threadId: String(message.threadId ?? ''),
    ...(headers.subject ? { subject: headers.subject } : {}),
    ...(headers.from ? { from: headers.from } : {}),
    ...(headers.to ? { to: headers.to } : {}),
    ...(headers.date ? { date: headers.date } : {}),
    ...(typeof message.snippet === 'string' ? { snippet: message.snippet } : {}),
    ...(labelIds.length ? { labelIds } : {}),
    unread: labelIds.includes('UNREAD'),
    starred: labelIds.includes('STARRED'),
    hasAttachments: attachments.length > 0 || labelIds.includes('HAS_ATTACHMENT'),
  };
};

const splitAddresses = (value: string | undefined): string[] =>
  (value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

const threadSummaryFromValue = (value: unknown): GmailThreadSummary => {
  const thread = asRecord(value);
  const messages = Array.isArray(thread.messages) ? thread.messages.map(asRecord) : [];
  const latest = messages[messages.length - 1] ?? {};
  const latestDecoded = metadataSummaryFromMessage(latest);
  const allLabels = new Set<string>();
  let hasAttachments = false;
  for (const message of messages) {
    for (const labelId of stringArray(message.labelIds)) {
      allLabels.add(labelId);
    }
    hasAttachments = hasAttachments || collectAttachments(asRecord(message.payload)).length > 0;
  }
  const participants = Array.from(new Set([
    ...splitAddresses(latestDecoded.from),
    ...splitAddresses(latestDecoded.to),
  ]));
  return {
    threadId: String(thread.id ?? latestDecoded.threadId),
    ...(latestDecoded.id ? { latestMessageId: latestDecoded.id } : {}),
    ...(typeof thread.historyId === 'string' ? { historyId: thread.historyId } : {}),
    ...(latestDecoded.subject ? { subject: latestDecoded.subject } : {}),
    ...(latestDecoded.from ? { from: latestDecoded.from } : {}),
    participants,
    ...(typeof thread.snippet === 'string' ? { snippet: thread.snippet } : latestDecoded.snippet ? { snippet: latestDecoded.snippet } : {}),
    ...(latestDecoded.date ? { date: latestDecoded.date } : {}),
    labelIds: [...allLabels],
    unread: allLabels.has('UNREAD'),
    starred: allLabels.has('STARRED'),
    hasAttachments: hasAttachments || allLabels.has('HAS_ATTACHMENT'),
  };
};

const decodeDraft = (value: unknown): GmailDraftSummary => {
  const draft = asRecord(value);
  return {
    id: String(draft.id ?? ''),
    ...(draft.message ? { message: decodeMessage(draft.message) } : {}),
  };
};

export const validateConnection = async (context: InternalToolContext): Promise<void> => {
  await refreshGmailAccessToken(context);
};

export const getProfile = async (context: InternalToolContext): Promise<GmailProfile> => {
  const parsed = asRecord(await gmailFetch(context, '/profile'));
  return {
    emailAddress: String(parsed.emailAddress ?? ''),
    messagesTotal: optionalNumber(parsed.messagesTotal),
    threadsTotal: optionalNumber(parsed.threadsTotal),
    historyId: typeof parsed.historyId === 'string' ? parsed.historyId : undefined,
  };
};

export const listLabels = async (context: InternalToolContext): Promise<GmailLabelSummary[]> => {
  const parsed = asRecord(await gmailFetch(context, '/labels'));
  const labels = Array.isArray(parsed.labels) ? parsed.labels : [];
  return labels.map((value) => {
    const label = asRecord(value);
    return {
      id: String(label.id ?? ''),
      name: String(label.name ?? ''),
      type: typeof label.type === 'string' ? label.type : undefined,
      messagesTotal: optionalNumber(label.messagesTotal),
      messagesUnread: optionalNumber(label.messagesUnread),
      threadsTotal: optionalNumber(label.threadsTotal),
      threadsUnread: optionalNumber(label.threadsUnread),
    };
  }).filter((label) => label.id && label.name);
};

export const searchMessages = async (
  context: InternalToolContext,
  query: string,
  maxResults = 10,
  pageToken?: string,
): Promise<GmailMessageSummary[]> => {
  const path = buildQueryPath('/messages', {
    q: query,
    maxResults: clampLimit(maxResults, 10, 25),
    pageToken: cleanString(pageToken),
  });
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
    const detail = asRecord(await gmailFetch(context, buildQueryPath(`/messages/${encodeURIComponent(message.id)}`, {
      format: 'metadata',
      metadataHeaders: ['Subject', 'From', 'To', 'Date'],
    })));
    return metadataSummaryFromMessage({ ...detail, id: message.id, threadId: message.threadId });
  }));
};

export const listThreads = async (
  context: InternalToolContext,
  input: GmailListThreadsInput = {},
): Promise<GmailListThreadsResult> => {
  const path = buildQueryPath('/threads', {
    q: cleanString(input.query),
    labelIds: input.labelIds,
    maxResults: clampLimit(input.maxResults, 20, 50),
    pageToken: cleanString(input.pageToken),
  });
  const parsed = asRecord(await gmailFetch(context, path));
  const threads = Array.isArray(parsed.threads) ? parsed.threads : [];
  const summaries = threads
    .map((thread) => asRecord(thread))
    .map((thread) => String(thread.id ?? ''))
    .filter(Boolean);
  const detailed = await Promise.all(summaries.map(async (threadId) =>
    asRecord(await gmailFetch(context, buildQueryPath(`/threads/${encodeURIComponent(threadId)}`, {
      format: 'metadata',
      metadataHeaders: ['Subject', 'From', 'To', 'Cc', 'Date'],
    })))));
  return {
    threads: detailed.map(threadSummaryFromValue).filter((thread) => thread.threadId),
    ...(typeof parsed.nextPageToken === 'string' ? { nextPageToken: parsed.nextPageToken } : {}),
    ...(typeof parsed.resultSizeEstimate === 'number' ? { resultSizeEstimate: parsed.resultSizeEstimate } : {}),
  };
};

export const readMessage = async (context: InternalToolContext, messageId: string): Promise<GmailDecodedMessage> => {
  return decodeMessage(await gmailFetch(context, `/messages/${encodeURIComponent(messageId)}?format=full`));
};

export const readThread = async (context: InternalToolContext, threadId: string): Promise<GmailDecodedThread> => {
  const parsed = asRecord(await gmailFetch(context, `/threads/${encodeURIComponent(threadId)}?format=full`));
  const messages = Array.isArray(parsed.messages) ? parsed.messages.map(decodeMessage) : [];
  return {
    id: String(parsed.id ?? threadId),
    ...(typeof parsed.historyId === 'string' ? { historyId: parsed.historyId } : {}),
    messages,
  };
};

export const listChanges = async (
  context: InternalToolContext,
  input: GmailListChangesInput,
): Promise<GmailListChangesResult> => {
  const parsed = asRecord(await gmailFetch(context, buildQueryPath('/history', {
    startHistoryId: input.startHistoryId,
    maxResults: clampLimit(input.maxResults, 100, 500),
    pageToken: cleanString(input.pageToken),
    historyTypes: ['messageAdded', 'labelAdded', 'labelRemoved'],
  })));
  const changes: GmailHistoryChange[] = [];
  const history = Array.isArray(parsed.history) ? parsed.history : [];
  const appendChanges = (items: unknown, type: GmailHistoryChange['type']): void => {
    if (!Array.isArray(items)) return;
    for (const item of items) {
      const entry = asRecord(item);
      const message = asRecord(entry.message);
      const messageId = cleanString(message.id);
      if (!messageId) continue;
      changes.push({
        messageId,
        ...(cleanString(message.threadId) ? { threadId: cleanString(message.threadId) } : {}),
        ...(stringArray(message.labelIds).length ? { labelIds: stringArray(message.labelIds) } : {}),
        type,
      });
    }
  };
  for (const item of history) {
    const entry = asRecord(item);
    appendChanges(entry.messagesAdded, 'message_added');
    appendChanges(entry.labelsAdded, 'label_added');
    appendChanges(entry.labelsRemoved, 'label_removed');
  }
  return {
    ...(typeof parsed.historyId === 'string' ? { historyId: parsed.historyId } : {}),
    changes,
    ...(typeof parsed.nextPageToken === 'string' ? { nextPageToken: parsed.nextPageToken } : {}),
  };
};

export const modifyThread = async (
  context: InternalToolContext,
  input: GmailModifyThreadInput,
): Promise<GmailDecodedThread> => {
  const parsed = await gmailFetch(context, `/threads/${encodeURIComponent(input.threadId)}/modify`, {
    method: 'POST',
    body: JSON.stringify({
      addLabelIds: input.addLabelIds ?? [],
      removeLabelIds: input.removeLabelIds ?? [],
    }),
  });
  return readThread(context, String(asRecord(parsed).id ?? input.threadId));
};

export const moveThread = async (
  context: InternalToolContext,
  input: GmailMoveThreadInput,
): Promise<GmailDecodedThread> => {
  const endpoint = input.destination === 'trash' ? 'trash' : 'untrash';
  const parsed = await gmailFetch(context, `/threads/${encodeURIComponent(input.threadId)}/${endpoint}`, { method: 'POST' });
  return readThread(context, String(asRecord(parsed).id ?? input.threadId));
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

export const listDrafts = async (
  context: InternalToolContext,
  input: GmailListDraftsInput = {},
): Promise<GmailListDraftsResult> => {
  const parsed = asRecord(await gmailFetch(context, buildQueryPath('/drafts', {
    maxResults: clampLimit(input.maxResults, 20, 50),
    pageToken: cleanString(input.pageToken),
  })));
  const drafts = Array.isArray(parsed.drafts) ? parsed.drafts : [];
  const ids = drafts.map((draft) => cleanString(asRecord(draft).id)).filter(Boolean);
  const detailed = await Promise.all(ids.map((draftId) => getDraft(context, { draftId })));
  return {
    drafts: detailed,
    ...(typeof parsed.nextPageToken === 'string' ? { nextPageToken: parsed.nextPageToken } : {}),
    ...(typeof parsed.resultSizeEstimate === 'number' ? { resultSizeEstimate: parsed.resultSizeEstimate } : {}),
  };
};

export const getDraft = async (
  context: InternalToolContext,
  input: GmailGetDraftInput,
): Promise<GmailDraftSummary> =>
  decodeDraft(await gmailFetch(context, `/drafts/${encodeURIComponent(input.draftId)}?format=full`));

export const saveDraft = async (
  context: InternalToolContext,
  input: GmailSaveDraftInput,
  raw: string,
): Promise<GmailDraftSummary> => {
  const body = JSON.stringify({
    message: {
      raw,
      ...(input.threadId ? { threadId: input.threadId } : {}),
    },
  });
  const parsed = input.draftId
    ? await gmailFetch(context, `/drafts/${encodeURIComponent(input.draftId)}`, { method: 'PUT', body })
    : await gmailFetch(context, '/drafts', { method: 'POST', body });
  return decodeDraft(parsed);
};

export const deleteDraft = async (context: InternalToolContext, draftId: string): Promise<{ id: string; deleted: boolean }> => {
  await gmailFetch(context, `/drafts/${encodeURIComponent(draftId)}`, { method: 'DELETE' });
  return { id: draftId, deleted: true };
};

export const sendDraft = async (
  context: InternalToolContext,
  input: GmailSendDraftInput,
): Promise<{ id: string; threadId?: string }> => {
  const parsed = asRecord(await gmailFetch(context, '/drafts/send', {
    method: 'POST',
    body: JSON.stringify({ id: input.draftId }),
  }));
  return {
    id: String(parsed.id ?? ''),
    threadId: typeof parsed.threadId === 'string' ? parsed.threadId : undefined,
  };
};
