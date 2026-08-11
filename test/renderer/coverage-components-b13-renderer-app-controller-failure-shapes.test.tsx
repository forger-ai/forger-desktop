import { act } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  installControllerBridge,
  renderControllerHarness,
  resetControllerHarness,
} from './helpers/renderer-app-controller-harness';

beforeEach(resetControllerHarness);

describe('RendererAppController non-Error rejection and optional-result shapes', () => {
  it('uses localized fallbacks when lifecycle, backup, memory, and settings bridges reject non-Error values', async () => {
    const app = { id: 'planner', name: 'Planner', category: 'productivity', status: 'installed', version: '1.0.0' };
    const local = { backupId: 'backup', appId: 'planner', appName: 'Planner', totalBytes: 1, createdAt: '2026-08-10', reason: 'manual' };
    const remote = { id: 'remote', appId: 'planner', appName: 'Planner', totalBytes: 1, createdAt: '2026-08-10', backupType: 'sync_snapshot' };
    const bridge = installControllerBridge({ listInstalledApps: [app] });
    const { result } = await renderControllerHarness(bridge);
    const reject = () => Promise.reject('non-error rejection');
    for (const [method, action] of [
      ['openApp', () => result.current.handleOpen('planner')],
      ['updateApp', () => result.current.handleUpdate('planner')],
      ['createBackup', () => result.current.handleCreateBackup('planner')],
      ['deleteBackup', () => result.current.handleDeleteBackup(local)],
      ['deleteBackups', () => result.current.handleDeleteSelectedBackups([local])],
      ['restoreBackup', () => result.current.handleRestoreBackup(local)],
      ['createRemoteBackup', () => result.current.handleSyncNow('planner')],
      ['deleteRemoteBackup', () => result.current.handleDeleteRemoteBackup(remote as never)],
      ['restoreRemoteBackup', () => result.current.handleRestoreRemoteBackup(remote as never)],
      ['setAppAutoSync', () => result.current.handleSetAutoSync('planner', true)],
      ['memoryCreate', () => result.current.handleCreateMemory({ content: 'Memory', scope: 'global' })],
      ['memoryUpdate', () => result.current.handleUpdateMemory({ id: 'memory', content: 'Memory' })],
      ['memoryDelete', () => result.current.handleDeleteMemory('memory')],
      ['updateAgentDefaults', () => result.current.handleAgentDefaultsChange({ provider: 'codex' })],
      ['setActiveLlmProviderProfile', () => result.current.handleActiveProviderProfileChange({ provider: 'codex', profileId: 'profile' })],
      ['updateLlmProviderProfileDefaults', () => result.current.handleProviderProfileDefaultsChange({ provider: 'codex', profileId: 'profile' })],
    ] as const) {
      bridge.set(method, reject);
      await act(async () => action());
    }
    expect(result.current.bannerSeverity).toBe('error');
  });

  it('uses localized fallbacks for every provider rejection represented by a non-Error value', async () => {
    const bridge = installControllerBridge();
    const { result } = await renderControllerHarness(bridge);
    const reject = () => Promise.reject('provider rejected');
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
    ] as const) {
      bridge.set(method, reject);
      await act(async () => action());
    }
    expect(result.current.bannerSeverity).toBe('error');
  });

  it('maps official-tool account errors, generic errors, and configure analytics independently', async () => {
    const bridge = installControllerBridge({ listOfficialTools: { tools: [] } });
    const { result } = await renderControllerHarness(bridge);
    await act(async () => result.current.runOfficialToolAction('gmail', async () => ({ success: false, userMessage: 'Login', technicalCode: 'forger_account_required' })));
    expect(result.current.agentToolErrorCode).toBe('forger_account_required');
    await act(async () => result.current.runOfficialToolAction('gmail', async () => ({ success: false, userMessage: 'Generic' })));
    expect(result.current.agentToolErrorCode).toBeNull();
    await act(async () => result.current.runOfficialToolAction('gmail', async () => ({ success: true, userMessage: 'Done' })));
    expect(result.current.bannerSeverity).toBe('success');
  });

  it('maps every desktop-update message and diagnostic payload combination', async () => {
    const bridge = installControllerBridge({ prepareDesktopErrorReport: async (report: Record<string, unknown>) => report });
    const { result } = await renderControllerHarness(bridge);
    for (const state of [
      { status: 'installer_opened', currentVersion: '1.0.0' },
      { status: 'unsupported', currentVersion: '1.0.0' },
      { status: 'idle', currentVersion: '1.0.0' },
      { status: 'error', currentVersion: '1.0.0', userMessage: 'Update failed' },
      { status: 'error', currentVersion: '1.0.0', technicalCode: 'update_failed', availableVersion: '2.0.0', diagnosticDetails: { log: 'failed' } },
    ]) {
      await act(async () => result.current.runDesktopUpdateAction(async () => state as never));
    }
    expect(result.current.desktopUpdateBusy).toBe(false);
  });
});
