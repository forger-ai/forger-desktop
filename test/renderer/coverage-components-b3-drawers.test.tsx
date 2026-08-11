import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BackgroundTasksDrawer } from '@renderer/components/BackgroundTasksDrawer';
import { LocalNetworkShareDialog } from '@renderer/components/LocalNetworkShareDialog';
import { en } from '@renderer/i18n/en';
import type { AppDictionary } from '@renderer/i18n';
import type { BackgroundTask, BackgroundTaskStatus, LocalNetworkShareStatus } from '@shared/types';

const { toDataURL } = vi.hoisted(() => ({
  toDataURL: vi.fn(),
}));

vi.mock('qrcode', () => ({
  default: { toDataURL },
}));

const t = en as unknown as AppDictionary;

const task = (
  id: string,
  status: BackgroundTaskStatus,
  overrides: Partial<BackgroundTask> = {},
): BackgroundTask => ({
  id,
  source: 'automation',
  title: `${status} task ${id}`,
  status,
  statusUpdates: [],
  createdAt: '2026-08-10T08:00:00.000Z',
  updatedAt: '2026-08-10T09:00:00.000Z',
  ...overrides,
});

const taskSet = [
  task('success', 'succeeded', {
    statusUpdates: [{ message: 'Uploaded', createdAt: '2026-08-10T09:00:00.000Z' }],
    app: { id: 'app-1', name: 'Planner' },
  }),
  task('failed', 'failed', {
    result: { status: 'error', message: 'Upload failed' },
    app: { id: 'app-2' },
  }),
  task('skipped', 'skipped', { updatedAt: 'not-a-date' }),
  task('canceled', 'canceled', { updatedAt: undefined as unknown as string }),
  task('queued', 'queued', { updatedAt: '2026-08-10T11:00:00.000Z' }),
  task('running', 'running', { updatedAt: '2026-08-10T10:00:00.000Z' }),
  task('extra-1', 'succeeded', { updatedAt: '2026-08-10T07:00:00.000Z' }),
  task('extra-2', 'succeeded', { updatedAt: '2026-08-10T06:00:00.000Z' }),
  task('extra-3', 'succeeded', { updatedAt: '2026-08-10T05:00:00.000Z' }),
];

const renderTaskDrawer = ({ tasks = [], open = true, activeCount = 0 }: {
  tasks?: BackgroundTask[];
  open?: boolean;
  activeCount?: number;
} = {}) => {
  const handlers = {
    onOpen: vi.fn(),
    onClose: vi.fn(),
    onOpenHistory: vi.fn(),
    onOpenTask: vi.fn(),
  };
  const drawer = (nextOpen: boolean) => (
    <BackgroundTasksDrawer
      t={t}
      tasks={tasks}
      open={nextOpen}
      activeCount={activeCount}
      {...handlers}
    />
  );
  const view = render(drawer(open));
  return { ...view, ...handlers, rerenderOpen: (nextOpen: boolean) => view.rerender(drawer(nextOpen)) };
};

describe('BackgroundTasksDrawer behavior', () => {
  it('opens an empty drawer, reports no active work, closes, and navigates to history', async () => {
    const user = userEvent.setup();
    const handlers = renderTaskDrawer({ open: false });

    await user.click(screen.getByRole('button', { name: t.backgroundTasks.open }));
    expect(handlers.onOpen).toHaveBeenCalledOnce();
    handlers.rerenderOpen(true);

    expect(screen.getByText(t.backgroundTasks.noActive)).toBeInTheDocument();
    expect(screen.getByText(t.backgroundTasks.empty)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: t.backgroundTasks.viewHistory }));
    expect(handlers.onOpenHistory).toHaveBeenCalledOnce();
    await user.keyboard('{Escape}');
    expect(handlers.onClose).toHaveBeenCalledOnce();
  });

  it('renders active, terminal, and failed tasks in valid semantic markup and opens a task', async () => {
    const user = userEvent.setup();
    const consoleError = vi.spyOn(console, 'error');
    const handlers = renderTaskDrawer({ tasks: taskSet, activeCount: 2 });

    expect(screen.getByText(t.backgroundTasks.activeSummary(2))).toBeInTheDocument();
    expect(screen.getByText('Uploaded')).toBeInTheDocument();
    expect(screen.getByText('Upload failed')).toBeInTheDocument();
    expect(screen.getByText('Planner')).toBeInTheDocument();
    for (const status of ['queued', 'running', 'succeeded', 'failed', 'canceled', 'skipped'] as const) {
      expect(screen.getAllByText(t.backgroundTasks.statuses[status]).length).toBeGreaterThan(0);
    }
    expect(screen.queryByText('succeeded task extra-3')).not.toBeInTheDocument();

    const rows = document.querySelectorAll('.MuiListItemButton-root');
    expect(rows[0]).toHaveTextContent('queued task queued');
    expect(rows[1]).toHaveTextContent('running task running');
    const queuedRow = screen.getByText('queued task queued').closest('.MuiListItemButton-root') as HTMLElement;
    await user.click(queuedRow);
    expect(handlers.onOpenTask).toHaveBeenCalledWith('queued');
    expect(within(queuedRow).getByText(t.backgroundTasks.statuses.queued)).toBeInTheDocument();

    const invalidMarkupWarnings = consoleError.mock.calls
      .flat()
      .map(String)
      .filter((message) => /cannot be a descendant|cannot contain a nested/i.test(message));
    expect(invalidMarkupWarnings).toEqual([]);
  });
});

const connectUrl = 'http://192.168.1.8:4173/connect/token';

const renderShareDialog = ({
  open = true,
  status = { active: true, appId: 'planner', connectUrl },
}: {
  open?: boolean;
  status?: LocalNetworkShareStatus | null;
} = {}) => {
  const handlers = {
    onClose: vi.fn(),
    onStop: vi.fn(),
    onCopied: vi.fn(),
  };
  const dialog = (nextOpen: boolean, nextStatus: LocalNetworkShareStatus | null) => (
    <LocalNetworkShareDialog
      appName="Planner"
      open={nextOpen}
      status={nextStatus}
      t={t}
      {...handlers}
    />
  );
  const view = render(dialog(open, status));
  return {
    ...view,
    ...handlers,
    rerenderDialog: (nextOpen: boolean, nextStatus: LocalNetworkShareStatus | null) =>
      view.rerender(dialog(nextOpen, nextStatus)),
  };
};

beforeEach(() => {
  toDataURL.mockReset();
  toDataURL.mockResolvedValue('data:image/png;base64,qr');
});

describe('LocalNetworkShareDialog behavior', () => {
  it('renders the waiting QR, copies the connection link, closes, and stops sharing', async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, 'writeText');
    const handlers = renderShareDialog();

    expect(screen.getByText(t.localNetwork.waitingBody)).toBeInTheDocument();
    expect(await screen.findByRole('img', { name: t.localNetwork.menuAction })).toHaveAttribute('src', 'data:image/png;base64,qr');
    expect(screen.getByRole('textbox')).toHaveValue(connectUrl);
    expect(toDataURL).toHaveBeenCalledWith(connectUrl, { margin: 1, width: 224 });

    await user.click(screen.getByRole('button', { name: t.localNetwork.copyLink }));
    expect(writeText).toHaveBeenCalledWith(connectUrl);
    expect(handlers.onCopied).toHaveBeenCalledOnce();
    await user.click(screen.getByRole('button', { name: t.localNetwork.close }));
    await user.click(screen.getByRole('button', { name: t.localNetwork.stop }));
    expect(handlers.onClose).toHaveBeenCalledOnce();
    expect(handlers.onStop).toHaveBeenCalledOnce();
  });

  it('shows a connected session using the fallback URL and disables copying', async () => {
    const user = userEvent.setup();
    const handlers = renderShareDialog({
      status: {
        active: true,
        appId: 'planner',
        url: 'http://192.168.1.8:4173',
        connectedAt: '2026-08-10T10:00:00.000Z',
      },
    });

    expect(screen.getByRole('alert')).toHaveTextContent(t.localNetwork.connectedBody);
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: t.localNetwork.copyLink })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: t.localNetwork.stop }));
    expect(handlers.onStop).toHaveBeenCalledOnce();
  });

  it('does not generate a QR while closed and clears it when the link disappears', async () => {
    const handlers = renderShareDialog({ open: false });
    expect(toDataURL).not.toHaveBeenCalled();

    handlers.rerenderDialog(true, { active: true, appId: 'planner', connectUrl });
    expect(await screen.findByRole('img')).toBeInTheDocument();
    handlers.rerenderDialog(true, null);
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: t.localNetwork.copyLink })).toBeDisabled();
  });

  it('ignores a QR result that resolves after unmount', async () => {
    let resolveQr: (value: string) => void = () => undefined;
    toDataURL.mockReturnValueOnce(new Promise<string>((resolve) => {
      resolveQr = resolve;
    }));
    const view = renderShareDialog();
    expect(toDataURL).toHaveBeenCalledOnce();

    view.unmount();
    await act(async () => {
      resolveQr('data:image/png;base64,late');
      await Promise.resolve();
    });
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });
});
