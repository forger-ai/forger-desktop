import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '@renderer/views/ChatView';
import {
  ANTIGRAVITY_EFFORT_OPTIONS,
  ANTIGRAVITY_MODEL_OPTIONS,
  CHAT_AGENT_PROVIDER_STORAGE_KEY,
  CHAT_BOT_PICTURE_OPTIONS,
  CHAT_BOT_PICTURE_STORAGE_KEY,
  CLAUDE_EFFORT_OPTIONS,
  CLAUDE_MODEL_OPTIONS,
  CODEX_MODEL_OPTIONS,
  CODEX_REASONING_OPTIONS,
  LANGUAGE_STORAGE_KEY,
  THEME_STORAGE_KEY,
  getStoredAntigravityEffort,
  getStoredAntigravityModel,
  getStoredChatAgentProvider,
  getStoredChatBotPicture,
  getStoredClaudeEffort,
  getStoredClaudeModel,
  getStoredCodexModel,
  getStoredCodexReasoningEffort,
  getStoredLanguagePreference,
  getStoredThemePreference,
  normalizeLocale,
  resolveSystemLocale,
} from '@renderer/preferences';
import {
  CHAT_STORAGE_KEY,
  appendChatMessageOnce,
  appendChatMessageToConversationOnce,
  makeConversationId,
  readPersistedChatState,
  summarizeConversationTitle,
  type ChatConversation,
} from '@renderer/chat-state';
import {
  buildErrorReport,
  isIgnoredBrowserNoise,
  shouldPromptForErrorReport,
} from '@renderer/error-reporting';
import { buildAppTheme, resolveThemeMode } from '@renderer/theme/appTheme';

const CODEX_MODEL_STORAGE_KEY = 'forger-codex-model-v1';
const CODEX_REASONING_STORAGE_KEY = 'forger-codex-reasoning-effort-v1';
const CLAUDE_MODEL_STORAGE_KEY = 'forger-claude-model-v1';
const CLAUDE_EFFORT_STORAGE_KEY = 'forger-claude-effort-v1';
const ANTIGRAVITY_MODEL_STORAGE_KEY = 'forger-antigravity-model-v1';
const ANTIGRAVITY_EFFORT_STORAGE_KEY = 'forger-antigravity-effort-v1';

const emptyState = {
  conversations: [],
  activeConversationByApp: {},
  lastActiveConversationId: null,
  activeRuns: [],
  draftInputByConversationId: {},
};

const chatMessage = (id: string, content = id): ChatMessage => ({
  id,
  role: 'user',
  content,
});

const chatConversation = (
  id: string,
  options: Partial<ChatConversation> = {},
): ChatConversation => ({
  id,
  appId: 'app-1',
  title: id,
  threadId: null,
  createdAt: '2026-08-10T00:00:00.000Z',
  updatedAt: '2026-08-10T00:00:00.000Z',
  messages: [],
  ...options,
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe('renderer preferences', () => {
  it.each([
    [undefined, null],
    [null, null],
    ['', null],
    ['ES', 'es'],
    ['es-CL', 'es'],
    ['EN-us', 'en'],
    ['fr-FR', null],
  ] as const)('normalizes locale %s to %s', (value, expected) => {
    expect(normalizeLocale(value)).toBe(expected);
  });

  it('resolves system locale from ordered browser preferences and safe fallbacks', () => {
    const languages = vi.spyOn(window.navigator, 'languages', 'get');
    const language = vi.spyOn(window.navigator, 'language', 'get');
    languages.mockReturnValue(['fr-FR', 'en-US']);
    language.mockReturnValue('es-CL');
    expect(resolveSystemLocale()).toBe('en');

    languages.mockReturnValue([]);
    expect(resolveSystemLocale()).toBe('es');
    languages.mockReturnValue(undefined as unknown as readonly string[]);
    expect(resolveSystemLocale()).toBe('es');
    language.mockReturnValue('fr-FR');
    expect(resolveSystemLocale()).toBe('es');

    vi.stubGlobal('navigator', undefined);
    expect(resolveSystemLocale()).toBe('es');
  });

  it('reads language and theme preferences only from their supported values', () => {
    expect(getStoredLanguagePreference()).toBe('system');
    expect(getStoredThemePreference()).toBe('system');
    for (const value of ['system', 'es', 'en'] as const) {
      localStorage.setItem(LANGUAGE_STORAGE_KEY, value);
      expect(getStoredLanguagePreference()).toBe(value);
    }
    localStorage.setItem(LANGUAGE_STORAGE_KEY, 'fr');
    expect(getStoredLanguagePreference()).toBe('system');

    for (const value of ['system', 'light', 'dark'] as const) {
      localStorage.setItem(THEME_STORAGE_KEY, value);
      expect(getStoredThemePreference()).toBe(value);
    }
    localStorage.setItem(THEME_STORAGE_KEY, 'sepia');
    expect(getStoredThemePreference()).toBe('system');
  });

  it('normalizes stored runtime provider, model, and effort selections', () => {
    const codexModel = CODEX_MODEL_OPTIONS[0].realModelName;
    const codexEffort = CODEX_MODEL_OPTIONS[0].supportedReasoningEfforts?.[0] ?? CODEX_MODEL_OPTIONS[0].defaultReasoningEffort;
    localStorage.setItem(CODEX_MODEL_STORAGE_KEY, codexModel);
    localStorage.setItem(CODEX_REASONING_STORAGE_KEY, codexEffort);
    expect(getStoredCodexModel()).toBe(codexModel);
    expect(getStoredCodexReasoningEffort()).toBe(codexEffort);
    localStorage.setItem(CODEX_MODEL_STORAGE_KEY, 'invalid');
    localStorage.setItem(CODEX_REASONING_STORAGE_KEY, 'invalid');
    expect(getStoredCodexModel()).toBe(CODEX_MODEL_OPTIONS[0].realModelName);
    expect(CODEX_REASONING_OPTIONS.map((option) => option.value)).toContain(getStoredCodexReasoningEffort());

    for (const provider of ['codex', 'claude', 'antigravity', 'auto'] as const) {
      localStorage.setItem(CHAT_AGENT_PROVIDER_STORAGE_KEY, provider);
      expect(getStoredChatAgentProvider()).toBe(provider);
    }
    localStorage.setItem(CHAT_AGENT_PROVIDER_STORAGE_KEY, 'unknown');
    expect(getStoredChatAgentProvider()).toBe('auto');

    const claudeModel = CLAUDE_MODEL_OPTIONS[0].realModelName;
    const claudeEffort = CLAUDE_EFFORT_OPTIONS[0].value;
    localStorage.setItem(CLAUDE_MODEL_STORAGE_KEY, claudeModel);
    localStorage.setItem(CLAUDE_EFFORT_STORAGE_KEY, claudeEffort);
    expect(getStoredClaudeModel()).toBe(claudeModel);
    expect(getStoredClaudeEffort()).toBe(claudeEffort);
    localStorage.setItem(CLAUDE_MODEL_STORAGE_KEY, 'invalid');
    localStorage.setItem(CLAUDE_EFFORT_STORAGE_KEY, 'invalid');
    expect(getStoredClaudeModel()).toBe(CLAUDE_MODEL_OPTIONS[0].realModelName);
    expect(CLAUDE_EFFORT_OPTIONS.map((option) => option.value)).toContain(getStoredClaudeEffort());

    const antigravityModel = ANTIGRAVITY_MODEL_OPTIONS[0].realModelName;
    const antigravityEffort = ANTIGRAVITY_EFFORT_OPTIONS[0].value;
    localStorage.setItem(ANTIGRAVITY_MODEL_STORAGE_KEY, antigravityModel);
    localStorage.setItem(ANTIGRAVITY_EFFORT_STORAGE_KEY, antigravityEffort);
    expect(getStoredAntigravityModel()).toBe(antigravityModel);
    expect(getStoredAntigravityEffort()).toBe(antigravityEffort);
    localStorage.setItem(ANTIGRAVITY_MODEL_STORAGE_KEY, 'invalid');
    localStorage.setItem(ANTIGRAVITY_EFFORT_STORAGE_KEY, 'invalid');
    expect(getStoredAntigravityModel()).toBe(ANTIGRAVITY_MODEL_OPTIONS[0].realModelName);
    expect(ANTIGRAVITY_EFFORT_OPTIONS.map((option) => option.value)).toContain(getStoredAntigravityEffort());
  });

  it('uses runtime defaults when browser storage is unavailable', () => {
    vi.stubGlobal('window', undefined);
    expect(getStoredLanguagePreference()).toBe('system');
    expect(getStoredThemePreference()).toBe('system');
    expect(getStoredCodexModel()).toBe(CODEX_MODEL_OPTIONS[0].realModelName);
    expect(CODEX_REASONING_OPTIONS.map((option) => option.value)).toContain(getStoredCodexReasoningEffort());
    expect(getStoredChatAgentProvider()).toBe('auto');
    expect(getStoredClaudeModel()).toBe(CLAUDE_MODEL_OPTIONS[0].realModelName);
    expect(CLAUDE_EFFORT_OPTIONS.map((option) => option.value)).toContain(getStoredClaudeEffort());
    expect(getStoredAntigravityModel()).toBe(ANTIGRAVITY_MODEL_OPTIONS[0].realModelName);
    expect(ANTIGRAVITY_EFFORT_OPTIONS.map((option) => option.value)).toContain(getStoredAntigravityEffort());
    expect(getStoredChatBotPicture()).toBe('bot');
  });

  it('preserves valid bot pictures and chooses a bounded fallback for invalid storage', () => {
    for (const option of CHAT_BOT_PICTURE_OPTIONS) {
      localStorage.setItem(CHAT_BOT_PICTURE_STORAGE_KEY, option.value);
      expect(getStoredChatBotPicture()).toBe(option.value);
    }
    localStorage.setItem(CHAT_BOT_PICTURE_STORAGE_KEY, 'invalid');
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    expect(getStoredChatBotPicture()).toBe('female');
    vi.mocked(Math.random).mockReturnValue(1);
    expect(getStoredChatBotPicture()).toBe('bot');
  });
});

describe('persisted renderer chat state', () => {
  it('returns an empty normalized state when storage is absent or malformed', () => {
    expect(readPersistedChatState()).toEqual(emptyState);
    localStorage.setItem(CHAT_STORAGE_KEY, '{broken');
    expect(readPersistedChatState()).toEqual(emptyState);

    localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify({
      conversations: 'invalid',
      activeConversationByApp: 'invalid',
      lastActiveConversationId: 42,
      activeRuns: 'invalid',
      draftInputByConversationId: 'invalid',
    }));
    expect(readPersistedChatState()).toEqual(emptyState);

    vi.stubGlobal('window', undefined);
    expect(readPersistedChatState()).toEqual(emptyState);
  });

  it('migrates legacy conversations, runtime metadata, active runs, and drafts', () => {
    const withRuntime = chatConversation('runtime', {
      mode: 'create_app',
      runtime: { provider: 'claude', model: 'claude-model', effort: 'high' },
    });
    const untouchedEmpty = chatConversation('empty', { appId: 'forger' });
    const editLegacy = chatConversation('edit', { threadId: 'thread-1' });
    const socialLegacy = chatConversation('social', {
      appId: 'social-app',
      mode: 'social_app_review',
      targetAppId: null,
      messages: [chatMessage('message-1')],
    });
    const freeLegacy = chatConversation('free', {
      appId: 'forger',
      mode: 'not-valid' as ChatConversation['mode'],
      messages: [chatMessage('message-2')],
    });
    localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify({
      conversations: [withRuntime, untouchedEmpty, editLegacy, socialLegacy, freeLegacy],
      activeConversationByApp: { 'app-1': 'edit' },
      lastActiveConversationId: 'edit',
      activeRuns: [
        { runId: ' run-1 ', conversationId: ' edit ', appId: ' app-1 ' },
        { runId: 'duplicate', conversationId: 'edit', appId: 'app-1' },
      ],
      activeRun: { runId: 'legacy', conversationId: 'legacy-conversation', appId: 'legacy-app' },
      draftInputByConversationId: { edit: 'draft', invalid: 1 },
    }));

    const state = readPersistedChatState();
    expect(state.activeConversationByApp).toEqual({ 'app-1': 'edit' });
    expect(state.lastActiveConversationId).toBe('edit');
    expect(state.activeRuns).toEqual([{ runId: 'run-1', conversationId: 'edit', appId: 'app-1' }]);
    expect(state.draftInputByConversationId).toEqual({ edit: 'draft' });
    expect(state.conversations.find((item) => item.id === 'runtime')).toMatchObject({
      mode: 'create_app', targetAppId: null, runtime: withRuntime.runtime,
    });
    const emptyConversation = state.conversations.find((item) => item.id === 'empty');
    expect(emptyConversation).toMatchObject({ mode: 'free_chat', targetAppId: null });
    expect(emptyConversation).not.toHaveProperty('runtime');
    expect(state.conversations.find((item) => item.id === 'edit')).toMatchObject({
      mode: 'edit_app', targetAppId: 'app-1', runtime: { provider: 'codex', model: 'gpt-5.2', effort: 'medium' },
    });
    expect(state.conversations.find((item) => item.id === 'social')).toMatchObject({
      mode: 'social_app_review', targetAppId: 'social-app', runtime: { provider: 'codex' },
    });
    expect(state.conversations.find((item) => item.id === 'free')).toMatchObject({
      mode: 'free_chat', targetAppId: null, runtime: { provider: 'codex' },
    });

    localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify({ activeRun: {
      runId: 'legacy', conversationId: 'legacy-conversation', appId: 'legacy-app',
    } }));
    expect(readPersistedChatState().activeRuns).toEqual([{
      runId: 'legacy', conversationId: 'legacy-conversation', appId: 'legacy-app',
    }]);
  });

  it('generates conversation ids through crypto with a timestamp fallback', () => {
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue('00000000-0000-4000-8000-000000000001');
    expect(makeConversationId()).toBe('00000000-0000-4000-8000-000000000001');
    vi.stubGlobal('crypto', undefined);
    vi.spyOn(Date, 'now').mockReturnValue(1234);
    expect(makeConversationId()).toBe('conv-1234');
  });

  it('appends messages once while preserving unrelated conversations and valid threads', () => {
    const original = chatConversation('conversation-1', { threadId: 'old-thread' });
    const message = chatMessage('message-1');
    const appended = appendChatMessageOnce(original, message, '2026-08-10T01:00:00.000Z');
    expect(appended).toMatchObject({
      updatedAt: '2026-08-10T01:00:00.000Z',
      messages: [message],
    });
    expect(appendChatMessageOnce(appended, message)).toBe(appended);

    const unrelated = chatConversation('conversation-2');
    const updated = appendChatMessageToConversationOnce(
      [original, unrelated],
      'conversation-1',
      message,
      { threadId: 'new-thread', updatedAt: '2026-08-10T02:00:00.000Z' },
    );
    expect(updated[0]).toMatchObject({ threadId: 'new-thread', messages: [message] });
    expect(updated[1]).toBe(unrelated);

    const duplicateWithoutThread = appendChatMessageToConversationOnce(updated, 'conversation-1', message);
    expect(duplicateWithoutThread[0]).toBe(updated[0]);
    const duplicateBlankThread = appendChatMessageToConversationOnce(updated, 'conversation-1', message, { threadId: '   ' });
    expect(duplicateBlankThread[0]).toMatchObject({ threadId: 'new-thread' });
    expect(duplicateBlankThread[0]).not.toBe(updated[0]);
  });

  it('summarizes blank, compact, and long prompts', () => {
    expect(summarizeConversationTitle(' \n ', 'Fallback')).toBe('Fallback');
    expect(summarizeConversationTitle('  concise   prompt  ')).toBe('concise prompt');
    const long = 'x'.repeat(57);
    expect(summarizeConversationTitle(long)).toBe(`${'x'.repeat(56)}...`);
  });
});

describe('renderer diagnostics and theme', () => {
  it('builds a normalized error report with current environment metadata', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-10T12:00:00.000Z'));
    vi.spyOn(window.navigator, 'platform', 'get').mockReturnValue('MacIntel');
    expect(buildErrorReport({ source: 'renderer', message: 'Failure' }, '0.5.16')).toMatchObject({
      source: 'renderer',
      message: 'Failure',
      desktopVersion: '0.5.16',
      platform: 'MacIntel',
      occurredAt: '2026-08-10T12:00:00.000Z',
    });
    expect(buildErrorReport({ source: 'renderer', message: 'Failure' }, '').desktopVersion).toBeUndefined();
  });

  it.each([
    'permission_denied',
    'app_not_installed',
    'missing_secrets',
    'no_pending_update_conflict',
    'codex_auth_missing',
    'auth_missing',
    'backend_client_missing',
    'forger_cloud_auth_expired',
  ])('does not prompt for the expected technical code %s', (technicalCode) => {
    expect(shouldPromptForErrorReport(technicalCode)).toBe(false);
  });

  it('prompts for unexpected failures and filters only known browser noise', () => {
    expect(shouldPromptForErrorReport()).toBe(true);
    expect(shouldPromptForErrorReport('unexpected')).toBe(true);
    expect(isIgnoredBrowserNoise()).toBe(false);
    expect(isIgnoredBrowserNoise('ordinary warning')).toBe(false);
    expect(isIgnoredBrowserNoise('ResizeObserver loop completed with undelivered notifications.')).toBe(true);
    expect(isIgnoredBrowserNoise('ResizeObserver loop limit exceeded')).toBe(true);
  });

  it('resolves and builds complete light and dark themes', () => {
    expect(resolveThemeMode('system', true)).toBe('dark');
    expect(resolveThemeMode('system', false)).toBe('light');
    expect(resolveThemeMode('dark', false)).toBe('dark');
    expect(resolveThemeMode('light', true)).toBe('light');

    const light = buildAppTheme('light');
    const dark = buildAppTheme('dark');
    expect(light.palette.mode).toBe('light');
    expect(dark.palette.mode).toBe('dark');
    expect(light.palette.background.default).not.toBe(dark.palette.background.default);
    expect(light.components?.MuiCssBaseline?.styleOverrides).toBeDefined();
    expect(dark.components?.MuiCard?.styleOverrides).toBeDefined();
    expect(light.typography.button.textTransform).toBe('none');
  });
});
