import chatBotIcon from '@renderer/assets/chat-bot-icon.png';
import chatFemaleIcon from '@renderer/assets/chat-female-icon.png';
import chatMaleIcon from '@renderer/assets/chat-male-icon.png';
import { defaultLocale, type Locale } from '@renderer/i18n';
import type { ThemePreference } from '@renderer/theme/appTheme';
import type { AgentProvider, ClaudeEffort, CodexModelOption, CodexReasoningEffort } from '@shared/types';

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

export const CODEX_MODEL_OPTIONS: CodexModelOption[] = [
  { displayModelName: '5.4', realModelName: 'gpt-5.4', defaultReasoningEffort: 'medium' as const },
  { displayModelName: '5.3 Codex', realModelName: 'gpt-5.3-codex', defaultReasoningEffort: 'low' as const },
  { displayModelName: '5.3 Spark', realModelName: 'gpt-5.3-codex-spark', defaultReasoningEffort: 'high' as const },
  { displayModelName: '5.4 Mini', realModelName: 'gpt-5.4-mini', defaultReasoningEffort: 'medium' as const },
  { displayModelName: '5.5', realModelName: 'gpt-5.5', defaultReasoningEffort: 'medium' as const },
];

export const CODEX_REASONING_OPTIONS: { label: string; value: CodexReasoningEffort }[] = [
  { label: 'Low', value: 'low' },
  { label: 'Medium', value: 'medium' },
  { label: 'High', value: 'high' },
  { label: 'XHigh', value: 'xhigh' },
];

export const AGENT_PROVIDER_OPTIONS: Array<{ label: string; value: AgentProvider | 'auto' }> = [
  { label: 'Auto', value: 'auto' },
  { label: 'Codex', value: 'codex' },
  { label: 'Claude', value: 'claude' },
];

export const CLAUDE_MODEL_OPTIONS: Array<{ displayModelName: string; realModelName: string; defaultEffort: ClaudeEffort }> = [
  { displayModelName: 'Sonnet latest (Claude Code alias)', realModelName: 'sonnet', defaultEffort: 'medium' },
  { displayModelName: 'Opus latest (Claude Code alias)', realModelName: 'opus', defaultEffort: 'high' },
  { displayModelName: 'Haiku latest (Claude Code alias)', realModelName: 'haiku', defaultEffort: 'low' },
];

export const CLAUDE_EFFORT_OPTIONS: { label: string; value: ClaudeEffort }[] = [
  { label: 'Low', value: 'low' },
  { label: 'Medium', value: 'medium' },
  { label: 'High', value: 'high' },
  { label: 'XHigh', value: 'xhigh' },
  { label: 'Max', value: 'max' },
];

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
  return CODEX_MODEL_OPTIONS.some((option) => option.realModelName === stored)
    ? stored as string
    : CODEX_MODEL_OPTIONS[0].realModelName;
};

export const getStoredCodexReasoningEffort = (): CodexReasoningEffort => {
  if (typeof window === 'undefined') {
    return CODEX_MODEL_OPTIONS[0].defaultReasoningEffort;
  }
  const stored = window.localStorage.getItem(CODEX_REASONING_STORAGE_KEY);
  return CODEX_REASONING_OPTIONS.some((option) => option.value === stored)
    ? stored as CodexReasoningEffort
    : CODEX_MODEL_OPTIONS[0].defaultReasoningEffort;
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
  return CLAUDE_MODEL_OPTIONS.some((option) => option.realModelName === stored)
    ? stored as string
    : CLAUDE_MODEL_OPTIONS[0].realModelName;
};

export const getStoredClaudeEffort = (): ClaudeEffort => {
  if (typeof window === 'undefined') {
    return CLAUDE_MODEL_OPTIONS[0].defaultEffort;
  }
  const stored = window.localStorage.getItem(CLAUDE_EFFORT_STORAGE_KEY);
  return CLAUDE_EFFORT_OPTIONS.some((option) => option.value === stored)
    ? stored as ClaudeEffort
    : CLAUDE_MODEL_OPTIONS[0].defaultEffort;
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
