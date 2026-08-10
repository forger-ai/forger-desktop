import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { AppDetails, AppStatus, InstallAppResult } from '@shared/types';
import { en } from '@renderer/i18n/en';

import { AppViewActions } from '@renderer/views/app-view/AppViewActions';

const details = (
  status: AppStatus,
  overrides: Partial<AppDetails> = {},
  appOverrides: Partial<AppDetails['app']> = {},
): AppDetails => ({
  app: {
    id: 'app-1',
    category: 'productivity',
    status,
    ...appOverrides,
  },
  installed: status !== 'not_installed' && status !== 'installing',
  status,
  operations: [],
  ...overrides,
});

const handlers = () => ({
  onInstall: vi.fn(),
  onUpdate: vi.fn(),
  onOpen: vi.fn(),
  onStop: vi.fn(),
  onRestoreUserVersion: vi.fn(),
  onResolveConflict: vi.fn(),
  onDelete: vi.fn(),
  onStartLocalNetworkShare: vi.fn(),
  onStartRemoteNetworkShare: vi.fn(),
  onStopRemoteNetworkShare: vi.fn(),
  onUploadSocial: vi.fn(),
  onRenameApp: vi.fn(),
});

const renderActions = (appDetails: AppDetails, options: { installProgress?: InstallAppResult; isOpening?: boolean } = {}) => {
  const callbacks = handlers();
  const component = (nextDetails: AppDetails, nextOptions: { installProgress?: InstallAppResult; isOpening?: boolean } = {}) => (
    <AppViewActions
      appId="app-1"
      details={nextDetails}
      installProgress={nextOptions.installProgress}
      isOpening={nextOptions.isOpening ?? false}
      t={en}
      {...callbacks}
    />
  );
  const view = render(component(appDetails, options));
  return {
    ...view,
    ...callbacks,
    rerenderActions: (nextDetails: AppDetails, nextOptions?: { installProgress?: InstallAppResult; isOpening?: boolean }) =>
      view.rerender(component(nextDetails, nextOptions)),
  };
};

describe('AppViewActions', () => {
  it('installs a missing app and represents both installation signals as busy', async () => {
    const view = renderActions(details('not_installed'));
    await userEvent.click(screen.getByRole('button', { name: en.actions.install }));
    expect(view.onInstall).toHaveBeenCalledWith('app-1');
    expect(screen.queryByRole('button', { name: en.actions.delete })).not.toBeInTheDocument();

    view.rerenderActions(details('installing'));
    expect(screen.getByRole('button', { name: en.actions.installing })).toBeDisabled();

    view.rerenderActions(details('installed'), { installProgress: {} as InstallAppResult });
    expect(screen.getByRole('button', { name: en.actions.installing })).toHaveAttribute('aria-busy', 'true');
  });

  it('offers both safe conflict recovery paths and deletion', async () => {
    const view = renderActions(details('conflict'));
    await userEvent.click(screen.getByRole('button', { name: en.actions.resolveWithForger }));
    await userEvent.click(screen.getByRole('button', { name: en.actions.restoreUserVersion }));
    await userEvent.click(screen.getByRole('button', { name: en.actions.delete }));

    expect(view.onResolveConflict).toHaveBeenCalledWith('app-1');
    expect(view.onRestoreUserVersion).toHaveBeenCalledWith('app-1');
    expect(view.onDelete).toHaveBeenCalledWith('app-1');
  });

  it('retries install failures and recovers update failures', async () => {
    const installFailure = renderActions(details('error', {}, { lastErrorOperation: 'install' }));
    await userEvent.click(screen.getByRole('button', { name: en.actions.retry }));
    expect(installFailure.onInstall).toHaveBeenCalledWith('app-1');
    expect(screen.getByRole('button', { name: en.actions.askForgerHelp })).toBeDisabled();
    installFailure.unmount();

    const updateFailure = renderActions(details('error', {}, { lastErrorOperation: 'update' }));
    await userEvent.click(screen.getByRole('button', { name: en.actions.update }));
    expect(updateFailure.onUpdate).toHaveBeenCalledWith('app-1');
    expect(screen.getByRole('button', { name: en.actions.delete })).toBeVisible();
  });

  it('opens and stops ordinary apps without an action menu', async () => {
    const stopped = renderActions(details('installed'));
    await userEvent.click(screen.getByRole('button', { name: en.actions.open }));
    expect(stopped.onOpen).toHaveBeenCalledWith('app-1');
    expect(screen.queryByRole('button', { name: `${en.actions.open} menu` })).not.toBeInTheDocument();
    stopped.unmount();

    const running = renderActions(details('running'));
    await userEvent.click(screen.getByRole('button', { name: en.actions.stop }));
    expect(running.onStop).toHaveBeenCalledWith('app-1');
    expect(screen.queryByRole('button', { name: `${en.actions.stop} menu` })).not.toBeInTheDocument();
  });

  it('runs every available action from a running app menu and closes it explicitly', async () => {
    const view = renderActions(details('running', { updateAvailable: true }, {
      localNetworkShareSupported: true,
      remoteTunnelSupported: true,
      remoteNetworkShare: { active: true, state: 'connected' },
      privateLocal: true,
    }));
    const menuButton = screen.getByRole('button', { name: `${en.actions.stop} menu` });
    expect(menuButton).toHaveAttribute('aria-expanded', 'false');

    const actions = [
      [en.social.renameAppAction, view.onRenameApp],
      [en.localNetwork.menuAction, view.onStartLocalNetworkShare],
      [en.remoteNetwork.menuAction, view.onStartRemoteNetworkShare],
      [en.remoteNetwork.stop, view.onStopRemoteNetworkShare],
      [en.social.uploadTitle, view.onUploadSocial],
    ] as const;
    for (const [label, callback] of actions) {
      await userEvent.click(menuButton);
      expect(menuButton).toHaveAttribute('aria-expanded', 'true');
      await userEvent.click(screen.getByRole('menuitem', { name: label }));
      expect(callback).toHaveBeenLastCalledWith('app-1');
    }

    await userEvent.click(menuButton);
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: en.actions.stop }));
    await userEvent.click(screen.getByRole('button', { name: en.actions.update }));
    expect(view.onStop).toHaveBeenCalledWith('app-1');
    expect(view.onUpdate).toHaveBeenCalledWith('app-1');
  });

  it('opens recoverable runtime errors and exposes social-source actions', async () => {
    const view = renderActions(details('error', { updateAvailable: true }, {
      lastErrorOperation: 'runtime',
      socialSource: { userAppId: 1, slug: 'shared-app', ownerUsername: 'ada' },
    }));
    await userEvent.click(screen.getByRole('button', { name: en.actions.open }));
    expect(view.onOpen).toHaveBeenCalledWith('app-1');

    const menuButton = screen.getByRole('button', { name: `${en.actions.open} menu` });
    await userEvent.click(menuButton);
    expect(screen.getByRole('menuitem', { name: en.social.renameAppAction })).toBeVisible();
    expect(screen.getByRole('menuitem', { name: en.social.uploadTitle })).toBeVisible();
    expect(screen.queryByRole('menuitem', { name: en.remoteNetwork.stop })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('menuitem', { name: en.social.renameAppAction }));
    expect(view.onRenameApp).toHaveBeenCalledWith('app-1');
    await userEvent.click(menuButton);
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
  });

  it('disables the split open action while opening and keeps a stopped update action', async () => {
    const opening = renderActions(details('installed', {}, { privateLocal: true }), { isOpening: true });
    expect(screen.getByRole('button', { name: en.actions.opening })).toBeDisabled();
    expect(screen.getByRole('button', { name: `${en.actions.opening} menu` })).toBeDisabled();
    opening.unmount();

    const update = renderActions(details('installed', { updateAvailable: true }, {
      remoteTunnelSupported: true,
      remoteNetworkShare: { active: true, state: 'closed' },
    }));
    await userEvent.click(screen.getByRole('button', { name: en.actions.update }));
    expect(update.onUpdate).toHaveBeenCalledWith('app-1');
    expect(screen.queryByRole('menuitem', { name: en.remoteNetwork.stop })).not.toBeInTheDocument();
  });

  it('does not offer remote stop for inactive or disconnected shares', () => {
    const inactive = renderActions(details('installed', {}, {
      remoteTunnelSupported: true,
      remoteNetworkShare: { active: true, state: 'inactive' },
    }));
    expect(screen.getByRole('button', { name: `${en.actions.open} menu` })).toBeVisible();
    inactive.unmount();

    renderActions(details('installed', {}, {
      remoteTunnelSupported: true,
      remoteNetworkShare: { active: false, state: 'connected' },
    }));
    expect(screen.getByRole('button', { name: `${en.actions.open} menu` })).toBeVisible();
  });
});
