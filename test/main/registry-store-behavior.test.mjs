import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createRegistryStoreController } = require('../../dist-electron/main/installed-apps/registry-store.js');

const tmpRoot = async (name) => await fs.mkdtemp(path.join(os.tmpdir(), `forger-${name}-`));

const createController = (root, overrides = {}) => {
  const registryPath = path.join(root, 'app_registry.json');
  const backupPath = `${registryPath}.bak`;
  const cloudSyncSettingsPath = path.join(root, 'cloud-sync.json');
  const emitted = [];
  const logs = [];
  const registry = overrides.registry ?? { apps: {} };
  const controller = createRegistryStoreController({
    DEFAULT_NODE_VERSION: '22',
    DEFAULT_PYTHON_VERSION: '3.12',
    DevCatalogService: overrides.DevCatalogService ?? class {},
    app: {},
    appendInstallLog: async (event, payload) => {
      logs.push({ event, payload });
    },
    catalogApps: overrides.catalogApps ?? [],
    cloudSyncSettings: overrides.cloudSyncSettings ?? { appSync: {} },
    emitRuntimeStatus: (payload) => {
      emitted.push(payload);
    },
    forgerAccount: overrides.forgerAccount ?? { authenticated: false, token: null },
    fs: overrides.fs ?? fs,
    getCloudSyncSettingsPath: () => cloudSyncSettingsPath,
    getRegistryBackupPath: () => backupPath,
    getRegistryPath: () => registryPath,
    isDev: overrides.isDev ?? false,
    isVersionNewer: (candidate, current) => candidate === '2.0.0' && current !== '2.0.0',
    localCatalogJsonUrl: null,
    normalizeNodeRuntimeVersion: (value) => {
      const match = String(value ?? '').match(/\d+/);
      return match?.[0] ?? '22';
    },
    normalizeVersionForFolder: (value) => value.replace(/^python-/, '') || '3.12',
    path,
    registry,
    runningApps: overrides.runningApps ?? new Map(),
    serializeErrorForInstallLog: (error) => ({ message: error instanceof Error ? error.message : String(error) }),
    settings: {},
  });
  return { controller, emitted, logs, registryPath, backupPath, cloudSyncSettingsPath };
};

test('registry store parses only object registries and normalizes runtime versions', async (t) => {
  const root = await tmpRoot('registry-parse');
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  const { controller } = createController(root);

  assert.equal(controller.parseRegistry('{"notApps":{}}'), null);
  assert.equal(controller.parseRegistry('{"apps":null}'), null);
  assert.deepEqual(controller.parseRegistry('{"apps":{"demo":{"appId":"demo"}}}'), {
    apps: { demo: { appId: 'demo' } },
  });

  const normalized = controller.normalizeRegistryRuntimeVersions({
    apps: {
      demo: {
        appId: 'demo',
        requiredNodeVersion: 'node-v20.11.1',
        requiredPythonVersion: 'python-3.11',
      },
      defaults: { appId: 'defaults' },
    },
  });

  assert.equal(normalized.changed, true);
  assert.equal(normalized.registry.apps.demo.requiredNodeVersion, '20');
  assert.equal(normalized.registry.apps.demo.requiredPythonVersion, '3.11');
  assert.equal(normalized.registry.apps.defaults.requiredNodeVersion, '22');
  assert.equal(normalized.registry.apps.defaults.requiredPythonVersion, '3.12');

  assert.equal(controller.normalizeRegistryRuntimeVersions({
    apps: {
      ready: {
        appId: 'ready',
        requiredNodeVersion: '22',
        requiredPythonVersion: '3.12',
      },
    },
  }).changed, false);
});

test('registry store saves atomically, backs up the previous valid registry, and emits status', async (t) => {
  const root = await tmpRoot('registry-save');
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  const previous = {
    apps: {
      old: { appId: 'old', name: 'Old', version: '0.1.0', status: 'installed' },
    },
  };
  const { controller, emitted, registryPath, backupPath } = createController(root);
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(registryPath, JSON.stringify(previous), 'utf8');

  await controller.upsertInstalledRecord({
    appId: 'demo',
    name: 'Demo',
    version: '1.0.0',
    status: 'installing',
    installDir: path.join(root, 'apps', 'demo'),
    userMessage: 'Installing',
    requiredNodeVersion: 'node-v18.19.0',
    requiredPythonVersion: '',
  });

  const saved = JSON.parse(await fs.readFile(registryPath, 'utf8'));
  const backup = JSON.parse(await fs.readFile(backupPath, 'utf8'));
  assert.deepEqual(backup, previous);
  assert.equal(saved.apps.demo.requiredNodeVersion, '18');
  assert.equal(saved.apps.demo.requiredPythonVersion, '3.12');
  assert.deepEqual(emitted, [
    {
      appId: 'demo',
      status: 'installing',
      userMessage: 'Installing',
      backendUrl: undefined,
      frontendUrl: undefined,
    },
  ]);
});

test('registry store loads from backup when primary is corrupt and persists normalized recovery state', async (t) => {
  const root = await tmpRoot('registry-corrupt');
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  const { controller, registryPath, backupPath } = createController(root);
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(registryPath, '{bad json', 'utf8');
  await fs.writeFile(backupPath, JSON.stringify({
    apps: {
      backup: {
        appId: 'backup',
        name: 'Backup',
        version: '1.0.0',
        status: 'installed',
        requiredNodeVersion: 'node-v16.0.0',
        requiredPythonVersion: 'python-3.10',
      },
    },
  }), 'utf8');

  await controller.loadRegistry();
  await controller.upsertInstalledRecord({
    appId: 'new',
    name: 'New',
    version: '1.0.0',
    status: 'installed',
  });

  const saved = JSON.parse(await fs.readFile(registryPath, 'utf8'));
  assert.deepEqual(Object.keys(saved.apps).sort(), ['backup', 'new']);
  assert.equal(saved.apps.backup.requiredNodeVersion, '16');
  assert.equal(saved.apps.backup.requiredPythonVersion, '3.10');
  assert.equal(saved.apps.new.requiredNodeVersion, '22');
  assert.equal(saved.apps.new.requiredPythonVersion, '3.12');
});

test('registry store handles corrupted cloud sync settings, app auto-sync, cloud eligibility, removal, and catalog statuses', async (t) => {
  const root = await tmpRoot('registry-settings');
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  const runningApps = new Map([['demo', { backendUrl: 'http://127.0.0.1:1', frontendUrl: 'http://127.0.0.1:2' }]]);
  const catalogApps = [
    { id: 'demo', name: 'Demo', version: '1.0.0', latestVersion: '2.0.0' },
    { id: 'missing', name: 'Missing', version: '1.0.0', latestVersion: '1.0.0' },
  ];
  const { controller, emitted, cloudSyncSettingsPath, registryPath } = createController(root, {
    catalogApps,
    runningApps,
    forgerAccount: { authenticated: true, token: 'token', user: { subscriptionTier: 'pro' } },
  });
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(cloudSyncSettingsPath, '{bad json', 'utf8');

  await controller.loadCloudSyncSettings();
  assert.deepEqual(await controller.setAppAutoSyncSetting('demo', true), { appSync: { demo: { autoSync: true } } });
  assert.deepEqual(JSON.parse(await fs.readFile(cloudSyncSettingsPath, 'utf8')), { appSync: { demo: { autoSync: true } } });
  assert.equal(controller.canUseCloudDataSync(), true);

  await controller.upsertInstalledRecord({
    appId: 'demo',
    name: 'Demo',
    version: '1.0.0',
    status: 'installed',
    userMessage: 'Ready',
  });
  controller.ensureCatalogStatuses();
  assert.equal(catalogApps[0].status, undefined, 'controller keeps catalog state internally and does not mutate caller array');
  assert.equal(emitted.at(-1).status, 'running');
  assert.equal(emitted.at(-1).backendUrl, 'http://127.0.0.1:1');

  await controller.removeInstalledRecord('demo');
  const saved = JSON.parse(await fs.readFile(registryPath, 'utf8'));
  assert.deepEqual(saved.apps, {});
});

test('registry store covers dev catalog startup, empty recovery, and atomic write cleanup failures', async (t) => {
  const root = await tmpRoot('registry-edges');
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const previousLocalApps = process.env.FORGER_LOCAL_APPS;
  const previousWarn = console.warn;
  t.after(() => {
    if (previousLocalApps === undefined) {
      delete process.env.FORGER_LOCAL_APPS;
    } else {
      process.env.FORGER_LOCAL_APPS = previousLocalApps;
    }
    console.warn = previousWarn;
  });

  process.env.FORGER_LOCAL_APPS = `${root}/apps`;
  console.warn = () => undefined;
  class StartedDevCatalogService {
    url = 'http://127.0.0.1:4411/catalog.json';

    async start() {}
  }
  const successfulDev = createController(root, {
    DevCatalogService: StartedDevCatalogService,
    isDev: true,
  });
  await successfulDev.controller.startDevCatalogService();
  assert.equal(successfulDev.logs.some((entry) => entry.event === 'dev_catalog:start'), true);

  class FailingDevCatalogService {
    async start() {
      throw new Error('dev_catalog_boom');
    }
  }
  const failingDev = createController(root, {
    DevCatalogService: FailingDevCatalogService,
    isDev: true,
  });
  await failingDev.controller.startDevCatalogService();
  assert.equal(failingDev.logs.some((entry) => entry.event === 'dev_catalog:failed'), true);

  const emptyRecovery = createController(root);
  await emptyRecovery.controller.loadRegistry();
  await emptyRecovery.controller.upsertInstalledRecord({
    appId: 'empty',
    name: 'Empty',
    version: '1.0.0',
    status: 'installed',
  });
  assert.deepEqual(Object.keys(JSON.parse(await fs.readFile(emptyRecovery.registryPath, 'utf8')).apps), ['empty']);

  const closeCalls = [];
  await emptyRecovery.controller.syncDirectory(path.join(root, 'missing-dir'));
  await emptyRecovery.controller.syncDirectory(root);
  const fakeFs = {
    ...fs,
    open: async (target, flags) => {
      if (flags === 'w') {
        return {
          writeFile: async () => undefined,
          sync: async () => {
            throw new Error('sync_failed');
          },
          close: async () => {
            closeCalls.push(target);
          },
        };
      }
      return await fs.open(target, flags);
    },
  };
  const failingSave = createController(root, { fs: fakeFs });
  await assert.rejects(
    failingSave.controller.upsertInstalledRecord({
      appId: 'fail',
      name: 'Fail',
      version: '1.0.0',
      status: 'installed',
    }),
    /sync_failed/,
  );
  assert.equal(closeCalls.length, 1);
});

test('registry store tolerates malformed persisted shapes and no-op dev catalog settings', async (t) => {
  const root = await tmpRoot('registry-malformed-shapes');
  const previousLocalApps = process.env.FORGER_LOCAL_APPS;
  t.after(async () => {
    if (previousLocalApps === undefined) {
      delete process.env.FORGER_LOCAL_APPS;
    } else {
      process.env.FORGER_LOCAL_APPS = previousLocalApps;
    }
    await fs.rm(root, { recursive: true, force: true });
  });

  const noDev = createController(root, { isDev: true });
  delete process.env.FORGER_LOCAL_APPS;
  await noDev.controller.startDevCatalogService();
  assert.deepEqual(noDev.logs, []);

  const { controller, registryPath, cloudSyncSettingsPath, emitted } = createController(root, {
    cloudSyncSettings: { appSync: { existing: { autoSync: false } } },
    runningApps: new Map([['demo', { backendUrl: 'http://backend', frontendUrl: 'http://frontend' }]]),
  });
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(registryPath, JSON.stringify({ apps: [] }), 'utf8');
  await fs.writeFile(cloudSyncSettingsPath, JSON.stringify({ appSync: [] }), 'utf8');

  await controller.loadRegistry();
  await controller.loadCloudSyncSettings();
  assert.deepEqual(await controller.setAppAutoSyncSetting('demo', false), { appSync: { demo: { autoSync: false } } });

  await fs.writeFile(cloudSyncSettingsPath, JSON.stringify({ appSync: 0 }), 'utf8');
  await controller.loadCloudSyncSettings();
  assert.deepEqual(await controller.setAppAutoSyncSetting('other', true), { appSync: { other: { autoSync: true } } });

  await controller.upsertInstalledRecord({
    appId: 'demo',
    name: 'Demo',
    version: '1.0.0',
    status: 'installed',
    userMessage: 'Ready',
  });
  assert.deepEqual(emitted.at(-1), {
    appId: 'demo',
    status: 'running',
    userMessage: 'Ready',
    backendUrl: 'http://backend',
    frontendUrl: 'http://frontend',
  });
});
