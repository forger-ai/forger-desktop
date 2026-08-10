import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DesktopUpdateState, ForgerAccountSession } from '@shared/types';
import { getDictionary } from '@renderer/i18n';
import { AppShell } from '@renderer/components/AppShell';

const shellSpies = vi.hoisted(() => ({
  sidebar: vi.fn(),
  topbar: vi.fn(),
}));

vi.mock('@renderer/components/Sidebar', () => ({
  Sidebar: (props: Record<string, unknown>) => {
    shellSpies.sidebar(props);
    return <nav>Sidebar</nav>;
  },
}));

vi.mock('@renderer/components/Topbar', () => ({
  Topbar: (props: Record<string, unknown>) => {
    shellSpies.topbar(props);
    return <header>Topbar</header>;
  },
}));

const t = getDictionary('en');

beforeEach(() => {
  shellSpies.sidebar.mockClear();
  shellSpies.topbar.mockClear();
});

describe('AppShell', () => {
  it('composes navigation, account controls, tasks, and page content', () => {
    const onNavigate = vi.fn();
    const account = { authenticated: false } as ForgerAccountSession;
    const desktopUpdateState = { status: 'idle' } as DesktopUpdateState;
    const getAppMeta = vi.fn().mockReturnValue({ name: 'Reports', description: 'Local reports' });
    const onSelectDataApp = vi.fn();
    const onOpenCloudModal = vi.fn();
    const onLogout = vi.fn();
    const onOpenStorageSettings = vi.fn();
    const onOpenBackgroundTasks = vi.fn();
    const onCloseBackgroundTasks = vi.fn();
    const onOpenBackgroundTaskHistory = vi.fn();
    const onOpenBackgroundTask = vi.fn();

    render(
      <AppShell
        currentView="chat"
        onNavigate={onNavigate}
        t={t}
        chatModeLabel="Codex"
        dataApps={[]}
        selectedDataAppId={null}
        getAppMeta={getAppMeta}
        onSelectDataApp={onSelectDataApp}
        onOpenCloudModal={onOpenCloudModal}
        account={account}
        accountBusy={false}
        cloudStorageUsage={null}
        cloudStorageBusy={false}
        onOpenStorageSettings={onOpenStorageSettings}
        onLogout={onLogout}
        backgroundTasks={[]}
        backgroundTasksOpen={false}
        activeBackgroundTaskCount={0}
        onOpenBackgroundTasks={onOpenBackgroundTasks}
        onCloseBackgroundTasks={onCloseBackgroundTasks}
        onOpenBackgroundTaskHistory={onOpenBackgroundTaskHistory}
        onOpenBackgroundTask={onOpenBackgroundTask}
        desktopUpdateState={desktopUpdateState}
        pinnedViews={[]}
        workflowsEnabled
        showForumNav
      >
        <section>Current page</section>
      </AppShell>,
    );

    expect(screen.getByRole('navigation')).toHaveTextContent('Sidebar');
    expect(screen.getByRole('banner')).toHaveTextContent('Topbar');
    expect(screen.getByText('Current page')).toBeVisible();
    expect(shellSpies.sidebar).toHaveBeenCalledWith(expect.objectContaining({
      currentView: 'chat',
      onNavigate,
      desktopUpdateState,
      workflowsEnabled: true,
      showForumNav: true,
    }));
    expect(shellSpies.topbar).toHaveBeenCalledWith(expect.objectContaining({
      currentView: 'chat',
      chatModeLabel: 'Codex',
      account,
      getAppMeta,
      onSelectDataApp,
      onOpenCloudModal,
      onOpenStorageSettings,
      onLogout,
      onOpenBackgroundTasks,
      onCloseBackgroundTasks,
      onOpenBackgroundTaskHistory,
      onOpenBackgroundTask,
    }));

    const topbarProps = shellSpies.topbar.mock.calls[0][0] as { onOpenSocialTab: () => void };
    topbarProps.onOpenSocialTab();
    expect(onNavigate).toHaveBeenCalledWith('friends');
  });
});
