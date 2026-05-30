import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import Module from 'node:module';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { clearDistModule } from './electron-test-helpers.mjs';

const require = createRequire(import.meta.url);
const tmpRoot = async (name) => await fs.mkdtemp(path.join(os.tmpdir(), `forger-${name}-`));

const waitFor = async (predicate) => {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('wait_for_timeout');
};

class FakeChildProcess extends EventEmitter {
  constructor(label) {
    super();
    this.label = label;
    this.killed = false;
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.pid = FakeChildProcess.nextPid++;
  }

  kill(signal) {
    this.killed = true;
    this.signal = signal;
    queueMicrotask(() => this.emit('exit', null, signal));
    return true;
  }
}

FakeChildProcess.nextPid = 20_000;

class FakeBrowserWindow extends EventEmitter {
  static instances = [];

  constructor(options) {
    super();
    this.options = options;
    this.destroyed = false;
    this.minimized = false;
    this.loadedUrls = [];
    this.closed = false;
    this.webContents = new EventEmitter();
    this.webContents.currentUrl = '';
    this.webContents.getURL = () => this.webContents.currentUrl;
    this.webContents.setWindowOpenHandler = (handler) => {
      this.openHandler = handler;
    };
    FakeBrowserWindow.instances.push(this);
  }

  async loadURL(url) {
    this.webContents.currentUrl = url;
    this.loadedUrls.push(url);
  }

  async loadFile(filePath, options) {
    this.loadedFile = { filePath, options };
  }

  isDestroyed() {
    return this.destroyed;
  }

  isMinimized() {
    return this.minimized;
  }

  restore() {
    this.minimized = false;
  }

  show() {
    this.shown = true;
  }

  focus() {
    this.focused = true;
  }

  close() {
    this.closed = true;
    this.destroyed = true;
    this.emit('closed');
  }
}

const withRuntimeModule = async ({ spawnImpl, electronMock }, callback) => {
  const originalLoad = Module._load;
  Module._load = function loadWithRuntimeMocks(request, parent, isMain) {
    if (request === 'electron') {
      return electronMock;
    }
    if (request === 'node:child_process') {
      return { spawn: spawnImpl };
    }
    return originalLoad.apply(this, [request, parent, isMain]);
  };

  try {
    clearDistModule('main/runtime/installed-app-runtime.js');
    const runtime = require('../../dist-electron/main/runtime/installed-app-runtime.js');
    return await callback(runtime);
  } finally {
    Module._load = originalLoad;
    clearDistModule('main/runtime/installed-app-runtime.js');
    FakeBrowserWindow.instances = [];
  }
};

const writeOpenableApp = async (root) => {
  const installDir = path.join(root, 'apps', 'demo-app');
  await fs.mkdir(path.join(installDir, 'backend', 'src', 'finance_api'), { recursive: true });
  await fs.mkdir(path.join(installDir, 'web'), { recursive: true });
  await fs.writeFile(path.join(installDir, 'backend', 'src', 'finance_api', 'server.py'), 'app = object()\n', 'utf8');
  await fs.writeFile(path.join(installDir, 'manifest.json'), JSON.stringify({
    services: [
      {
        name: 'backend',
        context: './backend',
        command: 'fastapi dev src/finance_api/server.py',
        healthcheck: 'ready',
        environment: {
          DATABASE_URL: 'sqlite:////app/data/app.sqlite3',
          CUSTOM_PATH: '{app_root}/custom',
        },
      },
      {
        name: 'frontend',
        context: './web',
      },
    ],
  }), 'utf8');
  return installDir;
};

const makeRuntimeHarness = async ({ root, spawnImpl, electronOverrides = {} } = {}) => {
  const harnessRoot = root ?? await tmpRoot('runtime-open');
  const installDir = await writeOpenableApp(harnessRoot);
  const appWindows = new Map();
  const registry = {
    apps: {
      'demo-app': {
        appId: 'demo-app',
        name: 'Demo App',
        version: '1.0.0',
        installDir,
        requiredNodeVersion: '22.0.0',
        requiredPythonVersion: '3.12.0',
        status: 'installed',
        userMessage: 'Ready',
        installedAt: new Date().toISOString(),
      },
    },
  };
  const calls = [];
  const deepLinks = [];
  const shellUrls = [];
  const runtimeBridgeEnv = { FORGER_TASK_PORT: '49152' };
  const electronMock = {
    BrowserWindow: FakeBrowserWindow,
    shell: {
      openExternal: async (url) => {
        shellUrls.push(url);
      },
    },
    ...electronOverrides,
  };
  const defaultSpawn = () => new FakeChildProcess('process');
  const deps = {
    FORGER_PROTOCOL: 'forger',
    app: {
      getPath: () => harnessRoot,
      getAppPath: () => harnessRoot,
      focus: () => calls.push(['appFocus']),
    },
    appAgentConversationManager: { rejectPendingPermissionsForApp: (appId) => calls.push(['rejectConversation', appId]) },
    appAgentTaskManager: { rejectPendingPermissionsForApp: (appId) => calls.push(['rejectTask', appId]) },
    appFolderGrantSecret: 'grant-secret',
    appWindows,
    appendInstallLog: async (event, payload = {}) => calls.push(['log', event, payload]),
    desktopRuntimeBridge: { environmentForApp: () => runtimeBridgeEnv },
    dispatchDeepLink: (link) => deepLinks.push(link),
    emitRuntimeStatus: (payload) => calls.push(['runtimeStatus', payload]),
    ensureBackendPythonEnvironment: async (pythonPath, backendDir, appId, reason) => {
      calls.push(['ensureBackendPythonEnvironment', pythonPath, backendDir, appId, reason]);
    },
    ensureCatalogStatuses: () => calls.push(['catalogStatuses']),
    ensureRuntimeInstalled: async (type, version) => {
      calls.push(['ensureRuntimeInstalled', type, version]);
      return type === 'node'
        ? { node: path.join(harnessRoot, 'runtime', 'node', 'bin', 'node'), npm: path.join(harnessRoot, 'runtime', 'node', 'bin', 'npm') }
        : { python: path.join(harnessRoot, 'runtime', 'python', 'bin', 'python'), pip: path.join(harnessRoot, 'runtime', 'python', 'bin', 'pip') };
    },
    failureDiagnostic: (error, fallbackCode) => ({ technicalCode: error instanceof Error ? error.message : fallbackCode }),
    formatProcessOutputForInstallLog: (text, secrets) => secrets.reduce((next, secret) => next.split(secret).join('[secret]'), text),
    friendChatWindows: new Map(),
    fs,
    getBackendPathEntries: async () => [path.join(harnessRoot, 'developer-bin')],
    getInstallLogPath: () => path.join(harnessRoot, 'install.log'),
    getManifestAppSecretsValidationError: () => null,
    getSecretsStore: () => ({
      resolveAppEnv: async () => ({
        env: { OPENAI_API_KEY: 'secret-value' },
        missingRequired: [],
        secretValues: ['secret-value'],
      }),
    }),
    getVenvExecutables: (backendDir) => ({ python: path.join(backendDir, '.venv', 'bin', 'python'), pip: path.join(backendDir, '.venv', 'bin', 'pip') }),
    http: require('node:http'),
    isDev: false,
    isSecretsVaultUnavailableError: () => false,
    net: require('node:net'),
    normalizeManifestAppSecrets: () => [{ name: 'OpenAI API key', required: true }],
    normalizeNodeRuntimeVersion: (value) => value ?? '22.0.0',
    parseForgerUrl: (url) => ({ kind: 'app', rawUrl: url }),
    path,
    registry,
    requiresWindowsShell: () => false,
    resolveInstalledManifest: async (target) => JSON.parse(await fs.readFile(path.join(target, 'manifest.json'), 'utf8')),
    runCommand: async (command, args, options) => calls.push(['runCommand', command, args, options]),
    runningApps: new Map(),
    serializeErrorForInstallLog: (error) => ({ message: error instanceof Error ? error.message : String(error) }),
    shell: electronMock.shell,
    stoppingApps: new Set(),
    syncAppToCloudIfEnabled: async (appId) => calls.push(['syncCloud', appId]),
    truncateForInstallLog: (value) => value.slice(0, 32),
    upsertInstalledRecord: async (record) => {
      registry.apps[record.appId] = { ...record };
      calls.push(['upsert', record]);
    },
    wait: async () => undefined,
    withAppLifecycleLock: async (appId, operation) => {
      calls.push(['lock', appId]);
      return await operation();
    },
  };

  return {
    appWindows,
    calls,
    deepLinks,
    deps,
    electronMock,
    installDir,
    registry,
    root: harnessRoot,
    shellUrls,
    spawnImpl: spawnImpl ?? defaultSpawn,
  };
};

test('openInstalledApp resolves FastAPI imports, merges PYTHONPATH, logs process output, and opens a secure app window', async (t) => {
  const root = await tmpRoot('runtime-open-processes');
  const originalFetch = globalThis.fetch;
  const spawned = [];
  t.after(async () => {
    globalThis.fetch = originalFetch;
    await fs.rm(root, { recursive: true, force: true });
  });
  globalThis.fetch = async () => new Response('ok', { status: 200 });

  const harness = await makeRuntimeHarness({
    root,
    spawnImpl: (command, args, options) => {
      const child = new FakeChildProcess(spawned.length === 0 ? 'backend' : 'frontend');
      spawned.push({ command, args, options, child });
      return child;
    },
  });

  await withRuntimeModule(harness, async ({ createInstalledAppRuntimeController }) => {
    const controller = createInstalledAppRuntimeController(harness.deps);
    const result = await controller.openInstalledApp('demo-app', 'es-CL');

    assert.equal(result.success, true);
    assert.equal(harness.deps.runningApps.has('demo-app'), true);
    assert.equal(spawned.length, 2);
    assert.deepEqual(spawned[0].args.slice(0, 3), ['-m', 'uvicorn', 'finance_api.server:app']);
    assert.ok(spawned[0].args.includes('--reload'));
    assert.equal(spawned[0].options.cwd, path.join(harness.installDir, 'backend'));
    assert.equal(
      spawned[0].options.env.PYTHONPATH.split(path.delimiter)[0],
      path.join(harness.installDir, 'backend', 'src'),
    );
    assert.equal(spawned[0].options.env.DATABASE_URL, `sqlite:///${path.join(harness.installDir, 'backend', 'data', 'app.sqlite3')}`);
    assert.equal(spawned[0].options.env.OPENAI_API_KEY, 'secret-value');
    assert.equal(spawned[0].options.env.FORGER_TASK_PORT, '49152');
    assert.equal(spawned[0].options.env.FORGER_APP_GRANT_SECRET, 'grant-secret');
    assert.equal(spawned[0].options.env.PATH.split(path.delimiter)[0], path.join(root, 'developer-bin'));
    assert.equal(spawned[1].command, path.join(root, 'runtime', 'node', 'bin', 'npm'));
    assert.equal(spawned[1].options.cwd, path.join(harness.installDir, 'web'));
    assert.match(spawned[1].options.env.VITE_API_BASE_URL, /\/__forger_api$/);

    const sqliteParent = path.join(harness.installDir, 'backend', 'data');
    assert.ok(await fs.stat(sqliteParent));
    assert.equal(FakeBrowserWindow.instances.length, 1);
    const appWindow = FakeBrowserWindow.instances[0];
    assert.equal(appWindow.options.webPreferences.nodeIntegration, false);
    assert.equal(appWindow.options.webPreferences.contextIsolation, true);
    assert.equal(appWindow.options.webPreferences.sandbox, true);
    assert.match(appWindow.loadedUrls[0], /^http:\/\/127\.0\.0\.1:\d+\/\?forgerLocale=es-CL$/);

    spawned[0].child.stdout.emit('data', Buffer.from('backend secret-value output'));
    spawned[1].child.stderr.emit('data', Buffer.from('frontend secret-value error'));
    await waitFor(() => harness.calls.some((call) => call[1] === 'open:frontend:stderr'));
    const backendStdout = harness.calls.find((call) => call[1] === 'open:backend:stdout');
    const frontendStderr = harness.calls.find((call) => call[1] === 'open:frontend:stderr');
    assert.equal(backendStdout[2].text.includes('secret-value'), false);
    assert.equal(frontendStderr[2].text.includes('secret-value'), false);

    const prevented = { called: false, preventDefault() { this.called = true; } };
    appWindow.webContents.emit('will-navigate', prevented, 'https://example.com/outside');
    assert.equal(prevented.called, true);
    await waitFor(() => harness.shellUrls.includes('https://example.com/outside'));

    assert.deepEqual(appWindow.openHandler({ url: `${new URL(appWindow.loadedUrls[0]).origin}/next` }), { action: 'deny' });
    await waitFor(() => appWindow.loadedUrls.at(-1).endsWith('/next'));
    assert.deepEqual(appWindow.openHandler({ url: 'forger://apps/demo-app' }), { action: 'deny' });
    assert.deepEqual(harness.deepLinks, [{ kind: 'app', rawUrl: 'forger://apps/demo-app' }]);

    await controller.stopInstalledApp('demo-app');
    assert.equal(spawned[0].child.killed, true);
    assert.equal(spawned[1].child.killed, true);
  });
});

test('openInstalledApp marks a running app as errored when a local process exits unexpectedly', async (t) => {
  const root = await tmpRoot('runtime-open-crash');
  const originalFetch = globalThis.fetch;
  const spawned = [];
  t.after(async () => {
    globalThis.fetch = originalFetch;
    await fs.rm(root, { recursive: true, force: true });
  });
  globalThis.fetch = async () => new Response('ok', { status: 200 });

  const harness = await makeRuntimeHarness({
    root,
    spawnImpl: (command, args, options) => {
      const child = new FakeChildProcess(spawned.length === 0 ? 'backend' : 'frontend');
      spawned.push({ command, args, options, child });
      return child;
    },
  });

  await withRuntimeModule(harness, async ({ createInstalledAppRuntimeController }) => {
    const controller = createInstalledAppRuntimeController(harness.deps);
    const result = await controller.openInstalledApp('demo-app');
    assert.equal(result.success, true);

    spawned[0].child.emit('exit', 1, null);
    await waitFor(() => harness.calls.some((call) => call[0] === 'runtimeStatus' && call[1].status === 'error'));

    assert.equal(harness.deps.runningApps.has('demo-app'), false);
    assert.equal(harness.registry.apps['demo-app'].status, 'error');
    assert.ok(harness.calls.some((call) => call[0] === 'runtimeStatus' && call[1].status === 'error'));
    assert.equal(harness.appWindows.has('demo-app'), false);
  });
});
