import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  buildEffectiveDeveloperPathEntries,
  normalizeDeveloperPathEntries,
  validateDeveloperPathEntries,
} = require('../../dist-electron/main/runtime/developer-paths.js');
const { createDeveloperPathService } = require('../../dist-electron/main/core/developer-path-service.js');

test('developer PATH helpers normalize and validate absolute existing directories', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forger-developer-paths-'));
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  const binDir = path.join(root, 'bin');
  await fs.mkdir(binDir);
  const filePath = path.join(root, 'tool');
  await fs.writeFile(filePath, 'not a directory', 'utf8');

  assert.deepEqual(
    normalizeDeveloperPathEntries([binDir, `${binDir}/`, 'relative/bin', '~/bin', '$HOME/bin', binDir], path),
    [binDir],
  );
  assert.deepEqual(await validateDeveloperPathEntries([binDir], { fs, path }), [binDir]);
  await assert.rejects(
    validateDeveloperPathEntries([filePath], { fs, path }),
    /developer_path_invalid/,
  );
  await assert.rejects(
    validateDeveloperPathEntries([path.join(root, 'missing')], { fs, path }),
    /developer_path_invalid/,
  );
});

test('effective developer PATH keeps Forger runtimes before developer and system entries', () => {
  assert.deepEqual(
    buildEffectiveDeveloperPathEntries({
      enabled: true,
      runtimePathEntries: ['/forger/node', '/forger/python'],
      globalPathEntries: ['/opt/homebrew/bin'],
      appPathEntries: ['/Applications/Docker.app/Contents/Resources/bin'],
      systemPath: ['/usr/bin', '/opt/homebrew/bin'].join(path.delimiter),
      delimiter: path.delimiter,
    }),
    [
      '/forger/node',
      '/forger/python',
      '/opt/homebrew/bin',
      '/Applications/Docker.app/Contents/Resources/bin',
      '/usr/bin',
    ],
  );
  assert.deepEqual(
    buildEffectiveDeveloperPathEntries({
      enabled: false,
      runtimePathEntries: ['/forger/node'],
      globalPathEntries: ['/opt/homebrew/bin'],
      appPathEntries: ['/docker/bin'],
      systemPath: '/usr/bin',
      delimiter: path.delimiter,
    }),
    ['/forger/node', '/usr/bin'],
  );
});

test('developer path service merges runtime, global, app, and system PATH entries', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forger-developer-path-service-'));
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  const globalBin = path.join(root, 'global-bin');
  const appBin = path.join(root, 'app-bin');
  await fs.mkdir(globalBin);
  await fs.mkdir(appBin);

  let settings = { developerMode: { enabled: true, pathEntries: [globalBin] } };
  const registry = {
    apps: {
      demo: {
        id: 'demo',
        path: root,
        requiredNodeVersion: '20',
        requiredPythonVersion: '3.12',
        developerPathEntries: [appBin],
      },
    },
  };
  const service = createDeveloperPathService({
    defaultNodeVersion: '22',
    ensureRuntimeInstalled: async (type, version) => ({ binDir: `/forger/${type}-${version}` }),
    fs,
    getAppLocalToolPathEntries: async () => ['/app-local-tools'],
    getRuntimePathEntries: (runtime) => [runtime.binDir],
    normalizeNodeRuntimeVersion: (version) => version ?? '22',
    normalizeSettings: (input) => input,
    path,
    registry,
    settings: () => settings,
    systemPath: () => ['/usr/bin', globalBin].join(path.delimiter),
    upsertInstalledRecord: async (record) => {
      registry.apps[record.id] = record;
    },
  });

  assert.deepEqual(await service.getAgentPathEntries('demo'), [
    '/forger/node-22',
    '/app-local-tools',
    '/forger/node-20',
    '/forger/python-3.12',
    globalBin,
    appBin,
  ]);
  assert.deepEqual(await service.getDeveloperPathState('demo'), {
    enabled: true,
    globalPathEntries: [globalBin],
    appPathEntries: [appBin],
    runtimePathEntries: ['/forger/node-22', '/app-local-tools', '/forger/node-20', '/forger/python-3.12'],
    systemPathEntries: ['/usr/bin', globalBin],
    effectivePathEntries: ['/forger/node-22', '/app-local-tools', '/forger/node-20', '/forger/python-3.12', globalBin, appBin, '/usr/bin'],
  });

  const updated = await service.updateAppDeveloperSettings({ appId: 'demo', pathEntries: [globalBin] });
  assert.deepEqual(registry.apps.demo.developerPathEntries, [globalBin]);
  assert.deepEqual(updated.appPathEntries, [globalBin]);

  await assert.rejects(
    service.updateAppDeveloperSettings({ appId: 'missing', pathEntries: [] }),
    /developer_app_not_installed/,
  );
  settings = { developerMode: { enabled: false, pathEntries: [globalBin] } };
  assert.deepEqual(await service.getAgentPathEntries(), ['/forger/node-22']);
});
