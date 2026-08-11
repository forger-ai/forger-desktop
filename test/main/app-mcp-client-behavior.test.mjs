import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { CallToolRequestSchema, ListToolsRequestSchema } = require('@modelcontextprotocol/sdk/types.js');

const loadAppMcpClient = () => {
  try {
    const loaded = require('../../dist-electron/main/app-mcp-client.js');
    assert.equal(typeof loaded.AppMcpClient, 'function', 'AppMcpClient must be exported');
    return loaded.AppMcpClient;
  } catch (error) {
    assert.fail(`AppMcpClient must compile at src/main/app-mcp-client.ts: ${error instanceof Error ? error.message : error}`);
  }
};

const schema = (properties = {}) => ({
  type: 'object',
  properties,
  additionalProperties: false,
});

const annotations = (overrides = {}) => ({
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
  ...overrides,
});

const declaredTool = (name, overrides = {}) => ({
  name,
  title: overrides.title ?? name,
  description: overrides.description ?? `${name} description`,
  inputSchema: overrides.inputSchema ?? schema(),
  outputSchema: overrides.outputSchema ?? schema({ ok: { type: 'boolean' } }),
  annotations: overrides.annotations ?? annotations(),
});

const startMcpFixture = async ({ tools, token = 'fixture-token', onCall, delayMs = 0, nextCursor, onListTools }) => {
  const requests = [];
  const protocols = new Set();
  const server = http.createServer(async (request, response) => {
    requests.push({
      method: request.method,
      url: request.url,
      authorization: request.headers.authorization,
    });
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
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }

    // Stateless MCP creates one protocol/transport pair per HTTP exchange.
    // This is a real Streamable HTTP loopback fixture, not a mocked SDK client.
    const protocol = new Server(
      { name: 'forger-app-fixture', version: '1.0.0' },
      { capabilities: { tools: {} } },
    );
    protocols.add(protocol);
    protocol.setRequestHandler(ListToolsRequestSchema, async ({ params }) => {
      if (onListTools) return onListTools(params ?? {});
      return { tools, ...(nextCursor ? { nextCursor } : {}) };
    });
    protocol.setRequestHandler(CallToolRequestSchema, async ({ params }, extra) => await onCall(params, extra));
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
    url: `http://127.0.0.1:${address.port}/mcp`,
    token,
    requests,
    close: async () => {
      for (const protocol of protocols) {
        await protocol.close().catch(() => undefined);
      }
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
};

const actionProjection = (action) => ({
  toolName: action.toolName,
  effect: action.effect,
  risk: action.risk,
  idempotent: action.idempotent,
});

test('AppMcpClient discovers only fully contracted actions and derives stable safety metadata', async () => {
  const AppMcpClient = loadAppMcpClient();
  const tools = [
    declaredTool('customers.read', {
      title: 'Read customer',
      annotations: annotations({ readOnlyHint: true, idempotentHint: true }),
    }),
    declaredTool('notes.write', {
      title: 'Write note',
      annotations: annotations({ idempotentHint: true }),
    }),
    declaredTool('notice.publish', {
      title: 'Publish notice',
      annotations: annotations({ openWorldHint: true }),
    }),
    declaredTool('records.delete', {
      title: 'Delete record',
      annotations: annotations({ destructiveHint: true }),
    }),
    declaredTool('missing.output', { outputSchema: undefined }),
    {
      ...declaredTool('partial.annotations'),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
  ];
  // `declaredTool` defaults undefined outputSchema; delete it explicitly to
  // model a legacy MCP tool that is callable but cannot be composed safely.
  delete tools[4].outputSchema;
  const fixture = await startMcpFixture({
    tools,
    onCall: async () => ({ content: [{ type: 'text', text: 'unused' }], structuredContent: { ok: true } }),
  });
  const client = new AppMcpClient({ url: fixture.url, token: fixture.token, timeoutMs: 1_000 });
  try {
    const first = await client.listActions();
    const second = await client.listActions();

    assert.deepEqual(first.map(actionProjection), [
      { toolName: 'customers.read', effect: 'read', risk: 'low', idempotent: true },
      { toolName: 'notes.write', effect: 'write', risk: 'medium', idempotent: true },
      { toolName: 'notice.publish', effect: 'external', risk: 'medium', idempotent: false },
      { toolName: 'records.delete', effect: 'destructive', risk: 'high', idempotent: false },
    ]);
    assert.deepEqual(first[0], {
      toolName: 'customers.read',
      title: 'Read customer',
      description: 'customers.read description',
      inputSchema: schema(),
      outputSchema: schema({ ok: { type: 'boolean' } }),
      effect: 'read',
      risk: 'low',
      idempotent: true,
      contractHash: first[0].contractHash,
    });
    assert.match(first[0].contractHash, /^[a-f0-9]{64}$/);
    assert.deepEqual(
      second.map((action) => action.contractHash),
      first.map((action) => action.contractHash),
      'the same MCP contract has the same identity across discovery calls',
    );
    assert.ok(fixture.requests.length >= 3, 'initialization plus tools/list requests reached loopback');
    assert.ok(fixture.requests.every((request) => request.authorization === `Bearer ${fixture.token}`));
  } finally {
    await client.close();
    await fixture.close();
  }
});

test('AppMcpClient accepts the MCP annotation title fallback and explicit timeout', async () => {
  const AppMcpClient = loadAppMcpClient();
  const tool = declaredTool('annotation.title');
  delete tool.title;
  tool.annotations.title = 'Annotation title';
  const fixture = await startMcpFixture({ tools: [tool] });
  const client = new AppMcpClient({ url: fixture.url, token: fixture.token, timeoutMs: 25 });
  try {
    const [action] = await client.listActions();
    assert.equal(action.title, 'Annotation title');
  } finally {
    await client.close();
    await fixture.close();
  }
});

test('AppMcpClient discovers only schemas covered by the workflow validator subset', async () => {
  const AppMcpClient = loadAppMcpClient();
  const nestedOutput = (valueSchema) => schema({ value: valueSchema });
  const tools = [
    declaredTool('valid.nested', {
      inputSchema: schema({
        payload: {
          type: 'object',
          properties: {
            names: {
              type: 'array',
              items: { type: 'string', minLength: 1, maxLength: 80 },
              minItems: 1,
              maxItems: 10,
            },
          },
          required: ['names'],
          additionalProperties: false,
        },
      }),
      outputSchema: nestedOutput({ type: 'integer', enum: [1, 2, 3] }),
    }),
    declaredTool('invalid.pattern', {
      outputSchema: nestedOutput({ type: 'string', pattern: '^unsafe$' }),
    }),
    declaredTool('invalid.minimum', {
      outputSchema: nestedOutput({ type: 'number', minimum: 0 }),
    }),
    declaredTool('invalid.maximum', {
      outputSchema: nestedOutput({ type: 'number', maximum: 10 }),
    }),
    declaredTool('invalid.combinator', {
      outputSchema: nestedOutput({ type: 'string', oneOf: [{ type: 'string' }] }),
    }),
    declaredTool('invalid.any-of', {
      outputSchema: nestedOutput({ type: 'string', anyOf: [{ type: 'string' }] }),
    }),
    declaredTool('invalid.all-of', {
      outputSchema: nestedOutput({ type: 'string', allOf: [{ type: 'string' }] }),
    }),
    declaredTool('invalid.const', {
      outputSchema: nestedOutput({ type: 'string', const: 'fixed' }),
    }),
    declaredTool('invalid.reference', {
      outputSchema: nestedOutput({ type: 'string', $ref: '#' }),
    }),
    declaredTool('invalid.union-type', {
      outputSchema: nestedOutput({ type: ['string', 'null'] }),
    }),
    declaredTool('invalid.missing-type', {
      outputSchema: nestedOutput({ description: 'No scalar type.' }),
    }),
    declaredTool('invalid.open-object', {
      outputSchema: nestedOutput({ type: 'object', properties: {} }),
    }),
    declaredTool('invalid.required-key', {
      outputSchema: nestedOutput({
        type: 'object',
        properties: {},
        required: ['missing'],
        additionalProperties: false,
      }),
    }),
    declaredTool('invalid.nested-array-item', {
      outputSchema: nestedOutput({
        type: 'array',
        items: { type: 'string', pattern: '^unsupported$' },
      }),
    }),
    declaredTool('invalid.root-object', {
      inputSchema: { type: 'object', properties: {} },
    }),
    declaredTool('invalid.object-enum-value', {
      outputSchema: nestedOutput({ type: 'object', enum: ['not-an-object'], properties: {}, additionalProperties: false }),
    }),
    declaredTool('invalid.array-enum-value', {
      outputSchema: nestedOutput({ type: 'array', enum: [{ not: 'an-array' }], items: { type: 'string' } }),
    }),
    declaredTool('invalid.schema-title-type', {
      outputSchema: nestedOutput({ type: 'string', title: 42 }),
    }),
    declaredTool('invalid.schema-description-type', {
      outputSchema: nestedOutput({ type: 'string', description: 42 }),
    }),
    declaredTool('invalid.duplicate-required', {
      outputSchema: nestedOutput({ type: 'object', properties: {}, required: ['same', 'same'], additionalProperties: false }),
    }),
  ];
  const fixture = await startMcpFixture({
    tools,
    onCall: async () => ({ content: [], structuredContent: { value: 1 } }),
  });
  const client = new AppMcpClient({ url: fixture.url, token: fixture.token, timeoutMs: 1_000 });
  try {
    assert.deepEqual(
      (await client.listActions()).map((action) => action.toolName),
      ['valid.nested'],
    );
  } finally {
    await client.close();
    await fixture.close();
  }
});

test('AppMcpClient validates enum values for every supported schema type', async () => {
  const AppMcpClient = loadAppMcpClient();
  const typed = schema({
    string: { type: 'string', enum: ['text'] },
    integer: { type: 'integer', enum: [2] },
    number: { type: 'number', enum: [2.5] },
    boolean: { type: 'boolean', enum: [true] },
    nullValue: { type: 'null', enum: [null] },
    object: { type: 'object', enum: [{ ok: true }], properties: {}, additionalProperties: false },
    array: { type: 'array', enum: [[]], items: { type: 'string' } },
    minOnly: { type: 'string', minLength: 1 },
    maxOnly: { type: 'string', maxLength: 5 },
    titled: { type: 'string', title: 'Title', description: 'Description' },
  });
  const fixture = await startMcpFixture({ tools: [declaredTool('typed.enums', { outputSchema: typed })] });
  const client = new AppMcpClient({ url: fixture.url, token: fixture.token, timeoutMs: 1_000 });
  try {
    assert.deepEqual((await client.listActions()).map((action) => action.toolName), ['typed.enums']);
  } finally {
    await client.close();
    await fixture.close();
  }
});

test('AppMcpClient returns only structuredContent objects and rejects legacy text-only tool results', async () => {
  const AppMcpClient = loadAppMcpClient();
  const tools = [
    declaredTool('echo.structured'),
    declaredTool('echo.text_only'),
  ];
  const calls = [];
  const fixture = await startMcpFixture({
    tools,
    onCall: async ({ name, arguments: input }) => {
      calls.push({ name, input });
      return name === 'echo.structured'
        ? {
            content: [{ type: 'text', text: 'done' }],
            structuredContent: { echoed: input, count: 1 },
          }
        : { content: [{ type: 'text', text: 'not composable' }] };
    },
  });
  const client = new AppMcpClient({ url: fixture.url, token: fixture.token, timeoutMs: 1_000 });
  try {
    assert.deepEqual(await client.callAction({
      toolName: 'echo.structured',
      input: { message: 'hello' },
    }), { echoed: { message: 'hello' }, count: 1 });

    await assert.rejects(
      client.callAction({ toolName: 'echo.text_only', input: {} }),
      /app_mcp_structured_content_required/,
    );
    assert.deepEqual(calls, [
      { name: 'echo.structured', input: { message: 'hello' } },
      { name: 'echo.text_only', input: {} },
    ]);
  } finally {
    await client.close();
    await fixture.close();
  }
});

test('AppMcpClient rejects MCP tool errors and closes a connection that finishes after close', async () => {
  const AppMcpClient = loadAppMcpClient();
  const fixture = await startMcpFixture({
    tools: [declaredTool('error.tool')],
    delayMs: 40,
    onCall: async () => ({ content: [{ type: 'text', text: 'failed' }], isError: true }),
  });
  const client = new AppMcpClient({ url: fixture.url, token: fixture.token, timeoutMs: 1_000 });
  try {
    const pending = client.listActions();
    await client.close();
    await assert.rejects(pending, /closed/);
  } finally {
    await client.close();
    await fixture.close();
  }

  const errorFixture = await startMcpFixture({
    tools: [declaredTool('error.tool')],
    onCall: async () => ({ content: [{ type: 'text', text: 'failed' }], isError: true }),
  });
  const errorClient = new AppMcpClient({ url: errorFixture.url, token: errorFixture.token, timeoutMs: 1_000 });
  try {
    await errorClient.listActions();
    await assert.rejects(errorClient.callAction({ toolName: 'error.tool', input: {} }), /app_mcp_action_failed/);
  } finally {
    await errorClient.close();
    await errorFixture.close();
  }
});

test('AppMcpClient bounds calls with both an explicit timeout and an AbortSignal', async () => {
  const AppMcpClient = loadAppMcpClient();
  const tools = [declaredTool('slow.wait')];
  const fixture = await startMcpFixture({
    tools,
    onCall: async () => {
      await new Promise((resolve) => setTimeout(resolve, 250));
      return { content: [{ type: 'text', text: 'late' }], structuredContent: { ok: true } };
    },
  });
  const client = new AppMcpClient({ url: fixture.url, token: fixture.token, timeoutMs: 1_000 });
  try {
    await assert.rejects(
      client.callAction({ toolName: 'slow.wait', input: {}, timeoutMs: 20 }),
      (error) => error instanceof Error && /timeout|timed.out/i.test(error.message),
    );

    const controller = new AbortController();
    const aborted = client.callAction({
      toolName: 'slow.wait',
      input: {},
      signal: controller.signal,
      timeoutMs: 1_000,
    });
    setTimeout(() => controller.abort(), 20);
    await assert.rejects(
      aborted,
      (error) => error instanceof Error && /abort|cancel/i.test(error.message),
    );
  } finally {
    await client.close();
    await fixture.close();
  }
});

test('AppMcpClient rejects every unsafe schema shape and non-object tool result', async () => {
  const AppMcpClient = loadAppMcpClient();
  const tools = [
    declaredTool('bad.enum-type', { outputSchema: schema({ value: { type: 'string', enum: [1] } }) }),
    declaredTool('bad.required', { outputSchema: schema({ value: { type: 'object', properties: {}, required: ['missing'], additionalProperties: false } }) }),
    declaredTool('bad.array-bounds', { outputSchema: schema({ value: { type: 'array', items: { type: 'string' }, minItems: 3, maxItems: 1 } }) }),
    declaredTool('bad.array-min', { outputSchema: schema({ value: { type: 'array', items: { type: 'string' }, minItems: -1 } }) }),
    declaredTool('bad.string-bounds', { outputSchema: schema({ value: { type: 'string', minLength: 3, maxLength: 1 } }) }),
    declaredTool('bad.string-min', { outputSchema: schema({ value: { type: 'string', minLength: -1 } }) }),
    declaredTool('bad.open-object', { outputSchema: schema({ value: { type: 'object', properties: {} } }) }),
    declaredTool('oversized.schema', { outputSchema: { ...schema({}), description: 'x'.repeat(300_000) } }),
  ];
  const fixture = await startMcpFixture({ tools, onCall: async () => ({ content: [], structuredContent: [] }) });
  const client = new AppMcpClient({ url: fixture.url, token: fixture.token, timeoutMs: 1_000 });
  try {
    assert.deepEqual(await client.listActions(), []);
    await assert.rejects(client.callAction({ toolName: 'bad.enum-type', input: {} }), /app_mcp_structured_content_required|MCP error/);
  } finally {
    await client.close();
    await fixture.close();
  }
});

test('AppMcpClient validates loopback boundaries, bounded inputs, fallbacks, and duplicate discovery', async () => {
  const AppMcpClient = loadAppMcpClient();
  assert.throws(() => new AppMcpClient({ url: 'http://[invalid/mcp', token: 't' }), /app_mcp_url_invalid/);
  for (const url of [
    'http://127.0.0.1:0/mcp',
    'http://127.0.0.1:65536/mcp',
    'http://127.0.0.1:1/other',
    'http://user:pass@127.0.0.1:1/mcp',
    'http://127.0.0.1:1/mcp#hash',
    'http://127.0.0.2:1/mcp',
  ]) {
    assert.throws(() => new AppMcpClient({ url, token: 't' }), /loopback|invalid/);
  }
  const duplicateFixture = await startMcpFixture({
    tools: [declaredTool('same'), declaredTool('same')],
    onCall: async () => ({ content: [], structuredContent: { ok: true } }),
  });
  const client = new AppMcpClient({ url: duplicateFixture.url, token: duplicateFixture.token, timeoutMs: 1_000 });
  try {
    await assert.rejects(client.listActions(), /duplicate_action/);
    const cyclic = {}; cyclic.self = cyclic;
    await assert.rejects(client.callAction({ toolName: 'same', input: cyclic }), /action_input_invalid/);
  } finally {
    await client.close();
    await duplicateFixture.close();
  }
});

test('AppMcpClient covers bounded discovery, schema serialization failures, and connection cleanup', async () => {
  const AppMcpClient = loadAppMcpClient();
  const invalidInputClient = new AppMcpClient({ url: 'http://127.0.0.1:1/mcp', token: 't', timeoutMs: 1_000 });
  const defaultTimeoutClient = new AppMcpClient({ url: 'http://127.0.0.1:1/mcp', token: 't' });
  const unsafeInput = JSON.parse('{"__proto__":true}');
  await assert.rejects(invalidInputClient.callAction({ toolName: 'x', input: unsafeInput }), /action_input_invalid/);
  const throwingInput = { ok: true };
  Object.defineProperty(throwingInput, 'toJSON', { enumerable: false, value: () => { throw new Error('serialize'); } });
  await assert.rejects(invalidInputClient.callAction({ toolName: 'x', input: throwingInput }), /action_input_invalid/);
  await assert.rejects(invalidInputClient.listActions(), /ECONNREFUSED|fetch|connect|timeout/i);
  await invalidInputClient.close();
  await defaultTimeoutClient.close();
  const customPrototype = Object.create({ inherited: true });
  await assert.rejects(defaultTimeoutClient.callAction({ toolName: 'x', input: customPrototype }), /action_input_invalid/);
  await assert.rejects(defaultTimeoutClient.callAction({ toolName: 'x', input: () => undefined }), /action_input_invalid/);
  assert.throws(() => new AppMcpClient({ url: 'http://127.0.0.1:1/mcp', token: '   ' }), /app_mcp_token_required/);
  const closedClient = new AppMcpClient({ url: 'http://127.0.0.1:1/mcp', token: 'token' });
  await closedClient.close();
  await assert.rejects(closedClient.listActions(), /app_mcp_client_closed/);
});

test('AppMcpClient enforces discovery page, cursor, and tool-count limits', async () => {
  const AppMcpClient = loadAppMcpClient();
  const duplicateCursorFixture = await startMcpFixture({
    tools: [],
    onListTools: async () => ({ tools: [], nextCursor: 'same' }),
  });
  const duplicateCursorClient = new AppMcpClient({
    url: duplicateCursorFixture.url,
    token: duplicateCursorFixture.token,
    timeoutMs: 1_000,
  });
  try {
    await assert.rejects(duplicateCursorClient.listActions(), /cursor_invalid/);
  } finally {
    await duplicateCursorClient.close();
    await duplicateCursorFixture.close();
  }

  const pageFixture = await startMcpFixture({
    tools: [],
    onListTools: async ({ cursor }) => {
      const next = cursor ? `page-${Number(cursor.split('-')[1]) + 1}` : 'page-1';
      return { tools: [], nextCursor: next };
    },
  });
  const pageClient = new AppMcpClient({ url: pageFixture.url, token: pageFixture.token, timeoutMs: 1_000 });
  try {
    await assert.rejects(pageClient.listActions(), /cursor_invalid/);
  } finally {
    await pageClient.close();
    await pageFixture.close();
  }

  const tooManyFixture = await startMcpFixture({
    tools: Array.from({ length: 101 }, (_, index) => declaredTool(`tool-${index}`)),
  });
  const tooManyClient = new AppMcpClient({ url: tooManyFixture.url, token: tooManyFixture.token, timeoutMs: 1_000 });
  try {
    await assert.rejects(tooManyClient.listActions(), /discovery_limit_exceeded/);
  } finally {
    await tooManyClient.close();
    await tooManyFixture.close();
  }
});

test('AppMcpClient rejects malformed tool contracts at the client boundary', async () => {
  const AppMcpClient = loadAppMcpClient();
  const originalConnect = Client.prototype.connect;
  const originalListTools = Client.prototype.listTools;
  const originalClose = Client.prototype.close;
  Client.prototype.connect = async function connect() {};
  Client.prototype.close = async function close() {};
  Client.prototype.listTools = async function listTools() {
    return {
      tools: [
        Object.assign(declaredTool('bad-input'), { inputSchema: null }),
        declaredTool('bad-type', { outputSchema: schema({ value: { type: 'date' } }) }),
        declaredTool('bad-extra-key', { outputSchema: schema({ value: { type: 'string', pattern: 'unsupported' } }) }),
        declaredTool('bad-required', {
          outputSchema: schema({ value: { type: 'object', properties: { same: { type: 'string' } }, required: ['same', 'same'], additionalProperties: false } }),
        }),
        declaredTool('bad-array-items', { outputSchema: schema({ value: { type: 'array', items: null } }) }),
      ],
    };
  };
  const client = new AppMcpClient({ url: 'http://127.0.0.1:1/mcp', token: 'token' });
  try {
    assert.deepEqual(await client.listActions(), []);
  } finally {
    await client.close();
    Client.prototype.connect = originalConnect;
    Client.prototype.listTools = originalListTools;
    Client.prototype.close = originalClose;
  }
});
