import { render, screen, waitForElementToBeRemoved, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { Workflow } from '@shared/types';
import { getDictionary } from '@renderer/i18n';
import { WorkflowsListView } from '@renderer/views/workflows/WorkflowsListView';

const t = getDictionary('en');
const copy = t.sections.workflows;

const workflow = (overrides: Partial<Workflow> = {}): Workflow => ({
  id: 'workflow-1',
  name: 'Morning brief',
  description: 'Summarize the latest activity.',
  trigger: { type: 'manual' },
  nodes: [],
  edges: [],
  enabled: true,
  running: false,
  nextRunAt: null,
  createdAt: '2026-08-10T08:00:00.000Z',
  updatedAt: '2026-08-10T08:00:00.000Z',
  ...overrides,
});

const renderList = (workflows: Workflow[], busy = false) => {
  const callbacks = {
    onCreate: vi.fn(),
    onOpen: vi.fn(),
    onToggleEnabled: vi.fn(),
    onRunNow: vi.fn(),
    onDelete: vi.fn(),
  };
  render(<WorkflowsListView t={t} workflows={workflows} busy={busy} {...callbacks} />);
  return callbacks;
};

describe('WorkflowsListView', () => {
  it('shows the empty state and starts workflow creation', async () => {
    const user = userEvent.setup();
    const callbacks = renderList([]);
    expect(screen.getByText(copy.empty)).toBeVisible();
    await user.click(screen.getByRole('button', { name: copy.newWorkflow }));
    expect(callbacks.onCreate).toHaveBeenCalledOnce();
  });

  it('renders running, active, paused, manual, scheduled, and timestamp states', async () => {
    const user = userEvent.setup();
    const running = workflow({
      id: 'running',
      name: 'Running flow',
      running: true,
      lastRun: {
        id: 'run-1',
        workflowId: 'running',
        trigger: 'manual',
        status: 'running',
        startedAt: '2026-08-10T09:00:00.000Z',
        nodeRuns: [],
      },
      nextRunAt: '2026-08-11T09:00:00.000Z',
    });
    const paused = workflow({
      id: 'paused',
      name: 'Paused schedule',
      description: undefined,
      enabled: false,
      trigger: { type: 'scheduled', frequency: { type: 'hourly' } },
    });
    const active = workflow({ id: 'active', name: 'Active manual', description: undefined });
    const callbacks = renderList([running, paused, active]);

    expect(screen.getByText(copy.running)).toBeVisible();
    expect(screen.getByText(copy.paused)).toBeVisible();
    expect(screen.getByText(copy.active)).toBeVisible();
    expect(screen.getAllByText(copy.triggerManual)).toHaveLength(2);
    expect(screen.getByText(`${copy.triggerScheduled} · ${t.sections.automations.frequencyLabels.hourly}`)).toBeVisible();
    expect(screen.getAllByText(/—/)).toHaveLength(4);

    const activeTitle = screen.getByText('Active manual');
    await user.click(activeTitle.closest('.MuiCardActionArea-root') as HTMLElement);
    expect(callbacks.onOpen).toHaveBeenCalledWith('active');
  });

  it('runs a workflow and toggles both enabled states while respecting running and global locks', async () => {
    const user = userEvent.setup();
    const enabled = workflow({ id: 'enabled', name: 'Enabled flow' });
    const disabled = workflow({ id: 'disabled', name: 'Disabled flow', enabled: false });
    const callbacks = renderList([enabled, disabled]);

    const runButtons = screen.getAllByRole('button', { name: copy.runNow });
    await user.click(runButtons[0]);
    expect(callbacks.onRunNow).toHaveBeenCalledWith(enabled);

    await user.click(screen.getByRole('button', { name: copy.disable }));
    await user.click(screen.getByRole('button', { name: copy.enable }));
    expect(callbacks.onToggleEnabled.mock.calls).toEqual([[enabled], [disabled]]);

    const { unmount } = render(
      <WorkflowsListView
        t={t}
        workflows={[workflow({ running: true })]}
        busy
        onCreate={vi.fn()}
        onOpen={vi.fn()}
        onToggleEnabled={vi.fn()}
        onRunNow={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    const lockedRunButtons = screen.getAllByRole('button', { name: copy.runNow });
    expect(lockedRunButtons.at(-1)).toBeDisabled();
    const lockedToggleButtons = screen.getAllByRole('button', { name: copy.disable });
    expect(lockedToggleButtons.at(-1)).toBeDisabled();
    unmount();
  });

  it('cancels deletion without side effects and confirms the selected workflow', async () => {
    const user = userEvent.setup();
    const selected = workflow({ id: 'delete-me', name: 'Delete me' });
    const callbacks = renderList([selected]);

    await user.click(screen.getByRole('button', { name: copy.delete }));
    const firstDialog = screen.getByRole('dialog', { name: copy.delete });
    expect(firstDialog).toBeVisible();
    expect(screen.getByText(copy.deleteConfirm('Delete me'))).toBeVisible();
    await user.click(within(firstDialog).getByRole('button', { name: copy.cancel }));
    expect(callbacks.onDelete).not.toHaveBeenCalled();
    await waitForElementToBeRemoved(firstDialog);

    await user.click(screen.getByRole('button', { name: copy.delete }));
    const escapeDialog = screen.getByRole('dialog', { name: copy.delete });
    await user.keyboard('{Escape}');
    await waitForElementToBeRemoved(escapeDialog);

    await user.click(screen.getByRole('button', { name: copy.delete }));
    const confirmDialog = screen.getByRole('dialog', { name: copy.delete });
    await user.click(within(confirmDialog).getByRole('button', { name: copy.delete }));
    expect(callbacks.onDelete).toHaveBeenCalledWith(selected);
    await waitForElementToBeRemoved(confirmDialog);
  });
});
