import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { CallToolRequestSchema, ListToolsRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const { WorkflowAppActionRuntime } = require('../../dist-electron/main/app-action-runtime.js');
const { WorkflowManager } = require('../../dist-electron/main/workflow-manager.js');

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

const annotations = (overrides = {}) => ({
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
  ...overrides,
});

const declaredTool = (name, overrides) => ({
  name,
  title: overrides.title,
  description: overrides.description,
  inputSchema: overrides.inputSchema,
  outputSchema: overrides.outputSchema,
  annotations: annotations(overrides.annotations),
});

const startAppMcp = async ({ appId, tool, token, events, onCall }) => {
  let tools = [tool];
  const protocols = new Set();
  const server = http.createServer(async (request, response) => {
    if (request.url !== '/mcp') {
      response.statusCode = 404;
      response.end('not found');
      return;
    }
    if (request.headers.authorization !== `Bearer ${token}`) {
      response.statusCode = 401;
      response.end('unauthorized');
      return;
    }
    const protocol = new Server(
      { name: `${appId}-fixture`, version: '1.0.0' },
      { capabilities: { tools: {} } },
    );
    protocols.add(protocol);
    protocol.setRequestHandler(ListToolsRequestSchema, async () => {
      events.push({ appId, type: 'tools/list' });
      return { tools };
    });
    protocol.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
      events.push({ appId, type: 'tools/call', name: params.name, input: params.arguments ?? {} });
      return await onCall(params);
    });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await protocol.connect(transport);
    response.once('close', () => {
      protocols.delete(protocol);
      void protocol.close();
    });
    await transport.handleRequest(request, response);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return {
    config: {
      name: `app_${appId}`,
      url: `http://127.0.0.1:${address.port}/mcp`,
      token,
      tokenEnvVar: `APP_${appId.toUpperCase()}_TOKEN`,
      toolTimeoutSec: 2,
    },
    hideTool: () => {
      tools = [];
    },
    close: async () => {
      for (const protocol of protocols) {
        await protocol.close().catch(() => undefined);
      }
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
};

const createLeaseManager = (configs) => {
  const activeLeases = new Map();
  const released = [];
  return {
    activeLeases,
    released,
    listenRequiredMcps: async (appIds, listenerId) => {
      const uniqueAppIds = [...new Set(appIds)];
      const servers = uniqueAppIds.flatMap((appId) => {
        const config = configs.get(appId);
        return config ? [{ appId, config }] : [];
      });
      const failures = uniqueAppIds
        .filter((appId) => !configs.has(appId))
        .map((appId) => ({ appId, code: 'app_mcp_start_failed' }));
      if (failures.length === 0) activeLeases.set(listenerId, new Set(uniqueAppIds));
      return { servers, failures };
    },
    releaseMcps: (listenerId) => {
      if (activeLeases.delete(listenerId)) released.push(listenerId);
    },
  };
};

const actionNode = (id, appId, action, input) => ({
  id,
  name: action.title,
  type: 'app_action',
  appId,
  toolName: action.toolName,
  input,
  requiresApproval: false,
  action: {
    title: action.title,
    description: action.description,
    inputSchema: action.inputSchema,
    outputSchema: action.outputSchema,
    effect: action.effect,
    risk: action.risk,
    idempotent: action.idempotent,
    contractHash: action.contractHash,
  },
});

const createHarness = async ({ appA, appB }) => {
  const metadataRoot = await mkdtemp(join(tmpdir(), 'forger-app-action-vertical-'));
  const leaseManager = createLeaseManager(new Map([
    ['app-a', appA.config],
    ['app-b', appB.config],
  ]));
  const runtime = new WorkflowAppActionRuntime({ appMcpManager: leaseManager });
  let providerCalls = 0;
  const manager = new WorkflowManager({
    forgerHomeRoot: metadataRoot,
    metadataRoot,
    codexHome: join(metadataRoot, 'codex'),
    getAgentRuntime: async () => {
      providerCalls += 1;
      throw new Error('provider_must_not_run_for_app_action');
    },
    getInstalledApps: () => [],
    getCodexCliPath: async () => null,
    getClaudeCliPath: async () => null,
    getCodexPathEntries: async () => [],
    getCodexAuthenticated: async () => false,
    getClaudeAuthenticated: async () => false,
    getPersonalAgent: async () => null,
    ...runtime.workflowManagerOptions(),
    onWorkflowUpdated: () => undefined,
  });
  await manager.initialize();
  return {
    manager,
    runtime,
    leaseManager,
    providerCallCount: () => providerCalls,
    cleanup: async () => {
      await manager.dispose();
      await runtime.dispose();
      await rm(metadataRoot, { recursive: true, force: true });
    },
  };
};

const waitForTerminalRun = async (manager, runId) => await waitFor(async () => {
  const run = await manager.getRun(runId);
  return run && ['succeeded', 'failed', 'canceled', 'skipped'].includes(run.status) ? run : null;
});

const approveWaitingNode = async (manager, runId, nodeId) => {
  await waitFor(async () => {
    const run = await manager.getRun(runId);
    return run?.status === 'waiting_approval' && run.pendingApprovalNodeId === nodeId;
  });
  const result = await manager.approveNode({ runId, nodeId, approved: true });
  assert.equal(result.success, true);
};

const readTool = declaredTool('customers.read', {
  title: 'Read customer',
  description: 'Reads one customer from App A.',
  inputSchema: objectSchema({ customerId: { type: 'string' } }),
  outputSchema: objectSchema({
    customer: objectSchema({ id: { type: 'string' }, name: { type: 'string' } }),
  }),
  annotations: { readOnlyHint: true, idempotentHint: true },
});

const writeTool = declaredTool('deliveries.create', {
  title: 'Create delivery',
  description: 'Creates one local delivery in App B.',
  inputSchema: objectSchema({ customerId: { type: 'string' }, note: { type: 'string' } }),
  outputSchema: objectSchema({ deliveryId: { type: 'string' }, recipientId: { type: 'string' } }),
  annotations: { idempotentHint: true },
});

test('a real MCP App A output is mapped into App B through the persisted workflow without an LLM', async () => {
  const events = [];
  const appA = await startAppMcp({
    appId: 'a',
    tool: readTool,
    token: 'token-a',
    events,
    onCall: async () => ({
      content: [{ type: 'text', text: 'customer loaded' }],
      structuredContent: { customer: { id: 'customer-7', name: 'Ada' } },
    }),
  });
  const appB = await startAppMcp({
    appId: 'b',
    tool: writeTool,
    token: 'token-b',
    events,
    onCall: async ({ arguments: input }) => ({
      content: [{ type: 'text', text: 'delivery created' }],
      structuredContent: { deliveryId: 'delivery-9', recipientId: input.customerId },
    }),
  });
  const harness = await createHarness({ appA, appB });
  try {
    const [readAction] = await harness.runtime.listAppActions('app-a');
    const [writeAction] = await harness.runtime.listAppActions('app-b');
    assert.ok(readAction && writeAction, 'both real MCP contracts are discoverable');
    events.length = 0;

    const workflow = await harness.manager.upsert({
      name: 'App A to App B',
      trigger: { type: 'manual' },
      nodes: [
        actionNode('read', 'app-a', readAction, { customerId: 'customer-7' }),
        actionNode('write', 'app-b', writeAction, {
          customerId: '{{nodes.read.output.customer.id}}',
          note: 'Delivery for {{nodes.read.output.customer.name}}',
        }),
      ],
      edges: [{ from: 'read', to: 'write', condition: 'success' }],
    });

    const queued = await harness.manager.runNow(workflow.id);
    await approveWaitingNode(harness.manager, queued.id, 'read');
    await approveWaitingNode(harness.manager, queued.id, 'write');
    const finished = await waitForTerminalRun(harness.manager, queued.id);
    await waitFor(() => harness.leaseManager.activeLeases.size === 0);

    assert.equal(finished.status, 'succeeded');
    const firstCallIndex = events.findIndex((event) => event.type === 'tools/call');
    assert.ok(firstCallIndex > -1, 'the workflow invoked app tools');
    assert.deepEqual(
      new Set(events.slice(0, firstCallIndex)
        .filter((event) => event.type === 'tools/list')
        .map((event) => event.appId)),
      new Set(['a', 'b']),
      'preflight lists both apps before the first side effect',
    );
    assert.deepEqual(events.filter((event) => event.type === 'tools/call'), [
      { appId: 'a', type: 'tools/call', name: 'customers.read', input: { customerId: 'customer-7' } },
      {
        appId: 'b',
        type: 'tools/call',
        name: 'deliveries.create',
        input: { customerId: 'customer-7', note: 'Delivery for Ada' },
      },
    ]);
    assert.deepEqual(finished.nodeRuns.map(({ nodeId, output }) => ({ nodeId, output })), [
      { nodeId: 'read', output: { customer: { id: 'customer-7', name: 'Ada' } } },
      { nodeId: 'write', output: { deliveryId: 'delivery-9', recipientId: 'customer-7' } },
    ]);
    assert.equal(harness.providerCallCount(), 0);
    assert.ok(harness.leaseManager.released.includes(queued.id));
  } finally {
    await harness.cleanup();
    await Promise.all([appA.close(), appB.close()]);
  }
});

test('if App B no longer exposes its action, preflight prevents any call to App A', async () => {
  const events = [];
  const appA = await startAppMcp({
    appId: 'a',
    tool: readTool,
    token: 'token-a',
    events,
    onCall: async () => ({
      content: [{ type: 'text', text: 'must not run' }],
      structuredContent: { customer: { id: 'customer-7', name: 'Ada' } },
    }),
  });
  const appB = await startAppMcp({
    appId: 'b',
    tool: writeTool,
    token: 'token-b',
    events,
    onCall: async () => ({
      content: [{ type: 'text', text: 'must not run' }],
      structuredContent: { deliveryId: 'delivery-9', recipientId: 'customer-7' },
    }),
  });
  const harness = await createHarness({ appA, appB });
  try {
    const [readAction] = await harness.runtime.listAppActions('app-a');
    const [writeAction] = await harness.runtime.listAppActions('app-b');
    assert.ok(readAction && writeAction, 'workflow captures both contracts before App B changes');
    appB.hideTool();
    events.length = 0;

    const workflow = await harness.manager.upsert({
      name: 'Fail closed before App A',
      trigger: { type: 'manual' },
      nodes: [
        actionNode('read', 'app-a', readAction, { customerId: 'customer-7' }),
        actionNode('write', 'app-b', writeAction, {
          customerId: '{{nodes.read.output.customer.id}}',
          note: 'Delivery for {{nodes.read.output.customer.name}}',
        }),
      ],
      edges: [{ from: 'read', to: 'write', condition: 'success' }],
    });

    const queued = await harness.manager.runNow(workflow.id);
    const finished = await waitForTerminalRun(harness.manager, queued.id);
    await waitFor(() => harness.leaseManager.activeLeases.size === 0);

    assert.equal(finished.status, 'failed');
    assert.equal(finished.error, 'workflow_app_action_not_found');
    assert.deepEqual(
      new Set(events.filter((event) => event.type === 'tools/list').map((event) => event.appId)),
      new Set(['a', 'b']),
    );
    assert.deepEqual(events.filter((event) => event.type === 'tools/call'), []);
    assert.equal(harness.providerCallCount(), 0);
    assert.ok(harness.leaseManager.released.includes(queued.id));
  } finally {
    await harness.cleanup();
    await Promise.all([appA.close(), appB.close()]);
  }
});
