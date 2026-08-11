import { createTheme, ThemeProvider } from '@mui/material/styles';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Sidebar, PINNABLE_VIEWS } from '@renderer/components/Sidebar';
import { en } from '@renderer/i18n/en';
import type { AppDictionary } from '@renderer/i18n';
import type { AgentProviderUsageResult, DesktopUpdateState } from '@shared/types';

const t = en as unknown as AppDictionary;
const idleUpdate: DesktopUpdateState = { status: 'idle', currentVersion: '1.0.0' };
const availableUpdate: DesktopUpdateState = { status: 'available', currentVersion: '1.0.0', availableVersion: '2.0.0' };

const fullUsage: AgentProviderUsageResult = {
  success: true,
  checkedAt: '2026-08-10T10:00:00.000Z',
  providers: [
    {
      provider: 'codex', label: 'Codex', connected: true, checkedAt: '2026-08-10T10:00:00.000Z',
      windows: [
        { kind: 'five_hour', label: '5h', source: 'codex_rate_limits', remainingPercent: 50, resetsAt: 1_800_000_000 },
        { kind: 'weekly', label: 'Weekly', source: 'codex_rate_limits', remainingPercent: 20, resetsAt: 1_800_000_000 },
      ],
    },
    {
      provider: 'claude', label: 'Claude', connected: true, checkedAt: '2026-08-10T10:00:00.000Z',
      windows: [
        { kind: 'five_hour', label: '5h', source: 'claude_api', remainingPercent: 10 },
        { kind: 'weekly', label: 'Weekly', source: 'claude_api' },
      ],
    },
    {
      provider: 'antigravity', label: 'Antigravity', connected: true, checkedAt: '2026-08-10T10:00:00.000Z',
      windows: [{ kind: 'five_hour', label: '5h', source: 'claude_audit', remainingPercent: 60 }],
    },
  ],
};

const unavailableUsage: AgentProviderUsageResult = {
  success: true,
  checkedAt: '2026-08-10T10:05:00.000Z',
  providers: [
    { provider: 'codex', label: 'No recent usage', connected: true, checkedAt: '2026-08-10T10:05:00.000Z', windows: [], unavailableReason: 'no_recent_usage' },
    { provider: 'claude', label: 'Claude failed', connected: true, checkedAt: '2026-08-10T10:05:00.000Z', windows: [], unavailableReason: 'read_failed', externalUrl: 'https://example.test/usage' },
    { provider: 'antigravity', label: 'Unavailable provider', connected: false, checkedAt: '2026-08-10T10:05:00.000Z', windows: [], unavailableReason: 'not_available' },
  ],
};

const installForger = (getAgentProviderUsage = vi.fn().mockResolvedValue(fullUsage)) => {
  const api = {
    getAgentProviderUsage,
    openExternalUrl: vi.fn().mockResolvedValue(undefined),
  };
  Object.defineProperty(window, 'forger', { configurable: true, value: api });
  return api;
};

const renderSidebar = ({
  currentView = 'chat' as const,
  desktopUpdateState = idleUpdate,
  pinnedViews = [] as (typeof PINNABLE_VIEWS)[number][],
  workflowsEnabled = false,
  showForumNav = false,
  mode = 'light' as 'light' | 'dark',
} = {}) => {
  const onNavigate = vi.fn();
  const view = render(
    <ThemeProvider theme={createTheme({ palette: { mode } })}>
      <Sidebar
        currentView={currentView}
        onNavigate={onNavigate}
        t={t}
        desktopUpdateState={desktopUpdateState}
        pinnedViews={pinnedViews}
        workflowsEnabled={workflowsEnabled}
        showForumNav={showForumNav}
      />
    </ThemeProvider>,
  );
  return { onNavigate, ...view };
};

const usageToggle = () => screen.getAllByText(t.providerUsage.title)[0].closest('.MuiListItemButton-root') as HTMLElement;

describe('Sidebar', () => {
  it('navigates default and pinned destinations, filters optional entries, and opens the update from pointer and keyboard', async () => {
    const user = userEvent.setup();
    installForger();
    const handlers = renderSidebar({
      currentView: 'chat',
      desktopUpdateState: availableUpdate,
      pinnedViews: [...PINNABLE_VIEWS],
      workflowsEnabled: false,
      showForumNav: false,
    });

    expect(screen.queryByRole('button', { name: t.nav.community })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: t.nav.workflows })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: t.nav.files })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: t.nav.chat })).toHaveClass('Mui-selected');
    await user.click(screen.getByRole('button', { name: t.nav.apps }));
    await user.click(screen.getByRole('button', { name: t.nav.files }));
    await user.click(screen.getByRole('button', { name: t.nav.more }));
    await user.click(screen.getByRole('button', { name: t.nav.settings }));
    expect(handlers.onNavigate.mock.calls.slice(0, 4)).toEqual([['apps'], ['files'], ['more'], ['settings']]);

    const updateBanner = screen.getByText(t.settings.desktopUpdateStatuses.available).closest('[role="button"]') as HTMLElement;
    fireEvent.keyDown(updateBanner, { key: 'ArrowDown' });
    fireEvent.keyDown(updateBanner, { key: 'Enter' });
    fireEvent.keyDown(updateBanner, { key: ' ' });
    await user.click(updateBanner);
    expect(handlers.onNavigate.mock.calls.filter(([view]) => view === 'settings')).toHaveLength(4);
  });

  it('shows all usage states, reset formats, meter colors, external navigation, toggle close, and periodic refresh', async () => {
    const user = userEvent.setup();
    const intervalCallbacks: Array<() => void> = [];
    const setInterval = vi.spyOn(window, 'setInterval').mockImplementation(((callback: TimerHandler) => {
      intervalCallbacks.push(callback as () => void);
      return 77;
    }) as typeof window.setInterval);
    const clearInterval = vi.spyOn(window, 'clearInterval').mockImplementation(() => undefined);
    const api = installForger();
    const view = renderSidebar({ pinnedViews: ['workflows'], workflowsEnabled: true, showForumNav: true });

    await waitFor(() => expect(usageToggle()).toHaveTextContent('10%'));
    expect(screen.getByRole('button', { name: t.nav.community })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: t.nav.workflows })).toBeInTheDocument();
    await user.click(usageToggle());
    expect(await screen.findByText('Codex')).toBeInTheDocument();
    expect(screen.getAllByText(t.providerUsage.fiveHour)).toHaveLength(3);
    expect(screen.getAllByText(t.providerUsage.weekly).length).toBeGreaterThan(0);
    expect(screen.getByText(t.providerUsage.percentUnavailable)).toBeInTheDocument();
    expect(screen.getAllByRole('progressbar')).toHaveLength(4);

    api.getAgentProviderUsage.mockResolvedValue(unavailableUsage);
    await act(async () => intervalCallbacks[0]());
    expect(await screen.findByText(t.providerUsage.readFailed)).toBeInTheDocument();
    expect(screen.getByText(t.providerUsage.noRecentUsage)).toBeInTheDocument();
    expect(screen.getByText(t.providerUsage.unavailable)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: t.providerUsage.openExternal }));
    expect(api.openExternalUrl).toHaveBeenCalledWith('https://example.test/usage');

    await user.click(usageToggle());
    await waitFor(() => expect(screen.queryByText('Codex')).not.toBeInTheDocument());
    await user.click(usageToggle());
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByText('Codex')).not.toBeInTheDocument());

    expect(api.getAgentProviderUsage.mock.calls.length).toBeGreaterThanOrEqual(4);
    view.unmount();
    expect(setInterval).toHaveBeenCalled();
    expect(clearInterval).toHaveBeenCalledWith(77);
  });

  it('renders loading, custom and default failures, empty usage, ready update, and a dark theme', async () => {
    const user = userEvent.setup();
    const deferred = Promise.withResolvers<AgentProviderUsageResult>();
    const getUsage = vi.fn().mockReturnValue(deferred.promise);
    installForger(getUsage);
    const first = renderSidebar({
      desktopUpdateState: { ...availableUpdate, status: 'ready' },
      showForumNav: true,
      mode: 'dark',
    });
    expect(usageToggle().querySelector('.MuiCircularProgress-root')).toBeInTheDocument();
    await user.click(usageToggle());
    expect(screen.getByText(t.providerUsage.loading)).toBeInTheDocument();
    deferred.resolve({ success: false, checkedAt: '2026-08-10T10:00:00.000Z', providers: [], userMessage: 'Provider unavailable now.' });
    expect(await screen.findByText('Provider unavailable now.')).toBeInTheDocument();
    expect(screen.getByText(t.providerUsage.noConnectedProviders)).toBeInTheDocument();
    expect(screen.getByText(t.settings.desktopUpdateStatuses.ready)).toBeInTheDocument();
    first.unmount();

    installForger(vi.fn().mockResolvedValue({ success: false, checkedAt: '2026-08-10T10:00:00.000Z', providers: [] }));
    renderSidebar();
    await user.click(usageToggle());
    expect(await screen.findByText(t.providerUsage.error)).toBeInTheDocument();
  });

  it('recovers from provider-usage exceptions and omits update and pinned sections when idle', async () => {
    const user = userEvent.setup();
    installForger(vi.fn().mockRejectedValue(new Error('usage failed')));
    renderSidebar();
    await user.click(usageToggle());

    expect(await screen.findByText(t.providerUsage.error)).toBeInTheDocument();
    expect(screen.getByText(t.providerUsage.noConnectedProviders)).toBeInTheDocument();
    expect(screen.queryByText(t.settings.desktopUpdateStatuses.available)).not.toBeInTheDocument();
  });
});
