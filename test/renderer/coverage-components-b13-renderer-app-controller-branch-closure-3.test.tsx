import { act, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  controllerChatPersistence,
  controllerSettingsFixture,
  installControllerBridge,
  renderControllerHarness,
  resetControllerHarness,
} from './helpers/renderer-app-controller-harness';

beforeEach(resetControllerHarness);
afterEach(() => vi.useRealTimers());

describe('RendererAppController chat and authentication branch closure', () => {
  it('resolves an explicitly selected authenticated Codex provider', async () => {
    const bridge = installControllerBridge({
      getCodexAuthStatus: { installed: true, authenticated: true, authFilePath: '/tmp/auth', codexHome: '/tmp/codex' },
    });
    const { result } = await renderControllerHarness(bridge);
    await waitFor(() => expect(result.current.codexAuthStatus.authenticated).toBe(true));
    act(() => result.current.setSelectedAgentProvider('codex'));
    expect(result.current.resolvedChatProvider).toBe('codex');
  });

  it('starts the first conversation with an active profile and a mentioned-only prompt', async () => {
    const settings = controllerSettingsFixture();
    settings.activeProviderProfiles = { codex: 'work' };
    const file = { id: 'file', name: 'notes.txt', relativePath: 'notes.txt', categoryPath: '', sizeBytes: 10, modifiedAt: '2026-08-10', uploadedAt: '2026-08-10' };
    const bridge = installControllerBridge({
      getSettings: settings,
      getCodexAuthStatus: { installed: true, authenticated: true, authFilePath: '/tmp/auth', codexHome: '/tmp/codex' },
      filesList: [file], chatStartRun: { runId: 'mentioned-run', status: 'queued' },
    });
    const { result } = await renderControllerHarness(bridge);
    await waitFor(() => expect(result.current.forgerFiles).toHaveLength(1));
    act(() => result.current.handleMentionFile(file as never));
    await act(async () => result.current.handleSendMessage('', { mode: 'free_chat' }));
    expect(bridge.call('chatStartRun')).toHaveBeenCalledWith(expect.objectContaining({
      prompt: 'Review the shared files in this message.', authProfileId: 'work',
    }));
  });

  it('guards missing chat runs and maps cancellation failure and thrown Error states', async () => {
    controllerChatPersistence.state = {
      conversations: [{ id: 'chat', appId: 'forger', mode: 'free_chat', targetAppId: null, title: 'Chat', threadId: null, createdAt: '2026-08-10', updatedAt: '2026-08-10', messages: [] }],
      activeConversationByApp: { forger: 'chat' }, lastActiveConversationId: 'chat', activeRuns: [], draftInputByConversationId: {},
    };
    const bridge = installControllerBridge({ chatCancelRun: { success: false } });
    const { result } = await renderControllerHarness(bridge);
    await act(async () => result.current.handleStopChatRun());
    act(() => bridge.emit('onChatRunUpdated', { run: { runId: 'running', appId: 'forger', conversationId: 'chat', prompt: '', status: 'running', dangerMode: false, permissionMode: 'safe' } }));
    await act(async () => result.current.handleStopChatRun());
    expect(result.current.bannerSeverity).toBe('error');
    bridge.set('chatCancelRun', () => Promise.reject(new Error('cancel exploded')));
    await act(async () => result.current.handleStopChatRun());
    expect(result.current.bannerMessage).toBe('cancel exploded');
  });

  it('denies a permission and sends a question answer without an optional description', async () => {
    controllerChatPersistence.state = {
      conversations: [{ id: 'chat', appId: 'forger', mode: 'free_chat', targetAppId: null, title: 'Chat', threadId: null, createdAt: '2026-08-10', updatedAt: '2026-08-10', messages: [] }],
      activeConversationByApp: { forger: 'chat' }, lastActiveConversationId: 'chat', activeRuns: [], draftInputByConversationId: {},
    };
    const bridge = installControllerBridge({ chatApprovePermission: { success: true }, chatStartRun: { runId: 'answer', status: 'queued' } });
    const { result } = await renderControllerHarness(bridge);
    const permission = { requestId: 'permission', pluginId: 'gmail', permission: 'send', reason: 'Send', risk: 'high', resource: 'mail' };
    act(() => bridge.emit('onChatRunUpdated', { run: { runId: 'permission-run', appId: 'forger', conversationId: 'chat', prompt: '', status: 'needs_permission', permissionRequest: permission, dangerMode: false, permissionMode: 'safe' } }));
    await act(async () => result.current.handleRespondPermission('permission-run', 'permission', 'deny'));
    expect(result.current.chatMessages.at(-1)?.action?.status).toBe('denied');
    const request = { requestId: 'question', chatId: 'chat', createdAt: '2026-08-10', questions: [] };
    act(() => bridge.emit('onChatRunUpdated', { run: { runId: 'question-run', appId: 'forger', conversationId: 'chat', prompt: '', status: 'applied', questionRequest: request, dangerMode: false, permissionMode: 'safe' } }));
    await act(async () => result.current.handleRespondQuestion('question-run', request, {
      answers: [{ questionId: 'q', question: 'Choose', optionId: 'one', label: 'One' }],
    }));
    expect(bridge.call('chatStartRun')).toHaveBeenCalled();
  });

  it('supports legacy free and app conversations while restoring only the failed target', async () => {
    controllerChatPersistence.state = {
      conversations: [
        { id: 'legacy-free', appId: 'forger', title: 'Free', threadId: null, createdAt: '2026-08-10', updatedAt: '2026-08-10', messages: [] },
        { id: 'legacy-app', appId: 'planner', title: 'App', threadId: null, createdAt: '2026-08-09', updatedAt: '2026-08-09', messages: [] },
        { id: 'other', appId: 'forger', mode: 'free_chat', targetAppId: null, title: 'Other', threadId: null, createdAt: '2026-08-08', updatedAt: '2026-08-08', messages: [] },
      ] as never,
      activeConversationByApp: { forger: 'legacy-free' }, lastActiveConversationId: 'legacy-free', activeRuns: [], draftInputByConversationId: {},
    };
    const bridge = installControllerBridge({
      getCodexAuthStatus: { installed: true, authenticated: true, authFilePath: '/tmp/auth', codexHome: '/tmp/codex' },
      chatStartRun: () => Promise.reject('app_run_in_progress'),
    });
    const { result } = await renderControllerHarness(bridge);
    await waitFor(() => expect(result.current.codexAuthStatus.authenticated).toBe(true));
    result.current.handleOpenFreeChatFromWake();
    const freeRequest = { requestId: 'free-question', chatId: 'legacy-free', createdAt: '2026-08-10', questions: [] };
    await act(async () => result.current.handleRespondQuestion('free-run', freeRequest, { answers: [] }));
    expect(result.current.chatMessages.at(-1)?.role).toBe('assistant');

    act(() => result.current.handleOpenConversation('legacy-app'));
    const appRequest = { requestId: 'app-question', chatId: 'legacy-app', createdAt: '2026-08-10', questions: [] };
    await act(async () => result.current.handleRespondQuestion('app-run', appRequest, { answers: [] }));
    expect(bridge.call('chatStartRun')).toHaveBeenLastCalledWith(expect.objectContaining({ appId: 'planner', chatMode: 'edit_app', targetAppId: 'planner' }));
  });

  it('maps automation edit failures and deletion message fallbacks', async () => {
    const bridge = installControllerBridge({
      automationsUpdate: () => Promise.reject('save unavailable'),
      automationsDelete: { success: false }, automationsList: [],
    });
    const { result } = await renderControllerHarness(bridge);
    await act(async () => result.current.handleSaveAutomation({ id: 'automation', name: 'Automation', enabled: true, selectedAppIds: [] } as never));
    expect(result.current.bannerSeverity).toBe('error');
    await act(async () => result.current.handleDeleteAutomation('automation'));
    expect(result.current.bannerSeverity).toBe('error');
  });

  it('uses the generic technical code for a failed personal-agent run without an error', async () => {
    const bridge = installControllerBridge();
    const { result } = await renderControllerHarness(bridge);
    await act(async () => result.current.prepareConversationDiagnosticReport({
      agent: { id: 'agent', name: 'Agent', description: '', runtime: { provider: 'codex', model: 'gpt', effort: 'medium' } },
      conversation: { id: 'conversation', agentId: 'agent', title: '', provider: 'codex', providerThreadId: null, messages: [], activeRun: null, createdAt: '2026-08-10', updatedAt: '2026-08-10' },
      run: { id: 'run', conversationId: 'conversation', status: 'failed', progress: [], createdAt: '2026-08-10', updatedAt: '2026-08-10' },
    } as never));
    expect(bridge.call('prepareConversationDiagnosticReport')).toHaveBeenCalledWith(expect.objectContaining({ technicalCode: 'personal_agent_run_failed' }));
  });

  it('refreshes a failed Claude connection without a returned status and warns on an unconfirmed success', async () => {
    let mode: 'failed' | 'success' = 'failed';
    let successReads = 0;
    const settings = controllerSettingsFixture();
    settings.providerConnections = { claude: { connected: true } as never };
    const bridge = installControllerBridge({
      getSettings: settings,
      connectClaudeAuth: { success: false, userMessage: 'Failed' },
      getClaudeAuthStatus: () => Promise.resolve({
        installed: true,
        authenticated: mode === 'failed' || ++successReads === 1,
        source: mode === 'failed' || successReads === 1 ? 'credentials' : 'missing',
      }),
    });
    const { result } = await renderControllerHarness(bridge);
    await act(async () => result.current.handleConnectClaudeAuth());
    expect(bridge.call('getClaudeAuthStatus')).toHaveBeenCalled();
    mode = 'success';
    successReads = 0;
    bridge.set('connectClaudeAuth', { success: true, userMessage: 'Started', status: { installed: true, authenticated: false, source: 'missing' } });
    vi.useFakeTimers();
    let connecting!: Promise<void>;
    act(() => { connecting = result.current.handleConnectClaudeAuth(); });
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(121_500); });
    await act(async () => connecting);
    expect(result.current.bannerSeverity).toBe('warning');
  });

  it('cancels Antigravity safely before a session id exists', async () => {
    const bridge = installControllerBridge();
    const { result } = await renderControllerHarness(bridge);
    await act(async () => result.current.handleCancelAntigravityAuthSession());
    expect(bridge.call('cancelAntigravityAuthSession')).not.toHaveBeenCalled();
  });

  it('does not clear a newer provider busy state when an older provider action settles', async () => {
    const codex = Promise.withResolvers<{ success: boolean; userMessage: string }>();
    const claude = Promise.withResolvers<{ success: boolean; userMessage: string }>();
    const bridge = installControllerBridge({
      disconnectCodexAuth: () => codex.promise,
      signOutClaudeAuth: () => claude.promise,
    });
    const { result } = await renderControllerHarness(bridge);
    let first!: Promise<void>;
    let second!: Promise<void>;
    act(() => { first = result.current.handleDisconnectCodexAuth(); });
    act(() => { second = result.current.handleDisconnectClaudeAuth(); });
    codex.resolve({ success: true, userMessage: 'Codex disconnected' });
    await act(async () => first);
    expect(result.current.claudeAuthBusy).toBe(true);
    claude.resolve({ success: true, userMessage: 'Claude disconnected' });
    await act(async () => second);
  });
});
