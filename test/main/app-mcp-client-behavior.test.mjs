import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
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

const startMcpFixture = async ({ tools, token = 'fixture-token', onCall }) => {
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

    // Stateless MCP creates one protocol/transport pair per HTTP exchange.
    // This is a real Streamable HTTP loopback fixture, not a mocked SDK client.
    const protocol = new Server(
      { name: 'forger-app-fixture', version: '1.0.0' },
      { capabilities: { tools: {} } },
    );
    protocols.add(protocol);
    protocol.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
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
    declaredTool('invalid.tuple-array', {
      outputSchema: nestedOutput({
        type: 'array',
        items: [{ type: 'string' }, { type: 'number' }],
      }),
    }),
    declaredTool('invalid.root-object', {
      inputSchema: { type: 'object', properties: {} },
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
