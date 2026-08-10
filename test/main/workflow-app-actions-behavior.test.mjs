import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { WorkflowManager } = require('../../dist-electron/main/workflow-manager.js');
const { sanitizeWorkflowNode } = require('../../dist-electron/main/workflow/sanitize.js');
const { workflowAppActionContractHash } = require('../../dist-electron/main/workflow/revisions.js');
const {
  createWorkflowValueReceipt,
  validateOutputAgainstSchema,
  validateWorkflowStructuredValueLimits,
} = require('../../dist-electron/main/workflow/output-schema.js');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const waitFor = async (predicate, timeoutMs = 5_000) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = await predicate();
    if (value) return value;
    await wait(20);
  }
  throw new Error('waitFor_timeout');
};

const objectSchema = (properties, required = Object.keys(properties)) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});

const appAction = (toolName, overrides = {}) => {
  const contract = {
    toolName,
    title: overrides.title ?? toolName,
    description: overrides.description ?? `${toolName} action`,
    inputSchema: overrides.inputSchema ?? objectSchema({}),
    outputSchema: overrides.outputSchema ?? objectSchema({ ok: { type: 'boolean' } }),
    effect: overrides.effect ?? 'read',
    risk: overrides.risk ?? 'low',
    idempotent: overrides.idempotent ?? true,
  };
  return {
    ...contract,
    contractHash: overrides.contractHash ?? workflowAppActionContractHash(toolName, contract),
  };
};

const appActionNode = (id, appId, action, overrides = {}) => ({
  id,
  name: overrides.name ?? action.title,
  type: 'app_action',
  appId,
  toolName: action.toolName,
  input: overrides.input ?? {},
  action: {
    title: action.title,
    ...(action.description ? { description: action.description } : {}),
    inputSchema: action.inputSchema,
    outputSchema: action.outputSchema,
    effect: action.effect,
    risk: action.risk,
    idempotent: action.idempotent,
    contractHash: action.contractHash,
  },
  ...(overrides.requiresApproval !== undefined
    ? { requiresApproval: overrides.requiresApproval }
    : {}),
});

const createManager = async ({ actionsByApp = {}, callAppAction, getAgentRuntime } = {}) => {
  const metadataRoot = await mkdtemp(join(tmpdir(), 'forger-workflow-app-actions-'));
  const listCalls = [];
  const actionCalls = [];
  let providerCalls = 0;
  const manager = new WorkflowManager({
    forgerHomeRoot: metadataRoot,
    metadataRoot,
    codexHome: join(metadataRoot, 'codex'),
    getAgentRuntime: getAgentRuntime ?? (async () => {
      providerCalls += 1;
      throw new Error('provider_must_not_run_for_app_action');
    }),
    getInstalledApps: () => [],
    getCodexCliPath: async () => null,
    getClaudeCliPath: async () => null,
    getCodexPathEntries: async () => [],
    getCodexAuthenticated: async () => false,
    getClaudeAuthenticated: async () => false,
    getPersonalAgent: async () => null,
    listAppActions: async (appId) => {
      listCalls.push(appId);
      return actionsByApp[appId] ?? [];
    },
    callAppAction: async (input) => {
      actionCalls.push(input);
      return await (callAppAction?.(input) ?? Promise.resolve({ ok: true }));
    },
    onWorkflowUpdated: () => undefined,
  });
  await manager.initialize();
  return {
    manager,
    metadataRoot,
    listCalls,
    actionCalls,
    providerCallCount: () => providerCalls,
    cleanup: async () => {
      await manager.dispose();
      await rm(metadataRoot, { recursive: true, force: true });
    },
  };
};

const waitForTerminalRun = async (manager, runId) => await waitFor(async () => {
  const run = await manager.getRun(runId);
  return run && ['succeeded', 'failed', 'canceled', 'skipped'].includes(run.status) ? run : null;
});

const approvePendingUntilTerminal = async (manager, runId) => {
  const approved = new Set();
  return await waitFor(async () => {
    const run = await manager.getRun(runId);
    if (run && ['succeeded', 'failed', 'canceled', 'skipped'].includes(run.status)) return run;
    if (run?.status === 'waiting_approval' && run.pendingApprovalNodeId && !approved.has(run.pendingApprovalNodeId)) {
      approved.add(run.pendingApprovalNodeId);
      await manager.approveNode({ runId, nodeId: run.pendingApprovalNodeId, approved: true });
    }
    return null;
  });
};

test('app_action sanitization preserves its immutable app contract snapshot', () => {
  const action = appAction('customers.lookup', {
    title: 'Find customer',
    description: 'Looks up one customer locally.',
    inputSchema: objectSchema({ customerId: { type: 'string' } }),
    outputSchema: objectSchema({ customer: { type: 'object' } }),
    effect: 'read',
    risk: 'low',
    idempotent: true,
  });
  const input = appActionNode('buscar', 'crm-local', action, {
    input: { customerId: '{{trigger.customerId}}' },
    requiresApproval: false,
  });

  assert.deepEqual(sanitizeWorkflowNode(input), input);
  assert.equal(sanitizeWorkflowNode({ ...input, appId: '../outside' }), null);
  assert.equal(sanitizeWorkflowNode({ ...input, toolName: '' }), null);
  assert.equal(sanitizeWorkflowNode({ ...input, action: { ...input.action, outputSchema: null } }), null);
  assert.equal(sanitizeWorkflowNode({ ...input, action: { ...input.action, effect: 'maybe' } }), null);
  assert.equal(sanitizeWorkflowNode({ ...input, action: { ...input.action, risk: 'critical' } }), null);
  assert.equal(sanitizeWorkflowNode({ ...input, action: { ...input.action, idempotent: 'yes' } }), null);
  assert.equal(sanitizeWorkflowNode({ ...input, action: { ...input.action, contractHash: '' } }), null);
  assert.throws(
    () => sanitizeWorkflowNode({ ...input, action: { ...input.action, title: 'Forged title' } }),
    /workflow_app_action_contract_hash_invalid/,
  );
});

test('forged or oversized app_action snapshots are rejected before a revision is persisted', async () => {
  const action = appAction('customers.lookup');
  const validNode = appActionNode('lookup', 'crm-local', action);
  const harness = await createManager({ actionsByApp: { 'crm-local': [action] } });
  try {
    await assert.rejects(
      harness.manager.upsert({
        name: 'Forged contract',
        trigger: { type: 'manual' },
        nodes: [{ ...validNode, action: { ...validNode.action, risk: 'high' } }],
        edges: [],
      }),
      /workflow_app_action_contract_hash_invalid/,
    );
    await assert.rejects(
      harness.manager.upsert({
        name: 'Oversized contract',
        trigger: { type: 'manual' },
        nodes: [{ ...validNode, input: { value: 'x'.repeat(1_100_000) } }],
        edges: [],
      }),
      /workflow_app_action_contract_limits_exceeded/,
    );
    assert.deepEqual(harness.manager.list(), []);
  } finally {
    await harness.cleanup();
  }
});

test('a run preflights every referenced app action before calling any app', async () => {
  const readCustomer = appAction('customers.lookup', {
    outputSchema: objectSchema({ customer: { type: 'object' } }),
  });
  const missingDelivery = appAction('delivery.create', {
    effect: 'external',
    risk: 'medium',
    idempotent: false,
  });
  const harness = await createManager({
    actionsByApp: {
      'crm-local': [readCustomer],
      'delivery-local': [],
    },
  });
  try {
    const workflow = await harness.manager.upsert({
      name: 'CRM to delivery',
      trigger: { type: 'manual' },
      nodes: [
        appActionNode('read', 'crm-local', readCustomer),
        appActionNode('deliver', 'delivery-local', missingDelivery),
      ],
      edges: [{ from: 'read', to: 'deliver', condition: 'success' }],
    });

    const queued = await harness.manager.runNow(workflow.id);
    const finished = await approvePendingUntilTerminal(harness.manager, queued.id);

    assert.equal(finished.status, 'failed');
    assert.equal(finished.error, 'workflow_app_action_not_found');
    assert.deepEqual(new Set(harness.listCalls), new Set(['crm-local', 'delivery-local']));
    assert.equal(harness.actionCalls.length, 0, 'App A must not run when App B fails preflight');
    assert.equal(harness.providerCallCount(), 0);
  } finally {
    await harness.cleanup();
  }
});

test('two app_action nodes map typed output A to input B without invoking an LLM provider', async () => {
  const readCustomer = appAction('customers.lookup', {
    inputSchema: objectSchema({ customerId: { type: 'string' } }),
    outputSchema: objectSchema({
      customer: objectSchema({ id: { type: 'string' }, name: { type: 'string' } }),
    }),
  });
  const createDelivery = appAction('delivery.create', {
    inputSchema: objectSchema({ customerId: { type: 'string' }, note: { type: 'string' } }),
    outputSchema: objectSchema({ delivered: { type: 'boolean' }, recipient: { type: 'string' } }),
    effect: 'write',
    risk: 'medium',
    idempotent: true,
  });
  const harness = await createManager({
    actionsByApp: {
      'crm-local': [readCustomer],
      'delivery-local': [createDelivery],
    },
    callAppAction: async (call) => call.toolName === 'customers.lookup'
      ? { customer: { id: 'customer-7', name: 'Ada' } }
      : { delivered: true, recipient: call.input.customerId },
  });
  try {
    const workflow = await harness.manager.upsert({
      name: 'Typed deterministic composition',
      trigger: { type: 'manual' },
      nodes: [
        appActionNode('read', 'crm-local', readCustomer, { input: { customerId: 'customer-7' } }),
        appActionNode('deliver', 'delivery-local', createDelivery, {
          input: {
            customerId: '{{nodes.read.output.customer.id}}',
            note: 'Delivery for {{nodes.read.output.customer.name}}',
          },
        }),
      ],
      edges: [{ from: 'read', to: 'deliver', condition: 'success' }],
    });

    const queued = await harness.manager.runNow(workflow.id);
    const finished = await approvePendingUntilTerminal(harness.manager, queued.id);

    assert.equal(finished.status, 'succeeded');
    assert.deepEqual(harness.actionCalls.map((call) => ({
      appId: call.appId,
      toolName: call.toolName,
      input: call.input,
      nodeId: call.nodeId,
    })), [
      {
        appId: 'crm-local',
        toolName: 'customers.lookup',
        input: { customerId: 'customer-7' },
        nodeId: 'read',
      },
      {
        appId: 'delivery-local',
        toolName: 'delivery.create',
        input: { customerId: 'customer-7', note: 'Delivery for Ada' },
        nodeId: 'deliver',
      },
    ]);
    for (const call of harness.actionCalls) {
      assert.equal(call.runId, queued.id);
      assert.equal(call.expectedContractHash, actionsByToolName(call.toolName, readCustomer, createDelivery).contractHash);
      assert.equal(call.timeoutMs, 300_000);
      assert.ok(call.signal instanceof AbortSignal);
      assert.equal(call.signal.aborted, false);
    }
    assert.deepEqual(
      finished.nodeRuns.find((nodeRun) => nodeRun.nodeId === 'deliver')?.output,
      { delivered: true, recipient: 'customer-7' },
    );
    assert.equal(harness.providerCallCount(), 0);
  } finally {
    await harness.cleanup();
  }
});

const actionsByToolName = (toolName, ...actions) =>
  actions.find((action) => action.toolName === toolName);

test('app action contracts enforce the bounded JSON Schema subset and safe receipts', () => {
  const schema = objectSchema({
    count: { type: 'integer', enum: [2, 4] },
    note: { type: 'string', minLength: 2, maxLength: 5 },
    values: { type: 'array', minItems: 1, maxItems: 2, items: { type: 'null' } },
  });
  assert.deepEqual(validateOutputAgainstSchema({ count: 2, note: 'okay', values: [null] }, schema), []);
  assert.ok(validateOutputAgainstSchema({ count: 3, note: 'x', values: [null, null, null], extra: true }, schema).length >= 4);
  assert.ok(validateOutputAgainstSchema(Object.create({ count: 2 }), objectSchema({ count: { type: 'integer' } })).length > 0);

  const smallLimits = { maxDepth: 2, maxKeys: 10, maxArrayItems: 10, maxBytes: 1_000 };
  assert.deepEqual(validateWorkflowStructuredValueLimits({ nested: { too: { deep: true } } }, smallLimits), ['workflow_value_depth_exceeded']);
  assert.deepEqual(validateWorkflowStructuredValueLimits({ a: 1, b: 2, c: 3 }, { ...smallLimits, maxKeys: 2 }), ['workflow_value_keys_exceeded']);
  assert.deepEqual(validateWorkflowStructuredValueLimits([1, 2, 3], { ...smallLimits, maxArrayItems: 2 }), ['workflow_value_array_items_exceeded']);
  assert.deepEqual(validateWorkflowStructuredValueLimits({ text: 'a string larger than twenty bytes' }, { ...smallLimits, maxBytes: 20 }), ['workflow_value_bytes_exceeded']);

  assert.deepEqual(createWorkflowValueReceipt({
    token: 'private-token',
    nested: { apiKey: 'private-key', safe: 'visible' },
  }), {
    token: '[REDACTED]',
    nested: { apiKey: '[REDACTED]', safe: 'visible' },
  });
});

test('app action history is redacted while downstream mappings keep the raw in-memory output', async () => {
  const issueToken = appAction('auth.issue', {
    outputSchema: objectSchema({ accessToken: { type: 'string' }, customerId: { type: 'string' } }),
  });
  const useToken = appAction('auth.use', {
    inputSchema: objectSchema({ authorization: { type: 'string' }, customerId: { type: 'string' } }),
  });
  const harness = await createManager({
    actionsByApp: { auth: [issueToken, useToken] },
    callAppAction: async (call) => call.toolName === 'auth.issue'
      ? { accessToken: 'top-secret', customerId: 'customer-9' }
      : { ok: call.input.authorization === 'top-secret' && call.input.customerId === 'customer-9' },
  });
  try {
    const workflow = await harness.manager.upsert({
      name: 'Private in-memory mapping',
      trigger: { type: 'manual' },
      nodes: [
        appActionNode('issue', 'auth', issueToken),
        appActionNode('use', 'auth', useToken, {
          input: {
            authorization: '{{nodes.issue.output.accessToken}}',
            customerId: '{{nodes.issue.output.customerId}}',
          },
        }),
      ],
      edges: [{ from: 'issue', to: 'use', condition: 'success' }],
    });
    const queued = await harness.manager.runNow(workflow.id);
    const finished = await approvePendingUntilTerminal(harness.manager, queued.id);

    assert.equal(finished.status, 'succeeded');
    assert.equal(harness.actionCalls[1].input.authorization, 'top-secret');
    assert.deepEqual(finished.nodeRuns.find((entry) => entry.nodeId === 'issue')?.output, {
      accessToken: '[REDACTED]',
      customerId: 'customer-9',
    });
    assert.deepEqual(finished.nodeRuns.find((entry) => entry.nodeId === 'use')?.input, {
      appId: 'auth',
      toolName: 'auth.use',
      input: { authorization: '[REDACTED]', customerId: 'customer-9' },
    });
  } finally {
    await harness.cleanup();
  }
});

test('oversized app action output fails before persistence and downstream effects', async () => {
  const oversized = appAction('data.export', {
    outputSchema: objectSchema({ payload: { type: 'string' } }),
  });
  const publish = appAction('data.publish', {
    inputSchema: objectSchema({ payload: { type: 'string' } }),
  });
  const harness = await createManager({
    actionsByApp: { data: [oversized, publish] },
    callAppAction: async (call) => call.toolName === 'data.export'
      ? { payload: 'x'.repeat(1024 * 1024) }
      : { ok: true },
  });
  try {
    const workflow = await harness.manager.upsert({
      name: 'Bounded output',
      trigger: { type: 'manual' },
      nodes: [
        appActionNode('export', 'data', oversized),
        appActionNode('publish', 'data', publish, { input: { payload: '{{nodes.export.output.payload}}' } }),
      ],
      edges: [{ from: 'export', to: 'publish', condition: 'success' }],
    });
    const queued = await harness.manager.runNow(workflow.id);
    const finished = await approvePendingUntilTerminal(harness.manager, queued.id);
    const exportRun = finished.nodeRuns.find((entry) => entry.nodeId === 'export');

    assert.equal(finished.status, 'failed');
    assert.equal(exportRun?.error, 'workflow_app_action_output_limits_exceeded');
    assert.equal(exportRun?.output, undefined);
    assert.deepEqual(harness.actionCalls.map((call) => call.toolName), ['data.export']);
  } finally {
    await harness.cleanup();
  }
});

test('an app action returning structured data outside its declared output schema fails before downstream calls', async () => {
  const countRows = appAction('rows.count', {
    outputSchema: objectSchema({ count: { type: 'number' } }),
  });
  const publishCount = appAction('report.publish', {
    inputSchema: objectSchema({ count: { type: 'number' } }),
    effect: 'write',
    risk: 'medium',
  });
  const harness = await createManager({
    actionsByApp: { data: [countRows], reports: [publishCount] },
    callAppAction: async (call) => call.toolName === 'rows.count'
      ? { count: 'three' }
      : { ok: true },
  });
  try {
    const workflow = await harness.manager.upsert({
      name: 'Schema guarded actions',
      trigger: { type: 'manual' },
      nodes: [
        appActionNode('count', 'data', countRows),
        appActionNode('publish', 'reports', publishCount, {
          input: { count: '{{nodes.count.output.count}}' },
        }),
      ],
      edges: [{ from: 'count', to: 'publish', condition: 'success' }],
    });

    const queued = await harness.manager.runNow(workflow.id);
    const finished = await approvePendingUntilTerminal(harness.manager, queued.id);
    const countRun = finished.nodeRuns.find((nodeRun) => nodeRun.nodeId === 'count');

    assert.equal(finished.status, 'failed');
    assert.equal(countRun?.status, 'failed');
    assert.match(countRun?.error ?? '', /workflow_app_action_output_(schema_)?invalid/);
    assert.deepEqual(harness.actionCalls.map((call) => call.toolName), ['rows.count']);
    assert.equal(harness.providerCallCount(), 0);
  } finally {
    await harness.cleanup();
  }
});

test('every app action requires approval even in runNode regardless of declared risk', async () => {
  const scenarios = [
    { suffix: 'low', effect: 'read', risk: 'low' },
    { suffix: 'high', effect: 'read', risk: 'high' },
    { suffix: 'destructive', effect: 'destructive', risk: 'low' },
    { suffix: 'unknown', effect: 'unknown', risk: 'low' },
  ];

  for (const scenario of scenarios) {
    const action = appAction(`records.${scenario.suffix}`, {
      effect: scenario.effect,
      risk: scenario.risk,
      idempotent: false,
    });
    const harness = await createManager({ actionsByApp: { records: [action] } });
    try {
      const workflow = await harness.manager.upsert({
        name: `Approval ${scenario.suffix}`,
        trigger: { type: 'manual' },
        nodes: [appActionNode('action', 'records', action, { requiresApproval: false })],
        edges: [],
      });

      const queued = await harness.manager.runNode(workflow.id, 'action');
      const waiting = await waitFor(async () => {
        const run = await harness.manager.getRun(queued.id);
        return run?.status === 'waiting_approval' ? run : null;
      });

      assert.equal(waiting.pendingApprovalNodeId, 'action');
      assert.equal(harness.actionCalls.length, 0, `${scenario.suffix} action waits before side effects`);
      assert.equal((await harness.manager.approveNode({
        runId: queued.id,
        nodeId: 'action',
        approved: true,
      })).success, true);

      const finished = await waitForTerminalRun(harness.manager, queued.id);
      assert.equal(finished.status, 'succeeded');
      assert.equal(harness.actionCalls.length, 1);
      assert.equal(harness.providerCallCount(), 0);
    } finally {
      await harness.cleanup();
    }
  }
});

test('every app_action requires approval and rejection prevents calls in a normal run', async () => {
  const action = appAction('customers.read', {
    effect: 'read',
    risk: 'low',
    idempotent: true,
  });
  const harness = await createManager({ actionsByApp: { customers: [action] } });
  try {
    const workflow = await harness.manager.upsert({
      name: 'Approval for every app action',
      trigger: { type: 'manual' },
      nodes: [appActionNode('read', 'customers', action, { requiresApproval: false })],
      edges: [],
    });

    const queued = await harness.manager.runNow(workflow.id);
    const waiting = await waitFor(async () => {
      const run = await harness.manager.getRun(queued.id);
      return run?.status === 'waiting_approval' ? run : null;
    });
    assert.equal(waiting.pendingApprovalNodeId, 'read');
    assert.equal(harness.actionCalls.length, 0);
    assert.equal((await harness.manager.approveNode({
      runId: queued.id,
      nodeId: 'read',
      approved: false,
    })).success, true);

    const finished = await waitForTerminalRun(harness.manager, queued.id);
    assert.equal(finished.status, 'failed');
    assert.equal(finished.nodeRuns[0].error, 'workflow_node_approval_denied');
    assert.equal(harness.actionCalls.length, 0);
  } finally {
    await harness.cleanup();
  }
});
