import { act, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  controllerChatPersistence,
  controllerSettingsFixture,
  installControllerBridge,
  renderControllerHarness,
  resetControllerHarness,
} from './helpers/renderer-app-controller-harness';

beforeEach(resetControllerHarness);

const chatRun = (overrides: Record<string, unknown> = {}) => ({
  runId: 'run', appId: 'forger', conversationId: 'conversation', prompt: '', status: 'running',
  dangerMode: false, permissionMode: 'safe', ...overrides,
});

describe('RendererAppController remaining observable decision variants', () => {
  it('keeps the selected conversation while hydrating a free run with server timestamps absent', async () => {
    controllerChatPersistence.state = {
      conversations: [{ id: 'selected', appId: 'forger', mode: 'free_chat', targetAppId: null, title: 'Selected', threadId: null, createdAt: '2026-08-10', updatedAt: '2026-08-10', messages: [] }],
      activeConversationByApp: { forger: 'selected' }, lastActiveConversationId: 'selected', activeRuns: [], draftInputByConversationId: {},
    };
    const bridge = installControllerBridge();
    const { result } = await renderControllerHarness(bridge);

    act(() => bridge.emit('onChatRunUpdated', { run: chatRun({ runId: 'free-run', conversationId: 'free-live', createdAt: undefined, updatedAt: undefined }) }));

    expect(result.current.activeConversationId).toBe('selected');
    act(() => result.current.handleOpenConversation('free-live'));
    expect(result.current.activeConversation).toEqual(expect.objectContaining({
      appId: 'forger', mode: 'free_chat', targetAppId: null, threadId: null,
    }));

    act(() => bridge.emit('onChatRunUpdated', { run: chatRun({ runId: 'malformed', appId: '', conversationId: 'malformed' }) }));
    act(() => bridge.emit('onChatRunUpdated', { run: chatRun({ runId: 'free-run', conversationId: 'free-live', status: 'running' }) }));
  });

  it('deduplicates repeated permission, created-app, and remote-ready events and ignores orphan replies', async () => {
    const bridge = installControllerBridge();
    const { result } = await renderControllerHarness(bridge);
    const permissionRequest = { requestId: 'permission', pluginId: 'gmail', permission: 'send', reason: 'Send', risk: 'high', resource: 'mail' };
    const permission = chatRun({ runId: 'permission-run', conversationId: 'permission-chat', status: 'needs_permission', permissionRequest });
    act(() => bridge.emit('onChatRunUpdated', { run: permission }));
    act(() => bridge.emit('onChatRunUpdated', { run: permission }));
    expect(result.current.chatMessages.filter((message) => message.action?.type === 'permission')).toHaveLength(1);

    const completed = chatRun({ runId: 'created-run', conversationId: 'permission-chat', status: 'applied', userMessage: 'Created', createdApp: { appId: 'new-app', name: 'New app' } });
    act(() => bridge.emit('onChatRunUpdated', { run: completed }));
    act(() => bridge.emit('onChatRunUpdated', { run: completed }));

    act(() => result.current.handleDeleteConversation('permission-chat'));
    act(() => bridge.emit('onChatRunUpdated', { run: chatRun({ runId: 'orphan', conversationId: undefined, status: 'failed', userMessage: 'No target' }) }));

    const ready = { appId: 'planner', appName: 'Planner', state: 'ready', sessionId: undefined, frontendUrl: undefined, portalUrl: undefined, tunnelUrl: undefined };
    act(() => bridge.emit('onRemoteNetworkShareUpdated', { status: ready }));
    act(() => bridge.emit('onRemoteNetworkShareUpdated', { status: ready }));
  });

  it('persists false defaults for omitted Social grant drafts and accepts success without an installed app id', async () => {
    const gate = {
      appId: 'social-app', appName: 'Social', canInstall: true, platformCapabilities: {}, required: [],
      optional: [{ declaration: { toolId: 'gmail', actions: [], reason: 'Optional' }, required: false, resolvedActions: [], allActions: false, granted: false, hasStoredGrant: false, available: true, configured: true }],
      connectionRequired: [], agents: [], promptTemplates: [],
    };
    const bridge = installControllerBridge({
      getForgerAccount: { authenticated: true, user: { id: 1, email: 'user@example.com', confirmed: true } },
      listCatalogApps: [{ id: 'social-app', name: 'Social', category: 'productivity', socialUserAppId: 7 }],
      getAppToolsInstallGate: gate,
      installSocialApp: { success: true, userMessage: 'Already installed' },
    });
    const { result } = await renderControllerHarness(bridge);
    await waitFor(() => expect(result.current.forgerAccount.authenticated).toBe(true));
    await act(async () => result.current.handleInstall('social-app'));
    gate.optional.push({ declaration: { toolId: 'calendar', actions: [], reason: 'Added while reviewing' }, required: false, resolvedActions: [], allActions: false, granted: false, hasStoredGrant: false, available: true, configured: true });
    await act(async () => result.current.handleSocialInstallReviewDecision('skipped_review'));

    expect(bridge.call('setAppToolGrant')).toHaveBeenCalledWith(expect.objectContaining({ granted: false }), 'en');
    expect(bridge.call('installSocialApp')).toHaveBeenCalled();
  });

  it('keeps existing history when an authenticated Social review run fails with an Error', async () => {
    controllerChatPersistence.state = {
      conversations: [{ id: 'existing', appId: 'forger', mode: 'free_chat', targetAppId: null, title: 'Existing', threadId: null, createdAt: '2026-08-10', updatedAt: '2026-08-10', messages: [] }],
      activeConversationByApp: { forger: 'existing' }, lastActiveConversationId: 'existing', activeRuns: [], draftInputByConversationId: {},
    };
    const settings = controllerSettingsFixture();
    settings.activeProviderProfiles = { codex: 'work' };
    const bridge = installControllerBridge({
      getSettings: settings,
      getForgerAccount: { authenticated: true, user: { id: 1, email: 'user@example.com', confirmed: true } },
      getCodexAuthStatus: { installed: true, authenticated: true, authFilePath: '/tmp/auth', codexHome: '/tmp/codex' },
      listCatalogApps: [{ id: 'social-app', name: 'Social', category: 'productivity', socialUserAppId: 7 }],
      prepareSocialAppReview: { success: true, userMessage: 'Review ready', quarantine: { quarantineId: 'quarantine', name: 'Social', ownerUsername: 'alice', stagedDir: '/tmp/q' } },
      chatStartRun: () => Promise.reject(new Error('review agent failed')),
    });
    const { result } = await renderControllerHarness(bridge);
    await waitFor(() => expect(result.current.codexAuthStatus.authenticated).toBe(true));
    await act(async () => result.current.handleInstall('social-app', 'reviewed'));

    expect(result.current.chatHistoryItems.some((item) => item.id === 'existing')).toBe(true);
    expect(result.current.chatMessages.at(-1)?.content).toContain('review agent failed');
    expect(bridge.call('chatStartRun')).toHaveBeenCalledWith(expect.objectContaining({ authProfileId: 'work' }));
  });

  it('uses active profiles and Error diagnostics when a created app run cannot start', async () => {
    const settings = controllerSettingsFixture();
    settings.activeProviderProfiles = { codex: 'work' };
    const bridge = installControllerBridge({
      getSettings: settings,
      getCodexAuthStatus: { installed: true, authenticated: true, authFilePath: '/tmp/auth', codexHome: '/tmp/codex' },
      createLocalApp: { success: true, userMessage: 'Created', app: { appId: 'created', name: 'Created', description: '', purpose: '' } },
      chatStartRun: () => Promise.reject(new Error('create agent failed')),
    });
    const { result } = await renderControllerHarness(bridge);
    await waitFor(() => expect(result.current.codexAuthStatus.authenticated).toBe(true));
    await act(async () => result.current.handleCreateLocalApp({ name: 'Created', description: '', purpose: '' }));

    expect(bridge.call('chatStartRun')).toHaveBeenCalledWith(expect.objectContaining({ authProfileId: 'work' }));
    expect(result.current.chatMessages.at(-1)?.content).toContain('create agent failed');
  });

  it('maps fallback messages for failed public profile, rating, feedback, and prompt operations', async () => {
    const bridge = installControllerBridge({
      updateForgerAccountProfile: { success: false },
      submitAppRating: { success: false },
      submitProductFeedback: { success: false, technicalCode: 'permission_denied' },
      updateAppPrompt: { success: false },
      restoreAppPrompt: { success: false },
    });
    const { result } = await renderControllerHarness(bridge);

    await act(async () => result.current.handleForgerProfileUpdate({ displayName: 'User' }));
    expect(result.current.bannerSeverity).toBe('error');
    await act(async () => result.current.handleSubmitRating({ appId: 'planner', rating: 1 } as never));
    await act(async () => result.current.handleSubmitFeedback({ target: 'desktop', kind: 'bug', surface: 'settings' } as never));
    await act(async () => result.current.handleUpdateAppPrompt({ appId: 'planner', prompt: 'Prompt' } as never));
    await act(async () => result.current.handleRestoreAppPrompt({ appId: 'planner' } as never));

    expect(result.current.bannerSeverity).toBe('error');
    expect(bridge.call('prepareDesktopErrorReport')).not.toHaveBeenCalled();
  });

  it('uses empty diagnostic descriptions, blocks closure while preparing, and applies report fallbacks', async () => {
    controllerChatPersistence.state = {
      conversations: [{ id: 'chat', appId: 'forger', mode: 'free_chat', targetAppId: null, title: 'Chat', threadId: null, createdAt: '2026-08-10', updatedAt: '2026-08-10', messages: [] }],
      activeConversationByApp: { forger: 'chat' }, lastActiveConversationId: 'chat', activeRuns: [], draftInputByConversationId: {},
    };
    const preparing = Promise.withResolvers<Record<string, unknown>>();
    const bridge = installControllerBridge({
      prepareConversationDiagnosticReport: () => preparing.promise,
      submitConversationDiagnosticReport: { success: false, userMessage: 'Not sent', technicalCode: 'server_error' },
      submitDesktopErrorReport: { success: true, userMessage: '' },
    });
    const { result } = await renderControllerHarness(bridge);
    let pending!: Promise<void>;
    act(() => { pending = result.current.prepareConversationDiagnosticReport(); });
    await waitFor(() => expect(result.current.conversationDiagnosticDialog.busy).toBe(true));
    act(() => result.current.closeConversationDiagnosticDialog());
    expect(result.current.conversationDiagnosticDialog.open).toBe(true);
    preparing.resolve({ source: 'desktop_chat', occurredAt: '2026-08-10' });
    await act(async () => pending);
    await act(async () => result.current.copyConversationDiagnosticReport());
    await act(async () => result.current.submitConversationDiagnosticReport());
    expect(bridge.call('submitConversationDiagnosticReport')).toHaveBeenCalledWith(expect.objectContaining({ description: undefined }));
  });

  it('enables analytics and reports a non-Error forum failure without navigating', async () => {
    const bridge = installControllerBridge({
      getForgerAccount: { authenticated: true, user: { id: 1, email: 'user@example.com', confirmed: true } },
      updateForumParticipation: () => Promise.reject('forum unavailable'),
    });
    const { result } = await renderControllerHarness(bridge);
    await waitFor(() => expect(result.current.forgerAccount.authenticated).toBe(true));
    act(() => result.current.handleUsageAnalyticsChange(true));
    await act(async () => result.current.handleDismissForumPrompt());
    expect(result.current.currentView).not.toBe('friends');
    expect(result.current.bannerSeverity).toBe('error');
  });
});
