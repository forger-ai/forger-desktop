import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import Module, { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);

class FakeWebSocket extends EventEmitter {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;
  static instances = [];

  constructor(url, options) {
    super();
    this.url = url;
    this.options = options;
    this.readyState = FakeWebSocket.CONNECTING;
    this.sent = [];
    this.closed = 0;
    FakeWebSocket.instances.push(this);
  }

  close() {
    this.closed += 1;
    this.readyState = FakeWebSocket.CLOSED;
  }

  send(value) {
    this.sent.push(value);
  }
}

class FakeWebSocketServer {
  constructor(options) {
    this.options = options;
  }

  close(callback) {
    callback();
  }

  handleUpgrade(_request, _socket, _head, callback) {
    callback(new FakeWebSocket('remote', {}));
  }
}

const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === 'ws') return { WebSocket: FakeWebSocket, WebSocketServer: FakeWebSocketServer };
  if (request.endsWith('remote-frontend-packager')) {
    return { buildRemoteFrontend: async () => ({ assets: [], hash: '' }) };
  }
  if (request.endsWith('remote-tunnel-provider')) {
    return {
      listenLocal: async () => 4321,
      LocalTunnelProvider: class {},
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const remoteModulePath = require.resolve('../../dist-electron/main/remote-network-share-manager.js');
delete require.cache[remoteModulePath];
const { RemoteNetworkShareManager } = require(remoteModulePath);
Module._load = originalLoad;

const managerFixture = (overrides = {}) => {
  const runningApps = new Map();
  const logs = [];
  const statuses = [];
  const reports = [];
  const client = {
    closeRemoteTunnelSession: async () => undefined,
    createRemoteTunnelSession: async () => ({ id: 7, session_id: 'session', handshake_url: 'https://example.test/handshake' }),
    reportRemoteTunnelSession: async (payload) => reports.push(payload),
    uploadRemoteTunnelFrontend: async () => ({ frontend_url: '/frontend', portal_url: '/portal' }),
  };
  const options = {
    appendInstallLog: async (event, payload) => logs.push({ event, payload }),
    backendBaseUrl: 'https://cloud.test',
    backendClient: () => client,
    emitRuntimeStatus: (_appId, status) => statuses.push(status),
    ensureRuntimeInstalled: async () => ({ node: process.execPath, npm: process.execPath, rootDir: path.dirname(process.execPath) }),
    getCurrentDeviceId: async () => 1,
    installDirForApp: () => path.join(os.tmpdir(), 'app'),
    normalizeNodeRuntimeVersion: () => '22.0.0',
    openInstalledApp: async () => ({ success: true, userMessage: 'opened' }),
    requiredNodeVersionForApp: () => undefined,
    resolveInstalledManifest: async () => ({ remoteTunnel: true, services: [] }),
    runningApps,
    tunnelProvider: { open: async () => ({ close: async () => undefined, url: 'http://127.0.0.1:4321' }) },
    ...overrides,
  };
  return { client, logs, manager: new RemoteNetworkShareManager(options), options, reports, runningApps, statuses };
};

const shareState = (overrides = {}) => ({
  appId: 'app',
  connectionKeyIds: new Set(),
  crypto: {},
  remoteSockets: new Set(),
  seenNonces: new Set(),
  server: { close: (callback) => callback() },
  sessionId: 'session',
  sessionRowId: 7,
  status: { active: true, appId: 'app', connectionCount: 0, connections: [], state: 'waiting_for_session' },
  tunnel: { close: async () => undefined },
  websocketServer: new FakeWebSocketServer({}),
  ...overrides,
});

test('RemoteNetworkShareManager refuses websocket upgrades when the app stopped after sharing', async () => {
  const { manager } = managerFixture();
  manager.shares.set('app', shareState());
  const socket = { destroyed: 0, output: '', destroy() { this.destroyed += 1; }, write(value) { this.output += value; } };
  await manager.handleRealtimeUpgrade('app', {}, new FakeWebSocketServer({}), { url: undefined }, socket, Buffer.alloc(0));
  assert.match(socket.output, /404 Not Found/);
  socket.output = '';
  await manager.handleRealtimeUpgrade('app', {}, new FakeWebSocketServer({}), { url: '/__forger_remote_ws' }, socket, Buffer.alloc(0));
  assert.match(socket.output, /503 Service Unavailable/);
  assert.equal(socket.destroyed, 2);
});

test('RemoteNetworkShareManager queues, forwards, rejects replay, and closes realtime peers deterministically', async () => {
  FakeWebSocket.instances.length = 0;
  const { manager, logs } = managerFixture();
  const state = shareState();
  const remote = new FakeWebSocket('remote', {});
  remote.readyState = FakeWebSocket.OPEN;
  state.remoteSockets.add(remote);
  const crypto = {
    decrypt: (envelope) => envelope.payload,
    encryptForKey: (_sessionId, keyId, payload) => ({ keyId, payload }),
  };
  manager.attachRealtimeSocket(state, 'https://backend.test', crypto, remote);
  const backend = FakeWebSocket.instances.at(-1);
  assert.equal(backend.url, 'wss://backend.test/api/realtime/ws');

  backend.emit('message', Buffer.from('{}'));
  remote.emit('message', Buffer.from(JSON.stringify({ keyId: 'key-1', nonce: 'nonce-1', payload: { queued: true }, sessionId: 'session' })));
  assert.deepEqual(backend.sent, []);
  backend.readyState = FakeWebSocket.OPEN;
  backend.emit('open');
  assert.deepEqual(backend.sent, [JSON.stringify({ queued: true })]);

  remote.emit('message', Buffer.from(JSON.stringify({ keyId: 'key-1', nonce: 'nonce-2', payload: { direct: true }, sessionId: 'session' })));
  assert.equal(backend.sent.at(-1), JSON.stringify({ direct: true }));
  backend.emit('message', Buffer.from(JSON.stringify({ response: true })));
  assert.deepEqual(JSON.parse(remote.sent.at(-1)), { keyId: 'key-1', payload: { response: true } });

  backend.emit('message', Buffer.from('{bad json'));
  assert.ok(logs.some(({ event }) => event === 'remote_network_share:ws_backend_failed'));
  assert.equal(remote.closed, 1);

  remote.readyState = FakeWebSocket.OPEN;
  backend.readyState = FakeWebSocket.OPEN;
  remote.emit('message', Buffer.from(JSON.stringify({ keyId: 'key-1', nonce: 'nonce-2', payload: {}, sessionId: 'session' })));
  assert.ok(logs.some(({ event, payload }) => event === 'remote_network_share:ws_failed' && payload.error === 'remote_ws_replay'));
  backend.emit('error', 'network down');
  assert.ok(logs.some(({ event, payload }) => event === 'remote_network_share:ws_backend_error' && payload.error === 'remote_ws_backend_error'));
  backend.emit('error', new Error('socket error'));
  assert.ok(logs.some(({ event, payload }) => event === 'remote_network_share:ws_backend_error' && payload.error === 'socket error'));

  const stringRemote = new FakeWebSocket('string-remote', {});
  stringRemote.readyState = FakeWebSocket.OPEN;
  manager.attachRealtimeSocket(shareState(), 'http://backend.test', {
    decrypt: (envelope) => envelope.payload,
    encryptForKey: () => { throw 'encrypt denied'; },
  }, stringRemote);
  const stringBackend = FakeWebSocket.instances.at(-1);
  stringRemote.emit('message', Buffer.from(JSON.stringify({ keyId: 'string-key', nonce: 'string-nonce', payload: {}, sessionId: 'session' })));
  stringBackend.emit('message', Buffer.from('{}'));
  assert.ok(logs.some(({ event, payload }) => event === 'remote_network_share:ws_backend_failed' && payload.error === 'remote_ws_backend_failed'));
});

test('RemoteNetworkShareManager rejects frames when the backend cannot accept them', () => {
  FakeWebSocket.instances.length = 0;
  const { manager, logs } = managerFixture();
  const state = shareState();
  const remote = new FakeWebSocket('remote', {});
  remote.readyState = FakeWebSocket.CLOSED;
  manager.attachRealtimeSocket(state, 'http://backend.test', { decrypt: (value) => value.payload }, remote);
  const backend = FakeWebSocket.instances.at(-1);
  backend.readyState = FakeWebSocket.CLOSED;
  remote.emit('message', Buffer.from(JSON.stringify({ keyId: 'key', nonce: 'nonce', payload: {}, sessionId: 'session' })));
  assert.ok(logs.some(({ payload }) => payload.error === 'remote_ws_backend_not_connected'));
  const secondRemote = new FakeWebSocket('remote-2', {});
  const secondState = shareState();
  manager.attachRealtimeSocket(secondState, 'http://backend.test', { decrypt: () => { throw 'decrypt denied'; } }, secondRemote);
  secondRemote.emit('message', Buffer.from(JSON.stringify({ keyId: 'key-2', nonce: 'nonce-2', payload: {}, sessionId: 'session' })));
  assert.ok(logs.some(({ payload }) => payload.error === 'remote_ws_failed'));
  backend.emit('close');
});

test('RemoteNetworkShareManager closes every tracked remote socket and reports through optional cloud state', async () => {
  const closed = [];
  const socketA = { close: () => closed.push('a') };
  const socketB = { close: () => closed.push('b') };
  const state = shareState({ remoteSockets: new Set([socketA, socketB]) });
  const { manager } = managerFixture({ backendClient: () => null, onStatusChanged: undefined });
  manager.shares.set('app', state);
  const result = await manager.stop('app');
  assert.equal(result.status.state, 'closed');
  assert.deepEqual(closed, ['a', 'b']);

  const changed = [];
  const callbackContext = managerFixture({ onStatusChanged: (status) => changed.push(status) });
  callbackContext.manager.shares.set('app', shareState());
  await callbackContext.manager.stop('app');
  assert.equal(changed.at(-1).state, 'closed');
});

test('RemoteNetworkShareManager sanitizes invalid URLs and short session identifiers in startup telemetry', async () => {
  const created = {
    frontend_url: 'http://[',
    handshake_url: 'http://[',
    id: 7,
    portal_url: '',
    session_id: 'abc',
  };
  const context = managerFixture({
    backendBaseUrl: 'http://[',
    backendClient: () => ({
      closeRemoteTunnelSession: async () => undefined,
      createRemoteTunnelSession: async () => created,
      reportRemoteTunnelSession: async () => undefined,
      uploadRemoteTunnelFrontend: async () => ({ frontend_url: 'http://[', portal_url: '' }),
    }),
  });
  context.runningApps.set('app', { backendUrl: 'http://127.0.0.1:1' });
  const result = await context.manager.start('app');
  assert.equal(result.success, true);
  assert.ok(context.logs.some(({ payload }) => payload?.sessionIdPrefix === 'ab...'));
  assert.ok(context.logs.some(({ payload }) => payload?.handshakeUrl?.shape === 'invalid'));
  context.manager.shares.clear();
});

test('RemoteNetworkShareManager covers provider, callback, frontend, and startup error fallbacks', async () => {
  const base = managerFixture({ onStatusChanged: () => undefined });
  delete base.options.tunnelProvider;
  const defaultProviderManager = new RemoteNetworkShareManager(base.options);
  assert.equal(defaultProviderManager.status('app').state, 'inactive');

  const openFallback = managerFixture({ openInstalledApp: async () => ({ success: false, userMessage: 'no' }) });
  assert.equal((await openFallback.manager.start('app')).technicalCode, 'remote_tunnel_open_failed');

  const thrown = managerFixture({
    backendClient: () => ({ createRemoteTunnelSession: async () => { throw 'create failed'; } }),
    onStatusChanged: (status) => thrown.statuses.push(status),
  });
  thrown.runningApps.set('app', { backendUrl: 'http://127.0.0.1:1' });
  assert.equal((await thrown.manager.start('app')).technicalCode, 'remote_tunnel_start_failed');

  const createdFallback = managerFixture({
    backendClient: () => ({
      closeRemoteTunnelSession: async () => undefined,
      createRemoteTunnelSession: async () => ({
        frontend_url: '/created', handshake_url: 'forger://relative', id: 8, portal_url: '/created-portal', session_id: '--',
      }),
      reportRemoteTunnelSession: async () => undefined,
      uploadRemoteTunnelFrontend: async () => ({}),
    }),
    onStatusChanged: () => undefined,
  });
  createdFallback.runningApps.set('app', { backendUrl: 'http://127.0.0.1:1' });
  const createdResult = await createdFallback.manager.start('app');
  assert.equal(createdResult.status.frontendUrl, '/created');
  assert.equal(createdResult.status.portalUrl, '/created-portal');
  assert.ok(createdFallback.logs.some(({ payload }) => payload?.handshakeUrl?.path === '/'));
  createdFallback.manager.shares.clear();

  const emptyFallback = managerFixture({
    backendClient: () => ({
      closeRemoteTunnelSession: async () => undefined,
      createRemoteTunnelSession: async () => ({ handshake_url: 'relative', id: 9, session_id: 'short' }),
      reportRemoteTunnelSession: async () => undefined,
      uploadRemoteTunnelFrontend: async () => ({}),
    }),
  });
  emptyFallback.runningApps.set('app', { backendUrl: 'http://127.0.0.1:1' });
  const emptyResult = await emptyFallback.manager.start('app');
  assert.equal(emptyResult.status.frontendUrl, '');
  assert.equal(emptyResult.status.portalUrl, '');
  emptyFallback.manager.shares.clear();

  const noInstallDir = managerFixture({ installDirForApp: () => undefined });
  assert.equal(noInstallDir.manager.frontendDir('app', { services: [{ name: 'frontend', context: './web' }] }), path.resolve('web'));
});

test('RemoteNetworkShareManager applies CORS defaults and records non-Error RPC failures safely', async (t) => {
  const { manager, logs, runningApps } = managerFixture();
  const state = shareState();
  manager.shares.set('app', state);
  runningApps.set('app', { backendUrl: 'http://backend.test' });
  const request = new EventEmitter();
  request.headers = { origin: '' };
  request.method = 'POST';
  request.url = '/__forger_remote_rpc';
  request.destroy = () => undefined;
  const response = { body: '', headers: {}, setHeader(key, value) { this.headers[key] = value; }, end(value = '') { this.body += value; } };
  const crypto = { decrypt: () => { throw 'decrypt failed'; } };
  const handling = manager.handleRpc('app', crypto, request, response);
  request.emit('data', JSON.stringify({ nonce: 'n' }));
  request.emit('end');
  await handling;
  assert.equal(response.headers['access-control-allow-origin'], '*');
  assert.equal(response.body, 'remote_rpc_failed');
  assert.ok(logs.some(({ payload }) => payload.technicalCode === 'remote_rpc_failed'));

  const missingRequest = new EventEmitter();
  Object.assign(missingRequest, { headers: {}, method: 'GET', url: undefined });
  const missingResponse = { body: '', setHeader: () => undefined, end(value = '') { this.body += value; } };
  await manager.handleRpc('missing', {}, missingRequest, missingResponse);
  assert.equal(missingResponse.body, 'not_found');

  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    assert.equal(init.body, undefined);
    assert.equal(init.headers.accept, 'application/json');
    assert.equal(Object.hasOwn(init.headers, 'content-type'), false);
    return new Response('ok', { headers: { 'cache-control': 'private', ignored: 'x' }, status: 201 });
  };
  t.after(() => { globalThis.fetch = previousFetch; });
  const request2 = new EventEmitter();
  Object.assign(request2, { headers: {}, method: 'POST', url: '/__forger_remote_rpc', destroy: () => undefined });
  const response2 = { body: '', headers: {}, setHeader(key, value) { this.headers[key] = value; }, end(value = '') { this.body += value; } };
  const crypto2 = { decrypt: () => ({ bodyBase64: null, headers: {}, method: 'GET', path: '/items' }), encrypt: (_sessionId, value) => value };
  const handling2 = manager.handleRpc('app', crypto2, request2, response2);
  request2.emit('data', JSON.stringify({ keyId: 'key', nonce: 'n2' }));
  request2.emit('end');
  await handling2;
  assert.equal(JSON.parse(response2.body).status, 201);
});
