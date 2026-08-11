import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const {
  validateWorkflowStructuredValueLimits,
  validateOutputAgainstSchema,
  createWorkflowValueReceipt,
} = require('../../dist-electron/main/workflow/output-schema.js');
const { WorkflowNodeRuntime } = require('../../dist-electron/main/workflow/node-runtime.js');
const agentCommandRunner = require('../../dist-electron/main/automation/agent-command-runner.js');
const { WorkflowStore } = require('../../dist-electron/main/workflow/store.js');
const { findForEachJoinConflict, buildUpstreamFieldSources } = require('../../dist-electron/shared/workflow-templates.js');
const { WorkflowAppActionRuntime } = require('../../dist-electron/main/app-action-runtime.js');
const { AppMcpClient } = require('../../dist-electron/main/app-mcp-client.js');
const { executeWorkflowManagementTool } = require('../../dist-electron/main/forger-mcp/workflow-management-tools.js');
const { workflowMcpErrorMessage, parsePromptRuntimeOverride } = require('../../dist-electron/main/forger-mcp-server-helpers.js');
const { sanitizeWorkflowNode, sanitizeWorkflowUpsertInput } = require('../../dist-electron/main/workflow/sanitize.js');
const { workflowAppActionContractHash, workflowAppActionContractValue, assertAuthenticWorkflowAppAction } = require('../../dist-electron/main/workflow/revisions.js');

const schema = (properties = {}, extra = {}) => ({
  type: 'object', properties, additionalProperties: false, ...extra,
});

test('workflow output contracts cover bounded values, every schema type, and receipts', () => {
  const limits = { maxDepth: 2, maxKeys: 2, maxArrayItems: 2, maxBytes: 20 };
  assert.deepEqual(validateWorkflowStructuredValueLimits(null, limits), []);
  assert.deepEqual(validateWorkflowStructuredValueLimits(Infinity, limits), ['workflow_value_not_serializable']);
  assert.deepEqual(validateWorkflowStructuredValueLimits(undefined, limits), ['workflow_value_not_serializable']);
  assert.deepEqual(validateWorkflowStructuredValueLimits({ a: { b: { c: true } } }, { ...limits, maxKeys: 10 }), ['workflow_value_depth_exceeded']);
  assert.deepEqual(validateWorkflowStructuredValueLimits({ a: 1, b: 2, c: 3 }, limits), ['workflow_value_keys_exceeded']);
  assert.deepEqual(validateWorkflowStructuredValueLimits([1, 2, 3], limits), ['workflow_value_array_items_exceeded']);
  assert.deepEqual(validateWorkflowStructuredValueLimits({ text: '012345678901234567890' }, limits), ['workflow_value_bytes_exceeded']);
  assert.deepEqual(validateWorkflowStructuredValueLimits({ constructor: true }, limits), ['workflow_value_unsafe_key']);
  const cyclic = {}; cyclic.self = cyclic;
  assert.deepEqual(validateWorkflowStructuredValueLimits(cyclic), ['workflow_value_not_serializable']);
  const throwsOnSerialize = {};
  Object.defineProperty(throwsOnSerialize, 'toJSON', { enumerable: false, value: () => { throw new Error('serialize'); } });
  assert.deepEqual(validateWorkflowStructuredValueLimits(throwsOnSerialize), ['workflow_value_not_serializable']);
  const undefinedOnSerialize = {};
  Object.defineProperty(undefinedOnSerialize, 'toJSON', { enumerable: false, value: () => undefined });
  assert.deepEqual(validateWorkflowStructuredValueLimits(undefinedOnSerialize), ['workflow_value_not_serializable']);
  assert.deepEqual(validateWorkflowStructuredValueLimits(Object.create(null)), []);
  assert.deepEqual(validateWorkflowStructuredValueLimits(new Date()), ['workflow_value_not_serializable']);

  assert.deepEqual(validateOutputAgainstSchema({ id: 'xx', count: 2, ok: true }, schema({
    id: { type: 'string', minLength: 2, maxLength: 4 },
    count: { type: 'integer' },
    ok: { type: 'boolean' },
  }, { required: ['id', 'count', 'ok'] })), []);
  assert.ok(validateOutputAgainstSchema({}, schema({ id: { type: 'string' } }, { required: ['id'] })).length);
  assert.ok(validateOutputAgainstSchema({ extra: true }, schema(),).length);
  assert.ok(validateOutputAgainstSchema('x', schema()).length);
  assert.ok(validateOutputAgainstSchema({ values: [1] }, schema({ values: {
    type: 'array', minItems: 2, maxItems: 3, items: { type: 'number' },
  } })).length);
  assert.ok(validateOutputAgainstSchema({ value: null }, schema({ value: { type: 'null' } })).length === 0);
  assert.ok(validateOutputAgainstSchema({ value: 1.5 }, schema({ value: { type: 'integer' } })).length);
  assert.ok(validateOutputAgainstSchema({ value: Infinity }, schema({ value: { type: 'number' } })).length);
  assert.ok(validateOutputAgainstSchema({ value: 'x' }, schema({ value: { type: 'string', minLength: 2 } })).length);
  assert.ok(validateOutputAgainstSchema({ value: 'long' }, schema({ value: { type: 'string', maxLength: 2 } })).length);
  assert.ok(validateOutputAgainstSchema({ value: 'x' }, schema({ value: { type: 'string', enum: ['y'] } })).length);
  assert.ok(validateOutputAgainstSchema({ value: 1 }, schema({ value: { type: 'number', enum: [2] } })).length);
  assert.ok(validateOutputAgainstSchema({ value: true }, schema({ value: { type: 'boolean' } })).length === 0);
  const circularSchema = schema(); circularSchema.properties.self = circularSchema;
  assert.ok(validateOutputAgainstSchema({}, circularSchema).length);
  assert.deepEqual(validateOutputAgainstSchema({ value: 'x' }, schema({ value: { type: ['string'] } })), []);

  assert.deepEqual(createWorkflowValueReceipt({ accessToken: 'hidden', nested: { cookie: 'hidden' }, ok: true }), {
    accessToken: '[REDACTED]', nested: { cookie: '[REDACTED]' }, ok: true,
  });
  const receipt = createWorkflowValueReceipt({ long: 'x'.repeat(30_000), list: Array.from({ length: 120 }, (_, i) => i) });
  assert.match(receipt.long, /\[TRUNCATED\]$/);
  assert.equal(receipt.list.length, 101);
  const deepReceipt = createWorkflowValueReceipt({ deep: { a: { b: { c: { d: { e: { f: { g: { h: 1 } } } } } } } } });
  assert.ok(deepReceipt.deep);

  // Exercise the remaining bounded-container and receipt fallbacks.
  assert.deepEqual(validateWorkflowStructuredValueLimits([1], { ...limits, maxArrayItems: 1, maxBytes: 1 }), ['workflow_value_bytes_exceeded']);
  assert.deepEqual(validateWorkflowStructuredValueLimits({ key: 'value' }, { ...limits, maxKeys: 1, maxBytes: 1 }), ['workflow_value_bytes_exceeded']);
  assert.deepEqual(validateWorkflowStructuredValueLimits([Infinity]), ['workflow_value_not_serializable']);
  assert.deepEqual(validateWorkflowStructuredValueLimits({ key: 1 }, { ...limits, maxBytes: 3 }), ['workflow_value_bytes_exceeded']);
  assert.deepEqual(validateWorkflowStructuredValueLimits({ value: '\n'.repeat(20) }, { ...limits, maxBytes: 40 }), ['workflow_value_bytes_exceeded']);
  assert.deepEqual(validateWorkflowStructuredValueLimits({ key: undefined }, { ...limits, maxBytes: 100 }), []);
  const objectEnum = schema({ value: { type: 'object', enum: [{ a: 1, b: [2] }] } });
  assert.deepEqual(validateOutputAgainstSchema({ value: { b: [2], a: 1 } }, objectEnum), []);
  assert.ok(validateOutputAgainstSchema({ value: { a: 2 } }, objectEnum).length);
  assert.ok(validateOutputAgainstSchema({ value: 'not-an-object' }, objectEnum).length);
  assert.ok(validateOutputAgainstSchema({ value: [] }, schema({ value: { type: 'object', properties: {}, additionalProperties: false } })).length);
  assert.ok(validateOutputAgainstSchema({ value: { extra: true } }, schema({ value: { type: 'object', properties: {}, additionalProperties: false } })).length);
  assert.ok(validateOutputAgainstSchema({ value: [] }, schema({ value: { type: 'array', minItems: 1, items: { type: 'string' } } })).length);
  assert.ok(validateOutputAgainstSchema({ value: ['x', 'y'] }, schema({ value: { type: 'array', maxItems: 1 } })).length);
  assert.ok(validateOutputAgainstSchema({ value: [1] }, schema({ value: { type: 'array', items: { type: 'string' } } })).length);
  assert.ok(validateOutputAgainstSchema({ value: 'x' }, schema({ value: { type: 'boolean' } })).length);
  assert.deepEqual(validateOutputAgainstSchema({ value: 'x' }, schema({ value: { type: 'string', minLength: 1, maxLength: 2 } })), []);
  assert.deepEqual(validateWorkflowStructuredValueLimits({ key: 'value' }, { ...limits, maxKeys: 0 }), ['workflow_value_keys_exceeded']);
  assert.ok(validateOutputAgainstSchema({ value: 'x' }, schema({ value: { type: 'null' } })).length);
  assert.deepEqual(validateOutputAgainstSchema({ value: {} }, schema({ value: { type: 'object', properties: { optional: { type: 'string' } }, additionalProperties: false } })), []);
  assert.ok(validateOutputAgainstSchema({ value: { optional: 1 } }, schema({ value: { type: 'object', properties: { optional: { type: 'string' } }, additionalProperties: false } })).length);
  assert.ok(validateOutputAgainstSchema({ value: ['x'] }, schema({ value: { type: 'array', items: { type: 'string' }, minItems: 2 } })).length);
  assert.ok(validateOutputAgainstSchema({ value: ['x', 'y'] }, schema({ value: { type: 'array', items: { type: 'string' }, maxItems: 1 } })).length);
  const hugeReceipt = createWorkflowValueReceipt(Object.fromEntries(Array.from({ length: 240 }, (_, i) => [`k${i}`, 'x'.repeat(120)])));
  assert.equal(hugeReceipt._truncated, true);
  const unicodeReceipt = createWorkflowValueReceipt(Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`value${i}`, '\u0800'.repeat(2_000)])));
  assert.equal(unicodeReceipt._truncated, true);
  assert.equal(createWorkflowValueReceipt({ list: Array.from({ length: 101 }, (_, i) => i) }).list.at(-1), '[TRUNCATED]');
  assert.equal(createWorkflowValueReceipt({ deep: { a: { b: { c: { d: { e: { f: { g: { h: { i: 1 } } } } } } } } } }).deep.a.b.c.d.e.f.g.h, '[TRUNCATED]');
  assert.equal(createWorkflowValueReceipt({ value: Symbol('safe') }).value, 'Symbol(safe)');
  assert.equal(createWorkflowValueReceipt(Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`key${i}`, 'z'.repeat(1_000)])))._truncated, true);
});

test('workflow template conflict detection covers independent and nested forEach joins', () => {
  const nodes = [{ id: 'a', forEach: '{{nodes.items}}' }, { id: 'b', forEach: '{{nodes.other}}' }, { id: 'join' }];
  const edges = [{ from: 'a', to: 'join', condition: 'success' }, { from: 'b', to: 'join', condition: 'success' }];
  assert.deepEqual(findForEachJoinConflict(nodes, edges), { nodeId: 'join', parents: ['a', 'b'] });
  assert.equal(findForEachJoinConflict(nodes.slice(0, 2), edges), null);
  const appAction = {
    id: 'action', name: 'Action', type: 'app_action', appId: 'app', toolName: 'read', input: {},
    action: { title: 'Read', inputSchema: schema(), outputSchema: schema({ value: { type: 'string' } }), effect: 'read', risk: 'low', idempotent: true },
  };
  appAction.action.contractHash = workflowAppActionContractHash(appAction.toolName, appAction.action);
  const downstream = { id: 'downstream', name: 'Downstream', type: 'condition', expression: { left: 'x', operator: 'is_empty' } };
  const sources = buildUpstreamFieldSources(
    { id: 'workflow', nodes: [appAction, downstream], edges: [{ from: 'action', to: 'downstream', condition: 'success' }] },
    'downstream',
  );
  assert.equal(sources[0].fields[0].path, 'value');
  const noDescription = workflowAppActionContractValue('read', appAction.action);
  assert.equal('description' in noDescription, false);
  assert.doesNotThrow(() => assertAuthenticWorkflowAppAction('read', appAction.action));
  assert.throws(() => assertAuthenticWorkflowAppAction('read', { ...appAction.action, contractHash: 'bad' }), /contract_hash_invalid/);
  const sanitized = sanitizeWorkflowNode({ ...appAction, action: { ...appAction.action, description: '' } });
  assert.ok(sanitized);
  assert.deepEqual(sanitizeWorkflowNode({ ...appAction, input: [] }).input, {});
  assert.equal(sanitizeWorkflowNode({ ...appAction, action: [] }), null);
  assert.equal(sanitizeWorkflowNode({ id: 'agent', name: 'Agent', type: 'forger_agent', agentId: 'a', prompt: 'x', outputSchema: { type: 'object' } }).outputSchema.type, 'object');
  assert.equal(require('../../dist-electron/main/workflow/sanitize.js').sanitizeWorkflowFrequency({ type: 'weekly', timeOfDay: '25:99', weeklyDay: 9 }).weeklyDay, 6);
  assert.equal(sanitizeWorkflowUpsertInput({ expectedRevision: 'invalid' }).expectedRevision, 0);
  assert.deepEqual(sanitizeWorkflowUpsertInput(null), { name: '', trigger: { type: 'manual' }, nodes: [], edges: [] });
});

test('app action runtime closes discovery, failure, mismatch, and call branches', async () => {
  const released = [];
  const clients = new Map();
  const manager = {
    listenRequiredMcps: async (appIds, _runId) => ({
      servers: appIds.includes('missing') ? [] : appIds.map((appId) => ({ appId, config: { url: appId, token: 't' } })),
      failures: appIds.includes('offline') ? [{ appId: 'offline', code: 'offline' }] : [],
    }),
    releaseMcps: (runId) => released.push(runId),
  };
  const action = { toolName: 'read', title: 'Read', description: 'Read', inputSchema: {}, outputSchema: {}, effect: 'read', risk: 'low', idempotent: true, contractHash: 'hash' };
  const runtime = new WorkflowAppActionRuntime({
    appMcpManager: manager,
    createClient: (config) => {
      const client = {
        listActions: async () => clients.get(config.url)?.actions ?? [action],
        callAction: async (input) => ({ ok: true, toolName: input.toolName, input: input.input }),
        close: async () => { client.closed = true; },
      };
      clients.set(config.url, { actions: [action], client });
      return client;
    },
  });
  await runtime.preflightAppActions([], 'empty');
  await assert.rejects(runtime.preflightAppActions([{ appId: 'offline', toolName: 'read', action }], 'offline-run'), /offline/);
  await assert.rejects(runtime.preflightAppActions([{ appId: 'missing', toolName: 'read', action }], 'missing-run'), /discovery|unavailable/);
  await runtime.preflightAppActions([{ appId: 'app', toolName: 'read', action }], 'run-1');
  const mismatchRuntime = new WorkflowAppActionRuntime({
    appMcpManager: { listenRequiredMcps: async () => ({ servers: [{ appId: 'app', config: { url: 'app', token: 't' } }], failures: [] }), releaseMcps: () => undefined },
    createClient: () => ({ listActions: async () => [{ ...action, contractHash: 'changed' }], callAction: async () => ({}), close: async () => undefined }),
  });
  await assert.rejects(mismatchRuntime.preflightAppActions([{ appId: 'app', toolName: 'read', action }], 'mismatch'), /contract_changed/);
  const discoveryMismatch = new WorkflowAppActionRuntime({
    appMcpManager: { listenRequiredMcps: async () => ({ servers: [{ appId: 'other', config: { url: 'other', token: 't' } }], failures: [] }), releaseMcps: () => undefined },
    createClient: () => ({ listActions: async () => [action], callAction: async () => ({}), close: async () => undefined }),
  });
  await assert.rejects(discoveryMismatch.preflightAppActions([{ appId: 'app', toolName: 'read', action }], 'discovery-mismatch'), /discovery_failed/);
  assert.deepEqual(await runtime.listAppActions('app'), [action]);
  await assert.rejects(runtime.listAppActions('offline'), /offline/);
  await assert.rejects(runtime.listAppActions('missing'), /discovery_failed/);
  assert.deepEqual(await runtime.callAppAction({ runId: 'run-1', appId: 'app', toolName: 'read', expectedContractHash: 'hash', input: { id: 1 } }), { ok: true, toolName: 'read', input: { id: 1 } });
  await assert.rejects(runtime.callAppAction({ runId: 'unknown', appId: 'app', toolName: 'read', expectedContractHash: 'hash', input: {} }), /not_preflighted/);
  await assert.rejects(runtime.callAppAction({ runId: 'run-1', appId: 'other', toolName: 'read', expectedContractHash: 'hash', input: {} }), /not_preflighted/);
  clients.get('app').actions = [];
  await assert.rejects(runtime.callAppAction({ runId: 'run-1', appId: 'app', toolName: 'read', expectedContractHash: 'hash', input: {} }), /not_found/);
  clients.get('app').actions = [{ ...action, contractHash: 'changed' }];
  await assert.rejects(runtime.callAppAction({ runId: 'run-1', appId: 'app', toolName: 'read', expectedContractHash: 'hash', input: {} }), /contract_changed/);
  await runtime.releaseAppActions('run-1');
  await runtime.releaseAppActions('run-1');
  const bridge = runtime.workflowManagerOptions();
  assert.equal(typeof bridge.listAppActions, 'function');
  assert.equal(typeof bridge.callAppAction, 'function');
  await bridge.listAppActions('app');
  await bridge.preflightAppActions([{ appId: 'app', toolName: 'read', action }], 'bridge');
  await bridge.callAppAction({ runId: 'bridge', appId: 'app', toolName: 'read', expectedContractHash: 'hash', input: {} }).catch(() => undefined);
  await bridge.releaseAppActions('bridge');
  await runtime.dispose();
  assert.ok(released.includes('run-1'));
});

test('app action runtime rejects a live action that disappears during preflight', async () => {
  const action = { toolName: 'read', title: 'Read', description: 'Read', inputSchema: {}, outputSchema: {}, effect: 'read', risk: 'low', idempotent: true, contractHash: 'hash' };
  const runtime = new WorkflowAppActionRuntime({
    appMcpManager: {
      listenRequiredMcps: async () => ({ servers: [{ appId: 'app', config: { url: 'app', token: 't' } }], failures: [] }),
      releaseMcps: () => undefined,
    },
    createClient: () => ({ listActions: async () => [], callAction: async () => ({}), close: async () => undefined }),
  });
  await assert.rejects(runtime.preflightAppActions([{ appId: 'app', toolName: action.toolName, action }], 'not-found'), /not_found/);
  await runtime.dispose();
});

test('app action runtime derives the real MCP client when no factory is supplied', async () => {
  const runtime = new WorkflowAppActionRuntime({
    appMcpManager: {
      listenRequiredMcps: async () => ({
        servers: [{ appId: 'app', config: { url: 'http://127.0.0.1:1/mcp', token: 'token' } }],
        failures: [],
      }),
      releaseMcps: () => undefined,
    },
  });
  await assert.rejects(runtime.listAppActions('app'), /ECONNREFUSED|fetch|timeout|connect/i);
  await runtime.dispose();
});

test('workflow node runtime app actions return stable failure and cancellation states', async () => {
  const makeRuntime = (overrides = {}) => new WorkflowNodeRuntime({
    forgerHomeRoot: os.tmpdir(), metadataRoot: os.tmpdir(), codexHome: os.tmpdir(),
    getAgentRuntime: async () => ({ provider: 'codex', model: 'm', effort: 'low' }),
    getInstalledApps: () => [], getCodexCliPath: async () => null, getClaudeCliPath: async () => null,
    getCodexPathEntries: async () => [], getCodexAuthenticated: async () => false, getClaudeAuthenticated: async () => false,
    ...overrides,
  });
  const node = { id: 'action', name: 'Action', type: 'app_action', appId: 'app', toolName: 'read', input: {}, requiresApproval: false,
    action: { title: 'Read', description: 'Read', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, outputSchema: { type: 'object', properties: {}, additionalProperties: false }, effect: 'read', risk: 'low', idempotent: true, contractHash: 'hash' } };
  const active = { workflowId: 'wf', canceled: false, children: new Set(), actionAbortControllers: new Set(), approvalResolvers: new Map() };
  const runtime = makeRuntime();
  assert.equal((await runtime.executeAppActionNode({ id: 'run' }, node, { trigger: {}, nodes: {} }, active)).error, 'workflow_app_actions_unavailable');
  const invalid = makeRuntime({ callAppAction: async () => ({}) });
  const invalidNode = { ...node, input: { unsafe: true } };
  assert.equal((await invalid.executeAppActionNode({ id: 'run' }, invalidNode, { trigger: {}, nodes: {} }, active)).error, 'workflow_app_action_input_schema_invalid');
  const throwing = makeRuntime({ callAppAction: async () => { throw 'failed'; } });
  assert.equal((await throwing.executeAppActionNode({ id: 'run' }, node, { trigger: {}, nodes: {} }, active)).error, 'workflow_app_action_call_failed');
  const canceled = makeRuntime({ callAppAction: async () => { active.canceled = true; throw new Error('aborted'); } });
  assert.equal((await canceled.executeAppActionNode({ id: 'run' }, node, { trigger: {}, nodes: {} }, active)).status, 'canceled');
});

test('workflow store rejects revision path escapes and preserves safe indexes', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forger-final-store-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new WorkflowStore({ metadataRoot: root });
  await store.initialize();
  await assert.rejects(store.saveRevisions('../escape', []), /workflow_revision_path_outside_storage/);
  assert.throws(() => store.runTranscriptPath('../escape'), /workflow_run_path_outside_storage/);
  await store.saveRevisions('safe', []);
  await fs.writeFile(path.join(root, 'workflow-revisions', 'safe.json'), '{broken', 'utf8');
  assert.deepEqual(await store.readRevisions('safe'), []);
  await fs.mkdir(path.join(root, 'workflows.json'));
  await assert.rejects(store.saveWorkflows([]));
});

test('AppMcpClient rejects unsafe URLs and required token values before connecting', () => {
  assert.throws(() => new AppMcpClient({ url: 'not a url', token: 't' }), /url_invalid/);
  assert.throws(() => new AppMcpClient({ url: 'https://example.com/mcp', token: 't' }), /loopback/);
  assert.throws(() => new AppMcpClient({ url: 'http://127.0.0.1:1/mcp', token: ' ' }), /token_required/);
  assert.throws(() => new AppMcpClient({ url: 'http://127.0.0.1:1/mcp?x=1', token: 't' }), /loopback/);
});

test('AppMcpClient closes a pending connection and rejects discovery/call limits', async () => {
  const client = new AppMcpClient({ url: 'http://127.0.0.1:1/mcp', token: 't', timeoutMs: 20 });
  const pending = client.listActions().catch((error) => error);
  await client.close();
  const error = await pending;
  assert.ok(error instanceof Error);
  await assert.rejects(client.listActions(), /client_closed/);
  await assert.rejects(client.callAction({ toolName: 'x', input: { constructor: true } }), /action_input_invalid/);
});

test('workflow management tools and helper mappings cover unavailable, validation, and error paths', async () => {
  const session = { caller: 'desktop', locale: 'es', appId: 'app' };
  assert.equal(workflowMcpErrorMessage('workflow_expected_revision_required').length > 0, true);
  assert.equal(workflowMcpErrorMessage('workflow_applied_revision_required').length > 0, true);
  assert.equal(workflowMcpErrorMessage('workflow_review_required').length > 0, true);
  assert.equal(workflowMcpErrorMessage('unknown').length > 0, true);
  assert.deepEqual(await executeWorkflowManagementTool(session, 'forger_workflow_upsert', {}, {}), {
    success: false, technicalCode: 'workflow_manager_unavailable',
  });
  assert.deepEqual(await executeWorkflowManagementTool(session, 'forger_workflow_review', { workflowId: 'wf' }, {}), {
    success: false, technicalCode: 'workflow_manager_unavailable',
  });
  assert.deepEqual(await executeWorkflowManagementTool(session, 'forger_workflow_apply', { workflowId: 'wf' }, {}), {
    success: false, technicalCode: 'workflow_manager_unavailable',
  });
  assert.deepEqual(await executeWorkflowManagementTool(session, 'forger_workflow_apply', { workflowId: 'wf', definitionHash: '', expectedRevision: 0 }, {
    workflowsApply: async () => ({ id: 'wf' }),
  }), { success: false, technicalCode: 'workflow_apply_input_invalid' });
  assert.deepEqual(await executeWorkflowManagementTool(session, 'forger_workflow_apply', { workflowId: 'wf', definitionHash: 'hash', expectedRevision: 2 }, {
    workflowsApply: async (id, input) => ({ id, input }),
  }), { success: true, workflow: { id: 'wf', input: { definitionHash: 'hash', expectedRevision: 2 } } });
  assert.deepEqual(await executeWorkflowManagementTool(session, 'forger_workflow_run', { workflowId: 'wf' }, {
    workflowsRun: async () => { throw 'plain_failure'; },
  }), { success: false, userMessage: 'No pudimos completar la operacion sobre el flujo.', technicalCode: 'workflow_operation_failed' });
  assert.deepEqual(await executeWorkflowManagementTool(session, 'forger_workflow_run', { workflowId: 'wf' }, {}), {
    success: false, technicalCode: 'workflow_manager_unavailable',
  });
  assert.deepEqual(parsePromptRuntimeOverride({ runtime: { provider: 'codex', model: 'gpt', effort: 'medium' }, provider: 'claude', model: 'gpt-5', effort: 'low', reasoningEffort: 'high' }), {
    runtime: { provider: 'codex', model: 'gpt', effort: 'medium' }, provider: 'claude', model: 'gpt-5', effort: 'low', reasoningEffort: 'high',
  });
  assert.deepEqual(parsePromptRuntimeOverride({ runtime: 'bad', provider: 'bad', model: '', effort: '', reasoningEffort: 'bad' }), {});
  assert.deepEqual(parsePromptRuntimeOverride({ runtime: { provider: 'bad', model: ' ', effort: 'bad' }, provider: 'bad', effort: 'bad', reasoningEffort: 'bad' }), {});
  assert.deepEqual(parsePromptRuntimeOverride({ runtime: { provider: 'codex', model: '', effort: 'low' } }), {});
  assert.deepEqual(parsePromptRuntimeOverride({ runtime: { provider: 'claude', model: 'sonnet', effort: 'xhigh' } }), {
    runtime: { provider: 'claude', model: 'sonnet', effort: 'xhigh' },
  });
});

test('workflow sanitizers, revisions, templates, and store cover alternate shapes', async (t) => {
  assert.equal(sanitizeWorkflowNode({ id: 'llm', name: 'LLM', type: 'llm_agent', prompt: '' }), null);
  assert.equal(sanitizeWorkflowNode({ id: 'agent', name: 'Agent', type: 'forger_agent', agentId: '', prompt: 'x' }), null);
  assert.equal(sanitizeWorkflowNode({ id: 'agent', name: 'Agent', type: 'forger_agent', agentId: 'a', prompt: 'x', outputSchema: [] }).type, 'forger_agent');
  assert.equal(sanitizeWorkflowNode({ id: 'cond', name: 'Condition', type: 'condition', expression: { operator: 'is_empty', right: 'ignored' } }).type, 'condition');
  assert.equal(sanitizeWorkflowNode({ id: 'tool', name: 'Tool', type: 'forger_tool', toolId: 'missing' }, new Set(['known'])), null);
  assert.equal(sanitizeWorkflowNode({ id: 'conn', name: 'Connector', type: 'connector', toolId: 'not-a-connection', actionId: 'missing' }, new Set(['known'])), null);
  assert.deepEqual(sanitizeWorkflowUpsertInput({ nodes: [{ id: 'bad id', name: 'bad', type: 'condition' }] }), {
    name: '', trigger: { type: 'manual' }, nodes: [], edges: [],
  });
  assert.throws(() => sanitizeWorkflowUpsertInput({ nodes: [{ id: 'bad id', name: 'bad', type: 'condition' }] }, undefined, { rejectInvalidNodes: true }), /workflow_node_invalid/);

  const workflow = {
    id: 'wf', name: 'Workflow', description: '', revision: 1, updatedAt: '2026-01-01T00:00:00Z',
    trigger: { type: 'manual' }, nodes: [], edges: [], enabled: false, running: false,
  };
  const { createWorkflowRevision, workflowDefinitionHash } = require('../../dist-electron/main/workflow/revisions.js');
  assert.equal(workflowDefinitionHash(workflow).length, 64);
  const revision = createWorkflowRevision(workflow, { id: 'rev', applied: true, appliedAt: 'now' });
  assert.equal(revision.appliedAt, 'now');
  assert.equal(createWorkflowRevision(workflow).id.length > 0, true);
  assert.equal(workflowDefinitionHash({ ...workflow, description: 'with description' }).length, 64);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forger-final-store-alt-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new WorkflowStore({ metadataRoot: root });
  await store.initialize();
  await fs.writeFile(path.join(root, 'workflow-revisions', 'shape.json'), '{}', 'utf8');
  assert.deepEqual(await store.readRevisions('shape'), []);
  await fs.writeFile(path.join(root, 'workflow-runs', 'run.index.json'), JSON.stringify(['ok', 1, null]), 'utf8');
  assert.deepEqual(await store.readRunIds('run'), ['ok']);
  assert.throws(() => store.revisionFilePath('../escape'), /workflow_revision_path_outside_storage/);
});

test('workflow node runtime exercises dispatch, discovery, schemas, and iteration boundaries', async () => {
  const calls = [];
  const action = {
    title: 'Read', description: 'Read', inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    outputSchema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false },
    effect: 'read', risk: 'low', idempotent: true, contractHash: '',
  };
  action.contractHash = workflowAppActionContractHash('read', action);
  const makeRuntime = (overrides = {}) => new WorkflowNodeRuntime({
    forgerHomeRoot: os.tmpdir(), metadataRoot: os.tmpdir(), codexHome: os.tmpdir(),
    getAgentRuntime: async () => ({ provider: 'codex', model: 'm', effort: 'low' }),
    getInstalledApps: () => [], getCodexCliPath: async () => null, getClaudeCliPath: async () => null,
    getCodexPathEntries: async () => [], getCodexAuthenticated: async () => false, getClaudeAuthenticated: async () => false,
    ...overrides,
  });
  const node = { id: 'action', name: 'Action', type: 'app_action', appId: 'app', toolName: 'read', input: {}, requiresApproval: false, action };
  const context = { trigger: {}, nodes: {} };
  const run = { id: 'run' };
  const active = { workflowId: 'wf', canceled: false, children: new Set(), actionAbortControllers: new Set(), approvalResolvers: new Map() };
  const runtime = makeRuntime({
    callAppAction: async (input) => { calls.push(input); return { ok: true }; },
    listAppActions: async () => [{ ...action, toolName: 'read' }],
  });
  await runtime.preflightAppActionNodes([], 'empty');
  await runtime.preflightAppActionNodes([node], 'run');
  const unavailablePreflight = makeRuntime();
  await assert.rejects(unavailablePreflight.preflightAppActionNodes([node], 'unavailable'), /workflow_app_actions_unavailable/);
  const missingDiscovery = makeRuntime({ callAppAction: async () => ({ ok: true }) });
  await assert.rejects(missingDiscovery.preflightAppActionNodes([node], 'missing-discovery'), /workflow_app_actions_unavailable/);
  const failedDiscovery = makeRuntime({ callAppAction: async () => ({ ok: true }), listAppActions: async () => { throw new Error('offline'); } });
  await assert.rejects(failedDiscovery.preflightAppActionNodes([node], 'offline'), /workflow_app_action_discovery_failed/);
  await runtime.resolveLiveAppActionNodes([node]);
  await runtime.resolveLiveAppActionNodes([
    { id: 'condition', name: 'Condition', type: 'condition', expression: { left: 'x', operator: 'is_empty' } },
    node,
  ]);
  const approvalStates = {};
  await runtime.executeNode(
    {},
    run,
    { id: 'approval-canceled', name: 'Approval', type: 'condition', requiresApproval: true, expression: { left: 1, operator: 'equals', right: 1 } },
    approvalStates,
    {},
    { ...active, canceled: true },
    path.join(os.tmpdir(), 'approval.log'),
    async () => undefined,
  );
  assert.equal(approvalStates['approval-canceled'].status, 'canceled');
  runtime.assertLiveAppActionNodesMatch([node], [node]);
  assert.throws(
    () => runtime.assertLiveAppActionNodesMatch([node], [{ ...node, action: { ...action, contractHash: 'different' } }]),
    /workflow_app_action_contract_changed/,
  );
  assert.throws(
    () => runtime.assertAuthenticAppActionNodes([{ ...node, input: { huge: 'x'.repeat(1_100_000) } }]),
    /workflow_app_action_contract_limits_exceeded/,
  );
  const hugeAction = { ...action, description: 'x'.repeat(1_100_000) };
  hugeAction.contractHash = workflowAppActionContractHash('read', hugeAction);
  assert.throws(
    () => runtime.assertAuthenticAppActionNodes([{ ...node, action: hugeAction }]),
    /workflow_app_action_contract_limits_exceeded/,
  );
  const liveHugeAction = { ...hugeAction };
  const hugeRuntime = makeRuntime({ listAppActions: async () => [{ ...liveHugeAction, toolName: 'read' }] });
  await assert.rejects(hugeRuntime.resolveLiveAppActionNodes([node]), /workflow_app_action_contract_limits_exceeded/);
  runtime.assertLiveAppActionNodesMatch([{ id: 'other', type: 'condition', name: 'c', expression: { left: 'x', operator: 'is_empty' } }], []);
  assert.deepEqual(runtime.persistedNodeRunValue({ ...node, type: 'condition' }, undefined), undefined);
  assert.deepEqual(runtime.persistedNodeRunValue({ ...node, type: 'condition' }, { ok: true }), { ok: true });
  assert.deepEqual(runtime.completeNodeFromMcp('missing', {}), { success: false, technicalCode: 'workflow_node_context_not_found' });
  assert.equal((await runtime.executeNodeOnce({}, run, { id: 'condition', name: 'Condition', type: 'condition', expression: { left: 'x', operator: 'is_empty' } }, context, active, path.join(os.tmpdir(), 'node.log'))).status, 'succeeded');
  assert.equal((await runtime.executeNodeOnce({}, run, { id: 'tool', name: 'Tool', type: 'forger_tool', toolId: 'tool', input: {} }, context, active, path.join(os.tmpdir(), 'node.log'))).status, 'failed');
  assert.equal((await runtime.executeNodeOnce({}, run, { id: 'connection', name: 'Connection', type: 'connection', connectionType: 'gmail', actionId: 'read', input: {} }, context, active, path.join(os.tmpdir(), 'node.log'))).status, 'failed');
  assert.equal((await runtime.executeNodeOnce({}, run, { id: 'action', name: 'Action', type: 'app_action', appId: 'app', toolName: 'read', input: {}, action }, context, active, path.join(os.tmpdir(), 'node.log'))).status, 'succeeded');
  const scalar = makeRuntime({ callAppAction: async () => 'scalar' });
  assert.equal((await scalar.executeAppActionNode(run, node, context, active)).error, 'workflow_app_action_output_schema_invalid');
  const cancelDuringAction = { ...active, canceled: false };
  const canceledFailure = makeRuntime({ callConnectionAction: async () => { cancelDuringAction.canceled = true; throw new Error('canceled-action'); } });
  const canceledStates = {};
  const cancelConnectionNode = { id: 'cancel-connection', name: 'Cancel', type: 'connection', connectionType: 'gmail', actionId: 'read', input: {} };
  await canceledFailure.executeNode({}, run, cancelConnectionNode, canceledStates, {}, cancelDuringAction, path.join(os.tmpdir(), 'canceled-action.log'), async () => undefined);
  assert.equal(canceledStates['cancel-connection'].status, 'canceled');
  const missingInputActive = { ...active, canceled: false };
  const missingInputRuntime = makeRuntime();
  missingInputRuntime.executeNodeOnce = async () => {
    missingInputActive.canceled = true;
    return { status: 'failed' };
  };
  const missingInputStates = {};
  await missingInputRuntime.executeNode(
    {},
    run,
    { id: 'missing-input', name: 'Missing input', type: 'condition', expression: { left: 1, operator: 'equals', right: 2 } },
    missingInputStates,
    {},
    missingInputActive,
    path.join(os.tmpdir(), 'missing-input.log'),
    async () => undefined,
  );
  assert.equal(missingInputStates['missing-input'].status, 'canceled');
  const structuredInvalid = makeRuntime({ callAppAction: async () => { throw new Error('app_mcp_structured_content_invalid'); } });
  assert.equal((await structuredInvalid.executeAppActionNode(run, node, context, active)).error, 'workflow_app_action_output_limits_exceeded');
  const workflowFailure = makeRuntime({ callAppAction: async () => { throw new Error('workflow_app_action_timeout'); } });
  assert.equal((await workflowFailure.executeAppActionNode(run, node, context, active)).error, 'workflow_app_action_timeout');
  const originalAppendTranscript = agentCommandRunner.appendTranscript;
  const canceledAfterTranscript = { ...active, canceled: false };
  agentCommandRunner.appendTranscript = async () => { canceledAfterTranscript.canceled = true; };
  try {
    const states = {};
    await runtime.executeNode({}, run, { id: 'cancel-after-transcript', name: 'Cancel', type: 'condition', expression: { left: 1, operator: 'equals', right: 1 } }, states, {}, canceledAfterTranscript, path.join(os.tmpdir(), 'cancel.log'), async () => undefined);
    assert.equal(states['cancel-after-transcript'].status, 'canceled');
  } finally {
    agentCommandRunner.appendTranscript = originalAppendTranscript;
  }
  assert.equal(calls.length, 1);
  assert.deepEqual(await runtime.preflightAppActionNodes([node], 'run-2'), undefined);
  const missingAction = { ...action, contractHash: workflowAppActionContractHash('missing', action) };
  await assert.rejects(runtime.resolveLiveAppActionNodes([{ ...node, toolName: 'missing', action: missingAction }]), /workflow_app_action_not_found/);
  const changedAction = { ...action, description: 'Changed' };
  changedAction.contractHash = workflowAppActionContractHash('read', changedAction);
  await assert.rejects(
    runtime.preflightAppActionNodes([{ ...node, action: changedAction }], 'preflight-stale'),
    /workflow_app_action_contract_changed/,
  );
  await assert.rejects(
    runtime.resolveLiveAppActionNodes([{ ...node, action: changedAction }]),
    /workflow_app_action_contract_changed/,
  );
  const fallback = makeRuntime({ callAppAction: async () => ({ ok: true }), listAppActions: async () => [{ ...action, toolName: 'read' }] });
  await fallback.preflightAppActionNodes([node], 'fallback');
  const forEach = { id: 'each', name: 'Each', type: 'condition', forEach: '{{items}}', expression: { left: 'item', operator: 'is_not_empty' } };
  const canceled = { ...active, canceled: true };
  assert.equal((await runtime.executeNodeForEach({}, run, forEach, { ...context, items: [1, 2] }, canceled, path.join(os.tmpdir(), 'node.log'))).status, 'canceled');
  const background = makeRuntime({
    persistAgentRunActivity: async () => { throw new Error('activity-write-failed'); },
  });
  await background.runAgentNode(
    { id: 'workflow', name: 'Workflow' },
    run,
    { id: 'agent', name: 'Agent', type: 'llm_agent', prompt: 'Run' },
    context,
    active,
    path.join(os.tmpdir(), 'agent.log'),
    { prompt: 'Run', appIds: [], toolIds: [], connectionGrants: [] },
  );
  await background.activityPersistenceTail;
  assert.equal(background.backgroundFailures.at(-1).message, 'activity-write-failed');
  const released = [];
  const sessionRuntime = makeRuntime({
    getCodexAuthenticated: async () => true,
    getCodexCliPath: async () => '/bin/false',
    createForgerMcpSession: () => ({ url: 'http://127.0.0.1:1/mcp', token: 'token' }),
    releaseForgerMcpSession: (token) => released.push(`forger:${token}`),
    listenAppMcps: async () => [],
    releaseAppMcps: (listenerId) => released.push(`apps:${listenerId}`),
  });
  await sessionRuntime.runAgentNode(
    { id: 'workflow', name: 'Workflow' },
    run,
    { id: 'agent-with-sessions', name: 'Agent', type: 'llm_agent', prompt: 'Run' },
    context,
    active,
    path.join(os.tmpdir(), 'agent-sessions.log'),
    { prompt: 'Run', appIds: ['app'], toolIds: [], connectionGrants: [] },
  );
  assert.deepEqual(released, ['forger:token', 'apps:run:agent-with-sessions']);
});
