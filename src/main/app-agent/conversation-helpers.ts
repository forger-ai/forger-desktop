import type {
  AppCodexConversation,
  AppCodexConversationRun,
  AppCodexConversationRunStatus,
  AppCodexConversationMessage,
  AgentRuntime,
  CodexReasoningEffort,
} from '../../shared/types';
import { getSharedCopy } from '../../shared/i18n';

export interface InternalConversationShape extends AppCodexConversation {
  threadId?: string | null;
  runtime?: AgentRuntime;
  metadata?: Record<string, string | number | boolean | null>;
}

interface RuntimePromptEnvelope {
  runtimeContract?: string;
  interfaceObjective?: string;
  turnPayload: string;
}

const MAX_CONTEXT_CHARS = 40_000;
const DEFAULT_MODEL = 'gpt-5.4';
const DEFAULT_REASONING: CodexReasoningEffort = 'medium';

export const buildAppAgentPrompt = (message: string, context: string | undefined, initialPrompt?: string): string => {
  const trimmedContext = (context ?? '').trim();
  const promptEnvelope = parseRuntimePromptEnvelope(trimmedContext);
  const parts: string[] = [];
  const trimmedInitialPrompt = initialPrompt?.trim();
  if (trimmedInitialPrompt) {
    parts.push(trimmedInitialPrompt, '');
  }
  if (promptEnvelope.runtimeContract) {
    parts.push(
      'Runtime contract:',
      promptEnvelope.runtimeContract,
      '',
      'Interface objective:',
      promptEnvelope.interfaceObjective || 'Follow the current app interface objective from the turn payload.',
      '',
      'Turn payload:',
      promptEnvelope.turnPayload || '{}',
      '',
      'Message:',
      message.trim(),
    );
    return parts.join('\n');
  }
  const legacyContext = trimmedContext.slice(0, MAX_CONTEXT_CHARS);
  if (!legacyContext) {
    parts.push(message.trim());
    return parts.join('\n');
  }
  parts.push(
    'Contexto actual de la app:',
    legacyContext,
    '',
    'Mensaje del usuario:',
    message.trim(),
    '',
    'Usa las herramientas MCP de la app cuando necesites modificar su estado. Responde breve para mostrar el resultado dentro de la app.',
  );
  return parts.join('\n');
};

const parseRuntimePromptEnvelope = (context: string): RuntimePromptEnvelope => {
  if (!context) {
    return { turnPayload: '' };
  }
  try {
    const parsed = JSON.parse(context) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { turnPayload: context.slice(0, MAX_CONTEXT_CHARS) };
    }
    const payload = { ...(parsed as Record<string, unknown>) };
    const runtimeContract = typeof payload.runtime_contract === 'string' ? payload.runtime_contract.trim() : '';
    const interfaceObjective = typeof payload.interface_objective === 'string' ? payload.interface_objective.trim() : '';
    delete payload.runtime_contract;
    delete payload.interface_objective;
    return {
      runtimeContract,
      interfaceObjective,
      turnPayload: JSON.stringify(payload, null, 2).slice(0, MAX_CONTEXT_CHARS),
    };
  } catch {
    return { turnPayload: context.slice(0, MAX_CONTEXT_CHARS) };
  }
};

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
  return [
    'Historial persistido de este Desktop thread:',
    transcript,
    '',
    'Continúa en el mismo Desktop thread usando este historial como contexto.',
  ].join('\n');
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
  ...(run.progressLog ? { progressLog: run.progressLog } : {}),
  ...(run.permissionRequest ? { permissionRequest: run.permissionRequest } : {}),
});

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
          const compact = stripMarkdown(item.text).replace(/\s+/g, ' ').trim();
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
