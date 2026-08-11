import { act, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  installControllerBridge,
  renderControllerHarness,
  resetControllerHarness,
} from './helpers/renderer-app-controller-harness';

beforeEach(resetControllerHarness);

const emptyGate = (overrides: Record<string, unknown> = {}) => ({
  appId: 'planner', appName: 'Planner', canInstall: true, platformCapabilities: {}, required: [], optional: [],
  connectionRequired: [], connectionOptional: [], agents: [], promptTemplates: [], ...overrides,
});

describe('RendererAppController optional result branches', () => {
  it('closes busy Social review safely and persists default optional tool and connection choices', async () => {
    const gate = emptyGate({
      optional: [{ declaration: { toolId: 'tool', actions: [], reason: 'Optional' }, required: false, resolvedActions: [], allActions: false, granted: false, hasStoredGrant: false, available: true, configured: true }],
      connectionOptional: [{ declaration: { type: 'slack', actions: [], reason: 'Optional' }, required: false, resolvedActions: [], allActions: false, granted: false, hasStoredGrant: false, configured: true, instances: [] }],
    });
    const pending = Promise.withResolvers<unknown>();
    const bridge = installControllerBridge({
      getForgerAccount: { authenticated: true, user: { id: 1, email: 'user@example.com', confirmed: true } },
      listCatalogApps: [{ id: 'planner', name: 'Planner', category: 'productivity', socialUserAppId: 7 }],
      getAppToolsInstallGate: gate,
      setAppToolGrant: () => pending.promise,
      setAppConnectionGrant: gate,
      prepareSocialAppReview: { success: false, userMessage: 'No review', technicalCode: 'review_failed' },
    });
    const { result } = await renderControllerHarness(bridge);
    await act(async () => result.current.handleInstall('planner'));
    let deciding!: Promise<void>;
    act(() => { deciding = result.current.handleSocialInstallReviewDecision('reviewed'); });
    await waitFor(() => expect(result.current.socialInstallReviewDialog.busy).toBe(true));
    act(() => result.current.closeSocialInstallReviewDialog());
    expect(result.current.socialInstallReviewDialog.open).toBe(true);
    await act(async () => result.current.handleSocialInstallReviewDecision('reviewed'));
    pending.resolve(gate);
    await act(async () => deciding);
  });

  it('handles creation and upload success payloads with absent optional app, message, deep-link, and catalog metadata', async () => {
    const bridge = installControllerBridge({
      createLocalApp: { success: true, userMessage: 'Created without app' },
      uploadSocialApp: { success: true },
      listInstalledApps: [],
    });
    const { result } = await renderControllerHarness(bridge);
    await act(async () => result.current.handleCreateLocalApp({ name: 'Missing', description: '', purpose: '' }));
    act(() => result.current.handleUploadSocial('unknown-app'));
    expect(result.current.socialUploadDialog.name).toBe('unknown-app');
    await act(async () => result.current.submitSocialUploadDialog());
    await waitFor(() => expect(result.current.bannerSeverity).toBe('success'));
  });

  it('updates selected app details, maps rename cloud warnings, and syncs pending install grants', async () => {
    const gate = emptyGate({
      optional: [{ declaration: { toolId: 'tool', actions: [], reason: 'Optional' }, required: false, resolvedActions: [], allActions: false, granted: true, hasStoredGrant: true, available: true, configured: true }],
      connectionOptional: [{ declaration: { type: 'slack', actions: [], reason: 'Optional' }, required: false, resolvedActions: [], allActions: false, granted: true, hasStoredGrant: true, configured: true, instances: [] }],
    });
    const bridge = installControllerBridge({
      listInstalledApps: [{ id: 'planner', name: 'Planner', category: 'productivity', status: 'installed', publishedSocialSource: { ownerUsername: 'alice', slug: 'planner' } }],
      getAppToolsInstallGate: gate, setAppToolGrant: gate, setAppConnectionGrant: gate,
      renameInstalledApp: { success: true, cloudSynced: false, technicalCode: 'cloud_sync_failed', userMessage: 'Renamed locally' },
    });
    const { result } = await renderControllerHarness(bridge);
    await act(async () => result.current.handleInstall('planner'));
    await act(async () => result.current.openAppDetails('planner'));
    await act(async () => result.current.handleAppDetailsToolGrant('tool', false));
    await act(async () => result.current.handleAppDetailsConnectionGrant('slack', false));
    act(() => result.current.handleRenameApp('planner'));
    act(() => result.current.setRenameAppName('Renamed'));
    await act(async () => result.current.submitRenameAppDialog());
    expect(result.current.bannerSeverity).toBe('warning');
  });

  it('maps catalog conflicts, public and unknown deletions, selected-detail deletion, and failed uninstall results', async () => {
    const bridge = installControllerBridge({
      listInstalledApps: [
        { id: 'public', name: 'Public', category: 'productivity', status: 'installed' },
        { id: 'selected', name: 'Selected', category: 'productivity', status: 'installed' },
      ],
      listCatalogApps: [{ id: 'public', name: 'Public', category: 'productivity' }, { id: 'selected', name: 'Selected', category: 'productivity' }],
      updateApp: { success: false, phase: 'conflict', userMessage: 'Conflict' },
      uninstallApp: { success: false, userMessage: 'Delete failed' },
    });
    const { result } = await renderControllerHarness(bridge);
    await act(async () => result.current.handleUpdate('public'));
    expect(result.current.bannerSeverity).toBe('warning');
    await act(async () => result.current.handleDeleteApp('unknown'));
    await act(async () => result.current.openAppDetails('selected'));
    await act(async () => result.current.handleDeleteApp('selected'));
    expect(result.current.currentView).toBe('catalog');
    await act(async () => result.current.handleDeleteApp('public'));
    expect(result.current.bannerSeverity).toBe('error');
  });

  it('maps category/file mutation technical fallbacks and skips post-create selection', async () => {
    const file = { id: 'file', name: 'file.txt', relativePath: 'file.txt', categoryPath: '', sizeBytes: 1, uploadedAt: '2026-08-10', modifiedAt: '2026-08-10', type: 'text/plain' };
    const bridge = installControllerBridge({
      filesCreateCategory: { path: 'category', name: 'Category', parentPath: '' },
      filesRenameCategory: { success: false, technicalCode: 'rename_failed' },
      filesDeleteCategory: { success: false },
      filesRename: { success: true }, filesMove: { success: true }, filesDelete: { success: true },
    });
    const { result } = await renderControllerHarness(bridge);
    act(() => result.current.openCreateCategoryDialog(undefined, false));
    act(() => result.current.setCategoryDialogName('Category'));
    await act(async () => result.current.handleCreateCategorySubmit());
    expect(result.current.uploadCategoryPath).toBe('');
    act(() => result.current.setRenameCategoryDialog({ open: true, categoryPath: 'category', name: 'Renamed' }));
    await act(async () => result.current.handleRenameCategorySubmit());
    await act(async () => result.current.handleDeleteCategory('category'));
    act(() => result.current.openRenameFileDialog(file));
    act(() => result.current.setRenameFileDialog((current: never) => ({ ...(current as object), name: 'renamed.txt' })));
    await act(async () => result.current.handleRenameFileSubmit());
    expect(result.current.bannerSeverity).toBe('error');
    Object.defineProperty(window, 'confirm', { configurable: true, value: vi.fn(() => true) });
  });
});
