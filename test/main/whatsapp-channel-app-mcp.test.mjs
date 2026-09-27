import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);

test('a channel app session hides the shared credential and checks revocation on every request', async () => {
  const { createChannelAppMcpProxy } = require('../../dist-electron/main/forger-mcp/channel-app-proxy.js');
  const calls = [];
  const upstream = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    calls.push({ authorization: request.headers.authorization, body });
    response.setHeader('Content-Type', 'application/json');
    response.setHeader('Mcp-Session-Id', 'upstream-session');
    response.end(JSON.stringify({ ok: true }));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  let granted = true;
  const proxy = await createChannelAppMcpProxy({ name: 'app', tokenEnvVar: 'APP_TOKEN', token: 'private-upstream-secret', url: `http://127.0.0.1:${upstream.address().port}/mcp` }, async () => granted);
  try {
    assert.notEqual(proxy.config.token, 'private-upstream-secret');
    assert.notEqual(proxy.config.url, `http://127.0.0.1:${upstream.address().port}/mcp`);
    assert.equal((await fetch(proxy.config.url)).status, 401);
    const headers = { Authorization: `Bearer ${proxy.config.token}`, 'Content-Type': 'application/json' };
    const accepted = await fetch(proxy.config.url, { method: 'POST', headers, body: '{"method":"tools/call"}' });
    assert.equal(accepted.status, 200);
    assert.equal(accepted.headers.get('mcp-session-id'), 'upstream-session');
    assert.deepEqual(await accepted.json(), { ok: true });
    granted = false;
    assert.equal((await fetch(proxy.config.url, { method: 'POST', headers, body: '{}' })).status, 403);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].authorization, 'Bearer private-upstream-secret');
  } finally {
    proxy.close();
    upstream.closeAllConnections();
    await new Promise(resolve => upstream.close(resolve));
  }
});

test('proxy rejects unsafe targets, oversize requests, unavailable authority and revocation during a streamed reply', async () => {
  const { createChannelAppMcpProxy } = require('../../dist-electron/main/forger-mcp/channel-app-proxy.js');
  const base = { name: 'app', tokenEnvVar: 'TOKEN', token: 'secret' };
  for (const url of ['https://example.org/mcp', 'http://example.org/mcp']) await assert.rejects(createChannelAppMcpProxy({ ...base, url }, async () => true), /endpoint_invalid/);
  let mode = 'empty';
  let authorized = true;
  let authorityThrows = false;
  let nextChunk;
  const upstream = createServer((_req, res) => {
    if (mode === 'empty') { res.writeHead(204).end(); return; }
    if (mode === 'revoked-empty') { authorized = false; res.writeHead(204).end(); return; }
    if (mode === 'revoked') { authorized = false; res.end('secret result'); return; }
    res.setHeader('Content-Type', 'text/event-stream');
    res.write('first\n');
    nextChunk = () => res.end('must not leave the host');
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const proxy = await createChannelAppMcpProxy({ ...base, url: `http://127.0.0.1:${upstream.address().port}/mcp`, toolTimeoutSec: 2 }, async () => {
    if (authorityThrows) throw new Error('private detail');
    return authorized;
  });
  const headers = { Authorization: `Bearer ${proxy.config.token}` };
  try {
    assert.equal((await fetch(proxy.config.url + '/invalid', { headers })).status, 404);
    assert.equal((await fetch(proxy.config.url, { method: 'PUT', headers })).status, 404);
    assert.equal((await fetch(proxy.config.url, { method: 'POST', headers, body: 'x'.repeat(1024 * 1024 + 1) })).status, 413);
    assert.equal((await fetch(proxy.config.url, { headers })).status, 204);
    authorityThrows = true;
    const failed = await fetch(proxy.config.url, { headers });
    assert.equal(failed.status, 502);
    assert.equal(await failed.text(), '');
    authorityThrows = false;
    for (const nextMode of ['revoked', 'revoked-empty']) {
      mode = nextMode; authorized = true;
      assert.equal((await fetch(proxy.config.url, { headers })).status, 403);
    }
    mode = 'stream'; authorized = true;
    const response = await fetch(proxy.config.url, { headers });
    const reader = response.body.getReader();
    assert.equal(new TextDecoder().decode((await reader.read()).value), 'first\n');
    authorized = false;
    nextChunk();
    await assert.rejects(reader.read());
  } finally {
    proxy.close(); upstream.closeAllConnections();
    await new Promise(resolve => upstream.close(resolve));
  }
});

test('application bindings scope guarded proxies to the run and release every resource after startup failure', async () => {
  const { createPersonalAgentMcpBindings } = require('../../dist-electron/main/core/personal-agent-mcp-bindings.js');
  const released = [];
  let granted = true;
  let fail = false;
  const upstream = createServer((_req, response) => response.end('{}'));
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const config = { name: 'app', tokenEnvVar: 'TOKEN', token: 'secret', url: `http://127.0.0.1:${upstream.address().port}/mcp` };
  const deps = {
    getForgerMcpServer: () => ({ createSession: (_run, _app, input) => input }),
    getRegistry: () => ({ apps: { selected: { installDir: '/selected' }, denied: {}, broken: {} } }),
    getAppMcpManager: () => ({ listenMcps: async ([id]) => fail && id === 'broken' ? [{ ...config, url: 'http://example.org/mcp' }] : [config], releaseMcps: run => released.push(run) }),
    getWhatsAppChannelAgent: async () => granted ? { appIds: ['selected', 'broken'] } : null,
  };
  const context = { channel: {}, channelWorkspaceRoot: '/isolated', conversationId: 'conversation', callStackAgentIds: [] };
  const bindings = createPersonalAgentMcpBindings(deps);
  try {
    assert.equal(bindings.createForgerMcpSession('run', { id: 'agent' }, context).whatsappChannelWorkspaceRoot, '/isolated');
    const [proxy] = await bindings.listenAppMcps(['selected', 'denied'], 'run', context, 'agent');
    assert.notEqual(proxy.token, config.token);
    const headers = { Authorization: `Bearer ${proxy.token}` };
    assert.equal((await fetch(proxy.url, { headers })).status, 200);
    granted = false;
    assert.equal((await fetch(proxy.url, { headers })).status, 403);
    bindings.releaseAppMcps('run');
    assert.deepEqual(released, ['run']);
    granted = true; fail = true;
    await assert.rejects(bindings.listenAppMcps(['selected', 'broken'], 'failure', context, 'agent'), /endpoint_invalid/);
    assert.deepEqual(released, ['run', 'failure']);
    assert.deepEqual(await bindings.listenAppMcps(['selected'], 'missing-agent', context), []);
    const noReader = createPersonalAgentMcpBindings({ ...deps, getWhatsAppChannelAgent: undefined });
    assert.deepEqual(await noReader.listenAppMcps(['selected'], 'no-authority', context, 'agent'), []);
    const noManager = createPersonalAgentMcpBindings({ ...deps, getAppMcpManager: () => null });
    assert.deepEqual(await noManager.listenAppMcps(['selected'], 'no-manager', context, 'agent'), []);
  } finally { bindings.releaseAppMcps('run'); upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); }
});

test('shared file references resolve only through host imported IDs', async () => {
  const { createPersonalAgentMcpBindings } = require('../../dist-electron/main/core/personal-agent-mcp-bindings.js');
  let imported = [{ id: 'safe', name: 'file.txt', absolutePath: '/imported/file.txt' }];
  const lookups = [];
  const deps = { getForgerMcpServer: () => null, getAppMcpManager: () => null, getRegistry: () => ({ apps: {} }) };
  const bindings = createPersonalAgentMcpBindings({ ...deps, getFileLibrary: () => ({ getFilesByIds: async (...args) => { lookups.push(args); return imported; } }) });
  assert.deepEqual(await bindings.resolveWhatsAppSharedFiles([{ id: 'safe', path: '/forged-private-path' }]), imported);
  assert.deepEqual(lookups, [[['safe'], 'attached']]);
  await assert.rejects(bindings.resolveWhatsAppSharedFiles([{ path: 'missing-id' }]), /unavailable/);
  imported = [];
  await assert.rejects(bindings.resolveWhatsAppSharedFiles([{ id: 'missing' }]), /unavailable/);
  await assert.rejects(createPersonalAgentMcpBindings(deps).resolveWhatsAppSharedFiles([{ id: 'safe' }]), /unavailable/);
});
