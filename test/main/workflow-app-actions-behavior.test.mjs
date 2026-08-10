import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { WorkflowManager } = require('../../dist-electron/main/workflow-manager.js');
const { WorkflowStore } = require('../../dist-electron/main/workflow/store.js');
const { sanitizeWorkflowNode } = require('../../dist-electron/main/workflow/sanitize.js');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const waitForRunEnd = async (manager, runId, timeoutMs = 5_000) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const run = await manager.getRun(runId);
    if (run && ['succeeded', 'failed', 'canceled', 'skipped'].includes(run.status)) return run;
    await wait(20);
  }
  throw new Error('waitForRunEnd_timeout');
};

const waitForRunStatus = async (manager, runId, status, timeoutMs = 5_000) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const run = await manager.getRun(runId);
    if (run?.status === status) return run;
    await wait(20);
  }
  throw new Error(`waitForRunStatus_timeout:${status}`);
};

const contractFor = (appName, actionTitle, outputSchema, overrides = {}) => ({
  appName,
  appVersion: '1.2.3',
  actionTitle,
  description: `${actionTitle} description`,
  inputSchema: { type: 'object' },
  outputSchema,
  annotations: { readOnlyHint: false },
  effect: 'write',
  ...overrides,
});

const definitionFor = (appId, toolName, outputSchema, overrides = {}) => ({
  appId,
  appName: appId === 'app-a' ? 'App A' : 'App B',
  appVersion: '1.2.3',
  toolName,
  title: toolName === 'find' ? 'Find record' : 'Save record',
  description: 'Deterministic app action',
  inputSchema: { type: 'object' },
  outputSchema,
  annotations: { readOnlyHint: toolName === 'find' },
  effect: toolName === 'find' ? 'read' : 'write',
  ...overrides,
});

const appActionNode = (id, appId, toolName, input, contract = contractFor(
  appId === 'app-a' ? 'App A' : 'App B',
  toolName === 'find' ? 'Find record' : 'Save record',
  { type: 'object' },
  { annotations: { readOnlyHint: toolName === 'find' }, effect: toolName === 'find' ? 'read' : 'write' },
)) => ({
  id,
  name: id === 'a' ? 'Find in A' : 'Save in B',
  type: 'app_action',
  appId,
  toolName,
  input,
  ...(contract ? { contract } : {}),
});

const workflowInput = (nodes, edges = []) => ({
  name: 'A to B without AI',
  trigger: { type: 'manual' },
  nodes,
  edges,
});

const createHarness = async ({ prepareAppActions, callAppAction } = {}) => {
  const metadataRoot = await mkdtemp(join(tmpdir(), 'forger-wf-app-action-'));
  const providerCalls = [];
  const releases = [];
  const manager = new WorkflowManager({
    forgerHomeRoot: metadataRoot,
    metadataRoot,
    codexHome: join(metadataRoot, 'codex-home'),
    getAgentRuntime: async (...args) => {
      providerCalls.push(args);
      throw new Error('provider_must_not_run_for_app_action');
    },
    getInstalledApps: () => [
      { id: 'app-a', name: 'App A', status: 'installed' },
      { id: 'app-b', name: 'App B', status: 'installed' },
    ],
    getCodexCliPath: async () => { providerCalls.push(['codex']); return null; },
    getClaudeCliPath: async () => { providerCalls.push(['claude']); return null; },
    getCodexPathEntries: async () => [],
    getCodexAuthenticated: async () => { providerCalls.push(['codex-auth']); return false; },
    getClaudeAuthenticated: async () => { providerCalls.push(['claude-auth']); return false; },
    prepareAppActions,
    callAppAction,
    releaseAppActions: (runId) => releases.push(runId),
    onWorkflowUpdated: () => undefined,
  });
  await manager.initialize();
  return {
    manager,
    metadataRoot,
    providerCalls,
    releases,
    cleanup: async () => {
      manager.dispose();
      await rm(metadataRoot, { recursive: true, force: true });
    },
  };
};

test('app_action survives sanitization and persisted workflow storage with its frozen contract', async () => {
  const contract = contractFor('App A', 'Find record', {
    type: 'object',
    required: ['record'],
    properties: { record: { type: 'object' } },
  });
  const rawNode = {
    ...appActionNode('a', 'app-a', 'find', { query: '  fixed value  ' }, contract),
    position: { x: 10, y: 20 },
    requiresApproval: true,
  };

  const sanitized = sanitizeWorkflowNode(rawNode);
  assert.deepEqual(sanitized, rawNode);

  const metadataRoot = await mkdtemp(join(tmpdir(), 'forger-wf-app-action-store-'));
  try {
    const store = new WorkflowStore({ metadataRoot });
    await store.initialize();
    const persistedWorkflow = {
      id: 'wf-app-action',
      name: 'Persisted app action',
      trigger: { type: 'manual' },
      nodes: [sanitized],
      edges: [],
      enabled: false,
      running: false,
      nextRunAt: null,
      createdAt: '2026-08-09T00:00:00.000Z',
      updatedAt: '2026-08-09T00:00:00.000Z',
    };
    await store.saveWorkflows([persistedWorkflow]);
    assert.deepEqual(await store.readWorkflows(), [persistedWorkflow]);
  } finally {
    await rm(metadataRoot, { recursive: true, force: true });
  }
});

test('an incomplete app_action is rejected instead of being silently dropped from a mixed workflow', async () => {
  const harness = await createHarness();
  try {
    await assert.rejects(
      () => harness.manager.upsert(workflowInput([
        appActionNode('a', '', '', {}),
        { id: 'condition', name: 'Keep me', type: 'condition', expression: { left: 'yes', operator: 'equals', right: 'yes' } },
      ])),
      /workflow_app_action_incomplete/,
    );
    assert.deepEqual(harness.manager.list(), []);
  } finally {
    await harness.cleanup();
  }
});

test('an app_action without a frozen contract persists as a pending draft but cannot preflight or cause effects until the current contract is adopted', async () => {
  let preflights = 0;
  let effects = 0;
  const outputSchema = {
    type: 'object',
    required: ['recordId'],
    properties: { recordId: { type: 'string' } },
  };
  const definition = definitionFor('app-a', 'find', outputSchema);
  const harness = await createHarness({
    prepareAppActions: async () => {
      preflights += 1;
      return [definition];
    },
    callAppAction: async () => {
      effects += 1;
      return { structuredContent: { recordId: 'record-42' } };
    },
  });
  try {
    const pending = await harness.manager.upsert(workflowInput([
      appActionNode('a', 'app-a', 'find', { query: 'invoice' }, null),
    ]));
    assert.equal(pending.nodes[0].contract, undefined, 'the pending draft remains editable and persisted');
    assert.deepEqual(harness.manager.get(pending.id)?.nodes[0].input, { query: 'invoice' });

    const blockedSummary = await harness.manager.runNow(pending.id);
    const blocked = await waitForRunEnd(harness.manager, blockedSummary.id);
    assert.equal(blocked.status, 'failed');
    assert.equal(blocked.error, 'workflow_app_action_contract_required');
    assert.equal(preflights, 0, 'missing snapshots are rejected before starting any app MCP session');
    assert.equal(effects, 0);

    const adoptedContract = contractFor('App A', 'Find record', outputSchema, {
      annotations: { readOnlyHint: true },
      effect: 'read',
    });
    const adopted = await harness.manager.upsert({
      ...workflowInput([
        appActionNode('a', 'app-a', 'find', { query: 'invoice' }, adoptedContract),
      ]),
      id: pending.id,
    });
    assert.deepEqual(adopted.nodes[0].input, { query: 'invoice' }, 'adopting the compatible contract preserves configured input');

    const runnableSummary = await harness.manager.runNow(adopted.id);
    const runnable = await waitForRunEnd(harness.manager, runnableSummary.id);
    assert.equal(runnable.status, 'succeeded');
    assert.equal(preflights, 1);
    assert.equal(effects, 1);
    assert.deepEqual(runnable.nodeRuns[0].output, { recordId: 'record-42' });
  } finally {
    await harness.cleanup();
  }
});

test('global preflight discovers every selected app action before A has any effect, then B receives A structured output without an LLM', async () => {
  const events = [];
  const aOutputSchema = {
    type: 'object',
    required: ['record'],
    properties: { record: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } },
  };
  const bOutputSchema = {
    type: 'object',
    required: ['savedId'],
    properties: { savedId: { type: 'string' } },
  };
  const definitions = [
    definitionFor('app-a', 'find', aOutputSchema),
    definitionFor('app-b', 'save', bOutputSchema),
  ];
  const harness = await createHarness({
    prepareAppActions: async (selections, runId) => {
      events.push({ type: 'preflight', selections, runId });
      return definitions;
    },
    callAppAction: async (request) => {
      events.push({ type: 'call', request });
      if (request.appId === 'app-a') {
        return { structuredContent: { record: { id: 'record-42' } } };
      }
      assert.deepEqual(request.input, { sourceId: 'record-42', fixed: true });
      return { structuredContent: { savedId: request.input.sourceId } };
    },
  });
  try {
    const workflow = await harness.manager.upsert(workflowInput([
      appActionNode('a', 'app-a', 'find', { query: 'invoice' }, contractFor('App A', 'Find record', aOutputSchema, {
        annotations: { readOnlyHint: true },
        effect: 'read',
      })),
      appActionNode('b', 'app-b', 'save', {
        sourceId: '{{nodes.a.output.record.id}}',
        fixed: true,
      }, contractFor('App B', 'Save record', bOutputSchema)),
    ], [{ from: 'a', to: 'b', condition: 'success' }]));
    const summary = await harness.manager.runNow(workflow.id);
    const finished = await waitForRunEnd(harness.manager, summary.id);

    assert.equal(finished.status, 'succeeded');
    assert.deepEqual(finished.nodeRuns.find((entry) => entry.nodeId === 'a').output, { record: { id: 'record-42' } });
    assert.deepEqual(finished.nodeRuns.find((entry) => entry.nodeId === 'b').output, { savedId: 'record-42' });
    assert.equal(events[0].type, 'preflight');
    assert.deepEqual(events[0].selections, [
      { appId: 'app-a', toolName: 'find' },
      { appId: 'app-b', toolName: 'save' },
    ]);
    assert.deepEqual(events.slice(1).map((entry) => `${entry.request.appId}:${entry.request.toolName}`), [
      'app-a:find',
      'app-b:save',
    ]);
    assert.equal(harness.providerCalls.length, 0, 'deterministic actions never resolve or invoke an LLM provider');
    assert.deepEqual(harness.releases, [summary.id], 'the run-scoped MCP session is always released');
    assert.equal(JSON.stringify(finished).includes('structuredContent'), false, 'only the structured object becomes node output');
  } finally {
    await harness.cleanup();
  }
});

test('contract drift blocks the run before any action is called', async () => {
  let effects = 0;
  const savedOutputSchema = {
    type: 'object',
    required: ['recordId'],
    properties: { recordId: { type: 'string' } },
  };
  const currentOutputSchema = {
    type: 'object',
    required: ['recordId', 'revision'],
    properties: { recordId: { type: 'string' }, revision: { type: 'number' } },
  };
  const harness = await createHarness({
    prepareAppActions: async () => [definitionFor('app-a', 'find', currentOutputSchema)],
    callAppAction: async () => { effects += 1; return { structuredContent: { recordId: '42', revision: 2 } }; },
  });
  try {
    const workflow = await harness.manager.upsert(workflowInput([
      appActionNode('a', 'app-a', 'find', {}, contractFor('App A', 'Find record', savedOutputSchema, {
        annotations: { readOnlyHint: true },
        effect: 'read',
      })),
    ]));
    const summary = await harness.manager.runNow(workflow.id);
    const finished = await waitForRunEnd(harness.manager, summary.id);
    assert.equal(finished.status, 'failed');
    assert.equal(finished.error, 'workflow_app_action_contract_changed');
    assert.equal(effects, 0);
    assert.deepEqual(harness.releases, [summary.id]);
  } finally {
    await harness.cleanup();
  }
});

test('an open-world read action always pauses for approval before its first external effect', async () => {
  let effects = 0;
  const outputSchema = { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } };
  const definition = definitionFor('app-a', 'find', outputSchema, {
    annotations: { readOnlyHint: true, openWorldHint: true },
    effect: 'external',
  });
  const harness = await createHarness({
    prepareAppActions: async () => [definition],
    callAppAction: async () => { effects += 1; return { structuredContent: { ok: true } }; },
  });
  try {
    const workflow = await harness.manager.upsert(workflowInput([
      appActionNode('a', 'app-a', 'find', {}, contractFor('App A', 'Find record', outputSchema, {
        annotations: { readOnlyHint: true, openWorldHint: true },
        effect: 'external',
      })),
    ]));
    const summary = await harness.manager.runNow(workflow.id);
    const waiting = await waitForRunStatus(harness.manager, summary.id, 'waiting_approval');
    assert.equal(waiting.pendingApprovalNodeId, 'a');
    assert.deepEqual(waiting.nodeRuns.find((nodeRun) => nodeRun.nodeId === 'a')?.input, {
      appId: 'app-a',
      appName: 'App A',
      toolName: 'find',
      actionTitle: 'Find record',
      effect: 'external',
      input: {},
    });
    assert.equal(effects, 0);
    assert.equal((await harness.manager.approveNode({ runId: summary.id, nodeId: 'a', approved: true })).success, true);
    const finished = await waitForRunEnd(harness.manager, summary.id);
    assert.equal(finished.status, 'succeeded');
    assert.equal(effects, 1);
  } finally {
    await harness.cleanup();
  }
});

test('preflight fails closed before any action when an app/tool is missing or an output schema is absent', async (t) => {
  const cases = [
    ['app missing', 'workflow_app_action_app_not_installed'],
    ['MCP missing', 'workflow_app_action_mcp_not_declared'],
    ['required secrets missing', 'workflow_app_action_required_secrets_missing'],
    ['secrets unavailable', 'workflow_app_action_secrets_unavailable'],
    ['MCP start failure', 'workflow_app_action_start_failed'],
    ['tool listing failure', 'workflow_app_action_list_failed'],
  ];
  for (const [label, code] of cases) {
    await t.test(label, async () => {
      let effects = 0;
      const harness = await createHarness({
        prepareAppActions: async () => { throw new Error(code); },
        callAppAction: async () => { effects += 1; return { structuredContent: { ok: true } }; },
      });
      try {
        const workflow = await harness.manager.upsert(workflowInput([
          appActionNode('a', 'app-a', 'find', {}),
          appActionNode('b', 'app-b', 'save', {}),
        ], [{ from: 'a', to: 'b', condition: 'success' }]));
        const summary = await harness.manager.runNow(workflow.id);
        const finished = await waitForRunEnd(harness.manager, summary.id);
        assert.equal(finished.status, 'failed');
        assert.equal(finished.error, code);
        assert.equal(effects, 0);
        assert.deepEqual(harness.releases, [summary.id]);
      } finally {
        await harness.cleanup();
      }
    });
  }

  await t.test('unknown tool returned by discovery', async () => {
    let effects = 0;
    const harness = await createHarness({
      prepareAppActions: async () => [definitionFor('app-a', 'another-tool', { type: 'object' })],
      callAppAction: async () => { effects += 1; return { structuredContent: { ok: true } }; },
    });
    try {
      const workflow = await harness.manager.upsert(workflowInput([
        appActionNode('a', 'app-a', 'find', {}),
      ]));
      const summary = await harness.manager.runNow(workflow.id);
      const finished = await waitForRunEnd(harness.manager, summary.id);
      assert.equal(finished.error, 'workflow_app_action_tool_not_found');
      assert.equal(effects, 0);
      assert.deepEqual(harness.releases, [summary.id]);
    } finally {
      await harness.cleanup();
    }
  });

  await t.test('discovered action without output schema', async () => {
    let effects = 0;
    const harness = await createHarness({
      prepareAppActions: async () => [definitionFor('app-a', 'find', undefined)],
      callAppAction: async () => { effects += 1; return { structuredContent: { ok: true } }; },
    });
    try {
      const workflow = await harness.manager.upsert(workflowInput([appActionNode('a', 'app-a', 'find', {})]));
      const summary = await harness.manager.runNow(workflow.id);
      const finished = await waitForRunEnd(harness.manager, summary.id);
      assert.equal(finished.error, 'workflow_app_action_output_schema_required');
      assert.equal(effects, 0);
      assert.deepEqual(harness.releases, [summary.id]);
    } finally {
      await harness.cleanup();
    }
  });
});

test('input and structured output schemas fail closed with stable app-action errors and no text fallback', async (t) => {
  const outputSchema = {
    type: 'object',
    required: ['total'],
    properties: { total: { type: 'number' } },
  };

  await t.test('invalid resolved input is rejected before tools/call', async () => {
    let effects = 0;
    const definition = definitionFor('app-a', 'find', outputSchema, {
      inputSchema: { type: 'object', required: ['count'], properties: { count: { type: 'number' } } },
    });
    const harness = await createHarness({
      prepareAppActions: async () => [definition],
      callAppAction: async () => { effects += 1; return { structuredContent: { total: 1 } }; },
    });
    try {
      const workflow = await harness.manager.upsert(workflowInput([appActionNode('a', 'app-a', 'find', { count: 'one' }, contractFor(
        'App A', 'Find record', outputSchema, { inputSchema: definition.inputSchema, annotations: { readOnlyHint: true }, effect: 'read' },
      ))]));
      const summary = await harness.manager.runNow(workflow.id);
      const finished = await waitForRunEnd(harness.manager, summary.id);
      assert.equal(finished.error, 'workflow_app_action_input_invalid');
      assert.equal(effects, 0);
      assert.deepEqual(harness.releases, [summary.id]);
    } finally {
      await harness.cleanup();
    }
  });

  const badOutputs = [
    ['missing structuredContent despite text content', { content: [{ type: 'text', text: '{"total":1}' }] }],
    ['structuredContent is an array', { structuredContent: [{ total: 1 }] }],
    ['structuredContent violates outputSchema', { structuredContent: { total: 'one' } }],
  ];
  for (const [label, result] of badOutputs) {
    await t.test(label, async () => {
      const harness = await createHarness({
        prepareAppActions: async () => [definitionFor('app-a', 'find', outputSchema)],
        callAppAction: async () => result,
      });
      try {
        const workflow = await harness.manager.upsert(workflowInput([appActionNode('a', 'app-a', 'find', {}, contractFor(
          'App A', 'Find record', outputSchema, { annotations: { readOnlyHint: true }, effect: 'read' },
        ))]));
        const summary = await harness.manager.runNow(workflow.id);
        const finished = await waitForRunEnd(harness.manager, summary.id);
        assert.equal(finished.error, 'workflow_app_action_output_invalid');
        assert.equal(finished.nodeRuns[0].output, undefined);
        assert.deepEqual(harness.releases, [summary.id]);
      } finally {
        await harness.cleanup();
      }
    });
  }
});

test('tool errors, call failures, timeout and cancellation remain app-action-specific and release the run session', async (t) => {
  const outputSchema = { type: 'object', properties: { ok: { type: 'boolean' } } };
  const cases = [
    ['tool error', async () => ({ isError: true, structuredContent: { ok: false } }), 'workflow_app_action_tool_error'],
    ['call error', async () => { throw new Error('workflow_app_action_call_failed'); }, 'workflow_app_action_call_failed'],
    ['timeout', async () => { throw new Error('workflow_app_action_timeout'); }, 'workflow_app_action_timeout'],
    ['canceled', async () => { throw new Error('workflow_app_action_canceled'); }, 'workflow_app_action_canceled'],
  ];
  for (const [label, callAppAction, code] of cases) {
    await t.test(label, async () => {
      const harness = await createHarness({
        prepareAppActions: async () => [definitionFor('app-a', 'find', outputSchema)],
        callAppAction,
      });
      try {
        const workflow = await harness.manager.upsert(workflowInput([appActionNode('a', 'app-a', 'find', {}, contractFor(
          'App A', 'Find record', outputSchema, { annotations: { readOnlyHint: true }, effect: 'read' },
        ))]));
        const summary = await harness.manager.runNow(workflow.id);
        const finished = await waitForRunEnd(harness.manager, summary.id);
        assert.equal(finished.error, code);
        assert.deepEqual(harness.releases, [summary.id]);
      } finally {
        await harness.cleanup();
      }
    });
  }
});

test('missing app-action dependencies fail closed and never fall back to an LLM', async () => {
  const harness = await createHarness();
  try {
    const workflow = await harness.manager.upsert(workflowInput([appActionNode('a', 'app-a', 'find', {})]));
    const summary = await harness.manager.runNow(workflow.id);
    const finished = await waitForRunEnd(harness.manager, summary.id);
    assert.equal(finished.error, 'workflow_app_actions_unavailable');
    assert.equal(harness.providerCalls.length, 0);
    assert.deepEqual(harness.releases, [summary.id]);
  } finally {
    await harness.cleanup();
  }
});
