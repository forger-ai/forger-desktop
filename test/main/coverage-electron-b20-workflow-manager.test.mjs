import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { WorkflowManager } = require('../../dist-electron/main/workflow-manager.js');
const agentCommandRunner = require('../../dist-electron/main/automation/agent-command-runner.js');

const tmpRoot = async (name) => fs.mkdtemp(path.join(os.tmpdir(), `forger-b20-${name}-`));

const baseOptions = (root, overrides = {}) => ({
  forgerHomeRoot: root,
  metadataRoot: root,
  codexHome: path.join(root, 'codex-home'),
  getAgentRuntime: async () => ({ provider: 'codex', model: 'test', effort: 'low' }),
  getInstalledApps: () => [],
  getCodexCliPath: async () => null,
  getClaudeCliPath: async () => null,
  getCodexPathEntries: async () => [],
  getCodexAuthenticated: async () => false,
  getClaudeAuthenticated: async () => false,
  onWorkflowUpdated: () => undefined,
  ...overrides,
});

const createManager = async (name, overrides = {}) => {
  const root = await tmpRoot(name);
  const manager = new WorkflowManager(baseOptions(root, overrides));
  await manager.initialize();
  return { root, manager };
};

const conditionNode = (id = 'condition') => ({
  id,
  name: `Condition ${id}`,
  type: 'condition',
  expression: { left: 1, operator: 'equals', right: 1 },
});

const waitForRun = async (manager, runId) => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const run = await manager.getRun(runId);
    if (run && ['succeeded', 'failed', 'canceled', 'skipped'].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('workflow_run_timeout');
};

test('Given a prepared run is disposed before launch, then it is canceled and missing scheduled state is ignored safely', async (t) => {
  const { root, manager } = await createManager('workflow-prepared-cancel');
  t.after(async () => {
    await manager.dispose().catch(() => undefined);
    await fs.rm(root, { recursive: true, force: true });
  });
  const workflow = await manager.upsert({
    name: 'Prepared cancel',
    trigger: { type: 'manual' },
    nodes: [conditionNode()],
    edges: [],
  });
  const originalWithWorkflowLock = manager.withWorkflowLock.bind(manager);
  manager.withWorkflowLock = async (id, operation) => {
    const result = await originalWithWorkflowLock(id, operation);
    if (result?.execute) manager.disposed = true;
    return result;
  };
  const canceled = await manager.startRun(workflow.id, 'manual');
  assert.equal(canceled.status, 'canceled');
  await manager.skipMissedRunUnlocked('missing-workflow', 'workflow_missed_schedule');
});

test('Given legacy scheduled workflows and a valid tool registry, when initialization normalizes them, then defaults and schedules are restored', async (t) => {
  const root = await tmpRoot('workflow-normalization');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'workflows.json'), JSON.stringify([
    {
      id: 'legacy',
      name: 'Legacy',
      description: 'Legacy description',
      trigger: { type: 'scheduled', frequency: { type: 'hourly' } },
      nodes: [conditionNode()],
      edges: [],
      enabled: true,
    },
    {
      id: 'applied-legacy',
      name: 'Applied legacy',
      trigger: { type: 'manual' },
      nodes: [conditionNode()],
      edges: [],
      enabled: true,
      revision: 2,
      revisionId: 'applied-legacy-revision',
      appliedRevisionId: 'applied-legacy-revision',
    },
  ]));
  const manager = new WorkflowManager(baseOptions(root, {
    getValidToolIds: () => new Set(['forger_refresh_app_view']),
  }));
  t.after(() => manager.dispose());

  await manager.initialize();
  const legacy = manager.get('legacy');
  assert.equal(manager.get('applied-legacy').appliedRevisionId, 'applied-legacy-revision');
  assert.equal(manager.get('applied-legacy').revisionId, 'applied-legacy-revision');
  assert.equal(legacy.description, 'Legacy description');
  assert.equal(typeof legacy.nextRunAt, 'string');
  assert.equal(typeof legacy.createdAt, 'string');
  assert.equal(typeof legacy.updatedAt, 'string');
  await manager.store.deleteRevisions('applied-legacy');
  const originalReadRevisions = manager.store.readRevisions;
  manager.store.readRevisions = async () => [];
  await manager.initialize();
  manager.store.readRevisions = originalReadRevisions;
  assert.equal(manager.get('applied-legacy').appliedRevisionId, 'applied-legacy-revision');
  const migratedRevisions = await manager.store.readRevisions('applied-legacy');
  assert.equal(migratedRevisions[0].applied, true);
  assert.equal(typeof migratedRevisions[0].appliedAt, 'string');

  const run = await manager.runNow('legacy');
  await waitForRun(manager, run.id);
  const updated = await manager.upsert({
    id: 'legacy',
    expectedRevision: legacy.revision,
    name: 'Legacy updated',
    trigger: { type: 'manual' },
    nodes: [conditionNode()],
    edges: [],
  });
  assert.equal(updated.lastRun.id, run.id);
  assert.equal(updated.enabled, true);
});

test('Given step and parallel executor failures, when runs settle, then non-Error failures become safe persisted codes and disposed managers reject new work', async (t) => {
  const { root, manager } = await createManager('workflow-run-errors');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workflow = await manager.upsert({
    name: 'Failure handling',
    trigger: { type: 'manual' },
    nodes: [conditionNode()],
    edges: [],
  });

  const workflowRevision = (await manager.listRevisions(workflow.id))[0];
  const stepRun = manager.createRunRecord(workflow, workflowRevision, 'step', 'queued');
  manager.collectLatestOutputs = async () => { throw 'step failure'; };
  await manager.executeSingleNode(workflow.id, stepRun, 'condition');
  assert.equal((await manager.getRun(stepRun.id)).error, 'workflow_step_failed');

  const errorStepRun = manager.createRunRecord(workflow, workflowRevision, 'step', 'queued');
  manager.collectLatestOutputs = async () => { throw new Error('step Error'); };
  await manager.executeSingleNode(workflow.id, errorStepRun, 'condition');
  assert.equal((await manager.getRun(errorStepRun.id)).error, 'step Error');

  const preflightStepRun = manager.createRunRecord(workflow, workflowRevision, 'step', 'queued');
  manager.collectLatestOutputs = WorkflowManager.prototype.collectLatestOutputs.bind(manager);
  manager.options.releaseAppActions = () => undefined;
  manager.nodeRuntime.preflightAppActionNodes = async () => { throw new Error('single-step preflight failed'); };
  await manager.executeSingleNode(workflow.id, preflightStepRun, 'condition');
  assert.equal(preflightStepRun.error, 'single-step preflight failed');
  await manager.store.appendRunId(workflow.id, preflightStepRun.id);
  await manager.store.appendRunId(workflow.id, 'missing-list-run');
  assert.equal((await manager.listRuns(workflow.id)).some((run) => run.id === preflightStepRun.id), true);
  manager.nodeRuntime.preflightAppActionNodes = async () => undefined;

  const originalRunNodeLock = manager.withWorkflowLock.bind(manager);
  manager.withWorkflowLock = async (id, operation) => {
    const result = await originalRunNodeLock(id, operation);
    if (result?.execute) manager.disposed = true;
    return result;
  };
  const canceledStep = await manager.runNode(workflow.id, 'condition');
  assert.equal(canceledStep.status, 'canceled');
  manager.disposed = false;
  manager.withWorkflowLock = originalRunNodeLock;

  const originalAppendRunId = manager.store.appendRunId;
  manager.store.appendRunId = async () => { throw new Error('run index write failed'); };
  await assert.rejects(manager.startRun(workflow.id, 'manual'), /run index write failed/);
  manager.store.appendRunId = originalAppendRunId;

  const twoNodeWorkflow = await manager.upsert({
    name: 'No stored samples',
    trigger: { type: 'manual' },
    nodes: [conditionNode('first'), conditionNode('second')],
    edges: [{ from: 'first', to: 'second', condition: 'success' }],
  });
  manager.collectLatestOutputs = WorkflowManager.prototype.collectLatestOutputs.bind(manager);
  const stepWithoutSamples = await manager.runNode(twoNodeWorkflow.id, 'second');
  await waitForRun(manager, stepWithoutSamples.id);
  assert.equal((await manager.getRun(stepWithoutSamples.id)).nodeRuns.find((entry) => entry.nodeId === 'first').status, 'skipped');
  await manager.store.appendRunId(twoNodeWorkflow.id, 'missing-run');
  await manager.collectLatestOutputs(twoNodeWorkflow.id);

  manager.nodeRuntime.executeNode = async () => { throw 'node failure'; };
  const parallel = await manager.runNow(workflow.id);
  const parallelResult = await waitForRun(manager, parallel.id);
  assert.equal(parallelResult.status, 'failed');
  assert.equal(parallelResult.nodeRuns[0].error, 'workflow_node_failed');

  manager.nodeRuntime.executeNode = async () => { throw new Error('node Error'); };
  const errorParallel = await manager.runNow(workflow.id);
  const errorParallelResult = await waitForRun(manager, errorParallel.id);
  assert.equal(errorParallelResult.nodeRuns[0].error, 'node Error');

  const outerRun = manager.createRunRecord(workflow, workflowRevision, 'manual', 'queued');
  manager.requireWorkflow = () => { throw 'run failure'; };
  await manager.executeRun(workflow.id, outerRun);
  assert.equal((await manager.getRun(outerRun.id)).error, 'workflow_run_failed');

  await manager.dispose();
  await assert.rejects(manager.runNow(workflow.id), /workflow_manager_disposed/);
});

test('Given tool and connection actions, when executors are missing, reject, throw, or return scalar data, then node results stay structured', async (t) => {
  const { root, manager } = await createManager('workflow-action-results');
  t.after(async () => {
    await manager.dispose();
    await fs.rm(root, { recursive: true, force: true });
  });
  const context = { trigger: { type: 'manual' }, nodes: {} };
  const toolNode = { id: 'tool', name: 'Tool', type: 'forger_tool', toolId: 'forger_refresh_app_view', input: {} };
  const connectionNode = {
    id: 'connection',
    name: 'Connection',
    type: 'connection',
    connectionType: 'slack',
    connectionId: 'primary',
    actionId: 'slack.send_message',
    input: {},
  };

  assert.equal((await manager.nodeRuntime.executeForgerToolNode(toolNode, context)).error, 'workflow_forger_tools_unavailable');
  manager.options.callForgerToolAction = async () => ({ success: false, userMessage: 'tool user failure' });
  assert.equal((await manager.nodeRuntime.executeForgerToolNode(toolNode, context)).error, 'tool user failure');
  manager.options.callForgerToolAction = async () => ({ success: false });
  assert.equal((await manager.nodeRuntime.executeForgerToolNode(toolNode, context)).error, 'workflow_forger_tool_failed');
  manager.options.callForgerToolAction = async () => ({ success: true });
  assert.deepEqual((await manager.nodeRuntime.executeForgerToolNode(toolNode, context)).output, { value: null });
  manager.options.callForgerToolAction = async () => ({ success: true, data: ['item'] });
  assert.deepEqual((await manager.nodeRuntime.executeForgerToolNode(toolNode, context)).output, { value: ['item'] });
  manager.options.callForgerToolAction = async () => { throw 'tool rejected'; };
  assert.equal((await manager.nodeRuntime.executeForgerToolNode(toolNode, context)).error, 'workflow_forger_tool_failed');

  assert.equal((await manager.nodeRuntime.executeConnectionNode(connectionNode, context)).error, 'workflow_connections_unavailable');
  manager.options.callConnectionAction = async () => ({ success: false, userMessage: 'connection user failure' });
  assert.equal((await manager.nodeRuntime.executeConnectionNode(connectionNode, context)).error, 'connection user failure');
  manager.options.callConnectionAction = async () => ({ success: false });
  assert.equal((await manager.nodeRuntime.executeConnectionNode(connectionNode, context)).error, 'workflow_connection_failed');
  manager.options.callConnectionAction = async () => ({ success: true });
  assert.deepEqual((await manager.nodeRuntime.executeConnectionNode(connectionNode, context)).output, { value: null });
  manager.options.callConnectionAction = async () => ({ success: true, data: 0 });
  assert.deepEqual((await manager.nodeRuntime.executeConnectionNode(connectionNode, context)).output, { value: 0 });
  manager.options.callConnectionAction = async () => { throw 'connection rejected'; };
  assert.equal((await manager.nodeRuntime.executeConnectionNode(connectionNode, context)).error, 'workflow_connection_failed');
  manager.options.callConnectionAction = async () => { throw new Error('connection Error'); };
  assert.equal((await manager.nodeRuntime.executeConnectionNode(connectionNode, context)).error, 'connection Error');
  assert.equal(manager.nodeRuntime.buildNodeDebugInput(connectionNode, context).connectionId, 'primary');
});

test('Given forEach edge results and canceled nodes, when iteration runs, then defaults, partial output, and cancellation are preserved', async (t) => {
  const { root, manager } = await createManager('workflow-foreach-edges');
  t.after(async () => {
    await manager.dispose();
    await fs.rm(root, { recursive: true, force: true });
  });
  const workflow = { id: 'wf', name: 'Workflow', nodes: [], edges: [] };
  const run = { id: 'run', workflowId: 'wf' };
  const node = { ...conditionNode(), forEach: '{{nodes.source.output.items}}' };
  const context = {
    trigger: { type: 'manual' },
    nodes: { source: { status: 'succeeded', output: { items: ['a'] } } },
  };
  const active = { canceled: false, children: new Set(), approvalResolvers: new Map() };

  manager.nodeRuntime.executeNodeOnce = async () => ({ status: 'failed' });
  const failed = await manager.nodeRuntime.executeNodeForEach(workflow, run, node, context, active, path.join(root, 'foreach.log'));
  assert.equal(failed.error, 'workflow_foreach_item_failed:0:workflow_node_failed');

  manager.nodeRuntime.executeNodeOnce = async () => ({ status: 'succeeded' });
  const succeeded = await manager.nodeRuntime.executeNodeForEach(workflow, run, node, context, active, path.join(root, 'foreach.log'));
  assert.deepEqual(succeeded.output, { items: [{}], count: 1, result: false });

  active.canceled = true;
  const canceled = await manager.nodeRuntime.executeNodeForEach(workflow, run, node, context, active, path.join(root, 'foreach.log'));
  assert.equal(canceled.status, 'canceled');

  const originalAppendTranscript = agentCommandRunner.appendTranscript;
  agentCommandRunner.appendTranscript = async () => {
    active.canceled = true;
  };
  try {
    active.canceled = false;
    const canceledAfterTranscript = await manager.nodeRuntime.executeNodeForEach(
      workflow,
      run,
      node,
      context,
      active,
      path.join(root, 'foreach-after-transcript.log'),
    );
    assert.equal(canceledAfterTranscript.status, 'canceled');
  } finally {
    agentCommandRunner.appendTranscript = originalAppendTranscript;
  }

  const states = {
    ok: { status: 'succeeded' },
    failed: { status: 'failed' },
  };
  assert.deepEqual(manager.nodeRuntime.buildAgentInputContext({ ...context, item: { id: 1 }, itemIndex: 0, nodes: states }), {
    trigger: context.trigger,
    item: { id: 1 },
    itemIndex: 0,
    nodes: {
      ok: { status: 'succeeded', output: null, summary: null, error: null },
      failed: { status: 'failed', output: null, summary: null, error: null },
    },
  });

  manager.nodeRuntime.executeNodeOnce = async () => ({ status: 'failed' });
  const nodeStates = { condition: { status: 'pending' } };
  const canceledActive = { canceled: true, children: new Set(), approvalResolvers: new Map() };
  await manager.nodeRuntime.executeNode(workflow, run, { ...conditionNode(), requiresApproval: false }, nodeStates, context.trigger, canceledActive, path.join(root, 'node.log'), async () => undefined);
  assert.equal(nodeStates.condition.status, 'canceled');
});

test('Given agent completion and prompt variants, when an agent reports through MCP or setup throws, then outputs, summaries, diagnostics, and cleanup are deterministic', async (t) => {
  const { root, manager } = await createManager('workflow-agent-edges', {
    getInstalledApps: () => [{ id: 'app-without-name', status: 'installed' }],
    getCodexAuthenticated: async () => true,
    getCodexCliPath: async () => process.execPath,
    getAgentNetworkAccess: async () => true,
    onAgentRunActivity: () => undefined,
  });
  t.after(async () => {
    await manager.dispose();
    await fs.rm(root, { recursive: true, force: true });
  });
  const originalRunAgentCommand = agentCommandRunner.runAgentCommand;
  t.after(() => { agentCommandRunner.runAgentCommand = originalRunAgentCommand; });
  const workflow = { id: 'wf', name: 'Workflow', nodes: [], edges: [] };
  const node = {
    id: 'agent',
    name: 'Agent',
    type: 'llm_agent',
    prompt: 'Use context',
    appIds: ['app-without-name'],
    toolIds: [],
    connectionGrants: [],
  };
  const context = { trigger: { type: 'manual' }, nodes: {} };
  const active = { canceled: false, children: new Set(), approvalResolvers: new Map() };
  const config = { prompt: node.prompt, appIds: node.appIds, toolIds: [], connectionGrants: [] };

  agentCommandRunner.runAgentCommand = async (_cli, options) => {
    options.onAssistantMessages(['Assistant fallback']);
    manager.nodeRuntime.nodeCompletions.set('run-success:agent', { status: 'succeeded' });
    return { code: 0, stdout: '', stderr: '' };
  };
  const succeeded = await manager.nodeRuntime.runAgentNode(workflow, { id: 'run-success' }, node, context, active, path.join(root, 'agent.log'), config);
  assert.deepEqual(succeeded.output, {});
  assert.equal(succeeded.summary, 'Assistant fallback');

  agentCommandRunner.runAgentCommand = async () => {
    manager.nodeRuntime.nodeCompletions.set('run-failure:agent', { status: 'failed' });
    return { code: 0, stdout: '', stderr: '' };
  };
  const failed = await manager.nodeRuntime.runAgentNode(workflow, { id: 'run-failure' }, node, context, active, path.join(root, 'agent.log'), config);
  assert.equal(failed.error, 'workflow_node_reported_failure');

  manager.options.getAgentRuntime = async () => { throw 'runtime rejected'; };
  const rejected = await manager.nodeRuntime.runAgentNode(workflow, { id: 'run-rejected' }, node, context, active, path.join(root, 'agent.log'), config);
  assert.equal(rejected.error, 'workflow_agent_exec_failed');

  manager.options.getAgentRuntime = async () => { throw new Error('runtime Error'); };
  manager.options.onAgentRunActivity = (activity) => {
    if (activity.status === 'failed') throw new Error('activity callback failed');
  };
  await assert.rejects(
    manager.nodeRuntime.runAgentNode(workflow, { id: 'run-finally' }, node, context, active, path.join(root, 'agent.log'), config),
    /activity callback failed/,
  );

  manager.options.getAgentRuntime = async () => ({ provider: 'codex', model: 'test', effort: 'low' });
  manager.options.onAgentRunActivity = () => undefined;
  manager.options.createForgerMcpSession = () => ({ url: 'http://127.0.0.1/mcp', token: 'token' });
  manager.options.releaseForgerMcpSession = () => { throw new Error('release failed'); };
  agentCommandRunner.runAgentCommand = async () => ({ code: 0, stdout: '', stderr: '' });
  await assert.rejects(
    manager.nodeRuntime.runAgentNode(workflow, { id: 'run-release' }, node, context, active, path.join(root, 'agent.log'), config),
    /release failed/,
  );

  const prompt = manager.nodeRuntime.buildNodePrompt(
    workflow,
    node,
    { prompt: node.prompt, appIds: node.appIds, outputSchema: { type: 'object' } },
    context,
    { large: 'x'.repeat(13_000) },
  );
  assert.match(prompt, /app-without-name/);
  assert.match(prompt, /truncated, call workflow_get_context/);
  assert.match(prompt, /Expected Output Schema/);

  const noAgentManager = new WorkflowManager(baseOptions(path.join(root, 'no-agent')));
  const personal = await noAgentManager.nodeRuntime.executeForgerAgentNode(workflow, { id: 'run' }, { ...node, type: 'forger_agent', agentId: 'missing' }, context, active, path.join(root, 'personal.log'));
  assert.equal(personal.error, 'workflow_personal_agent_not_found');
});

test('Given bridge defaults and scheduling fallbacks, when optional values are absent, then safe defaults and paused schedules are used', async (t) => {
  const { root, manager } = await createManager('workflow-optional-defaults');
  t.after(async () => {
    await manager.dispose();
    await fs.rm(root, { recursive: true, force: true });
  });

  manager.nodeRuntime.nodeContexts.set('node-key', { workflowId: 'wf', runId: 'run', nodeId: 'node' });
  assert.equal(manager.completeNodeFromMcp('node-key', { output: null }).success, true);
  assert.deepEqual(manager.nodeRuntime.nodeCompletions.get('node-key'), { status: 'succeeded', output: {}, summary: undefined });

  const workflow = await manager.upsert({
    name: 'Scheduled fallback',
    description: 'Keeps description',
    trigger: { type: 'scheduled', frequency: { type: 'hourly' } },
    nodes: [conditionNode()],
    edges: [],
    enabled: true,
  });
  const stored = manager.workflows.get(workflow.id);
  stored.trigger.missedRunPolicy = 'within_window';
  stored.trigger.missedRunWindowMinutes = undefined;
  stored.nextRunAt = new Date(Date.now() - 2 * 60_000).toISOString();
  manager.startRun = async () => undefined;
  await manager.handleDueScheduledRun(workflow.id);

  await manager.setEnabled(workflow.id, false);
  await manager.advanceScheduleUnlocked(workflow.id);
  assert.equal(manager.workflows.get(workflow.id).nextRunAt, null);

  const workflowRevision = (await manager.listRevisions(workflow.id))[0];
  const stepRun = manager.createRunRecord(workflow, workflowRevision, 'step', 'queued');
  manager.nodeRuntime.executeNode = async (_workflow, _run, node, states, _trigger, active) => {
    active.canceled = true;
    states[node.id] = { status: 'canceled' };
  };
  await manager.executeSingleNode(workflow.id, stepRun, 'condition');
  assert.equal((await manager.getRun(stepRun.id)).status, 'canceled');
});

test('Given rejected background run and activity persistence tasks, when disposing, then all failures are awaited and surfaced together without handles', async (t) => {
  const { root, manager } = await createManager('workflow-background-errors', {
    persistAgentRunActivity: async () => { throw new Error('activity persistence failed'); },
  });
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  manager.runTasks.set('rejected-task', Promise.reject(new Error('run task failed')));
  manager.runTasks.set('aggregate-task', Promise.reject(new AggregateError([new Error('nested task failed')], 'aggregate task failure')));
  manager.nodeRuntime.backgroundFailures.push(new Error('activity persistence failed'));

  await assert.rejects(manager.dispose(), (error) => {
    assert.equal(error instanceof AggregateError, true);
    assert.equal(error.errors.length, 3);
    assert.deepEqual(error.errors.map((entry) => entry.message).sort(), ['activity persistence failed', 'nested task failed', 'run task failed']);
    return true;
  });
});

test('Given a non-aggregate activity flush failure, dispose still reports the original error safely', async (t) => {
  const { root, manager } = await createManager('workflow-dispose-flush-error');
  t.after(async () => {
    await manager.dispose().catch(() => undefined);
    await fs.rm(root, { recursive: true, force: true });
  });
  const released = [];
  manager.options.releaseAppActions = async (runId) => released.push(runId);
  manager.activeRuns.set('active-run', {
    workflowId: 'workflow',
    canceled: false,
    children: new Set(),
    actionAbortControllers: new Set(),
    approvalResolvers: new Map(),
  });
  manager.nodeRuntime.flushActivityPersistence = async () => { throw new Error('flush failed'); };
  await assert.rejects(manager.dispose(), (error) => {
    assert.equal(error instanceof AggregateError, true);
    assert.deepEqual(error.errors.map((entry) => entry.message), ['flush failed']);
    return true;
  });
  assert.deepEqual(released, ['active-run']);
});

test('Given workflow lifecycle edge states, when scheduling, persisting, retrying, and canceling, then every boundary remains deterministic', async (t) => {
  const { root, manager } = await createManager('workflow-boundary-sweep');
  t.after(async () => {
    await manager.dispose().catch(() => undefined);
    await fs.rm(root, { recursive: true, force: true });
  });
  const workflow = await manager.upsert({
    name: 'Boundary workflow',
    trigger: { type: 'manual' },
    nodes: [conditionNode()],
    edges: [],
  });
  const revision = (await manager.listRevisions(workflow.id))[0];

  await assert.rejects(manager.runNow(workflow.id, 'scheduled'), /workflow_schedule_not_active/);
  await assert.rejects(manager.runNode(workflow.id, 'missing'), /workflow_node_not_found/);
  manager.workflows.get(workflow.id).running = true;
  const skipped = await manager.runNode(workflow.id, 'condition');
  assert.equal(skipped.status, 'skipped');
  manager.workflows.get(workflow.id).running = false;
  const originalAppendRunId = manager.store.appendRunId;
  manager.store.appendRunId = async () => { throw new Error('single-step run index failed'); };
  await assert.rejects(manager.runNode(workflow.id, 'condition'), /single-step run index failed/);
  manager.store.appendRunId = originalAppendRunId;
  await assert.rejects(manager.setEnabled(workflow.id, true), /workflow_applied_revision_required/);
  Object.assign(manager.workflows.get(workflow.id), {
    appliedRevision: revision.revision,
    appliedRevisionId: revision.id,
    appliedTrigger: revision.workflow.trigger,
  });
  await assert.rejects(manager.setEnabled(workflow.id, true), /workflow_manual_cannot_activate/);

  // Exercise the persistence branches for orphan and finishing active runs.
  const orphan = manager.createRunRecord(workflow, revision, 'manual', 'queued');
  await manager.persistRunUnlocked('orphan-workflow', orphan);
  const finishing = manager.createRunRecord(workflow, revision, 'manual', 'queued');
  manager.activeRuns.set(finishing.id, { workflowId: workflow.id, canceled: false, children: new Set(), actionAbortControllers: new Set(), approvalResolvers: new Map() });
  finishing.status = 'succeeded';
  await manager.persistRunUnlocked(workflow.id, finishing);
  manager.activeRuns.delete(finishing.id);

  await manager.markWorkflowRunningUnlocked('missing-workflow', true);
  await manager.markWorkflowRunningUnlocked(workflow.id, true);
  await manager.markWorkflowRunningUnlocked(workflow.id, false);
  manager.workflows.get(workflow.id).appliedRevisionId = revision.id;
  Object.assign(manager.workflows.get(workflow.id), {
    enabled: true,
    nextRunAt: new Date(Date.now() + 60_000).toISOString(),
  });
  await manager.scheduleWorkflow(workflow.id);
  await manager.handleDueScheduledRun(workflow.id);
  await manager.advanceScheduleUnlocked(workflow.id);
  assert.throws(
    () => manager.requireAppliedRevision({ ...workflow, appliedRevisionId: 'missing-applied-revision' }),
    /workflow_applied_revision_required/,
  );
  assert.throws(
    () => manager.requireRunnableRevision({ id: 'missing-workflow', revisionId: 'missing-revision' }),
    /workflow_revision_not_found/,
  );
  manager.revisions.set('missing-workflow', []);
  assert.throws(
    () => manager.requireRunnableRevision({ id: 'missing-workflow', revisionId: 'missing-revision' }),
    /workflow_revision_not_found/,
  );
  await assert.rejects(manager.trackOperation(Promise.reject(new Error('tracked operation failed'))), /tracked operation failed/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.throws(
    () => manager.assertWorkflowReadyToApply(workflow, { expectedRevision: workflow.revision, definitionHash: 'hash' }),
    /workflow_review_required/,
  );
  await assert.rejects(manager.retryRun('unknown-run'), /workflow_retry_not_safe/);
  const missingRevisionRun = manager.createRunRecord(workflow, revision, 'manual', 'failed', 'failed');
  missingRevisionRun.safeToRetry = true;
  missingRevisionRun.workflowRevisionId = 'missing-revision';
  missingRevisionRun.definitionHash = 'missing-definition';
  await manager.store.writeRun(missingRevisionRun);
  await assert.rejects(manager.retryRun(missingRevisionRun.id), /workflow_retry_revision_unavailable/);
  const applyCandidate = await manager.upsert({
    name: 'Missing applied revision',
    trigger: { type: 'manual' },
    nodes: [conditionNode()],
    edges: [],
  });
  const applyReport = await manager.review(applyCandidate.id);
  manager.revisions.set(applyCandidate.id, []);
  await assert.rejects(
    manager.apply(applyCandidate.id, { expectedRevision: applyCandidate.revision, definitionHash: applyReport.definitionHash }),
    /workflow_revision_not_found/,
  );
  assert.throws(() => manager.workflowForRun({ workflowId: workflow.id, workflowRevisionId: 'missing', definitionHash: 'missing' }), /workflow_run_revision_unavailable/);
  assert.throws(() => manager.assertExpectedRevision(workflow, 0), /workflow_revision_conflict/);

  const scheduled = await manager.upsert({
    name: 'Scheduled boundary',
    trigger: { type: 'scheduled', frequency: { type: 'hourly' } },
    nodes: [conditionNode()],
    edges: [],
  });
  const scheduledRevision = (await manager.listRevisions(scheduled.id))[0];
  const scheduledEntry = manager.workflows.get(scheduled.id);
  Object.assign(scheduledEntry, {
    enabled: true,
    appliedRevision: scheduledRevision.revision,
    appliedRevisionId: scheduledRevision.id,
    appliedTrigger: scheduledRevision.workflow.trigger,
    nextRunAt: 'not-a-date',
  });
  await manager.handleDueScheduledRun(scheduled.id);
  manager.workflows.get(scheduled.id).enabled = false;
  await manager.advanceScheduleUnlocked(scheduled.id);
  manager.workflows.get(scheduled.id).nextRunAt = new Date(Date.now() + 60_000).toISOString();
  manager.workflows.get(scheduled.id).enabled = true;
  manager.workflows.get(scheduled.id).nextRunAt = new Date(Date.now() + 60_000).toISOString();
  await manager.handleDueScheduledRun(scheduled.id);
  manager.clearTimer(scheduled.id);
  manager.workflows.get(scheduled.id).nextRunAt = new Date(Date.now() - 120_000).toISOString();
  await manager.handleDueScheduledRun(scheduled.id);
  manager.clearTimer(scheduled.id);
  await manager.scheduleWorkflow(scheduled.id);
  manager.clearTimer(scheduled.id);
  manager.timers.set('manual-timer', setTimeout(() => undefined, 60_000));
  manager.clearTimer('manual-timer');
  manager.disposed = true;
  await manager.scheduleWorkflow(scheduled.id);
  manager.disposed = false;
  manager.clearTimer(scheduled.id);

  const canceled = manager.createRunRecord(workflow, revision, 'manual', 'queued');
  canceled.nodeRuns.push({ id: 'already-finished', nodeId: 'condition', status: 'succeeded' });
  await manager.cancelPreparedRun(workflow.id, canceled);
  assert.equal(canceled.status, 'canceled');
  manager.killChild({ pid: null, kill: () => { throw new Error('already gone'); } });
  const originalKill = process.kill;
  process.kill = () => { throw new Error('group already gone'); };
  try {
    manager.killChild({ pid: 123, kill: () => undefined });
  } finally {
    process.kill = originalKill;
  }

  const interrupted = { ...workflow, id: 'interrupted', lastRun: { id: 'missing', status: 'running' } };
  const absent = { ...workflow, id: 'interrupted-absent', lastRun: { id: 'absent', status: 'queued' } };
  manager.workflows.set(interrupted.id, interrupted);
  manager.workflows.set(absent.id, absent);
  await manager.store.writeRun({ ...canceled, id: 'missing', workflowId: interrupted.id, status: 'running', nodeRuns: [] });
  await manager.failInterruptedRuns();
  assert.equal(manager.workflows.get(interrupted.id).lastRun.status, 'failed');
  await assert.rejects(
    manager.restoreRevision(workflow.id, {
      revisionId: 'missing-revision',
      expectedRevision: manager.get(workflow.id).revision,
    }),
    /workflow_revision_not_found/,
  );
  manager.options.getValidToolIds = () => [];
  await manager.restoreRevision(workflow.id, {
    revisionId: revision.id,
    expectedRevision: manager.get(workflow.id).revision,
  });
});

test('Given a reviewed workflow revision, when normalizing and requesting revisions, then review metadata is preserved and mismatches fail closed', async (t) => {
  const { root, manager } = await createManager('workflow-review-normalization');
  t.after(async () => {
    await manager.dispose();
    await fs.rm(root, { recursive: true, force: true });
  });
  const workflow = await manager.upsert({
    name: 'Reviewed workflow',
    trigger: { type: 'manual' },
    nodes: [conditionNode()],
    edges: [],
  });
  await manager.review(workflow.id);
  const normalized = manager.normalizeWorkflow(manager.get(workflow.id));
  assert.equal(normalized.review.status, 'ready');
  assert.deepEqual(normalized.review.issues, []);
  const blocked = manager.normalizeWorkflow({
    ...manager.get(workflow.id),
    review: { ...manager.get(workflow.id).review, status: 'blocked' },
  });
  assert.equal(blocked.review.status, 'blocked');
  const manualEnabled = manager.normalizeWorkflow({
    ...manager.get(workflow.id),
    enabled: true,
    nextRunAt: undefined,
  });
  assert.equal(manualEnabled.nextRunAt, null);
  const revision = (await manager.listRevisions(workflow.id))[0];
  assert.equal(manager.requireRequestedRevision(workflow.id, revision).id, revision.id);
  assert.throws(
    () => manager.requireRequestedRevision(workflow.id, { id: revision.id, definitionHash: 'stale' }),
    /workflow_run_revision_unavailable/,
  );
  const originalPreflight = manager.nodeRuntime.preflightAppActionNodes;
  manager.nodeRuntime.preflightAppActionNodes = async () => {
    manager.workflows.get(workflow.id).revisionId = 'stale-reviewed-revision';
  };
  await assert.rejects(
    manager.apply(workflow.id, {
      expectedRevision: workflow.revision,
      definitionHash: normalized.review.definitionHash,
    }),
    /workflow_review_stale/,
  );
  manager.nodeRuntime.preflightAppActionNodes = originalPreflight;
});
