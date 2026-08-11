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
  ]));
  const manager = new WorkflowManager(baseOptions(root, {
    getValidToolIds: () => new Set(['forger_refresh_app_view']),
  }));
  t.after(() => manager.dispose());

  await manager.initialize();
  const legacy = manager.get('legacy');
  assert.equal(legacy.description, 'Legacy description');
  assert.equal(typeof legacy.nextRunAt, 'string');
  assert.equal(typeof legacy.createdAt, 'string');
  assert.equal(typeof legacy.updatedAt, 'string');

  const run = await manager.runNow('legacy');
  await waitForRun(manager, run.id);
  const updated = await manager.upsert({
    id: 'legacy',
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

  const stepRun = manager.createRunRecord(workflow, 'step', 'queued');
  manager.collectLatestOutputs = async () => { throw 'step failure'; };
  await manager.executeSingleNode(workflow.id, stepRun, 'condition');
  assert.equal((await manager.getRun(stepRun.id)).error, 'workflow_step_failed');

  const errorStepRun = manager.createRunRecord(workflow, 'step', 'queued');
  manager.collectLatestOutputs = async () => { throw new Error('step Error'); };
  await manager.executeSingleNode(workflow.id, errorStepRun, 'condition');
  assert.equal((await manager.getRun(errorStepRun.id)).error, 'step Error');

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

  manager.executeNode = async () => { throw 'node failure'; };
  const parallel = await manager.runNow(workflow.id);
  const parallelResult = await waitForRun(manager, parallel.id);
  assert.equal(parallelResult.status, 'failed');
  assert.equal(parallelResult.nodeRuns[0].error, 'workflow_node_failed');

  manager.executeNode = async () => { throw new Error('node Error'); };
  const errorParallel = await manager.runNow(workflow.id);
  const errorParallelResult = await waitForRun(manager, errorParallel.id);
  assert.equal(errorParallelResult.nodeRuns[0].error, 'node Error');

  const outerRun = manager.createRunRecord(workflow, 'manual', 'queued');
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

  assert.equal((await manager.executeForgerToolNode(toolNode, context)).error, 'workflow_forger_tools_unavailable');
  manager.options.callForgerToolAction = async () => ({ success: false, userMessage: 'tool user failure' });
  assert.equal((await manager.executeForgerToolNode(toolNode, context)).error, 'tool user failure');
  manager.options.callForgerToolAction = async () => ({ success: false });
  assert.equal((await manager.executeForgerToolNode(toolNode, context)).error, 'workflow_forger_tool_failed');
  manager.options.callForgerToolAction = async () => ({ success: true });
  assert.deepEqual((await manager.executeForgerToolNode(toolNode, context)).output, { value: null });
  manager.options.callForgerToolAction = async () => ({ success: true, data: ['item'] });
  assert.deepEqual((await manager.executeForgerToolNode(toolNode, context)).output, { value: ['item'] });
  manager.options.callForgerToolAction = async () => { throw 'tool rejected'; };
  assert.equal((await manager.executeForgerToolNode(toolNode, context)).error, 'workflow_forger_tool_failed');

  assert.equal((await manager.executeConnectionNode(connectionNode, context)).error, 'workflow_connections_unavailable');
  manager.options.callConnectionAction = async () => ({ success: false, userMessage: 'connection user failure' });
  assert.equal((await manager.executeConnectionNode(connectionNode, context)).error, 'connection user failure');
  manager.options.callConnectionAction = async () => ({ success: false });
  assert.equal((await manager.executeConnectionNode(connectionNode, context)).error, 'workflow_connection_failed');
  manager.options.callConnectionAction = async () => ({ success: true });
  assert.deepEqual((await manager.executeConnectionNode(connectionNode, context)).output, { value: null });
  manager.options.callConnectionAction = async () => ({ success: true, data: 0 });
  assert.deepEqual((await manager.executeConnectionNode(connectionNode, context)).output, { value: 0 });
  manager.options.callConnectionAction = async () => { throw 'connection rejected'; };
  assert.equal((await manager.executeConnectionNode(connectionNode, context)).error, 'workflow_connection_failed');
  manager.options.callConnectionAction = async () => { throw new Error('connection Error'); };
  assert.equal((await manager.executeConnectionNode(connectionNode, context)).error, 'connection Error');
  assert.equal(manager.buildNodeDebugInput(connectionNode, context).connectionId, 'primary');
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

  manager.executeNodeOnce = async () => ({ status: 'failed' });
  const failed = await manager.executeNodeForEach(workflow, run, node, context, active, path.join(root, 'foreach.log'));
  assert.equal(failed.error, 'workflow_foreach_item_failed:0:workflow_node_failed');

  manager.executeNodeOnce = async () => ({ status: 'succeeded' });
  const succeeded = await manager.executeNodeForEach(workflow, run, node, context, active, path.join(root, 'foreach.log'));
  assert.deepEqual(succeeded.output, { items: [{}], count: 1, result: false });

  active.canceled = true;
  const canceled = await manager.executeNodeForEach(workflow, run, node, context, active, path.join(root, 'foreach.log'));
  assert.equal(canceled.status, 'canceled');

  const states = {
    ok: { status: 'succeeded' },
    failed: { status: 'failed' },
  };
  assert.deepEqual(manager.buildAgentInputContext({ ...context, item: { id: 1 }, itemIndex: 0, nodes: states }), {
    trigger: context.trigger,
    item: { id: 1 },
    itemIndex: 0,
    nodes: {
      ok: { status: 'succeeded', output: null, summary: null, error: null },
      failed: { status: 'failed', output: null, summary: null, error: null },
    },
  });

  manager.executeNodeOnce = async () => ({ status: 'failed' });
  const nodeStates = { condition: { status: 'pending' } };
  const canceledActive = { canceled: true, children: new Set(), approvalResolvers: new Map() };
  await manager.executeNode(workflow, run, { ...conditionNode(), requiresApproval: false }, nodeStates, context.trigger, canceledActive, path.join(root, 'node.log'), async () => undefined);
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
    manager.nodeCompletions.set('run-success:agent', { status: 'succeeded' });
    return { code: 0, stdout: '', stderr: '' };
  };
  const succeeded = await manager.runAgentNode(workflow, { id: 'run-success' }, node, context, active, path.join(root, 'agent.log'), config);
  assert.deepEqual(succeeded.output, {});
  assert.equal(succeeded.summary, 'Assistant fallback');

  agentCommandRunner.runAgentCommand = async () => {
    manager.nodeCompletions.set('run-failure:agent', { status: 'failed' });
    return { code: 0, stdout: '', stderr: '' };
  };
  const failed = await manager.runAgentNode(workflow, { id: 'run-failure' }, node, context, active, path.join(root, 'agent.log'), config);
  assert.equal(failed.error, 'workflow_node_reported_failure');

  manager.options.getAgentRuntime = async () => { throw 'runtime rejected'; };
  const rejected = await manager.runAgentNode(workflow, { id: 'run-rejected' }, node, context, active, path.join(root, 'agent.log'), config);
  assert.equal(rejected.error, 'workflow_agent_exec_failed');

  manager.options.getAgentRuntime = async () => { throw new Error('runtime Error'); };
  manager.options.onAgentRunActivity = (activity) => {
    if (activity.status === 'failed') throw new Error('activity callback failed');
  };
  await assert.rejects(
    manager.runAgentNode(workflow, { id: 'run-finally' }, node, context, active, path.join(root, 'agent.log'), config),
    /activity callback failed/,
  );

  manager.options.getAgentRuntime = async () => ({ provider: 'codex', model: 'test', effort: 'low' });
  manager.options.onAgentRunActivity = () => undefined;
  manager.options.createForgerMcpSession = () => ({ url: 'http://127.0.0.1/mcp', token: 'token' });
  manager.options.releaseForgerMcpSession = () => { throw new Error('release failed'); };
  agentCommandRunner.runAgentCommand = async () => ({ code: 0, stdout: '', stderr: '' });
  await assert.rejects(
    manager.runAgentNode(workflow, { id: 'run-release' }, node, context, active, path.join(root, 'agent.log'), config),
    /release failed/,
  );

  const prompt = manager.buildNodePrompt(
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
  const personal = await noAgentManager.executeForgerAgentNode(workflow, { id: 'run' }, { ...node, type: 'forger_agent', agentId: 'missing' }, context, active, path.join(root, 'personal.log'));
  assert.equal(personal.error, 'workflow_personal_agent_not_found');
});

test('Given bridge defaults and scheduling fallbacks, when optional values are absent, then safe defaults and paused schedules are used', async (t) => {
  const { root, manager } = await createManager('workflow-optional-defaults');
  t.after(async () => {
    await manager.dispose();
    await fs.rm(root, { recursive: true, force: true });
  });

  manager.nodeContexts.set('node-key', { workflowId: 'wf', runId: 'run', nodeId: 'node' });
  assert.equal(manager.completeNodeFromMcp('node-key', { output: null }).success, true);
  assert.deepEqual(manager.nodeCompletions.get('node-key'), { status: 'succeeded', output: {}, summary: undefined });

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

  manager.workflows.get(workflow.id).enabled = false;
  await manager.advanceSchedule(workflow.id);
  assert.equal(manager.workflows.get(workflow.id).nextRunAt, null);

  const stepRun = manager.createRunRecord(workflow, 'step', 'queued');
  manager.executeNode = async (_workflow, _run, node, states, _trigger, active) => {
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

  manager.trackRunTask('rejected-task', Promise.reject(new Error('run task failed')));
  manager.queueActivityPersistence({ runId: 'activity' });

  await assert.rejects(manager.dispose(), (error) => {
    assert.equal(error instanceof AggregateError, true);
    assert.equal(error.errors.length, 2);
    assert.deepEqual(error.errors.map((entry) => entry.message).sort(), ['activity persistence failed', 'run task failed']);
    return true;
  });
});
