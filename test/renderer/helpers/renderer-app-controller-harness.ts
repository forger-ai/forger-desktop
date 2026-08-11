import { act, renderHook, waitFor } from '@testing-library/react';
import { expect, vi } from 'vitest';
import { useRendererAppController } from '@renderer/app/RendererAppController';
import type { Settings } from '@shared/types';

const controllerAnalyticsState = vi.hoisted(() => ({
  submitForgerInstalledEvent: vi.fn(),
  submitUsageEvent: vi.fn(),
  setUsageAnalyticsPreference: vi.fn(),
  usageAnalytics: new Proxy({}, { get: (target, property) => {
    const record = target as Record<PropertyKey, ReturnType<typeof vi.fn>>;
    record[property] ??= vi.fn();
    return record[property];
  } }),
}));

const controllerChatPersistenceState = vi.hoisted(() => ({
  state: {
    conversations: [] as Array<Record<string, unknown>>,
    activeConversationByApp: {} as Record<string, string>,
    lastActiveConversationId: null as string | null,
    activeRuns: [] as Array<{ runId: string; conversationId: string; appId: string }>,
    draftInputByConversationId: {} as Record<string, string>,
  },
}));

export const controllerAnalytics = controllerAnalyticsState;
export const controllerChatPersistence = controllerChatPersistenceState;

vi.mock('@renderer/usage-analytics', () => ({
  getUsageAnalyticsEnabled: () => true,
  setUsageAnalyticsPreference: controllerAnalyticsState.setUsageAnalyticsPreference,
  submitForgerInstalledEvent: controllerAnalyticsState.submitForgerInstalledEvent,
  submitUsageEvent: controllerAnalyticsState.submitUsageEvent,
  usageAnalytics: controllerAnalyticsState.usageAnalytics,
}));

vi.mock('@renderer/preferences', async (importOriginal) => ({
  ...await importOriginal<typeof import('@renderer/preferences')>(),
  getStoredAntigravityEffort: () => 'medium',
  getStoredAntigravityModel: () => 'gemini-2.5-pro',
  getStoredChatAgentProvider: () => 'auto',
  getStoredChatBotPicture: () => 'forger',
  getStoredClaudeEffort: () => 'medium',
  getStoredClaudeModel: () => 'claude-sonnet-4-5',
  getStoredCodexModel: () => 'gpt-5.2-codex',
  getStoredCodexReasoningEffort: () => 'medium',
  getStoredLanguagePreference: () => 'en',
  getStoredThemePreference: () => 'system',
  resolveSystemLocale: () => 'en',
}));

vi.mock('@renderer/chat-state', async (importOriginal) => ({
  ...await importOriginal<typeof import('@renderer/chat-state')>(),
  readPersistedChatState: () => controllerChatPersistenceState.state,
}));

export const controllerSettingsFixture = (): Settings => ({
  userEmail: '', plan: 'Free', safeMode: false,
  earlyAccess: { workflowsEnabled: true },
  developerMode: { enabled: false, pathEntries: [] },
  codexDefaults: { model: 'gpt-5.2-codex', reasoningEffort: 'medium' },
  defaultAgentProvider: 'auto', defaultChatPermissionMode: 'safe', defaultChatNetworkAccess: true,
  providerInactivityTimeoutMinutes: { codex: 30, claude: 30, antigravity: 30 },
  agentDefaults: {
    codex: { model: 'gpt-5.2-codex', reasoningEffort: 'medium' },
    claude: { model: 'claude-sonnet-4-5', effort: 'medium' },
    antigravity: { model: 'gemini-2.5-pro', effort: 'medium' },
  },
  llmProviderDefaults: {
    codex: { model: 'gpt-5.2-codex', reasoningEffort: 'medium' },
    claude: { model: 'claude-sonnet-4-5', effort: 'medium' },
    antigravity: { model: 'gemini-2.5-pro', effort: 'medium' },
  },
  providerConnections: {}, llmProviderProfiles: {}, activeProviderProfiles: {},
});

type DesktopApi = NonNullable<typeof window.forger>;
type Listener = (...args: never[]) => void;

const defaultValues = () => ({
  listCatalogApps: [], listInstalledApps: [], getSettings: controllerSettingsFixture(),
  getForgerAccount: { authenticated: false },
  getCodexAuthStatus: { installed: true, authenticated: false, authFilePath: '', codexHome: '' },
  getClaudeAuthStatus: { installed: true, authenticated: false, source: 'missing' },
  getAntigravityAuthStatus: { installed: true, authenticated: false, source: 'missing' },
  getDesktopUpdateState: { status: 'idle', currentVersion: '1.0.0' },
  listAgentTools: [], getAgentToolSettings: { approvals: {} }, listOfficialTools: { tools: [] },
  filesList: [], filesListCategories: [], automationsList: [], backgroundTasksList: [],
  listBackups: [],
  listRemoteBackups: { backups: [], usage: { usedBytes: 0, limitBytes: 0, backupCount: 0, backupCountLimit: 0 } },
  getCloudSyncSettings: { appSync: {} }, getCloudStorageUsage: null, getCloudIdentity: null,
  memoryList: [], checkDesktopUpdates: { status: 'idle', currentVersion: '1.0.0' },
  getForumParticipation: { status: 'opted_out', isModerator: false },
  getAppDetails: { app: { id: 'planner', name: 'Planner', description: '', category: 'productivity', status: 'installed' }, installed: true, status: 'installed', operations: [] },
  getAppToolsInstallGate: null, getAppSecrets: { appId: 'planner', requirements: [], connections: [], userSecrets: [] },
  listUserSecrets: [], backgroundTasksUpsert: undefined, traceChatEvent: undefined,
  prepareDesktopErrorReport: undefined,
  prepareConversationDiagnosticReport: { source: 'desktop_chat', occurredAt: '2026-08-10' },
});

export const installControllerBridge = (overrides: Record<string, unknown> = {}) => {
  const values: Record<string, unknown> = { ...defaultValues(), ...overrides };
  const calls: Record<string, ReturnType<typeof vi.fn>> = {};
  const listeners: Record<string, Listener[]> = {};
  const unsubscribers: Record<string, Array<ReturnType<typeof vi.fn>>> = {};
  const api = new Proxy({}, {
    get: (_target, property) => {
      const name = String(property);
      if (calls[name]) return calls[name];
      if (name.startsWith('on')) {
        calls[name] = vi.fn((listener: Listener) => {
          (listeners[name] ??= []).push(listener);
          const unsubscribe = vi.fn(() => {
            listeners[name] = (listeners[name] ?? []).filter((entry) => entry !== listener);
          });
          (unsubscribers[name] ??= []).push(unsubscribe);
          return unsubscribe;
        });
        return calls[name];
      }
      calls[name] = vi.fn((...args: unknown[]) => {
        const value = values[name];
        if (typeof value === 'function') return value(...args);
        return Promise.resolve(value);
      });
      return calls[name];
    },
  }) as DesktopApi;
  Object.defineProperty(window, 'forger', { configurable: true, value: api });
  return {
    api, calls, values, listeners, unsubscribers,
    set: (name: string, value: unknown) => { values[name] = value; },
    emit: (name: string, payload: unknown) => {
      for (const listener of [...(listeners[name] ?? [])]) listener(payload as never);
    },
    call: (name: string) => api[name as keyof DesktopApi] as ReturnType<typeof vi.fn>,
  };
};

export const renderControllerHarness = async (bridge = installControllerBridge()) => {
  const hook = renderHook(() => useRendererAppController());
  await waitFor(() => expect(bridge.call('getSettings')).toHaveBeenCalled());
  await act(async () => { await Promise.resolve(); });
  return { bridge, ...hook };
};

export const resetControllerHarness = () => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  window.history.replaceState({}, '', '/');
  Object.defineProperty(window, 'confirm', { configurable: true, value: vi.fn(() => true) });
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn().mockResolvedValue(undefined) } });
  vi.clearAllMocks();
  controllerChatPersistence.state = {
    conversations: [], activeConversationByApp: {}, lastActiveConversationId: null, activeRuns: [], draftInputByConversationId: {},
  };
};
