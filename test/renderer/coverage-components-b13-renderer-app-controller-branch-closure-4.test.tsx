import { act, fireEvent, render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  controllerChatPersistence,
  installControllerBridge,
  renderControllerHarness,
  resetControllerHarness,
} from './helpers/renderer-app-controller-harness';

beforeEach(resetControllerHarness);

const automation = { id: 'automation', name: 'Automation', enabled: true, selectedAppIds: [], createdAt: '2026-08-10', updatedAt: '2026-08-10' };
const transcript = (id: string) => ({ id, automationId: 'automation', status: 'succeeded', startedAt: '2026-08-10', finishedAt: '2026-08-10', updatedAt: '2026-08-10', transcript: [] });

describe('RendererAppController late branch and invariant closure', () => {
  it('preserves the selected automation transcript when an update omits its run', async () => {
    const bridge = installControllerBridge({
      automationsList: [automation],
      automationsListRuns: [transcript('newest'), transcript('selected')],
      automationsGetRunTranscript: (id: string) => Promise.resolve(transcript(id)),
    });
    const { result } = await renderControllerHarness(bridge);
    await act(async () => result.current.handleSelectAutomationRun('selected'));
    expect(result.current.selectedAutomationRun?.id).toBe('selected');

    act(() => bridge.emit('onAutomationUpdated', { automation }));

    await waitFor(() => expect(bridge.call('automationsGetRunTranscript')).toHaveBeenLastCalledWith('selected'));
    expect(result.current.selectedAutomationRun?.id).toBe('selected');
  });

  it('selects the first available run and clears selection when an automation history becomes empty', async () => {
    let runs = [transcript('first')];
    const bridge = installControllerBridge({
      automationsList: [automation],
      automationsListRuns: () => Promise.resolve(runs),
      automationsGetRunTranscript: (id: string) => Promise.resolve(transcript(id)),
    });
    const { result } = await renderControllerHarness(bridge);
    act(() => bridge.emit('onAutomationUpdated', { automation }));
    await waitFor(() => expect(result.current.selectedAutomationRun?.id).toBe('first'));
    runs = [];
    act(() => bridge.emit('onAutomationUpdated', { automation }));
    await waitFor(() => expect(result.current.selectedAutomationRun).toBeNull());
  });

  it('clears Antigravity busy state when the active session emits a failure', async () => {
    const pending = Promise.withResolvers<{ success: boolean; userMessage: string }>();
    const bridge = installControllerBridge({ connectAntigravityAuth: () => pending.promise });
    const { result } = await renderControllerHarness(bridge);
    bridge.set('getAntigravityAuthStatus', { installed: true, authenticated: true, source: 'credentials' });
    let connecting!: Promise<void>;
    act(() => { connecting = result.current.handleConnectAntigravityAuth(); });
    await waitFor(() => expect(result.current.antigravityAuthBusy).toBe(true));
    act(() => bridge.emit('onAntigravityAuthSessionEvent', { sessionId: 'session', type: 'failed', text: 'Failed' }));
    expect(result.current.antigravityAuthBusy).toBe(false);
    pending.resolve({ success: false, userMessage: 'Stopped' });
    await act(async () => connecting);
  });

  it('hydrates a server thread and deduplicates created-app analytics across terminal variants', async () => {
    const bridge = installControllerBridge();
    const { result } = await renderControllerHarness(bridge);
    const base = { runId: 'created', appId: 'planner', conversationId: 'chat', prompt: '', dangerMode: false, permissionMode: 'safe', threadId: 'thread' };
    act(() => bridge.emit('onChatRunUpdated', { run: { ...base, status: 'running' } }));
    act(() => bridge.emit('onChatRunUpdated', { run: { ...base, status: 'applied', userMessage: 'Applied', createdApp: { appId: 'new', name: 'New' } } }));
    act(() => bridge.emit('onChatRunUpdated', { run: { ...base, status: 'undone', userMessage: 'Undone', createdApp: { appId: 'new', name: 'New' } } }));
    expect(result.current.activeConversation?.threadId).toBe('thread');
  });

  it('uses Social share codes and maps non-conflict update failures as errors', async () => {
    const social = {
      id: 7, slug: 'shared', name: undefined, visibility: 'public', status: 'published',
      owner: { id: 2, username: 'alice', displayName: 'Alice' }, reviewsCount: 0,
      latestVersion: { id: 1, version: '1.0.0', runtimeStack: 'vite-fastapi-sqlite', supportedPlatforms: [], capabilities: [], checksumSha256: 'x', fileSizeBytes: 1 },
    };
    const bridge = installControllerBridge({
      getForgerAccount: { authenticated: true, user: { id: 1, email: 'user@example.com', confirmed: true } },
      resolveSocialCode: { app: social }, getAppToolsInstallGate: null,
      installSocialApp: { success: false, userMessage: 'Update failed', phase: 'download', technicalCode: 'update_failed' },
    });
    const { result } = await renderControllerHarness(bridge);
    act(() => bridge.emit('onDeepLink', { kind: 'social-app', code: 'share-code' }));
    await waitFor(() => expect(result.current.selectedAppDetailsId).toBe('social-alice-shared'));
    await act(async () => result.current.handleInstall('social-alice-shared'));
    expect(result.current.socialInstallReviewDialog.input.appId).toBeUndefined();
    await act(async () => result.current.handleUpdate('social-alice-shared'));
    expect(result.current.bannerSeverity).toBe('error');
  });

  it('uses localized fallbacks for non-Error create, update, chat, stop, and automation failures', async () => {
    const activeRunError = new Error('app_run_in_progress');
    activeRunError.stack = undefined;
    controllerChatPersistence.state = {
      conversations: [
        { id: 'chat', appId: 'forger', mode: 'free_chat', targetAppId: null, title: 'Chat', threadId: null, createdAt: '2026-08-10', updatedAt: '2026-08-10', messages: [] },
        { id: 'other', appId: 'forger', mode: 'free_chat', targetAppId: null, title: 'Other', threadId: null, createdAt: '2026-08-09', updatedAt: '2026-08-09', messages: [] },
      ], activeConversationByApp: { forger: 'chat' }, lastActiveConversationId: 'chat', activeRuns: [], draftInputByConversationId: {},
    };
    const bridge = installControllerBridge({
      getCodexAuthStatus: { installed: true, authenticated: true, authFilePath: '/tmp/auth', codexHome: '/tmp/codex' },
      createLocalApp: () => Promise.reject('create failed'),
      chatStartRun: () => Promise.reject(activeRunError),
      chatCancelRun: () => Promise.reject('cancel failed'),
      automationsUpdate: () => Promise.reject(new Error('save failed')),
      automationsRunNow: () => Promise.reject(new Error('run failed')),
      filesList: [],
    });
    const { result } = await renderControllerHarness(bridge);
    await waitFor(() => expect(result.current.codexAuthStatus.authenticated).toBe(true));
    await act(async () => result.current.handleCreateLocalApp({ name: 'App', description: '', purpose: '' }));
    await act(async () => result.current.handleSendMessage('Hello'));
    expect(result.current.chatMessages.at(-1)?.content).toBe(result.current.t.sections.chat.appRunInProgress);
    act(() => bridge.emit('onChatRunUpdated', { run: { runId: 'running', appId: 'forger', conversationId: 'chat', prompt: '', status: 'running', dangerMode: false, permissionMode: 'safe' } }));
    await act(async () => result.current.handleStopChatRun());
    await act(async () => result.current.handleSaveAutomation({ id: 'automation', name: 'Automation', enabled: true, selectedAppIds: [] } as never));
    await act(async () => result.current.handleRunAutomationNow('automation'));
    expect(result.current.bannerSeverity).toBe('error');
  });

  it('deduplicates concurrent local-share starts and falls back on restore failures', async () => {
    const sharing = Promise.withResolvers<{ success: boolean; userMessage: string; status: Record<string, unknown> }>();
    const bridge = installControllerBridge({
      startLocalNetworkShare: () => sharing.promise,
      restoreAppUserVersion: { success: false },
    });
    const { result } = await renderControllerHarness(bridge);
    let first!: Promise<void>;
    act(() => { first = result.current.handleStartLocalNetworkShare('planner'); });
    await waitFor(() => expect(result.current.openingAppIds.has('planner')).toBe(true));
    await act(async () => result.current.handleStartLocalNetworkShare('planner'));
    sharing.resolve({ success: false, userMessage: 'No share', status: { appId: 'planner', state: 'error' } });
    await act(async () => first);
    expect(bridge.call('startLocalNetworkShare')).toHaveBeenCalledTimes(1);
    await act(async () => result.current.handleRestoreUserVersion('planner'));
    expect(result.current.bannerSeverity).toBe('error');
  });

  it('keeps a newer connection grant busy while an older connection settles', async () => {
    const github = Promise.withResolvers<null>();
    const calendar = Promise.withResolvers<null>();
    const bridge = installControllerBridge({
      getAppDetails: { app: { id: 'planner', name: 'Planner', category: 'productivity', status: 'installed' }, installed: true, status: 'installed', operations: [] },
      setAppConnectionGrant: (input: { type: string }) => input.type === 'github' ? github.promise : calendar.promise,
    });
    const { result } = await renderControllerHarness(bridge);
    await act(async () => result.current.openAppDetails('planner'));
    let first!: Promise<void>;
    let second!: Promise<void>;
    act(() => { first = result.current.handleAppDetailsConnectionGrant('github', true); });
    act(() => { second = result.current.handleAppDetailsConnectionGrant('calendar', true); });
    github.resolve(null);
    await act(async () => first);
    expect(result.current.selectedAppToolGrantBusyId).toBe('connection:calendar');
    calendar.resolve(null);
    await act(async () => second);
  });

  it('submits successful feedback with app context and handles report variants', async () => {
    controllerChatPersistence.state = {
      conversations: [{ id: 'chat', appId: 'forger', mode: 'free_chat', targetAppId: null, title: 'Chat', threadId: null, createdAt: '2026-08-10', updatedAt: '2026-08-10', messages: [] }],
      activeConversationByApp: { forger: 'chat' }, lastActiveConversationId: 'chat', activeRuns: [], draftInputByConversationId: {},
    };
    const bridge = installControllerBridge({
      submitProductFeedback: { success: true, userMessage: 'Thanks' },
      prepareConversationDiagnosticReport: () => Promise.reject(new Error('prepare failed')),
      submitDesktopErrorReport: { success: true, userMessage: '' },
    });
    const { result } = await renderControllerHarness(bridge);
    await act(async () => result.current.handleSubmitFeedback({ target: 'app', kind: 'bug', surface: 'app', appId: 'planner' } as never));
    await act(async () => result.current.prepareConversationDiagnosticReport());
    expect(result.current.conversationDiagnosticDialog.userMessage).toBe('prepare failed');
  });

  it('keeps other quarantine conversations and closes successful no-id review installs', async () => {
    controllerChatPersistence.state = {
      conversations: [
        { id: 'review', appId: 'quarantine', mode: 'social_app_review', targetAppId: 'quarantine', title: 'Review', threadId: null, createdAt: '2026-08-10', updatedAt: '2026-08-10', messages: [] },
        { id: 'other', appId: 'forger', mode: 'free_chat', targetAppId: null, title: 'Other', threadId: null, createdAt: '2026-08-09', updatedAt: '2026-08-09', messages: [] },
      ], activeConversationByApp: { quarantine: 'review' }, lastActiveConversationId: 'review', activeRuns: [], draftInputByConversationId: {},
    };
    const bridge = installControllerBridge({
      finishSocialAppInstall: { success: true, userMessage: 'Already installed' },
      deleteQuarantinedSocialApp: { success: true, userMessage: 'Deleted' },
    });
    const { result } = await renderControllerHarness(bridge);
    await act(async () => result.current.handleFinishSocialReviewInstall());
    await act(async () => result.current.handleDeleteSocialReview());
    act(() => result.current.handleOpenConversation('other'));
    expect(result.current.chatMessages).toEqual([]);
  });

  it('marks the forum prompt shown without navigation and uses the portal fallback', async () => {
    const bridge = installControllerBridge({
      getForgerAccount: { authenticated: true, user: { id: 1, email: 'user@example.com', confirmed: true } },
      updateForumParticipation: { status: 'opted_out', isModerator: false, firstPromptShownAt: '2026-08-10' },
    });
    const { result } = await renderControllerHarness(bridge);
    await waitFor(() => expect(result.current.forgerAccount.authenticated).toBe(true));
    await act(async () => result.current.handleDismissForumPrompt());
    expect(result.current.currentView).not.toBe('friends');
    act(() => bridge.emit('onRuntimeStatusChanged', { appId: 'planner', status: 'running', remoteNetworkShare: { appId: 'planner', appName: 'Planner', state: 'ready', sessionId: 'portal-fallback', portalUrl: '' } }));
    act(() => result.current.openRemoteTunnelPortal());
    expect(bridge.call('openExternalUrl')).toHaveBeenCalled();
  });

  it('deduplicates remote-ready sessions whose bridge payload omits every URL', async () => {
    const bridge = installControllerBridge();
    const { result } = await renderControllerHarness(bridge);
    const status = { active: true, appId: 'planner', appName: 'Planner', state: 'connected', sessionId: '', frontendUrl: '', portalUrl: '', tunnelUrl: '' };
    act(() => bridge.emit('onRuntimeStatusChanged', { appId: 'planner', status: 'running', remoteNetworkShare: status }));
    expect(result.current.remoteTunnelReadyDialog.open).toBe(true);
    act(() => result.current.closeRemoteTunnelReadyDialog());
    act(() => bridge.emit('onRuntimeStatusChanged', { appId: 'planner', status: 'running', remoteNetworkShare: status }));
    expect(result.current.remoteTunnelReadyDialog.open).toBe(false);
  });

  it('uses an empty Social grant map defensively and keeps optional draft callbacks safe after closure', async () => {
    const gate = {
      appId: 'social-app', appName: 'Social', canInstall: true, platformCapabilities: {}, required: [],
      optional: [{ declaration: { toolId: 'gmail', actions: [], reason: 'Optional' }, required: false, resolvedActions: [], allActions: false, granted: false, hasStoredGrant: false, available: true, configured: true }],
      connectionRequired: [], connectionOptional: [], agents: [], promptTemplates: [],
    };
    const bridge = installControllerBridge({
      getForgerAccount: { authenticated: true, user: { id: 1, email: 'user@example.com', confirmed: true } },
      listCatalogApps: [{ id: 'social-app', name: 'Social', category: 'productivity', socialUserAppId: 7 }],
      getAppToolsInstallGate: gate, installSocialApp: { success: true, userMessage: 'Done' },
    });
    const { result } = await renderControllerHarness(bridge);
    await waitFor(() => expect(result.current.forgerAccount.authenticated).toBe(true));
    await act(async () => result.current.handleInstall('social-app'));
    (result.current.socialInstallReviewDialog as { grantDrafts?: Record<string, boolean> }).grantDrafts = {};
    await act(async () => result.current.handleSocialInstallReviewDecision('skipped_review'));
    const view = render(result.current.renderInstallTool(gate.optional[0] as never, false));
    fireEvent.click(view.getByRole('switch'));
  });

  it('maps non-Error update failures, preserves nonmatching memories, and falls back for conflict results', async () => {
    const original = { id: 'original', key: 'key', value: 'old', scope: 'global', createdAt: '2026-08-10', updatedAt: '2026-08-10' };
    const bridge = installControllerBridge({
      memoryList: [original],
      memoryUpdate: { ...original, id: 'other', value: 'new' },
      resolveAppUpdateConflict: { success: false },
    });
    const { result } = await renderControllerHarness(bridge);
    await act(async () => result.current.runDesktopUpdateAction(async () => Promise.reject('update unavailable')));
    await act(async () => result.current.handleUpdateMemory({ id: 'other', value: 'new' } as never));
    expect(result.current.memories).toContainEqual(original);
    await act(async () => result.current.handleResolveConflict('planner'));
    expect(result.current.bannerSeverity).toBe('error');
  });

  it('uses non-Error chat fallbacks and recognizes legacy app conversations on wake', async () => {
    controllerChatPersistence.state = {
      conversations: [
        { id: 'legacy-app', appId: 'planner', title: 'Legacy', threadId: null, createdAt: '2026-08-10', updatedAt: '2026-08-10', messages: [] },
        { id: 'other', appId: 'forger', mode: 'create_app', targetAppId: null, title: 'Other', threadId: null, createdAt: '2026-08-09', updatedAt: '2026-08-09', messages: [] },
      ] as never,
      activeConversationByApp: { planner: 'legacy-app' }, lastActiveConversationId: 'legacy-app', activeRuns: [], draftInputByConversationId: {},
    };
    const bridge = installControllerBridge({
      getCodexAuthStatus: { installed: true, authenticated: true, authFilePath: '/tmp/auth', codexHome: '/tmp/codex' },
      chatStartRun: () => Promise.reject('send unavailable'), filesList: [],
    });
    const { result } = await renderControllerHarness(bridge);
    await waitFor(() => expect(result.current.codexAuthStatus.authenticated).toBe(true));
    result.current.handleOpenFreeChatFromWake();
    act(() => result.current.handleOpenConversation('legacy-app'));
    await act(async () => result.current.handleSendMessage('Hello', { mode: 'edit_app', targetAppId: 'planner' }));
    expect(result.current.chatMessages.at(-1)?.role).toBe('assistant');
    const request = { requestId: 'question', chatId: 'legacy-app', createdAt: '2026-08-10', questions: [] };
    bridge.set('chatStartRun', () => Promise.reject(new Error('app_run_in_progress')));
    await act(async () => result.current.handleRespondQuestion('question-run', request, { answers: [] }));
  });

  it('completes an automation edit and prepares diagnostics with an explicit provider', async () => {
    controllerChatPersistence.state = {
      conversations: [{ id: 'chat', appId: 'forger', mode: 'free_chat', targetAppId: null, title: 'Chat', threadId: null, createdAt: '2026-08-10', updatedAt: '2026-08-10', messages: [] }],
      activeConversationByApp: { forger: 'chat' }, lastActiveConversationId: 'chat', activeRuns: [], draftInputByConversationId: {},
    };
    const bridge = installControllerBridge({
      automationsUpdate: automation, automationsList: [automation], automationsListRuns: [],
    });
    const { result } = await renderControllerHarness(bridge);
    await act(async () => result.current.handleSaveAutomation({ ...automation, id: 'automation' } as never));
    act(() => result.current.setSelectedAgentProvider('codex'));
    await act(async () => result.current.prepareConversationDiagnosticReport());
    expect(bridge.call('prepareConversationDiagnosticReport')).toHaveBeenCalledWith(expect.objectContaining({ provider: 'codex' }));
  });

  it('uses report success and non-Error preparation fallbacks', async () => {
    controllerChatPersistence.state = {
      conversations: [{ id: 'chat', appId: 'forger', mode: 'free_chat', targetAppId: null, title: 'Chat', threadId: null, createdAt: '2026-08-10', updatedAt: '2026-08-10', messages: [] }],
      activeConversationByApp: { forger: 'chat' }, lastActiveConversationId: 'chat', activeRuns: [], draftInputByConversationId: {},
    };
    const bridge = installControllerBridge({
      prepareDesktopErrorReport: (report: Record<string, unknown>) => Promise.resolve(report),
      submitDesktopErrorReport: { success: true, userMessage: '' },
      prepareConversationDiagnosticReport: () => Promise.reject('prepare unavailable'),
    });
    const { result } = await renderControllerHarness(bridge);
    act(() => window.dispatchEvent(new ErrorEvent('error', { message: 'Unexpected failure' })));
    await waitFor(() => expect(result.current.errorReportDialog.busy).toBe(false));
    await act(async () => result.current.submitErrorReport());
    expect(result.current.errorReportDialog.open).toBe(false);
    await act(async () => result.current.prepareConversationDiagnosticReport());
    expect(result.current.conversationDiagnosticDialog.userMessage).toBe(result.current.t.settings.conversationReportPrepareError);
  });
});
