import { act, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  installControllerBridge,
  renderControllerHarness,
  resetControllerHarness,
} from './helpers/renderer-app-controller-harness';

beforeEach(resetControllerHarness);

const socialApp = (overrides: Record<string, unknown> = {}) => ({
  id: 7, slug: 'shared-app', name: 'Shared App', shortDescription: 'Short description',
  visibility: 'public', status: 'published', owner: { id: 2, username: 'alice', displayName: 'Alice' },
  averageReviewScore: 4, reviewsCount: 3,
  latestVersion: { id: 9, version: '2.0.0', runtimeStack: 'vite-fastapi-sqlite', supportedPlatforms: ['darwin'], capabilities: [], checksumSha256: 'abc', fileSizeBytes: 10 },
  ...overrides,
});

const quarantine = {
  quarantineId: 'quarantine-1', userAppId: 7, localAppId: 'social-alice-shared-app', status: 'pending_review',
  name: 'Shared App', slug: 'shared-app', version: '2.0.0', zipPath: '/tmp/app.zip', stagedDir: '/tmp/staged',
  createdAt: '2026-08-10', updatedAt: '2026-08-10',
};

describe('RendererAppController Social app variants', () => {
  it('builds minimal, installed, and updateable Social details with safe fallback identifiers', async () => {
    const installed = {
      id: 'social-alice-shared-app', name: 'Installed custom name', description: 'Installed description', category: 'finance',
      status: 'installed', version: '1.0.0', socialSource: { ownerUsername: 'alice', slug: 'shared-app' },
    };
    const bridge = installControllerBridge({ listInstalledApps: [installed] });
    const { result } = await renderControllerHarness(bridge);
    act(() => result.current.handleOpenSocialApp(socialApp({
      description: 'Long description', category: 'productivity',
      latestVersion: { ...socialApp().latestVersion, capabilities: ['files'], platformCapabilities: { files: { required: true } }, tools: [], promptTemplates: [], agents: [] },
    }) as never));
    expect(result.current.selectedAppDetails).toEqual(expect.objectContaining({ installed: true, updateAvailable: true }));
    expect(result.current.selectedAppDetails?.app.name).toBe('Installed custom name');

    act(() => result.current.handleOpenSocialApp(socialApp({
      id: 8, slug: '!!!', name: 'Fallback', description: undefined, shortDescription: undefined,
      owner: { id: 3, username: '***', displayName: '' }, latestVersion: undefined,
    }) as never));
    expect(result.current.selectedAppDetails?.social?.localAppId).toBe('social-user-app');
    expect(result.current.selectedAppDetails?.app.description).toContain('Forger Social');
  });

  it('recovers review-gate loading and ignores empty or closed review decisions', async () => {
    const account = { success: true, authenticated: true, user: { id: 1, email: 'user@example.com', username: 'user', confirmed: true } };
    const bridge = installControllerBridge({
      getForgerAccount: account,
      listCatalogApps: [{ id: 'social-alice-shared-app', name: 'Shared App', category: 'productivity', socialUserAppId: 7 }],
      getAppToolsInstallGate: () => Promise.reject(new Error('gate unavailable')),
    });
    const { result } = await renderControllerHarness(bridge);
    await act(async () => result.current.handleSocialInstallReviewDecision('reviewed'));
    await act(async () => result.current.handleInstall('social-alice-shared-app'));
    expect(result.current.socialInstallReviewDialog.open).toBe(true);
    expect(result.current.socialInstallReviewDialog.gate).toBeNull();
    act(() => result.current.closeSocialInstallReviewDialog());
    expect(result.current.socialInstallReviewDialog.open).toBe(false);
  });

  it('keeps a failed review open, handles a missing quarantine, and opens provider setup when review preparation succeeds', async () => {
    const account = { success: true, authenticated: true, user: { id: 1, email: 'user@example.com', username: 'user', confirmed: true } };
    const bridge = installControllerBridge({
      getForgerAccount: account,
      listCatalogApps: [{ id: 'social-alice-shared-app', name: 'Shared App', category: 'productivity', socialUserAppId: 7 }],
      getAppToolsInstallGate: null,
      prepareSocialAppReview: { success: false, userMessage: 'Review unavailable', technicalCode: 'review_failed' },
    });
    const { result } = await renderControllerHarness(bridge);
    await act(async () => result.current.handleInstall('social-alice-shared-app'));
    await act(async () => result.current.handleSocialInstallReviewDecision('reviewed'));
    expect(result.current.socialInstallReviewDialog.open).toBe(true);

    bridge.set('prepareSocialAppReview', { success: true, userMessage: 'Missing quarantine' });
    await act(async () => result.current.handleSocialInstallReviewDecision('reviewed'));
    expect(result.current.bannerSeverity).toBe('error');

    bridge.set('prepareSocialAppReview', { success: true, userMessage: 'Review ready', quarantine: { ...quarantine, ownerUsername: undefined } });
    await act(async () => result.current.handleSocialInstallReviewDecision('reviewed'));
    expect(result.current.activeConversation?.mode).toBe('social_app_review');
    expect(bridge.call('chatStartRun')).not.toHaveBeenCalled();
  });

  it('shows a chat error when an authenticated reviewed install cannot start its agent run', async () => {
    const bridge = installControllerBridge({
      getForgerAccount: { success: true, authenticated: true, user: { id: 1, email: 'user@example.com', confirmed: true } },
      getCodexAuthStatus: { installed: true, authenticated: true, authFilePath: '/tmp/auth', codexHome: '/tmp/codex' },
      listCatalogApps: [{ id: 'social-alice-shared-app', name: 'Shared App', category: 'productivity', socialUserAppId: 7 }],
      prepareSocialAppReview: { success: true, userMessage: 'Review ready', quarantine },
      chatStartRun: () => Promise.reject('start failed'),
    });
    const { result } = await renderControllerHarness(bridge);
    await act(async () => result.current.handleInstall('social-alice-shared-app', 'reviewed'));
    expect(result.current.chatMessages.at(-1)?.role).toBe('assistant');
    expect(result.current.activeConversationRunActive).toBe(false);
  });

  it('handles skipped-review install failures and Social update success and conflicts', async () => {
    const account = { success: true, authenticated: true, user: { id: 1, email: 'user@example.com', confirmed: true } };
    const bridge = installControllerBridge({
      getForgerAccount: account,
      listCatalogApps: [{ id: 'social-alice-shared-app', name: 'Shared App', category: 'productivity', socialUserAppId: 7 }],
      installSocialApp: { success: false, userMessage: 'Install failed', technicalCode: 'social_install_failed' },
    });
    const { result } = await renderControllerHarness(bridge);
    await act(async () => result.current.handleInstall('social-alice-shared-app', 'skipped_review'));
    expect(result.current.bannerSeverity).toBe('error');

    act(() => result.current.handleOpenSocialApp(socialApp() as never));
    bridge.set('installSocialApp', { success: true, userMessage: 'Updated', appId: 'social-alice-shared-app' });
    await act(async () => result.current.handleUpdate('social-alice-shared-app'));
    expect(result.current.selectedAppId).toBe('social-alice-shared-app');
    act(() => result.current.handleOpenSocialApp(socialApp() as never));
    bridge.set('installSocialApp', { success: false, phase: 'conflict', userMessage: 'Conflict', technicalCode: 'social_update_conflict' });
    await act(async () => result.current.handleUpdate('social-alice-shared-app'));
    expect(result.current.bannerSeverity).toBe('warning');
  });

  it('recovers Social upload and rename failures and guards empty dialogs and busy submissions', async () => {
    const app = { id: 'local', name: 'Local', category: 'productivity', status: 'installed', privateLocal: true };
    const bridge = installControllerBridge({ listInstalledApps: [app] });
    const { result } = await renderControllerHarness(bridge);
    await act(async () => result.current.submitSocialUploadDialog());
    act(() => result.current.handleUploadSocial('local'));
    bridge.set('uploadSocialApp', { success: false, userMessage: 'Upload failed', technicalCode: 'upload_failed' });
    await act(async () => result.current.submitSocialUploadDialog());
    await waitFor(() => expect(result.current.bannerSeverity).toBe('error'));
    bridge.set('uploadSocialApp', () => Promise.reject('upload exploded'));
    await act(async () => result.current.uploadSocialApp('local', 'private'));

    act(() => result.current.handleRenameApp('local'));
    act(() => result.current.setRenameAppName('   '));
    await act(async () => result.current.submitRenameAppDialog());
    act(() => result.current.setRenameAppName('New name'));
    bridge.set('renameInstalledApp', { success: false, userMessage: 'Rename failed', technicalCode: 'rename_failed' });
    await act(async () => result.current.submitRenameAppDialog());
    expect(result.current.renameAppDialog.open).toBe(true);

    const pending = Promise.withResolvers<{ success: boolean; userMessage: string; cloudSynced: boolean }>();
    bridge.set('renameInstalledApp', () => pending.promise);
    let renaming!: Promise<void>;
    act(() => { renaming = result.current.submitRenameAppDialog(); });
    await waitFor(() => expect(result.current.renameAppDialog.busy).toBe(true));
    await act(async () => result.current.submitRenameAppDialog());
    act(() => result.current.closeRenameAppDialog());
    expect(result.current.renameAppDialog.open).toBe(true);
    pending.resolve({ success: true, userMessage: 'Renamed with warning', cloudSynced: false });
    await act(async () => renaming);
  });
});
