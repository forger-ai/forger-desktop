import type {
  AppCodexConversation,
  AppCodexConversationRun,
  AppCodexConversationRunStatus,
  AppCodexConversationMessage,
  AppAgentRunSummary,
  AppAgentThreadSummary,
  AgentRuntime,
  CodexReasoningEffort,
} from '../../shared/types';
import { getSharedCopy } from '../../shared/i18n';
import { renderPromptFile } from '../prompt-builder';
import { isInternalProviderProgressText } from '../chat/progress-errors';

export interface InternalConversationShape extends AppCodexConversation {
  threadId?: string | null;
  runtime?: AgentRuntime;
  metadata?: Record<string, string | number | boolean | null>;
}

const MAX_CONTEXT_CHARS = 40_000;
const DEFAULT_MODEL = 'gpt-5.2';
const DEFAULT_REASONING: CodexReasoningEffort = 'medium';

export const buildManifestAgentStartPrompt = (manifestPrompt: string): string =>
  renderPromptFile('agent-threads/start.md', { manifestPrompt: manifestPrompt.trim() });

export const buildManifestAgentResumePrompt = (manifestPrompt: string): string =>
  renderPromptFile('agent-threads/resume.md', { manifestPrompt: manifestPrompt.trim() });

export const buildManifestAgentSteerPrompt = (manifestPrompt: string): string =>
  renderPromptFile('agent-threads/steer.md', { manifestPrompt: manifestPrompt.trim() });

export const buildManifestAgentRecoveryPrompt = (
  manifestPrompt: string,
  chatHistory: string,
): string => renderPromptFile('agent-threads/recovery.md', {
  manifestPrompt: manifestPrompt.trim(),
  chatHistory: chatHistory.trim().slice(-MAX_CONTEXT_CHARS),
});

export const buildConversationRecoveryContext = (
  conversation: { messages: AppCodexConversationMessage[] },
  activeRunId: string,
): string => {
  const priorMessages = conversation.messages.filter((message) => message.runId !== activeRunId);
  if (priorMessages.length === 0) {
    return '';
  }
  const transcript = priorMessages
    .map((message) => `${message.role}: ${message.text.trim()}`)
    .join('\n\n')
    .slice(-MAX_CONTEXT_CHARS);
  return transcript;
};

export const toConversation = (conversation: InternalConversationShape): AppCodexConversation => ({
  conversationId: conversation.conversationId,
  appId: conversation.appId,
  title: conversation.title,
  createdAt: conversation.createdAt,
  updatedAt: conversation.updatedAt,
  messages: conversation.messages,
  ...(conversation.activeRun ? { activeRun: conversation.activeRun } : {}),
});

export const toRun = (run: AppCodexConversationRun): AppCodexConversationRun => ({
  runId: run.runId,
  status: run.status,
  createdAt: run.createdAt,
  updatedAt: run.updatedAt,
  ...(run.error ? { error: run.error } : {}),
  ...(run.errorDetails ? { errorDetails: run.errorDetails } : {}),
  ...(run.progressLog ? { progressLog: run.progressLog } : {}),
  ...(run.activity ? { activity: run.activity } : {}),
  ...(run.permissionRequest ? { permissionRequest: run.permissionRequest } : {}),
});

export const toAppAgentThreadSummary = (conversation: AppCodexConversation | null): AppAgentThreadSummary | null => {
  if (!conversation) {
    return null;
  }
  return {
    desktop_thread_id: conversation.conversationId,
    title: conversation.title,
    status: conversation.activeRun?.status ?? 'idle',
    ...(conversation.activeRun ? { active_run: toAppAgentRunSummary(conversation.conversationId, conversation.activeRun, conversation.messages) ?? undefined } : {}),
    messages: conversation.messages.map((message) => ({
      id: message.messageId,
      role: message.role,
      content: message.text,
      created_at: message.createdAt,
    })),
    ...(conversation.activeRun?.progressLog ? { progressLog: conversation.activeRun.progressLog } : {}),
  };
};

export const toAppAgentRunSummary = (
  desktopThreadId: string,
  run: AppCodexConversationRun | undefined,
  messages: AppCodexConversationMessage[] = [],
): AppAgentRunSummary | null => {
  if (!run) {
    return null;
  }
  const resultText = latestAssistantTextForRun(messages, run.runId);
  return {
    desktop_thread_id: desktopThreadId,
    desktop_run_id: run.runId,
    status: run.status,
    ...(run.error ? { error: run.error } : {}),
    ...(resultText ? { resultText } : {}),
    ...(run.progressLog ? { progressLog: run.progressLog } : {}),
    ...(run.activity ? { activity: run.activity } : {}),
  };
};

export const toAppAgentRunSummaryForId = (
  conversation: AppCodexConversation | null,
  desktopThreadId: string,
  desktopRunId: string,
): AppAgentRunSummary | null => {
  if (!conversation) {
    return null;
  }
  if (conversation.activeRun?.runId === desktopRunId) {
    return toAppAgentRunSummary(desktopThreadId, conversation.activeRun, conversation.messages);
  }
  const resultText = latestAssistantTextForRun(conversation.messages, desktopRunId);
  if (!resultText) {
    return null;
  }
  return {
    desktop_thread_id: desktopThreadId,
    desktop_run_id: desktopRunId,
    status: 'completed',
    resultText,
  };
};

export const latestAssistantTextForRun = (
  messages: AppCodexConversationMessage[],
  runId: string,
): string | null => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === 'assistant' && message.runId === runId && message.text.trim()) {
      return message.text;
    }
  }
  return null;
};

export const isTerminalRunStatus = (status: AppCodexConversationRunStatus): boolean =>
  status === 'completed' || status === 'failed' || status === 'canceled';

export const isMissingProviderThread = (stdout: string, stderr: string): boolean => {
  const combined = `${stderr}\n${stdout}`.toLowerCase();
  return (
    combined.includes('no rollout found for thread id') ||
    combined.includes('thread/resume failed') ||
    combined.includes('conversation not found') ||
    combined.includes('session not found')
  );
};

export const sanitizeId = (value: string): string => value.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 120) || 'app';

export const extensionForMimeType = (mimeType: string): string => {
  if (mimeType.includes('jpeg') || mimeType.includes('jpg')) {
    return 'jpg';
  }
  if (mimeType.includes('webp')) {
    return 'webp';
  }
  if (mimeType.includes('svg')) {
    return 'svg';
  }
  return 'png';
};

export const sanitizeTitle = (value: unknown): string =>
  typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, 120) : '';

export const normalizeMetadata = (value: unknown): Record<string, string | number | boolean | null> | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const output: Record<string, string | number | boolean | null> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean' || item === null) {
      output[key] = item;
    }
  }
  return output;
};

export const progressFromCodexOutput = (text: string, locale?: string): string | null => {
  const copy = getSharedCopy(locale).appConversation;
  for (const line of text.split('\n').map((entry) => entry.trim()).filter(Boolean)) {
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (parsed.type === 'turn.started') {
        return copy.agentThinking;
      }
      if (parsed.type === 'item.completed' && parsed.item && typeof parsed.item === 'object') {
        const item = parsed.item as Record<string, unknown>;
        if (item.type === 'agent_message' && typeof item.text === 'string') {
          if (isInternalProviderProgressText(item.text)) {
            return null;
          }
          const compact = stripMarkdown(item.text).replace(/\s+/g, ' ').trim();
          if (!compact || isInternalProviderProgressText(compact)) {
            return null;
          }
          return compact.length > 160 ? `${compact.slice(0, 157)}...` : compact;
        }
        if (String(item.type ?? '').includes('tool') || item.type === 'command_execution') {
          return copy.usingTools;
        }
      }
      if (parsed.type === 'item.started' && parsed.item && typeof parsed.item === 'object') {
        const item = parsed.item as Record<string, unknown>;
        if (String(item.type ?? '').includes('tool') || item.type === 'command_execution') {
          return copy.usingTools;
        }
      }
    } catch {
      continue;
    }
  }
  return null;
};

const stripMarkdown = (text: string): string =>
  text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^>\s?/gm, '')
    .replace(/^[\s*-]*[-*+]\s+/gm, '')
    .replace(/^[\s\d.]+[.)]\s+/gm, '')
    .replace(/[*_~]+/g, '')
    .trim();

export const defaultAgentRuntime = (): { model: string; reasoningEffort: CodexReasoningEffort } => ({
  model: DEFAULT_MODEL,
  reasoningEffort: DEFAULT_REASONING,
});
