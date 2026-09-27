import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createLocalInferenceGateway } = require('../../dist-electron/main/llm-provider/local/gateway.js');

async function setup(t, handler, timeoutMs = 1000, onToolInventory) {
  let calls = 0;
  const runtime = http.createServer((req, res) => { calls++; handler(req, res); });
  await new Promise((resolve) => runtime.listen(0, '127.0.0.1', resolve));
  const gateway = await createLocalInferenceGateway({
    endpoint: `http://127.0.0.1:${runtime.address().port}`,
    model: 'fixture:small', timeoutMs, onToolInventory,
  });
  t.after(async () => {
    await gateway.close();
    runtime.closeAllConnections();
    await new Promise((resolve) => runtime.close(resolve));
  });
  return { gateway, calls: () => calls };
}

test('gateway preserves namespaced function declarations and records only bounded contract identifiers', async (t) => {
  const inventories = [];
  const data = {
    model: 'fixture:small', input: 'PRIVATE PROMPT',
    tools: [{ type: 'namespace', name: 'functions', tools: [{
      type: 'function', name: 'exec_command', description: 'PRIVATE DESCRIPTION',
      parameters: { type: 'object', properties: { cmd: { type: 'string' } } },
    }] }],
  };
  let forwarded;
  const f = await setup(t, (req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => { forwarded = JSON.parse(body); res.end('{}'); });
  }, 1000, (inventory) => inventories.push(inventory));
  for (let i = 0; i < 2; i++) {
    const response = await request(f.gateway, { body: JSON.stringify(data) });
    assert.equal(response.status, 200);
    await response.text();
  }
  assert.deepEqual(forwarded, data);
  assert.deepEqual(inventories.at(-1), [
    { type: 'namespace', name: 'functions', namespace: '' },
    { type: 'function', name: 'exec_command', namespace: 'functions' },
  ]);
});

for (const payload of [
  { tools: [{ type: 'custom', name: 'apply_patch' }] },
  { tools: [{ type: 'namespace', name: 'functions', tools: [{ type: 'custom', name: 'apply_patch' }] }] },
  { tools: [{ type: 'web_search', name: 'search' }] },
  { tools: [{ type: 'unknown', name: 'unknown' }] },
  { tools: [{ type: 'function', name: 'bad name with prompt' }] },
  { tools: {} },
  { input: [{ type: 'custom_tool_call', name: 'apply_patch', input: 'PRIVATE PATCH' }] },
  { input: [{ type: 'custom_tool_call_output', call_id: 'x', output: 'PRIVATE RESULT' }] },
]) {
  test(`gateway refuses unsupported tool contracts before inference: ${JSON.stringify(payload)}`, async (t) => {
    const f = await setup(t, (_req, res) => res.end('unexpected'));
    const response = await request(f.gateway, {
      body: JSON.stringify({ model: 'fixture:small', ...payload }),
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, 'local_tool_contract_unsupported');
    assert.equal(f.calls(), 0);
  });
}

test('gateway limits contract inventory and namespace nesting before forwarding', async (t) => {
  const f = await setup(t, (_req, res) => res.end('unexpected'));
  let nested = { type: 'function', name: 'run' };
  for (let i = 0; i < 10; i++) nested = { type: 'namespace', name: 'scope', tools: [nested] };
  for (const tools of [
    [nested],
    Array.from({ length: 129 }, (_, i) => ({ type: 'function', name: `tool_${i}` })),
  ]) {
    assert.equal((await request(f.gateway, {
      body: JSON.stringify({ model: 'fixture:small', tools }),
    })).status, 400);
  }
  assert.equal(f.calls(), 0);
});

function request(gateway, options = {}) {
  return fetch(`${gateway.baseUrl}${options.path ?? '/responses'}`, {
    method: options.method ?? 'POST',
    headers: { authorization: `Bearer ${gateway.token}`, 'content-type': 'application/json', ...options.headers },
    body: options.method === 'GET' ? undefined : options.body ?? JSON.stringify({ model: 'fixture:small', stream: true }),
  });
}

test('gateway authenticates each request and rejects unsupported routes, methods and models', async (t) => {
  const f = await setup(t, (_req, res) => res.end('unexpected'));
  assert.equal((await request(f.gateway, { headers: { authorization: 'Bearer wrong' } })).status, 401);
  assert.equal((await request(f.gateway, { path: '/models' })).status, 404);
  assert.equal((await request(f.gateway, { method: 'GET' })).status, 405);
  assert.equal((await request(f.gateway, { body: '{' })).status, 400);
  assert.equal((await request(f.gateway, { body: JSON.stringify({ model: 'cloud' }) })).status, 400);
  assert.equal(f.calls(), 0);
});

test('gateway forwards bounded local streaming without passing authorization or cookies', async (t) => {
  const f = await setup(t, (req, res) => {
    assert.equal(req.url, '/v1/responses');
    assert.equal(req.headers.authorization, undefined);
    assert.equal(req.headers.cookie, undefined);
    assert.equal(req.headers['x-secret'], undefined);
    res.setHeader('content-type', 'text/event-stream');
    res.write('data: first\n\n');
    res.end('data: second\n\n');
  });
  const response = await request(f.gateway, { headers: { cookie: 'secret', 'x-secret': 'secret' } });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'data: first\n\ndata: second\n\n');
  assert.equal(f.calls(), 1);
});

test('gateway rejects redirects without sending inference to the redirected port', async (t) => {
  let redirected = 0;
  const canary = http.createServer((_req, res) => { redirected++; res.end(); });
  await new Promise((resolve) => canary.listen(0, '127.0.0.1', resolve));
  t.after(async () => { canary.closeAllConnections(); await new Promise((resolve) => canary.close(resolve)); });
  const f = await setup(t, (_req, res) => {
    res.writeHead(307, { location: `http://127.0.0.1:${canary.address().port}/leak` });
    res.end();
  });
  const response = await request(f.gateway);
  assert.equal(response.status, 502);
  assert.equal(redirected, 0);
});

test('gateway refuses oversized requests before forwarding', async (t) => {
  const f = await setup(t, (_req, res) => res.end('unexpected'));
  const response = await request(f.gateway, { body: JSON.stringify({ model: 'fixture:small', input: 'x'.repeat(2 * 1024 * 1024) }) });
  assert.equal(response.status, 413);
  assert.equal(f.calls(), 0);
});

test('closing the gateway cancels active upstream and client streams and is idempotent', async (t) => {
  let acknowledgeDisconnect;
  const disconnected = new Promise((resolve) => { acknowledgeDisconnect = resolve; });
  const f = await setup(t, (_req, res) => {
    res.on('close', acknowledgeDisconnect);
    res.write('data: waiting\n\n');
  });
  const response = await request(f.gateway);
  const bodyStopped = assert.rejects(response.text());
  await Promise.all([f.gateway.close(), f.gateway.close()]);
  await bodyStopped;
  await Promise.race([
    disconnected,
    new Promise((_resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('runtime connection survived gateway close')), 1500);
      t.after(() => clearTimeout(timer));
    }),
  ]);
  await assert.rejects(request(f.gateway));
});

test('cancelling a client stream closes the associated runtime request', async (t) => {
  let acknowledgeDisconnect;
  const disconnected = new Promise((resolve) => { acknowledgeDisconnect = resolve; });
  const f = await setup(t, (_req, res) => {
    res.on('close', acknowledgeDisconnect);
    res.write('data: waiting\n\n');
  });
  const response = await request(f.gateway);
  await response.body.cancel();
  await Promise.race([
    disconnected,
    new Promise((_resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('runtime connection survived client cancellation')), 500);
      t.after(() => clearTimeout(timer));
    }),
  ]);
});

test('gateway aborts responses exceeding its output limit', async (t) => {
  const f = await setup(t, (_req, res) => {
    res.setHeader('content-type', 'text/event-stream');
    res.end('x'.repeat(8 * 1024 * 1024 + 1));
  });
  await assert.rejects(async () => {
    const response = await request(f.gateway);
    await response.text();
  });
  assert.equal(f.calls(), 1);
});

test('gateway deadline closes a stalled upstream stream', async (t) => {
  let acknowledgeDisconnect;
  const disconnected = new Promise((resolve) => { acknowledgeDisconnect = resolve; });
  const f = await setup(t, (_req, res) => {
    res.on('close', acknowledgeDisconnect);
    res.write('data: waiting\n\n');
  }, 80);
  const response = await request(f.gateway);
  await assert.rejects(response.text());
  await Promise.race([
    disconnected,
    new Promise((_resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('runtime connection survived deadline')), 1500);
      t.after(() => clearTimeout(timer));
    }),
  ]);
});
