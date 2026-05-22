import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import test from 'node:test';

const { LocalNetworkShareManager } = await import('../../dist-electron/main/local-network-share-manager.js');

const listenLocal = async (server) =>
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address !== 'object') {
        reject(new Error('test_port_unavailable'));
        return;
      }
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });

test('LocalNetworkShareManager protects LAN proxy with one-time token and revocable session', async (t) => {
  const upstream = http.createServer((request, response) => {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    if (request.url?.startsWith('/__forger_api')) {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    if (request.url?.startsWith('/asset.bin')) {
      response.setHeader('content-type', 'application/octet-stream');
      response.end(Buffer.from([1, 2, 3]));
      return;
    }
    if (request.method === 'POST') {
      const chunks = [];
      request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      request.on('end', () => {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({
          method: request.method,
          body: Buffer.concat(chunks).toString('utf8'),
          contentType: request.headers['content-type'],
          forwardedSecret: request.headers['x-secret'] ?? null,
        }));
      });
      return;
    }
    response.end('<html><script src="http://127.0.0.1/assets/app.js"></script></html>');
  });
  const upstreamUrl = await listenLocal(upstream);
  t.after(() => new Promise((resolve) => upstream.close(resolve)));

  const runningApps = new Map([
    ['finance-os', { appId: 'finance-os', frontendUrl: upstreamUrl }],
  ]);
  const events = [];
  const connectedStatuses = [];
  const manager = new LocalNetworkShareManager({
    runningApps,
    openInstalledApp: async () => ({ success: true, userMessage: 'opened' }),
    appendInstallLog: async (event, payload) => events.push([event, payload]),
    onConnected: (status) => connectedStatuses.push(status),
  });
  t.after(() => manager.stopAll());

  const started = await manager.start('finance-os');
  assert.equal(started.success, true);
  assert.equal(started.status.active, true);
  assert.ok(started.status.connectUrl);
  const alreadyStarted = await manager.start('finance-os');
  assert.equal(alreadyStarted.success, true);
  assert.equal(alreadyStarted.status.connectUrl, started.status.connectUrl);

  const connectPath = new URL(started.status.connectUrl).pathname;
  const localPort = new URL(started.status.url).port;
  const localBaseUrl = `http://127.0.0.1:${localPort}`;
  const unauthenticated = await fetch(`${localBaseUrl}/`);
  assert.equal(unauthenticated.status, 401);
  const wrongCookie = await fetch(`${localBaseUrl}/`, { headers: { cookie: 'other=value' } });
  assert.equal(wrongCookie.status, 401);

  const connected = await fetch(`${localBaseUrl}${connectPath}`, { redirect: 'manual' });
  assert.equal(connected.status, 200);
  assert.match(await connected.text(), /Te conectaste exitosamente/);
  const cookie = connected.headers.get('set-cookie');
  assert.match(cookie ?? '', /forger_lan_share=/);
  assert.equal(manager.status('finance-os').connectUrl, undefined);
  assert.ok(manager.status('finance-os').connectedAt);
  assert.equal(connectedStatuses.length, 1);
  assert.equal(connectedStatuses[0].appId, 'finance-os');
  assert.ok(connectedStatuses[0].connectedAt);

  const reusedToken = await fetch(`${localBaseUrl}${connectPath}`, { redirect: 'manual' });
  assert.equal(reusedToken.status, 502);

  const homepage = await fetch(`${localBaseUrl}/`, { headers: { cookie } });
  assert.equal(homepage.status, 200);
  assert.match(await homepage.text(), new RegExp(started.status.url.replaceAll('.', '\\.')));

  const api = await fetch(`${localBaseUrl}/__forger_api/health`, { headers: { cookie } });
  assert.equal(api.status, 200);
  assert.deepEqual(await api.json(), { ok: true });

  const binary = await fetch(`${localBaseUrl}/asset.bin`, { headers: { cookie } });
  assert.equal(binary.status, 200);
  assert.deepEqual([...new Uint8Array(await binary.arrayBuffer())], [1, 2, 3]);

  const post = await fetch(`${localBaseUrl}/echo`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'text/plain', 'x-secret': 'blocked' },
    body: 'hello',
  });
  assert.equal(post.status, 200);
  assert.deepEqual(await post.json(), {
    method: 'POST',
    body: 'hello',
    contentType: 'text/plain',
    forwardedSecret: null,
  });

  const blockedDotGit = await fetch(`${localBaseUrl}/.git/config`, { headers: { cookie } });
  assert.equal(blockedDotGit.status, 403);

  const blockedFileScheme = await fetch(`${localBaseUrl}/file:/etc/passwd`, { headers: { cookie } });
  assert.equal(blockedFileScheme.status, 403);

  const blockedMalformedPath = await fetch(`${localBaseUrl}/%E0%A4%A`, { headers: { cookie } });
  assert.equal(blockedMalformedPath.status, 403);

  await assert.rejects(
    fetch(`${localBaseUrl}/too-large`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'text/plain' },
      body: Buffer.alloc((64 * 1024 * 1024) + 1, 'x'),
    }),
    /fetch failed/,
  );

  runningApps.delete('finance-os');
  const originalStop = manager.stop.bind(manager);
  manager.stop = async () => {
    throw new Error('stop boom');
  };
  const missingRunningApp = await fetch(`${localBaseUrl}/`, { headers: { cookie } });
  assert.equal(missingRunningApp.status, 424);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(manager.status('finance-os').active, true);
  assert.equal(events.some(([event]) => event === 'local_network_share:stop_failed'), true);
  manager.stop = originalStop;

  const stopped = await manager.stop('finance-os');
  assert.equal(stopped.success, true);
  assert.equal(stopped.status.active, false);
  await assert.rejects(fetch(`${localBaseUrl}/`, { headers: { cookie } }));
  assert.equal(events[0][0], 'local_network_share:started');
  assert.equal(events.some(([event]) => event === 'local_network_share:connected'), true);
  assert.equal(events.some(([event]) => event === 'local_network_share:error'), true);
});

test('LocalNetworkShareManager reports startup failures without opening a LAN proxy', async () => {
  const openFailure = new LocalNetworkShareManager({
    runningApps: new Map(),
    openInstalledApp: async () => ({ success: false, userMessage: 'nope', technicalCode: 'open_failed' }),
    appendInstallLog: async () => undefined,
  });
  assert.deepEqual(await openFailure.start('finance-os'), {
    success: false,
    userMessage: 'nope',
    technicalCode: 'open_failed',
    status: { active: false, appId: 'finance-os' },
  });

  const notRunning = new LocalNetworkShareManager({
    runningApps: new Map(),
    openInstalledApp: async () => ({ success: true, userMessage: 'opened' }),
    appendInstallLog: async () => undefined,
  });
  const result = await notRunning.start('finance-os');
  assert.equal(result.success, false);
  assert.equal(result.technicalCode, 'app_not_running');
  assert.deepEqual(notRunning.status('finance-os'), { active: false, appId: 'finance-os' });
  assert.deepEqual((await notRunning.stop('finance-os')).status, { active: false, appId: 'finance-os' });
  await notRunning.stopAll();
});

test('LocalNetworkShareManager stops an active share explicitly', async (t) => {
  const upstream = http.createServer((_request, response) => {
    response.end('ok');
  });
  const upstreamUrl = await listenLocal(upstream);
  t.after(() => new Promise((resolve) => upstream.close(resolve)));

  const events = [];
  const manager = new LocalNetworkShareManager({
    runningApps: new Map([['finance-os', { appId: 'finance-os', frontendUrl: upstreamUrl }]]),
    openInstalledApp: async () => ({ success: true, userMessage: 'opened' }),
    appendInstallLog: async (event, payload) => events.push([event, payload]),
  });
  t.after(() => manager.stopAll());

  const started = await manager.start('finance-os');
  assert.equal(started.status.active, true);
  const stopped = await manager.stop('finance-os');
  assert.equal(stopped.status.active, false);
  assert.equal(events.at(-1)[0], 'local_network_share:stopped');
});

test('LocalNetworkShareManager falls back to localhost when no LAN interface exists', async (t) => {
  const originalNetworkInterfaces = os.networkInterfaces;
  os.networkInterfaces = () => ({});
  t.after(() => {
    os.networkInterfaces = originalNetworkInterfaces;
  });

  const upstream = http.createServer((_request, response) => {
    response.end('ok');
  });
  const upstreamUrl = await listenLocal(upstream);
  t.after(() => new Promise((resolve) => upstream.close(resolve)));

  const manager = new LocalNetworkShareManager({
    runningApps: new Map([['finance-os', { appId: 'finance-os', frontendUrl: upstreamUrl }]]),
    openInstalledApp: async () => ({ success: true, userMessage: 'opened' }),
    appendInstallLog: async () => undefined,
  });
  t.after(() => manager.stopAll());

  const started = await manager.start('finance-os');
  assert.match(started.status.url, /^http:\/\/127\.0\.0\.1:/);
});
