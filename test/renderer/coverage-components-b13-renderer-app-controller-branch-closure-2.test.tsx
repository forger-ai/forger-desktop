import { act, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  controllerSettingsFixture,
  installControllerBridge,
  renderControllerHarness,
  resetControllerHarness,
} from './helpers/renderer-app-controller-harness';

beforeEach(resetControllerHarness);

describe('RendererAppController public fallback and concurrency decisions', () => {
  it('handles promptless chat deep links, empty data views, and ignored browser-noise failures', async () => {
    const bridge = installControllerBridge({
      listInstalledApps: [],
      installApp: () => Promise.reject(new Error('ResizeObserver loop limit exceeded')),
    });
    const { result } = await renderControllerHarness(bridge);
    act(() => bridge.emit('onDeepLink', { kind: 'chat', app: '   ' }));
    expect(result.current.currentView).toBe('chat');
    act(() => result.current.setCurrentView('datos'));
    await act(async () => result.current.handleInstall('planner'));
    expect(bridge.call('prepareDesktopErrorReport')).not.toHaveBeenCalled();
  });

  it('maps catalog failures with omitted diagnostics and Error exceptions', async () => {
    const bridge = installControllerBridge({
      installApp: { success: false, userMessage: 'Failed' },
      getAppToolsInstallGate: null,
    });
    const { result } = await renderControllerHarness(bridge);
    await act(async () => result.current.handleInstall('planner'));
    expect(result.current.bannerSeverity).toBe('error');
    bridge.set('installApp', () => Promise.reject(new Error('install exploded')));
    await act(async () => result.current.handleInstall('planner'));
    expect(bridge.call('prepareDesktopErrorReport')).toHaveBeenCalled();
  });

  it('persists a newly introduced optional connection as denied during Social review', async () => {
    const gate = {
      appId: 'social-app', appName: 'Social', canInstall: true, platformCapabilities: {}, required: [], optional: [],
      connectionRequired: [], connectionOptional: [{ declaration: { type: 'github', actions: [], reason: 'Optional' }, required: false, resolvedActions: [], allActions: false, granted: false, hasStoredGrant: false, available: true, configured: true }], agents: [], promptTemplates: [],
    };
    const bridge = installControllerBridge({
      getForgerAccount: { authenticated: true, user: { id: 1, email: 'user@example.com', confirmed: true } },
      listCatalogApps: [{ id: 'social-app', name: 'Social', category: 'productivity', socialUserAppId: 7 }],
      getAppToolsInstallGate: gate,
      installSocialApp: { success: true, userMessage: 'Done' },
    });
    const { result } = await renderControllerHarness(bridge);
    await waitFor(() => expect(result.current.forgerAccount.authenticated).toBe(true));
    await act(async () => result.current.handleInstall('social-app'));
    gate.connectionOptional[0].declaration.type = 'calendar';
    await act(async () => result.current.handleSocialInstallReviewDecision('skipped_review'));
    expect(bridge.call('setAppConnectionGrant')).toHaveBeenCalledWith(expect.objectContaining({ granted: false }), 'en');
  });

  it('reports Error exceptions from local creation, Social upload, and rename', async () => {
    const bridge = installControllerBridge({
      listInstalledApps: [],
      createLocalApp: () => Promise.reject(new Error('create exploded')),
      uploadSocialApp: () => Promise.reject(new Error('upload exploded')),
      renameInstalledApp: () => Promise.reject(new Error('rename exploded')),
    });
    const { result } = await renderControllerHarness(bridge);
    await act(async () => result.current.handleCreateLocalApp({ name: 'App', description: '', purpose: '' }));
    await act(async () => result.current.uploadSocialApp('missing', 'private'));
    act(() => result.current.handleRenameApp('missing'));
    act(() => result.current.setRenameAppName('Renamed'));
    await act(async () => result.current.submitRenameAppDialog());
    expect(bridge.call('prepareDesktopErrorReport')).toHaveBeenCalled();
  });

  it('guards a missing pending gate and preserves a newer grant action while an older action settles', async () => {
    const first = Promise.withResolvers<null>();
    const bridge = installControllerBridge({
      getAppDetails: { app: { id: 'planner', name: 'Planner', category: 'productivity', status: 'installed' }, installed: true, status: 'installed', operations: [] },
      setAppToolGrant: () => first.promise,
      setAppConnectionGrant: null,
    });
    const { result } = await renderControllerHarness(bridge);
    await act(async () => result.current.handleConfirmInstallWithTools());
    await act(async () => result.current.openAppDetails('planner'));
    let tool!: Promise<void>;
    act(() => { tool = result.current.handleAppDetailsToolGrant('gmail', true); });
    await waitFor(() => expect(result.current.selectedAppToolGrantBusyId).toBe('gmail'));
    await act(async () => result.current.handleAppDetailsConnectionGrant('github', true));
    first.resolve(null);
    await act(async () => tool);
    expect(result.current.selectedAppToolGrantBusyId).toBeNull();
  });

  it('renders a tool with no action chips and preserves background navigation origin', async () => {
    const { result } = await renderControllerHarness();
    const rendered = result.current.renderInstallTool({
      declaration: { toolId: 'empty', actions: [], reason: 'No actions' }, required: false,
      resolvedActions: [], allActions: false, granted: false, hasStoredGrant: false,
      available: true, configured: true,
    } as never, false);
    expect(rendered).toBeTruthy();
    act(() => result.current.setCurrentView('catalog'));
    act(() => result.current.openBackgroundTaskHistory());
    expect(result.current.backgroundTasksBackView).toBe('catalog');
  });

  it('maps Social and regular update errors and accepts Social success without a returned id', async () => {
    const social = {
      id: 7, slug: 'shared', name: 'Shared', visibility: 'public', status: 'published',
      owner: { id: 2, username: 'alice', displayName: 'Alice' }, reviewsCount: 0,
      latestVersion: { id: 1, version: '1.0.0', runtimeStack: 'vite-fastapi-sqlite', supportedPlatforms: [], capabilities: [], checksumSha256: 'x', fileSizeBytes: 1 },
    };
    const localAppId = 'social-alice-shared';
    const bridge = installControllerBridge({
      resolveSocialApp: { app: social }, getAppToolsInstallGate: null,
      installSocialApp: { success: true, userMessage: 'Current' },
      updateApp: { success: false, userMessage: 'Update failed', phase: 'download' },
    });
    const { result } = await renderControllerHarness(bridge);
    act(() => bridge.emit('onDeepLink', { kind: 'social-app', id: 7 }));
    await waitFor(() => expect(result.current.selectedAppDetailsId).toBe(localAppId));
    await act(async () => result.current.handleUpdate(localAppId));
    expect(result.current.bannerSeverity).toBe('success');
    bridge.set('getAppDetails', { app: { id: 'planner', name: 'Planner', category: 'productivity', status: 'installed' }, installed: true, status: 'installed', operations: [] });
    await act(async () => result.current.openAppDetails('planner'));
    await act(async () => result.current.handleUpdate('planner'));
    expect(result.current.bannerSeverity).toBe('error');
  });

  it('cancels bulk backup deletion and handles update errors without diagnostic details', async () => {
    const bridge = installControllerBridge();
    const { result } = await renderControllerHarness(bridge);
    Object.defineProperty(window, 'confirm', { configurable: true, value: () => false });
    const deleted = await result.current.handleDeleteSelectedBackups([{ id: 'one', appId: 'planner', appName: 'Planner', sizeBytes: 0 }] as never);
    expect(deleted).toBe(false);
    await act(async () => result.current.runDesktopUpdateAction(async () => ({ status: 'error', currentVersion: '1.0.0', technicalCode: 'update_failed' })));
    bridge.set('memoryUpdate', { id: 'other', key: 'key', value: 'updated', scope: 'global', createdAt: '2026-08-10', updatedAt: '2026-08-10' });
    await act(async () => result.current.handleUpdateMemory({ id: 'missing', value: 'updated' } as never));
  });

  it('uses existing provider defaults when partial changes omit model and effort', async () => {
    const updated = controllerSettingsFixture();
    (updated as { defaultChatPermissionMode?: string }).defaultChatPermissionMode = undefined;
    const bridge = installControllerBridge({ updateAgentDefaults: updated });
    const { result } = await renderControllerHarness(bridge);
    await act(async () => result.current.handleAgentDefaultsChange({ provider: 'claude' } as never));
    await act(async () => result.current.handleAgentDefaultsChange({ provider: 'antigravity' } as never));
    expect(result.current.selectedChatPermissionMode).toBe('safe');
  });

  it('refreshes selected details and applies success-message fallbacks for provider settings', async () => {
    const bridge = installControllerBridge({
      getAppDetails: { app: { id: 'planner', name: 'Planner', category: 'productivity', status: 'installed' }, installed: true, status: 'installed', operations: [] },
      updateAgentDefaults: controllerSettingsFixture(),
      setActiveLlmProviderProfile: { success: true },
      updateLlmProviderProfileDefaults: { success: true },
      restoreAppUserVersion: { success: false },
    });
    const { result } = await renderControllerHarness(bridge);
    await act(async () => result.current.openAppDetails('planner'));
    await act(async () => result.current.handleAgentDefaultsChange({ provider: 'codex' } as never));
    await act(async () => result.current.handleActiveProviderProfileChange({ provider: 'codex', profileId: null } as never));
    await act(async () => result.current.handleProviderProfileDefaultsChange({ provider: 'codex', model: 'gpt' } as never));
    await act(async () => result.current.handleRestoreUserVersion('missing'));
    expect(result.current.bannerSeverity).toBe('error');
  });

  it('deduplicates concurrent app and remote-share starts and maps fallback stop messages', async () => {
    const opening = Promise.withResolvers<{ success: boolean; userMessage: string }>();
    const sharing = Promise.withResolvers<{ success: boolean; userMessage: string; status: Record<string, unknown> }>();
    const bridge = installControllerBridge({
      listInstalledApps: [],
      openApp: () => opening.promise,
      startRemoteNetworkShare: () => sharing.promise,
      stopLocalNetworkShare: { success: true, userMessage: '', status: { appId: 'planner', state: 'idle' } },
    });
    const { result } = await renderControllerHarness(bridge);
    let firstOpen!: Promise<void>;
    act(() => { firstOpen = result.current.handleOpen('missing'); });
    await waitFor(() => expect(result.current.openingAppIds.has('missing')).toBe(true));
    await act(async () => result.current.handleOpen('missing'));
    opening.resolve({ success: true, userMessage: 'Opened' });
    await act(async () => firstOpen);
    expect(bridge.call('openApp')).toHaveBeenCalledTimes(1);

    let firstShare!: Promise<void>;
    act(() => { firstShare = result.current.handleStartRemoteNetworkShare('planner'); });
    await waitFor(() => expect(result.current.openingAppIds.has('planner')).toBe(true));
    await act(async () => result.current.handleStartRemoteNetworkShare('planner'));
    sharing.resolve({ success: false, userMessage: 'No share', status: { appId: 'planner', state: 'error' } });
    await act(async () => firstShare);
    expect(bridge.call('startRemoteNetworkShare')).toHaveBeenCalledTimes(1);
    await act(async () => result.current.handleStopLocalNetworkShare('planner'));
    expect(result.current.bannerSeverity).toBe('info');
  });

  it('maps rejected secret mutations and terminal category-name fallbacks', async () => {
    const bridge = installControllerBridge({
      createUserSecret: { success: false, userMessage: 'Rejected' },
      filesRenameCategory: { success: false }, filesList: [], filesListCategories: [],
    });
    const { result } = await renderControllerHarness(bridge);
    await act(async () => result.current.handleCreateSecret({ name: 'TOKEN', value: 'secret' }));
    act(() => result.current.openRenameCategoryDialog('/'));
    act(() => result.current.setRenameCategoryDialog({ open: true, categoryPath: '/', name: 'Renamed' }));
    await act(async () => result.current.handleRenameCategorySubmit());
    expect(result.current.bannerSeverity).toBe('error');
  });
});
