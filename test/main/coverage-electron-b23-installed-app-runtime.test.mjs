import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const runtimePath = require.resolve('../../dist-electron/main/runtime/installed-app-runtime.js');
const processSpawnPath = require.resolve('../../dist-electron/main/runtime/process-spawn.js');
const electronPath = require.resolve('electron');
const { createInstalledAppRuntimeController } = require(runtimePath);

class FakeProcess extends EventEmitter {
  static nextPid = 51_000;

  constructor() {
    super();
    this.pid = FakeProcess.nextPid++;
    this.killed = false;
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
  }

  kill(signal) {
    this.killed = true;
    this.signal = signal;
    queueMicrotask(() => this.emit('exit', null, signal));
    return true;
  }
}

const withSpawnedRuntime = async (spawnProcess, operation) => {
  const savedRuntime = require.cache[runtimePath];
  const savedProcessSpawn = require.cache[processSpawnPath];
  const savedElectron = require.cache[electronPath];
  delete require.cache[runtimePath];
  require.cache[processSpawnPath] = {
    id: processSpawnPath,
    filename: processSpawnPath,
    loaded: true,
    exports: {
      spawnProcess,
      mergePathEntry: (environment, ...entries) => ({
        ...environment,
        PATH: [...entries.filter(Boolean), environment.PATH ?? ''].filter(Boolean).join(path.delimiter),
      }),
    },
  };
  require.cache[electronPath] = {
    id: electronPath,
    filename: electronPath,
    loaded: true,
    exports: { BrowserWindow: class FakeBrowserWindow {} },
  };
  try {
    return await operation(require(runtimePath).createInstalledAppRuntimeController);
  } finally {
    delete require.cache[runtimePath];
    if (savedRuntime) require.cache[runtimePath] = savedRuntime;
    if (savedProcessSpawn) require.cache[processSpawnPath] = savedProcessSpawn;
    else delete require.cache[processSpawnPath];
    if (savedElectron) require.cache[electronPath] = savedElectron;
    else delete require.cache[electronPath];
  }
};

const createDeps = (overrides = {}) => {
  const calls = [];
  const registry = {
    apps: {
      'demo-app': {
        appId: 'demo-app',
        name: 'Demo App',
        version: '1.0.0',
        installDir: '/tmp/forger-b23-demo-app',
        requiredNodeVersion: '22.0.0',
        requiredPythonVersion: '3.12.0',
        status: 'installed',
        userMessage: 'Ready',
        installedAt: new Date().toISOString(),
      },
    },
  };
  const deps = {
    FORGER_PROTOCOL: 'forger',
    app: { getPath: () => '/tmp', getAppPath: () => '/tmp' },
    appAgentConversationManager: null,
    appAgentTaskManager: null,
    appFolderGrantSecret: 'grant',
    appWindows: new Map(),
    appendInstallLog: async (event, payload = {}) => calls.push(['log', event, payload]),
    desktopRuntimeBridge: null,
    dispatchDeepLink: () => undefined,
    emitRuntimeStatus: (payload) => calls.push(['status', payload]),
    ensureBackendPythonEnvironment: async () => undefined,
    ensureCatalogStatuses: () => undefined,
    ensureRuntimeInstalled: async (type) => type === 'node'
      ? { node: '/tmp/node', npm: '/tmp/npm' }
      : { python: '/tmp/python', pip: '/tmp/pip' },
    failureDiagnostic: (error, fallbackCode) => ({ technicalCode: error instanceof Error ? error.message : fallbackCode }),
    formatProcessOutputForInstallLog: (text) => text,
    friendChatWindows: new Map(),
    fs,
    getBackendPathEntries: async () => [],
    getInstallLogPath: () => '/tmp/install.log',
    getManifestAppSecretsValidationError: () => null,
    getSecretsStore: () => ({ resolveAppEnv: async () => ({ env: {}, missingRequired: [], secretValues: [] }) }),
    getVenvExecutables: () => ({ python: '/tmp/venv/python', pip: '/tmp/venv/pip' }),
    http,
    isDev: false,
    isSecretsVaultUnavailableError: () => false,
    net,
    normalizeManifestAppSecrets: () => [],
    normalizeNodeRuntimeVersion: (value) => value ?? '22.0.0',
    parseForgerUrl: () => null,
    path,
    registry,
    resolveInstalledManifest: async () => ({ services: [] }),
    runCommand: async () => undefined,
    runningApps: new Map(),
    serializeErrorForInstallLog: (error) => ({ message: error instanceof Error ? error.message : String(error) }),
    shell: { openExternal: async () => undefined },
    stoppingApps: new Set(),
    syncAppToCloudIfEnabled: async () => undefined,
    truncateForInstallLog: (value) => value,
    upsertInstalledRecord: async (record) => {
      registry.apps[record.appId] = { ...record };
    },
    wait: async () => undefined,
    withAppLifecycleLock: async (_appId, operation) => await operation(),
    ...overrides,
  };
  return { calls, deps, registry };
};

const requestThroughFakeProxy = async (handler, { url, method = 'GET', headers = {}, body = '' }) => {
  const incoming = new EventEmitter();
  incoming.url = url;
  incoming.method = method;
  incoming.headers = headers;
  const response = {
    headers: new Map(),
    setHeader(name, value) { this.headers.set(name, value); },
  };
  const completed = new Promise((resolve) => {
    response.end = (payload) => {
      response.payload = payload;
      resolve(response);
    };
  });
  handler(incoming, response);
  if (body) incoming.emit('data', Buffer.from(body));
  incoming.emit('end');
  return await completed;
};

const createSocket = () => {
  const socket = new EventEmitter();
  socket.writes = [];
  socket.destroyed = false;
  socket.write = (value) => socket.writes.push(Buffer.isBuffer(value) ? value.toString() : value);
  socket.destroy = () => { socket.destroyed = true; };
  socket.pipe = (target) => target;
  return socket;
};

test('Given the local proxy boundary, when HTTP and websocket requests omit optional metadata or fail, then routing, headers, and both sockets close deterministically', async () => {
  const servers = [];
  const targetSockets = [];
  const fakeHttp = {
    createServer: (requestHandler) => {
      const server = new EventEmitter();
      server.requestHandler = requestHandler;
      server.listen = (_port, _host, callback) => callback();
      server.address = () => ({ port: 43210 });
      server.close = (callback) => callback?.();
      servers.push(server);
      return server;
    },
  };
  const fakeNet = {
    connect: (port, hostname) => {
      const socket = createSocket();
      socket.port = port;
      socket.hostname = hostname;
      targetSockets.push(socket);
      return socket;
    },
  };
  const controller = createInstalledAppRuntimeController({ http: fakeHttp, net: fakeNet });
  const previousFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url) => new Response(`proxied:${url}`, {
      status: 201,
      headers: { 'content-type': 'text/plain', 'x-private': 'hidden' },
    });
    await controller.createLocalAppProxy('https://backend.example', 'http://frontend.example');
    const server = servers.at(-1);

    const frontend = await requestThroughFakeProxy(server.requestHandler, {
      url: undefined,
      method: 'POST',
      headers: { accept: 'text/plain', cookie: 'secret', 'accept-language': ['es'] },
      body: 'payload',
    });
    assert.equal(frontend.statusCode, 201);
    assert.equal(frontend.headers.has('content-type'), true);
    assert.equal(frontend.headers.has('x-private'), false);

    const apiRoot = await requestThroughFakeProxy(server.requestHandler, {
      url: '/__forger_api',
      method: 'HEAD',
    });
    assert.equal(apiRoot.statusCode, 201);

    globalThis.fetch = async () => { throw new Error('offline'); };
    const failed = await requestThroughFakeProxy(server.requestHandler, { url: '/screen' });
    assert.equal(failed.statusCode, 502);
    assert.equal(failed.payload, 'Forger app proxy failed.');

    const upgrade = server.listeners('upgrade')[0];
    const missingUrlClient = createSocket();
    upgrade({ url: undefined, method: 'GET', httpVersion: '1.1', rawHeaders: [] }, missingUrlClient, Buffer.alloc(0));
    assert.ok(missingUrlClient.writes.some((value) => value.includes('404 Not Found')));

    const client = createSocket();
    upgrade({
      url: '/__forger_api',
      method: undefined,
      httpVersion: '1.1',
      rawHeaders: ['Upgrade', 'websocket', 'X-Odd'],
    }, client, Buffer.from('early-frame'));
    const connected = targetSockets.at(-1);
    assert.equal(connected.port, 443);
    connected.emit('connect');
    assert.match(connected.writes[0], /^GET \/ HTTP\/1\.1/);
    assert.match(connected.writes[0], /Host: backend\.example/);
    assert.equal(connected.writes[1], 'early-frame');
    client.emit('error', new Error('client_closed'));
    assert.equal(client.destroyed, true);
    assert.equal(connected.destroyed, true);

    const earlyFailureClient = createSocket();
    upgrade({ url: '/__forger_api/socket', method: 'GET', httpVersion: '1.1', rawHeaders: ['Host', 'old'] }, earlyFailureClient, Buffer.alloc(0));
    const earlyFailureTarget = targetSockets.at(-1);
    earlyFailureTarget.emit('error', new Error('refused'));
    assert.ok(earlyFailureClient.writes.some((value) => value.includes('502 Bad Gateway')));

    const lateFailureClient = createSocket();
    upgrade({ url: '/__forger_api/socket', method: 'GET', httpVersion: '1.1', rawHeaders: ['Host', 'old'] }, lateFailureClient, Buffer.alloc(0));
    const lateFailureTarget = targetSockets.at(-1);
    lateFailureTarget.emit('connect');
    lateFailureTarget.emit('error', new Error('after_connect'));
    assert.equal(lateFailureClient.writes.some((value) => value.includes('502 Bad Gateway')), false);

    await controller.createLocalAppProxy('http://plain.example', 'http://frontend.example');
    const plainUpgrade = servers.at(-1).listeners('upgrade')[0];
    plainUpgrade({ url: '/__forger_api/socket', method: 'GET', httpVersion: '1.1', rawHeaders: [] }, createSocket(), Buffer.alloc(0));
    assert.equal(targetSockets.at(-1).port, 80);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('Given runtime status and manifest helpers, when optional sharing, services, and secret labels are absent, then public results use safe defaults', async () => {
  const share = { state: 'active', localUrl: 'http://192.168.1.2:3000' };
  const shared = createDeps({ getLocalNetworkShareStatus: () => share });
  shared.deps.runningApps.set('demo-app', { backendUrl: 'http://backend', frontendUrl: 'http://frontend' });
  const controller = createInstalledAppRuntimeController(shared.deps);
  assert.deepEqual(controller.getRuntimeStatus('demo-app').localNetworkShare, share);
  assert.deepEqual(controller.getRuntimeStatus('missing').localNetworkShare, share);
  assert.equal(controller.findManifestService(null, 'backend', './backend'), null);
  assert.deepEqual(controller.splitManifestCommand(undefined), []);

  const missingSecret = createDeps({
    normalizeManifestAppSecrets: () => [{ name: 'API_TOKEN', required: true }],
    getSecretsStore: () => ({
      resolveAppEnv: async () => ({
        env: {}, secretValues: [], missingRequired: [{ name: 'API_TOKEN', required: true }],
      }),
    }),
  });
  const result = await createInstalledAppRuntimeController(missingSecret.deps).openInstalledAppUnlocked('demo-app');
  assert.equal(result.technicalCode, 'required_app_secrets_missing');
  assert.match(result.userMessage, /API_TOKEN/);
});

test('Given app startup output and alternative FastAPI or Uvicorn commands, when readiness fails, then bounded diagnostics identify the failing service and release every process', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forger-b23-runtime-open-'));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const previousDateNow = Date.now;
  const previousPath = process.env.PATH;
  const runCase = async ({ command, emitOutput, diagnostic = (error) => ({ technicalCode: error.message }) }) => {
    const spawned = [];
    const harness = createDeps({
      getSpeechToTextEnvironment: () => ({ SPEECH_TO_TEXT: '1' }),
      getTextToSpeechEnvironment: () => ({ TEXT_TO_SPEECH: '1' }),
      getAudioInputEnvironment: () => ({ AUDIO_INPUT: '1' }),
      failureDiagnostic: diagnostic,
      registry: {
        apps: {
          'demo-app': {
            appId: 'demo-app', name: 'Demo', version: '1', installDir: root,
            requiredNodeVersion: '22', requiredPythonVersion: '3.12', status: 'installed', userMessage: 'Ready', installedAt: 'now',
          },
        },
      },
      resolveInstalledManifest: async () => ({
        services: [
          { name: 'backend', context: './backend', command },
          { name: 'frontend', environment: 'invalid' },
        ],
      }),
    });
    harness.deps.upsertInstalledRecord = async (record) => {
      harness.deps.registry.apps[record.appId] = { ...record };
    };
    return await withSpawnedRuntime(() => {
      const child = new FakeProcess();
      spawned.push(child);
      if (spawned.length === 2) queueMicrotask(() => emitOutput(spawned));
      return child;
    }, async (createController) => {
      let now = 0;
      Date.now = () => {
        now += 70_000;
        return now;
      };
      delete process.env.PATH;
      try {
        const result = await createController(harness.deps).openInstalledAppUnlocked('demo-app', undefined, { openWindow: false });
        assert.equal(spawned.every((child) => child.killed), true);
        return { result, calls: harness.calls };
      } finally {
        Date.now = previousDateNow;
        if (previousPath === undefined) delete process.env.PATH;
        else process.env.PATH = previousPath;
      }
    });
  };

  const frontendFailure = await runCase({
    command: 'fastapi dev --host 0.0.0.0',
    emitOutput: ([backend, frontend]) => {
      backend.stdout.emit('data', Buffer.from('   '));
      for (let index = 0; index < 14; index += 1) backend.stdout.emit('data', Buffer.from(`backend chunk ${index}`));
      frontend.stderr.emit('data', Buffer.from(`${'x'.repeat(6_100)} frontend Error`));
    },
  });
  assert.equal(frontendFailure.result.technicalCode, 'app_frontend_startup_failed');
  assert.match(frontendFailure.result.details.frontendStartupOutput, /frontend Error$/);
  assert.equal(frontendFailure.result.details.frontendStartupOutput.length, 6_000);
  const fastapiSpawn = frontendFailure.calls.find((call) => call[0] === 'log' && call[1] === 'open:spawn');
  assert.ok(fastapiSpawn[2].backend.args.includes('app.main:app'));

  const noSrc = await runCase({
    command: 'fastapi dev main.py',
    emitOutput: ([backend]) => backend.stderr.emit('data', Buffer.from('backend exception')),
  });
  assert.equal(noSrc.result.technicalCode, 'app_backend_startup_failed');

  const emptyModule = await runCase({
    command: 'fastapi dev src',
    emitOutput: ([backend]) => backend.stderr.emit('data', Buffer.from('backend failed')),
  });
  assert.equal(emptyModule.result.technicalCode, 'app_backend_startup_failed');

  const frontendOnly = await runCase({
    command: 'uvicorn app.main:app',
    emitOutput: ([, frontend]) => frontend.stderr.emit('data', Buffer.from('frontend error')),
  });
  assert.equal(frontendOnly.result.technicalCode, 'app_frontend_startup_failed');
  assert.equal('backendStartupOutput' in frontendOnly.result.details, false);

  const uvicornDefault = await runCase({
    command: 'uvicorn --reload',
    emitOutput: () => undefined,
    diagnostic: () => ({ userMessage: '' }),
  });
  assert.equal(uvicornDefault.result.userMessage, '');
});

test('Given a running app, when the frontend exits first, then the backend sibling is terminated and runtime state is released', async () => {
  const spawned = [];
  const harness = createDeps({
    getSpeechToTextEnvironment: () => ({}),
    getTextToSpeechEnvironment: () => ({}),
    getAudioInputEnvironment: () => ({}),
  });
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('ready', { status: 200 });
  try {
    await withSpawnedRuntime(() => {
      const child = new FakeProcess();
      spawned.push(child);
      return child;
    }, async (createController) => {
      const controller = createController(harness.deps);
      assert.equal((await controller.openInstalledAppUnlocked('demo-app', undefined, { openWindow: false })).success, true);
      spawned[1].emit('exit', 1, null);
      for (let turn = 0; turn < 4 && !spawned[0].killed; turn += 1) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      assert.equal(harness.deps.runningApps.has('demo-app'), false);
      assert.equal(spawned[0].killed, true);
    });
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('Given restart startup diagnostics without a message or code, when reopening fails, then error status and stable restart fallbacks are returned', async () => {
  const spawned = [];
  const harness = createDeps({ failureDiagnostic: () => ({ userMessage: '' }) });
  const previousDateNow = Date.now;
  try {
    await withSpawnedRuntime(() => {
      const child = new FakeProcess();
      spawned.push(child);
      return child;
    }, async (createController) => {
      let now = 0;
      Date.now = () => {
        now += 70_000;
        return now;
      };
      const result = await createController(harness.deps).restartInstalledApp('demo-app');
      assert.equal(result.userMessage, 'La app se detuvo, pero no pudimos volver a abrirla.');
      assert.equal(result.technicalCode, 'restart_open_failed');
      assert.equal(harness.registry.apps['demo-app'].status, 'error');
      assert.ok(harness.calls.some((call) => call[0] === 'status' && call[1].status === 'error'));
    });
  } finally {
    Date.now = previousDateNow;
  }
});

test('Given restart failures, when stop or reopen lacks display diagnostics, then stable fallback messages, status, and codes are emitted', async () => {
  const stopHarness = createDeps({ failureDiagnostic: () => ({ userMessage: '' }) });
  stopHarness.deps.runningApps.set('demo-app', {
    appId: 'demo-app',
    backend: { killed: false, pid: 1, kill: () => { throw new Error('cannot_stop'); } },
    frontend: { killed: true },
    proxyServer: { close: (callback) => callback?.() },
  });
  const stopped = await createInstalledAppRuntimeController(stopHarness.deps).restartInstalledApp('demo-app');
  assert.equal(stopped.userMessage, 'No pudimos detener la app para reiniciarla.');
  assert.equal(stopped.technicalCode, 'restart_stop_failed');
});
