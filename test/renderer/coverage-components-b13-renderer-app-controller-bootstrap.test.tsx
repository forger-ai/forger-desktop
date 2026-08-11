import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useRendererAppController } from '@renderer/app/RendererAppController';
import type { Settings } from '@shared/types';

const analytics = vi.hoisted(() => ({
  submitForgerInstalledEvent: vi.fn(),
  submitUsageEvent: vi.fn(),
  setUsageAnalyticsPreference: vi.fn(),
  usageAnalytics: new Proxy({}, { get: (target, property) => {
    const record = target as Record<PropertyKey, ReturnType<typeof vi.fn>>;
    record[property] ??= vi.fn();
    return record[property];
  } }),
}));

const chatPersistence = vi.hoisted(() => ({
  state: {
    conversations: [] as Array<Record<string, unknown>>,
    activeConversationByApp: {} as Record<string, string>,
    lastActiveConversationId: null as string | null,
    activeRuns: [] as Array<{ runId: string; conversationId: string; appId: string }>,
    draftInputByConversationId: {} as Record<string, string>,
  },
}));

vi.mock('@renderer/usage-analytics', () => ({
  getUsageAnalyticsEnabled: () => true,
  setUsageAnalyticsPreference: analytics.setUsageAnalyticsPreference,
  submitForgerInstalledEvent: analytics.submitForgerInstalledEvent,
  submitUsageEvent: analytics.submitUsageEvent,
  usageAnalytics: analytics.usageAnalytics,
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
  readPersistedChatState: () => chatPersistence.state,
}));

type DesktopApi = NonNullable<typeof window.forger>;
type Listener = (...args: never[]) => void;

const settingsFixture = (): Settings => ({
  userEmail: '',
  plan: 'Free',
  safeMode: false,
  earlyAccess: { workflowsEnabled: true },
  developerMode: { enabled: false, pathEntries: [] },
  codexDefaults: { model: 'gpt-5.2-codex', reasoningEffort: 'medium' },
  defaultAgentProvider: 'auto',
  defaultChatPermissionMode: 'safe',
  defaultChatNetworkAccess: true,
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
  providerConnections: {},
  llmProviderProfiles: {},
  activeProviderProfiles: {},
});

const baseValues = () => ({
  listCatalogApps: [],
  listInstalledApps: [],
  getSettings: settingsFixture(),
  getForgerAccount: { authenticated: false },
  getCodexAuthStatus: { installed: true, authenticated: false, authFilePath: '', codexHome: '' },
  getClaudeAuthStatus: { installed: true, authenticated: false, source: 'missing' },
  getAntigravityAuthStatus: { installed: true, authenticated: false, source: 'missing' },
  getDesktopUpdateState: { status: 'idle', currentVersion: '1.0.0' },
  listAgentTools: [],
  getAgentToolSettings: { approvals: {} },
  listOfficialTools: { tools: [] },
  filesList: [],
  filesListCategories: [],
  automationsList: [],
  backgroundTasksList: [],
  listBackups: [],
  listRemoteBackups: { backups: [], usage: { usedBytes: 0, limitBytes: 0, backupCount: 0, backupCountLimit: 0 } },
  getCloudSyncSettings: { appSync: {} },
  getCloudStorageUsage: null,
  getCloudIdentity: null,
  memoryList: [],
  checkDesktopUpdates: { status: 'idle', currentVersion: '1.0.0' },
  getForumParticipation: { status: 'opted_out', isModerator: false },
  getAppDetails: { app: { id: 'planner', name: 'Planner', description: 'Plan', category: 'productivity', status: 'installed' }, installed: true, status: 'installed', operations: [] },
  getAppToolsInstallGate: null,
  getAppSecrets: { appId: 'planner', requirements: [], connections: [], userSecrets: [] },
  listUserSecrets: [],
  installApp: { success: true, phase: 'completed', userMessage: 'Installed' },
  installWelcome: { success: true, message: 'Welcome to Planner' },
  updateApp: { success: true, phase: 'completed', userMessage: 'Updated' },
  restoreAppUserVersion: { success: true, userMessage: 'Restored' },
  resolveAppUpdateConflict: { success: true, userMessage: 'Ready' },
  uninstallApp: { success: true, userMessage: 'Deleted' },
  openApp: { success: true, userMessage: 'Opened' },
  stopApp: { success: true, userMessage: 'Stopped' },
  startLocalNetworkShare: { success: true, userMessage: 'Shared', status: { active: true, appId: 'planner', frontendUrl: 'http://local', connectedAt: null } },
  stopLocalNetworkShare: { success: true, userMessage: 'Stopped share', status: null },
  startRemoteNetworkShare: { success: true, userMessage: 'Remote ready', status: { active: true, appId: 'planner', state: 'waiting_for_session', sessionId: 'session-1' } },
  stopRemoteNetworkShare: { success: true, userMessage: 'Remote stopped' },
  createLocalApp: { success: true, userMessage: 'Created', app: { appId: 'created', name: 'Created', description: 'Description', purpose: 'Purpose' } },
  uploadSocialApp: { success: true, userMessage: 'Uploaded', share: { deepLink: 'forger://social/app' } },
  renameInstalledApp: { success: true, userMessage: 'Renamed', cloudSynced: true },
  filesPickForChat: [],
  filesStageForChat: { grantId: 'staged', name: 'paste.png', sizeBytes: 10, modifiedAt: '2026-08-10', type: 'image/png', staged: true },
  filesReleaseSelections: undefined,
  filesImport: [],
  filesCreateCategory: { path: 'notes', name: 'Notes', parentPath: '' },
  filesRenameCategory: { success: true, userMessage: 'Category renamed' },
  filesDeleteCategory: { success: true, userMessage: 'Category deleted' },
  filesRename: { success: true, userMessage: 'File renamed' },
  filesMove: { success: true, userMessage: 'File moved' },
  filesDelete: { success: true, userMessage: 'File deleted' },
  createBackup: { success: true, userMessage: 'Backup created' },
  deleteBackup: { success: true, userMessage: 'Backup deleted' },
  deleteBackups: { success: true, userMessage: 'Backups deleted', deleted: ['backup-1'], failed: [] },
  restoreBackup: { success: true, userMessage: 'Backup restored' },
  createRemoteBackup: { success: true, userMessage: 'Cloud backup created' },
  deleteRemoteBackup: { success: true, userMessage: 'Remote deleted' },
  restoreRemoteBackup: { success: true, userMessage: 'Remote restored' },
  setAppAutoSync: { appSync: { planner: { enabled: true } } },
  automationsListRuns: [],
  automationsGetRunTranscript: null,
  automationsCreate: { id: 'automation-1', name: 'Daily', enabled: true, selectedAppIds: [], createdAt: '2026-08-10', updatedAt: '2026-08-10' },
  automationsUpdate: { id: 'automation-1', name: 'Daily', enabled: false, selectedAppIds: [], createdAt: '2026-08-10', updatedAt: '2026-08-10' },
  automationsDelete: { success: true, userMessage: 'Automation deleted' },
  automationsPause: { success: true },
  automationsResume: { success: true },
  automationsRunNow: { id: 'run-1', automationId: 'automation-1', status: 'queued', startedAt: '2026-08-10', updatedAt: '2026-08-10' },
  backgroundTasksUpsert: undefined,
  memoryCreate: { id: 'memory-created', content: 'Created', scope: 'global', createdAt: '2026-08-10', updatedAt: '2026-08-10' },
  memoryUpdate: { id: 'memory-created', content: 'Updated', scope: 'global', createdAt: '2026-08-10', updatedAt: '2026-08-11' },
  memoryDelete: undefined,
  updateAgentToolApproval: { approvals: {} },
  setAppToolGrant: null,
  setAppConnectionGrant: null,
  openExternalUrl: undefined,
  chatStartRun: { runId: 'run-1', status: 'queued' },
  chatCancelRun: { success: true },
  chatApprovePermission: { success: true },
  chatGetRun: null,
  traceChatEvent: undefined,
  connectCodexAuth: { success: true, userMessage: 'Codex started' },
  disconnectCodexAuth: { success: true, userMessage: 'Codex disconnected' },
  reinstallCodex: { success: true, userMessage: 'Codex reinstalled', status: { installed: true, authenticated: true, authFilePath: '/tmp/auth', codexHome: '/tmp/codex' } },
  connectClaudeAuth: { success: true, userMessage: 'Claude started', status: { installed: true, authenticated: true, source: 'credentials' } },
  confirmClaudeAuthConnection: { success: true, userMessage: 'Claude connected', status: { installed: true, authenticated: true, source: 'credentials' } },
  signOutClaudeAuth: { success: true, userMessage: 'Claude disconnected', status: { installed: true, authenticated: false, source: 'missing' } },
  reinstallClaude: { success: true, userMessage: 'Claude reinstalled', status: { installed: true, authenticated: true, source: 'credentials' } },
  connectAntigravityAuth: { success: true, userMessage: 'Google started', status: { installed: true, authenticated: true, source: 'credentials' } },
  disconnectAntigravityAuth: { success: true, userMessage: 'Google disconnected', status: { installed: true, authenticated: false, source: 'missing' } },
  reinstallAntigravity: { success: true, userMessage: 'Google reinstalled', status: { installed: true, authenticated: true, source: 'credentials' } },
  cancelAntigravityAuthSession: undefined,
  desktopLog: undefined,
  loginForgerAccount: { success: true, authenticated: true, user: { id: 1, email: 'user@example.com', username: 'user', confirmed: true } },
  loginForgerAccountWithGoogle: { success: true, authenticated: true, user: { id: 1, email: 'google@example.com', username: 'google', confirmed: true } },
  loginForgerAccountWithApple: { success: true, authenticated: true, user: { id: 1, email: 'apple@example.com', username: 'apple', confirmed: true } },
  registerForgerAccount: { success: true, authenticated: false, userMessage: 'Confirm your account' },
  updateForgerAccountProfile: { success: true, authenticated: true, user: { id: 1, email: 'user@example.com', username: 'renamed', confirmed: true } },
  logoutForgerAccount: { success: true, authenticated: false },
  updateForumParticipation: { status: 'opted_in', isModerator: false, firstPromptShownAt: '2026-08-10' },
  updateWorkflowsEarlyAccess: settingsFixture(),
  updateAgentDefaults: settingsFixture(),
  setActiveLlmProviderProfile: { success: true, userMessage: 'Profile selected' },
  updateLlmProviderProfileDefaults: { success: true, userMessage: 'Defaults updated' },
  updateDeveloperMode: settingsFixture(),
  createUserSecret: { success: true, userMessage: 'Secret created' },
  updateUserSecret: { success: true, userMessage: 'Secret updated' },
  deleteUserSecret: { success: true, userMessage: 'Secret deleted' },
  connectAppSecret: { success: true, userMessage: 'Secret connected' },
  disconnectAppSecret: { success: true, userMessage: 'Secret disconnected' },
  submitAppRating: { success: true, userMessage: 'Rating sent' },
  submitProductFeedback: { success: true, userMessage: 'Feedback sent' },
  updateAppPrompt: { success: true, userMessage: 'Prompt updated' },
  restoreAppPrompt: { success: true, userMessage: 'Prompt restored' },
  prepareDesktopErrorReport: undefined,
  submitDesktopErrorReport: { success: true, userMessage: 'Report sent' },
  prepareConversationDiagnosticReport: { source: 'desktop_chat', occurredAt: '2026-08-10', diagnosticAttachmentToken: 'secret-token' },
  submitConversationDiagnosticReport: { success: true, userMessage: 'Diagnostic sent' },
});

const installBridge = (overrides: Record<string, unknown> = {}) => {
  const values: Record<string, unknown> = { ...baseValues(), ...overrides };
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
    api,
    calls,
    values,
    listeners,
    unsubscribers,
    set: (name: string, value: unknown) => { values[name] = value; },
    emit: (name: string, payload: unknown) => {
      for (const listener of [...(listeners[name] ?? [])]) listener(payload as never);
    },
    call: (name: string) => api[name as keyof DesktopApi] as ReturnType<typeof vi.fn>,
  };
};

const renderController = async (bridge = installBridge()) => {
  const hook = renderHook(() => useRendererAppController());
  await waitFor(() => expect(bridge.call('getSettings')).toHaveBeenCalled());
  await act(async () => { await Promise.resolve(); });
  return { bridge, ...hook };
};

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  window.history.replaceState({}, '', '/');
  Object.defineProperty(window, 'confirm', { configurable: true, value: vi.fn(() => true) });
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn().mockResolvedValue(undefined) } });
  vi.clearAllMocks();
  chatPersistence.state = {
    conversations: [], activeConversationByApp: {}, lastActiveConversationId: null, activeRuns: [], draftInputByConversationId: {},
  };
});

describe('RendererAppController bootstrap, routing, and cleanup', () => {
  it('hydrates every startup surface, exposes the chosen locale/theme, and records startup analytics', async () => {
    const app = { id: 'planner', name: 'Planner', category: 'productivity', status: 'installed', privateLocal: true };
    const social = { id: 'social', name: 'Social', category: 'productivity', status: 'installed', socialSource: { ownerUsername: 'ana', slug: 'social' } };
    const bridge = installBridge({
      listInstalledApps: [app, social],
      listCatalogApps: [{ id: 'planner', name: 'Planner catalog', category: 'productivity' }],
      memoryList: [{ id: 'memory-1', content: 'Prefers concise answers', scope: 'global', createdAt: '2026-08-10', updatedAt: '2026-08-10' }],
      listOfficialTools: { tools: [{ id: 'gmail', name: 'Gmail', configured: true }] },
    });
    const { result } = await renderController(bridge);
    expect(result.current.installedApps).toEqual([app, social]);
    expect(result.current.catalogApps).toHaveLength(1);
    expect(result.current.memories).toHaveLength(1);
    expect(result.current.officialTools).toHaveLength(1);
    expect(result.current.activeLocale).toBe('en');
    expect(result.current.theme.palette.mode).toBeDefined();
    expect(analytics.submitForgerInstalledEvent).toHaveBeenCalled();
    expect(analytics.usageAnalytics.localAppCreated).toHaveBeenCalled();
    expect(analytics.usageAnalytics.catalogAppDownloaded).toHaveBeenCalled();
    expect(analytics.usageAnalytics.officialToolConnected).toHaveBeenCalled();
  });

  it('routes public navigation actions and keeps workflow, connection, task, data, and pinned state consistent', async () => {
    const bridge = installBridge({
      listInstalledApps: [{ id: 'planner', name: 'Planner', category: 'productivity', status: 'installed' }],
    });
    const { result } = await renderController(bridge);
    act(() => result.current.openWorkflowDetail('workflow-1'));
    expect(result.current.currentView).toBe('workflowDetail');
    expect(result.current.selectedWorkflowId).toBe('workflow-1');
    act(() => result.current.openWorkflowEditor(null));
    expect(result.current.currentView).toBe('workflowEditor');
    act(() => result.current.backToWorkflowList());
    expect(result.current.currentView).toBe('workflows');
    act(() => result.current.openConnectionDetail('gmail'));
    expect(result.current.currentView).toBe('connectionDetail');
    act(() => result.current.backToConnectionsList());
    expect(result.current.currentView).toBe('connections');
    act(() => result.current.openBackgroundTaskDetail('task-1'));
    expect(result.current.currentView).toBe('backgroundTaskDetail');
    act(() => result.current.backFromBackgroundTaskDetail());
    expect(result.current.currentView).toBe('backgroundTasks');
    act(() => result.current.backFromBackgroundTaskHistory());
    expect(result.current.currentView).toBe('catalog');
    act(() => result.current.togglePinnedView('files'));
    expect(result.current.pinnedViews).toContain('files');
    act(() => result.current.togglePinnedView('files'));
    expect(result.current.pinnedViews).not.toContain('files');
    act(() => result.current.setCurrentView('datos'));
    await waitFor(() => expect(result.current.selectedDataAppId).toBe('planner'));
  });

  it('handles deep links for known, development, unknown, and social profile chat targets', async () => {
    const bridge = installBridge({
      listInstalledApps: [
        { id: 'planner', name: 'Planner', category: 'productivity', status: 'installed' },
        { id: 'writer-dev', name: 'Writer Dev', category: 'productivity', status: 'installed' },
      ],
    });
    const { result } = await renderController(bridge);
    await waitFor(() => expect(bridge.listeners.onDeepLink).toHaveLength(1));
    act(() => bridge.emit('onDeepLink', { kind: 'chat', app: 'planner', prompt: 'Plan today' }));
    expect(result.current.selectedAppId).toBe('planner');
    expect(result.current.chatInput).toBe('Plan today');
    act(() => bridge.emit('onDeepLink', { kind: 'chat', app: 'writer', prompt: 'Draft' }));
    expect(result.current.selectedAppId).toBe('writer-dev');
    act(() => bridge.emit('onDeepLink', { kind: 'chat', app: 'missing', prompt: 'Fallback' }));
    expect(result.current.selectedAppId).toBeNull();
    expect(result.current.currentView).toBe('chat');
    act(() => bridge.emit('onDeepLink', { kind: 'social-profile', username: '@alice' }));
    expect(result.current.socialProfileUsername).toBe('alice');
    expect(result.current.currentView).toBe('friends');
    act(() => bridge.emit('onDeepLink', { kind: 'social-profile', username: '   ' }));
    expect(result.current.bannerSeverity).toBe('error');
    act(() => bridge.emit('onDeepLink', { kind: 'other' }));
  });

  it('captures bridge events, updates public state, and releases every listener on unmount', async () => {
    const bridge = installBridge();
    const { result, unmount } = await renderController(bridge);
    await waitFor(() => expect(bridge.listeners.onInstallProgress).toHaveLength(1));
    act(() => bridge.emit('onInstallProgress', { appId: 'planner', progress: { success: true, phase: 'downloading', userMessage: 'Downloading' } }));
    expect(result.current.installProgressByApp.planner).toMatchObject({ phase: 'downloading' });
    expect(result.current.bannerMessage).toBe('Downloading');
    act(() => bridge.emit('onInstallProgress', { appId: 'planner', progress: { success: true, phase: 'completed', userMessage: 'Done' } }));
    expect(result.current.installProgressByApp.planner).toBeUndefined();
    expect(result.current.selectedAppId).toBe('planner');

    act(() => bridge.emit('onDesktopUpdateProgress', { status: 'available', currentVersion: '1.0.0', availableVersion: '2.0.0' }));
    expect(result.current.desktopUpdateState.status).toBe('available');
    act(() => bridge.emit('onForgerAccountUpdated', { authenticated: true, userMessage: 'Signed in' }));
    expect(result.current.forgerAccount.authenticated).toBe(true);
    act(() => bridge.emit('onBackgroundTaskUpdated', { task: { id: 'task', source: 'install', title: 'Task', status: 'running', statusUpdates: [], createdAt: '2026-08-10', updatedAt: '2026-08-10' } }));
    expect(result.current.backgroundTasks[0]?.id).toBe('task');

    unmount();
    for (const callbacks of Object.values(bridge.unsubscribers)) {
      for (const unsubscribe of callbacks) expect(unsubscribe).toHaveBeenCalledOnce();
    }
  });

  it('resolves the dedicated social chat window route only for complete query parameters', async () => {
    window.history.replaceState({}, '', '/?socialChat=1&friendUserId=42&friendUsername=alice&friendDisplayName=Alice');
    const valid = await renderController();
    expect(valid.result.current.socialChatWindowRoute).toEqual({ friendUserId: 42, friendUsername: 'alice', friendDisplayName: 'Alice' });
    valid.unmount();
    window.history.replaceState({}, '', '/?socialChat=1&friendUserId=nope&friendUsername=&friendDisplayName=');
    const invalid = await renderController();
    expect(invalid.result.current.socialChatWindowRoute).toBeNull();
  });
});

describe('RendererAppController apps, files, backups, automations, and tools', () => {
  const installedApp = { id: 'planner', name: 'Planner', description: 'Plan work', category: 'productivity', status: 'installed', privateLocal: true, version: '1.0.0' };
  const storedFile = { id: 'file-1', name: 'plan.txt', relativePath: 'notes/plan.txt', categoryPath: 'notes', sizeBytes: 12, uploadedAt: '2026-08-10', modifiedAt: '2026-08-10', type: 'text/plain' };
  const localBackup = { backupId: 'backup-1', appId: 'planner', appName: 'Planner', totalBytes: 2048, createdAt: '2026-08-10', reason: 'manual' };
  const remoteBackup = { id: 'remote-1', appId: 'planner', appName: 'Planner', totalBytes: 4096, createdAt: '2026-08-10', backupType: 'sync_snapshot' };
  const automation = { id: 'automation-1', name: 'Daily', enabled: true, selectedAppIds: ['planner'], createdAt: '2026-08-10', updatedAt: '2026-08-10' };

  it('opens, starts, shares, stops, updates, restores, and deletes an installed app', async () => {
    const bridge = installBridge({
      listInstalledApps: [installedApp],
      listCatalogApps: [{ ...installedApp, status: undefined }],
      getCloudStorageUsage: { usedBytes: 10, limitBytes: 100 },
    });
    const { result } = await renderController(bridge);
    act(() => result.current.handleSelectChatApp('planner'));
    expect(result.current.selectedAppId).toBe('planner');
    act(() => result.current.handleSelectChatApp(null));
    expect(result.current.selectedAppId).toBeNull();
    act(() => result.current.handleSelectChatApp('missing'));
    expect(result.current.selectedAppId).toBeNull();

    await act(async () => result.current.openAppDetails('planner'));
    expect(result.current.currentView).toBe('app');
    expect(result.current.selectedAppDetails?.app.id).toBe('planner');
    await act(async () => result.current.handleOpen('planner'));
    expect(result.current.bannerMessage).toBe('Opened');
    await act(async () => result.current.handleStartLocalNetworkShare('planner'));
    expect(result.current.localNetworkShareDialogOpen).toBe(true);
    await act(async () => result.current.handleStopLocalNetworkShare());
    expect(result.current.localNetworkShareDialogOpen).toBe(false);
    await act(async () => result.current.handleStartRemoteNetworkShare('planner'));
    expect(result.current.remoteTunnelReadyDialog.open).toBe(true);
    await act(async () => result.current.openRemoteTunnelPortal());
    expect(bridge.call('openExternalUrl')).toHaveBeenCalled();
    await act(async () => result.current.stopReadyRemoteTunnel());
    await act(async () => result.current.handleStop('planner'));
    expect(result.current.bannerMessage).toBe('Stopped');
    await act(async () => result.current.handleUpdate('planner'));
    await act(async () => result.current.handleRestoreUserVersion('planner'));
    await act(async () => result.current.handleResolveConflict('planner'));
    expect(result.current.currentView).toBe('chat');
    await act(async () => result.current.handleDeleteApp('planner'));
    expect(bridge.call('uninstallApp')).toHaveBeenCalledWith('planner');
  });

  it('installs and creates local apps, including install welcome and provider setup conversation states', async () => {
    const bridge = installBridge({ listInstalledApps: [installedApp] });
    const { result } = await renderController(bridge);
    await act(async () => result.current.handleInstall('planner'));
    expect(bridge.call('installApp')).toHaveBeenCalledWith('planner', 'en');
    expect(result.current.chatMessages[0]?.content).toBe('Welcome to Planner');
    await act(async () => result.current.handleRetry('planner'));
    await act(async () => result.current.handleCreateLocalApp({ name: 'Created', description: 'Description', purpose: 'Purpose', lookAndFeel: 'Calm' }));
    expect(result.current.selectedAppId).toBe('created');
    expect(result.current.agentProviderConfigOpen).toBe(true);
    expect(result.current.createLocalAppBusy).toBe(false);
  });

  it('selects, stages, mentions, categorizes, renames, moves, and deletes files', async () => {
    const picked = { grantId: 'grant-1', name: 'picked.txt', sizeBytes: 4, modifiedAt: '2026-08-10', type: 'text/plain' };
    const bridge = installBridge({
      filesPickForChat: [picked, picked],
      filesList: [storedFile],
      filesListCategories: [{ path: 'notes', name: 'Notes', parentPath: '' }],
    });
    const { result } = await renderController(bridge);
    await act(async () => result.current.handlePickChatFiles());
    expect(result.current.pendingChatFiles).toHaveLength(1);
    await act(async () => result.current.handleStagePastedChatFile({ name: 'paste.png', mimeType: 'image/png', dataBase64: 'eA==' }));
    expect(result.current.pendingChatFiles).toHaveLength(2);
    act(() => result.current.handleMentionFile(storedFile));
    act(() => result.current.handleMentionFile(storedFile));
    expect(result.current.mentionedChatFiles).toEqual([storedFile]);
    act(() => result.current.handleRemovePendingChatFile('grant-1'));
    expect(result.current.pendingChatFiles).toHaveLength(1);

    act(() => result.current.openCreateCategoryDialog('', true));
    act(() => result.current.setCategoryDialogName(' Notes '));
    await act(async () => result.current.handleCreateCategorySubmit());
    expect(result.current.uploadCategoryPath).toBe('notes');
    act(() => result.current.openRenameCategoryDialog('notes'));
    act(() => result.current.setRenameCategoryDialog({ open: true, categoryPath: 'notes', name: 'Plans' }));
    await act(async () => result.current.handleRenameCategorySubmit());
    await act(async () => result.current.handleDeleteCategory('notes'));
    act(() => result.current.openRenameFileDialog(storedFile));
    act(() => result.current.setRenameFileDialog({ open: true, file: storedFile, name: 'renamed.txt' }));
    await act(async () => result.current.handleRenameFileSubmit());
    act(() => result.current.openMoveFileDialog(storedFile));
    act(() => result.current.setMoveFileDialog({ open: true, file: storedFile, categoryPath: '' }));
    await act(async () => result.current.handleMoveFileSubmit());
    await act(async () => result.current.handleDeleteFile(storedFile));
    expect(bridge.call('filesDelete')).toHaveBeenCalled();
  });

  it('creates, deletes, restores, syncs, and configures local and cloud backups', async () => {
    const bridge = installBridge({
      listInstalledApps: [installedApp],
      listBackups: [localBackup],
      listRemoteBackups: { backups: [remoteBackup], usage: { usedBytes: 4096, limitBytes: 8192, backupCount: 1, backupCountLimit: 5 } },
    });
    const { result } = await renderController(bridge);
    await act(async () => result.current.handleCreateBackup('planner'));
    await act(async () => result.current.handleDeleteBackup(localBackup));
    await act(async () => result.current.handleDeleteSelectedBackups([localBackup]));
    await act(async () => result.current.handleRestoreBackup(localBackup));
    await act(async () => result.current.handleSyncNow('planner'));
    await act(async () => result.current.handleDeleteRemoteBackup(remoteBackup));
    await act(async () => result.current.handleRestoreRemoteBackup(remoteBackup));
    await act(async () => result.current.handleSetAutoSync('planner', true));
    expect(result.current.backupsBusy).toBe(false);
    expect(bridge.call('createBackup')).toHaveBeenCalled();
    expect(bridge.call('restoreRemoteBackup')).toHaveBeenCalled();
    act(() => result.current.openCloudUpsell());
    expect(result.current.cloudModalOpen).toBe(true);
  });

  it('creates, updates, selects, runs, pauses, resumes, and deletes automations', async () => {
    const bridge = installBridge({ automationsList: [automation] });
    const { result } = await renderController(bridge);
    await act(async () => result.current.handleSaveAutomation({ name: 'Daily', prompt: 'Plan', frequency: 'daily', enabled: true, selectedAppIds: [] }));
    await act(async () => result.current.handleSaveAutomation({ id: 'automation-1', name: 'Daily', prompt: 'Plan', frequency: 'daily', enabled: false, selectedAppIds: [] }));
    act(() => result.current.handleSelectAutomation('automation-1'));
    await act(async () => result.current.handleSelectAutomationRun('run-1'));
    await act(async () => result.current.handlePauseAutomation('automation-1'));
    await act(async () => result.current.handleResumeAutomation('automation-1'));
    await act(async () => result.current.handleRunAutomationNow('automation-1'));
    await act(async () => result.current.handleDeleteAutomation('automation-1'));
    expect(result.current.automationBusy).toBe(false);
    expect(bridge.call('automationsCreate')).toHaveBeenCalled();
    expect(bridge.call('automationsUpdate')).toHaveBeenCalled();
  });

  it('mutates memories, tool approvals, official tools, and renders install access summaries', async () => {
    const bridge = installBridge({
      memoryList: [{ id: 'memory-created', content: 'Old', scope: 'global', createdAt: '2026-08-10', updatedAt: '2026-08-10' }],
      listOfficialTools: { tools: [{ id: 'gmail', name: 'Gmail', configured: true }] },
    });
    const { result } = await renderController(bridge);
    await act(async () => result.current.handleCreateMemory({ content: 'Created', scope: 'global' }));
    await act(async () => result.current.handleUpdateMemory({ id: 'memory-created', content: 'Updated' }));
    await act(async () => result.current.handleDeleteMemory('memory-created'));
    expect(result.current.memories).toEqual([]);
    await act(async () => result.current.handleAgentToolApprovalChange('forger_open_app', false));
    await act(async () => result.current.runOfficialToolAction('gmail', async () => ({ success: true, userMessage: 'Connected' }), 'configure'));
    expect(result.current.bannerMessage).toBe('Connected');

    const capability = result.current.renderInstallCapability({ key: 'network', label: 'Network', required: true, reason: 'Required for sync' });
    const item = result.current.renderInstallItem({ id: 'agent-1', title: 'Planner agent', description: 'Plans work', prompt: 'Plan' });
    render(<>{capability}{item}</>);
    expect(screen.getByText('Network')).toBeInTheDocument();
    expect(screen.getByText('Planner agent')).toBeInTheDocument();
  });
});

describe('RendererAppController chat, streaming, permissions, questions, and wake', () => {
  const authenticatedStatus = { installed: true, authenticated: true, authFilePath: '/tmp/auth.json', codexHome: '/tmp/codex' };
  const run = (overrides: Record<string, unknown> = {}) => ({
    runId: 'run-1',
    appId: 'forger',
    prompt: 'Hello',
    status: 'running',
    createdAt: '2026-08-10T12:00:00.000Z',
    updatedAt: '2026-08-10T12:00:01.000Z',
    dangerMode: false,
    permissionMode: 'safe',
    ...overrides,
  });

  it('starts a new free-chat conversation and sends its first message with the selected runtime', async () => {
    const bridge = installBridge({ getCodexAuthStatus: authenticatedStatus });
    const { result } = await renderController(bridge);
    act(() => result.current.handleStartNewConversation());
    expect(result.current.activeConversation?.mode).toBe('free_chat');
    await act(async () => result.current.handleSendMessage('Hello Forger'));
    expect(bridge.call('chatStartRun')).toHaveBeenCalledWith(expect.objectContaining({
      chatMode: 'free_chat',
      prompt: 'Hello Forger',
      provider: 'codex',
      permissionMode: 'safe',
      networkAccess: true,
    }));
    expect(result.current.chatMessages.at(-1)?.content).toBe('Hello Forger');
    expect(result.current.activeConversationRunActive).toBe(true);
  });

  it('streams progress, renders and resolves permission and question requests, deduplicates terminal replies, and stops runs', async () => {
    let startCount = 0;
    const bridge = installBridge({
      getCodexAuthStatus: authenticatedStatus,
      chatStartRun: async () => ({ runId: `run-${++startCount}`, status: 'queued' }),
    });
    const { result } = await renderController(bridge);
    act(() => result.current.handleStartNewConversation());
    const conversationId = result.current.activeConversationId!;
    await act(async () => result.current.handleSendMessage('Run it'));
    act(() => bridge.emit('onChatRunUpdated', { run: run({ runId: 'run-1', conversationId, progressLog: ['Working'] }) }));
    expect(result.current.activeConversationProgressLines).toEqual(['Working']);
    expect(result.current.activeConversationRunActive).toBe(true);

    const permissionRequest = { requestId: 'permission-1', pluginId: 'gmail', permission: 'send', reason: 'Send mail', risk: 'high', resource: 'message' };
    act(() => bridge.emit('onChatRunUpdated', { run: run({ runId: 'run-1', conversationId, status: 'needs_permission', permissionRequest }) }));
    expect(result.current.chatMessages.at(-1)?.action).toMatchObject({ type: 'permission', status: 'pending' });
    await act(async () => result.current.handleRespondPermission('run-1', 'permission-1', 'allow'));
    expect(result.current.chatMessages.at(-1)?.action).toMatchObject({ type: 'permission', status: 'approved' });

    act(() => bridge.emit('onChatRunUpdated', { run: run({ runId: 'run-1', conversationId, status: 'applied', userMessage: 'Finished', commitSha: 'abc123' }) }));
    act(() => bridge.emit('onChatRunUpdated', { run: run({ runId: 'run-1', conversationId, status: 'applied', userMessage: 'Finished', commitSha: 'abc123' }) }));
    expect(result.current.chatMessages.filter((message) => message.content === 'Finished')).toHaveLength(1);

    const questionRequest = {
      requestId: 'question-1', chatId: conversationId, createdAt: '2026-08-10',
      questions: [{ id: 'direction', question: 'Which?', options: [{ id: 'safe', label: 'Safe', description: 'Use safe mode' }] }],
    };
    act(() => bridge.emit('onChatRunUpdated', { run: run({ runId: 'question-run', conversationId, status: 'applied', questionRequest }) }));
    expect(result.current.chatMessages.at(-1)?.action).toMatchObject({ type: 'question', status: 'pending' });
    await act(async () => result.current.handleRespondQuestion('question-run', questionRequest, {
      answers: [{ questionId: 'direction', question: 'Which?', optionId: 'safe', label: 'Safe', description: 'Use safe mode' }],
      freeText: 'Please continue',
    }));
    expect(bridge.call('chatStartRun')).toHaveBeenLastCalledWith(expect.objectContaining({
      prompt: expect.stringContaining('FORGER_QUESTION_RESPONSE'),
      conversationId,
    }));

    act(() => bridge.emit('onChatRunUpdated', { run: run({ runId: 'run-2', conversationId, status: 'running' }) }));
    await act(async () => result.current.handleStopChatRun());
    expect(bridge.call('chatCancelRun')).toHaveBeenCalledWith({ runId: 'run-2' });
    expect(result.current.activeConversationRunActive).toBe(false);
  });

  it('imports attached and mentioned files, releases staged grants, and sends a file-only prompt', async () => {
    const mentioned = { id: 'mentioned', name: 'notes.txt', relativePath: 'notes/notes.txt', categoryPath: 'notes', sizeBytes: 12, uploadedAt: '2026-08-10', modifiedAt: '2026-08-10', type: 'text/plain' };
    const staged = { grantId: 'staged', name: 'paste.png', sizeBytes: 10, modifiedAt: '2026-08-10', type: 'image/png', staged: true };
    const imported = { id: 'imported', name: 'paste.png', relativePath: 'images/paste.png', categoryPath: 'images', sizeBytes: 10, uploadedAt: '2026-08-10', modifiedAt: '2026-08-10', type: 'image/png' };
    const bridge = installBridge({
      getCodexAuthStatus: authenticatedStatus,
      filesList: [mentioned],
      filesStageForChat: staged,
      filesImport: [imported],
    });
    const { result } = await renderController(bridge);
    act(() => result.current.handleStartNewConversation());
    await act(async () => result.current.handleStagePastedChatFile({ name: 'paste.png', mimeType: 'image/png', dataBase64: 'eA==' }));
    act(() => result.current.handleMentionFile(mentioned));
    await act(async () => result.current.handleSendMessage());
    expect(bridge.call('filesImport')).toHaveBeenCalledWith(expect.objectContaining({ grantIds: ['staged'] }));
    expect(bridge.call('filesReleaseSelections')).toHaveBeenCalledWith({ grantIds: ['staged'] });
    expect(bridge.call('chatStartRun')).toHaveBeenCalledWith(expect.objectContaining({
      prompt: 'Review the shared files in this message.',
      sharedFiles: expect.arrayContaining([
        expect.objectContaining({ id: 'imported', source: 'attached' }),
        expect.objectContaining({ id: 'mentioned', source: 'mentioned' }),
      ]),
    }));
    expect(result.current.pendingChatFiles).toEqual([]);
    expect(result.current.mentionedChatFiles).toEqual([]);
  });

  it('opens free chat from wake by creating it once and reusing it thereafter, and prompts for a missing provider', async () => {
    const unauthenticated = await renderController();
    act(() => unauthenticated.result.current.handleOpenFreeChatFromWake());
    const firstId = unauthenticated.result.current.activeConversationId;
    act(() => unauthenticated.result.current.handleOpenFreeChatFromWake());
    expect(unauthenticated.result.current.activeConversationId).toBe(firstId);
    await act(async () => unauthenticated.result.current.handleSendMessage('Cannot send'));
    expect(unauthenticated.result.current.agentProviderConfigOpen).toBe(true);
  });
});

describe('RendererAppController authentication, accounts, settings, secrets, and reports', () => {
  const codexAuthenticated = { installed: true, authenticated: true, authFilePath: '/tmp/auth', codexHome: '/tmp/codex' };
  const claudeAuthenticated = { installed: true, authenticated: true, source: 'credentials' };
  const antigravityAuthenticated = { installed: true, authenticated: true, source: 'credentials' };

  it('connects, disconnects, reinstalls, and closes all provider authentication flows', async () => {
    const bridge = installBridge({
      getCodexAuthStatus: codexAuthenticated,
      getClaudeAuthStatus: claudeAuthenticated,
      getAntigravityAuthStatus: antigravityAuthenticated,
    });
    const { result } = await renderController(bridge);
    act(() => {
      result.current.setCodexConfigOpen(true);
      result.current.setClaudeConfigOpen(true);
      result.current.setAntigravityConfigOpen(true);
      result.current.setAgentProviderConfigOpen(true);
    });
    await act(async () => result.current.handleConnectCodexAuth());
    await act(async () => result.current.handleConnectClaudeAuth());
    await act(async () => result.current.handleConnectAntigravityAuth());
    expect(analytics.usageAnalytics.llmProviderConnected).toHaveBeenCalled();
    await act(async () => result.current.handleDisconnectCodexAuth());
    await act(async () => result.current.handleDisconnectClaudeAuth());
    await act(async () => result.current.handleSignOutClaudeAuth());
    await act(async () => result.current.handleDisconnectAntigravityAuth());
    await act(async () => result.current.handleReinstallCodex());
    await act(async () => result.current.handleReinstallClaude());
    await act(async () => result.current.handleReinstallAntigravity());
    act(() => {
      result.current.closeCodexConfig();
      result.current.closeClaudeConfig();
      result.current.closeAntigravityConfig();
    });
    expect(result.current.codexAuthBusy).toBe(false);
    expect(result.current.claudeAuthBusy).toBe(false);
    expect(result.current.antigravityAuthBusy).toBe(false);
  });

  it('streams antigravity session output, completion, failure, cancellation, and explicit user cancel', async () => {
    const bridge = installBridge({ getAntigravityAuthStatus: antigravityAuthenticated });
    const { result } = await renderController(bridge);
    await waitFor(() => expect(bridge.listeners.onAntigravityAuthSessionEvent).toHaveLength(1));
    act(() => bridge.emit('onAntigravityAuthSessionEvent', { sessionId: 'session-a', type: 'started', text: 'Open browser' }));
    act(() => bridge.emit('onAntigravityAuthSessionEvent', { sessionId: 'session-a', type: 'output', stream: 'stdout', text: 'Waiting' }));
    expect(result.current.antigravityAuthLines.some((line) => line.text === 'Waiting')).toBe(true);
    act(() => bridge.emit('onAntigravityAuthSessionEvent', { sessionId: 'other', type: 'output', text: 'Ignore' }));
    expect(result.current.antigravityAuthLines.some((line) => line.text === 'Ignore')).toBe(false);
    act(() => bridge.emit('onAntigravityAuthSessionEvent', { sessionId: 'session-a', type: 'failed', stream: 'stderr', text: 'Failed' }));
    expect(result.current.bannerSeverity).toBe('error');
    act(() => bridge.emit('onAntigravityAuthSessionEvent', { sessionId: 'session-a', type: 'canceled', text: 'Canceled' }));
    act(() => bridge.emit('onAntigravityAuthSessionEvent', { sessionId: 'session-a', type: 'completed', status: antigravityAuthenticated }));
    await act(async () => result.current.handleCancelAntigravityAuthSession());
    expect(bridge.call('cancelAntigravityAuthSession')).toHaveBeenCalledWith('session-a');
  });

  it('logs in with password, Google, and Apple, registers, updates profile, enters forum, and logs out', async () => {
    const bridge = installBridge();
    const { result } = await renderController(bridge);
    await act(async () => result.current.handleForgerLogin('user@example.com', 'secret'));
    expect(result.current.forgerAccount.authenticated).toBe(true);
    await act(async () => result.current.handleForgerGoogleLogin());
    await act(async () => result.current.handleForgerAppleLogin());
    expect(await result.current.handleForgerRegister({ email: 'new@example.com', password: 'secret', passwordConfirmation: 'secret' })).toBe(true);
    await act(async () => result.current.handleForgerUsernameUpdate('renamed'));
    await act(async () => result.current.handleForgerProfileUpdate({ displayName: 'Renamed User' }));
    await act(async () => result.current.handleEnterForum());
    expect(result.current.currentView).toBe('friends');
    await act(async () => result.current.handleDismissForumPrompt());
    await act(async () => result.current.handleForgerLogout());
    expect(result.current.forgerAccount.authenticated).toBe(false);
    expect(result.current.forgerAccountBusy).toBe(false);
  });

  it('updates workflows, agent defaults, profiles, developer mode, analytics, appearance, and onboarding state', async () => {
    const bridge = installBridge();
    const { result } = await renderController(bridge);
    await act(async () => result.current.handleUpdateWorkflowsEarlyAccess(false));
    await act(async () => result.current.handleAgentDefaultsChange({ provider: 'codex', model: 'gpt-pro', effort: 'high', defaultProvider: 'codex' }));
    await act(async () => result.current.handleAgentDefaultsChange({ provider: 'claude', model: 'claude-pro', effort: 'high' }));
    await act(async () => result.current.handleAgentDefaultsChange({ provider: 'antigravity', model: 'gemini-pro', effort: 'high' }));
    await act(async () => result.current.handleAgentDefaultsChange({ defaultChatPermissionMode: 'unsafe', defaultChatNetworkAccess: false }));
    await act(async () => result.current.handleActiveProviderProfileChange({ provider: 'codex', profileId: 'profile-1' }));
    await act(async () => result.current.handleProviderProfileDefaultsChange({ provider: 'codex', profileId: 'profile-1', model: 'gpt-pro', effort: 'high' }));
    await act(async () => result.current.handleDeveloperModeChange({ enabled: true, pathEntries: ['/usr/local/bin'] }));
    act(() => {
      result.current.handleUsageAnalyticsChange(false);
      result.current.setThemePreference('dark');
      result.current.setLanguagePreference('es');
      result.current.setChatBotPicture('forger');
      result.current.resetOnboarding();
    });
    expect(result.current.themePreference).toBe('dark');
    expect(result.current.languagePreference).toBe('es');
    expect(analytics.setUsageAnalyticsPreference).toHaveBeenCalledWith(false);
    expect(result.current.bannerSeverity).toBe('success');
  });

  it('creates global secrets and connects app secrets after opening app details', async () => {
    const bridge = installBridge({
      listInstalledApps: [{ id: 'planner', name: 'Planner', category: 'productivity', status: 'installed' }],
      listUserSecrets: [{ id: 'secret-1', name: 'TOKEN', createdAt: '2026-08-10', updatedAt: '2026-08-10' }],
    });
    const { result } = await renderController(bridge);
    await act(async () => result.current.handleCreateSecret({ name: 'TOKEN', value: 'secret' }));
    await act(async () => result.current.handleUpdateSecret({ id: 'secret-1', name: 'TOKEN', value: 'new' }));
    await act(async () => result.current.handleDeleteSecret('secret-1'));
    await act(async () => result.current.openAppDetails('planner'));
    await act(async () => result.current.handleConnectSecret('API_TOKEN', 'secret-1'));
    await act(async () => result.current.handleDisconnectSecret('API_TOKEN'));
    expect(bridge.call('connectAppSecret')).toHaveBeenCalledWith(expect.objectContaining({ appId: 'planner', appSecretName: 'API_TOKEN' }));
    expect(result.current.secretsBusy).toBe(false);
  });

  it('prepares, copies, submits, and closes desktop and conversation diagnostic reports', async () => {
    const bridge = installBridge({
      prepareDesktopErrorReport: async (report: Record<string, unknown>) => ({ ...report, diagnosticAttachmentToken: 'desktop-token' }),
    });
    const { result } = await renderController(bridge);
    act(() => bridge.emit('onDesktopErrorReportRequested', { source: 'renderer', operation: 'manual', message: 'Boom', technicalCode: 'renderer_failure', occurredAt: '2026-08-10' }));
    await waitFor(() => expect(result.current.errorReportDialog.busy).toBe(false));
    await act(async () => result.current.copyErrorReportDetails());
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(expect.not.stringContaining('desktop-token'));
    await act(async () => result.current.submitErrorReport());
    expect(result.current.errorReportDialog.open).toBe(false);
    act(() => result.current.closeErrorReportDialog());

    const agent = { id: 'agent-1', name: 'Planner agent', description: 'Plans', createdAt: '2026-08-10', updatedAt: '2026-08-10' };
    const conversation = { id: 'agent-chat', agentId: 'agent-1', title: 'Agent chat', messages: [{ id: 'user', role: 'user', content: 'Plan', createdAt: '2026-08-10' }], createdAt: '2026-08-10', updatedAt: '2026-08-10' };
    await act(async () => result.current.prepareConversationDiagnosticReport({ agent, conversation }));
    act(() => result.current.setConversationDiagnosticDescription(' Useful context '));
    await act(async () => result.current.copyConversationDiagnosticReport());
    await act(async () => result.current.submitConversationDiagnosticReport());
    expect(result.current.conversationDiagnosticDialog.open).toBe(false);
    act(() => result.current.closeConversationDiagnosticDialog());
  });

  it('submits ratings, feedback, prompt updates, and desktop update actions', async () => {
    const bridge = installBridge({ listInstalledApps: [{ id: 'planner', name: 'Planner', category: 'productivity', status: 'installed' }] });
    const { result } = await renderController(bridge);
    await act(async () => result.current.openAppDetails('planner'));
    await act(async () => result.current.handleSubmitRating({ appId: 'planner', rating: 5 }));
    await act(async () => result.current.handleSubmitFeedback({ target: 'product', kind: 'idea', message: 'Great', surface: 'feedback' }));
    await act(async () => result.current.handleUpdateAppPrompt({ appId: 'planner', promptId: 'prompt-1', prompt: 'Updated' }));
    await act(async () => result.current.handleRestoreAppPrompt({ appId: 'planner', promptId: 'prompt-1' }));
    await act(async () => result.current.runDesktopUpdateAction(async () => ({ status: 'installer_opened', currentVersion: '1.0.0', userMessage: 'Opened installer' })));
    expect(result.current.desktopUpdateBusy).toBe(false);
    expect(bridge.call('submitAppRating')).toHaveBeenCalled();
    expect(analytics.submitUsageEvent).toHaveBeenCalled();
  });
});

describe('RendererAppController install gates and social apps', () => {
  const socialApp = {
    id: 7,
    slug: 'shared-planner',
    name: 'Shared Planner',
    description: 'A shared planner',
    category: 'productivity',
    visibility: 'public',
    status: 'published',
    owner: { id: 2, username: 'Alice User', displayName: 'Alice' },
    averageReviewScore: 4.5,
    reviewsCount: 2,
    latestVersion: {
      id: 9, version: '1.2.0', runtimeStack: 'vite-fastapi-sqlite', supportedPlatforms: ['darwin'],
      capabilities: ['files'], checksumSha256: 'abc', fileSizeBytes: 10,
    },
  };

  const gate = () => ({
    appId: 'planner', appName: 'Planner', canInstall: true,
    platformCapabilities: { network: { required: true, reason: 'Sync' } },
    required: [{
      declaration: { toolId: 'gmail', actions: ['send'], reason: 'Send mail' }, required: true,
      tool: { id: 'gmail', name: 'Gmail', configured: true }, resolvedActions: [{ id: 'send', name: 'Send' }],
      allActions: false, granted: true, hasStoredGrant: true, available: true, configured: true,
    }],
    optional: [{
      declaration: { toolId: 'calendar', actions: ['*'], reason: 'Read calendar' }, required: false,
      resolvedActions: [], allActions: true, granted: false, hasStoredGrant: false, available: false, configured: false,
    }],
    connectionRequired: [], connectionOptional: [{
      declaration: { type: 'slack', actions: ['send'], reason: 'Send Slack messages' }, required: false,
      definition: { type: 'slack', displayName: 'Slack', actions: [{ id: 'send', name: 'Send' }] },
      resolvedActions: [{ id: 'send', name: 'Send' }], allActions: false, granted: true, hasStoredGrant: true,
      configured: true, instances: [],
    }],
    agents: [{ id: 'agent', title: 'Planner agent', prompt: 'Plan' }],
    promptTemplates: [{ id: 'prompt', title: 'Plan week', prompt: 'Plan week' }],
  });

  it('reviews platform, tool, connection, agent, and prompt access before installation and persists optional choices', async () => {
    const installGate = gate();
    const bridge = installBridge({
      getAppToolsInstallGate: installGate,
      setAppToolGrant: installGate,
      setAppConnectionGrant: installGate,
    });
    const { result } = await renderController(bridge);
    await act(async () => result.current.handleInstall('planner'));
    expect(result.current.pendingInstallGate?.appId).toBe('planner');
    expect(result.current.capabilityRows(installGate).at(0)).toMatchObject({ key: 'network', required: true });
    const requiredTool = result.current.renderInstallTool(installGate.required[0], true);
    const optionalTool = result.current.renderInstallTool(installGate.optional[0], false);
    const optionalConnection = result.current.renderInstallConnection(installGate.connectionOptional[0], false);
    const view = render(<>{requiredTool}{optionalTool}{optionalConnection}</>);
    expect(screen.getByText('Gmail')).toBeInTheDocument();
    expect(screen.getByText('Slack')).toBeInTheDocument();
    const switches = screen.getAllByRole('switch');
    fireEvent.click(switches[0]!);
    fireEvent.click(switches[1]!);
    view.unmount();
    await act(async () => result.current.handleConfirmInstallWithTools());
    expect(bridge.call('setAppToolGrant')).toHaveBeenCalled();
    expect(bridge.call('setAppConnectionGrant')).toHaveBeenCalled();
    expect(bridge.call('installApp')).toHaveBeenCalled();

    await act(async () => result.current.openAppDetails('planner'));
    await act(async () => result.current.handleAppDetailsToolGrant('calendar', true));
    await act(async () => result.current.handleAppDetailsConnectionGrant('slack', false));
    expect(result.current.selectedAppToolGrantBusyId).toBeNull();
  });

  it('opens social deep links and details, requests account confirmation, and opens review access', async () => {
    const bridge = installBridge({
      resolveSocialCode: { app: socialApp },
      resolveSocialApp: { app: socialApp },
      getAppToolsInstallGate: null,
      listCatalogApps: [{ id: 'social-alice-user-shared-planner', name: 'Shared Planner', category: 'productivity', socialUserAppId: 7 }],
    });
    const { result } = await renderController(bridge);
    act(() => bridge.emit('onDeepLink', { kind: 'social-app', code: 'share-code' }));
    await waitFor(() => expect(result.current.selectedAppDetails?.social?.app.id).toBe(7));
    expect(result.current.currentView).toBe('app');
    act(() => result.current.handleOpenSocialApp(socialApp));
    expect(result.current.appDetailsBackView).toBe('friends');
    await act(async () => result.current.handleInstall('social-alice-user-shared-planner'));
    expect(result.current.socialDownloadAccountRequiredOpen).toBe(true);
  });

  it('installs social apps with skipped review and creates a reviewed quarantine conversation', async () => {
    const account = { success: true, authenticated: true, user: { id: 1, email: 'user@example.com', username: 'user', confirmed: true } };
    const quarantine = {
      quarantineId: 'quarantine-1', userAppId: 7, localAppId: 'social-alice-user-shared-planner', status: 'pending_review',
      name: 'Shared Planner', slug: 'shared-planner', ownerUsername: 'alice', version: '1.2.0',
      zipPath: '/tmp/app.zip', stagedDir: '/tmp/staged', createdAt: '2026-08-10', updatedAt: '2026-08-10',
    };
    const bridge = installBridge({
      getForgerAccount: account,
      getCodexAuthStatus: { installed: true, authenticated: true, authFilePath: '/tmp/auth', codexHome: '/tmp/codex' },
      listCatalogApps: [{ id: 'social-alice-shared-planner', name: 'Shared Planner', category: 'productivity', socialUserAppId: 7 }],
      installSocialApp: { success: true, userMessage: 'Social installed', appId: 'social-alice-shared-planner' },
      prepareSocialAppReview: { success: true, userMessage: 'Ready to review', quarantine },
      getAppDetails: { app: { id: 'social-alice-shared-planner', name: 'Shared Planner', category: 'productivity', status: 'installed' }, installed: true, status: 'installed', operations: [] },
    });
    const { result } = await renderController(bridge);
    await act(async () => result.current.handleInstall('social-alice-shared-planner', 'skipped_review'));
    expect(bridge.call('installSocialApp')).toHaveBeenCalled();
    await act(async () => result.current.handleInstall('social-alice-shared-planner', 'reviewed'));
    expect(result.current.activeConversation?.mode).toBe('social_app_review');
    expect(bridge.call('prepareSocialAppReview')).toHaveBeenCalled();
    expect(bridge.call('chatStartRun')).toHaveBeenCalledWith(expect.objectContaining({ chatMode: 'social_app_review' }));
  });

  it('uploads and renames local and remixed apps through dialog state', async () => {
    const installed = { id: 'remix', name: 'Ámazing App!', description: 'Remix', category: 'invalid', status: 'installed', socialSource: { ownerUsername: 'alice', slug: 'source' } };
    const bridge = installBridge({ listInstalledApps: [installed] });
    const { result } = await renderController(bridge);
    act(() => result.current.handleUploadSocial('remix'));
    expect(result.current.socialUploadDialog.slug).toBe('amazing-app');
    act(() => {
      result.current.setSocialUploadVisibility('friends');
      result.current.setSocialUploadCategory('productivity');
      result.current.setSocialUploadName('New Social Name');
    });
    await act(async () => result.current.submitSocialUploadDialog());
    await waitFor(() => expect(bridge.call('uploadSocialApp')).toHaveBeenCalled());
    act(() => result.current.closeSocialUploadDialog());

    act(() => result.current.handleRenameApp('remix'));
    act(() => result.current.setRenameAppName('Renamed Remix'));
    await act(async () => result.current.submitRenameAppDialog());
    expect(bridge.call('renameInstalledApp')).toHaveBeenCalledWith({ appId: 'remix', name: 'Renamed Remix' });
    act(() => result.current.closeRenameAppDialog());
  });
});

describe('RendererAppController event variants, reactive loading, and recoverable failures', () => {
  it('handles runtime, automation, account, and installation event variants', async () => {
    const automation = { id: 'automation-1', name: 'Daily', enabled: true, selectedAppIds: ['planner'], createdAt: '2026-08-10', updatedAt: '2026-08-11' };
    const run = { id: 'automation-run', automationId: 'automation-1', status: 'succeeded', userMessage: 'Done', startedAt: '2026-08-10', finishedAt: '2026-08-11', updatedAt: '2026-08-11' };
    const bridge = installBridge({
      automationsList: [automation],
      automationsListRuns: [run],
      automationsGetRunTranscript: { ...run, transcript: [] },
    });
    const { result } = await renderController(bridge);
    act(() => bridge.emit('onInstallProgress', { appId: 'planner', progress: { success: false, phase: 'failed', userMessage: 'Install failed' } }));
    expect(result.current.bannerSeverity).toBe('error');
    act(() => bridge.emit('onInstallProgress', { appId: 'planner', progress: { success: false, phase: 'conflict', userMessage: 'Conflict' } }));
    expect(result.current.installProgressByApp.planner).toBeUndefined();
    act(() => bridge.emit('onRuntimeStatusChanged', { appId: 'planner', status: 'running', userMessage: 'Running', localNetworkShare: { active: true, appId: 'planner' }, remoteNetworkShare: { active: true, appId: 'planner', state: 'connected', sessionId: 'runtime-session' } }));
    expect(result.current.localNetworkShareStatus?.appId).toBe('planner');
    expect(result.current.remoteTunnelReadyDialog.open).toBe(true);
    act(() => bridge.emit('onRuntimeStatusChanged', { appId: 'planner', status: 'error', userMessage: 'Crashed' }));
    expect(result.current.bannerSeverity).toBe('error');
    act(() => bridge.emit('onRuntimeStatusChanged', { appId: 'planner', status: 'installed' }));
    expect(result.current.bannerSeverity).toBe('info');
    act(() => result.current.handleSelectAutomation('automation-1'));
    act(() => bridge.emit('onAutomationUpdated', { automation, run }));
    await waitFor(() => expect(bridge.call('automationsGetRunTranscript')).toHaveBeenCalledWith('automation-run'));
    act(() => bridge.emit('onForgerAccountUpdated', { authenticated: false, userMessage: 'Signed out' }));
    expect(result.current.forumPromptOpen).toBe(false);
  });

  it('reactively loads files, backups, secrets, details, analytics routes, and disables inaccessible workflows', async () => {
    const disabled = settingsFixture();
    disabled.earlyAccess = { workflowsEnabled: false };
    const bridge = installBridge({
      getSettings: disabled,
      listInstalledApps: [{ id: 'planner', name: 'Planner', category: 'productivity', status: 'installed' }],
      getAppSecrets: { appId: 'planner', requirements: [], connections: [], userSecrets: [] },
    });
    const { result } = await renderController(bridge);
    act(() => result.current.setCurrentView('workflows'));
    await waitFor(() => expect(result.current.currentView).toBe('more'));
    act(() => result.current.setCurrentView('files'));
    await waitFor(() => expect(bridge.call('filesList').mock.calls.length).toBeGreaterThan(1));
    act(() => result.current.setFileFilters({ sortBy: 'name', sortDirection: 'asc' }));
    await waitFor(() => expect(bridge.call('filesList')).toHaveBeenLastCalledWith({ sortBy: 'name', sortDirection: 'asc' }));
    act(() => result.current.setCurrentView('backups'));
    await waitFor(() => expect(bridge.call('listBackups').mock.calls.length).toBeGreaterThan(1));
    act(() => result.current.setCurrentView('secrets'));
    await waitFor(() => expect(bridge.call('listUserSecrets')).toHaveBeenCalled());
    await act(async () => result.current.openAppDetails('planner'));
    await waitFor(() => expect(bridge.call('getAppSecrets')).toHaveBeenCalledWith('planner'));
    act(() => result.current.setCurrentView('catalog'));
    act(() => result.current.setCatalogFilter('productivity'));
    act(() => result.current.setCatalogStatusFilter('installed'));
    act(() => result.current.setCurrentView('feedback'));
    expect(analytics.submitUsageEvent).toHaveBeenCalledWith(expect.objectContaining({ eventName: 'feedback_opened' }));
    act(() => window.dispatchEvent(new Event('languagechange')));
  });

  it('surfaces startup loading failures and available or unsupported startup updates without aborting bootstrap', async () => {
    const failure = () => Promise.reject(new Error('offline'));
    const bridge = installBridge({
      listCatalogApps: failure,
      listAgentTools: failure,
      listOfficialTools: failure,
      checkDesktopUpdates: { status: 'available', currentVersion: '1.0.0', availableVersion: '2.0.0' },
    });
    const first = await renderController(bridge);
    await waitFor(() => expect(first.result.current.desktopUpdateState.status).toBe('available'));
    expect(first.result.current.agentToolError).not.toBeNull();
    first.unmount();

    window.localStorage.clear();
    const unsupported = await renderController(installBridge({
      checkDesktopUpdates: { status: 'unsupported', currentVersion: '1.0.0', userMessage: 'Unsupported system' },
    }));
    await waitFor(() => expect(unsupported.result.current.bannerMessage).toBe('Unsupported system'));
  });

  it('handles malformed and failing Social app links', async () => {
    const bridge = installBridge({
      resolveSocialCode: () => Promise.reject(new Error('expired')),
      resolveSocialApp: () => Promise.reject(new Error('missing')),
    });
    const { result } = await renderController(bridge);
    act(() => bridge.emit('onDeepLink', { kind: 'social-app', code: 'expired' }));
    await waitFor(() => expect(result.current.bannerSeverity).toBe('error'));
    act(() => bridge.emit('onDeepLink', { kind: 'social-app', id: 7 }));
    await waitFor(() => expect(bridge.call('resolveSocialApp')).toHaveBeenCalledWith(7));
    act(() => bridge.emit('onDeepLink', { kind: 'social-app' }));
    await waitFor(() => expect(result.current.bannerMessage).toBe('No pudimos abrir esta app de Social.'));
  });
});

describe('RendererAppController failure recovery and edge conditions', () => {
  const failure = (message = 'failure') => () => Promise.reject(new Error(message));
  const app = { id: 'planner', name: 'Planner', category: 'productivity', status: 'installed', version: '1.0.0' };
  const localBackup = { backupId: 'backup-1', appId: 'planner', appName: 'Planner', totalBytes: 0, createdAt: '2026-08-10', reason: 'manual' };
  const remoteBackup = { id: 'remote-1', appId: 'planner', appName: 'Planner', totalBytes: 0, createdAt: '2026-08-10', backupType: 'sync_snapshot' };

  it('recovers from app lifecycle and network sharing failures while releasing busy state', async () => {
    const bridge = installBridge({
      listInstalledApps: [app],
      openApp: failure('open failed'),
      updateApp: failure('update failed'),
      startLocalNetworkShare: failure(), stopLocalNetworkShare: failure(),
      startRemoteNetworkShare: failure(), stopRemoteNetworkShare: failure(),
    });
    const { result } = await renderController(bridge);
    await act(async () => result.current.handleOpen('planner'));
    expect(result.current.openingAppIds.size).toBe(0);
    await act(async () => result.current.handleStartLocalNetworkShare('planner'));
    await act(async () => result.current.handleStopLocalNetworkShare('planner'));
    await act(async () => result.current.handleStartRemoteNetworkShare('planner'));
    await act(async () => result.current.handleStopRemoteNetworkShare('planner'));
    await act(async () => result.current.handleUpdate('planner'));
    expect(result.current.bannerSeverity).toBe('error');

    const pending = Promise.withResolvers<{ success: boolean; userMessage: string }>();
    bridge.set('openApp', () => pending.promise);
    let first!: Promise<void>;
    act(() => { first = result.current.handleOpen('planner'); });
    await act(async () => result.current.handleOpen('planner'));
    expect(bridge.call('openApp')).toHaveBeenCalledTimes(2);
    pending.resolve({ success: true, userMessage: 'Opened' });
    await act(async () => first);
  });

  it('handles backup cancellations, empty selections, partial deletion, upsells, and all backup exceptions', async () => {
    const bridge = installBridge({ listInstalledApps: [app] });
    const { result } = await renderController(bridge);
    expect(await result.current.handleDeleteSelectedBackups([])).toBe(false);
    Object.defineProperty(window, 'confirm', { configurable: true, value: vi.fn(() => false) });
    await act(async () => result.current.handleDeleteBackup(localBackup));
    await act(async () => result.current.handleRestoreBackup(localBackup));
    await act(async () => result.current.handleDeleteRemoteBackup(remoteBackup));
    await act(async () => result.current.handleRestoreRemoteBackup(remoteBackup));
    expect(bridge.call('deleteBackup')).not.toHaveBeenCalled();
    Object.defineProperty(window, 'confirm', { configurable: true, value: vi.fn(() => true) });

    bridge.set('deleteBackups', { success: false, userMessage: 'Partial', deleted: ['backup-1'], failed: ['backup-2'] });
    await act(async () => result.current.handleDeleteSelectedBackups([localBackup, { ...localBackup, backupId: 'backup-2', totalBytes: Number.POSITIVE_INFINITY }]));
    expect(result.current.bannerSeverity).toBe('warning');
    bridge.set('createRemoteBackup', { success: false, userMessage: 'Cloud required', technicalCode: 'cloud_account_required' });
    await act(async () => result.current.handleSyncNow('planner'));
    expect(result.current.cloudModalOpen).toBe(true);

    for (const [method, action] of [
      ['createBackup', () => result.current.handleCreateBackup('planner')],
      ['deleteBackup', () => result.current.handleDeleteBackup(localBackup)],
      ['deleteBackups', () => result.current.handleDeleteSelectedBackups([localBackup])],
      ['restoreBackup', () => result.current.handleRestoreBackup(localBackup)],
      ['createRemoteBackup', () => result.current.handleSyncNow('planner')],
      ['deleteRemoteBackup', () => result.current.handleDeleteRemoteBackup(remoteBackup)],
      ['restoreRemoteBackup', () => result.current.handleRestoreRemoteBackup(remoteBackup)],
      ['setAppAutoSync', () => result.current.handleSetAutoSync('planner', false)],
    ] as const) {
      bridge.set(method, failure(`${method} failed`));
      await act(async () => action());
    }
    expect(result.current.backupsBusy).toBe(false);
  });

  it('guards invalid file dialogs and reports file and secret mutation failures', async () => {
    const bridge = installBridge({ filesListCategories: [] });
    const { result } = await renderController(bridge);
    await act(async () => result.current.handleCreateCategorySubmit());
    await act(async () => result.current.handleRenameCategorySubmit());
    await act(async () => result.current.handleRenameFileSubmit());
    await act(async () => result.current.handleMoveFileSubmit());
    Object.defineProperty(window, 'confirm', { configurable: true, value: vi.fn(() => false) });
    await act(async () => result.current.handleDeleteCategory('notes'));
    await act(async () => result.current.handleDeleteFile({ id: 'file', name: 'file.txt', relativePath: 'file.txt', categoryPath: '', sizeBytes: 1, uploadedAt: '2026-08-10', modifiedAt: '2026-08-10', type: 'text/plain' }));
    bridge.set('createUserSecret', failure());
    await act(async () => result.current.handleCreateSecret({ name: 'TOKEN', value: 'secret' }));
    expect(result.current.bannerSeverity).toBe('error');
    await act(async () => result.current.handleConnectSecret('TOKEN', 'secret'));
    await act(async () => result.current.handleDisconnectSecret('TOKEN'));
  });

  it('restores permission requests after rejected decisions and reports orphaned and terminal chat events', async () => {
    const bridge = installBridge({ chatApprovePermission: { success: false } });
    const { result } = await renderController(bridge);
    const request = { requestId: 'permission', pluginId: 'gmail', permission: 'send', reason: 'Send', risk: 'high', resource: 'mail' };
    act(() => bridge.emit('onChatRunUpdated', { run: { runId: 'orphan', appId: 'forger', prompt: '', status: 'needs_permission', createdAt: '2026-08-10', updatedAt: '2026-08-10', dangerMode: false, permissionMode: 'safe', permissionRequest: request } }));
    expect(result.current.bannerSeverity).toBe('warning');
    await act(async () => result.current.handleRespondPermission('orphan', 'permission', 'deny'));
    act(() => bridge.emit('onChatRunUpdated', { run: { runId: 'terminal', appId: 'forger', prompt: '', status: 'failed', createdAt: '2026-08-10', updatedAt: '2026-08-10', dangerMode: false, permissionMode: 'safe', userMessage: '' } }));
    expect(result.current.activeConversationRunActive).toBe(false);
  });

  it('maps chat start failures to friendly messages and restores failed question actions', async () => {
    for (const [detail, expectedFragment] of [
      ['app_run_in_progress', 'already'],
      ['another_run_in_progress', 'previous'],
      ['generic failure', 'generic failure'],
    ]) {
      const bridge = installBridge({
        getCodexAuthStatus: { installed: true, authenticated: true, authFilePath: '/tmp/auth', codexHome: '/tmp/codex' },
        chatStartRun: failure(detail),
      });
      const current = await renderController(bridge);
      act(() => current.result.current.handleStartNewConversation());
      await act(async () => current.result.current.handleSendMessage('Hello'));
      expect(current.result.current.chatMessages.at(-1)?.content.toLowerCase()).toContain(expectedFragment);
      current.unmount();
    }

    const bridge = installBridge({
      getCodexAuthStatus: { installed: true, authenticated: true, authFilePath: '/tmp/auth', codexHome: '/tmp/codex' },
      chatStartRun: failure('conversation_run_in_progress'),
    });
    const current = await renderController(bridge);
    act(() => current.result.current.handleStartNewConversation());
    const conversationId = current.result.current.activeConversationId!;
    const request = { requestId: 'question', chatId: conversationId, createdAt: '2026-08-10', questions: [] };
    act(() => bridge.emit('onChatRunUpdated', { run: { runId: 'question-run', appId: 'forger', prompt: '', conversationId, status: 'applied', createdAt: '2026-08-10', updatedAt: '2026-08-10', dangerMode: false, permissionMode: 'safe', questionRequest: request } }));
    await act(async () => current.result.current.handleRespondQuestion('question-run', request, { answers: [] }));
    expect(current.result.current.chatMessages.some((message) => message.action?.type === 'question' && message.action.status === 'pending')).toBe(true);
    await act(async () => current.result.current.handleRespondQuestion('question-run', { ...request, chatId: 'missing' }, { answers: [] }));
    expect(current.result.current.bannerSeverity).toBe('error');
  });

  it('surfaces failed settings, tool, memory, update, account, and report operations', async () => {
    const bridge = installBridge();
    const { result } = await renderController(bridge);
    for (const [method, action] of [
      ['updateWorkflowsEarlyAccess', () => result.current.handleUpdateWorkflowsEarlyAccess(true)],
      ['updateAgentDefaults', () => result.current.handleAgentDefaultsChange({ provider: 'codex', model: 'x' })],
      ['setActiveLlmProviderProfile', () => result.current.handleActiveProviderProfileChange({ provider: 'codex', profileId: 'x' })],
      ['updateLlmProviderProfileDefaults', () => result.current.handleProviderProfileDefaultsChange({ provider: 'codex', profileId: 'x', model: 'x', effort: 'low' })],
      ['updateAgentToolApproval', () => result.current.handleAgentToolApprovalChange('forger_open_app', true)],
      ['memoryCreate', () => result.current.handleCreateMemory({ content: 'x', scope: 'global' })],
      ['memoryUpdate', () => result.current.handleUpdateMemory({ id: 'x', content: 'x' })],
      ['memoryDelete', () => result.current.handleDeleteMemory('x')],
    ] as const) {
      bridge.set(method, failure(`${method} failed`));
      await act(async () => action());
    }
    await act(async () => result.current.runOfficialToolAction('gmail', async () => { throw new Error('tool failed'); }));
    await act(async () => result.current.runDesktopUpdateAction(failure('update failed')));
    bridge.set('loginForgerAccount', failure());
    await act(async () => result.current.handleForgerLogin('user@example.com', 'secret'));
    bridge.set('registerForgerAccount', failure());
    expect(await result.current.handleForgerRegister({ email: 'user@example.com', password: 'secret', passwordConfirmation: 'secret' })).toBe(false);
    bridge.set('updateForgerAccountProfile', failure());
    expect(await result.current.handleForgerProfileUpdate({ username: 'user' })).toBe(false);

    await act(async () => result.current.copyErrorReportDetails());
    await act(async () => result.current.submitErrorReport());
    await act(async () => result.current.prepareConversationDiagnosticReport());
    await act(async () => result.current.copyConversationDiagnosticReport());
    await act(async () => result.current.submitConversationDiagnosticReport());
  });

  it('captures window errors and unhandled rejections while ignoring ResizeObserver noise', async () => {
    const bridge = installBridge({ prepareDesktopErrorReport: async (report: Record<string, unknown>) => report });
    await renderController(bridge);
    act(() => window.dispatchEvent(new ErrorEvent('error', { message: 'ResizeObserver loop limit exceeded' })));
    expect(bridge.call('prepareDesktopErrorReport')).not.toHaveBeenCalled();
    const rejection = new Event('unhandledrejection') as PromiseRejectionEvent;
    Object.defineProperty(rejection, 'reason', { value: new Error('Rejected') });
    act(() => window.dispatchEvent(rejection));
    act(() => window.dispatchEvent(new ErrorEvent('error', { message: 'Renderer exploded', filename: 'app.js', lineno: 10, colno: 2, error: new Error('Renderer exploded') })));
    await waitFor(() => expect(bridge.call('prepareDesktopErrorReport')).toHaveBeenCalled());
  });

  it('prepares exactly one report for each global renderer failure', async () => {
    const bridge = installBridge({ prepareDesktopErrorReport: async (report: Record<string, unknown>) => report });
    await renderController(bridge);
    act(() => window.dispatchEvent(new ErrorEvent('error', { message: 'Single renderer failure' })));
    await waitFor(() => expect(bridge.call('prepareDesktopErrorReport')).toHaveBeenCalledTimes(1));
  });

  it('hydrates persisted active runs and clears missing or failed run records', async () => {
    const conversation = { id: 'persisted-chat', appId: 'forger', mode: 'free_chat', targetAppId: null, title: 'Persisted', threadId: null, createdAt: '2026-08-10', updatedAt: '2026-08-10', messages: [] };
    chatPersistence.state = {
      conversations: [conversation], activeConversationByApp: { forger: 'persisted-chat' }, lastActiveConversationId: 'persisted-chat',
      activeRuns: [{ runId: 'persisted-run', conversationId: 'persisted-chat', appId: 'forger' }], draftInputByConversationId: {},
    };
    const missing = await renderController(installBridge({ chatGetRun: null }));
    await waitFor(() => expect(missing.result.current.activeConversationRunActive).toBe(false));
    missing.unmount();
    const failed = await renderController(installBridge({ chatGetRun: failure('unavailable') }));
    await waitFor(() => expect(failed.result.current.activeConversationRunActive).toBe(false));
  });

  it('hydrates valid and legacy pinned navigation state and toggles entries deterministically', async () => {
    window.localStorage.setItem('forger.sidebar.pinnedViews', JSON.stringify(['files', 'docs', 'unknown']));
    const valid = await renderController();
    expect(valid.result.current.pinnedViews).toEqual(['files', 'docs']);
    act(() => valid.result.current.togglePinnedView('files'));
    expect(valid.result.current.pinnedViews).toEqual(['docs']);
    act(() => valid.result.current.togglePinnedView('files'));
    expect(valid.result.current.pinnedViews).toContain('files');
    valid.unmount();

    window.localStorage.setItem('forger.sidebar.pinnedViews', '{broken');
    window.localStorage.setItem('forger.beta.advancedModeEnabled', 'true');
    const legacy = await renderController();
    expect(legacy.result.current.pinnedViews.length).toBeGreaterThan(0);
    expect(legacy.result.current.pinnedViews).not.toContain('docs');
  });

  it('reports a missing Electron bridge through its public accessor while trace diagnostics stay best effort', async () => {
    const bridge = installBridge();
    const { result } = await renderController(bridge);
    Object.defineProperty(window, 'forger', { configurable: true, value: undefined });
    expect(() => result.current.getDesktopApi()).toThrow('Bridge de Electron no disponible');
    act(() => result.current.handleStartNewConversation());
    expect(result.current.activeConversationId).not.toBeNull();
    Object.defineProperty(window, 'forger', { configurable: true, value: bridge.api });
  });

  it('maps every automation run state into one sorted background task and tolerates persistence failure', async () => {
    const automation = { id: 'automation-1', name: 'Daily', enabled: true, selectedAppIds: ['planner'], createdAt: '2026-08-10', updatedAt: '2026-08-11' };
    const bridge = installBridge({
      listInstalledApps: [{ id: 'planner', name: 'Planner', category: 'productivity', status: 'installed' }],
      backgroundTasksUpsert: () => Promise.reject(new Error('task persistence unavailable')),
    });
    const { result } = await renderController(bridge);
    act(() => bridge.emit('onAutomationUpdated', { automation }));
    for (const [index, status] of ['succeeded', 'failed', 'skipped', 'running', 'queued', 'canceled'].entries()) {
      const run = {
        id: `run-${status}`,
        automationId: automation.id,
        status,
        ...(status === 'failed' ? { error: 'automation_failed' } : {}),
        ...(status === 'running' ? { userMessage: 'Working' } : {}),
        startedAt: `2026-08-${10 + index}`,
        ...(status === 'succeeded' ? { finishedAt: '2026-08-20' } : {}),
        updatedAt: `2026-08-${10 + index}`,
      };
      act(() => bridge.emit('onAutomationUpdated', { automation, run }));
    }
    act(() => bridge.emit('onBackgroundTaskUpdated', { task: { id: 'automation:run-running', source: 'automation', title: 'Older', status: 'running', statusUpdates: [{ message: 'Working', status: 'running', createdAt: '2026-08-01' }], relatedEntity: { kind: 'automation-run', id: 'run-running' }, createdAt: '2026-08-01', updatedAt: '2026-08-01' } }));
    act(() => bridge.emit('onAutomationUpdated', { automation, run: { id: 'run-running', automationId: automation.id, status: 'running', userMessage: 'Working', startedAt: '2026-08-01', updatedAt: '2026-08-30' } }));
    await waitFor(() => expect(bridge.call('backgroundTasksUpsert')).toHaveBeenCalledTimes(7));
    expect(result.current.backgroundTasks[0]?.id).toBe('automation:run-running');
    expect(bridge.call('backgroundTasksUpsert').mock.calls.map(([input]) => input.status)).toEqual(expect.arrayContaining(['succeeded', 'failed', 'skipped', 'running', 'queued']));
  });

  it('builds complete and minimal personal-agent diagnostics without leaking system messages', async () => {
    const bridge = installBridge();
    const { result } = await renderController(bridge);
    const agent = { id: 'agent-1', name: 'Helper', description: 'Helps', runtime: { provider: 'claude', model: 'sonnet', effort: 'medium' } };
    const conversation = {
      id: 'personal-chat', title: '', providerThreadId: null, provider: 'codex', activeRun: undefined,
      messages: [
        { id: 'system', role: 'system', content: 'private', createdAt: '2026-08-10' },
        { id: 'user', role: 'user', content: 'Hello', createdAt: '2026-08-10' },
        { id: 'assistant', role: 'assistant', content: 'Hi', runId: 'run-1', createdAt: '2026-08-10' },
      ],
      createdAt: '2026-08-10', updatedAt: '2026-08-10',
    };
    const run = {
      id: 'run-1', status: 'failed', error: 'Provider timed out with private detail',
      progress: [{ id: 'progress-1', message: 'Connecting', createdAt: '2026-08-10' }],
      activity: { summary: 'Working' }, createdAt: '2026-08-10', updatedAt: '2026-08-10',
    };
    await act(async () => result.current.prepareConversationDiagnosticReport({ agent, conversation, run } as never));
    const complete = bridge.call('prepareConversationDiagnosticReport').mock.calls.at(-1)?.[0];
    expect(complete).toEqual(expect.objectContaining({
      source: 'personal_agent_conversation', title: 'Helper', provider: 'codex', technicalCode: 'personal_agent_run_failed',
    }));
    expect(complete.conversation.messages).toHaveLength(2);
    expect(complete.run.activity).toEqual({ summary: 'Working' });

    await act(async () => result.current.prepareConversationDiagnosticReport({
      agent: { id: 'agent-2', name: 'Minimal', description: '', runtime: undefined },
      conversation: { ...conversation, id: 'minimal-chat', title: 'Minimal', provider: undefined, messages: [], activeRun: { ...run, error: 'stable_error_code' } },
    } as never));
    expect(bridge.call('prepareConversationDiagnosticReport').mock.calls.at(-1)?.[0]).toEqual(expect.objectContaining({
      conversationId: 'minimal-chat', technicalCode: 'stable_error_code',
    }));
  });

  it('shows every remote-sharing outcome and handles portal and stop actions from the ready dialog', async () => {
    const bridge = installBridge({
      listInstalledApps: [{ id: 'planner', name: 'Planner', category: 'productivity', status: 'installed' }],
    });
    const { result } = await renderController(bridge);
    await act(async () => result.current.stopReadyRemoteTunnel());
    expect(result.current.remoteTunnelReadyDialog.open).toBe(false);

    for (const outcome of [
      { success: true },
      { success: true, status: { active: false, appId: 'planner', state: 'inactive' } },
      { success: true, status: { active: true, appId: 'planner', state: 'connected', frontendUrl: 'http://front' } },
      { success: true, status: { active: true, appId: 'planner', state: 'connected', portalUrl: 'http://portal' } },
      { success: true, status: { active: true, appId: 'planner', state: 'connected', tunnelUrl: 'http://tunnel' } },
      { success: false, technicalCode: 'remote_tunnel_not_supported' },
      { success: false, technicalCode: 'forger_cloud_required' },
      { success: false, technicalCode: 'app_not_running' },
      { success: false, status: { active: false, appId: 'planner', state: 'error' } },
      { success: false, technicalCode: 'remote_tunnel_prepare_failed' },
      { success: false, technicalCode: 'localtunnel_failed' },
      { success: false, technicalCode: 'unexpected' },
    ]) {
      bridge.set('startRemoteNetworkShare', outcome);
      await act(async () => result.current.handleStartRemoteNetworkShare('planner'));
    }
    expect(result.current.bannerSeverity).toBe('error');

    act(() => result.current.openRemoteTunnelPortal());
    expect(bridge.call('openExternalUrl')).toHaveBeenCalled();
    bridge.set('startRemoteNetworkShare', { success: true, status: { active: true, appId: 'planner', state: 'waiting_for_session', sessionId: 'stop-session' } });
    await act(async () => result.current.handleStartRemoteNetworkShare('planner'));
    bridge.set('stopRemoteNetworkShare', { success: false });
    await act(async () => result.current.stopReadyRemoteTunnel());
    expect(result.current.remoteTunnelReadyDialog.open).toBe(false);

    await act(async () => result.current.handleStopLocalNetworkShare());
    bridge.set('stopLocalNetworkShare', { success: false, userMessage: '' });
    bridge.set('startLocalNetworkShare', { success: false, userMessage: '' });
    await act(async () => result.current.handleStartLocalNetworkShare('planner'));
    await act(async () => result.current.handleStopLocalNetworkShare('planner'));
    expect(result.current.bannerSeverity).toBe('error');
  });

  it('resolves app metadata and covers non-success lifecycle results without throwing', async () => {
    const installed = { id: 'installed', name: 'Installed name', description: 'Local', category: 'productivity', status: 'installed', version: '1.0.0' };
    const catalog = { id: 'catalog', name: 'Catalog name', category: 'productivity' };
    const bridge = installBridge({ listInstalledApps: [installed], listCatalogApps: [catalog] });
    const { result } = await renderController(bridge);
    expect(result.current.getAppMeta('catalog').name).toBe('Catalog name');
    expect(result.current.getAppMeta('installed').name).toBe('Installed name');
    expect(result.current.getAppMeta('unknown').name).toBe('unknown');
    act(() => result.current.handleSelectChatApp('missing'));
    expect(result.current.selectedAppId).toBeNull();

    bridge.set('openApp', { success: false, userMessage: 'Could not open', technicalCode: 'open_failed' });
    await act(async () => result.current.handleOpen('installed'));
    bridge.set('stopApp', { success: false, userMessage: 'Could not stop' });
    await act(async () => result.current.handleStop('installed'));
    bridge.set('resolveAppUpdateConflict', { success: false, userMessage: 'Conflict remains' });
    await act(async () => result.current.handleResolveConflict('installed'));
    bridge.set('restoreAppUserVersion', { success: false });
    await act(async () => result.current.handleRestoreUserVersion('installed'));
    expect(result.current.bannerSeverity).toBe('error');

    Object.defineProperty(window, 'confirm', { configurable: true, value: vi.fn(() => false) });
    await act(async () => result.current.handleDeleteApp('installed'));
    expect(bridge.call('uninstallApp')).not.toHaveBeenCalled();
  });

  it('recovers every provider and account action when the bridge rejects', async () => {
    const bridge = installBridge();
    const { result } = await renderController(bridge);
    const reject = (name: string) => () => Promise.reject(new Error(`${name} rejected`));
    for (const [method, action] of [
      ['connectCodexAuth', () => result.current.handleConnectCodexAuth()],
      ['connectClaudeAuth', () => result.current.handleConnectClaudeAuth()],
      ['connectAntigravityAuth', () => result.current.handleConnectAntigravityAuth()],
      ['disconnectCodexAuth', () => result.current.handleDisconnectCodexAuth()],
      ['signOutClaudeAuth', () => result.current.handleDisconnectClaudeAuth()],
      ['signOutClaudeAuth', () => result.current.handleSignOutClaudeAuth()],
      ['disconnectAntigravityAuth', () => result.current.handleDisconnectAntigravityAuth()],
      ['reinstallCodex', () => result.current.handleReinstallCodex()],
      ['reinstallClaude', () => result.current.handleReinstallClaude()],
      ['reinstallAntigravity', () => result.current.handleReinstallAntigravity()],
      ['loginForgerAccountWithGoogle', () => result.current.handleForgerGoogleLogin()],
      ['loginForgerAccountWithApple', () => result.current.handleForgerAppleLogin()],
    ] as const) {
      bridge.set(method, reject(method));
      await act(async () => action());
      expect(result.current.bannerSeverity).toBe('error');
    }
    bridge.set('logoutForgerAccount', reject('logoutForgerAccount'));
    await expect(result.current.handleForgerLogout()).rejects.toThrow('logoutForgerAccount rejected');
    expect(result.current.forgerAccountBusy).toBe(false);
  });

  it('keeps failed desktop and conversation reports actionable, including expired cloud auth', async () => {
    const bridge = installBridge({ prepareDesktopErrorReport: async (report: Record<string, unknown>) => ({ ...report, diagnosticAttachmentToken: 'private' }) });
    const { result } = await renderController(bridge);
    act(() => bridge.emit('onDesktopErrorReportRequested', { source: 'desktop', operation: 'manual', occurredAt: '2026-08-10', message: 'Failure', technicalCode: 'manual_failure' }));
    act(() => result.current.closeErrorReportDialog());
    await waitFor(() => expect(result.current.errorReportDialog.busy).toBe(false));
    bridge.set('submitDesktopErrorReport', { success: false, userMessage: '' });
    await act(async () => result.current.submitErrorReport());
    expect(result.current.errorReportDialog.open).toBe(true);
    bridge.set('submitDesktopErrorReport', () => Promise.reject(new Error('offline')));
    await act(async () => result.current.submitErrorReport());

    await act(async () => result.current.prepareConversationDiagnosticReport({
      agent: { id: 'agent', name: 'Agent', description: '' },
      conversation: { id: 'conversation', title: 'Conversation', providerThreadId: null, messages: [], createdAt: '2026-08-10', updatedAt: '2026-08-10' },
    } as never));
    act(() => result.current.setConversationDiagnosticDescription('  details  '));
    bridge.set('submitConversationDiagnosticReport', { success: false, userMessage: '', technicalCode: 'forger_cloud_auth_expired' });
    await act(async () => result.current.submitConversationDiagnosticReport());
    expect(result.current.cloudModalOpen).toBe(true);
    bridge.set('submitConversationDiagnosticReport', () => Promise.reject(new Error('offline')));
    await act(async () => result.current.submitConversationDiagnosticReport());
    expect(result.current.conversationDiagnosticDialog.open).toBe(true);
  });
});
