import { act, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  controllerChatPersistence,
  installControllerBridge,
  renderControllerHarness,
  resetControllerHarness,
} from './helpers/renderer-app-controller-harness';

beforeEach(resetControllerHarness);

describe('RendererAppController remaining public callback flows', () => {
  it('covers startup and listener callbacks for updates, account forum, automation sorting, and installed Social links', async () => {
    const social = {
      id: 7, slug: 'shared', name: 'Shared', visibility: 'public', status: 'published',
      owner: { id: 2, username: 'alice', displayName: 'Alice' }, reviewsCount: 0,
      latestVersion: { id: 1, version: '1.0.0', runtimeStack: 'vite-fastapi-sqlite', supportedPlatforms: [], capabilities: [], checksumSha256: 'x', fileSizeBytes: 1 },
    };
    const bridge = installControllerBridge({
      listInstalledApps: [{ id: 'social-alice-shared', name: 'Installed Shared', category: 'productivity', status: 'installed', version: '1.0.0' }],
      automationsList: [
        { id: 'older', name: 'Older', enabled: true, selectedAppIds: [], createdAt: '2026-08-01', updatedAt: '2026-08-01' },
        { id: 'newer', name: 'Newer', enabled: true, selectedAppIds: [], createdAt: '2026-08-02', updatedAt: '2026-08-02' },
      ],
      automationsListRuns: [],
      checkDesktopUpdates: () => Promise.reject(new Error('offline')),
      getForumParticipation: () => Promise.reject(new Error('forum offline')),
      resolveSocialApp: { app: social }, getAppToolsInstallGate: null,
    });
    const { result } = await renderControllerHarness(bridge);
    act(() => bridge.emit('onAutomationUpdated', { automation: { id: 'middle', name: 'Middle', enabled: true, selectedAppIds: [], createdAt: '2026-08-03', updatedAt: '2026-08-03' } }));
    expect(result.current.automations[0]?.id).toBe('middle');
    act(() => bridge.emit('onForgerAccountUpdated', { authenticated: true, user: { id: 1, email: 'user@example.com', confirmed: true } }));
    act(() => bridge.emit('onDeepLink', { kind: 'social-app', id: 7 }));
    await waitFor(() => expect(result.current.selectedAppDetails?.installed).toBe(true));
    expect(result.current.getCategoryLabel('productivity')).toBeTruthy();
  });

  it('uses fallback conversations and surfaces reactive installed-app secret and gate failures', async () => {
    controllerChatPersistence.state = {
      conversations: [
        { id: 'active', appId: 'forger', mode: 'free_chat', targetAppId: null, title: 'Active', threadId: null, createdAt: '2026-08-10', updatedAt: '2026-08-10', messages: [] },
        { id: 'fallback', appId: 'forger', mode: 'free_chat', targetAppId: null, title: 'Fallback', threadId: null, createdAt: '2026-08-09', updatedAt: '2026-08-09', messages: [] },
      ], activeConversationByApp: { forger: 'active' }, lastActiveConversationId: 'active', activeRuns: [], draftInputByConversationId: {},
    };
    const bridge = installControllerBridge({
      getAppDetails: { app: { id: 'planner', name: 'Planner', category: 'productivity', status: 'installed' }, installed: true, status: 'installed', operations: [] },
      getAppSecrets: () => Promise.reject(new Error('secret load failed')),
      getAppToolsInstallGate: () => Promise.reject(new Error('gate load failed')),
    });
    const { result } = await renderControllerHarness(bridge);
    act(() => result.current.handleDeleteConversation('active'));
    await waitFor(() => expect(result.current.activeConversationId).toBe('fallback'));
    await act(async () => result.current.openAppDetails('planner'));
    await waitFor(() => expect(result.current.bannerMessage).toBe('No pudimos cargar los secretos de esta app.'));
    expect(result.current.selectedAppToolGate).toBeNull();
  });

  it('reports failed catalog installation with installed-version context and catches a rejected install', async () => {
    const bridge = installControllerBridge({
      listInstalledApps: [{ id: 'planner', name: 'Planner', category: 'productivity', status: 'installed', version: '1.2.3' }],
      getAppToolsInstallGate: null,
      installApp: { success: false, userMessage: 'Install failed', technicalCode: 'install_failed' },
    });
    const { result } = await renderControllerHarness(bridge);
    await act(async () => result.current.handleInstall('planner'));
    expect(result.current.bannerSeverity).toBe('error');
    bridge.set('installApp', () => Promise.reject('install exploded'));
    await act(async () => result.current.handleRetry('planner'));
    expect(result.current.bannerSeverity).toBe('error');
  });

  it('starts created-app conversations with and without run failure and ignores concurrent creation', async () => {
    const bridge = installControllerBridge({
      getCodexAuthStatus: { installed: true, authenticated: true, authFilePath: '/tmp/auth', codexHome: '/tmp/codex' },
      createLocalApp: { success: true, userMessage: 'Created', app: { appId: 'created', name: 'Created', description: 'Description', purpose: 'Purpose', agentPrompt: 'Agent', lookAndFeel: 'Calm' } },
      chatStartRun: { runId: 'create-run', status: 'queued' },
    });
    const { result } = await renderControllerHarness(bridge);
    await waitFor(() => expect(result.current.codexAuthStatus.authenticated).toBe(true));
    await act(async () => result.current.handleCreateLocalApp({ name: 'Created', description: 'Description', purpose: 'Purpose', lookAndFeel: 'Calm' }));
    expect(bridge.call('chatStartRun')).toHaveBeenCalledWith(expect.objectContaining({ chatMode: 'edit_app', appId: 'created' }));

    bridge.set('createLocalApp', { success: true, userMessage: 'Created', app: { appId: 'failed', name: 'Failed', description: '', purpose: '' } });
    bridge.set('chatStartRun', () => Promise.reject('agent unavailable'));
    await act(async () => result.current.handleCreateLocalApp({ name: 'Failed', description: '', purpose: '' }));
    expect(result.current.chatMessages.at(-1)?.role).toBe('assistant');

    const pending = Promise.withResolvers<{ success: boolean; userMessage: string }>();
    bridge.set('createLocalApp', () => pending.promise);
    let creating!: Promise<void>;
    act(() => { creating = result.current.handleCreateLocalApp({ name: 'Pending', description: '', purpose: '' }); });
    await waitFor(() => expect(result.current.createLocalAppBusy).toBe(true));
    await act(async () => result.current.handleCreateLocalApp({ name: 'Ignored', description: '', purpose: '' }));
    pending.resolve({ success: false, userMessage: 'Stopped' });
    await act(async () => creating);
  });

  it('updates Social grant drafts, background navigation, friend windows, and rejected rename state', async () => {
    const bridge = installControllerBridge({
      openFriendChatWindow: undefined,
      listInstalledApps: [{ id: 'planner', name: 'Planner', category: 'productivity', status: 'installed' }],
      renameInstalledApp: () => Promise.reject('rename exploded'),
    });
    const { result } = await renderControllerHarness(bridge);
    act(() => result.current.handleSocialOptionalGrantDraftChange('tool:gmail', true));
    expect(result.current.socialInstallReviewDialog.grantDrafts).toEqual({ 'tool:gmail': true });
    act(() => result.current.setCurrentView('backgroundTasks'));
    act(() => result.current.openBackgroundTaskHistory());
    act(() => result.current.openBackgroundTaskDetail('task'));
    act(() => result.current.openBackgroundTaskHistory());
    await act(async () => result.current.handleOpenFriendChat({ id: 1, status: 'accepted' } as never));
    expect(bridge.call('openFriendChatWindow')).toHaveBeenCalled();
    act(() => result.current.handleRenameApp('planner'));
    act(() => result.current.setRenameAppName('New Planner'));
    await act(async () => result.current.submitRenameAppDialog());
    expect(result.current.renameAppDialog.busy).toBe(false);
  });

  it('falls back across multiple remaining conversations and covers new-conversation failure callbacks', async () => {
    controllerChatPersistence.state = {
      conversations: [
        { id: 'active', appId: 'forger', mode: 'free_chat', targetAppId: null, title: 'Active', threadId: null, createdAt: '2026-08-12', updatedAt: '2026-08-12', messages: [] },
        { id: 'middle', appId: 'forger', mode: 'free_chat', targetAppId: null, title: 'Middle', threadId: null, createdAt: '2026-08-11', updatedAt: '2026-08-11', messages: [] },
        { id: 'old', appId: 'forger', mode: 'free_chat', targetAppId: null, title: 'Old', threadId: null, createdAt: '2026-08-10', updatedAt: '2026-08-10', messages: [] },
      ], activeConversationByApp: { forger: 'active' }, lastActiveConversationId: 'active', activeRuns: [], draftInputByConversationId: {},
    };
    const sorted = await renderControllerHarness();
    act(() => sorted.result.current.handleDeleteConversation('active'));
    await waitFor(() => expect(sorted.result.current.activeConversationId).toBe('middle'));
    sorted.unmount();

    resetControllerHarness();
    controllerChatPersistence.state = {
      conversations: [{ id: 'other', appId: 'forger', mode: 'free_chat', targetAppId: null, title: 'Other', threadId: null, createdAt: '2026-08-01', updatedAt: '2026-08-01', messages: [] }],
      activeConversationByApp: {}, lastActiveConversationId: null, activeRuns: [], draftInputByConversationId: {},
    };
    const bridge = installControllerBridge({
      listInstalledApps: [{ id: 'planner', name: 'Planner', category: 'productivity', status: 'installed', version: '1.2.3' }],
      getCodexAuthStatus: { installed: true, authenticated: true, authFilePath: '/tmp/auth', codexHome: '/tmp/codex' },
      filesList: [], chatStartRun: () => Promise.reject(new Error('send failed')),
      chatApprovePermission: { success: false },
    });
    const { result } = await renderControllerHarness(bridge);
    await waitFor(() => expect(result.current.codexAuthStatus.authenticated).toBe(true));
    await act(async () => result.current.handleSendMessage('Hello', { mode: 'edit_app', targetAppId: 'planner' }));
    expect(result.current.activeConversation?.appId).toBe('planner');
    expect(result.current.chatMessages.at(-1)?.role).toBe('assistant');

    const permission = { requestId: 'permission', pluginId: 'gmail', permission: 'send', reason: 'Send', risk: 'high', resource: 'mail' };
    act(() => bridge.emit('onChatRunUpdated', { run: { runId: 'permission-run', appId: 'planner', conversationId: result.current.activeConversationId, prompt: '', status: 'needs_permission', permissionRequest: permission, createdAt: '2026-08-10', updatedAt: '2026-08-10', dangerMode: false, permissionMode: 'safe' } }));
    await act(async () => result.current.handleRespondPermission('permission-run', 'permission', 'deny'));
    expect(result.current.chatMessages.at(-1)?.action?.status).toBe('pending');

    const request = { requestId: 'question', chatId: result.current.activeConversationId!, createdAt: '2026-08-10', questions: [] };
    act(() => bridge.emit('onChatRunUpdated', { run: { runId: 'question-run', appId: 'planner', conversationId: request.chatId, prompt: '', status: 'applied', questionRequest: request, createdAt: '2026-08-10', updatedAt: '2026-08-10', dangerMode: false, permissionMode: 'safe' } }));
    bridge.set('chatStartRun', () => Promise.reject(new Error('question failed')));
    await act(async () => result.current.handleRespondQuestion('question-run', request, { answers: [] }));
    expect(result.current.chatMessages.some((message) => message.action?.type === 'question' && message.action.status === 'pending')).toBe(true);

    await act(async () => result.current.prepareConversationDiagnosticReport());
    expect(bridge.call('prepareConversationDiagnosticReport')).toHaveBeenCalledWith(expect.objectContaining({
      appId: 'planner', conversation: expect.objectContaining({ messages: expect.any(Array) }),
    }));
  });

  it('creates the first conversation from an empty history before starting its run', async () => {
    const bridge = installControllerBridge({
      getCodexAuthStatus: { installed: true, authenticated: true, authFilePath: '/tmp/auth', codexHome: '/tmp/codex' },
      filesList: [],
      chatStartRun: { runId: 'first-run', status: 'queued' },
    });
    const { result } = await renderControllerHarness(bridge);
    await waitFor(() => expect(result.current.codexAuthStatus.authenticated).toBe(true));

    await act(async () => result.current.handleSendMessage('My first message', { mode: 'free_chat' }));

    expect(result.current.activeConversation).toEqual(expect.objectContaining({
      appId: 'forger',
      mode: 'free_chat',
      targetAppId: null,
      title: 'My first message',
    }));
    expect(bridge.call('chatStartRun')).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: result.current.activeConversationId,
      prompt: 'My first message',
    }));
  });

  it('preserves non-target conversations when starting a run fails', async () => {
    controllerChatPersistence.state = {
      conversations: [
        { id: 'target', appId: 'forger', mode: 'free_chat', targetAppId: null, title: 'Target', threadId: null, createdAt: '2026-08-10', updatedAt: '2026-08-10', messages: [] },
        { id: 'other', appId: 'forger', mode: 'free_chat', targetAppId: null, title: 'Other', threadId: null, createdAt: '2026-08-09', updatedAt: '2026-08-09', messages: [{ id: 'kept', role: 'assistant', content: 'Keep me' }] },
      ],
      activeConversationByApp: { forger: 'target' }, lastActiveConversationId: 'target', activeRuns: [], draftInputByConversationId: {},
    };
    const bridge = installControllerBridge({
      getCodexAuthStatus: { installed: true, authenticated: true, authFilePath: '/tmp/auth', codexHome: '/tmp/codex' },
      filesList: [],
      chatStartRun: () => Promise.reject(new Error('run unavailable')),
    });
    const { result } = await renderControllerHarness(bridge);
    await waitFor(() => expect(result.current.codexAuthStatus.authenticated).toBe(true));

    await act(async () => result.current.handleSendMessage('Try it'));

    act(() => result.current.handleOpenConversation('other'));
    expect(result.current.chatMessages).toEqual([
      expect.objectContaining({ id: 'kept', content: 'Keep me' }),
    ]);
    act(() => result.current.handleOpenConversation('target'));
    expect(result.current.chatMessages.at(-1)?.content).toContain('run unavailable');
  });

  it('submits skipped review from the dialog and restores it when optional grant persistence fails', async () => {
    const gate = {
      appId: 'social-app', appName: 'Social', canInstall: true, platformCapabilities: {}, required: [],
      optional: [{ declaration: { toolId: 'gmail', actions: [], reason: 'Optional' }, required: false, resolvedActions: [], allActions: false, granted: false, hasStoredGrant: false, available: true, configured: true }],
      connectionRequired: [], connectionOptional: [], agents: [], promptTemplates: [],
    };
    const bridge = installControllerBridge({
      getForgerAccount: { authenticated: true, user: { id: 1, email: 'user@example.com', confirmed: true } },
      listCatalogApps: [{ id: 'social-app', name: 'Social', category: 'productivity', socialUserAppId: 7 }],
      getAppToolsInstallGate: gate, setAppToolGrant: gate,
      installSocialApp: { success: true, userMessage: 'Installed', appId: 'social-app' },
    });
    const { result } = await renderControllerHarness(bridge);
    await act(async () => result.current.handleInstall('social-app'));
    await act(async () => result.current.handleSocialInstallReviewDecision('skipped_review'));
    expect(result.current.socialInstallReviewDialog.open).toBe(false);

    await act(async () => result.current.handleInstall('social-app'));
    bridge.set('setAppToolGrant', () => Promise.reject(new Error('grant rejected')));
    await act(async () => result.current.handleSocialInstallReviewDecision('reviewed'));
    expect(result.current.socialInstallReviewDialog.busy).toBe(false);
    expect(result.current.bannerSeverity).toBe('error');
  });

  it('cancels each active authentication attempt and tolerates polling failures', async () => {
    for (const scenario of [
      { connect: 'connectCodexAuth', status: 'getCodexAuthStatus', action: 'handleConnectCodexAuth', close: 'closeCodexConfig' },
      { connect: 'connectClaudeAuth', status: 'getClaudeAuthStatus', action: 'handleConnectClaudeAuth', close: 'closeClaudeConfig' },
      { connect: 'connectAntigravityAuth', status: 'getAntigravityAuthStatus', action: 'handleConnectAntigravityAuth', close: 'closeAntigravityConfig' },
    ] as const) {
      resetControllerHarness();
      const pending = Promise.withResolvers<{ success: boolean; userMessage: string }>();
      const bridge = installControllerBridge({
        [scenario.connect]: () => pending.promise,
        [scenario.status]: () => Promise.reject(new Error('status unavailable')),
      });
      const current = await renderControllerHarness(bridge);
      let connecting!: Promise<void>;
      act(() => { connecting = current.result.current[scenario.action](); });
      await waitFor(() => expect(current.result.current[`${scenario.connect.replace('connect', '').replace('Auth', '').toLowerCase()}AuthBusy`] ?? true).toBeTruthy());
      act(() => current.result.current[scenario.close]());
      pending.resolve({ success: true, userMessage: 'Started' });
      await act(async () => connecting);
      current.unmount();
    }
  });
});
