import { act, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  controllerSettingsFixture,
  installControllerBridge,
  renderControllerHarness,
  resetControllerHarness,
} from './helpers/renderer-app-controller-harness';

beforeEach(resetControllerHarness);

describe('RendererAppController authentication result variants', () => {
  it('maps unsuccessful provider connection results and refreshes status without waiting', async () => {
    const bridge = installControllerBridge({
      connectCodexAuth: { success: false, technicalCode: 'codex_failed' },
      connectClaudeAuth: { success: false, status: { installed: true, authenticated: false, source: 'missing' }, technicalCode: 'claude_failed' },
      connectAntigravityAuth: { success: false, status: { installed: true, authenticated: false, source: 'missing' }, technicalCode: 'antigravity_failed' },
    });
    const { result } = await renderControllerHarness(bridge);
    await act(async () => result.current.handleConnectCodexAuth());
    expect(result.current.bannerSeverity).toBe('error');
    await act(async () => result.current.handleConnectClaudeAuth());
    expect(result.current.claudeAuthStatus.authenticated).toBe(false);
    await act(async () => result.current.handleConnectAntigravityAuth());
    expect(result.current.antigravityAuthStatus.authenticated).toBe(false);
  });

  it('uses Claude confirmation mode and reports a provider that authenticates but cannot be confirmed', async () => {
    const settings = controllerSettingsFixture();
    settings.providerConnections = {};
    let confirmations = 0;
    const authenticated = { installed: true, authenticated: true, source: 'credentials' };
    const bridge = installControllerBridge({
      getSettings: settings,
      getClaudeAuthStatus: authenticated,
      confirmClaudeAuthConnection: () => Promise.resolve(++confirmations === 1
        ? { success: true, status: authenticated, userMessage: 'Ready' }
        : { success: false, status: authenticated, technicalCode: 'confirmation_failed' }),
    });
    const { result } = await renderControllerHarness(bridge);
    await waitFor(() => expect(result.current.claudeAuthStatus.authenticated).toBe(true));
    await act(async () => result.current.handleConnectClaudeAuth());
    expect(bridge.call('connectClaudeAuth')).not.toHaveBeenCalled();
    expect(result.current.bannerSeverity).toBe('warning');
  });

  it('refreshes missing disconnect and reinstall statuses and maps unsuccessful results for every provider', async () => {
    const bridge = installControllerBridge({
      disconnectCodexAuth: { success: false, technicalCode: 'disconnect_failed' },
      signOutClaudeAuth: { success: false, technicalCode: 'signout_failed' },
      disconnectAntigravityAuth: { success: false, technicalCode: 'disconnect_failed' },
      reinstallCodex: { success: false, userMessage: '', technicalCode: 'reinstall_failed' },
      reinstallClaude: { success: false, userMessage: '', technicalCode: 'reinstall_failed' },
      reinstallAntigravity: { success: false, userMessage: '', technicalCode: 'reinstall_failed' },
    });
    const { result } = await renderControllerHarness(bridge);
    await act(async () => result.current.handleDisconnectCodexAuth());
    await act(async () => result.current.handleDisconnectClaudeAuth());
    await act(async () => result.current.handleSignOutClaudeAuth());
    await act(async () => result.current.handleDisconnectAntigravityAuth());
    await act(async () => result.current.handleReinstallCodex());
    await act(async () => result.current.handleReinstallClaude());
    await act(async () => result.current.handleReinstallAntigravity());
    expect(result.current.bannerSeverity).toBe('error');
  });

  it('maps failed account responses, empty messages, display-name updates, and registration failures', async () => {
    const bridge = installControllerBridge({
      loginForgerAccount: { success: false, authenticated: false },
      loginForgerAccountWithGoogle: { success: false, authenticated: false },
      loginForgerAccountWithApple: { success: false, authenticated: false },
      registerForgerAccount: { success: false, authenticated: false },
      updateForgerAccountProfile: { success: true, authenticated: true, user: { id: 1, email: 'user@example.com', displayName: 'New display', confirmed: true } },
    });
    const { result } = await renderControllerHarness(bridge);
    await act(async () => result.current.handleForgerLogin('user@example.com', 'bad'));
    await act(async () => result.current.handleForgerGoogleLogin());
    await act(async () => result.current.handleForgerAppleLogin());
    expect(await result.current.handleForgerRegister({ email: 'user@example.com', password: 'x', passwordConfirmation: 'x' })).toBe(false);
    expect(await result.current.handleForgerProfileUpdate({ displayName: 'New display' })).toBe(true);
    expect(bridge.call('updateForgerAccountProfile')).toHaveBeenCalledWith({ displayName: 'New display' });
  });
});
