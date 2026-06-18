import chatBotIcon from '@renderer/assets/chat-bot-icon.png';
import chatFemaleIcon from '@renderer/assets/chat-female-icon.png';
import chatMaleIcon from '@renderer/assets/chat-male-icon.png';
import { defaultLocale, type Locale } from '@renderer/i18n';
import type { ThemePreference } from '@renderer/theme/appTheme';
import type { AgentProvider, ClaudeEffort, CodexReasoningEffort } from '@shared/types';
import {
  AGENT_PROVIDER_OPTIONS,
  ANTIGRAVITY_EFFORT_OPTIONS,
  ANTIGRAVITY_MODEL_OPTIONS,
  CLAUDE_EFFORT_OPTIONS,
  CLAUDE_MODEL_OPTIONS,
  CODEX_MODEL_OPTIONS,
  CODEX_REASONING_OPTIONS,
  getDefaultClaudeEffort,
  getDefaultCodexReasoningEffort,
  isClaudeEffort,
  isClaudeModel,
  isCodexModel,
  isCodexReasoningEffort,
} from '@shared/types';

export const THEME_STORAGE_KEY = 'forger-theme-preference';
export const LANGUAGE_STORAGE_KEY = 'forger-language-preference';
export const CODEX_MODEL_STORAGE_KEY = 'forger-codex-model-v1';
export const CODEX_REASONING_STORAGE_KEY = 'forger-codex-reasoning-effort-v1';
export const CHAT_AGENT_PROVIDER_STORAGE_KEY = 'forger-chat-agent-provider-v1';
export const CLAUDE_MODEL_STORAGE_KEY = 'forger-claude-model-v1';
export const CLAUDE_EFFORT_STORAGE_KEY = 'forger-claude-effort-v1';
export const CHAT_BOT_PICTURE_STORAGE_KEY = 'forger-chat-bot-picture-v1';
export const STARTUP_UPDATE_CHECK_STORAGE_KEY = 'forger-desktop-startup-update-check-v1';

export type ChatBotPicture = 'bot' | 'female' | 'male';
export type LanguagePreference = 'system' | Locale;

export const SUPPORTED_LOCALES: Locale[] = ['es', 'en'];

export const CHAT_BOT_PICTURE_OPTIONS: Array<{ value: ChatBotPicture; label: string; src: string }> = [
  { value: 'bot', label: 'Bot', src: chatBotIcon },
  { value: 'female', label: 'Female', src: chatFemaleIcon },
  { value: 'male', label: 'Male', src: chatMaleIcon },
];

export {
  AGENT_PROVIDER_OPTIONS,
  ANTIGRAVITY_EFFORT_OPTIONS,
  ANTIGRAVITY_MODEL_OPTIONS,
  CLAUDE_EFFORT_OPTIONS,
  CLAUDE_MODEL_OPTIONS,
  CODEX_MODEL_OPTIONS,
  CODEX_REASONING_OPTIONS,
};

export const normalizeLocale = (value?: string | null): Locale | null => {
  if (!value) {
    return null;
  }
  const normalized = value.toLowerCase();
  return SUPPORTED_LOCALES.find((locale) => normalized === locale || normalized.startsWith(`${locale}-`)) ?? null;
};

export const resolveSystemLocale = (): Locale => {
  if (typeof navigator === 'undefined') {
    return defaultLocale;
  }
  for (const language of navigator.languages ?? []) {
    const locale = normalizeLocale(language);
    if (locale) {
      return locale;
    }
  }
  return normalizeLocale(navigator.language) ?? defaultLocale;
};

export const getStoredLanguagePreference = (): LanguagePreference => {
  if (typeof window === 'undefined') {
    return 'system';
  }
  const stored = window.localStorage.getItem(LANGUAGE_STORAGE_KEY);
  if (stored === 'system' || SUPPORTED_LOCALES.includes(stored as Locale)) {
    return stored as LanguagePreference;
  }
  return 'system';
};

export const getStoredThemePreference = (): ThemePreference => {
  if (typeof window === 'undefined') {
    return 'system';
  }

  const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
  if (stored === 'light' || stored === 'dark' || stored === 'system') {
    return stored;
  }

  return 'system';
};

export const getStoredCodexModel = (): string => {
  if (typeof window === 'undefined') {
    return CODEX_MODEL_OPTIONS[0].realModelName;
  }
  const stored = window.localStorage.getItem(CODEX_MODEL_STORAGE_KEY);
  return isCodexModel(stored)
    ? stored as string
    : CODEX_MODEL_OPTIONS[0].realModelName;
};

export const getStoredCodexReasoningEffort = (): CodexReasoningEffort => {
  if (typeof window === 'undefined') {
    return getDefaultCodexReasoningEffort(CODEX_MODEL_OPTIONS[0].realModelName);
  }
  const stored = window.localStorage.getItem(CODEX_REASONING_STORAGE_KEY);
  return isCodexReasoningEffort(stored)
    ? stored as CodexReasoningEffort
    : getDefaultCodexReasoningEffort(CODEX_MODEL_OPTIONS[0].realModelName);
};

export const getStoredChatAgentProvider = (): AgentProvider | 'auto' => {
  if (typeof window === 'undefined') {
    return 'auto';
  }
  const stored = window.localStorage.getItem(CHAT_AGENT_PROVIDER_STORAGE_KEY);
  return stored === 'codex' || stored === 'claude' || stored === 'auto' ? stored : 'auto';
};

export const getStoredClaudeModel = (): string => {
  if (typeof window === 'undefined') {
    return CLAUDE_MODEL_OPTIONS[0].realModelName;
  }
  const stored = window.localStorage.getItem(CLAUDE_MODEL_STORAGE_KEY);
  return isClaudeModel(stored)
    ? stored as string
    : CLAUDE_MODEL_OPTIONS[0].realModelName;
};

export const getStoredClaudeEffort = (): ClaudeEffort => {
  if (typeof window === 'undefined') {
    return getDefaultClaudeEffort(CLAUDE_MODEL_OPTIONS[0].realModelName);
  }
  const stored = window.localStorage.getItem(CLAUDE_EFFORT_STORAGE_KEY);
  return isClaudeEffort(stored)
    ? stored as ClaudeEffort
    : getDefaultClaudeEffort(CLAUDE_MODEL_OPTIONS[0].realModelName);
};

export const getStoredChatBotPicture = (): ChatBotPicture => {
  if (typeof window === 'undefined') {
    return 'bot';
  }
  const stored = window.localStorage.getItem(CHAT_BOT_PICTURE_STORAGE_KEY);
  if (stored === 'bot' || stored === 'female' || stored === 'male') {
    return stored;
  }
  const options = CHAT_BOT_PICTURE_OPTIONS.map((option) => option.value);
  return options[Math.floor(Math.random() * options.length)] ?? 'bot';
};
