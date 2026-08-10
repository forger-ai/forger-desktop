import { useState } from 'react';
import { fireEvent, render, screen, waitForElementToBeRemoved } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Workflow, WorkflowRun, WorkflowRunStatus, WorkflowRunSummary } from '@shared/types';
import { getDictionary } from '@renderer/i18n';
import { WorkflowDetailPage } from '@renderer/views/workflows/WorkflowDetailPage';
import type { WorkflowGraphData } from '@renderer/views/workflows/WorkflowEditorPage';
import { emptyDraft, type WorkflowDraft } from '@renderer/views/workflows/workflow-draft';

const childSpies = vi.hoisted(() => ({ editor: vi.fn(), runModal: vi.fn() }));

vi.mock('@renderer/views/workflows/WorkflowEditor', () => ({
  WorkflowEditor: (props: Record<string, unknown>) => {
    childSpies.editor(props);
    return (
      <div>
        <span>Graph {String(props.readOnly)}</span>
        <button onClick={() => (props.onOpenNodeRun as (id: string) => void)('node-1')}>Open node result</button>
        <button onClick={() => (props.onRunNode as (id: string) => void)('node-1')}>Run one node</button>
      </div>
    );
  },
}));

vi.mock('@renderer/views/workflows/WorkflowParamsForm', () => ({
  WorkflowParamsForm: (props: Record<string, unknown>) => (
    <button onClick={() => (props.onChange as (updater: (draft: WorkflowDraft) => WorkflowDraft) => void)(
      (draft) => ({ ...draft, name: 'Changed in dialog' }),
    )}>
      Change parameters
    </button>
  ),
}));

vi.mock('@renderer/views/workflows/WorkflowRunModal', () => ({
  WorkflowRunModal: (props: Record<string, unknown>) => {
    childSpies.runModal(props);
    if (!props.open) return null;
    return (
      <div role="dialog" aria-label="Node run">
        <button onClick={() => (props.onApprove as (id: string, approved: boolean) => void)('node-1', true)}>Approve node</button>
        <button onClick={() => (props.onApprove as (id: string, approved: boolean) => void)('node-1', false)}>Reject node</button>
        <button onClick={() => (props.onClose as () => void)()}>Close node</button>
      </div>
    );
  },
}));

const t = getDictionary('en');
const copy = t.sections.workflows;
const data: WorkflowGraphData = {
  apps: [], agents: [], toolPackages: [], officialTools: [], connectionOptions: [], providerOptions: [],
  outputSamples: {}, savedNodeIds: new Set(),
};

const workflow = (overrides: Partial<Workflow> = {}): Workflow => ({
  id: 'workflow-1', name: 'Morning brief', description: 'Summary', trigger: { type: 'manual' },
  nodes: [], edges: [], enabled: true, running: false, nextRunAt: null,
  createdAt: '2026-08-10T08:00:00.000Z', updatedAt: '2026-08-10T08:00:00.000Z', ...overrides,
});

const summary = (status: WorkflowRunStatus, index: number): WorkflowRunSummary => ({
  id: `run-${status}`, workflowId: 'workflow-1', trigger: (['manual', 'scheduled', 'chat', 'step'] as const)[index % 4],
  status, startedAt: `2026-08-10T0${index}:00:00.000Z`, nodeRuns: [],
});

const detailedRun = (status: WorkflowRunStatus): WorkflowRun => ({
  ...summary(status, 1),
  nodeRuns: [{ nodeId: 'node-1', nodeName: 'First node', nodeType: 'llm_agent', status: 'succeeded' }],
  transcript: 'Done',
});

interface HarnessProps {
  workflowValue?: Workflow;
  dirty?: boolean;
  busy?: boolean;
  banner?: { severity: 'success' | 'error'; message: string } | null;
  runs?: WorkflowRunSummary[];
  selectedRun?: WorkflowRun | null;
  selectedRunId?: string | null;
}

const renderDetail = ({
  workflowValue = workflow(), dirty = false, busy = false, banner = null, runs = [], selectedRun = null, selectedRunId = null,
}: HarnessProps = {}) => {
  const callbacks = {
    onClearBanner: vi.fn(), onSave: vi.fn(), onDiscard: vi.fn(), onBack: vi.fn(), onRunNow: vi.fn(),
    onToggleEnabled: vi.fn(), onRunNode: vi.fn(), onSelectRun: vi.fn(), onApproveNode: vi.fn(), onCancelRun: vi.fn(),
  };
  const Harness = () => {
    const [draft, setDraft] = useState<WorkflowDraft>({ ...emptyDraft(), name: 'Original name' });
    return (
      <>
        <WorkflowDetailPage
          t={t} workflow={workflowValue} draft={draft} onDraftChange={(updater) => setDraft(updater)} data={data}
          dirty={dirty} busy={busy} banner={banner} {...callbacks}
          runs={runs} selectedRunId={selectedRunId} selectedRun={selectedRun}
        />
        <output data-testid="detail-draft">{draft.name}</output>
      </>
    );
  };
  render(<Harness />);
  return callbacks;
};

beforeEach(() => {
  childSpies.editor.mockClear();
  childSpies.runModal.mockClear();
});

describe('WorkflowDetailPage', () => {
  it('handles idle editing, dirty actions, banners, and parameter rollback/save', async () => {
    const user = userEvent.setup();
    const callbacks = renderDetail({ dirty: true, banner: { severity: 'success', message: 'Saved earlier' } });

    expect(screen.getByText(copy.active)).toBeVisible();
    expect(screen.getByText(copy.unsavedChanges)).toBeVisible();
    expect(screen.getByText('Saved earlier').closest('[role="alert"]')).toBeVisible();
    await user.click(screen.getByRole('button', { name: copy.back }));
    await user.click(screen.getByRole('button', { name: copy.disable }));
    await user.click(screen.getByRole('button', { name: copy.runNow }));
    await user.click(screen.getByRole('button', { name: copy.discardChanges }));
    await user.click(screen.getByRole('button', { name: copy.saveChanges }));
    expect(callbacks.onBack).toHaveBeenCalledOnce();
    expect(callbacks.onToggleEnabled).toHaveBeenCalledOnce();
    expect(callbacks.onRunNow).toHaveBeenCalledOnce();
    expect(callbacks.onDiscard).toHaveBeenCalledOnce();
    expect(callbacks.onSave).toHaveBeenCalledOnce();

    await user.click(screen.getByRole('button', { name: copy.editParams }));
    const paramsDialog = screen.getByRole('dialog', { name: copy.editParams });
    await user.click(screen.getByRole('button', { name: 'Change parameters' }));
    expect(screen.getByTestId('detail-draft')).toHaveTextContent('Changed in dialog');
    await user.click(screen.getByRole('button', { name: copy.cancel }));
    await waitForElementToBeRemoved(paramsDialog);
    expect(screen.getByTestId('detail-draft')).toHaveTextContent('Original name');

    await user.click(screen.getByRole('button', { name: copy.editParams }));
    await user.click(screen.getByRole('button', { name: copy.save }));
    expect(callbacks.onSave).toHaveBeenCalledTimes(2);
  });

  it('locks a running workflow, maps node results, and cancels the active run', async () => {
    const user = userEvent.setup();
    const selectedRun = detailedRun('running');
    const callbacks = renderDetail({ workflowValue: workflow({ running: true }), dirty: true, busy: true, selectedRun });

    expect(screen.getAllByText(copy.running).length).toBeGreaterThan(0);
    expect(screen.getByText(copy.lockedWhileRunning)).toBeVisible();
    expect(screen.queryByText(copy.unsavedChanges)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: copy.running })).toBeDisabled();
    expect(screen.getByText('Graph true')).toBeVisible();
    expect(childSpies.editor).toHaveBeenCalledWith(expect.objectContaining({
      readOnly: true,
      nodeRuns: { 'node-1': selectedRun.nodeRuns[0] },
    }));

    await user.click(screen.getByRole('button', { name: 'Run one node' }));
    expect(callbacks.onRunNode).toHaveBeenCalledWith('node-1');
    await user.click(screen.getByRole('button', { name: copy.cancelRun }));
    expect(callbacks.onCancelRun).toHaveBeenCalledOnce();
  });

  it('opens node-run details, approves or rejects, and closes focus', async () => {
    const user = userEvent.setup();
    const callbacks = renderDetail({ selectedRun: detailedRun('waiting_approval') });
    await user.click(screen.getByRole('button', { name: 'Open node result' }));
    expect(screen.getByRole('dialog', { name: 'Node run' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Approve node' }));
    expect(callbacks.onApproveNode).toHaveBeenCalledWith('node-1', true);
    expect(screen.queryByRole('dialog', { name: 'Node run' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Open node result' }));
    await user.click(screen.getByRole('button', { name: 'Reject node' }));
    expect(callbacks.onApproveNode).toHaveBeenCalledWith('node-1', false);
    await user.click(screen.getByRole('button', { name: 'Open node result' }));
    await user.click(screen.getByRole('button', { name: 'Close node' }));
    expect(screen.queryByRole('dialog', { name: 'Node run' })).not.toBeInTheDocument();
  });

  it('toggles empty history and lists every run status and trigger', async () => {
    const user = userEvent.setup();
    const statuses: WorkflowRunStatus[] = ['queued', 'running', 'waiting_approval', 'succeeded', 'failed', 'skipped', 'canceled'];
    const runs = statuses.map(summary);
    const callbacks = renderDetail({ workflowValue: workflow({ enabled: false }), runs, selectedRunId: 'run-succeeded' });

    expect(screen.getByText(copy.paused)).toBeVisible();
    await user.click(screen.getByRole('button', { name: copy.runsTitle }));
    for (const status of statuses) expect(screen.getByText(copy.statusLabels[status])).toBeVisible();
    for (const trigger of ['manual', 'scheduled', 'chat', 'step'] as const) {
      expect(screen.getAllByText(copy.runTriggers[trigger]).length).toBeGreaterThan(0);
    }
    const runItem = screen.getAllByText(copy.runTriggers.scheduled)[0].closest('.MuiListItemButton-root') as HTMLElement;
    await user.click(runItem);
    expect(callbacks.onSelectRun).toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: t.actions.close }));
    expect(screen.queryByText(copy.noRuns)).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: copy.runsTitle }));
    await user.click(screen.getByRole('button', { name: copy.runsTitle }));
  });

  it('shows empty history and closes parameter edits through Escape', async () => {
    const user = userEvent.setup();
    renderDetail();
    await user.click(screen.getByRole('button', { name: copy.runsTitle }));
    expect(screen.getByText(copy.noRuns)).toBeVisible();
    await user.click(screen.getByRole('button', { name: copy.editParams }));
    const dialog = screen.getByRole('dialog', { name: copy.editParams });
    fireEvent.keyDown(dialog.closest('.MuiDialog-root') as HTMLElement, { key: 'Escape', code: 'Escape' });
    await waitForElementToBeRemoved(dialog);
  });
});
