import { act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  controllerSettingsFixture,
  installControllerBridge,
  renderControllerHarness,
  resetControllerHarness,
} from './helpers/renderer-app-controller-harness';

beforeEach(resetControllerHarness);
afterEach(() => vi.useRealTimers());

const codexStatus = (authenticated = false) => ({
  installed: true, authenticated, authFilePath: authenticated ? '/tmp/auth' : '', codexHome: '/tmp/codex',
});
const providerStatus = (authenticated = false) => ({
  installed: true, authenticated, source: authenticated ? 'credentials' : 'missing',
});

describe('RendererAppController authentication cancellation races', () => {
  it('completes active Codex and Claude attempts after their follow-up polls', async () => {
    const settings = controllerSettingsFixture();
    settings.providerConnections = { claude: { connected: true } as never };
    const bridge = installControllerBridge({
      getSettings: settings,
      getCodexAuthStatus: codexStatus(true),
      getClaudeAuthStatus: providerStatus(true),
      connectCodexAuth: { success: true, userMessage: 'Started' },
      connectClaudeAuth: { success: true, userMessage: 'Started', status: providerStatus(true) },
      confirmClaudeAuthConnection: { success: true, userMessage: 'Connected', status: providerStatus(true) },
    });
    const { result } = await renderControllerHarness(bridge);
    await act(async () => result.current.handleConnectCodexAuth());
    await act(async () => result.current.handleConnectClaudeAuth());
    expect(result.current.codexAuthStatus.authenticated).toBe(true);
    expect(result.current.claudeAuthStatus.authenticated).toBe(true);
  });

  it('cancels each provider while its initial status poll is waiting', async () => {
    const scenarios = [
      { status: 'getCodexAuthStatus', connect: 'connectCodexAuth', action: 'handleConnectCodexAuth', close: 'closeCodexConfig', value: codexStatus() },
      { status: 'getClaudeAuthStatus', connect: 'connectClaudeAuth', action: 'handleConnectClaudeAuth', close: 'closeClaudeConfig', value: providerStatus() },
      { status: 'getAntigravityAuthStatus', connect: 'connectAntigravityAuth', action: 'handleConnectAntigravityAuth', close: 'closeAntigravityConfig', value: providerStatus() },
    ] as const;
    for (const scenario of scenarios) {
      resetControllerHarness();
      const pending = Promise.withResolvers<{ success: boolean; userMessage: string }>();
      const bridge = installControllerBridge({
        [scenario.status]: scenario.value,
        [scenario.connect]: () => pending.promise,
      });
      const current = await renderControllerHarness(bridge);
      vi.useFakeTimers();
      let connecting!: Promise<void>;
      act(() => { connecting = current.result.current[scenario.action](); });
      await act(async () => { await Promise.resolve(); });
      act(() => current.result.current[scenario.close]());
      await act(async () => { await vi.advanceTimersByTimeAsync(1_500); });
      pending.resolve({ success: true, userMessage: 'Started' });
      await act(async () => connecting);
      vi.useRealTimers();
      current.unmount();
    }
  });

  it('cancels Codex during the follow-up authentication poll', async () => {
    const bridge = installControllerBridge({
      connectCodexAuth: { success: true, userMessage: 'Started' },
    });
    const { result } = await renderControllerHarness(bridge);
    let statusReads = 0;
    bridge.set('getCodexAuthStatus', () => Promise.resolve(++statusReads === 1 ? codexStatus(true) : codexStatus()));
    vi.useFakeTimers();
    let connecting!: Promise<void>;
    act(() => { connecting = result.current.handleConnectCodexAuth(); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    act(() => result.current.closeCodexConfig());
    await act(async () => { await vi.advanceTimersByTimeAsync(1_500); });
    await act(async () => connecting);
    expect(result.current.codexAuthBusy).toBe(false);
  });

  it('stops Codex and Claude after a follow-up status request is canceled', async () => {
    for (const scenario of [
      { status: 'getCodexAuthStatus', connect: 'connectCodexAuth', action: 'handleConnectCodexAuth', close: 'closeCodexConfig', initial: codexStatus(false) },
      { status: 'getClaudeAuthStatus', connect: 'connectClaudeAuth', action: 'handleConnectClaudeAuth', close: 'closeClaudeConfig', initial: providerStatus(false) },
    ] as const) {
      resetControllerHarness();
      const followUp = Promise.withResolvers<ReturnType<typeof codexStatus> | ReturnType<typeof providerStatus>>();
      let connected = false;
      let reads = 0;
      const bridge = installControllerBridge({
        [scenario.connect]: () => {
          connected = true;
          return Promise.resolve({ success: true, userMessage: 'Started', status: providerStatus(false) });
        },
        [scenario.status]: () => {
          if (!connected) return Promise.resolve(scenario.initial);
          reads += 1;
          return reads === 1 ? Promise.resolve(scenario.initial) : followUp.promise;
        },
      });
      const current = await renderControllerHarness(bridge);
      vi.useFakeTimers();
      let connecting!: Promise<void>;
      act(() => { connecting = current.result.current[scenario.action](); });
      await act(async () => {
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(2_000);
      });
      expect(reads).toBeGreaterThanOrEqual(2);
      act(() => current.result.current[scenario.close]());
      followUp.resolve(scenario.initial);
      await act(async () => connecting);
      vi.useRealTimers();
      current.unmount();
    }
  });

  it('cancels Claude and Antigravity during their follow-up authentication polls', async () => {
    for (const scenario of [
      { status: 'getClaudeAuthStatus', connect: 'connectClaudeAuth', action: 'handleConnectClaudeAuth', close: 'closeClaudeConfig' },
      { status: 'getAntigravityAuthStatus', connect: 'connectAntigravityAuth', action: 'handleConnectAntigravityAuth', close: 'closeAntigravityConfig' },
    ] as const) {
      resetControllerHarness();
      const bridge = installControllerBridge({
        [scenario.connect]: { success: true, userMessage: 'Started', status: providerStatus() },
      });
      const current = await renderControllerHarness(bridge);
      let statusReads = 0;
      bridge.set(scenario.status, () => Promise.resolve(++statusReads === 1 ? providerStatus(true) : providerStatus()));
      vi.useFakeTimers();
      let connecting!: Promise<void>;
      act(() => { connecting = current.result.current[scenario.action](); });
      await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
      act(() => current.result.current[scenario.close]());
      await act(async () => { await vi.advanceTimersByTimeAsync(1_500); });
      await act(async () => connecting);
      vi.useRealTimers();
      current.unmount();
    }
  });

  it('suppresses late connection errors after every provider is canceled', async () => {
    for (const scenario of [
      { status: 'getCodexAuthStatus', connect: 'connectCodexAuth', action: 'handleConnectCodexAuth', close: 'closeCodexConfig', value: codexStatus(true) },
      { status: 'getClaudeAuthStatus', connect: 'connectClaudeAuth', action: 'handleConnectClaudeAuth', close: 'closeClaudeConfig', value: providerStatus(true) },
      { status: 'getAntigravityAuthStatus', connect: 'connectAntigravityAuth', action: 'handleConnectAntigravityAuth', close: 'closeAntigravityConfig', value: providerStatus(true) },
    ] as const) {
      resetControllerHarness();
      const pending = Promise.withResolvers<never>();
      const bridge = installControllerBridge({ [scenario.connect]: () => pending.promise });
      const current = await renderControllerHarness(bridge);
      bridge.set(scenario.status, scenario.value);
      let connecting!: Promise<void>;
      act(() => { connecting = current.result.current[scenario.action](); });
      await act(async () => { await Promise.resolve(); });
      act(() => current.result.current[scenario.close]());
      pending.reject(new Error('late failure'));
      await act(async () => connecting);
      expect(current.result.current.errorReportDialog.open).toBe(false);
      current.unmount();
    }
  });

  it('keeps disconnect busy state when canceling a separate tracked connection', async () => {
    const connect = Promise.withResolvers<{ success: boolean; userMessage: string }>();
    const disconnect = Promise.withResolvers<{ success: boolean; userMessage: string; status: ReturnType<typeof providerStatus> }>();
    const bridge = installControllerBridge({
      getCodexAuthStatus: codexStatus(true),
      connectCodexAuth: () => connect.promise,
      signOutClaudeAuth: () => disconnect.promise,
    });
    const { result } = await renderControllerHarness(bridge);
    let connecting!: Promise<void>;
    let disconnecting!: Promise<void>;
    act(() => { connecting = result.current.handleConnectCodexAuth(); });
    act(() => { disconnecting = result.current.handleDisconnectClaudeAuth(); });
    act(() => result.current.closeCodexConfig());
    expect(result.current.claudeAuthBusy).toBe(true);
    connect.resolve({ success: true, userMessage: 'Started' });
    await act(async () => connecting);
    disconnect.resolve({ success: true, userMessage: 'Done', status: providerStatus() });
    await act(async () => disconnecting);
  });

  it('keeps a newer provider busy when an older connection is canceled', async () => {
    const codex = Promise.withResolvers<{ success: boolean; userMessage: string }>();
    const claude = Promise.withResolvers<{ success: boolean; userMessage: string }>();
    const bridge = installControllerBridge({
      getCodexAuthStatus: codexStatus(true), getClaudeAuthStatus: providerStatus(true),
      connectCodexAuth: () => codex.promise, connectClaudeAuth: () => claude.promise,
    });
    const { result } = await renderControllerHarness(bridge);
    let codexConnect!: Promise<void>;
    let claudeConnect!: Promise<void>;
    act(() => { codexConnect = result.current.handleConnectCodexAuth(); });
    act(() => { claudeConnect = result.current.handleConnectClaudeAuth(); });
    act(() => result.current.closeCodexConfig());
    expect(result.current.claudeAuthBusy).toBe(true);
    codex.resolve({ success: true, userMessage: 'Started' });
    await act(async () => codexConnect);
    claude.resolve({ success: false, userMessage: 'Stopped' });
    await act(async () => claudeConnect);
  });

  it('clears Antigravity busy state when its session is canceled during connect', async () => {
    const pending = Promise.withResolvers<{ success: boolean; userMessage: string }>();
    const bridge = installControllerBridge({
      getAntigravityAuthStatus: providerStatus(true),
      connectAntigravityAuth: () => pending.promise,
    });
    const { result } = await renderControllerHarness(bridge);
    let connecting!: Promise<void>;
    act(() => { connecting = result.current.handleConnectAntigravityAuth(); });
    await act(async () => result.current.handleCancelAntigravityAuthSession());
    expect(result.current.antigravityAuthBusy).toBe(false);
    pending.resolve({ success: false, userMessage: 'Stopped' });
    await act(async () => connecting);
  });

  it('preserves a newer busy provider while disconnect and reinstall actions settle', async () => {
    const scenarios = [
      { method: 'signOutClaudeAuth', action: 'handleDisconnectClaudeAuth', result: { success: true, userMessage: 'Done', status: providerStatus() } },
      { method: 'signOutClaudeAuth', action: 'handleSignOutClaudeAuth', result: { success: true, userMessage: 'Done', status: providerStatus() } },
      { method: 'disconnectAntigravityAuth', action: 'handleDisconnectAntigravityAuth', result: { success: true, userMessage: 'Done', status: providerStatus() } },
      { method: 'reinstallClaude', action: 'handleReinstallClaude', result: { success: true, userMessage: 'Done', status: providerStatus() } },
      { method: 'reinstallAntigravity', action: 'handleReinstallAntigravity', result: { success: true, userMessage: 'Done', status: providerStatus() } },
      { method: 'reinstallCodex', action: 'handleReinstallCodex', result: { success: true, userMessage: 'Done', status: codexStatus() } },
    ] as const;
    for (const scenario of scenarios) {
      resetControllerHarness();
      const primary = Promise.withResolvers<typeof scenario.result>();
      const blocker = Promise.withResolvers<{ success: boolean; userMessage: string; status: ReturnType<typeof codexStatus> }>();
      const bridge = installControllerBridge({
        [scenario.method]: () => primary.promise,
        disconnectCodexAuth: scenario.method === 'reinstallCodex' ? { success: true, userMessage: 'Done' } : () => blocker.promise,
        disconnectAntigravityAuth: scenario.method === 'disconnectAntigravityAuth' ? () => primary.promise : { success: true, userMessage: 'Done', status: providerStatus() },
      });
      const current = await renderControllerHarness(bridge);
      let first!: Promise<void>;
      let second!: Promise<void>;
      act(() => { first = current.result.current[scenario.action](); });
      if (scenario.method === 'reinstallCodex') {
        const secondPending = Promise.withResolvers<{ success: boolean; userMessage: string; status: ReturnType<typeof providerStatus> }>();
        bridge.set('disconnectAntigravityAuth', () => secondPending.promise);
        act(() => { second = current.result.current.handleDisconnectAntigravityAuth(); });
        primary.resolve(scenario.result);
        await act(async () => first);
        expect(current.result.current.antigravityAuthBusy).toBe(true);
        secondPending.resolve({ success: true, userMessage: 'Done', status: providerStatus() });
        await act(async () => second);
      } else {
        act(() => { second = current.result.current.handleDisconnectCodexAuth(); });
        primary.resolve(scenario.result);
        await act(async () => first);
        expect(current.result.current.codexAuthBusy).toBe(true);
        blocker.resolve({ success: true, userMessage: 'Done', status: codexStatus() });
        await act(async () => second);
      }
      current.unmount();
    }
  });
});
