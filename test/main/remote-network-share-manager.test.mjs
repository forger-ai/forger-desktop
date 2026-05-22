import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, createECDH, createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import Module from 'node:module';
import { EventEmitter } from 'node:events';

import { clearDistModule } from './electron-test-helpers.mjs';

const require = createRequire(import.meta.url);

const aad = (sessionId, keyId, timestamp) => Buffer.from(`${sessionId}\n${keyId}\n${timestamp}`, 'utf8');
const base64urlDecode = (value) => {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  return Buffer.from(padded, 'base64');
};
const jwkToPublicKey = (jwk) => Buffer.concat([Buffer.from([4]), base64urlDecode(jwk.x), base64urlDecode(jwk.y)]);
const publicKeyToJwk = (key) => ({
  kty: 'EC',
  crv: 'P-256',
  x: key.subarray(1, 33).toString('base64url'),
  y: key.subarray(33, 65).toString('base64url'),
  ext: true,
});

const makeBrowserCrypto = (desktopPublicKeyJwk) => {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const secret = ecdh.computeSecret(jwkToPublicKey(desktopPublicKeyJwk));
  const key = createHash('sha256').update(secret).digest();
  const browserPublicKeyJwk = publicKeyToJwk(ecdh.getPublicKey());
  const keyId = createHash('sha256').update(JSON.stringify(browserPublicKeyJwk)).digest('hex');
  return {
    browserPublicKeyJwk,
    keyId,
    encrypt(sessionId, payload) {
      const nonce = randomBytes(12);
      const timestamp = new Date().toISOString();
      const cipher = createCipheriv('aes-256-gcm', key, nonce);
      cipher.setAAD(aad(sessionId, keyId, timestamp));
      const encrypted = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
      return {
        sessionId,
        keyId,
        nonce: nonce.toString('base64'),
        timestamp,
        browserPublicKeyJwk,
        ciphertext: Buffer.concat([encrypted, cipher.getAuthTag()]).toString('base64'),
      };
    },
    decrypt(envelope) {
      const ciphertext = Buffer.from(envelope.ciphertext, 'base64');
      const tag = ciphertext.subarray(ciphertext.length - 16);
      const encrypted = ciphertext.subarray(0, ciphertext.length - 16);
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.nonce, 'base64'));
      decipher.setAAD(aad(envelope.sessionId, envelope.keyId, envelope.timestamp));
      decipher.setAuthTag(tag);
      return JSON.parse(Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8'));
    },
  };
};

const requestText = (url, options = {}, body = '') => new Promise((resolve, reject) => {
  const request = http.request(url, options, (response) => {
    const chunks = [];
    response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    response.on('end', () => resolve({
      status: response.statusCode,
      headers: response.headers,
      body: Buffer.concat(chunks).toString('utf8'),
    }));
  });
  request.on('error', reject);
  request.end(body);
});

const withMockedPackager = (buildRemoteFrontend, callback) => {
  const modulePath = clearDistModule('main/remote-frontend-packager.js');
  const previous = require.cache[modulePath];
  require.cache[modulePath] = {
    id: modulePath,
    filename: modulePath,
    loaded: true,
    exports: { buildRemoteFrontend },
  };
  try {
    clearDistModule('main/remote-network-share-manager.js');
    return callback(require('../../dist-electron/main/remote-network-share-manager.js'));
  } finally {
    if (previous) {
      require.cache[modulePath] = previous;
    } else {
      delete require.cache[modulePath];
    }
    clearDistModule('main/remote-network-share-manager.js');
  }
};

const withMockedPackagerAndProvider = (buildRemoteFrontend, providerExports, callback) => {
  const packagerPath = clearDistModule('main/remote-frontend-packager.js');
  const providerPath = clearDistModule('main/remote-tunnel-provider.js');
  const previousPackager = require.cache[packagerPath];
  const previousProvider = require.cache[providerPath];
  require.cache[packagerPath] = {
    id: packagerPath,
    filename: packagerPath,
    loaded: true,
    exports: { buildRemoteFrontend },
  };
  require.cache[providerPath] = {
    id: providerPath,
    filename: providerPath,
    loaded: true,
    exports: providerExports,
  };
  try {
    clearDistModule('main/remote-network-share-manager.js');
    return callback(require('../../dist-electron/main/remote-network-share-manager.js'));
  } finally {
    if (previousPackager) {
      require.cache[packagerPath] = previousPackager;
    } else {
      delete require.cache[packagerPath];
    }
    if (previousProvider) {
      require.cache[providerPath] = previousProvider;
    } else {
      delete require.cache[providerPath];
    }
    clearDistModule('main/remote-network-share-manager.js');
  }
};

const createBackendServer = async () => {
  const calls = [];
  const server = http.createServer((request, response) => {
    calls.push({ method: request.method, url: request.url, headers: request.headers });
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ ok: true, url: request.url, remote: request.headers['x-forger-remote-tunnel'] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return {
    calls,
    backendUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
};

const createManagerOptions = (overrides = {}) => {
  const logs = [];
  const statuses = [];
  const uploads = [];
  const reports = [];
  const closes = [];
  const runningApps = new Map();
  const client = {
    createRemoteTunnelSession: async () => ({
      id: 7,
      session_id: 'Session_ABC123',
      handshake_url: 'https://platform.test/remote-assets/Session_ABC123/handshake',
      portal_url: '/portal/tunnels/7',
      frontend_url: '/remote-assets/Session_ABC123/',
    }),
    uploadRemoteTunnelFrontend: async (input) => {
      uploads.push(input);
      return { portal_url: '/portal/tunnels/7', frontend_url: '/remote-assets/Session_ABC123/' };
    },
    reportRemoteTunnelSession: async (input) => {
      reports.push(input);
      return { ok: true };
    },
    closeRemoteTunnelSession: async (sessionId) => {
      closes.push(sessionId);
      return { ok: true };
    },
  };
  return {
    logs,
    statuses,
    uploads,
    reports,
    closes,
    runningApps,
    options: {
      runningApps,
      openInstalledApp: async () => ({ success: true, userMessage: 'ok' }),
      resolveInstalledManifest: async () => ({ remoteTunnel: true, services: [{ name: 'frontend', context: './frontend' }] }),
      backendClient: () => client,
      backendBaseUrl: 'https://platform.test',
      installDirForApp: () => '/tmp/app',
      getCurrentDeviceId: async () => 5,
      appendInstallLog: async (event, payload) => logs.push({ event, payload }),
      emitRuntimeStatus: (appId, remoteNetworkShare) => statuses.push({ appId, remoteNetworkShare }),
      ensureRuntimeInstalled: async () => ({ rootDir: '/runtime/node', node: process.execPath, npm: process.execPath }),
      normalizeNodeRuntimeVersion: (value) => value ?? '24',
      requiredNodeVersionForApp: () => '24',
      tunnelProvider: {
        open: async ({ port }) => ({
          url: `http://127.0.0.1:${port}`,
          close: async () => {
            logs.push({ event: 'fake_tunnel_closed' });
          },
        }),
      },
      ...overrides,
    },
  };
};

test('RemoteSessionCrypto exchanges browser keys and rejects invalid envelopes', () => {
  const { RemoteSessionCrypto } = require('../../dist-electron/main/remote-crypto.js');
  const desktop = new RemoteSessionCrypto();
  assert.throws(() => desktop.encrypt('session', {}), /remote_session_key_missing/);
  assert.throws(() => desktop.decrypt({
    sessionId: 'session',
    keyId: 'missing',
    nonce: Buffer.alloc(12).toString('base64'),
    timestamp: new Date().toISOString(),
    ciphertext: Buffer.alloc(17).toString('base64'),
  }), /remote_browser_key_missing/);
  assert.throws(() => desktop.decrypt({
    sessionId: 'session',
    keyId: 'bad',
    nonce: Buffer.alloc(12).toString('base64'),
    timestamp: new Date().toISOString(),
    browserPublicKeyJwk: { kty: 'EC' },
    ciphertext: Buffer.alloc(17).toString('base64'),
  }), /remote_browser_key_invalid/);

  const browser = makeBrowserCrypto(desktop.desktopPublicKeyJwk());
  const decrypted = desktop.decrypt(browser.encrypt('session', { hello: 'desktop' }));
  assert.deepEqual(decrypted, { hello: 'desktop' });
  const encrypted = desktop.encrypt('session', { hello: 'browser' });
  assert.deepEqual(browser.decrypt(encrypted), { hello: 'browser' });
});

test('remote tunnel provider helpers normalize URLs, subdomains, and local ports', async () => {
  const { LocalTunnelProvider, listenLocal, remoteTunnelSubdomain } = require('../../dist-electron/main/remote-tunnel-provider.js');
  assert.equal(remoteTunnelSubdomain('Finance OS Dev!!', 'ABC_123_xyz'), 'forger-finance-os-dev-abc123xyz');
  assert.equal(remoteTunnelSubdomain('!!!', '###'), 'forger-');
  process.env.FORGER_REMOTE_TUNNEL_PUBLIC_URL = 'https://example.loca.lt///';
  try {
    const tunnel = await new LocalTunnelProvider().open({ port: 1234, appId: 'app', sessionId: 'session' });
    assert.equal(tunnel.url, 'https://example.loca.lt');
    await tunnel.close();
  } finally {
    delete process.env.FORGER_REMOTE_TUNNEL_PUBLIC_URL;
  }
  const server = http.createServer((_request, response) => response.end('ok'));
  const port = await listenLocal(server);
  assert.equal(typeof port, 'number');
  await new Promise((resolve) => server.close(resolve));

  const originalFunction = globalThis.Function;
  let closed = false;
  globalThis.Function = () => () => Promise.resolve({
    default: async (input) => ({
      url: `https://${input.subdomain}.loca.lt/`,
      close: () => {
        closed = true;
      },
    }),
  });
  try {
    const tunnel = await new LocalTunnelProvider().open({ port: 42, appId: 'Finance OS', sessionId: 'Session_123' });
    assert.equal(tunnel.url, 'https://forger-finance-os-session123.loca.lt');
    await tunnel.close();
    assert.equal(closed, true);
  } finally {
    globalThis.Function = originalFunction;
  }

  globalThis.Function = () => () => Promise.reject(new Error('missing'));
  try {
    await assert.rejects(
      () => new LocalTunnelProvider().open({ port: 42, appId: 'app', sessionId: 'session' }),
      /localtunnel_dependency_missing/,
    );
  } finally {
    globalThis.Function = originalFunction;
  }

  await assert.rejects(
    () => listenLocal({
      once() {},
      listen(_port, _host, callback) {
        callback();
      },
      address() {
        return 'not-a-port-object';
      },
    }),
    /remote_tunnel_port_unavailable/,
  );
});

test('buildRemoteFrontend runs a build, reads assets, and computes a stable hash', async () => {
  const originalLoad = Module._load;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forger-remote-build-'));
  const failing = await fs.mkdtemp(path.join(os.tmpdir(), 'forger-remote-build-fail-'));
  Module._load = function loadWithSpawnMock(request, parent, isMain) {
    if (request === 'node:child_process') {
      return {
        spawn(command, args, options) {
          assert.equal(command, '/runtime/npm');
          assert.deepEqual(args, ['run', 'build', '--', '--base=./']);
          assert.equal(options.env.VITE_FORGER_REMOTE_TUNNEL, 'true');
          assert.equal(options.env.VITE_FORGER_REMOTE_SESSION_ID, 'session-1');
          assert.equal(options.env.VITE_FORGER_CLOUD_HANDSHAKE_URL, 'https://platform.test/handshake');
          assert.equal(options.env.PATH.startsWith(`${path.dirname('/runtime/node')}${path.delimiter}`), true);
          const child = new EventEmitter();
          child.stderr = new EventEmitter();
          child.kill = () => undefined;
          if (options.cwd === failing) {
            setImmediate(() => {
              child.stderr.emit('data', 'build nope');
              child.emit('close', 7);
            });
          } else {
            setImmediate(async () => {
              await fs.mkdir(path.join(options.cwd, 'dist', 'assets'), { recursive: true });
              await fs.writeFile(path.join(options.cwd, 'dist/index.html'), options.env.VITE_FORGER_REMOTE_SESSION_ID);
              await fs.writeFile(path.join(options.cwd, 'dist/assets/app.js'), options.env.VITE_FORGER_CLOUD_HANDSHAKE_URL);
              await fs.writeFile(path.join(options.cwd, 'dist/assets/style.css'), 'body{}');
              await fs.writeFile(path.join(options.cwd, 'dist/assets/data.json'), '{}');
              await fs.writeFile(path.join(options.cwd, 'dist/assets/icon.png'), '');
              await fs.writeFile(path.join(options.cwd, 'dist/assets/icon.svg'), '<svg />');
              await fs.writeFile(path.join(options.cwd, 'dist/assets/file.bin'), '');
              child.emit('close', 0);
            });
          }
          return child;
        },
      };
    }
    return originalLoad.apply(this, [request, parent, isMain]);
  };
  try {
    clearDistModule('main/remote-frontend-packager.js');
    const { buildRemoteFrontend } = require('../../dist-electron/main/remote-frontend-packager.js');
    const result = await buildRemoteFrontend({
      frontendDir: root,
      sessionId: 'session-1',
      handshakeUrl: 'https://platform.test/handshake',
      nodePath: '/runtime/node',
      npmPath: '/runtime/npm',
    });

    assert.deepEqual(result.assets.map((asset) => [asset.path, asset.type]), [
      ['assets/app.js', 'text/javascript; charset=utf-8'],
      ['assets/data.json', 'application/json'],
      ['assets/file.bin', 'application/octet-stream'],
      ['assets/icon.png', 'image/png'],
      ['assets/icon.svg', 'image/svg+xml'],
      ['assets/style.css', 'text/css; charset=utf-8'],
      ['index.html', 'text/html; charset=utf-8'],
    ]);
    assert.match(result.hash, /^[a-f0-9]{64}$/);

    await assert.rejects(
      () => buildRemoteFrontend({ frontendDir: failing, sessionId: 'session-1', handshakeUrl: 'https://platform.test/handshake', nodePath: '/runtime/node', npmPath: '/runtime/npm' }),
      /remote_frontend_build_failed_7: build nope/,
    );
  } finally {
    Module._load = originalLoad;
    clearDistModule('main/remote-frontend-packager.js');
  }
});

test('buildRemoteFrontend times out long-running builds and ignores late child close events', async () => {
  const originalLoad = Module._load;
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  let killedSignal;
  Module._load = function loadWithSpawnMock(request, parent, isMain) {
    if (request === 'node:child_process') {
      return {
        spawn(command, args, options) {
          assert.equal(command, '/runtime/npm');
          assert.equal(options.env.PATH.startsWith(`${path.dirname('/runtime/node')}${path.delimiter}`), true);
          const child = new EventEmitter();
          child.stderr = new EventEmitter();
          child.kill = (signal) => {
            killedSignal = signal;
            child.emit('close', 1);
          };
          return child;
        },
      };
    }
    return originalLoad.apply(this, [request, parent, isMain]);
  };
  globalThis.setTimeout = (callback) => originalSetTimeout(callback, 0);
  globalThis.clearTimeout = (timer) => originalClearTimeout(timer);
  try {
    clearDistModule('main/remote-frontend-packager.js');
    const { buildRemoteFrontend } = require('../../dist-electron/main/remote-frontend-packager.js');
    await assert.rejects(
      () => buildRemoteFrontend({ frontendDir: '/tmp/missing', sessionId: 'session-1', handshakeUrl: 'https://platform.test', nodePath: '/runtime/node', npmPath: '/runtime/npm' }),
      /remote_frontend_build_timeout_180000ms/,
    );
    assert.equal(killedSignal, 'SIGTERM');
  } finally {
    Module._load = originalLoad;
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
    clearDistModule('main/remote-frontend-packager.js');
  }
});

test('buildRemoteFrontend ignores timeout callbacks after successful builds', async () => {
  const originalLoad = Module._load;
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  let timeoutCallback;
  Module._load = function loadWithSpawnMock(request, parent, isMain) {
    if (request === 'node:child_process') {
      return {
        spawn(command, args, options) {
          assert.equal(command, '/runtime/npm');
          assert.equal(options.env.PATH.startsWith(`${path.dirname('/runtime/node')}${path.delimiter}`), true);
          const child = new EventEmitter();
          child.stderr = new EventEmitter();
          child.kill = () => undefined;
          originalSetTimeout(() => child.emit('close', 0), 0);
          return child;
        },
      };
    }
    return originalLoad.apply(this, [request, parent, isMain]);
  };
  globalThis.setTimeout = (callback) => {
    timeoutCallback = callback;
    return 1;
  };
  globalThis.clearTimeout = () => undefined;
  try {
    clearDistModule('main/remote-frontend-packager.js');
    const { buildRemoteFrontend } = require('../../dist-electron/main/remote-frontend-packager.js');
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forger-remote-build-late-timeout-'));
    await fs.mkdir(path.join(root, 'dist'), { recursive: true });
    await fs.writeFile(path.join(root, 'dist/index.html'), '<html></html>');
    const result = await buildRemoteFrontend({ frontendDir: root, sessionId: 'session-1', handshakeUrl: 'https://platform.test', nodePath: '/runtime/node', npmPath: '/runtime/npm' });
    assert.equal(result.assets.length, 1);
    timeoutCallback();
  } finally {
    Module._load = originalLoad;
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
    clearDistModule('main/remote-frontend-packager.js');
  }
});

test('RemoteNetworkShareManager starts, proxies encrypted RPC, rejects replays, and stops', async () => {
  const backend = await createBackendServer();
  await withMockedPackager(
    async (input) => {
      assert.equal(input.nodePath, process.execPath);
      assert.equal(input.npmPath, process.execPath);
      return { assets: [{ path: 'index.html', data: Buffer.from('<html></html>'), type: 'text/html' }], hash: 'hash' };
    },
    async ({ RemoteNetworkShareManager }) => {
      const context = createManagerOptions();
      context.runningApps.set('finance-os', { backendUrl: backend.backendUrl });
      const manager = new RemoteNetworkShareManager(context.options);

      assert.deepEqual(manager.status('finance-os'), { active: false, appId: 'finance-os', state: 'inactive' });
      const started = await manager.start('finance-os');
      assert.equal(started.success, true);
      assert.equal(started.status.state, 'waiting_for_session');
      assert.equal(context.uploads.length, 1);
      assert.equal(context.uploads[0].frontendHash, 'hash');
      assert.equal((await manager.start('finance-os')).status.state, 'waiting_for_session');

      const options = await requestText(`${started.status.tunnelUrl}/__forger_remote_rpc`, {
        method: 'OPTIONS',
        headers: { Origin: 'https://remote-assets.test' },
      });
      assert.equal(options.status, 204);
      assert.equal(options.headers['access-control-allow-origin'], 'https://remote-assets.test');
      const notFound = await requestText(`${started.status.tunnelUrl}/not-rpc`, { method: 'GET' });
      assert.equal(notFound.status, 404);

      const browser = makeBrowserCrypto(context.uploads[0].desktopPublicKeyJwk);
      const envelope = browser.encrypt('Session_ABC123', {
        method: 'POST',
        path: '/api/items?x=1',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        bodyBase64: Buffer.from(JSON.stringify({ name: 'demo' })).toString('base64'),
      });
      const rpc = await requestText(`${started.status.tunnelUrl}/__forger_remote_rpc`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
      }, JSON.stringify(envelope));
      assert.equal(rpc.status, 200);
      const decrypted = browser.decrypt(JSON.parse(rpc.body));
      assert.equal(decrypted.status, 200);
      assert.deepEqual(JSON.parse(Buffer.from(decrypted.bodyBase64, 'base64').toString('utf8')), {
        ok: true,
        url: '/api/items?x=1',
        remote: 'true',
      });
      assert.equal(manager.status('finance-os').connectionCount, 1);

      context.runningApps.delete('finance-os');
      const notRunning = await requestText(`${started.status.tunnelUrl}/__forger_remote_rpc`, { method: 'POST' }, JSON.stringify(
        browser.encrypt('Session_ABC123', { method: 'GET', path: '/api/items', headers: {}, bodyBase64: null }),
      ));
      assert.equal(notRunning.status, 403);
      assert.match(notRunning.body, /app_not_running/);
      context.runningApps.set('finance-os', { backendUrl: backend.backendUrl });

      const replay = await requestText(`${started.status.tunnelUrl}/__forger_remote_rpc`, { method: 'POST' }, JSON.stringify(envelope));
      assert.equal(replay.status, 403);
      assert.match(replay.body, /remote_rpc_replay/);
      const blocked = await requestText(`${started.status.tunnelUrl}/__forger_remote_rpc`, { method: 'POST' }, JSON.stringify(
        browser.encrypt('Session_ABC123', { method: 'GET', path: '/mcp/list', headers: {}, bodyBase64: null }),
      ));
      assert.equal(blocked.status, 403);
      await assert.rejects(
        () => requestText(`${started.status.tunnelUrl}/__forger_remote_rpc`, { method: 'POST' }, 'x'.repeat(64 * 1024 * 1024 + 1)),
        /socket hang up|ECONNRESET/,
      );
      assert.equal((await manager.stopBySession('missing')), undefined);
      assert.equal((await manager.stopBySession('Session_ABC123')).status.state, 'closed');
      assert.equal((await manager.stop('finance-os')).status.state, 'inactive');
      await manager.stopAll();
    },
  );
  await backend.close();
});

test('RemoteNetworkShareManager reports startup validation and cleanup failures', async () => {
  await withMockedPackager(
    async () => {
      throw new Error('build_failed');
    },
    async ({ RemoteNetworkShareManager }) => {
      const unsupported = createManagerOptions({ resolveInstalledManifest: async () => ({ remoteTunnel: false }) });
      assert.equal((await new RemoteNetworkShareManager(unsupported.options).start('app')).technicalCode, 'remote_tunnel_not_supported');
      const noCloud = createManagerOptions({ backendClient: () => null });
      assert.equal((await new RemoteNetworkShareManager(noCloud.options).start('app')).technicalCode, 'forger_cloud_required');
      const openFailed = createManagerOptions({ openInstalledApp: async () => ({ success: false, userMessage: 'nope', technicalCode: 'open_failed' }) });
      assert.equal((await new RemoteNetworkShareManager(openFailed.options).start('app')).technicalCode, 'open_failed');
      const notRunning = createManagerOptions();
      assert.equal((await new RemoteNetworkShareManager(notRunning.options).start('app')).technicalCode, 'app_not_running');
      const missingRuntime = createManagerOptions({ ensureRuntimeInstalled: async () => ({ rootDir: '/runtime/node' }) });
      missingRuntime.runningApps.set('app', { backendUrl: 'http://127.0.0.1:1' });
      assert.equal((await new RemoteNetworkShareManager(missingRuntime.options).start('app')).technicalCode, 'remote_tunnel_node_runtime_missing');
      const invalidSession = createManagerOptions({
        backendClient: () => ({
          createRemoteTunnelSession: async () => ({ id: 'bad', session_id: '', handshake_url: '' }),
        }),
      });
      invalidSession.runningApps.set('app', { backendUrl: 'http://127.0.0.1:1' });
      assert.equal((await new RemoteNetworkShareManager(invalidSession.options).start('app')).technicalCode, 'remote_tunnel_session_payload_invalid');

      const failing = createManagerOptions();
      failing.runningApps.set('app', { backendUrl: 'http://127.0.0.1:1' });
      const result = await new RemoteNetworkShareManager(failing.options).start('app');
      assert.equal(result.success, false);
      assert.equal(result.technicalCode, 'build_failed');
      assert.equal(failing.closes[0], 7);
    },
  );

  await withMockedPackagerAndProvider(
    async () => ({ assets: [], hash: 'hash' }),
    {
      LocalTunnelProvider: class LocalTunnelProvider {},
      listenLocal: async () => {
        throw new Error('listen_failed');
      },
    },
    async ({ RemoteNetworkShareManager }) => {
      const failingListen = createManagerOptions();
      failingListen.runningApps.set('app', { backendUrl: 'http://127.0.0.1:1' });
      const result = await new RemoteNetworkShareManager(failingListen.options).start('app');
      assert.equal(result.technicalCode, 'listen_failed');
      assert.equal(failingListen.closes[0], 7);
    },
  );
});
