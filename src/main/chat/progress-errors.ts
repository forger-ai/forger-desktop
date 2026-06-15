import fs from 'node:fs/promises';
import path from 'node:path';
import type { ChatErrorCode, ChatStartRunInput } from '../../shared/types';
import { getSharedCopy } from '../../shared/i18n';
import type { ChatHistoryMessage } from './orchestrator-helpers';

const MAX_CHAT_RECOVERY_CONTEXT_CHARS = 24_000;

export const normalizeChatHistory = (messages: ChatStartRunInput['conversationHistory']): ChatHistoryMessage[] => {
  if (!Array.isArray(messages)) {
    return [];
  }
  return messages
    .map((message) => {
      const role = message?.role === 'assistant' ? 'assistant' : message?.role === 'user' ? 'user' : null;
      const content = typeof message?.content === 'string' ? message.content.trim() : '';
      return role && content ? { role, content } : null;
    })
    .filter((message): message is ChatHistoryMessage => Boolean(message))
    .slice(-40);
};

export const buildChatRecoveryContext = (messages: ChatHistoryMessage[]): string => {
  if (messages.length === 0) {
    return '';
  }
  const transcript = messages
    .map((message) => `${message.role}: ${message.content}`)
    .join('\n\n')
    .slice(-MAX_CHAT_RECOVERY_CONTEXT_CHARS);
  return [
    'Historial persistido de este Desktop Chat:',
    transcript,
    '',
    'Continúa en el mismo Desktop Chat usando este historial como contexto.',
  ].join('\n');
};

export const isMissingProviderThreadError = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error ?? '');
  const combined = message.toLowerCase();
  return (
    combined.includes('no rollout found for thread id') ||
    combined.includes('thread/resume failed') ||
    combined.includes('conversation not found') ||
    combined.includes('session not found') ||
    combined.includes('could not resume') ||
    combined.includes('cannot resume')
  );
};

export const toProgressMessages = (
  stream: 'stdout' | 'stderr' | 'meta',
  text: string,
  locale?: string,
): string[] => {
  if (stream === 'meta') {
    return [];
  }

  const trimmed = text.trim();
  if (!trimmed) {
    return [];
  }

  const lines = trimmed
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const mapped: string[] = [];
  for (const line of lines) {
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }

    const type = typeof entry.type === 'string' ? entry.type : '';
    if (type === 'item.started' && entry.item && typeof entry.item === 'object') {
      const item = entry.item as Record<string, unknown>;
      const itemType = typeof item.type === 'string' ? item.type : '';
      const command = typeof item.command === 'string' ? item.command : '';
      if (itemType === 'command_execution' && looksLikeFileEditCommand(command)) {
        mapped.push(getSharedCopy(locale).chat.progress.editingFiles);
      }
    }
    if (type === 'item.completed' && entry.item && typeof entry.item === 'object') {
      const item = entry.item as Record<string, unknown>;
      const itemType = typeof item.type === 'string' ? item.type : '';
      if (itemType === 'agent_message') {
        const messageText = typeof item.text === 'string' ? item.text.trim() : '';
        if (messageText) {
          const compact = messageText.replace(/\s+/g, ' ');
          const snippet = compact.length > 160 ? `${compact.slice(0, 160)}...` : compact;
          if (mapped[mapped.length - 1] !== snippet) {
            mapped.push(snippet);
          }
        }
      }
    }
  }

  return mapped.slice(-6);
};

const looksLikeFileEditCommand = (command: string): boolean => {
  const compact = command.replace(/\s+/g, ' ').trim();
  return [
    /\bapply_patch\b/i,
    /\bcat\s+(?:>|<<)/i,
    /\btee\b/i,
    /\bpython(?:3)?\b.*(?:write|Path\(|open\(|mkdir|makedirs)/i,
    /\bnode\b.*(?:writeFile|mkdirSync)/i,
    /\bsed\s+-i\b/i,
    /\bperl\s+-pi\b/i,
    /\bmkdir\s+-p\b/i,
    /\btouch\b/i,
    /\b(?:cp|mv|rm)\s+/i,
  ].some((pattern) => pattern.test(compact));
};

export const getRunLogPath = (metadataRoot: string, runId: string): string => {
  return path.join(metadataRoot, 'runs', `${runId}.log`);
};

export const appendRunLog = async (
  runLogPath: string,
  stream: 'stdout' | 'stderr' | 'meta',
  text: string,
): Promise<void> => {
  try {
    await fs.mkdir(path.dirname(runLogPath), { recursive: true });
    const line = `[${new Date().toISOString()}] [${stream}] ${text}`;
    await fs.appendFile(runLogPath, line.endsWith('\n') ? line : `${line}\n`, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return;
    }
    throw error;
  }
};

export const normalizeErrorCode = (error: unknown): { code: ChatErrorCode; message: string } => {
  if (error && typeof error === 'object' && 'chatCode' in error) {
    const chatError = error as Error & { chatCode?: ChatErrorCode };
    return {
      code: chatError.chatCode ?? 'capability_unavailable',
      message: chatError.message,
    };
  }

  if (error instanceof Error) {
    return {
      code: 'capability_unavailable',
      message: error.message,
    };
  }

  return {
    code: 'capability_unavailable',
    message: 'unknown_error',
  };
};

export const mapFailureMessage = (code: ChatErrorCode, detail?: string, runLogPath?: string, locale?: string): string => {
  const copy = getSharedCopy(locale).chat.failures;
  const snippet = detail?.split('\n').slice(0, 2).join(' ').trim();
  const logHint = runLogPath ? ` Log: ${runLogPath}` : '';
  switch (code) {
    case 'auth_missing':
      return copy.authMissing;
    case 'app_not_installed':
      return copy.appNotInstalled;
    case 'permission_denied':
      return copy.permissionDenied;
    case 'timeout':
      return copy.timeout;
    case 'sandbox_violation':
      return copy.sandboxViolation;
    case 'dirty_worktree':
      return copy.dirtyWorktree;
    case 'conflict':
      return copy.conflict;
    case 'canceled':
      return copy.canceled(logHint);
    default:
      if (detail && /exec|unknown|command|not found|usage/i.test(detail)) {
        return copy.codexCliFailed(snippet ?? '', logHint).trim();
      }
      return copy.codexRequestFailed(snippet ?? '', logHint);
  }
};
