import type { ChatRun, ChatRunStatus } from './types/chat';

export interface PersistedActiveChatRun {
  runId: string;
  conversationId: string;
  appId: string;
}

const TERMINAL_CHAT_RUN_STATUSES = new Set<ChatRunStatus>([
  'preview_ready',
  'failed',
  'canceled',
  'applied',
  'undone',
]);

const MESSAGE_TERMINAL_CHAT_RUN_STATUSES = new Set<ChatRunStatus>([
  'preview_ready',
  'applied',
  'undone',
  'failed',
  'canceled',
]);

const cleanString = (value: unknown): string | null => {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

export const isTerminalChatRunStatus = (status: ChatRunStatus): boolean =>
  TERMINAL_CHAT_RUN_STATUSES.has(status);

export const isMessageTerminalChatRunStatus = (status: ChatRunStatus): boolean =>
  MESSAGE_TERMINAL_CHAT_RUN_STATUSES.has(status);

export const normalizePersistedActiveChatRun = (value: unknown): PersistedActiveChatRun | null => {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const candidate = value as Partial<Record<keyof PersistedActiveChatRun, unknown>>;
  const runId = cleanString(candidate.runId);
  const conversationId = cleanString(candidate.conversationId);
  const appId = cleanString(candidate.appId);

  if (!runId || !conversationId || !appId) {
    return null;
  }

  return { runId, conversationId, appId };
};

export const activeRunFromChatRun = (
  run: Pick<ChatRun, 'runId' | 'appId' | 'conversationId' | 'status'>,
): PersistedActiveChatRun | null => {
  if (isTerminalChatRunStatus(run.status)) {
    return null;
  }

  return normalizePersistedActiveChatRun({
    runId: run.runId,
    conversationId: run.conversationId,
    appId: run.appId,
  });
};
