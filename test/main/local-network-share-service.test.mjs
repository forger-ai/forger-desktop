import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

const { createLocalNetworkShareController } = await import('../../dist-electron/main/core/local-network-share-service.js');

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

test('local network share controller creates the manager lazily and emits share status', async (t) => {
  const upstream = http.createServer((_request, response) => {
    response.end('ok');
  });
  const upstreamUrl = await listenLocal(upstream);
  t.after(() => new Promise((resolve) => upstream.close(resolve)));

  const emitted = [];
  const logs = [];
  const runningApps = new Map([
    ['finance-os', { appId: 'finance-os', frontendUrl: upstreamUrl }],
  ]);
  const controller = createLocalNetworkShareController({
    runningApps,
    openInstalledApp: async (appId, locale, options) => {
      assert.equal(appId, 'finance-os');
      assert.equal(locale, undefined);
      assert.deepEqual(options, { openWindow: false });
      return { success: true, userMessage: 'opened' };
    },
    appendInstallLog: async (event, payload) => logs.push([event, payload]),
    getRuntimeStatus: (appId) => ({ appId, status: 'running', frontendUrl: upstreamUrl }),
    emitRuntimeStatus: (status) => emitted.push(status),
  });
  t.after(() => controller.manager?.stopAll());

  assert.deepEqual(controller.getStatus('finance-os'), { active: false, appId: 'finance-os' });
  assert.equal(controller.manager, null);

  const started = await controller.start('finance-os');
  assert.equal(started.success, true);
  assert.equal(started.status.active, true);
  assert.equal(controller.manager?.constructor.name, 'LocalNetworkShareManager');
  assert.equal(logs[0][0], 'local_network_share:started');
  assert.equal(emitted.at(-1).appId, 'finance-os');
  assert.equal(emitted.at(-1).localNetworkShare.active, true);

  const connectPath = new URL(started.status.connectUrl).pathname;
  const localPort = new URL(started.status.url).port;
  const connected = await fetch(`http://127.0.0.1:${localPort}${connectPath}`);
  assert.equal(connected.status, 200);
  assert.ok(emitted.at(-1).localNetworkShare.connectedAt);

  const stopped = await controller.stop('finance-os');
  assert.equal(stopped.success, true);
  assert.deepEqual(stopped.status, { active: false, appId: 'finance-os' });
  assert.deepEqual(emitted.at(-1).localNetworkShare, { active: false, appId: 'finance-os' });
});

test('local network share controller supports lifecycle manager injection', async () => {
  const emitted = [];
  const fakeManager = {
    status: (appId) => ({ active: true, appId, url: 'http://127.0.0.1:1' }),
    start: async (appId) => ({
      success: true,
      userMessage: 'started',
      status: { active: true, appId, url: 'http://127.0.0.1:1' },
    }),
    stop: async (appId) => ({
      success: true,
      userMessage: 'stopped',
      status: { active: false, appId },
    }),
  };
  const controller = createLocalNetworkShareController({
    runningApps: new Map(),
    openInstalledApp: async () => ({ success: true, userMessage: 'opened' }),
    appendInstallLog: async () => undefined,
    getRuntimeStatus: (appId) => ({ appId, status: 'running' }),
    emitRuntimeStatus: (status) => emitted.push(status),
  });

  controller.manager = fakeManager;

  assert.equal(controller.manager, fakeManager);
  assert.deepEqual(controller.getStatus('finance-os'), {
    active: true,
    appId: 'finance-os',
    url: 'http://127.0.0.1:1',
  });

  const started = await controller.start('finance-os');
  assert.equal(started.userMessage, 'started');
  assert.deepEqual(emitted.at(-1).localNetworkShare, {
    active: true,
    appId: 'finance-os',
    url: 'http://127.0.0.1:1',
  });

  const stopped = await controller.stop('finance-os');
  assert.equal(stopped.userMessage, 'stopped');
  assert.deepEqual(emitted.at(-1).localNetworkShare, { active: false, appId: 'finance-os' });
});
