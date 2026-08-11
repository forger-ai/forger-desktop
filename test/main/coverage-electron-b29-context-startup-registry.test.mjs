import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { createAppContextSupportController } = await import('../../dist-electron/main/apps/context-support.js');
const { createStartupLoadingController, createStartupLogger } = await import('../../dist-electron/main/core/startup-loading.js');
const { createRegistryStoreController } = await import('../../dist-electron/main/installed-apps/registry-store.js');

const tempRoot = async (t, name) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `forger-b29-${name}-`));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
};

const contextController = (root) => createAppContextSupportController({
  fs,
  path,
  catalogApps: [],
  registry: { apps: {} },
  fileLibraryState: { current: null },
  getPrivateDataRoot: () => path.join(root, 'data'),
  getForgerMetadataRoot: () => path.join(root, 'metadata'),
  appLifecycleLocks: new Map(),
  forgerBackendClient: null,
});

test('context support validates every frontend stack shape and rejects incomplete skill frontmatter', async (t) => {
  const root = await tempRoot(t, 'context');
  const controller = contextController(root);
  assert.equal(controller.hasValidManifestStack({ stack: { frontend: { command: 'npm run dev' } } }), true);
  assert.equal(controller.hasValidManifestStack({ stack: { frontend: 'vite' } }), false);
  assert.equal(controller.hasValidManifestStack({ stack: { frontend: [] } }), false);

  const installDir = path.join(root, 'app');
  const skillsRoot = path.join(root, 'copied-skills');
  const cases = [
    ['missing-name', '---\ndescription: Present\n---\nBody'],
    ['empty-name', '---\nname:   \ndescription: Present\n---\nBody'],
    ['multiline-name', '---\nname:\nborrowed-name\ndescription: Present\n---\nBody'],
    ['invalid-json-name', '---\nname: "unterminated\ndescription: Present\n---\nBody'],
    ['missing-frontmatter', 'No frontmatter here'],
  ];
  for (const [name, markdown] of cases) {
    const source = path.join(installDir, 'skills', name);
    await fs.mkdir(source, { recursive: true });
    await fs.writeFile(path.join(source, 'SKILL.md'), markdown);
  }
  const previousPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  try {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' });
    await controller.copyAppSkills(installDir, skillsRoot, {
      skills: cases.map(([name]) => `skills/${name}`),
    });
  } finally {
    Object.defineProperty(process, 'platform', previousPlatform);
  }
  await assert.rejects(() => fs.access(skillsRoot));
});

test('startup logger reports success and failure progress while storage failures remain non-blocking', async (t) => {
  const root = await tempRoot(t, 'startup-log');
  const progress = [];
  const logger = createStartupLogger(() => root, (update) => progress.push(update));
  await logger.event('startup:ready');
  await logger.step('startup:success', async () => undefined, { appId: 'demo' });
  await assert.rejects(() => logger.step('startup:failure', async () => {
    throw new Error('failed');
  }), /failed/);
  assert.deepEqual(progress.map(({ status }) => status), ['active', 'active', 'success', 'active', 'failed']);

  const failingLogger = createStartupLogger(() => {
    throw new Error('metadata unavailable');
  });
  await failingLogger.event('startup:logging-failed', { safe: true });
});

const windowDouble = (calls, overrides = {}) => class WindowDouble {
  constructor(options) {
    this.options = options;
    this.destroyed = overrides.destroyedAtConstruction ?? false;
    this.webContents = overrides.noWebContents ? undefined : {
      ...(overrides.noOnce ? {} : { once: (_event, listener) => { this.ready = listener; } }),
      ...(overrides.noExecute ? {} : {
        executeJavaScript: async (script) => {
          calls.scripts.push(script);
          if (overrides.rejectExecute) throw new Error('execute failed');
        },
      }),
    };
    calls.windows.push(this);
  }

  isDestroyed() {
    return this.destroyed;
  }

  async loadURL(url) {
    calls.urls.push(url);
    if (overrides.rejectLoad) throw new Error('load failed');
  }

  close() {
    calls.closes += 1;
    this.destroyed = true;
  }
};

test('startup loading controller is inert without Electron and guards destroyed windows at each rendering stage', async () => {
  const inert = createStartupLoadingController(null, undefined);
  inert.update({ event: 'startup:ready', status: 'active' });
  inert.close();

  const destroyedCalls = { windows: [], scripts: [], urls: [], closes: 0 };
  const destroyed = createStartupLoadingController(windowDouble(destroyedCalls, { destroyedAtConstruction: true }), undefined);
  destroyed.update({ event: 'startup:ready', status: 'active' });
  destroyed.close();
  assert.equal(destroyedCalls.urls.length, 0);
  assert.equal(destroyedCalls.closes, 0);

  const pendingCalls = { windows: [], scripts: [], urls: [], closes: 0 };
  const pending = createStartupLoadingController(windowDouble(pendingCalls), 'es');
  pending.update({ event: 'unknown', status: 'active' });
  pendingCalls.windows[0].destroyed = true;
  pendingCalls.windows[0].ready();
  assert.equal(pendingCalls.scripts.length, 0);
});

test('startup loading tolerates missing webContents APIs and rejected renderer operations', async () => {
  const fallbackCalls = { windows: [], scripts: [], urls: [], closes: 0 };
  const fallback = createStartupLoadingController(windowDouble(fallbackCalls, {
    noOnce: true,
    noExecute: true,
    rejectLoad: true,
  }), 'en');
  fallback.update({ event: 'startup:ready', status: 'active' });
  fallback.update({ event: 'startup:ready', status: 'success' });
  fallback.close();

  const rejectedCalls = { windows: [], scripts: [], urls: [], closes: 0 };
  const rejected = createStartupLoadingController(windowDouble(rejectedCalls, { rejectExecute: true }), 'en');
  rejected.update({ event: 'startup:ready', status: 'active' });
  rejectedCalls.windows[0].ready();
  rejected.update({ event: 'startup:failed', status: 'failed', error: 'failure' });
  await Promise.resolve();
  assert.equal(rejectedCalls.scripts.length, 2);
});

const registryController = (root, overrides = {}) => {
  const registry = overrides.registry ?? { apps: {} };
  const state = { registry, catalogApps: overrides.catalogApps ?? [] };
  const controller = createRegistryStoreController({
    DEFAULT_NODE_VERSION: '22',
    DEFAULT_PYTHON_VERSION: '3.12',
    DevCatalogService: class {},
    app: {},
    appendInstallLog: async () => undefined,
    catalogApps: state.catalogApps,
    cloudSyncSettings: { appSync: {} },
    emitRuntimeStatus: () => undefined,
    forgerAccount: { authenticated: false, token: null },
    fs: overrides.fs ?? fs,
    getCloudSyncSettingsPath: () => path.join(root, 'cloud-sync.json'),
    getPrivateAppsRoot: () => path.join(root, 'apps'),
    getRegistryBackupPath: () => path.join(root, 'registry.json.bak'),
    getRegistryPath: () => path.join(root, 'registry.json'),
    isDev: false,
    isVersionNewer: (candidate, current) => candidate !== current,
    localCatalogJsonUrl: undefined,
    setCatalogApps: (apps) => { state.catalogApps = apps; },
    setRegistry: (next) => { state.registry = next; },
    normalizeNodeRuntimeVersion: (value) => value ?? '22',
    normalizeVersionForFolder: (value) => value,
    path,
    registry,
    runningApps: overrides.runningApps ?? new Map(),
    serializeErrorForInstallLog: () => ({}),
    settings: {},
  });
  return { controller, state };
};

test('registry reconciliation ignores invalid manifests and avoids rewriting matching access flags', async (t) => {
  const root = await tempRoot(t, 'registry-reconcile');
  const arrayDir = path.join(root, 'apps', 'array');
  const matchingDir = path.join(root, 'apps', 'matching');
  await fs.mkdir(arrayDir, { recursive: true });
  await fs.mkdir(matchingDir, { recursive: true });
  await fs.writeFile(path.join(arrayDir, 'manifest.json'), '[]');
  await fs.writeFile(path.join(matchingDir, 'manifest.json'), JSON.stringify({ localNetworkShare: true, remoteTunnel: false }));
  const { controller } = registryController(root);
  const result = await controller.reconcileRegistryAccessFlags({ apps: {
    noDir: { appId: 'noDir', installDir: '' },
    array: { appId: 'array', installDir: arrayDir },
    matching: {
      appId: 'matching',
      installDir: matchingDir,
      localNetworkShareSupported: true,
      remoteTunnelSupported: false,
    },
  } });
  assert.equal(result.changed, false);
  assert.equal(result.registry.apps.matching.localNetworkShareSupported, true);
});

test('registry atomic save propagates fatal and exhausted rename errors without leaving temp files', async (t) => {
  const root = await tempRoot(t, 'registry-rename-errors');
  const immediateFs = {
    ...fs,
    rename: async () => { throw 'rename failed'; },
  };
  const immediate = registryController(root, { fs: immediateFs }).controller;
  await assert.rejects(() => immediate.upsertInstalledRecord({ appId: 'fatal', status: 'installed' }), (error) => error === 'rename failed');

  let attempts = 0;
  const previousSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback) => {
    callback();
    return 0;
  };
  try {
    const retryFs = {
      ...fs,
      rename: async () => {
        attempts += 1;
        const error = new Error('permission');
        error.code = 'EACCES';
        throw error;
      },
    };
    const exhausted = registryController(path.join(root, 'retry'), { fs: retryFs }).controller;
    await assert.rejects(() => exhausted.upsertInstalledRecord({ appId: 'retry', status: 'installed' }), /permission/);
    assert.equal(attempts, 4);
  } finally {
    globalThis.setTimeout = previousSetTimeout;
  }
});

test('registry catalog statuses distinguish stopped, running, and absent installed apps', async (t) => {
  const root = await tempRoot(t, 'registry-statuses');
  const registry = { apps: {
    stopped: { appId: 'stopped', status: 'installed', version: '1.0.0' },
    running: { appId: 'running', status: 'installed', version: '1.0.0' },
  } };
  const catalogApps = [
    { id: 'stopped', name: 'Stopped', version: '1.0.0', latestVersion: '2.0.0' },
    { id: 'running', name: 'Running', version: '1.0.0', latestVersion: '2.0.0' },
    { id: 'missing', name: 'Missing', version: '1.0.0', latestVersion: '2.0.0' },
  ];
  const { controller, state } = registryController(root, {
    registry,
    catalogApps,
    runningApps: new Map([['running', { backendUrl: 'http://127.0.0.1' }]]),
  });
  controller.ensureCatalogStatuses();
  assert.deepEqual(state.catalogApps.map(({ status }) => status), ['installed', 'running', 'not_installed']);
});
