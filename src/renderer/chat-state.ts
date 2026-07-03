import type { ChatMessage } from '@renderer/views/ChatView';
import {
  normalizePersistedActiveChatRun,
  normalizePersistedActiveChatRuns,
  type PersistedActiveChatRun,
} from '@shared/chat-run-state';
import type { AgentEffort, AgentProvider, ChatMode } from '@shared/types';

export const CHAT_STORAGE_KEY = 'forger-chat-conversations-v1';
export type { ChatMode };

export interface ChatConversation {
  id: string;
  appId: string;
  mode?: ChatMode;
  targetAppId?: string | null;
  title: string;
  threadId: string | null;
  runtime?: {
    provider: AgentProvider;
    model: string;
    effort: AgentEffort;
    authProfileId?: string;
  };
  createdAt: string;
  updatedAt: string;
  messages: ChatMessage[];
}

export interface PersistedChatState {
  conversations: ChatConversation[];
  activeConversationByApp: Record<string, string>;
  lastActiveConversationId: string | null;
  activeRuns: PersistedActiveChatRun[];
  activeRun?: PersistedActiveChatRun | null;
  draftInputByConversationId?: Record<string, string>;
}

const emptyPersistedChatState = (): PersistedChatState => ({
  conversations: [],
  activeConversationByApp: {},
  lastActiveConversationId: null,
  activeRuns: [],
  draftInputByConversationId: {},
});

const normalizeChatMode = (value: unknown): ChatMode | undefined =>
  value === 'create_app' || value === 'edit_app' || value === 'free_chat' || value === 'social_app_review' ? value : undefined;

const migrateLegacyConversation = (conversation: ChatConversation): ChatConversation => {
  const mode = normalizeChatMode(conversation.mode) ?? (conversation.appId === 'forger' ? 'free_chat' : 'edit_app');
  const targetAppId = mode === 'edit_app' || mode === 'social_app_review' ? (conversation.targetAppId ?? conversation.appId) : null;
  const normalizedConversation: ChatConversation = {
    ...conversation,
    mode,
    targetAppId,
  };

  if (normalizedConversation.runtime) {
    return normalizedConversation;
  }
  if (!normalizedConversation.threadId && normalizedConversation.messages.length === 0) {
    return normalizedConversation;
  }
  return {
    ...normalizedConversation,
    runtime: {
      provider: 'codex',
      model: 'gpt-5.2',
      effort: 'medium',
    },
  };
};

export const readPersistedChatState = (): PersistedChatState => {
  if (typeof window === 'undefined') {
    return emptyPersistedChatState();
  }

  const raw = window.localStorage.getItem(CHAT_STORAGE_KEY);
  if (!raw) {
    return emptyPersistedChatState();
  }

  try {
    const parsed = JSON.parse(raw) as Partial<PersistedChatState>;
    const activeRuns = normalizePersistedActiveChatRuns(parsed.activeRuns);
    const legacyActiveRun = normalizePersistedActiveChatRun(parsed.activeRun);
    return {
      conversations: Array.isArray(parsed.conversations)
        ? parsed.conversations.map(migrateLegacyConversation)
        : [],
      activeConversationByApp:
        parsed.activeConversationByApp && typeof parsed.activeConversationByApp === 'object'
          ? (parsed.activeConversationByApp as Record<string, string>)
          : {},
      lastActiveConversationId:
        typeof parsed.lastActiveConversationId === 'string' ? parsed.lastActiveConversationId : null,
      activeRuns: activeRuns.length > 0 ? activeRuns : legacyActiveRun ? [legacyActiveRun] : [],
      draftInputByConversationId:
        parsed.draftInputByConversationId && typeof parsed.draftInputByConversationId === 'object'
          ? Object.fromEntries(Object.entries(parsed.draftInputByConversationId).filter(([, value]) => typeof value === 'string'))
          : {},
    };
  } catch {
    return emptyPersistedChatState();
  }
};

export const makeConversationId = () =>
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `conv-${Date.now()}`;

export const appendChatMessageOnce = (
  conversation: ChatConversation,
  message: ChatMessage,
  updatedAt = new Date().toISOString(),
): ChatConversation => {
  if (conversation.messages.some((existingMessage) => existingMessage.id === message.id)) {
    return conversation;
  }

  return {
    ...conversation,
    updatedAt,
    messages: [...conversation.messages, message],
  };
};

export const appendChatMessageToConversationOnce = (
  conversations: ChatConversation[],
  conversationId: string,
  message: ChatMessage,
  options: {
    threadId?: string | null;
    updatedAt?: string;
  } = {},
): ChatConversation[] =>
  conversations.map((conversation) => {
    if (conversation.id !== conversationId) {
      return conversation;
    }

    const nextConversation = appendChatMessageOnce(conversation, message, options.updatedAt);
    if (nextConversation === conversation && !options.threadId) {
      return conversation;
    }

    return {
      ...nextConversation,
      threadId:
        typeof options.threadId === 'string' && options.threadId.trim().length > 0
          ? options.threadId
          : nextConversation.threadId,
    };
  });

export const summarizeConversationTitle = (prompt: string, fallback = 'New conversation'): string => {
  const compact = prompt.replace(/\s+/g, ' ').trim();
  if (!compact) {
    return fallback;
  }
  return compact.length <= 56 ? compact : `${compact.slice(0, 56)}...`;
};
