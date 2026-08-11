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

describe('RendererAppController fallback branch sweep', () => {
  it('migrates non-array pinned state, uses storage defaults, switches locale, and slugifies an empty Social name', async () => {
    window.localStorage.setItem('forger.sidebar.pinnedViews', JSON.stringify({ files: true }));
    controllerChatPersistence.state = {
      conversations: [], activeConversationByApp: {}, lastActiveConversationId: null, activeRuns: [],
      draftInputByConversationId: undefined as never,
    };
    const settings = controllerSettingsFixture();
    settings.defaultChatPermissionMode = undefined as never;
    settings.defaultChatNetworkAccess = undefined as never;
    const bridge = installControllerBridge({
      getSettings: settings,
      listInstalledApps: [{ id: 'local', name: '!!!', category: 'productivity', status: 'installed' }],
    });
    const { result } = await renderControllerHarness(bridge);
    expect(result.current.pinnedViews).toEqual([]);
    act(() => result.current.setLanguagePreference('system'));
    expect(result.current.activeLocale).toBe('en');
    act(() => result.current.setLanguagePreference('es'));
    expect(result.current.activeLocale).toBe('es');
    act(() => result.current.handleUploadSocial('local'));
    expect(result.current.socialUploadDialog.slug).toBe('social-app');
  });

  it('builds provider-only and nonfailed personal-agent diagnostics and preserves a locked Claude runtime', async () => {
    controllerChatPersistence.state = {
      conversations: [{
        id: 'claude-chat', appId: 'forger', mode: 'free_chat', targetAppId: null, title: 'Claude', threadId: null,
        runtime: { provider: 'claude', model: 'sonnet', effort: 'low' },
        createdAt: '2026-08-10', updatedAt: '2026-08-10', messages: [],
      }], activeConversationByApp: { forger: 'claude-chat' }, lastActiveConversationId: 'claude-chat', activeRuns: [], draftInputByConversationId: {},
    };
    const bridge = installControllerBridge({
      getClaudeAuthStatus: { installed: true, authenticated: true, source: 'credentials' },
      filesList: [], chatStartRun: { runId: 'claude-run', status: 'queued' },
    });
    const { result } = await renderControllerHarness(bridge);
    await act(async () => result.current.prepareConversationDiagnosticReport({
      agent: { id: 'agent', name: 'Agent', description: '' },
      conversation: {
        id: 'personal', title: 'Personal', provider: 'antigravity', providerThreadId: 'thread', messages: [],
        activeRun: { id: 'active-run', status: 'running', progress: [], createdAt: '2026-08-10', updatedAt: '2026-08-10' },
        createdAt: '2026-08-10', updatedAt: '2026-08-10',
      },
    } as never));
    expect(bridge.call('prepareConversationDiagnosticReport')).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'antigravity', conversation: expect.objectContaining({ runtime: { provider: 'antigravity' } }),
      run: expect.not.objectContaining({ error: expect.anything(), activity: expect.anything() }),
    }));
    await act(async () => result.current.handleSendMessage('Continue'));
    expect(bridge.call('chatStartRun')).toHaveBeenCalledWith(expect.objectContaining({ provider: 'claude', model: 'sonnet' }));
  });

  it('keeps the newer report when an older preparation rejects and suppresses expected technical errors', async () => {
    const old = Promise.withResolvers<Record<string, unknown>>();
    let calls = 0;
    const bridge = installControllerBridge({
      prepareDesktopErrorReport: (report: Record<string, unknown>) => ++calls === 1 ? old.promise : Promise.resolve(report),
      openApp: { success: false, userMessage: 'Not allowed', technicalCode: 'permission_denied' },
    });
    const { result } = await renderControllerHarness(bridge);
    act(() => bridge.emit('onDesktopErrorReportRequested', { source: 'desktop', operation: 'old', occurredAt: 'old', message: 'Old', technicalCode: 'old_failure' }));
    act(() => bridge.emit('onDesktopErrorReportRequested', { source: 'desktop', operation: 'new', occurredAt: 'new', message: 'New', technicalCode: 'new_failure' }));
    await waitFor(() => expect(result.current.errorReportDialog.report?.occurredAt).toBe('new'));
    old.reject(new Error('old failed'));
    await act(async () => { await old.promise.catch(() => undefined); });
    expect(result.current.errorReportDialog.report?.occurredAt).toBe('new');
    const reportsBefore = bridge.call('prepareDesktopErrorReport').mock.calls.length;
    await act(async () => result.current.handleOpen('planner'));
    expect(bridge.call('prepareDesktopErrorReport')).toHaveBeenCalledTimes(reportsBefore);
  });

  it('covers live-session busy branches, automation message fallbacks, and unconfigured tools', async () => {
    const pending = Promise.withResolvers<{ success: boolean; userMessage: string }>();
    const bridge = installControllerBridge({
      listOfficialTools: { tools: [{ id: 'gmail', name: 'Gmail', configured: false }] },
      connectAntigravityAuth: () => pending.promise,
      automationsList: [], backgroundTasksUpsert: undefined,
    });
    const { result } = await renderControllerHarness(bridge);
    let connecting!: Promise<void>;
    act(() => { connecting = result.current.handleConnectAntigravityAuth(); });
    await waitFor(() => expect(result.current.antigravityAuthBusy).toBe(true));
    act(() => bridge.emit('onAntigravityAuthSessionEvent', { sessionId: 'session', type: 'completed' }));
    act(() => bridge.emit('onAntigravityAuthSessionEvent', { sessionId: 'session', type: 'failed' }));
    pending.resolve({ success: false, userMessage: 'Stopped' });
    await act(async () => connecting);

    const automation = { id: 'automation', name: 'Daily', enabled: true, selectedAppIds: [], createdAt: '2026-08-10', updatedAt: '2026-08-10' };
    act(() => bridge.emit('onAutomationUpdated', { automation, run: { id: 'running', automationId: 'automation', status: 'running', startedAt: '2026-08-10', updatedAt: '2026-08-10' } }));
    act(() => bridge.emit('onRuntimeStatusChanged', { appId: 'planner', status: 'running' }));
    act(() => bridge.emit('onRuntimeStatusChanged', { appId: 'planner', status: 'stopped' }));
  });

  it('hydrates a changed active-run mapping and applies the fetched live run', async () => {
    controllerChatPersistence.state = {
      conversations: [{ id: 'conversation', appId: 'planner', mode: 'edit_app', targetAppId: 'planner', title: 'Planner', threadId: null, createdAt: '2026-08-10', updatedAt: '2026-08-10', messages: [] }],
      activeConversationByApp: { planner: 'different' }, lastActiveConversationId: null,
      activeRuns: [{ runId: 'persisted-run', conversationId: 'conversation', appId: 'planner' }], draftInputByConversationId: {},
    };
    const bridge = installControllerBridge({
      chatGetRun: { runId: 'persisted-run', appId: 'planner', conversationId: 'conversation', prompt: '', status: 'running', threadId: 'thread', progressLog: [], createdAt: '2026-08-10', updatedAt: '2026-08-10', dangerMode: false, permissionMode: 'safe' },
    });
    const { result } = await renderControllerHarness(bridge);
    await waitFor(() => expect(result.current.activeConversationRunId).toBe('persisted-run'));
    expect(result.current.activeConversationId).toBe('conversation');
  });
});
