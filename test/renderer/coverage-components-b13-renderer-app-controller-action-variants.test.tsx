import { act, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  controllerSettingsFixture,
  installControllerBridge,
  renderControllerHarness,
  resetControllerHarness,
} from './helpers/renderer-app-controller-harness';

beforeEach(resetControllerHarness);

describe('RendererAppController settings, backup, automation, and file action variants', () => {
  it('optimistically updates every provider default shape and recovers failed profile refreshes', async () => {
    const bridge = installControllerBridge({ updateAgentDefaults: controllerSettingsFixture() });
    const { result } = await renderControllerHarness(bridge);
    for (const input of [
      { defaultProvider: 'claude', defaultChatPermissionMode: 'full', defaultChatNetworkAccess: false },
      { provider: 'codex', inactivityTimeoutMinutes: 5 },
      { provider: 'claude', model: 'sonnet-next', effort: 'high' },
      { provider: 'antigravity', model: 'gemini-next', effort: 'low' },
    ]) {
      await act(async () => result.current.handleAgentDefaultsChange(input as never));
    }
    expect(bridge.call('updateAgentDefaults')).toHaveBeenCalledTimes(4);

    bridge.set('setActiveLlmProviderProfile', { success: false });
    await act(async () => result.current.handleActiveProviderProfileChange({ provider: 'codex', profileId: 'missing' }));
    bridge.set('updateLlmProviderProfileDefaults', { success: false });
    await act(async () => result.current.handleProviderProfileDefaultsChange({ provider: 'claude', profileId: 'missing', model: 'x', effort: 'low' }));
    expect(result.current.bannerSeverity).toBe('error');

    bridge.set('updateAgentDefaults', () => Promise.reject(new Error('defaults failed')));
    bridge.set('getSettings', () => Promise.reject(new Error('refresh failed')));
    await act(async () => result.current.handleAgentDefaultsChange({ provider: 'codex' }));
    bridge.set('setActiveLlmProviderProfile', () => Promise.reject(new Error('profile failed')));
    await act(async () => result.current.handleActiveProviderProfileChange({ provider: 'codex', profileId: 'x' }));
    bridge.set('updateLlmProviderProfileDefaults', () => Promise.reject(new Error('profile defaults failed')));
    await act(async () => result.current.handleProviderProfileDefaultsChange({ provider: 'codex', profileId: 'x' }));
  });

  it('renders all backup failure severities and storage-size confirmations', async () => {
    const local = (id: string, bytes: number) => ({ backupId: id, appId: 'planner', appName: '', totalBytes: bytes, createdAt: '2026-08-10', reason: 'manual' });
    const remote = { id: 'remote', appId: 'planner', appName: 'Planner', totalBytes: 1024, createdAt: '2026-08-10', backupType: 'sync_snapshot' };
    const bridge = installControllerBridge({
      createBackup: { success: false, userMessage: 'Create failed' },
      deleteBackup: { success: false, userMessage: 'Delete failed' },
      restoreBackup: { success: false, userMessage: 'Restore failed' },
      createRemoteBackup: { success: false, userMessage: 'Subscribe', technicalCode: 'subscription_required' },
      deleteRemoteBackup: { success: false, userMessage: 'Remote delete failed' },
      restoreRemoteBackup: { success: false, userMessage: 'Remote restore failed' },
      deleteBackups: { success: false, userMessage: '', deleted: [], failed: ['a', 'b'] },
      setAppAutoSync: { appSync: { planner: { enabled: false } } },
    });
    const { result } = await renderControllerHarness(bridge);
    await act(async () => result.current.handleCreateBackup('planner'));
    await act(async () => result.current.handleDeleteBackup(local('a', 512)));
    await act(async () => result.current.handleRestoreBackup(local('a', 512)));
    await act(async () => result.current.handleDeleteSelectedBackups([
      local('a', 512), local('b', 2_048), local('c', 2 * 1024 * 1024), local('d', 2 * 1024 * 1024 * 1024),
    ]));
    expect(result.current.bannerSeverity).toBe('error');
    await act(async () => result.current.handleSyncNow('planner'));
    expect(result.current.cloudModalOpen).toBe(true);
    await act(async () => result.current.handleDeleteRemoteBackup(remote as never));
    await act(async () => result.current.handleRestoreRemoteBackup(remote as never));
    await act(async () => result.current.handleSetAutoSync('planner', false));
    expect(result.current.backupsBusy).toBe(false);
  });

  it('covers empty, skipped, canceled, failed, and replacement automation behavior', async () => {
    const automation = { id: 'automation-1', name: 'Daily', enabled: false, selectedAppIds: [], createdAt: '2026-08-10', updatedAt: '2026-08-10' };
    const bridge = installControllerBridge({
      automationsList: [], automationsListRuns: [], automationsGetRunTranscript: null,
      automationsCreate: automation, automationsUpdate: automation,
      automationsRunNow: { id: 'run-skipped', automationId: automation.id, status: 'skipped', startedAt: '2026-08-10', updatedAt: '2026-08-10' },
      automationsDelete: { success: false, technicalCode: 'delete_failed' },
    });
    const { result } = await renderControllerHarness(bridge);
    await act(async () => result.current.handleSaveAutomation({ name: 'Daily', enabled: false, selectedAppIds: [], prompt: '', frequency: 'daily' } as never));
    expect(result.current.automations).toHaveLength(1);
    await act(async () => result.current.handleRunAutomationNow('automation-1'));
    expect(result.current.bannerSeverity).toBe('warning');
    await act(async () => result.current.handleSelectAutomationRun('missing-run'));
    expect(result.current.selectedAutomationRun).toBeNull();

    Object.defineProperty(window, 'confirm', { configurable: true, value: vi.fn(() => false) });
    await act(async () => result.current.handleDeleteAutomation('automation-1'));
    Object.defineProperty(window, 'confirm', { configurable: true, value: vi.fn(() => true) });
    await act(async () => result.current.handleDeleteAutomation('automation-1'));
    expect(result.current.selectedAutomationId).toBeNull();
    bridge.set('automationsRunNow', () => Promise.reject('run failed'));
    await act(async () => result.current.handleRunAutomationNow('automation-1'));
  });

  it('deduplicates picked and pasted grants, releases staging selections, and covers file-name fallbacks', async () => {
    const picked = { grantId: 'same', name: 'same.txt', sizeBytes: 1, modifiedAt: '2026-08-10', type: 'text/plain' };
    const bridge = installControllerBridge({
      filesPickForChat: [picked, picked],
      filesStageForChat: { ...picked, staged: true },
      filesReleaseSelections: () => Promise.reject(new Error('already released')),
      filesListCategories: [{ path: 'parent/name', name: 'Category', parentPath: 'parent' }],
    });
    const { result } = await renderControllerHarness(bridge);
    await act(async () => result.current.handlePickChatFiles());
    await act(async () => result.current.handlePickChatFiles());
    await act(async () => result.current.handleStagePastedChatFile({ name: 'same.txt', type: 'text/plain', bytes: new Uint8Array([1]) }));
    expect(result.current.pendingChatFiles).toHaveLength(1);
    act(() => result.current.handleRemovePendingChatFile('same'));
    await waitFor(() => expect(bridge.call('filesReleaseSelections')).toHaveBeenCalled());

    act(() => result.current.openRenameCategoryDialog('parent/name'));
    expect(result.current.renameCategoryDialog.name).toBe('Category');
    act(() => result.current.openRenameCategoryDialog('unknown/fallback'));
    expect(result.current.renameCategoryDialog.name).toBe('fallback');
    act(() => result.current.openCreateCategoryDialog(undefined, true));
    act(() => result.current.setCategoryDialogName('Created'));
    bridge.set('filesCreateCategory', { path: 'created', name: 'Created', parentPath: '' });
    await act(async () => result.current.handleCreateCategorySubmit());
    expect(result.current.uploadCategoryPath).toBe('created');
  });
});
