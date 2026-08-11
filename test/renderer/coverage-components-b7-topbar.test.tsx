import { createTheme, ThemeProvider } from '@mui/material/styles';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Topbar } from '@renderer/components/Topbar';
import { en } from '@renderer/i18n/en';
import { LAST_SOCIAL_TAB_KEY } from '@renderer/views/friends/socialViewHelpers';
import type { AppDictionary } from '@renderer/i18n';
import type {
  AppSummary,
  CloudStorageUsage,
  ForgerAccountSession,
  RemoteActivityItem,
  RemoteActivitySnapshot,
  WindowControlState,
} from '@shared/types';

vi.mock('@renderer/components/BackgroundTasksDrawer', () => ({
  BackgroundTasksDrawer: ({
    open,
    activeCount,
    onOpen,
    onClose,
    onOpenHistory,
    onOpenTask,
  }: {
    open: boolean;
    activeCount: number;
    onOpen: () => void;
    onClose: () => void;
    onOpenHistory: () => void;
    onOpenTask: (taskId: string) => void;
  }) => (
    <section aria-label="Background task fixture">
      <span>{`${open}:${activeCount}`}</span>
      <button onClick={onOpen}>Open task drawer</button>
      <button onClick={onClose}>Close task drawer</button>
      <button onClick={onOpenHistory}>Task history</button>
      <button onClick={() => onOpenTask('task-1')}>Open task</button>
    </section>
  ),
}));

vi.mock('@renderer/components/LlmRunsDrawer', () => ({
  LlmRunsDrawer: () => <div>LLM run fixture</div>,
}));

const t = en as unknown as AppDictionary;
const signedOut: ForgerAccountSession = { authenticated: false };
const signedIn = (firstName: string | undefined = ' Ada '): ForgerAccountSession => ({
  authenticated: true,
  user: {
    id: 7,
    email: 'ada@example.test',
    firstName,
    confirmed: true,
    subscriptionTier: 'pro',
  },
});

const emptyRemoteActivity = (): RemoteActivitySnapshot => ({
  activities: [],
  activeCount: 0,
  preparingCount: 0,
  errorCount: 0,
  updatedAt: '2026-08-10T10:00:00.000Z',
});

const activity = (
  id: string,
  kind: RemoteActivityItem['kind'],
  state: RemoteActivityItem['state'],
  overrides: Partial<RemoteActivityItem> = {},
): RemoteActivityItem => ({
  id,
  kind,
  state,
  transport: 'remote_tunnel',
  targetId: `target-${id}`,
  targetName: `${kind} ${state} ${id}`,
  startedAt: '2026-08-10T09:00:00.000Z',
  updatedAt: '2026-08-10T10:00:00.000Z',
  ...overrides,
});

const allRemoteStates: RemoteActivitySnapshot = {
  activities: [
    activity('active', 'app', 'active'),
    activity('error', 'app', 'error', {
      requesterMobileDevice: { id: 2, name: 'Ada phone' },
      lastError: 'Tunnel disconnected',
    }),
    activity('preparing', 'app', 'preparing'),
    activity('closed', 'app', 'closed'),
    activity('agent', 'agent', 'active'),
  ],
  activeCount: 2,
  preparingCount: 1,
  errorCount: 1,
  updatedAt: '2026-08-10T10:00:00.000Z',
};

const installForger = ({
  remote = emptyRemoteActivity(),
  windowState = { isMaximized: false, isFullScreen: false, usesCustomFrame: false },
  getRemoteActivity = vi.fn().mockResolvedValue(remote),
  getWindowState = vi.fn().mockResolvedValue(windowState),
}: {
  remote?: RemoteActivitySnapshot;
  windowState?: WindowControlState;
  getRemoteActivity?: ReturnType<typeof vi.fn>;
  getWindowState?: ReturnType<typeof vi.fn>;
} = {}) => {
  let remoteListener: ((snapshot: RemoteActivitySnapshot) => void) | undefined;
  let windowListener: ((state: WindowControlState) => void) | undefined;
  const removeRemoteListener = vi.fn();
  const removeWindowListener = vi.fn();
  const api = {
    getRemoteActivity,
    onRemoteActivityChanged: vi.fn((listener: (snapshot: RemoteActivitySnapshot) => void) => {
      remoteListener = listener;
      return removeRemoteListener;
    }),
    stopRemoteNetworkShare: vi.fn().mockResolvedValue(undefined),
    getWindowState,
    onWindowStateChanged: vi.fn((listener: (state: WindowControlState) => void) => {
      windowListener = listener;
      return removeWindowListener;
    }),
    minimizeWindow: vi.fn().mockResolvedValue(undefined),
    toggleMaximizeWindow: vi.fn().mockResolvedValue(undefined),
    closeWindow: vi.fn().mockResolvedValue(undefined),
  };
  Object.defineProperty(window, 'forger', { configurable: true, value: api });
  return {
    api,
    removeRemoteListener,
    removeWindowListener,
    emitRemote: (snapshot: RemoteActivitySnapshot) => remoteListener?.(snapshot),
    emitWindow: (state: WindowControlState) => windowListener?.(state),
  };
};

const renderTopbar = ({
  currentView = 'chat' as const,
  chatModeLabel = 'Builder',
  dataApps = [] as AppSummary[],
  selectedDataAppId = null as string | null,
  account = signedOut,
  accountBusy = false,
  cloudStorageUsage = null as CloudStorageUsage | null,
  cloudStorageBusy = false,
} = {}) => {
  const handlers = {
    onSelectDataApp: vi.fn(),
    onOpenCloudModal: vi.fn(),
    onOpenStorageSettings: vi.fn(),
    onOpenSocialTab: vi.fn(),
    onLogout: vi.fn(),
    onOpenBackgroundTasks: vi.fn(),
    onCloseBackgroundTasks: vi.fn(),
    onOpenBackgroundTaskHistory: vi.fn(),
    onOpenBackgroundTask: vi.fn(),
  };
  const view = render(
    <ThemeProvider theme={createTheme()}>
      <Topbar
        currentView={currentView}
        t={t}
        chatModeLabel={chatModeLabel}
        dataApps={dataApps}
        selectedDataAppId={selectedDataAppId}
        getAppMeta={(id) => ({
          name: dataApps.find((app) => app.id === id)?.name ?? '',
          description: dataApps.find((app) => app.id === id)?.description ?? '',
        })}
        account={account}
        accountBusy={accountBusy}
        cloudStorageUsage={cloudStorageUsage}
        cloudStorageBusy={cloudStorageBusy}
        backgroundTasks={[]}
        backgroundTasksOpen
        activeBackgroundTaskCount={3}
        {...handlers}
      />
    </ThemeProvider>,
  );
  return { ...view, ...handlers };
};

beforeEach(() => {
  window.sessionStorage.clear();
});

describe('Topbar navigation and menus', () => {
  it('shows chat context, opens cloud for a guest, and forwards task-drawer actions', async () => {
    const user = userEvent.setup();
    installForger();
    const handlers = renderTopbar();

    expect(screen.getByText(t.sections.chat.modeLabel)).toBeInTheDocument();
    expect(screen.getByText('Builder')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: t.cloud.openLabel }));
    expect(handlers.onOpenCloudModal).toHaveBeenCalledOnce();
    expect(screen.getByTestId('PersonRoundedIcon')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Open task drawer' }));
    await user.click(screen.getByRole('button', { name: 'Close task drawer' }));
    await user.click(screen.getByRole('button', { name: 'Task history' }));
    await user.click(screen.getByRole('button', { name: 'Open task' }));
    expect(handlers.onOpenBackgroundTasks).toHaveBeenCalledOnce();
    expect(handlers.onCloseBackgroundTasks).toHaveBeenCalledOnce();
    expect(handlers.onOpenBackgroundTaskHistory).toHaveBeenCalledOnce();
    expect(handlers.onOpenBackgroundTask).toHaveBeenCalledWith('task-1');
    expect(screen.getByText('true:3')).toBeInTheDocument();
    expect(screen.getByText('LLM run fixture')).toBeInTheDocument();
  });

  it('falls back to the pending chat label', () => {
    installForger();
    renderTopbar({ chatModeLabel: null });
    expect(screen.getByText(t.sections.chat.modeSelector.pendingChip)).toBeInTheDocument();
  });

  it('labels the active-app control and selects and clears data apps', async () => {
    const user = userEvent.setup();
    installForger();
    const dataApps: AppSummary[] = [
      { id: 'tasks', category: 'productivity', status: 'installed', name: 'Task Studio' },
      { id: 'notes', category: 'productivity', status: 'installed', name: 'Notes' },
      { id: 'blank', category: 'utilities', status: 'installed', name: '' },
    ];
    const handlers = renderTopbar({ currentView: 'datos', dataApps, selectedDataAppId: 'tasks' });

    const appSelect = screen.getByRole('combobox', { name: t.sections.datos.activeAppLabel });
    expect(appSelect).toHaveTextContent('Task Studio');
    expect(appSelect).toHaveTextContent('TS');
    await user.click(appSelect);
    await user.click(screen.getByRole('option', { name: t.sections.datos.inactiveApp }));
    expect(handlers.onSelectDataApp).toHaveBeenCalledWith(null);

    await user.click(appSelect);
    await user.click(screen.getByRole('option', { name: 'N Notes' }));
    expect(handlers.onSelectDataApp).toHaveBeenCalledWith('notes');

    handlers.unmount();
    renderTopbar({ currentView: 'datos', dataApps, selectedDataAppId: null });
    expect(screen.getByRole('combobox', { name: t.sections.datos.activeAppLabel }))
      .toHaveTextContent(t.sections.datos.inactiveApp);
  });

  it('opens every social destination, persists it, and closes from the keyboard', async () => {
    const user = userEvent.setup();
    installForger();
    const handlers = renderTopbar();
    const social = screen.getByRole('button', { name: 'Social' });
    expect(social).not.toHaveAttribute('aria-expanded');

    for (const [label, tab] of [
      ['Amigos', 'friends'],
      ['Foro', 'forum'],
      ['Mi perfil', 'profile'],
      ['Buscar', 'search'],
    ] as const) {
      await user.click(social);
      expect(social).toHaveAttribute('aria-expanded', 'true');
      await user.click(screen.getByRole('menuitem', { name: label }));
      expect(handlers.onOpenSocialTab).toHaveBeenLastCalledWith(tab);
      expect(window.sessionStorage.getItem(LAST_SOCIAL_TAB_KEY)).toBe(tab);
    }

    await user.click(social);
    await user.keyboard('{Escape}');
    await waitFor(() => expect(social).not.toHaveAttribute('aria-expanded'));
  });
});

describe('Topbar account storage', () => {
  it('shows capped error storage, formats every unit, and invokes account actions', async () => {
    const user = userEvent.setup();
    installForger();
    const cloudStorageUsage: CloudStorageUsage = {
      usedBytes: 12 * 1024 ** 3,
      limitBytes: 10 * 1024 ** 3,
      remainingBytes: 0,
      plan: 'pro',
      breakdown: {
        backupsBytes: 1.5 * 1024 ** 2,
        uploadedAppsBytes: 8 * 1024,
        pendingUserAppUploadsBytes: 2 * 1024,
        otherBytes: 0,
      },
    };
    const handlers = renderTopbar({ account: signedIn(), cloudStorageUsage });
    const accountButton = screen.getByRole('button', { name: t.cloud.openLabel });

    expect(accountButton).toHaveTextContent('A');
    await user.click(accountButton);
    expect(screen.getByText('Ada')).toBeInTheDocument();
    expect(screen.getByText('ada@example.test')).toBeInTheDocument();
    expect(screen.getByText(t.settings.storagePlanLabel('pro'))).toBeInTheDocument();
    expect(screen.getByText(t.settings.storageUsedOfLimit('12 GB', '10 GB'))).toBeInTheDocument();
    expect(screen.getByText(t.settings.storageMenuBreakdown('1.5 MB', '10 KB', '0 MB'))).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100');
    expect(screen.getByRole('progressbar')).toHaveClass('MuiLinearProgress-colorError');

    await user.click(screen.getByRole('button', { name: t.settings.storageManage }));
    expect(handlers.onOpenStorageSettings).toHaveBeenCalledOnce();
    await user.click(accountButton);
    await user.click(screen.getByRole('button', { name: t.cloud.logout }));
    expect(handlers.onLogout).toHaveBeenCalledOnce();
  });

  it('shows loading and unavailable storage, email fallback, busy logout, and warning/primary percentages', async () => {
    const user = userEvent.setup();
    installForger();
    const common: CloudStorageUsage = {
      usedBytes: 85,
      limitBytes: 100,
      remainingBytes: 15,
      plan: 'free',
      breakdown: { backupsBytes: 0, uploadedAppsBytes: 0, pendingUserAppUploadsBytes: 0, otherBytes: 0 },
    };

    const loading = renderTopbar({ account: signedIn('  '), accountBusy: true, cloudStorageBusy: true });
    const accountButton = screen.getByRole('button', { name: t.cloud.openLabel });
    expect(accountButton).toHaveTextContent('A');
    await user.click(accountButton);
    expect(screen.getByText(t.settings.storageLoading)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: t.cloud.logout })).toBeDisabled();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(accountButton).not.toHaveAttribute('aria-expanded'));
    loading.unmount();

    const unavailable = renderTopbar({ account: signedIn(), cloudStorageBusy: false });
    await user.click(screen.getByRole('button', { name: t.cloud.openLabel }));
    expect(screen.getByText(t.settings.storageUnavailable)).toBeInTheDocument();
    unavailable.unmount();

    const warning = renderTopbar({ account: signedIn(), cloudStorageUsage: common });
    await user.click(screen.getByRole('button', { name: t.cloud.openLabel }));
    expect(screen.getByRole('progressbar')).toHaveClass('MuiLinearProgress-colorWarning');
    warning.unmount();

    renderTopbar({
      account: signedIn(),
      cloudStorageUsage: { ...common, usedBytes: 50, limitBytes: 100 },
    });
    await user.click(screen.getByRole('button', { name: t.cloud.openLabel }));
    expect(screen.getByRole('progressbar')).toHaveClass('MuiLinearProgress-colorPrimary');
  });

  it('uses zero percent when storage has no limit', async () => {
    const user = userEvent.setup();
    installForger();
    renderTopbar({
      account: signedIn(),
      cloudStorageUsage: {
        usedBytes: 0,
        limitBytes: 0,
        remainingBytes: 0,
        plan: 'demo',
        breakdown: { backupsBytes: 0, uploadedAppsBytes: 0, pendingUserAppUploadsBytes: 0, otherBytes: 0 },
      },
    });
    await user.click(screen.getByRole('button', { name: t.cloud.openLabel }));
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0');
  });
});

describe('Topbar remote activity', () => {
  it('renders all activity kinds and states, stops an app once at a time, refreshes, and closes', async () => {
    const user = userEvent.setup();
    const stop = Promise.withResolvers<void>();
    const getRemoteActivity = vi.fn()
      .mockResolvedValueOnce(allRemoteStates)
      .mockResolvedValueOnce(allRemoteStates)
      .mockRejectedValueOnce(new Error('refresh unavailable'));
    const desktop = installForger({ getRemoteActivity });
    desktop.api.stopRemoteNetworkShare.mockReturnValueOnce(stop.promise).mockResolvedValueOnce(undefined);
    renderTopbar();

    await waitFor(() => expect(getRemoteActivity).toHaveBeenCalledOnce());
    await user.click(screen.getByRole('button', { name: t.remoteActivity.open }));
    expect(await screen.findByText(t.remoteActivity.activeSummary(2, 1))).toBeInTheDocument();
    for (const state of ['preparing', 'active', 'error', 'closed'] as const) {
      expect(screen.getAllByText(t.remoteActivity.states[state]).length).toBeGreaterThan(0);
    }
    expect(screen.getAllByText(t.remoteActivity.app)).toHaveLength(4);
    expect(screen.getByText(t.remoteActivity.agent)).toBeInTheDocument();
    expect(screen.getByText(t.remoteActivity.mobileRequested('Ada phone'))).toBeInTheDocument();
    expect(screen.getByText('Tunnel disconnected')).toBeInTheDocument();

    const activeRow = screen.getByText('app active active').closest('[role="menuitem"]') as HTMLElement;
    const activeStop = within(activeRow).getByRole('button', { name: t.remoteActivity.stop });
    await user.click(activeStop);
    expect(desktop.api.stopRemoteNetworkShare).toHaveBeenCalledWith('target-active');
    expect(within(activeRow).getByRole('button', { name: t.remoteActivity.stopping })).toBeDisabled();
    await act(async () => stop.resolve());
    await waitFor(() => expect(getRemoteActivity).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(within(activeRow).getByRole('button', { name: t.remoteActivity.stop })).toBeEnabled());
    await user.click(within(activeRow).getByRole('button', { name: t.remoteActivity.stop }));
    await waitFor(() => expect(getRemoteActivity).toHaveBeenCalledTimes(3));

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByText(t.remoteActivity.activeSummary(2, 1))).not.toBeInTheDocument());
  });

  it('shows empty activity, consumes live updates, and ignores initial read failures', async () => {
    const user = userEvent.setup();
    const desktop = installForger({ getRemoteActivity: vi.fn().mockRejectedValue(new Error('offline')) });
    const view = renderTopbar();
    await waitFor(() => expect(desktop.api.getRemoteActivity).toHaveBeenCalledOnce());
    await user.click(screen.getByRole('button', { name: t.remoteActivity.open }));
    expect(screen.getByText(t.remoteActivity.empty)).toBeInTheDocument();

    await act(async () => desktop.emitRemote({ ...allRemoteStates, errorCount: 0 }));
    expect(await screen.findByText('app active active')).toBeInTheDocument();
    view.unmount();
    expect(desktop.removeRemoteListener).toHaveBeenCalledOnce();
  });

  it('does not apply an initial activity result after unmount', async () => {
    const deferred = Promise.withResolvers<RemoteActivitySnapshot>();
    const desktop = installForger({ getRemoteActivity: vi.fn().mockReturnValue(deferred.promise) });
    const view = renderTopbar();
    view.unmount();
    deferred.resolve(allRemoteStates);
    await deferred.promise;
    expect(desktop.removeRemoteListener).toHaveBeenCalledOnce();
  });
});

describe('Topbar custom window controls', () => {
  it('minimizes, maximizes, restores maximized and full-screen windows, and closes', async () => {
    const user = userEvent.setup();
    const desktop = installForger({
      windowState: { isMaximized: false, isFullScreen: false, usesCustomFrame: true },
    });
    renderTopbar();

    const minimize = await screen.findByRole('button', { name: t.window.minimize });
    await user.click(minimize);
    await user.click(screen.getByRole('button', { name: t.window.maximize }));
    await user.click(screen.getByRole('button', { name: t.window.close }));
    expect(desktop.api.minimizeWindow).toHaveBeenCalledOnce();
    expect(desktop.api.toggleMaximizeWindow).toHaveBeenCalledOnce();
    expect(desktop.api.closeWindow).toHaveBeenCalledOnce();

    await act(async () => desktop.emitWindow({ isMaximized: true, isFullScreen: false, usesCustomFrame: true }));
    expect(screen.getByRole('button', { name: t.window.restore })).toBeInTheDocument();
    await act(async () => desktop.emitWindow({ isMaximized: false, isFullScreen: true, usesCustomFrame: true }));
    await user.click(screen.getByRole('button', { name: t.window.restore }));
    expect(desktop.api.toggleMaximizeWindow).toHaveBeenCalledTimes(2);
  });

  it('ignores failed window reads and cleans up listeners', async () => {
    const desktop = installForger({ getWindowState: vi.fn().mockRejectedValue(new Error('unavailable')) });
    const view = renderTopbar();
    await waitFor(() => expect(desktop.api.getWindowState).toHaveBeenCalledOnce());
    expect(screen.queryByRole('button', { name: t.window.minimize })).not.toBeInTheDocument();
    view.unmount();
    expect(desktop.removeWindowListener).toHaveBeenCalledOnce();
  });

  it('does not apply a window state after unmount', async () => {
    const deferred = Promise.withResolvers<WindowControlState>();
    const desktop = installForger({ getWindowState: vi.fn().mockReturnValue(deferred.promise) });
    const view = renderTopbar();
    view.unmount();
    deferred.resolve({ isMaximized: false, isFullScreen: false, usesCustomFrame: true });
    await deferred.promise;
    expect(desktop.removeWindowListener).toHaveBeenCalledOnce();
  });
});
