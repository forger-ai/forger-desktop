import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createLocalAppCreator } = require('../../dist-electron/main/installed-apps/local-app-creator.js');

const tmpRoot = async (name) => await fs.mkdtemp(path.join(os.tmpdir(), `forger-${name}-`));

const writeSkeleton = async (root) => {
  const skeletonRoot = path.join(root, 'skeletons', 'vite-fastapi-sqlite');
  await fs.mkdir(path.join(skeletonRoot, 'backend'), { recursive: true });
  await fs.mkdir(path.join(skeletonRoot, 'frontend'), { recursive: true });
  await fs.mkdir(path.join(skeletonRoot, '.git'), { recursive: true });
  await fs.writeFile(path.join(skeletonRoot, '.git', 'config'), '[core]\n', 'utf8');
  await fs.writeFile(path.join(skeletonRoot, 'backend', 'pyproject.toml'), '[project]\nname="demo"\n', 'utf8');
  await fs.writeFile(path.join(skeletonRoot, 'frontend', 'package.json'), '{"scripts":{}}\n', 'utf8');
  await fs.writeFile(path.join(skeletonRoot, 'frontend', 'index.html'), '<!doctype html><html><head><title>Skeleton App</title></head><body></body></html>\n', 'utf8');
  await fs.writeFile(path.join(skeletonRoot, 'AGENTS.md'), '# AGENTS\n', 'utf8');
  await fs.writeFile(path.join(skeletonRoot, 'manifest.json'), JSON.stringify({
    name: 'vite-fastapi-sqlite-skeleton',
    version: '0.1.0',
    description: 'Skeleton',
    catalog: {
      display_name: 'Skeleton',
      capabilities: [{ id: 'local_app_data' }],
    },
    stack: {
      backend: { python_version: '3.12' },
      frontend: { node_version: '24' },
    },
    services: [],
    tools: { required: ['legacy'], optional: ['legacy'] },
    cloudMessaging: { enabled: true },
  }, null, 2), 'utf8');
  return skeletonRoot;
};

const createController = (root, skeletonRoot, overrides = {}) => {
  const registry = { apps: {} };
  const calls = [];
  const progress = [];
  const appPath = path.join(root, 'desktop');
  const app = overrides.app ?? {
    isPackaged: false,
    getAppPath: () => appPath,
  };
  return {
    calls,
    progress,
    registry,
    controller: createLocalAppCreator({
      DEFAULT_NODE_VERSION: '22',
      DEFAULT_PYTHON_VERSION: '3.12',
      appendInstallLog: async (event, payload) => calls.push(['log', event, payload]),
      app,
      emitInstallProgress: (appId, payload) => progress.push([appId, payload]),
      failureDiagnostic: (error, fallbackCode) => ({
        technicalCode: error instanceof Error ? error.message : fallbackCode,
      }),
      fs,
      getPrivateAppsRoot: () => path.join(root, 'Forger', 'apps'),
      installAppDependencies: overrides.installAppDependencies ?? (async (appId, installDir) => calls.push(['installDeps', appId, installDir])),
      normalizeInstalledAgentContext: async (installDir, appId) => calls.push(['normalizeContext', installDir, appId]),
      path,
      registry,
      serializeErrorForInstallLog: (error) => ({ message: error instanceof Error ? error.message : String(error) }),
      upsertInstalledRecord: async (record) => {
        registry.apps[record.appId] = record;
      },
      ensureAppGitRepository: async (cwd) => calls.push(['gitInit', cwd]),
      ensureUserModifiedBranch: async (cwd) => calls.push(['userBranch', cwd]),
      getOriginalCommitSha: overrides.getOriginalCommitSha ?? (async () => 'initial-sha'),
    }),
    skeletonRoot,
  };
};

test('local app creator copies the skeleton, scrubs git metadata, writes manifest, and registers app', async (t) => {
  const root = await tmpRoot('local-app-create');
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  const skeletonRoot = await writeSkeleton(root);
  const { controller, calls, progress, registry } = createController(root, skeletonRoot);

  const result = await controller.createLocalAppFromSkeleton({
    name: 'Mi App de Clientes',
    description: 'Gestiona clientes locales.',
    purpose: 'Quiero guardar clientes, tareas y notas sin usar cloud.',
    lookAndFeel: 'Command center: sobrio, denso y operativo.',
  });

  assert.equal(result.success, true);
  assert.equal(result.app.appId, 'mi-app-de-clientes');
  assert.equal(result.app.lookAndFeel, 'Command center: sobrio, denso y operativo.');
  const installDir = path.join(root, 'Forger', 'apps', 'mi-app-de-clientes');
  await assert.rejects(fs.stat(path.join(installDir, '.git')));
  assert.equal(await fs.readFile(path.join(installDir, 'AGENTS.md'), 'utf8'), '# AGENTS\n');
  const manifest = JSON.parse(await fs.readFile(path.join(installDir, 'manifest.json'), 'utf8'));
  assert.equal(manifest.name, 'mi-app-de-clientes');
  assert.equal(manifest.catalog.display_name, 'Mi App de Clientes');
  assert.match(await fs.readFile(path.join(installDir, 'frontend', 'index.html'), 'utf8'), /<title>Mi App de Clientes<\/title>/);
  assert.equal(manifest.catalog.capabilities, undefined);
  assert.equal(manifest.localNetworkShare, true);
  assert.equal(manifest.remoteTunnel, true);
  assert.deepEqual(manifest.tools, { required: [], optional: [] });
  assert.deepEqual(manifest.appSecrets, []);
  assert.deepEqual(manifest.promptTemplates, []);
  assert.deepEqual(manifest.agents, []);
  assert.equal(manifest.cloudMessaging.enabled, false);
  assert.equal(registry.apps['mi-app-de-clientes'].status, 'installed');
  assert.equal(registry.apps['mi-app-de-clientes'].privateLocal, true);
  assert.equal(registry.apps['mi-app-de-clientes'].originalCommitSha, 'initial-sha');
  assert.equal(registry.apps['mi-app-de-clientes'].localNetworkShareSupported, true);
  assert.equal(registry.apps['mi-app-de-clientes'].remoteTunnelSupported, true);
  assert.ok(calls.some(([name]) => name === 'gitInit'));
  assert.ok(calls.some(([name]) => name === 'userBranch'));
  assert.ok(calls.some(([name]) => name === 'installDeps'));
  assert.equal(progress.at(-1)[1].phase, 'completed');
});

test('local app creator generates unique slugs and validates required fields', async (t) => {
  const root = await tmpRoot('local-app-slug');
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  const skeletonRoot = await writeSkeleton(root);
  const { controller, registry } = createController(root, skeletonRoot);
  registry.apps['demo'] = { appId: 'demo', installDir: path.join(root, 'Forger', 'apps', 'demo') };

  const missing = await controller.createLocalAppFromSkeleton({
    name: 'Demo',
    description: '',
    purpose: 'Purpose',
  });
  assert.equal(missing.success, false);
  assert.equal(missing.technicalCode, 'local_app_create_missing_fields');

  const created = await controller.createLocalAppFromSkeleton({
    name: 'Demo',
    description: 'Description',
    purpose: 'Purpose',
  });
  assert.equal(created.success, true);
  assert.equal(created.app.appId, 'demo-2');

  await fs.mkdir(path.join(root, 'Forger', 'apps', 'taken'), { recursive: true });
  const taken = await controller.createLocalAppFromSkeleton({
    name: 'Taken',
    description: 'Description',
    purpose: 'Purpose',
  });
  assert.equal(taken.success, true);
  assert.equal(taken.app.appId, 'taken-2');

  for (let index = 0; index < 100; index += 1) {
    const suffix = index === 0 ? '' : `-${index + 1}`;
    registry.apps[`blocked${suffix}`] = { appId: `blocked${suffix}` };
  }
  await assert.rejects(
    controller.createLocalAppFromSkeleton({
      name: 'Blocked',
      description: 'Description',
      purpose: 'Purpose',
    }),
    /app_slug_unavailable/,
  );
  assert.equal(controller.slugify('***'), 'my-app');
  assert.equal(controller.updateManifest({ catalog: [] }, {
    appId: 'fallback-description',
    name: 'Fallback',
    description: '',
    purpose: 'Purpose fallback',
  }).description, 'Purpose fallback');
});

test('local app creator handles packaged skeletons, missing titles, and failure diagnostics', async (t) => {
  const root = await tmpRoot('local-app-packaged');
  const previousResourcesPath = process.resourcesPath;
  t.after(async () => {
    if (previousResourcesPath === undefined) {
      delete process.resourcesPath;
    } else {
      Object.defineProperty(process, 'resourcesPath', {
        configurable: true,
        value: previousResourcesPath,
      });
    }
    await fs.rm(root, { recursive: true, force: true });
  });

  Object.defineProperty(process, 'resourcesPath', {
    configurable: true,
    value: root,
  });
  const skeletonRoot = path.join(root, 'app-skeletons', 'vite-fastapi-sqlite');
  await writeSkeleton(path.join(root, 'unused'));
  await fs.mkdir(path.dirname(skeletonRoot), { recursive: true });
  await fs.cp(path.join(root, 'unused', 'skeletons', 'vite-fastapi-sqlite'), skeletonRoot, { recursive: true });
  await fs.writeFile(
    path.join(skeletonRoot, 'frontend', 'index.html'),
    '<!doctype html><html><head></head><body></body></html>\n',
    'utf8',
  );

  const packaged = createController(root, skeletonRoot, {
    app: {
      isPackaged: true,
      getAppPath: () => path.join(root, 'ignored'),
    },
  }).controller;
  const created = await packaged.createLocalAppFromSkeleton({
    name: 'Clientes & Ventas <local>',
    description: 'Description',
    purpose: 'Purpose',
  });
  assert.equal(created.success, true);
  const html = await fs.readFile(
    path.join(root, 'Forger', 'apps', 'clientes-ventas-local', 'frontend', 'index.html'),
    'utf8',
  );
  assert.match(html, /<title>Clientes &amp; Ventas &lt;local&gt;<\/title>/);

  await fs.rm(path.join(skeletonRoot, 'frontend', 'index.html'), { force: true });
  const withoutHtml = await packaged.createLocalAppFromSkeleton({
    name: 'No Html',
    description: 'Description',
    purpose: 'Purpose',
  });
  assert.equal(withoutHtml.success, true);
  await assert.rejects(
    fs.stat(path.join(root, 'Forger', 'apps', 'no-html', 'frontend', 'index.html')),
    /ENOENT/,
  );

  await fs.rm(skeletonRoot, { recursive: true, force: true });
  const missingSkeleton = await packaged.createLocalAppFromSkeleton({
    name: 'Missing Skeleton',
    description: 'Description',
    purpose: 'Purpose',
  });
  assert.equal(missingSkeleton.success, false);
  assert.equal(missingSkeleton.technicalCode, 'app_skeleton_not_found');

  await fs.cp(path.join(root, 'unused', 'skeletons', 'vite-fastapi-sqlite'), skeletonRoot, { recursive: true });
  await fs.rm(path.join(skeletonRoot, 'frontend', 'index.html'), { force: true });
  await fs.mkdir(path.join(skeletonRoot, 'frontend', 'index.html'), { recursive: true });
  const unreadableHtml = await packaged.createLocalAppFromSkeleton({
    name: 'Unreadable Html',
    description: 'Description',
    purpose: 'Purpose',
  });
  assert.equal(unreadableHtml.success, false);
  assert.match(unreadableHtml.technicalCode, /EISDIR/);

  await fs.rm(skeletonRoot, { recursive: true, force: true });
  await fs.cp(path.join(root, 'unused', 'skeletons', 'vite-fastapi-sqlite'), skeletonRoot, { recursive: true });
  const failing = createController(root, skeletonRoot, {
    app: {
      isPackaged: true,
      getAppPath: () => path.join(root, 'ignored'),
    },
    installAppDependencies: async () => {
      throw new Error('dependency_install_failed');
    },
  }).controller;
  const failed = await failing.createLocalAppFromSkeleton({
    name: 'Install Failure',
    description: 'Description',
    purpose: 'Purpose',
  });
  assert.equal(failed.success, false);
  assert.equal(failed.technicalCode, 'dependency_install_failed');
});
