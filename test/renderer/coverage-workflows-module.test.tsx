import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Workflow, WorkflowRun, WorkflowRunSummary, WorkflowUpdatedEvent } from '@shared/types';
import { getDictionary } from '@renderer/i18n';
import type { WorkflowDraft } from '@renderer/views/workflows/workflow-draft';
import { WorkflowsModule } from '@renderer/views/workflows/WorkflowsModule';

const childSpies = vi.hoisted(() => ({
  list: vi.fn(),
  editor: vi.fn(),
  detail: vi.fn(),
}));

vi.mock('@renderer/views/workflows/WorkflowsListView', () => ({
  WorkflowsListView: (props: Record<string, unknown>) => {
    childSpies.list(props);
    const workflows = props.workflows as Workflow[];
    return (
      <div>
        <span>List workflows: {workflows.map((item) => item.name).join(', ') || 'empty'}</span>
        <button onClick={() => (props.onCreate as () => void)()}>Create workflow</button>
        {workflows[0] ? (
          <>
            <button onClick={() => (props.onOpen as (id: string) => void)(workflows[0].id)}>Open workflow</button>
            <button onClick={() => (props.onToggleEnabled as (workflow: Workflow) => void)(workflows[0])}>Toggle workflow</button>
            <button onClick={() => (props.onRunNow as (workflow: Workflow) => void)(workflows[0])}>Run workflow</button>
            <button onClick={() => (props.onDelete as (workflow: Workflow) => void)(workflows[0])}>Delete workflow</button>
          </>
        ) : null}
      </div>
    );
  },
}));

vi.mock('@renderer/views/workflows/WorkflowEditorPage', () => ({
  WorkflowEditorPage: (props: Record<string, unknown>) => {
    childSpies.editor(props);
    return (
      <div>
        <span>Editor draft: {(props.draft as WorkflowDraft).name || 'unnamed'}</span>
        <span>Editor banner: {String((props.banner as { message?: string } | null)?.message ?? 'none')}</span>
        <button onClick={() => (props.onDraftChange as (updater: (draft: WorkflowDraft) => WorkflowDraft) => void)(
          (draft) => ({ ...draft, name: 'Created flow' }),
        )}>Name draft</button>
        <button onClick={() => (props.onDraftChange as (updater: (draft: WorkflowDraft) => WorkflowDraft) => void)(
          (draft) => ({
            ...draft,
            nodes: [{
              id: 'node-1', name: 'Check input', type: 'condition', position: { x: 0, y: 0 },
              expression: { left: 'input', operator: 'is_not_empty' },
            }],
          }),
        )}>Add node</button>
        <button onClick={() => (props.onDraftChange as (updater: (draft: WorkflowDraft) => WorkflowDraft) => void)(
          (draft) => ({
            ...draft,
            nodes: [{
              id: 'app-action', name: 'Write note', type: 'app_action', position: { x: 0, y: 0 }, appId: 'app-1',
              toolName: 'notes.add', input: {}, requiresApproval: true,
              action: { title: 'Add note', inputSchema: {}, outputSchema: {}, effect: 'write', risk: 'high', idempotent: false, contractHash: 'hash' },
            }],
          }),
        )}>Add valid app action</button>
        <button onClick={() => (props.onClearBanner as () => void)()}>Clear editor banner</button>
        <button onClick={() => (props.onSave as () => void)()}>Save editor</button>
        <button onClick={() => (props.onBack as () => void)()}>Back from editor</button>
      </div>
    );
  },
}));

vi.mock('@renderer/views/workflows/WorkflowDetailPage', () => ({
  WorkflowDetailPage: (props: Record<string, unknown>) => {
    childSpies.detail(props);
    return (
      <div>
        <span>Detail draft: {(props.draft as WorkflowDraft).name}</span>
        <span>Detail dirty: {String(props.dirty)}</span>
        <span>Detail banner: {String((props.banner as { message?: string } | null)?.message ?? 'none')}</span>
        <button onClick={() => (props.onDraftChange as (updater: (draft: WorkflowDraft) => WorkflowDraft) => void)(
          (draft) => ({ ...draft, name: 'Changed detail' }),
        )}>Change detail</button>
        <button onClick={() => (props.onClearBanner as () => void)()}>Clear detail banner</button>
        <button onClick={() => (props.onSave as () => void)()}>Save detail</button>
        <button onClick={() => (props.onDiscard as () => void)()}>Discard detail</button>
        <button onClick={() => (props.onBack as () => void)()}>Back from detail</button>
        <button onClick={() => (props.onRunNow as () => void)()}>Run detail</button>
        <button onClick={() => (props.onToggleEnabled as () => void)()}>Toggle detail</button>
        <button onClick={() => (props.onRunNode as (id: string) => void)('node-1')}>Run detail node</button>
        <button onClick={() => (props.onSelectRun as (id: string) => void)('run-other')}>Select other run</button>
        <button onClick={() => (props.onApproveNode as (id: string, approved: boolean) => void)('node-1', true)}>Approve detail node</button>
        <button onClick={() => (props.onApproveNode as (id: string, approved: boolean) => void)('node-1', false)}>Reject detail node</button>
        <button onClick={() => (props.onCancelRun as () => void)()}>Cancel detail run</button>
        <button onClick={() => (props.onReview as () => void)()}>Review detail</button>
        <button onClick={() => (props.onApplyReview as () => void)()}>Apply detail review</button>
        <button onClick={() => (props.onReloadRevisions as () => void)()}>Reload revisions</button>
        <button onClick={() => (props.onRestoreRevision as (revision: unknown) => void)({ id: 'revision-1', revision: 1, definitionHash: 'hash', createdAt: '2026-08-10T10:00:00.000Z', applied: false })}>Restore detail revision</button>
        <button onClick={() => (props.onRetryRun as (id: string) => void)('run-1')}>Retry detail run</button>
      </div>
    );
  },
}));

const t = getDictionary('en');
const node = {
  id: 'node-1', name: 'Check input', type: 'condition' as const, position: { x: 0, y: 0 },
  expression: { left: 'input', operator: 'is_not_empty' as const },
};
const workflow = (overrides: Partial<Workflow> = {}): Workflow => ({
  id: 'workflow-1', name: 'Morning brief', description: 'Daily summary', trigger: { type: 'manual' },
  nodes: [node], edges: [], enabled: true, running: false, nextRunAt: null,
  createdAt: '2026-08-10T08:00:00.000Z', updatedAt: '2026-08-10T09:00:00.000Z',
  ...overrides,
});
const summary = (id = 'run-1', overrides: Partial<WorkflowRunSummary> = {}): WorkflowRunSummary => ({
  id, workflowId: 'workflow-1', trigger: 'manual', status: 'succeeded',
  startedAt: '2026-08-10T10:00:00.000Z',
  nodeRuns: [{ nodeId: 'node-1', nodeName: 'Check input', nodeType: 'condition', status: 'succeeded', output: { ok: true } }],
  ...overrides,
});
const detailedRun = (id = 'run-1', overrides: Partial<WorkflowRun> = {}): WorkflowRun => ({
  ...summary(id), transcript: `Transcript ${id}`, ...overrides,
});

type WorkflowListener = (event: WorkflowUpdatedEvent) => void;

const buildApi = () => {
  let listener: WorkflowListener | null = null;
  const unsubscribe = vi.fn();
  const api = {
    workflowsList: vi.fn().mockResolvedValue([workflow()]),
    workflowsListRevisions: vi.fn().mockResolvedValue([]),
    workflowsListRuns: vi.fn().mockResolvedValue([summary()]),
    workflowsGetRun: vi.fn().mockImplementation(async (id: string) => detailedRun(id)),
    workflowsUpsert: vi.fn().mockImplementation(async (input: Record<string, unknown>) => workflow({
      id: String(input.id ?? 'workflow-created'), name: String(input.name), description: input.description as string | undefined,
    })),
    workflowsRunNow: vi.fn().mockResolvedValue(summary('run-manual')),
    workflowsSetEnabled: vi.fn().mockImplementation(async (_id: string, enabled: boolean) => workflow({ enabled })),
    workflowsDelete: vi.fn().mockResolvedValue(undefined),
    workflowsApproveNode: vi.fn().mockResolvedValue(undefined),
    workflowsReview: vi.fn().mockResolvedValue({ status: 'ready', issues: [], definitionHash: 'hash' }),
    workflowsApply: vi.fn().mockImplementation(async (id: string) => workflow({ id })),
    workflowsRestoreRevision: vi.fn().mockImplementation(async (id: string) => workflow({ id })),
    workflowsListAppActions: vi.fn().mockResolvedValue([{ toolName: 'notes.add', title: 'Add note', inputSchema: {}, outputSchema: {}, effect: 'write', risk: 'high', idempotent: false, contractHash: 'hash' }]),
    workflowsCancelRun: vi.fn().mockResolvedValue(undefined),
    workflowsRunNode: vi.fn().mockResolvedValue(summary('run-node')),
    workflowsRetryRun: vi.fn().mockResolvedValue(summary('run-retry')),
    listInstalledApps: vi.fn().mockResolvedValue([{ id: 'app-1', name: 'Notes' }]),
    personalAgentsList: vi.fn().mockResolvedValue([{ id: 'agent-1', name: 'Helper' }]),
    listAgentTools: vi.fn().mockResolvedValue([{ id: 'package-1', name: 'Package' }]),
    listOfficialTools: vi.fn().mockResolvedValue({ tools: [{ id: 'official-1', name: 'Official' }] }),
    personalAgentGrantOptionsList: vi.fn().mockResolvedValue({ connections: [{ id: 'connection-1', name: 'Mail' }] }),
    getCodexAuthStatus: vi.fn().mockResolvedValue({ authenticated: true }),
    getClaudeAuthStatus: vi.fn().mockResolvedValue({ authenticated: false }),
    getAntigravityAuthStatus: vi.fn().mockResolvedValue({ authenticated: true }),
    onWorkflowUpdated: vi.fn().mockImplementation((next: WorkflowListener) => {
      listener = next;
      return unsubscribe;
    }),
  };
  return { api, emit: (event: WorkflowUpdatedEvent) => listener?.(event), unsubscribe };
};

const installApi = (api: ReturnType<typeof buildApi>['api'] | undefined) => {
  Object.defineProperty(window, 'forger', { configurable: true, value: api });
};

const baseProps = {
  t,
  isPinned: false,
  onBackToMore: vi.fn(),
  onOpenList: vi.fn(),
  onOpenDetail: vi.fn(),
  onOpenEditor: vi.fn(),
};

beforeEach(() => {
  childSpies.list.mockClear();
  childSpies.editor.mockClear();
  childSpies.detail.mockClear();
  Object.values(baseProps).forEach((value) => {
    if (typeof value === 'function') value.mockClear();
  });
});

describe('WorkflowsModule', () => {
  it('loads list dependencies, handles live ordering, and wires list actions', async () => {
    const user = userEvent.setup();
    const { api, emit, unsubscribe } = buildApi();
    api.workflowsList.mockResolvedValueOnce([
      workflow({ id: 'older', name: 'Older', updatedAt: '2026-08-10T08:00:00.000Z' }),
      workflow({ id: 'newer', name: 'Newer', updatedAt: '2026-08-10T09:00:00.000Z' }),
    ]);
    installApi(api);
    const rendered = render(
      <WorkflowsModule {...baseProps} view="workflows" selectedWorkflowId={null} />,
    );

    await waitFor(() => expect(childSpies.list.mock.lastCall?.[0].workflows).toHaveLength(2));
    expect(api.listAgentTools).toHaveBeenCalledWith('en');
    expect(api.listOfficialTools).toHaveBeenCalledWith('en');
    await user.click(screen.getByRole('button', { name: t.more.back }));
    await user.click(screen.getByRole('button', { name: 'Create workflow' }));
    await user.click(screen.getByRole('button', { name: 'Open workflow' }));
    await user.click(screen.getByRole('button', { name: 'Toggle workflow' }));
    await user.click(screen.getByRole('button', { name: 'Run workflow' }));
    await user.click(screen.getByRole('button', { name: 'Delete workflow' }));
    await waitFor(() => {
      expect(baseProps.onBackToMore).toHaveBeenCalledOnce();
      expect(baseProps.onOpenEditor).toHaveBeenCalledWith(null);
      expect(baseProps.onOpenDetail).toHaveBeenCalled();
      expect(api.workflowsSetEnabled).toHaveBeenCalled();
      expect(api.workflowsRunNow).toHaveBeenCalled();
      expect(api.workflowsDelete).toHaveBeenCalled();
    });

    act(() => emit({ workflow: workflow({ id: 'older', name: 'Updated old', updatedAt: '2026-08-10T11:00:00.000Z' }) }));
    await waitFor(() => expect((childSpies.list.mock.lastCall?.[0].workflows as Workflow[])[0].name).toBe('Updated old'));
    act(() => emit({ workflow: workflow({ id: 'brand-new', name: 'Brand new', updatedAt: '2026-08-10T12:00:00.000Z' }) }));
    await waitFor(() => expect((childSpies.list.mock.lastCall?.[0].workflows as Workflow[])[0].name).toBe('Brand new'));

    rendered.rerender(<WorkflowsModule {...baseProps} view="workflows" selectedWorkflowId={null} isPinned />);
    expect(screen.queryByRole('button', { name: t.more.back })).not.toBeInTheDocument();
    rendered.unmount();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it('creates a workflow, validates its draft, maps save errors, and resets editor state', async () => {
    const user = userEvent.setup();
    const { api } = buildApi();
    api.workflowsList.mockResolvedValue([]);
    api.workflowsListRuns.mockResolvedValue([]);
    installApi(api);
    const rendered = render(
      <WorkflowsModule {...baseProps} view="workflowEditor" selectedWorkflowId={null} />,
    );
    await screen.findByText('Editor draft: unnamed');

    await user.click(screen.getByRole('button', { name: 'Save editor' }));
    await screen.findByText(`Editor banner: ${t.sections.workflows.nameRequired}`);
    await user.click(screen.getByRole('button', { name: 'Clear editor banner' }));
    await user.click(screen.getByRole('button', { name: 'Name draft' }));
    await user.click(screen.getByRole('button', { name: 'Save editor' }));
    await screen.findByText(`Editor banner: ${t.sections.workflows.nodesRequired}`);
    await user.click(screen.getByRole('button', { name: 'Add node' }));

    const failures: Array<[unknown, string]> = [
      [new Error('workflow_graph_has_cycle'), t.sections.workflows.graphInvalid],
      [new Error('workflow_foreach_join_not_allowed'), t.sections.workflows.forEachJoinNotAllowed],
      [new Error('workflow_foreach_requires_upstream'), t.sections.workflows.forEachRequiresUpstream],
      [new Error('unknown_failure'), t.sections.workflows.saveError],
      ['string failure', t.sections.workflows.saveError],
    ];
    for (const [failure, message] of failures) {
      api.workflowsUpsert.mockRejectedValueOnce(failure);
      await user.click(screen.getByRole('button', { name: 'Save editor' }));
      await screen.findByText(`Editor banner: ${message}`);
    }

    await user.click(screen.getByRole('button', { name: 'Save editor' }));
    await waitFor(() => expect(baseProps.onOpenDetail).toHaveBeenCalledWith('workflow-created'));
    expect(api.workflowsListRuns).toHaveBeenCalledWith('workflow-created');
    await user.click(screen.getByRole('button', { name: 'Back from editor' }));
    expect(baseProps.onOpenList).toHaveBeenCalledOnce();

    rendered.rerender(<WorkflowsModule {...baseProps} view="workflows" selectedWorkflowId={null} />);
    rendered.rerender(<WorkflowsModule {...baseProps} view="workflowEditor" selectedWorkflowId={null} />);
    await screen.findByText('Editor draft: unnamed');
    api.workflowsUpsert.mockClear();
    await user.click(screen.getByRole('button', { name: 'Add valid app action' }));
    await user.click(screen.getByRole('button', { name: 'Name draft' }));
    await user.click(screen.getByRole('button', { name: 'Save editor' }));
    await waitFor(() => expect(api.workflowsUpsert).toHaveBeenCalledWith(expect.objectContaining({ nodes: [expect.objectContaining({ toolName: 'notes.add' })] })));
  });

  it('loads details and run samples, saves edits, and wires every run operation', async () => {
    const user = userEvent.setup();
    const { api, emit } = buildApi();
    const runs = [
      summary('run-1'),
      summary('run-duplicate', { startedAt: '2026-08-10T09:00:00.000Z' }),
      summary('run-undefined', {
        startedAt: '2026-08-10T08:00:00.000Z',
        nodeRuns: [{ nodeId: 'node-undefined', nodeName: 'Undefined', nodeType: 'condition', status: 'succeeded' }],
      }),
      summary('run-failed', {
        startedAt: '2026-08-10T07:00:00.000Z',
        nodeRuns: [{ nodeId: 'node-failed', nodeName: 'Failed', nodeType: 'condition', status: 'failed', output: 'ignored' }],
      }),
    ];
    api.workflowsListRuns.mockResolvedValue(runs);
    installApi(api);
    render(
      <WorkflowsModule {...baseProps} view="workflowDetail" selectedWorkflowId="workflow-1" />,
    );
    await screen.findByText('Detail draft: Morning brief');
    await waitFor(() => expect(childSpies.detail.mock.lastCall?.[0].selectedRun?.id).toBe('run-1'));
    const firstProps = childSpies.detail.mock.lastCall?.[0];
    expect(firstProps.data.outputSamples).toEqual({ 'node-1': { ok: true } });
    expect([...firstProps.data.savedNodeIds]).toEqual(['node-1']);

    act(() => emit({ workflow: workflow(), run: summary('run-1', { status: 'running' }) }));
    await waitFor(() => expect(childSpies.detail.mock.lastCall?.[0].selectedRun).toEqual(expect.objectContaining({
      id: 'run-1', transcript: 'Transcript run-1', status: 'running',
    })));

    await user.click(screen.getByRole('button', { name: 'Change detail' }));
    await screen.findByText('Detail dirty: true');
    await user.click(screen.getByRole('button', { name: 'Save detail' }));
    await screen.findByText(`Detail banner: ${t.sections.workflows.saved}`);
    expect(baseProps.onOpenDetail).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Clear detail banner' }));
    await user.click(screen.getByRole('button', { name: 'Discard detail' }));
    await screen.findByText('Detail draft: Morning brief');
    await user.click(screen.getByRole('button', { name: 'Back from detail' }));
    await user.click(screen.getByRole('button', { name: 'Run detail' }));
    await user.click(screen.getByRole('button', { name: 'Toggle detail' }));
    await user.click(screen.getByRole('button', { name: 'Run detail node' }));
    await user.click(screen.getByRole('button', { name: 'Select other run' }));
    await user.click(screen.getByRole('button', { name: 'Approve detail node' }));
    await user.click(screen.getByRole('button', { name: 'Reject detail node' }));
    await user.click(screen.getByRole('button', { name: 'Cancel detail run' }));
    await waitFor(() => {
      expect(baseProps.onOpenList).toHaveBeenCalled();
      expect(api.workflowsRunNow).toHaveBeenCalledWith('workflow-1');
      expect(api.workflowsSetEnabled).toHaveBeenCalledWith('workflow-1', false);
      expect(api.workflowsRunNode).toHaveBeenCalledWith('workflow-1', 'node-1');
      expect(api.workflowsGetRun).toHaveBeenCalledWith('run-other');
      expect(api.workflowsApproveNode).toHaveBeenCalledWith({ runId: expect.any(String), nodeId: 'node-1', approved: true });
      expect(api.workflowsApproveNode).toHaveBeenCalledWith({ runId: expect.any(String), nodeId: 'node-1', approved: false });
      expect(api.workflowsCancelRun).toHaveBeenCalled();
    });

    act(() => emit({ workflow: workflow({ name: 'Live update', updatedAt: '2026-08-10T13:00:00.000Z' }), run: summary('run-live') }));
    await waitFor(() => expect((childSpies.detail.mock.lastCall?.[0].runs as WorkflowRunSummary[])[0].id).toBe('run-live'));
    act(() => emit({ workflow: workflow({ id: 'another' }), run: summary('run-ignored') }));
  });

  it('handles an empty run history and ignores callbacks that become stale after navigation', async () => {
    const { api, emit } = buildApi();
    api.workflowsListRuns.mockResolvedValue([]);
    installApi(api);
    const rendered = render(
      <WorkflowsModule {...baseProps} view="workflowDetail" selectedWorkflowId="workflow-1" />,
    );
    await screen.findByText('Detail draft: Morning brief');
    await waitFor(() => expect(childSpies.detail.mock.lastCall?.[0].selectedRun).toBeNull());
    const emptyProps = childSpies.detail.mock.lastCall?.[0];
    emptyProps.onApproveNode('node-1', true);
    emptyProps.onCancelRun();
    expect(api.workflowsApproveNode).not.toHaveBeenCalled();
    expect(api.workflowsCancelRun).not.toHaveBeenCalled();

    act(() => emit({ workflow: workflow(), run: summary('run-live', { status: 'running' }) }));
    await waitFor(() => expect(childSpies.detail.mock.lastCall?.[0].selectedRun).toEqual(expect.objectContaining({
      id: 'run-live', transcript: '',
    })));
    act(() => emit({ workflow: workflow(), run: summary('run-live', { status: 'succeeded' }) }));
    await waitFor(() => expect(childSpies.detail.mock.lastCall?.[0].selectedRun.status).toBe('succeeded'));

    const liveProps = childSpies.detail.mock.lastCall?.[0];
    liveProps.onSelectRun('run-1');
    await waitFor(() => expect(api.workflowsGetRun).toHaveBeenCalledWith('run-1'));
    rendered.rerender(<WorkflowsModule {...baseProps} view="workflowDetail" selectedWorkflowId={null} />);
    await waitFor(() => expect(screen.queryByText(/Detail draft:/)).not.toBeInTheDocument());
    liveProps.onApproveNode('node-1', true);
    liveProps.onCancelRun();
    liveProps.onRunNode('node-1');
    liveProps.onRetryRun('run-stale');
    await waitFor(() => {
      expect(api.workflowsApproveNode).toHaveBeenCalledTimes(1);
      expect(api.workflowsCancelRun).toHaveBeenCalledTimes(1);
      expect(api.workflowsRunNode).not.toHaveBeenCalled();
    });
  });

  it('handles missing details and rejected optional bootstrap calls', async () => {
    const { api } = buildApi();
    api.workflowsList.mockRejectedValue(new Error('offline'));
    api.listInstalledApps.mockRejectedValue(new Error('offline'));
    api.personalAgentsList.mockRejectedValue(new Error('offline'));
    api.listAgentTools.mockRejectedValue(new Error('offline'));
    api.listOfficialTools.mockRejectedValue(new Error('offline'));
    api.personalAgentGrantOptionsList.mockRejectedValue(new Error('offline'));
    api.getCodexAuthStatus.mockRejectedValue(new Error('offline'));
    api.getClaudeAuthStatus.mockRejectedValue(new Error('offline'));
    api.getAntigravityAuthStatus.mockRejectedValue(new Error('offline'));
    installApi(api);
    const rendered = render(
      <WorkflowsModule {...baseProps} view="workflowDetail" selectedWorkflowId="missing" />,
    );
    await waitFor(() => expect(api.getAntigravityAuthStatus).toHaveBeenCalled());
    expect(screen.queryByText(/Detail draft:/)).not.toBeInTheDocument();
    rendered.rerender(<WorkflowsModule {...baseProps} view="workflows" selectedWorkflowId={null} />);
    await screen.findByText('List workflows: empty');
  });

  it('fails closed when the desktop bridge is absent', () => {
    installApi(undefined);
    expect(() => render(
      <WorkflowsModule {...baseProps} view="workflows" selectedWorkflowId={null} />,
    )).toThrow('forger_bridge_unavailable');
  });

  it('covers app-action loading and review, revision, retry, and mutation failures', async () => {
    const user = userEvent.setup();
    const { api } = buildApi();
    api.workflowsList.mockResolvedValueOnce([workflow(), workflow({ id: 'other-workflow' })]);
    installApi(api);
    render(<WorkflowsModule {...baseProps} view="workflowDetail" selectedWorkflowId="workflow-1" />);
    await screen.findByText('Detail draft: Morning brief');
    const latest = () => childSpies.detail.mock.lastCall?.[0] as Record<string, any>;

    await act(async () => { latest().onApplyReview(); });
    await act(async () => { latest().data.onRequestAppActions?.('app-1'); });
    await waitFor(() => expect(api.workflowsListAppActions).toHaveBeenCalledWith('app-1'));
    await act(async () => { latest().data.onRequestAppActions?.('app-2'); latest().data.onRequestAppActions?.('app-1'); latest().data.onRequestAppActions?.(''); });
    await waitFor(() => expect(api.workflowsListAppActions).toHaveBeenCalledWith('app-2'));
    expect(api.workflowsListAppActions).toHaveBeenCalledTimes(2);
    api.workflowsListAppActions.mockRejectedValueOnce(new Error('offline'));
    await act(async () => { latest().data.onRequestAppActions?.('app-3'); });
    await waitFor(() => expect(latest().banner?.message).toBe(t.sections.workflows.appActionLoadError));

    await act(async () => { latest().onReview(); });
    await waitFor(() => expect(api.workflowsReview).toHaveBeenCalledWith('workflow-1'));
    api.workflowsApply.mockResolvedValueOnce(workflow({ id: 'workflow-1' }));
    await act(async () => { latest().onApplyReview(); });
    await waitFor(() => expect(api.workflowsApply).toHaveBeenCalledWith('workflow-1', expect.objectContaining({ definitionHash: 'hash' })));
    await act(async () => { latest().onReview(); });
    await waitFor(() => expect(latest().review?.status).toBe('ready'));
    api.workflowsApply.mockResolvedValueOnce(workflow({ id: 'workflow-1', review: { status: 'ready', issues: [], definitionHash: 'hash' } }));
    await act(async () => { latest().onApplyReview(); });
    await waitFor(() => expect(api.workflowsApply).toHaveBeenCalledTimes(2));
    latest().onCloseReview();
    await act(async () => { latest().onReloadRevisions(); });
    await waitFor(() => expect(api.workflowsListRevisions).toHaveBeenCalled());
    await act(async () => { latest().onRestoreRevision({ id: 'revision-1', revision: 1, definitionHash: 'hash', createdAt: '2026-08-10T10:00:00.000Z', applied: false }); });
    await waitFor(() => expect(api.workflowsRestoreRevision).toHaveBeenCalled());
    await act(async () => { latest().onRetryRun('run-1'); });
    await waitFor(() => expect(api.workflowsRetryRun).toHaveBeenCalledWith('run-1'));

    api.workflowsReview.mockRejectedValueOnce(new Error('offline'));
    await act(async () => { latest().onReview(); });
    await waitFor(() => expect(latest().banner?.message).toBe(t.sections.workflows.reviewError));
    api.workflowsReview.mockResolvedValueOnce({ status: 'ready', issues: [], definitionHash: 'hash' });
    await act(async () => { latest().onReview(); });
    await waitFor(() => expect(latest().review?.status).toBe('ready'));
    api.workflowsApply.mockRejectedValueOnce(new Error('offline'));
    await act(async () => { latest().onApplyReview(); });
    await waitFor(() => expect(latest().banner?.message).toBe(t.sections.workflows.applyError));
    api.workflowsRunNow.mockRejectedValueOnce(new Error('offline'));
    await act(async () => { latest().onRunNow(); });
    await waitFor(() => expect(latest().banner?.message).toBe(t.sections.workflows.appliedRequired));
    api.workflowsSetEnabled.mockRejectedValueOnce(new Error('offline'));
    await act(async () => { latest().onToggleEnabled(); });
    await waitFor(() => expect(latest().banner?.message).toBe(t.sections.workflows.activationError));
    api.workflowsRestoreRevision.mockRejectedValueOnce(new Error('offline'));
    await act(async () => { latest().onRestoreRevision({ id: 'revision-2', revision: 2, definitionHash: 'hash', createdAt: '2026-08-11T10:00:00.000Z', applied: false }); });
    await waitFor(() => expect(latest().banner?.message).toBe(t.sections.workflows.restoreError));
    api.workflowsRetryRun.mockRejectedValueOnce(new Error('offline'));
    await act(async () => { latest().onRetryRun('run-2'); });
    await waitFor(() => expect(latest().banner?.message).toBe(t.sections.workflows.retryError));

    cleanup();
    render(<WorkflowsModule {...baseProps} view="workflowEditor" selectedWorkflowId={null} />);
    await screen.findByText('Editor draft: unnamed');
    const editorProps = childSpies.editor.mock.lastCall?.[0] as Record<string, any>;
    editorProps.onDraftChange((draft: WorkflowDraft) => ({
      ...draft,
      name: 'Invalid app action',
      nodes: [{ id: 'app', name: 'App action', type: 'app_action', appId: '', toolName: '', input: {}, action: {
        title: '', inputSchema: {}, outputSchema: {}, effect: 'unknown', risk: 'high', idempotent: false, contractHash: '',
      } }],
    }));
    await screen.findByText('Editor draft: Invalid app action');
    await user.click(screen.getByRole('button', { name: 'Save editor' }));
    await screen.findByText(`Editor banner: ${t.sections.workflows.appActionSelectionRequired}`);
  });
});
