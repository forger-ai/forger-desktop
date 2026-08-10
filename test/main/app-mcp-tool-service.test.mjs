import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let AppMcpToolService;
let serviceLoadError;
try {
  ({ AppMcpToolService } = require('../../dist-electron/main/app-mcp-tool-service.js'));
} catch (error) {
  serviceLoadError = error;
}
const { sanitizeWorkflowNode } = require('../../dist-electron/main/workflow/sanitize.js');

const requireService = () => {
  if (serviceLoadError) throw serviceLoadError;
  assert.equal(typeof AppMcpToolService, 'function', 'AppMcpToolService must be exported');
  return AppMcpToolService;
};

const objectSchema = (properties = {}, required = []) => ({
  type: 'object',
  properties,
  ...(required.length ? { required } : {}),
  additionalProperties: false,
});

const tool = (name, overrides = {}) => ({
  name,
  title: name === 'find' ? 'Find record' : 'Save record',
  description: `${name} deterministically`,
  inputSchema: objectSchema(),
  outputSchema: objectSchema({ ok: { type: 'boolean' } }, ['ok']),
  annotations: { readOnlyHint: name === 'find' },
  execution: { taskSupport: 'forbidden' },
  ...overrides,
});

const configFor = (appId, overrides = {}) => ({
  name: `app_${appId}`,
  url: `http://127.0.0.1:431${appId === 'app-a' ? '1' : '2'}/mcp`,
  token: `mcp-secret-${appId}`,
  tokenEnvVar: `FORGER_APP_MCP_TOKEN_${appId.toUpperCase().replaceAll('-', '_')}`,
  toolTimeoutSec: 2,
  ...overrides,
});

const createHarness = ({
  toolsByApp = { 'app-a': [tool('find')], 'app-b': [tool('save')] },
  resultsByApp = { 'app-a': { structuredContent: { ok: true } }, 'app-b': { structuredContent: { ok: true } } },
  configsByApp = {},
  listenFailure,
  listErrorByApp = {},
  listByApp = {},
  callByApp = {},
  terminateByApp = {},
} = {}) => {
  const events = [];
  const releases = [];
  const clients = new Map();
  const appMcpManager = {
    listenRequiredMcps: async (appIds, runId) => {
      events.push({ type: 'listen', appIds, runId });
      if (listenFailure) return { servers: [], failures: [listenFailure] };
      return {
        servers: appIds.map((appId) => ({ appId, config: configsByApp[appId] ?? configFor(appId) })),
        failures: [],
      };
    },
    releaseMcps: (runId) => {
      releases.push(runId);
      events.push({ type: 'release', runId });
    },
  };
  const clientFactory = (config, appId) => {
    events.push({ type: 'factory', appId, config });
    const client = {
      connectCount: 0,
      closeCount: 0,
      async connect() {
        this.connectCount += 1;
        events.push({ type: 'initialize', appId });
      },
      async listTools(params) {
        events.push({ type: 'tools/list', appId });
        if (listErrorByApp[appId]) throw listErrorByApp[appId];
        if (listByApp[appId]) return await listByApp[appId](params);
        return { tools: toolsByApp[appId] ?? [] };
      },
      async callTool(params, options) {
        events.push({ type: 'tools/call', appId, params, options });
        if (callByApp[appId]) return await callByApp[appId](params, options);
        return resultsByApp[appId];
      },
      async terminateSession() {
        events.push({ type: 'terminate', appId });
        if (terminateByApp[appId]) return await terminateByApp[appId]();
      },
      async close() {
        this.closeCount += 1;
        events.push({ type: 'close', appId });
      },
    };
    clients.set(appId, client);
    return client;
  };
  const Service = requireService();
  const service = new Service({
    appMcpManager,
    getInstalledApps: () => [
      { id: 'app-a', name: 'App A', version: '1.0.0', status: 'installed' },
      { id: 'app-b', name: 'App B', version: '2.0.0', status: 'installed' },
    ],
    clientFactory,
  });
  return { service, appMcpManager, events, releases, clients };
};

const assertRejectsCode = async (operation, code) => {
  await assert.rejects(operation, (error) => {
    assert.equal(error instanceof Error, true);
    assert.equal(error.message, code);
    assert.equal(JSON.stringify(error).includes('mcp-secret-'), false);
    return true;
  });
};

test('preflight initializes and lists every MCP before returning public definitions, without exposing Bearer material', async () => {
  const harness = createHarness();
  const definitions = await harness.service.prepareAppActions([
    { appId: 'app-a', toolName: 'find' },
    { appId: 'app-b', toolName: 'save' },
  ], 'run-preflight');

  assert.deepEqual(harness.events.filter((event) => event.type === 'initialize').map((event) => event.appId), ['app-a', 'app-b']);
  assert.deepEqual(harness.events.filter((event) => event.type === 'tools/list').map((event) => event.appId), ['app-a', 'app-b']);
  assert.equal(harness.events.some((event) => event.type === 'tools/call'), false);
  assert.deepEqual(definitions.map(({ appId, toolName }) => ({ appId, toolName })), [
    { appId: 'app-a', toolName: 'find' },
    { appId: 'app-b', toolName: 'save' },
  ]);
  const publicJson = JSON.stringify(definitions);
  assert.doesNotMatch(publicJson, /mcp-secret|tokenEnvVar|authorization|bearer|127\.0\.0\.1/i);

  await harness.service.releaseAppActions('run-preflight');
  assert.deepEqual(harness.releases, ['run-preflight']);
  assert.equal(harness.clients.get('app-a').closeCount, 1);
  assert.equal(harness.clients.get('app-b').closeCount, 1);
});

test('tools/call uses the retained preflight client, validates JSON Schema input, and accepts only object structuredContent', async () => {
  const inputSchema = objectSchema({ recordId: { type: 'string', minLength: 1 } }, ['recordId']);
  const outputSchema = objectSchema({ savedId: { type: 'string' } }, ['savedId']);
  const harness = createHarness({
    toolsByApp: { 'app-a': [tool('save', { inputSchema, outputSchema })] },
    callByApp: {
      'app-a': async (params) => {
        assert.deepEqual(params, { name: 'save', arguments: { recordId: 'record-42' } });
        return { structuredContent: { savedId: params.arguments.recordId } };
      },
    },
  });
  await harness.service.prepareAppActions([{ appId: 'app-a', toolName: 'save' }], 'run-call');

  await assertRejectsCode(() => harness.service.callAppAction({
    runId: 'run-call', appId: 'app-a', toolName: 'save', input: { recordId: 42 },
  }), 'workflow_app_action_input_invalid');
  assert.equal(harness.events.some((event) => event.type === 'tools/call'), false, 'invalid AJV input has no effect');

  const result = await harness.service.callAppAction({
    runId: 'run-call', appId: 'app-a', toolName: 'save', input: { recordId: 'record-42' },
  });
  assert.deepEqual(result, { structuredContent: { savedId: 'record-42' } });
  assert.equal(harness.clients.get('app-a').connectCount, 1, 'call reuses the preflight client and token');
  await harness.service.releaseAppActions('run-call');
});

test('preflight rejects ambiguous, asynchronous, or untyped tools and rolls back both apps exactly once', async (t) => {
  const invalidCases = [
    ['duplicate name', [tool('find'), tool('find')], 'workflow_app_action_list_failed'],
    ['required MCP task', [tool('find', { execution: { taskSupport: 'required' } })], 'workflow_app_action_list_failed'],
    ['missing output schema', [tool('find', { outputSchema: undefined })], 'workflow_app_action_output_schema_required'],
  ];
  for (const [label, appATools, code] of invalidCases) {
    await t.test(label, async () => {
      const harness = createHarness({ toolsByApp: { 'app-a': appATools, 'app-b': [tool('save')] } });
      await assertRejectsCode(() => harness.service.prepareAppActions([
        { appId: 'app-a', toolName: 'find' },
        { appId: 'app-b', toolName: 'save' },
      ], `run-${label}`), code);
      assert.equal(harness.events.some((event) => event.type === 'tools/call'), false);
      assert.deepEqual(harness.releases, [`run-${label}`]);
      for (const client of harness.clients.values()) assert.equal(client.closeCount, 1);
      await harness.service.releaseAppActions(`run-${label}`);
      assert.deepEqual(harness.releases, [`run-${label}`], 'explicit release after rollback is idempotent');
    });
  }
});

test('a failure listing the second app closes both initialized clients and releases the manager listener once', async () => {
  const harness = createHarness({ listErrorByApp: { 'app-b': new Error('Bearer mcp-secret-app-b redirect') } });
  await assertRejectsCode(() => harness.service.prepareAppActions([
    { appId: 'app-a', toolName: 'find' },
    { appId: 'app-b', toolName: 'save' },
  ], 'run-rollback'), 'workflow_app_action_list_failed');

  assert.deepEqual(harness.releases, ['run-rollback']);
  assert.equal(harness.clients.get('app-a').closeCount, 1);
  assert.equal(harness.clients.get('app-b').closeCount, 1);
  assert.equal(harness.events.some((event) => event.type === 'tools/call'), false);
});

test('non-loopback MCP URLs are rejected before constructing a client and redirects fail closed', async (t) => {
  await t.test('remote URL', async () => {
    const harness = createHarness({ configsByApp: { 'app-a': configFor('app-a', { url: 'https://attacker.example/mcp' }) } });
    await assertRejectsCode(
      () => harness.service.prepareAppActions([{ appId: 'app-a', toolName: 'find' }], 'run-remote'),
      'workflow_app_action_list_failed',
    );
    assert.equal(harness.events.some((event) => event.type === 'factory'), false);
    assert.deepEqual(harness.releases, ['run-remote']);
  });

  await t.test('redirect surfaced by transport', async () => {
    const harness = createHarness({ listErrorByApp: { 'app-a': new Error('redirect_not_allowed') } });
    await assertRejectsCode(
      () => harness.service.prepareAppActions([{ appId: 'app-a', toolName: 'find' }], 'run-redirect'),
      'workflow_app_action_list_failed',
    );
    assert.deepEqual(harness.releases, ['run-redirect']);
  });
});

test('tools/call rejects isError, text fallback, invalid structured output, timeout, and cancellation with stable errors', async (t) => {
  const cases = [
    ['isError', async () => ({ isError: true, structuredContent: { ok: false } }), 'workflow_app_action_tool_error'],
    ['text-only', async () => ({ content: [{ type: 'text', text: '{"ok":true}' }] }), 'workflow_app_action_output_invalid'],
    ['array structuredContent', async () => ({ structuredContent: [{ ok: true }] }), 'workflow_app_action_output_invalid'],
    ['schema-invalid structuredContent', async () => ({ structuredContent: { ok: 'yes' } }), 'workflow_app_action_output_invalid'],
    ['timeout', async (_params, options) => await new Promise((_resolve, reject) => {
      options.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }), 'workflow_app_action_timeout', 10],
  ];
  for (const [label, implementation, code, timeoutMs] of cases) {
    await t.test(label, async () => {
      const harness = createHarness({ callByApp: { 'app-a': implementation } });
      await harness.service.prepareAppActions([{ appId: 'app-a', toolName: 'find' }], `run-${label}`);
      await assertRejectsCode(() => harness.service.callAppAction({
        runId: `run-${label}`, appId: 'app-a', toolName: 'find', input: {}, ...(timeoutMs ? { timeoutMs } : {}),
      }), code);
      await harness.service.releaseAppActions(`run-${label}`);
      assert.deepEqual(harness.releases, [`run-${label}`]);
      assert.equal(harness.clients.get('app-a').closeCount, 1);
    });
  }

  await t.test('external cancellation', async () => {
    const controller = new AbortController();
    const harness = createHarness({
      callByApp: { 'app-a': async (_params, options) => await new Promise((_resolve, reject) => {
        options.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      }) },
    });
    await harness.service.prepareAppActions([{ appId: 'app-a', toolName: 'find' }], 'run-cancel');
    const operation = harness.service.callAppAction({
      runId: 'run-cancel', appId: 'app-a', toolName: 'find', input: {}, signal: controller.signal,
    });
    controller.abort();
    await assertRejectsCode(() => operation, 'workflow_app_action_canceled');
    await harness.service.releaseAppActions('run-cancel');
    assert.equal(harness.clients.get('app-a').closeCount, 1);
    assert.deepEqual(harness.releases, ['run-cancel']);
  });
});

test('listAppActions uses one ephemeral MCP session and returns a credential-free catalog', async () => {
  const harness = createHarness();
  const catalog = await harness.service.listAppActions('app-a');
  assert.equal(catalog.appId, 'app-a');
  assert.equal(catalog.appName, 'App A');
  assert.deepEqual(catalog.actions.map((action) => action.toolName), ['find']);
  assert.doesNotMatch(JSON.stringify(catalog), /mcp-secret|tokenEnvVar|authorization|bearer|127\.0\.0\.1/i);
  assert.equal(harness.releases.length, 1);
  assert.equal(harness.clients.get('app-a').closeCount, 1);
});

test('legacy tools stay available to agents but are omitted from the deterministic catalog', async () => {
  const harness = createHarness({
    toolsByApp: {
      'app-a': [
        tool('legacy-text-tool', { outputSchema: undefined }),
        tool('find'),
      ],
    },
  });
  const catalog = await harness.service.listAppActions('app-a');
  assert.deepEqual(catalog.actions.map((action) => action.toolName), ['find']);
});

test('schema or risk drift after preflight blocks tools/call', async () => {
  const toolsByApp = { 'app-a': [tool('find')] };
  const harness = createHarness({ toolsByApp });
  await harness.service.prepareAppActions([{ appId: 'app-a', toolName: 'find' }], 'run-drift');
  toolsByApp['app-a'] = [tool('find', { annotations: { readOnlyHint: false } })];

  await assertRejectsCode(() => harness.service.callAppAction({
    runId: 'run-drift', appId: 'app-a', toolName: 'find', input: {},
  }), 'workflow_app_action_contract_changed');
  assert.equal(harness.events.some((event) => event.type === 'tools/call'), false);
  await harness.service.releaseAppActions('run-drift');
});

test('read-only tools that can reach the open world are external and require mandatory approval', async () => {
  const harness = createHarness({
    toolsByApp: { 'app-a': [tool('find', { annotations: { readOnlyHint: true, openWorldHint: true } })] },
  });
  const [definition] = await harness.service.prepareAppActions(
    [{ appId: 'app-a', toolName: 'find' }],
    'run-open-world',
  );
  assert.equal(definition.effect, 'external');
  assert.equal(definition.annotations.readOnlyHint, true);
  assert.equal(definition.annotations.openWorldHint, true);
  await harness.service.releaseAppActions('run-open-world');
});

test('a hung MCP terminate cannot block close or releaseMcps and cleanup stays exactly-once', async () => {
  const never = new Promise(() => undefined);
  const harness = createHarness({ terminateByApp: { 'app-a': async () => await never } });
  await harness.service.prepareAppActions([{ appId: 'app-a', toolName: 'find' }], 'run-hung-terminate');
  await Promise.race([
    harness.service.releaseAppActions('run-hung-terminate'),
    new Promise((_resolve, reject) => setTimeout(() => reject(new Error('cleanup_timeout')), 250)),
  ]);
  assert.deepEqual(harness.releases, ['run-hung-terminate']);
  assert.equal(harness.clients.get('app-a').closeCount, 1);
  assert.equal(harness.events.filter((event) => event.type === 'terminate').length, 1);
  await harness.service.releaseAppActions('run-hung-terminate');
  assert.deepEqual(harness.releases, ['run-hung-terminate']);
});

test('the SDK transport validates exact loopback and denies redirects on every POST/GET/DELETE request', async () => {
  const source = await readFile(new URL('../../src/main/app-mcp-tool-service.ts', import.meta.url), 'utf8');
  assert.match(source, /const secureLoopbackFetch/);
  assert.match(source, /assertLoopbackMcpUrl\((?:requestUrl|url)/);
  assert.match(source, /redirect:\s*'error'/);
  assert.match(source, /fetch:\s*secureLoopbackFetch/);
  assert.match(source, /new StreamableHTTPClientTransport[\s\S]*?fetch:\s*secureLoopbackFetch/);
  assert.match(source, /limitMcpResponseBody\(response\)/);
  assert.match(source, /headers\.get\('content-length'\)/);
  assert.match(source, /response\.body\.getReader\(\)/);
  assert.match(source, /receivedBytes > MAX_MCP_RESPONSE_BYTES/);
});

test('catalog discovery rejects aggregate oversized action text even with valid tool count and schemas', async () => {
  const largeText = 'x'.repeat(40_000);
  const harness = createHarness({
    toolsByApp: {
      'app-a': Array.from({ length: 100 }, (_value, index) => tool(`tool-${index}`, {
        title: `${index}-${largeText}`,
        description: largeText,
      })),
    },
  });
  await assertRejectsCode(() => harness.service.listAppActions('app-a'), 'workflow_app_action_list_failed');
  assert.equal(harness.releases.length, 1);
  assert.equal(harness.clients.get('app-a').closeCount, 1);
});

test('catalog discovery applies its byte limit to all pages combined', async () => {
  const pageText = 'x'.repeat(25_000);
  const pages = [0, 1, 2].map((pageIndex) => Array.from({ length: 30 }, (_value, index) =>
    tool(`page-${pageIndex}-tool-${index}`, { description: pageText })));
  const harness = createHarness({
    listByApp: {
      'app-a': async (params) => {
        const pageIndex = params?.cursor ? Number(params.cursor) : 0;
        return {
          tools: pages[pageIndex],
          ...(pageIndex < pages.length - 1 ? { nextCursor: String(pageIndex + 1) } : {}),
        };
      },
    },
  });

  await assertRejectsCode(() => harness.service.listAppActions('app-a'), 'workflow_app_action_list_failed');
  assert.equal(harness.events.filter((event) => event.type === 'tools/list').length, 3);
  assert.deepEqual(harness.releases.length, 1);
});

test('persisted app-action input rejects oversized, over-deep, and prototype-polluting objects', () => {
  const unsafe = JSON.parse('{"__proto__":{"polluted":true}}');
  const tooDeep = {};
  let cursor = tooDeep;
  for (let depth = 0; depth < 35; depth += 1) {
    cursor.next = {};
    cursor = cursor.next;
  }
  for (const input of [
    { payload: 'x'.repeat(2_000_001) },
    tooDeep,
    unsafe,
    { constructor: { prototype: { polluted: true } } },
  ]) {
    assert.equal(sanitizeWorkflowNode({
      id: 'a', name: 'Unsafe action', type: 'app_action', appId: 'app-a', toolName: 'find', input,
    }), null);
  }
});

test('AppMcpManager includes the generated MCP Bearer token in stdout/stderr redaction secrets', async () => {
  const source = await readFile(new URL('../../src/main/app-mcp-manager.ts', import.meta.url), 'utf8');
  assert.match(source, /formatProcessOutput\(chunk\.toString\(\),\s*\[\.\.\.resolvedSecrets\.secretValues,\s*token\]\)/);
  assert.equal(source.includes("appendInstallLog('app_mcp:start_failed'"), true);
});
