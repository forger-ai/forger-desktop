import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { createLocalAppCreator } = require('../../dist-electron/main/installed-apps/local-app-creator.js');

test('BDD: local app generation preserves non-SQLite URLs, absent service environments, and an explicit agent prompt', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forger-b31-local-app-'));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const skeleton = path.join(root, 'skeletons', 'vite-fastapi-sqlite');
  await fs.mkdir(path.join(skeleton, 'frontend'), { recursive: true });
  await fs.writeFile(path.join(skeleton, 'frontend', 'index.html'), '<html><head><title>Skeleton</title></head></html>');
  await fs.writeFile(path.join(skeleton, 'manifest.json'), JSON.stringify({
    stack: {},
    services: [
      { name: 'worker' },
      { name: 'backend', environment: { DATABASE_URL: 'postgres://database/app' } },
    ],
  }));
  const registry = { apps: {} };
  const controller = createLocalAppCreator({
    DEFAULT_NODE_VERSION: '22', DEFAULT_PYTHON_VERSION: '3.12', appendInstallLog: async () => {},
    app: { isPackaged: false, getAppPath: () => path.join(root, 'desktop') }, emitInstallProgress: () => {},
    failureDiagnostic: (_error, fallbackCode) => ({ technicalCode: fallbackCode }), fs,
    getPrivateAppsRoot: () => path.join(root, 'Forger', 'apps'), installAppDependencies: async () => {},
    normalizeInstalledAgentContext: async () => {}, path, registry, serializeErrorForInstallLog: () => ({}),
    upsertInstalledRecord: async (record) => { registry.apps[record.appId] = record; },
    ensureAppGitRepository: async () => {}, ensureUserModifiedBranch: async () => {}, getOriginalCommitSha: async () => undefined,
  });
  const result = await controller.createLocalAppFromSkeleton({
    name: 'Database App', description: 'Description', purpose: 'Purpose', agentPrompt: 'Review every change.',
  });
  assert.equal(result.success, true);
  assert.equal(result.app.agentPrompt, 'Review every change.');
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'Forger', 'apps', 'database-app', 'manifest.json'), 'utf8'));
  assert.equal('environment' in manifest.services[0], false);
  assert.equal(manifest.services[1].environment.DATABASE_URL, 'postgres://database/app');
});
