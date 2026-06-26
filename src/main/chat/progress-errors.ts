import fs from 'node:fs/promises';
import path from 'node:path';
import type { AgentProvider, ChatErrorCode, ChatStartRunInput } from '../../shared/types';
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

export const toProviderProgressMessages = (
  provider: AgentProvider,
  stream: 'stdout' | 'stderr' | 'meta',
  text: string,
  locale?: string,
): string[] => {
  const jsonMessages = toProgressMessages(stream, text, locale);
  if (jsonMessages.length > 0) {
    return jsonMessages;
  }
  if (provider === 'claude') {
    return toClaudeJsonProgressMessages(stream, text, locale);
  }
  if (provider !== 'antigravity') {
    return [];
  }
  return toAntigravityPlainTextProgressMessages(stream, text);
};

const toClaudeJsonProgressMessages = (
  stream: 'stdout' | 'stderr' | 'meta',
  text: string,
  locale?: string,
): string[] => {
  if (stream === 'meta') {
    return [];
  }

  const mapped: string[] = [];
  for (const line of text.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean)) {
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }

    const textProgress = normalizeClaudeProgressText(extractClaudeProgressText(entry));
    if (textProgress && mapped[mapped.length - 1] !== textProgress) {
      mapped.push(textProgress);
    }
    if (hasClaudeToolUse(entry)) {
      const usingTools = getSharedCopy(locale).chat.progress.usingTools;
      if (mapped[mapped.length - 1] !== usingTools) {
        mapped.push(usingTools);
      }
    }
  }
  return mapped.slice(-6);
};

const extractClaudeProgressText = (entry: Record<string, unknown>): string => {
  if (typeof entry.text === 'string') {
    return entry.text;
  }

  const message = entry.message;
  if (!message || typeof message !== 'object') {
    return '';
  }
  const content = (message as Record<string, unknown>).content;
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .map((item) => {
      if (!item || typeof item !== 'object') {
        return '';
      }
      const text = (item as Record<string, unknown>).text;
      return typeof text === 'string' ? text : '';
    })
    .filter(Boolean)
    .join('\n');
};

const hasClaudeToolUse = (entry: Record<string, unknown>): boolean => {
  const type = typeof entry.type === 'string' ? entry.type : '';
  if (type === 'tool_use') {
    return true;
  }

  const message = entry.message;
  if (!message || typeof message !== 'object') {
    return false;
  }
  const content = (message as Record<string, unknown>).content;
  return Array.isArray(content) && content.some((item) => {
    if (!item || typeof item !== 'object') {
      return false;
    }
    return (item as Record<string, unknown>).type === 'tool_use';
  });
};

const normalizeClaudeProgressText = (text: string): string => {
  const compact = stripMarkdown(text)
    .replace(/\s+/g, ' ')
    .trim();
  return compact.length > 160 ? `${compact.slice(0, 157)}...` : compact;
};

const toAntigravityPlainTextProgressMessages = (
  stream: 'stdout' | 'stderr' | 'meta',
  text: string,
): string[] => {
  if (stream === 'meta') {
    return [];
  }

  const mapped: string[] = [];
  for (const line of text.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean)) {
    if (isAntigravityProgressNoise(line)) {
      continue;
    }
    const normalized = normalizeAntigravityProgressLine(line);
    if (normalized && mapped[mapped.length - 1] !== normalized) {
      mapped.push(normalized);
    }
  }
  return mapped.slice(-6);
};

const normalizeAntigravityProgressLine = (line: string): string => {
  const compact = stripMarkdown(line)
    .replace(/\s+/g, ' ')
    .trim();
  return compact.length > 160 ? `${compact.slice(0, 157)}...` : compact;
};

const isAntigravityProgressNoise = (line: string): boolean => {
  const compact = line.trim();
  return [
    /^$/,
    /^Print mode:/i,
    /^Created conversation\s+/i,
    /^Streaming conversation\s+/i,
    /^conversationID=/i,
    /^(?:conversation|Conversation|CONVERSATION)[\s_-]*(?:id|ID)\s*[:=]/,
    /^agy\s+(?:--conversation|-c)\s+/i,
    /^Authentication required\./i,
    /^Waiting for authentication/i,
    /^Or, paste the authorization code/i,
    /^MCP config/i,
    /^Using config/i,
    /^Log file:/i,
  ].some((pattern) => pattern.test(compact));
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

const stripMarkdown = (text: string): string =>
  text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^[\s>*-]+/gm, '');

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

export const normalizeProviderErrorCode = (error: unknown): { code: ChatErrorCode; message: string } | null => {
  if (!error || typeof error !== 'object' || !('chatCode' in error)) {
    return null;
  }
  return normalizeErrorCode(error);
};

export const mapFailureMessage = (
  code: ChatErrorCode,
  detail?: string,
  runLogPath?: string,
  locale?: string,
  provider?: AgentProvider,
): string => {
  const copy = getSharedCopy(locale).chat.failures;
  const snippet = detail?.split('\n').slice(0, 2).join(' ').trim();
  const logHint = runLogPath ? ` Log: ${runLogPath}` : '';
  const providerName = providerDisplayName(provider);
  switch (code) {
    case 'auth_missing':
      return providerName ? copy.authMissingProvider(providerName) : copy.authMissing;
    case 'codex_auth_expired':
      return copy.authMissingProvider('Codex');
    case 'app_not_installed':
      return copy.appNotInstalled;
    case 'permission_denied':
      return copy.permissionDenied;
    case 'timeout':
      return copy.timeout;
    case 'quota_exceeded':
      return copy.quotaExceeded(providerNameFromQuotaDetail(detail));
    case 'model_unsupported':
      return copy.modelUnsupported(providerNameFromModelUnsupportedDetail(detail) || providerName);
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
        return providerName && provider !== 'codex'
          ? copy.providerCliFailed(providerName, snippet ?? '', logHint).trim()
          : copy.codexCliFailed(snippet ?? '', logHint).trim();
      }
      return providerName && provider !== 'codex'
        ? copy.providerRequestFailed(providerName, snippet ?? '', logHint)
        : copy.codexRequestFailed(snippet ?? '', logHint);
  }
};

const providerNameFromQuotaDetail = (detail?: string): string => {
  const compact = detail?.replace(/\s+/g, ' ').trim() ?? '';
  const match = compact.match(/^(Google Antigravity|Codex|Claude(?: Code)?)\s+quota exceeded\b/i);
  return match?.[1] ?? '';
};

const providerNameFromModelUnsupportedDetail = (detail?: string): string => {
  const compact = detail?.replace(/\s+/g, ' ').trim() ?? '';
  const match = compact.match(/^(Google Antigravity|Codex|Claude(?: Code)?)\s+model unsupported\b/i);
  return match?.[1] ?? '';
};

const providerDisplayName = (provider?: AgentProvider): string => {
  if (provider === 'claude') {
    return 'Claude Code';
  }
  if (provider === 'antigravity') {
    return 'Google Antigravity';
  }
  if (provider === 'codex') {
    return 'Codex';
  }
  return '';
};
