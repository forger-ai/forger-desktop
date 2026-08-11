import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { BackgroundTask, BackgroundTaskStatus } from '@shared/types';
import { getDictionary } from '@renderer/i18n';
import {
  BackgroundTaskDetailView,
  BackgroundTasksListView,
  backgroundTaskIcon,
  backgroundTaskStatusColor,
  formatBackgroundTaskDateTime,
  viewLabel,
} from '@renderer/views/BackgroundTasksView';

const t = getDictionary('en');

const task = (
  status: BackgroundTaskStatus,
  overrides: Partial<BackgroundTask> = {},
): BackgroundTask => ({
  id: `task-${status}`,
  source: 'automation',
  title: `${status} task`,
  status,
  statusUpdates: [],
  createdAt: '2026-08-10T10:00:00.000Z',
  updatedAt: '2026-08-10T11:00:00.000Z',
  ...overrides,
});

describe('background task presentation helpers', () => {
  it.each([
    ['succeeded', 'success'],
    ['failed', 'error'],
    ['skipped', 'warning'],
    ['canceled', 'warning'],
    ['running', 'info'],
    ['queued', 'default'],
  ] as const)('maps %s task status to %s color', (status, color) => {
    expect(backgroundTaskStatusColor(task(status))).toBe(color);
  });

  it.each([
    ['succeeded', 'CheckCircleRoundedIcon'],
    ['failed', 'ErrorRoundedIcon'],
    ['queued', 'HourglassTopRoundedIcon'],
    ['running', 'HourglassTopRoundedIcon'],
    ['canceled', 'HourglassTopRoundedIcon'],
  ] as const)('renders the %s status icon', (status, testId) => {
    const { getByTestId } = render(backgroundTaskIcon(task(status)));
    expect(getByTestId(testId)).toBeVisible();
  });

  it('formats absent, invalid, and valid timestamps', () => {
    expect(formatBackgroundTaskDateTime()).toBe('-');
    expect(formatBackgroundTaskDateTime('invalid')).toBe('-');
    expect(formatBackgroundTaskDateTime('2026-08-10T10:00:00.000Z')).not.toBe('-');
  });

  it('labels task views, ordinary navigation, and unknown app detail with a fallback', () => {
    expect(viewLabel(t, 'backgroundTasks')).toBe(t.backgroundTasks.title);
    expect(viewLabel(t, 'backgroundTaskDetail')).toBe(t.backgroundTasks.title);
    expect(viewLabel(t, 'catalog')).toBe(t.nav.catalog);
    expect(viewLabel(t, 'app')).toBe(t.nav.apps);
  });
});

describe('background tasks list', () => {
  it('renders an empty history and returns to the previous view', async () => {
    const onBack = vi.fn();
    render(
      <BackgroundTasksListView t={t} tasks={[]} backLabel="Apps" onBack={onBack} onOpenTask={vi.fn()} />,
    );
    expect(screen.getByText(t.backgroundTasks.empty)).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: t.backgroundTasks.backTo('Apps') }));
    expect(onBack).toHaveBeenCalledOnce();
  });

  it('renders every status without invalid nested interactive markup and opens the selected task', async () => {
    const onOpenTask = vi.fn();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const tasks = [
      task('succeeded', { result: { status: 'success', message: 'Finished' }, app: { id: 'app-1', name: 'Reports' } }),
      task('failed', { statusUpdates: [{ message: 'Last failure', status: 'failed', createdAt: '2026-08-10T11:00:00.000Z' }] }),
      task('skipped'),
      task('canceled'),
      task('running'),
      task('queued'),
    ];
    render(
      <BackgroundTasksListView t={t} tasks={tasks} backLabel="Apps" onBack={vi.fn()} onOpenTask={onOpenTask} />,
    );
    expect(consoleError).not.toHaveBeenCalled();
    expect(screen.getByText('Finished')).toBeVisible();
    expect(screen.getByText('Last failure')).toBeVisible();
    expect(screen.getByText(/Reports/)).toBeVisible();
    await userEvent.click(screen.getByText('running task'));
    expect(onOpenTask).toHaveBeenCalledWith('task-running');
  });
});

describe('background task detail', () => {
  it('shows the missing state and allows navigating back', async () => {
    const onBack = vi.fn();
    render(<BackgroundTaskDetailView t={t} task={null} onBack={onBack} />);
    expect(screen.getByText(t.backgroundTasks.notFound)).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: t.actions.back }));
    expect(onBack).toHaveBeenCalledOnce();
  });

  it('renders app metadata, completion, ordered updates, result, and technical code', async () => {
    const onBack = vi.fn();
    render(
      <BackgroundTaskDetailView
        t={t}
        onBack={onBack}
        task={task('failed', {
          app: { id: 'app-1', name: 'Reports' },
          completedAt: '2026-08-10T12:00:00.000Z',
          statusUpdates: [
            { message: 'Started work', status: 'running', createdAt: '2026-08-10T10:00:00.000Z' },
            { message: 'Stopped work', status: 'failed', createdAt: '2026-08-10T11:00:00.000Z' },
          ],
          result: { status: 'error', message: 'Could not finish', technicalCode: 'task_failed' },
        })}
      />,
    );
    expect(screen.getByText(`${t.backgroundTasks.appLabel}: Reports`)).toBeVisible();
    expect(screen.getByText('Started work')).toBeVisible();
    expect(screen.getByText('Stopped work')).toBeVisible();
    expect(screen.getByText('Could not finish')).toBeVisible();
    expect(screen.getByText('task_failed')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: t.actions.back }));
    expect(onBack).toHaveBeenCalledOnce();
  });

  it('renders no-update and result-without-code variants without optional app metadata', () => {
    render(
      <BackgroundTaskDetailView
        t={t}
        onBack={vi.fn()}
        task={task('succeeded', {
          result: { status: 'success', message: 'Done' },
        })}
      />,
    );
    expect(screen.getByText(t.backgroundTasks.noUpdates)).toBeVisible();
    expect(screen.getByText('Done')).toBeVisible();
    expect(screen.queryByText(new RegExp(`^${t.backgroundTasks.appLabel}:`))).not.toBeInTheDocument();
  });

  it('omits the entire result section when the task has no result', () => {
    render(<BackgroundTaskDetailView t={t} task={task('running')} onBack={vi.fn()} />);
    expect(screen.queryByText(t.backgroundTasks.resultTitle)).not.toBeInTheDocument();
  });
});
