import type { ChatMessage } from '@renderer/views/ChatView';
import { normalizePersistedActiveChatRun, type PersistedActiveChatRun } from '@shared/chat-run-state';
import type { AgentEffort, AgentProvider } from '@shared/types';

export const CHAT_STORAGE_KEY = 'forger-chat-conversations-v1';

export interface ChatConversation {
  id: string;
  appId: string;
  title: string;
  threadId: string | null;
  runtime?: {
    provider: AgentProvider;
    model: string;
    effort: AgentEffort;
  };
  createdAt: string;
  updatedAt: string;
  messages: ChatMessage[];
}

export interface PersistedChatState {
  conversations: ChatConversation[];
  activeConversationByApp: Record<string, string>;
  lastActiveConversationId: string | null;
  activeRun: PersistedActiveChatRun | null;
}

const emptyPersistedChatState = (): PersistedChatState => ({
  conversations: [],
  activeConversationByApp: {},
  lastActiveConversationId: null,
  activeRun: null,
});

const migrateLegacyConversationRuntime = (conversation: ChatConversation): ChatConversation => {
  if (conversation.runtime) {
    return conversation;
  }
  if (!conversation.threadId && conversation.messages.length === 0) {
    return conversation;
  }
  return {
    ...conversation,
    runtime: {
      provider: 'codex',
      model: 'gpt-5.4',
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
    return {
      conversations: Array.isArray(parsed.conversations)
        ? parsed.conversations.map(migrateLegacyConversationRuntime)
        : [],
      activeConversationByApp:
        parsed.activeConversationByApp && typeof parsed.activeConversationByApp === 'object'
          ? (parsed.activeConversationByApp as Record<string, string>)
          : {},
      lastActiveConversationId:
        typeof parsed.lastActiveConversationId === 'string' ? parsed.lastActiveConversationId : null,
      activeRun: normalizePersistedActiveChatRun(parsed.activeRun),
    };
  } catch {
    return emptyPersistedChatState();
  }
};

export const makeConversationId = () =>
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `conv-${Date.now()}`;

export const summarizeConversationTitle = (prompt: string, fallback = 'New conversation'): string => {
  const compact = prompt.replace(/\s+/g, ' ').trim();
  if (!compact) {
    return fallback;
  }
  return compact.length <= 56 ? compact : `${compact.slice(0, 56)}...`;
};
