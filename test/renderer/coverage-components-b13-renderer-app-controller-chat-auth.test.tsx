import { act } from '@testing-library/react';
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

describe('RendererAppController runtime selection and authentication polling', () => {
  it('starts visible free-chat runs with Claude and Antigravity runtime drafts and active profiles', async () => {
    for (const provider of ['claude', 'antigravity'] as const) {
      resetControllerHarness();
      const settings = controllerSettingsFixture();
      settings.activeProviderProfiles = { [provider]: `${provider}-profile` };
      const bridge = installControllerBridge({
        getSettings: settings,
        getClaudeAuthStatus: { installed: true, authenticated: provider === 'claude', source: provider === 'claude' ? 'credentials' : 'missing' },
        getAntigravityAuthStatus: { installed: true, authenticated: provider === 'antigravity', source: provider === 'antigravity' ? 'credentials' : 'missing' },
        chatStartRun: { runId: `${provider}-run`, status: 'queued' }, filesList: [],
      });
      const current = await renderControllerHarness(bridge);
      act(() => current.result.current.setSelectedAgentProvider(provider));
      act(() => current.result.current.handleStartNewConversation());
      await act(async () => current.result.current.handleSendMessage(`Hello ${provider}`, { mode: 'free_chat' }));
      expect(bridge.call('chatStartRun')).toHaveBeenCalledWith(expect.objectContaining({
        provider, authProfileId: `${provider}-profile`,
      }));
      current.unmount();
    }
  });

  it('uses locked conversation runtimes, sorts history, and clears empty drafts', async () => {
    controllerChatPersistence.state = {
      conversations: [
        { id: 'older', appId: 'planner', mode: 'edit_app', targetAppId: null, title: 'Older', threadId: 'thread', runtime: { provider: 'codex', model: 'locked', effort: 'high', authProfileId: 'locked-profile' }, createdAt: '2026-08-09', updatedAt: '2026-08-09', messages: [] },
        { id: 'newer', appId: 'forger', mode: 'free_chat', targetAppId: null, title: 'Newer', threadId: null, createdAt: '2026-08-10', updatedAt: '2026-08-10', messages: [] },
      ],
      activeConversationByApp: { planner: 'older' }, lastActiveConversationId: 'older', activeRuns: [], draftInputByConversationId: { older: 'draft' },
    };
    const bridge = installControllerBridge({
      getCodexAuthStatus: { installed: true, authenticated: true, authFilePath: '/tmp/auth', codexHome: '/tmp/codex' },
      chatStartRun: { runId: 'locked-run', status: 'queued' }, filesList: [],
    });
    const { result } = await renderControllerHarness(bridge);
    expect(result.current.chatHistoryItems.map((item) => item.id)).toEqual(['newer', 'older']);
    act(() => result.current.setChatInput('changed'));
    expect(result.current.chatInput).toBe('changed');
    act(() => result.current.setChatInput(''));
    expect(result.current.chatInput).toBe('');
    await act(async () => result.current.handleSendMessage('Continue'));
    expect(bridge.call('chatStartRun')).toHaveBeenCalledWith(expect.objectContaining({
      appId: 'planner', targetAppId: 'planner', provider: 'codex', model: 'locked', authProfileId: 'locked-profile', threadId: 'thread',
    }));
  });

  it('polls each provider until the real authenticated status arrives', async () => {
    const scenarios = [
      { provider: 'codex', statusMethod: 'getCodexAuthStatus', connectMethod: 'connectCodexAuth', action: 'handleConnectCodexAuth' },
      { provider: 'claude', statusMethod: 'getClaudeAuthStatus', connectMethod: 'connectClaudeAuth', action: 'handleConnectClaudeAuth' },
      { provider: 'antigravity', statusMethod: 'getAntigravityAuthStatus', connectMethod: 'connectAntigravityAuth', action: 'handleConnectAntigravityAuth' },
    ] as const;
    for (const scenario of scenarios) {
      resetControllerHarness();
      let statusReads = 0;
      const unauthenticated = scenario.provider === 'codex'
        ? { installed: true, authenticated: false, authFilePath: '', codexHome: '' }
        : { installed: true, authenticated: false, source: 'missing' };
      const authenticated = scenario.provider === 'codex'
        ? { installed: true, authenticated: true, authFilePath: '/tmp/auth', codexHome: '/tmp/codex' }
        : { installed: true, authenticated: true, source: 'credentials' };
      const bridge = installControllerBridge({
        [scenario.statusMethod]: () => Promise.resolve(++statusReads >= 3 ? authenticated : unauthenticated),
        [scenario.connectMethod]: { success: true, userMessage: 'Started' },
        confirmClaudeAuthConnection: { success: true, status: authenticated },
      });
      const current = await renderControllerHarness(bridge);
      statusReads = 0;
      vi.useFakeTimers();
      let connecting!: Promise<void>;
      act(() => { connecting = current.result.current[scenario.action](); });
      await act(async () => { await Promise.resolve(); });
      await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
      await act(async () => connecting);
      expect(statusReads).toBeGreaterThanOrEqual(3);
      expect(current.result.current[`${scenario.provider}AuthStatus`].authenticated).toBe(true);
      vi.useRealTimers();
      current.unmount();
    }
  });
});
