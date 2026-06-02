/* eslint-disable max-lines */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createInstalledAppLifecycleController } = require('../../dist-electron/main/installed-apps/lifecycle.js');
const { createInstalledAppRuntimeController } = require('../../dist-electron/main/runtime/installed-app-runtime.js');
const { createAppContextSupportController } = require('../../dist-electron/main/apps/context-support.js');

const tmpRoot = async (name) => await fs.mkdtemp(path.join(os.tmpdir(), `forger-${name}-`));

const catalogApp = {
  id: 'demo-app',
  name: 'Demo App',
  description: 'Local demo',
  category: 'productivity',
  latestVersion: '1.0.0',
  downloadUrl: 'https://example.invalid/demo.zip',
  requiredPythonVersion: '3.12.0',
};

const makeLifecycleHarness = async (overrides = {}) => {
  const root = await tmpRoot('installed-lifecycle');
  const privateAppsRoot = path.join(root, 'apps');
  const tempRoot = path.join(root, 'tmp');
  const forgerRoot = path.join(root, 'forger-home');
  const metadataRoot = path.join(root, 'metadata');
  const registry = { apps: {} };
  const calls = [];
  const upsertInstalledRecord = async (record) => {
    registry.apps[record.appId] = { ...record };
    calls.push(['upsert', record.appId, record.status, record.version]);
  };
  const appendInstallLog = async (event, payload = {}) => {
    calls.push(['log', event, payload.appId]);
  };
  const failureDiagnostic = (error, fallbackCode) => ({
    technicalCode: error instanceof Error ? error.message : fallbackCode,
    details: { fallbackCode },
  });
  const runtimeError = (userMessage, technicalCode, phase = 'failed') => ({
    success: false,
    phase,
    userMessage,
    progress: 1,
    technicalCode,
  });
  const deps = {
    DEFAULT_NODE_VERSION: '22.0.0',
    DEFAULT_PYTHON_VERSION: '3.12.0',
    appendInstallLog,
    app: { getPath: () => root },
    backendPythonEnvironmentLocks: new Map(),
    catalogApps: [catalogApp],
    clearMacQuarantine: async (target) => calls.push(['quarantine', target]),
    closeAppWindow: () => undefined,
    collectPersistentInstallPaths: () => ['backend/data'],
    copyReleaseContentsForUpdate: async () => calls.push(['copyReleaseContentsForUpdate']),
    emitInstallProgress: (appId, payload) => calls.push(['installProgress', appId, payload.phase]),
    emitRuntimeStatus: (payload) => calls.push(['runtimeStatus', payload.appId, payload.status]),
    ensureAppGitRepository: async (cwd) => calls.push(['ensureGit', cwd]),
    ensureCatalogStatuses: () => calls.push(['catalogStatuses']),
    ensureGlobalAgentsContext: async (target) => {
      calls.push(['globalContext', target]);
      await fs.mkdir(target, { recursive: true });
    },
    ensureRuntimeInstalled: async (type, version) => {
      calls.push(['runtime', type, version]);
      return type === 'node'
        ? { node: path.join(root, 'node'), npm: path.join(root, 'npm') }
        : { python: path.join(root, 'python'), pip: path.join(root, 'pip') };
    },
    ensureUserModifiedBranch: async (cwd) => calls.push(['ensureUserBranch', cwd]),
    extractArchive: async (_archivePath, destination) => {
      calls.push(['extract', destination]);
      await fs.mkdir(path.join(destination, 'backend', 'data'), { recursive: true });
      await fs.mkdir(path.join(destination, 'frontend'), { recursive: true });
      await fs.writeFile(path.join(destination, 'backend', 'data', 'app.sqlite3'), 'db', 'utf8');
      await fs.writeFile(path.join(destination, 'manifest.json'), JSON.stringify({
        name: 'demo-app',
        version: '1.0.0',
        services: [{ name: 'backend', volumes: [{ source: 'backend/data', persist: true }] }],
      }), 'utf8');
    },
    failureDiagnostic,
    flattenSingleTopLevelDirectory: async (target) => calls.push(['flatten', target]),
    forgerBackendClient: null,
    fs,
    getBackupsManager: () => ({
      createBackup: async ({ appId, reason }) => {
        calls.push(['backup', appId, reason]);
        return {
          success: true,
          backup: {
            appId,
            appName: 'Demo App',
            appVersion: registry.apps[appId]?.version ?? '0.0.0',
            backupId: 'backup-1',
            createdAt: new Date().toISOString(),
            reason,
            fileCount: 1,
            totalBytes: 2,
            files: [],
          },
        };
      },
    }),
    getForgerHomeRoot: () => forgerRoot,
    getForgerMetadataRoot: () => metadataRoot,
    getGitHead: async () => 'user-head',
    getInstallLogPath: () => path.join(root, 'install.log'),
    getLegacyForgerMetadataRoot: () => path.join(root, 'legacy'),
    getOfficialToolsService: () => ({ getInstallGate: async () => ({ canInstall: true }) }),
    getOriginalCommitSha: async () => 'original-sha',
    getPrivateAppsRoot: () => privateAppsRoot,
    getRuntimeStatus: (appId) => ({ appId, status: registry.apps[appId]?.status ?? 'not_installed' }),
    getTempRoot: () => tempRoot,
    getUserVisibleGitStatusLines: async () => [],
    gitCommitAllExcept: async (_cwd, message, excluded) => {
      calls.push(['commitExcept', message, excluded.join(',')]);
      return 'base-sha';
    },
    installAppDependencies: async (appId, installDir, nodeVersion, pythonVersion, publishProgress) => {
      calls.push(['installAppDependencies', appId, installDir, nodeVersion, pythonVersion]);
      await publishProgress('installing_backend', 'backend');
      await publishProgress('installing_frontend', 'frontend');
    },
    installFrontendDependenciesWithNpm: async (nodePath, npmPath, frontendDir, appId) => {
      calls.push(['frontendDeps', nodePath, npmPath, frontendDir, appId]);
    },
    isVersionNewer: (candidate, current) => candidate !== current,
    listAppPrompts: async () => [],
    listCatalogFromBackend: async () => [catalogApp],
    normalizeInstalledAgentContext: async (installDir, appId) => calls.push(['agentContext', installDir, appId]),
    normalizeNodeRuntimeVersion: (value) => value ?? '22.0.0',
    normalizeVersionForFolder: (value) => value,
    openInstalledAppUnlocked: async (appId) => ({ success: true, userMessage: 'opened', appId }),
    path,
    registry,
    removeInstalledRecord: async (appId) => {
      delete registry.apps[appId];
      calls.push(['remove', appId]);
    },
    resolveInstalledAgents: async () => [],
    resolveInstalledManifest: async (installDir) => JSON.parse(await fs.readFile(path.join(installDir, 'manifest.json'), 'utf8')),
    resolveInstalledPromptTemplates: async () => [],
    resolvePlatformAlias: () => 'darwin_arm64',
    runCommand: async (command, args, options) => calls.push(['run', command, args.join(' '), options.cwd]),
    runCommandCapture: async (command, args, options) => {
      calls.push(['capture', command, args.join(' '), options.cwd]);
      return { code: 0, stdout: '', stderr: '' };
    },
    runningApps: new Map(),
    runtimeError,
    serializeErrorForInstallLog: (error) => ({ message: error instanceof Error ? error.message : String(error) }),
    stopInstalledApp: async (appId) => ({ success: true, userMessage: `stopped ${appId}` }),
    syncAppToCloudIfEnabled: async (appId) => calls.push(['cloudSync', appId]),
    syncReleaseIntoInstalledApp: async (sourceDir, targetDir, preservedPaths) => {
      calls.push(['syncRelease', sourceDir, targetDir, preservedPaths.join(',')]);
      await fs.cp(sourceDir, targetDir, { recursive: true, force: true });
    },
    toAppSummary: (record) => ({ appId: record.appId, name: record.name, status: record.status, version: record.version }),
    truncateForInstallLog: (value) => value.slice(0, 1000),
    upsertInstalledRecord,
    validateArchiveEntries: async (archivePath) => calls.push(['validateArchive', archivePath]),
    ...overrides,
  };
  return { root, registry, calls, controller: createInstalledAppLifecycleController(deps), deps };
};

const seedInstalledApp = async (root, registry, overrides = {}) => {
  const installDir = overrides.installDir ?? path.join(root, 'apps', 'demo-app');
  registry.apps['demo-app'] = {
    appId: 'demo-app',
    name: 'Demo App',
    description: 'Local demo',
    category: 'productivity',
    version: '0.9.0',
    installDir,
    requiredNodeVersion: '22.0.0',
    requiredPythonVersion: '3.12.0',
    status: 'installed',
    userMessage: 'Ready',
    installedAt: new Date().toISOString(),
    ...overrides,
  };
  await fs.mkdir(installDir, { recursive: true });
  await fs.writeFile(path.join(installDir, 'manifest.json'), JSON.stringify({ services: [] }), 'utf8');
  return registry.apps['demo-app'];
};

test('fetchDownloadBundle uses backend download URLs and verifies checksums before writing the temp ZIP', async (t) => {
  const originalFetch = globalThis.fetch;
  const buffer = Buffer.from('backend zip');
  const checksum = require('node:crypto').createHash('sha256').update(buffer).digest('hex');
  const requests = [];
  const { root, controller } = await makeLifecycleHarness({
    forgerBackendClient: {
      requestDownload: async (versionId, payload) => {
        requests.push([versionId, payload]);
        return {
          download_url: 'https://example.invalid/signed.zip',
          version: { version: '2.0.0', checksum_sha256: checksum },
        };
      },
    },
  });
  t.after(async () => {
    globalThis.fetch = originalFetch;
    await fs.rm(root, { recursive: true, force: true });
  });
  globalThis.fetch = async (url, init) => {
    assert.equal(url, 'https://example.invalid/signed.zip');
    assert.equal(init.headers.Accept, 'application/zip');
    return new Response(buffer, { status: 200 });
  };

  const result = await controller.fetchDownloadBundle({
    ...catalogApp,
    downloadUrl: undefined,
    latestVersionId: 'version-2',
    latestVersion: '1.9.0',
  });

  assert.equal(result.version, '2.0.0');
  assert.equal(result.checksumSha256, checksum);
  assert.equal(await fs.readFile(result.zipPath, 'utf8'), 'backend zip');
  assert.equal(requests[0][0], 'version-2');
  assert.equal(requests[0][1].platform, 'darwin_arm64');
});

test('fetchDownloadBundle rejects failed downloads and missing backend download contracts', async (t) => {
  const originalFetch = globalThis.fetch;
  const { root, controller } = await makeLifecycleHarness();
  t.after(async () => {
    globalThis.fetch = originalFetch;
    await fs.rm(root, { recursive: true, force: true });
  });

  await assert.rejects(
    () => controller.fetchDownloadBundle({
      ...catalogApp,
      downloadUrl: undefined,
      latestVersionId: undefined,
    }),
    /download_url_missing/,
  );

  globalThis.fetch = async () => new Response('not found', { status: 404 });
  await assert.rejects(
    () => controller.fetchDownloadBundle(catalogApp),
    /download_blob_failed_404/,
  );
});

test('installAppRuntime blocks missing catalog entries and missing required tools before download work', async (t) => {
  const missingCatalog = await makeLifecycleHarness({ catalogApps: [] });
  t.after(async () => {
    await fs.rm(missingCatalog.root, { recursive: true, force: true });
  });
  const missingResult = await missingCatalog.controller.installAppRuntime('demo-app');
  assert.equal(missingResult.success, false);
  assert.equal(missingResult.technicalCode, 'catalog_app_missing');
  assert.deepEqual(missingCatalog.registry.apps, {});

  const missingTools = await makeLifecycleHarness({
    getOfficialToolsService: () => ({ getInstallGate: async () => ({ canInstall: false }) }),
  });
  t.after(async () => {
    await fs.rm(missingTools.root, { recursive: true, force: true });
  });
  const toolsResult = await missingTools.controller.installAppRuntime('demo-app');
  assert.equal(toolsResult.success, false);
  assert.equal(toolsResult.technicalCode, 'required_app_tools_missing');
  assert.deepEqual(missingTools.registry.apps, {});
});

test('installAppRuntime records failed installs when a downloaded ZIP checksum does not match', async (t) => {
  const originalFetch = globalThis.fetch;
  const { root, registry, calls, controller } = await makeLifecycleHarness({
    catalogApps: [{ ...catalogApp, checksumSha256: 'not-the-real-checksum' }],
  });
  t.after(async () => {
    globalThis.fetch = originalFetch;
    await fs.rm(root, { recursive: true, force: true });
  });
  globalThis.fetch = async () => new Response(Buffer.from('fake zip'), { status: 200 });

  const result = await controller.installAppRuntime('demo-app');

  assert.equal(result.success, false);
  assert.equal(result.phase, 'failed');
  assert.equal(result.technicalCode, 'app_zip_checksum_mismatch');
  assert.equal(registry.apps['demo-app'].status, 'error');
  assert.ok(calls.some((call) => call[0] === 'installProgress' && call[2] === 'failed'));
  assert.ok(calls.some((call) => call[0] === 'catalogStatuses'));
});

test('installBackendDependenciesWithUv includes app dev dependencies for editable installs', async (t) => {
  const { root, calls, controller } = await makeLifecycleHarness();
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  const backendDir = path.join(root, 'backend');
  await fs.mkdir(backendDir, { recursive: true });
  await fs.writeFile(path.join(backendDir, 'uv.lock'), '', 'utf8');

  await controller.installBackendDependenciesWithUv('/runtime/python', backendDir, 'demo-app');

  const uvSync = calls.find((call) => call[0] === 'run' && call[1] === '/runtime/python' && call[2].includes('uv sync'));
  assert.ok(uvSync);
  assert.match(uvSync[2], /--no-install-project/);
  assert.match(uvSync[2], /--extra dev/);
  assert.match(uvSync[2], /--frozen/);
  assert.doesNotMatch(uvSync[2], /--no-dev/);
});

test('ensureBackendPythonEnvironment accepts usable venvs and repairs missing ones under one lock', async (t) => {
  const ready = await makeLifecycleHarness();
  t.after(async () => {
    await fs.rm(ready.root, { recursive: true, force: true });
  });
  const readyBackend = path.join(ready.root, 'apps', 'demo-app', 'backend');
  const readyPython = path.join(readyBackend, '.venv', 'bin', 'python');
  await fs.mkdir(path.dirname(readyPython), { recursive: true });
  await fs.writeFile(readyPython, '', 'utf8');
  await ready.controller.ensureBackendPythonEnvironment('/runtime/python', readyBackend, 'demo-app', 'open');
  assert.ok(ready.calls.some((call) => call[0] === 'log' && call[1] === 'backend_python_env:ready'));
  assert.equal(ready.calls.some((call) => call[0] === 'run'), false);

  const repairing = await makeLifecycleHarness({
    runCommand: async (command, args, options) => {
      repairing.calls.push(['run', command, args.join(' '), options.cwd]);
      if (args[1] === 'uv') {
        const python = path.join(options.cwd, '.venv', 'bin', 'python');
        await fs.mkdir(path.dirname(python), { recursive: true });
        await fs.writeFile(python, '', 'utf8');
      }
    },
  });
  t.after(async () => {
    await fs.rm(repairing.root, { recursive: true, force: true });
  });
  const repairBackend = path.join(repairing.root, 'apps', 'demo-app', 'backend');
  await fs.mkdir(repairBackend, { recursive: true });
  await fs.writeFile(path.join(repairBackend, 'uv.lock'), '', 'utf8');

  await Promise.all([
    repairing.controller.ensureBackendPythonEnvironment('/runtime/python', repairBackend, 'demo-app', 'open'),
    repairing.controller.ensureBackendPythonEnvironment('/runtime/python', repairBackend, 'demo-app', 'open'),
  ]);

  assert.equal(repairing.calls.filter((call) => call[0] === 'run').length, 2);
  assert.ok(repairing.calls.some((call) => call[0] === 'run' && call[2].includes('--frozen')));
  assert.equal(repairing.calls.filter((call) => call[0] === 'log' && call[1] === 'backend_python_env:repair_start').length, 1);
  assert.ok(repairing.calls.some((call) => call[0] === 'log' && call[1] === 'backend_python_env:repair_ready'));
});

test('ensureBackendPythonEnvironment smoke checks native Python dependencies', async (t) => {
  const harness = await makeLifecycleHarness();
  t.after(async () => {
    await fs.rm(harness.root, { recursive: true, force: true });
  });
  const backendDir = path.join(harness.root, 'apps', 'demo-app', 'backend');
  const python = path.join(backendDir, '.venv', 'bin', 'python');
  await fs.mkdir(path.dirname(python), { recursive: true });
  await fs.writeFile(python, '', 'utf8');

  await harness.controller.ensureBackendPythonEnvironment('/runtime/python', backendDir, 'demo-app', 'open');

  const smokeCheck = harness.calls.find((call) => call[0] === 'capture' && call[1] === python);
  assert.ok(smokeCheck);
  assert.match(smokeCheck[2], /import fastapi, pydantic_core, sqlmodel, uvicorn/);
});

test('ensureBackendPythonEnvironment repairs venvs with failed native dependency imports', async (t) => {
  let smokeChecks = 0;
  const harness = await makeLifecycleHarness({
    runCommandCapture: async (command, args, options) => {
      harness.calls.push(['capture', command, args.join(' '), options.cwd]);
      smokeChecks += 1;
      return smokeChecks === 1
        ? { code: 67, stdout: '', stderr: 'ImportError: pydantic_core rejected' }
        : { code: 0, stdout: '', stderr: '' };
    },
    runCommand: async (command, args, options) => {
      harness.calls.push(['run', command, args.join(' '), options.cwd]);
      if (args[1] === 'uv') {
        const python = path.join(options.cwd, '.venv', 'bin', 'python');
        await fs.mkdir(path.dirname(python), { recursive: true });
        await fs.writeFile(python, '', 'utf8');
      }
    },
  });
  t.after(async () => {
    await fs.rm(harness.root, { recursive: true, force: true });
  });
  const backendDir = path.join(harness.root, 'apps', 'demo-app', 'backend');
  const python = path.join(backendDir, '.venv', 'bin', 'python');
  await fs.mkdir(path.dirname(python), { recursive: true });
  await fs.writeFile(python, '', 'utf8');

  await harness.controller.ensureBackendPythonEnvironment('/runtime/python', backendDir, 'demo-app', 'open');

  assert.equal(smokeChecks, 2);
  assert.ok(harness.calls.some((call) => call[0] === 'log' && call[1] === 'backend_python_env:repair_start'));
  assert.ok(harness.calls.some((call) => call[0] === 'log' && call[1] === 'backend_python_env:repair_ready'));
});

test('ensureBackendPythonEnvironment logs failed venv checks and failed repairs', async (t) => {
  const failing = await makeLifecycleHarness({
    runCommandCapture: async () => {
      throw new Error('uvicorn check exploded');
    },
  });
  t.after(async () => {
    await fs.rm(failing.root, { recursive: true, force: true });
  });
  const backendDir = path.join(failing.root, 'apps', 'demo-app', 'backend');
  const python = path.join(backendDir, '.venv', 'bin', 'python');
  await fs.mkdir(path.dirname(python), { recursive: true });
  await fs.writeFile(python, '', 'utf8');

  await assert.rejects(
    () => failing.controller.ensureBackendPythonEnvironment('/runtime/python', backendDir, 'demo-app', 'open'),
    /backend_python_env_unusable/,
  );

  assert.ok(failing.calls.some((call) => (
    call[0] === 'log' &&
    call[1] === 'backend_python_env:repair_start' &&
    call[2] === 'demo-app'
  )));
  assert.ok(failing.calls.some((call) => (
    call[0] === 'log' &&
    call[1] === 'backend_python_env:repair_failed' &&
    call[2] === 'demo-app'
  )));
  assert.equal(failing.deps.backendPythonEnvironmentLocks.size, 0);
});

test('installed app lifecycle exposes platform-specific venv executable paths', async (t) => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  const harness = await makeLifecycleHarness();
  t.after(async () => {
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform);
    }
    await fs.rm(harness.root, { recursive: true, force: true });
  });

  assert.equal(
    harness.controller.getVenvExecutables('/apps/demo/backend').python,
    path.join('/apps/demo/backend', '.venv', 'bin', 'python'),
  );
  Object.defineProperty(process, 'platform', { value: 'win32' });
  assert.equal(
    harness.controller.getVenvExecutables('C:\\apps\\demo\\backend').pip,
    path.join('C:\\apps\\demo\\backend', '.venv', 'Scripts', 'pip.exe'),
  );
});

test('installAppRuntime installs into a temp private app root and prepares local context without real user data', async (t) => {
  const originalFetch = globalThis.fetch;
  const { root, registry, calls, controller } = await makeLifecycleHarness();
  t.after(async () => {
    globalThis.fetch = originalFetch;
    await fs.rm(root, { recursive: true, force: true });
  });
  globalThis.fetch = async () => new Response(Buffer.from('fake zip'), { status: 200 });

  const result = await controller.installAppRuntime('demo-app');

  assert.equal(result.success, true);
  assert.equal(result.phase, 'completed');
  assert.equal(registry.apps['demo-app'].status, 'installed');
  assert.equal(registry.apps['demo-app'].installDir, path.join(root, 'apps', 'demo-app'));
  assert.ok(calls.some((call) => call[0] === 'validateArchive'));
  assert.ok(calls.some((call) => call[0] === 'agentContext' && call[1] === registry.apps['demo-app'].installDir));
  assert.ok(calls.some((call) => call[0] === 'frontendDeps'));
  assert.ok(!registry.apps['demo-app'].installDir.includes(`${os.homedir()}${path.sep}Forger`));
});

test('installSocialAppRuntime requests a signed Social download and installs under a stable local id', async (t) => {
  const originalFetch = globalThis.fetch;
  const { root, registry, calls, controller } = await makeLifecycleHarness({
    catalogApps: [],
    forgerBackendClient: {
      resolveSocialCode: async (code) => {
        calls.push(['resolveSocialCode', code]);
        return {
          app: {
            id: 44,
            slug: 'shared-ledger',
            name: 'Shared Ledger',
            visibility: 'private',
            status: 'published',
            owner: { id: 3, username: 'Ana.User' },
          },
        };
      },
      requestSocialAppDownload: async (input) => {
        calls.push(['socialDownload', input.appId, input.shareCode, input.platform]);
        return {
          downloadUrl: 'https://social.test/app.zip',
          app: { id: 44, slug: 'shared-ledger', name: 'Shared Ledger', ownerUsername: 'Ana.User' },
          version: {
            id: 8,
            version: '2.1.0',
            runtimeStack: 'vite-fastapi-sqlite',
            supportedPlatforms: ['darwin_arm64'],
            capabilities: ['local_business_data'],
            checksumSha256: '',
            fileSizeBytes: 12,
          },
          install: { id: 77, installedAt: new Date().toISOString(), source: 'code', trustDecision: 'not_reviewed' },
        };
      },
    },
  });
  t.after(async () => {
    globalThis.fetch = originalFetch;
    await fs.rm(root, { recursive: true, force: true });
  });
  globalThis.fetch = async () => new Response(Buffer.from('fake zip'), { status: 200 });

  const result = await controller.installSocialAppRuntime({ shareCode: 'ABCD' });

  assert.equal(result.success, true);
  assert.equal(result.appId, 'social-ana-user-shared-ledger');
  assert.equal(registry.apps['social-ana-user-shared-ledger'].status, 'installed');
  assert.deepEqual(registry.apps['social-ana-user-shared-ledger'].socialSource, {
    userAppId: 44,
    slug: 'shared-ledger',
    ownerUsername: 'Ana.User',
    installId: 77,
  });
  assert.ok(calls.some((call) => call[0] === 'resolveSocialCode' && call[1] === 'ABCD'));
  assert.ok(calls.some((call) => call[0] === 'socialDownload' && call[1] === 44));
  assert.ok(calls.some((call) => call[0] === 'socialDownload' && call[2] === 'ABCD'));
  assert.ok(calls.some((call) => call[0] === 'frontendDeps' && call[4] === 'social-ana-user-shared-ledger'));
});

test('updateAppRuntime returns explicit guard results before touching installed app files', async (t) => {
  const missingApp = await makeLifecycleHarness();
  t.after(async () => {
    await fs.rm(missingApp.root, { recursive: true, force: true });
  });
  const missingAppResult = await missingApp.controller.updateAppRuntime('demo-app');
  assert.equal(missingAppResult.success, false);
  assert.equal(missingAppResult.technicalCode, 'app_not_installed');

  const missingCatalog = await makeLifecycleHarness({ catalogApps: [] });
  t.after(async () => {
    await fs.rm(missingCatalog.root, { recursive: true, force: true });
  });
  await seedInstalledApp(missingCatalog.root, missingCatalog.registry);
  const missingCatalogResult = await missingCatalog.controller.updateAppRuntime('demo-app');
  assert.equal(missingCatalogResult.success, false);
  assert.equal(missingCatalogResult.technicalCode, 'catalog_app_missing');

  const running = await makeLifecycleHarness();
  t.after(async () => {
    await fs.rm(running.root, { recursive: true, force: true });
  });
  await seedInstalledApp(running.root, running.registry);
  running.deps.runningApps.set('demo-app', { appId: 'demo-app' });
  const runningResult = await running.controller.updateAppRuntime('demo-app');
  assert.equal(runningResult.success, false);
  assert.equal(runningResult.technicalCode, 'app_running');

  const conflict = await makeLifecycleHarness();
  t.after(async () => {
    await fs.rm(conflict.root, { recursive: true, force: true });
  });
  await seedInstalledApp(conflict.root, conflict.registry, { status: 'conflict' });
  const conflictResult = await conflict.controller.updateAppRuntime('demo-app');
  assert.equal(conflictResult.success, false);
  assert.equal(conflictResult.technicalCode, 'app_update_conflict');

  const latest = await makeLifecycleHarness({ isVersionNewer: () => false });
  t.after(async () => {
    await fs.rm(latest.root, { recursive: true, force: true });
  });
  await seedInstalledApp(latest.root, latest.registry, { version: '1.0.0' });
  const latestResult = await latest.controller.updateAppRuntime('demo-app');
  assert.equal(latestResult.success, true);
  assert.equal(latestResult.phase, 'completed');
  assert.equal(latest.calls.some((call) => call[0] === 'backup'), false);
});

test('updateAppRuntime blocks dirty installed apps before backup, download, or merge work', async (t) => {
  const originalFetch = globalThis.fetch;
  const { root, registry, calls, controller } = await makeLifecycleHarness({
    getUserVisibleGitStatusLines: async () => [' M frontend/src/App.tsx'],
  });
  t.after(async () => {
    globalThis.fetch = originalFetch;
    await fs.rm(root, { recursive: true, force: true });
  });
  globalThis.fetch = async () => {
    throw new Error('fetch_should_not_run');
  };

  registry.apps['demo-app'] = {
    appId: 'demo-app',
    name: 'Demo App',
    description: 'Local demo',
    category: 'productivity',
    version: '0.9.0',
    installDir: path.join(root, 'apps', 'demo-app'),
    requiredNodeVersion: '22.0.0',
    requiredPythonVersion: '3.12.0',
    status: 'installed',
    userMessage: 'Ready',
    installedAt: new Date().toISOString(),
  };
  await fs.mkdir(registry.apps['demo-app'].installDir, { recursive: true });
  await fs.writeFile(path.join(registry.apps['demo-app'].installDir, 'manifest.json'), '{}', 'utf8');

  const result = await controller.updateAppRuntime('demo-app');

  assert.equal(result.success, false);
  assert.equal(result.technicalCode, 'dirty_worktree');
  assert.equal(registry.apps['demo-app'].status, 'installed');
  assert.equal(calls.some((call) => call[0] === 'backup'), false);
  assert.equal(calls.some((call) => call[0] === 'syncRelease'), false);
});

test('updateAppRuntime records a failed update when the user branch head cannot be resolved', async (t) => {
  const originalFetch = globalThis.fetch;
  const { root, registry, calls, controller } = await makeLifecycleHarness({
    getGitHead: async () => '',
  });
  t.after(async () => {
    globalThis.fetch = originalFetch;
    await fs.rm(root, { recursive: true, force: true });
  });
  globalThis.fetch = async () => {
    throw new Error('fetch_should_not_run');
  };
  await seedInstalledApp(root, registry);

  const result = await controller.updateAppRuntime('demo-app');

  assert.equal(result.success, false);
  assert.equal(result.technicalCode, 'missing_user_branch_head');
  assert.equal(registry.apps['demo-app'].status, 'error');
  assert.equal(calls.some((call) => call[0] === 'backup'), false);
});

test('updateAppRuntime restores installed status when a backup cannot be created', async (t) => {
  const originalFetch = globalThis.fetch;
  const { root, registry, calls, controller } = await makeLifecycleHarness({
    getBackupsManager: () => ({
      createBackup: async ({ appId, reason }) => {
        calls.push(['backup', appId, reason]);
        return {
          success: false,
          userMessage: 'No pudimos crear el respaldo.',
          technicalCode: 'backup_failed',
        };
      },
    }),
  });
  t.after(async () => {
    globalThis.fetch = originalFetch;
    await fs.rm(root, { recursive: true, force: true });
  });
  globalThis.fetch = async () => {
    throw new Error('fetch_should_not_run');
  };
  await seedInstalledApp(root, registry);

  const result = await controller.updateAppRuntime('demo-app');

  assert.equal(result.success, false);
  assert.equal(result.technicalCode, 'backup_failed');
  assert.equal(registry.apps['demo-app'].status, 'installed');
  assert.ok(calls.some((call) => call[0] === 'backup'));
  assert.equal(calls.some((call) => call[0] === 'validateArchive'), false);

  const defaultFailure = await makeLifecycleHarness({
    getBackupsManager: () => ({
      createBackup: async () => ({ success: false }),
    }),
  });
  t.after(async () => {
    await fs.rm(defaultFailure.root, { recursive: true, force: true });
  });
  await seedInstalledApp(defaultFailure.root, defaultFailure.registry);
  const defaultFailureResult = await defaultFailure.controller.updateAppRuntime('demo-app');
  assert.equal(defaultFailureResult.success, false);
  assert.equal(defaultFailureResult.technicalCode, 'backup_failed');
  assert.equal(defaultFailure.registry.apps['demo-app'].status, 'installed');
});

test('updateAppRuntime completes a clean update, installs dependencies, and clears pending update metadata', async (t) => {
  const originalFetch = globalThis.fetch;
  const { root, registry, calls, controller } = await makeLifecycleHarness({
    catalogApps: [{ ...catalogApp, latestVersion: '2.0.0', requiredNodeVersion: '24.1.0', requiredPythonVersion: '3.13.1' }],
  });
  t.after(async () => {
    globalThis.fetch = originalFetch;
    await fs.rm(root, { recursive: true, force: true });
  });
  globalThis.fetch = async () => new Response(Buffer.from('fake zip'), { status: 200 });
  await seedInstalledApp(root, registry);

  const result = await controller.updateAppRuntime('demo-app');

  assert.equal(result.success, true);
  assert.equal(result.phase, 'completed');
  assert.equal(registry.apps['demo-app'].version, '2.0.0');
  assert.equal(registry.apps['demo-app'].requiredNodeVersion, '24.1.0');
  assert.equal(registry.apps['demo-app'].requiredPythonVersion, '3.13.1');
  assert.equal(registry.apps['demo-app'].pendingUpdate, undefined);
  assert.ok(calls.some((call) => call[0] === 'run' && call[2] === 'checkout main'));
  assert.ok(calls.some((call) => call[0] === 'run' && call[2] === 'checkout user-modified'));
  assert.ok(calls.some((call) => call[0] === 'installAppDependencies' && call[3] === '24.1.0' && call[4] === '3.13.1'));
  assert.ok(calls.some((call) => call[0] === 'installProgress' && call[2] === 'completed'));
});

test('updateAppRuntime records conflict state with pending backup and pre-update head when merge fails', async (t) => {
  const originalFetch = globalThis.fetch;
  const { root, registry, calls, controller } = await makeLifecycleHarness({
    runCommandCapture: async (command, args, options) => {
      calls.push(['capture', command, args.join(' '), options.cwd]);
      if (args[0] === 'merge') {
        return { code: 1, stdout: 'conflict', stderr: 'merge conflict' };
      }
      return { code: 0, stdout: '', stderr: '' };
    },
  });
  t.after(async () => {
    globalThis.fetch = originalFetch;
    await fs.rm(root, { recursive: true, force: true });
  });
  globalThis.fetch = async () => new Response(Buffer.from('fake zip'), { status: 200 });

  const installDir = path.join(root, 'apps', 'demo-app');
  registry.apps['demo-app'] = {
    appId: 'demo-app',
    name: 'Demo App',
    description: 'Local demo',
    category: 'productivity',
    version: '0.9.0',
    installDir,
    requiredNodeVersion: '22.0.0',
    requiredPythonVersion: '3.12.0',
    status: 'installed',
    userMessage: 'Ready',
    installedAt: new Date().toISOString(),
  };
  await fs.mkdir(installDir, { recursive: true });
  await fs.writeFile(path.join(installDir, 'manifest.json'), JSON.stringify({ services: [] }), 'utf8');

  const result = await controller.updateAppRuntime('demo-app');

  assert.equal(result.success, false);
  assert.equal(result.phase, 'conflict');
  assert.equal(result.technicalCode, 'merge_conflict');
  assert.equal(registry.apps['demo-app'].status, 'conflict');
  assert.equal(registry.apps['demo-app'].pendingUpdate.preUpdateUserHead, 'user-head');
  assert.equal(registry.apps['demo-app'].pendingUpdate.backup.backupId, 'backup-1');
  assert.ok(calls.some((call) => call[0] === 'syncRelease'));
});

test('updateAppRuntime stores error status and cleans staged files when update work throws', async (t) => {
  const originalFetch = globalThis.fetch;
  const { root, registry, calls, controller, deps } = await makeLifecycleHarness({
    runCommand: async (command, args, options) => {
      calls.push(['run', command, args.join(' '), options.cwd]);
      if (args[0] === 'checkout' && args[1] === 'main') {
        throw new Error('checkout_failed');
      }
    },
  });
  t.after(async () => {
    globalThis.fetch = originalFetch;
    await fs.rm(root, { recursive: true, force: true });
  });
  globalThis.fetch = async () => new Response(Buffer.from('fake zip'), { status: 200 });
  await seedInstalledApp(root, registry);

  const result = await controller.updateAppRuntime('demo-app');

  assert.equal(result.success, false);
  assert.equal(result.phase, 'failed');
  assert.equal(result.technicalCode, 'checkout_failed');
  assert.equal(registry.apps['demo-app'].status, 'error');
  assert.ok(calls.some((call) => call[0] === 'log' && call[1] === 'update:failed'));
  const tempEntries = await fs.readdir(deps.getTempRoot()).catch(() => []);
  assert.equal(tempEntries.some((entry) => entry.includes('-update-')), false);
});

test('restoreAppUserVersionRuntime resets a conflicted app to its pre-update head', async (t) => {
  const { root, registry, calls, controller } = await makeLifecycleHarness();
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  await seedInstalledApp(root, registry, {
    status: 'conflict',
    version: '2.0.0',
    pendingUpdate: {
      fromVersion: '0.9.0',
      targetVersion: '2.0.0',
      preUpdateUserHead: 'user-head-before-update',
      baseCommitSha: 'base-head',
      backup: { backupId: 'backup-1' },
      startedAt: '2026-05-17T00:00:00.000Z',
    },
  });

  const result = await controller.restoreAppUserVersionRuntime('demo-app');

  assert.equal(result.success, true);
  assert.equal(registry.apps['demo-app'].version, '0.9.0');
  assert.equal(registry.apps['demo-app'].status, 'installed');
  assert.equal(registry.apps['demo-app'].pendingUpdate, undefined);
  assert.ok(calls.some((call) => call[0] === 'capture' && call[2] === 'merge --abort'));
  assert.ok(calls.some((call) => call[0] === 'run' && call[2] === 'reset --hard user-head-before-update'));
});

test('restoreAppUserVersionRuntime reports missing pending conflict and restore failures', async (t) => {
  const missing = await makeLifecycleHarness();
  t.after(async () => {
    await fs.rm(missing.root, { recursive: true, force: true });
  });
  const missingResult = await missing.controller.restoreAppUserVersionRuntime('demo-app');
  assert.equal(missingResult.success, false);
  assert.equal(missingResult.technicalCode, 'no_pending_update_conflict');

  const failing = await makeLifecycleHarness({
    runCommand: async (command, args) => {
      failing.calls.push(['run', command, args.join(' ')]);
      if (args[0] === 'reset') {
        throw new Error('reset_failed');
      }
    },
  });
  t.after(async () => {
    await fs.rm(failing.root, { recursive: true, force: true });
  });
  await seedInstalledApp(failing.root, failing.registry, {
    status: 'conflict',
    pendingUpdate: {
      fromVersion: '0.9.0',
      targetVersion: '2.0.0',
      preUpdateUserHead: 'user-head-before-update',
      baseCommitSha: 'base-head',
      backup: { backupId: 'backup-1' },
      startedAt: '2026-05-17T00:00:00.000Z',
    },
  });

  const failure = await failing.controller.restoreAppUserVersionRuntime('demo-app');
  assert.equal(failure.success, false);
  assert.equal(failure.technicalCode, 'reset_failed');
});

test('getAppDetails refreshes missing catalog metadata, marks running apps, and reads local change summaries', async (t) => {
  const { root, registry, calls, controller, deps } = await makeLifecycleHarness({
    catalogApps: [],
    listCatalogFromBackend: async () => [{
      ...catalogApp,
      latestVersion: '2.0.0',
      changelog: 'New dashboards',
      agents: [{ id: 'analyst', name: 'Analyst' }],
      promptTemplates: [{ id: 'review', title: 'Review' }],
      averageRating: 4.7,
      ratingsCount: 12,
    }],
    getOriginalCommitSha: async () => 'original-from-git',
    resolveInstalledAgents: async () => [{ id: 'installed-agent', name: 'Installed Agent' }],
    resolveInstalledPromptTemplates: async () => [{ id: 'installed-review', title: 'Installed review' }],
    listAppPrompts: async () => [{ id: 'prompt-1', name: 'Prompt' }],
    runCommandCapture: async (command, args, options) => {
      calls.push(['capture', command, args.join(' '), options.cwd]);
      if (args[0] === 'log') {
        return { code: 0, stdout: 'sha-1\u001fForger(custom): Added report\u001f2026-05-17T00:00:00.000Z', stderr: '' };
      }
      return { code: 0, stdout: '', stderr: '' };
    },
  });
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  await seedInstalledApp(root, registry, { originalCommitSha: undefined });
  deps.runningApps.set('demo-app', { appId: 'demo-app' });

  const details = await controller.getAppDetails('demo-app');

  assert.equal(details.status, 'running');
  assert.equal(details.app.status, 'running');
  assert.equal(details.updateAvailable, true);
  assert.equal(details.latestVersion, '2.0.0');
  assert.equal(details.originalCommitSha, 'original-from-git');
  assert.equal(details.localChanges[0].title, 'Added report');
  assert.deepEqual(details.promptTemplates, [{ id: 'installed-review', title: 'Installed review' }]);
  assert.deepEqual(details.agents, [{ id: 'installed-agent', name: 'Installed Agent' }]);
  assert.equal(details.codexConversation.enabled, true);
  assert.ok(calls.some((call) => call[0] === 'catalogStatuses'));
});

test('readLocalChangeSummaries skips malformed git log rows and fills missing display fields', async (t) => {
  const { root, controller } = await makeLifecycleHarness({
    runCommandCapture: async () => ({
      code: 0,
      stdout: [
        'sha-2\u001f\u001f',
        'malformed-row',
      ].join('\n'),
      stderr: '',
    }),
  });
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const summaries = await controller.readLocalChangeSummaries(path.join(root, 'apps', 'demo-app'));

  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].id, 'sha-2');
  assert.equal(summaries[0].title, 'Cambio guardado');
  assert.equal(typeof summaries[0].createdAt, 'string');
});

test('getAppDetails includes pending update conflict metadata for conflicted installs', async (t) => {
  const { root, registry, controller } = await makeLifecycleHarness({
    catalogApps: [{ ...catalogApp, latestVersion: '2.0.0', changelog: 'New version' }],
  });
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  await seedInstalledApp(root, registry, {
    status: 'conflict',
    pendingUpdate: {
      fromVersion: '0.9.0',
      targetVersion: '2.0.0',
      startedAt: '2026-05-21T00:00:00.000Z',
      message: 'Merge conflict',
    },
  });

  const details = await controller.getAppDetails('demo-app');

  assert.equal(details.status, 'conflict');
  assert.deepEqual(details.conflictInfo, {
    fromVersion: '0.9.0',
    targetVersion: '2.0.0',
    startedAt: '2026-05-21T00:00:00.000Z',
    message: 'Merge conflict',
  });
  assert.equal(details.changelog, 'New version');
});

test('installed app lifecycle returns empty operation and local change summaries for malformed data', async (t) => {
  const { root, registry, controller } = await makeLifecycleHarness({
    catalogApps: [],
    listCatalogFromBackend: async () => [],
    runCommandCapture: async () => ({ code: 1, stdout: '', stderr: 'not a git repo' }),
  });
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  assert.equal(await controller.getAppDetails('unknown-app'), null);
  assert.deepEqual(await controller.readOperationSummaries('demo-app'), []);
  assert.deepEqual(await controller.readLocalChangeSummaries(path.join(root, 'missing-app')), []);

  await seedInstalledApp(root, registry);
  await fs.mkdir(path.join(root, 'metadata', 'operations'), { recursive: true });
  await fs.writeFile(path.join(root, 'metadata', 'operations', 'demo-app.json'), JSON.stringify({ not: 'array' }), 'utf8');
  const details = await controller.getAppDetails('demo-app');
  assert.deepEqual(details.operations, []);
  assert.deepEqual(details.localChanges, []);

  await fs.writeFile(path.join(root, 'metadata', 'operations', 'demo-app.json'), '{bad json', 'utf8');
  assert.deepEqual(await controller.readOperationSummaries('demo-app'), []);
});

test('installed app lifecycle prepares welcome messages from localized files and safe fallbacks', async (t) => {
  const { root, controller, registry } = await makeLifecycleHarness();
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const record = await seedInstalledApp(root, registry, {
    name: 'Demo App',
    description: '',
  });
  await fs.writeFile(path.join(record.installDir, 'POSTINSTALL.es.md'), '# Hola\r\n\n- Abre la app', 'utf8');

  const localized = await controller.installWelcome('demo-app', 'es-CL');
  assert.equal(localized.success, true);
  assert.equal(localized.usedCodex, false);
  assert.equal(localized.message, '# Hola\n\n- Abre la app');

  await fs.rm(path.join(record.installDir, 'POSTINSTALL.es.md'));
  const fallback = await controller.installWelcome('demo-app', 'en-US');
  assert.equal(fallback.success, true);
  assert.match(fallback.message, /Demo App is installed/);
  assert.match(fallback.message, /Open the app/);

  assert.deepEqual(await controller.installWelcome('missing-app'), {
    success: false,
    appId: 'missing-app',
    usedCodex: false,
    userMessage: 'Primero instala esta app.',
    technicalCode: 'app_not_installed',
  });
});

test('installed app lifecycle surfaces restore, uninstall, and detail fallback edges', async (t) => {
  const stopped = [];
  const removed = [];
  const { root, calls, controller, deps, registry } = await makeLifecycleHarness({
    closeAppWindow: (appId) => calls.push(['closeWindow', appId]),
    removeInstalledRecord: async (appId) => {
      removed.push(appId);
      delete registry.apps[appId];
    },
    runCommand: async (command, args, options) => {
      calls.push(['run', command, args.join(' '), options.cwd]);
      if (args.join(' ') === 'reset --hard bad-head') {
        throw new Error('reset_failed');
      }
    },
    stopInstalledApp: async (appId) => {
      stopped.push(appId);
      return { success: true, userMessage: 'stopped' };
    },
  });
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  await seedInstalledApp(root, registry, {
    pendingUpdate: {
      fromVersion: '0.9.0',
      targetVersion: '1.0.0',
      preUpdateUserHead: 'bad-head',
      baseCommitSha: 'base',
      startedAt: '2026-05-21T00:00:00.000Z',
    },
  });

  const restore = await controller.restoreAppUserVersionRuntime('demo-app');
  assert.equal(restore.success, false);
  assert.equal(restore.technicalCode, 'reset_failed');

  registry.apps['demo-app'].pendingUpdate.preUpdateUserHead = 'good-head';
  const restored = await controller.restoreAppUserVersionRuntime('demo-app');
  assert.equal(restored.success, true);
  assert.equal(registry.apps['demo-app'].pendingUpdate, undefined);

  registry.apps['demo-app'].pendingUpdate = {
    fromVersion: '0.9.0',
    targetVersion: '1.0.0',
    startedAt: '2026-05-21T00:00:00.000Z',
    message: 'merge conflict',
  };
  deps.runningApps.set('demo-app', { frontendUrl: 'http://127.0.0.1:1' });
  const details = await controller.getAppDetails('demo-app');
  assert.equal(details.status, 'running');
  assert.equal(details.conflictInfo.message, 'merge conflict');
  assert.equal(details.codexConversation, undefined);

  const uninstalled = await controller.uninstallAppRuntime('demo-app');
  assert.equal(uninstalled.success, true);
  assert.deepEqual(stopped, ['demo-app']);
  assert.deepEqual(removed, ['demo-app']);
  assert.ok(calls.some((call) => call[0] === 'closeWindow' && call[1] === 'demo-app'));
  assert.equal(await fs.stat(path.join(root, 'apps', 'demo-app')).catch(() => null), null);
});

test('installed app lifecycle reads current and legacy operation summaries with defaults', async (t) => {
  const { root, controller } = await makeLifecycleHarness();
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  await fs.mkdir(path.join(root, 'metadata', 'operations'), { recursive: true });
  await fs.writeFile(path.join(root, 'metadata', 'operations', 'demo-app.json'), JSON.stringify([
    {
      runId: 'run-1',
      commitSha: 'sha-1',
      title: '  Custom title  ',
      summary: '  Custom summary  ',
      createdAt: '2026-05-17T00:00:00.000Z',
      revertedAt: '2026-05-18T00:00:00.000Z',
    },
    {
      createdAt: '2026-05-19T00:00:00.000Z',
    },
    {
      title: 'Missing date is ignored',
    },
  ]), 'utf8');

  const current = await controller.readOperationSummaries('demo-app');
  assert.deepEqual(current, [
    {
      operationId: 'sha-1',
      runId: 'run-1',
      commitSha: 'sha-1',
      title: 'Custom title',
      summary: 'Custom summary',
      createdAt: '2026-05-17T00:00:00.000Z',
      revertedAt: '2026-05-18T00:00:00.000Z',
    },
    {
      operationId: 'demo-app-2026-05-19T00:00:00.000Z',
      runId: undefined,
      commitSha: undefined,
      title: 'Cambio aplicado',
      summary: 'Forger aplico una modificacion en esta app.',
      createdAt: '2026-05-19T00:00:00.000Z',
      revertedAt: undefined,
    },
  ]);

  await fs.rm(path.join(root, 'metadata', 'operations', 'demo-app.json'), { force: true });
  await fs.mkdir(path.join(root, 'legacy', 'operations'), { recursive: true });
  await fs.writeFile(path.join(root, 'legacy', 'operations', 'demo-app.json'), JSON.stringify([
    {
      operationId: 'legacy-op',
      createdAt: '2026-05-20T00:00:00.000Z',
    },
  ]), 'utf8');

  assert.equal((await controller.readOperationSummaries('demo-app'))[0].operationId, 'legacy-op');
});

test('uninstallAppRuntime stops running apps, removes local files, and reports delete failures', async (t) => {
  const success = await makeLifecycleHarness({
    closeAppWindow: (appId) => success.calls.push(['closeWindow', appId]),
    stopInstalledApp: async (appId) => {
      success.calls.push(['stop', appId]);
      return { success: true, userMessage: 'stopped' };
    },
  });
  t.after(async () => {
    await fs.rm(success.root, { recursive: true, force: true });
  });
  const record = await seedInstalledApp(success.root, success.registry);
  await fs.mkdir(path.join(record.installDir, 'data'), { recursive: true });
  success.deps.runningApps.set('demo-app', { appId: 'demo-app' });

  const result = await success.controller.uninstallAppRuntime('demo-app');

  assert.equal(result.success, true);
  assert.equal(success.registry.apps['demo-app'], undefined);
  assert.equal(await fs.access(record.installDir).then(() => true).catch(() => false), false);
  assert.ok(success.calls.some((call) => call[0] === 'stop' && call[1] === 'demo-app'));
  assert.ok(success.calls.some((call) => call[0] === 'closeWindow' && call[1] === 'demo-app'));
  assert.ok(success.calls.some((call) => call[0] === 'runtimeStatus' && call[2] === 'not_installed'));

  const missing = await makeLifecycleHarness();
  t.after(async () => {
    await fs.rm(missing.root, { recursive: true, force: true });
  });
  const missingResult = await missing.controller.uninstallAppRuntime('demo-app');
  assert.equal(missingResult.success, false);
  assert.equal(missingResult.technicalCode, 'app_not_installed');

  const failing = await makeLifecycleHarness({
    removeInstalledRecord: async () => {
      throw new Error('remove_failed');
    },
  });
  t.after(async () => {
    await fs.rm(failing.root, { recursive: true, force: true });
  });
  await seedInstalledApp(failing.root, failing.registry);
  const failure = await failing.controller.uninstallAppRuntime('demo-app');
  assert.equal(failure.success, false);
  assert.equal(failure.technicalCode, 'remove_failed');
});

test('installWelcome reads localized app guidance and falls back when no postinstall file exists', async (t) => {
  const { root, registry, controller } = await makeLifecycleHarness();
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const missing = await controller.installWelcome('demo-app', 'es-CL');
  assert.equal(missing.success, false);
  assert.equal(missing.technicalCode, 'app_not_installed');

  const record = await seedInstalledApp(root, registry, {
    description: 'Track your finances locally.',
    name: 'Finance Local',
  });
  await fs.writeFile(path.join(record.installDir, 'POSTINSTALL.es.md'), '# Bienvenido\r\n\n- Abre Finanzas', 'utf8');
  const localized = await controller.installWelcome('demo-app', 'es_CL');
  assert.equal(localized.success, true);
  assert.equal(localized.usedCodex, false);
  assert.equal(localized.message, '# Bienvenido\n\n- Abre Finanzas');

  await fs.rm(path.join(record.installDir, 'POSTINSTALL.es.md'), { force: true });
  const fallback = await controller.installWelcome('demo-app', 'en-US');
  assert.equal(fallback.success, true);
  assert.match(fallback.message, /Finance Local is installed/);
  assert.match(fallback.message, /Track your finances locally/);
  assert.match(fallback.message, /Open the app to review its main screens/);

  const defaultLanguage = await controller.installWelcome('demo-app');
  assert.equal(defaultLanguage.success, true);
  assert.match(defaultLanguage.message, /Finance Local is installed/);

  const spanish = await controller.installWelcome('demo-app', 'es-CL');
  assert.equal(spanish.success, true);
  assert.match(spanish.message, /Finance Local ya esta instalada/);
  assert.match(spanish.message, /Abre la app para revisar sus pantallas principales/);
});

test('installWelcome reports diagnostics when postinstall reading throws unexpectedly', async (t) => {
  const throwingFs = {
    ...fs,
    readFile: () => {
      throw new Error('read_failed');
    },
  };
  const { root, registry, controller } = await makeLifecycleHarness({ fs: throwingFs });
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  await seedInstalledApp(root, registry);

  const result = await controller.installWelcome('demo-app', 'en');

  assert.equal(result.success, false);
  assert.equal(result.technicalCode, 'read_failed');
  assert.equal(result.userMessage, 'No pudimos preparar el mensaje inicial.');
});

class FakeChildProcess extends EventEmitter {
  killed = false;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  pid = Math.floor(Math.random() * 10_000) + 1000;

  kill(signal) {
    this.killed = true;
    this.signal = signal;
    queueMicrotask(() => this.emit('exit', null, signal));
    return true;
  }
}

const makeRuntimeHarness = () => {
  const registry = {
    apps: {
      'demo-app': {
        appId: 'demo-app',
        name: 'Demo App',
        version: '1.0.0',
        installDir: '/tmp/forger-test-demo-app',
        requiredNodeVersion: '22.0.0',
        requiredPythonVersion: '3.12.0',
        status: 'installed',
        userMessage: 'Ready',
        installedAt: new Date().toISOString(),
      },
    },
  };
  const calls = [];
  const backend = new FakeChildProcess();
  const frontend = new FakeChildProcess();
  const runningApps = new Map([
    ['demo-app', {
      appId: 'demo-app',
      backend,
      frontend,
      backendUrl: 'http://127.0.0.1:4101',
      frontendUrl: 'http://127.0.0.1:4102',
      rawFrontendUrl: 'http://127.0.0.1:4103',
      proxyServer: { close: (callback) => {
        calls.push(['proxyClose']);
        callback?.();
      } },
    }],
  ]);
  const controller = createInstalledAppRuntimeController({
    FORGER_PROTOCOL: 'forger',
    app: { getPath: () => '/tmp', getAppPath: () => '/tmp' },
    appAgentConversationManager: { rejectPendingPermissionsForApp: (appId) => calls.push(['rejectConversation', appId]) },
    appAgentTaskManager: { rejectPendingPermissionsForApp: (appId) => calls.push(['rejectTask', appId]) },
    appFolderGrantSecret: 'grant',
    appWindows: new Map([['demo-app', { isDestroyed: () => false, close: () => calls.push(['windowClose']) }]]),
    appendInstallLog: async (event, payload) => calls.push(['log', event, payload?.appId]),
    desktopRuntimeBridge: null,
    dispatchDeepLink: () => undefined,
    emitRuntimeStatus: (payload) => calls.push(['runtimeStatus', payload.appId, payload.status]),
    ensureBackendPythonEnvironment: async () => undefined,
    ensureCatalogStatuses: () => calls.push(['catalogStatuses']),
    ensureRuntimeInstalled: async () => ({ node: '/tmp/node', npm: '/tmp/npm', python: '/tmp/python', pip: '/tmp/pip' }),
    failureDiagnostic: (error, fallbackCode) => ({ technicalCode: error instanceof Error ? error.message : fallbackCode }),
    formatProcessOutputForInstallLog: (text) => text,
    friendChatWindows: new Map(),
    fs,
    getBackendPathEntries: async () => ['/tmp/developer-bin'],
    getInstallLogPath: () => '/tmp/install.log',
    getManifestAppSecretsValidationError: () => null,
    getSecretsStore: () => ({ resolveAppEnv: async () => ({ env: {}, missingRequired: [], secretValues: [] }) }),
    getVenvExecutables: () => ({ python: '/tmp/python', pip: '/tmp/pip' }),
    http: require('node:http'),
    isDev: false,
    isSecretsVaultUnavailableError: () => false,
    net: require('node:net'),
    normalizeManifestAppSecrets: () => [],
    normalizeNodeRuntimeVersion: (value) => value,
    parseForgerUrl: () => null,
    path,
    registry,
    requiresWindowsShell: () => false,
    resolveInstalledManifest: async () => ({}),
    runCommand: async (command, args) => calls.push(['run', command, args.join(' ')]),
    runningApps,
    serializeErrorForInstallLog: (error) => ({ message: error instanceof Error ? error.message : String(error) }),
    shell: { openExternal: async () => undefined },
    stoppingApps: new Set(),
    syncAppToCloudIfEnabled: async (appId) => calls.push(['syncCloud', appId]),
    truncateForInstallLog: (value) => value,
    upsertInstalledRecord: async (record) => {
      registry.apps[record.appId] = { ...record };
      calls.push(['upsert', record.appId, record.status]);
    },
    wait: async () => undefined,
    withAppLifecycleLock: async (_appId, operation) => await operation(),
  });
  return { controller, registry, runningApps, backend, frontend, calls };
};

test('stopInstalledApp terminates local processes, closes proxy, updates status, and syncs after stop', async () => {
  const { controller, registry, runningApps, backend, frontend, calls } = makeRuntimeHarness();

  const result = await controller.stopInstalledApp('demo-app');

  assert.equal(result.success, true);
  assert.equal(runningApps.has('demo-app'), false);
  assert.equal(backend.killed, true);
  assert.equal(frontend.killed, true);
  assert.equal(registry.apps['demo-app'].status, 'installed');
  assert.ok(calls.some((call) => call[0] === 'windowClose'));
  assert.ok(calls.some((call) => call[0] === 'proxyClose'));
  assert.ok(calls.some((call) => call[0] === 'runtimeStatus' && call[2] === 'installed'));
  assert.ok(calls.some((call) => call[0] === 'syncCloud' && call[1] === 'demo-app'));
});

test('openInstalledApp returns missing required app secrets before starting local processes', async () => {
  const { controller } = makeRuntimeHarness();

  const result = await controller.openInstalledAppUnlocked('demo-app', 'en', { openWindow: false });

  assert.equal(result.success, true);
  assert.equal(result.userMessage, 'La app ya esta en ejecucion.');
});

test('normalizeInstalledAgentContext writes app runtime skills while ignoring skill paths outside install root', async (t) => {
  const root = await tmpRoot('app-context');
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  const installDir = path.join(root, 'apps', 'demo-app');
  await fs.mkdir(path.join(installDir, 'skills', 'inside'), { recursive: true });
  await fs.writeFile(path.join(installDir, 'skills', 'inside', 'SKILL.md'), 'inside skill', 'utf8');
  await fs.mkdir(path.join(root, 'outside-skill'), { recursive: true });
  await fs.writeFile(path.join(root, 'outside-skill', 'SKILL.md'), 'outside skill', 'utf8');
  await fs.writeFile(path.join(installDir, 'manifest.json'), JSON.stringify({
    stack: {
      backend: { language: 'python', framework: 'fastapi' },
      frontend: { framework: 'react', ui: 'mui' },
    },
    mcp: { type: 'http', command: 'python -m app.mcp' },
    skills: ['./skills/inside', '../outside-skill'],
  }), 'utf8');

  const controller = createAppContextSupportController({
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

  await controller.normalizeInstalledAgentContext(installDir, 'demo-app');

  const skillsRoot = path.join(installDir, '.agents', 'skills');
  const generated = await fs.readdir(skillsRoot);
  assert.ok(generated.includes('forger-context'));
  assert.ok(generated.includes('forger-app-agents-authoring'));
  assert.ok(generated.includes('forger-app-official-tools'));
  assert.equal(generated.includes('forger-installed-app-change'), false);
  assert.equal(generated.includes('forger-python-backend'), false);
  assert.equal(generated.includes('forger-fastapi-contracts'), false);
  assert.equal(generated.includes('forger-frontend-structure'), false);
  assert.equal(generated.includes('forger-react-ui'), false);
  assert.equal(generated.includes('forger-frontend-product-patterns'), false);
  assert.equal(generated.includes('forger-app-shell-layout'), false);
  assert.equal(generated.includes('forger-mui-design-patterns'), false);
  assert.equal(generated.includes('forger-mui-component-patterns'), false);
  assert.equal(generated.includes('forger-mui-date-pickers'), false);
  assert.equal(generated.includes('forger-mui-consistency'), false);
  assert.equal(generated.includes('forger-tailwind-design-patterns'), false);
  assert.equal(generated.includes('forger-tailwind-shadcn-patterns'), false);
  assert.equal(generated.includes('forger-tailwind-responsive-frontend'), false);
  assert.ok(generated.includes('forger-app-mcp-data-tools'));
  assert.ok(generated.includes('inside'));
  assert.equal(generated.includes('outside-skill'), false);
  const appToolSkill = await fs.readFile(path.join(skillsRoot, 'forger-app-official-tools', 'SKILL.md'), 'utf8');
  assert.match(appToolSkill, /This app has not declared any official Forger tool actions/);
  const agentsMarkdown = await fs.readFile(path.join(installDir, 'AGENTS.md'), 'utf8');
  assert.match(agentsMarkdown, /Forger/);
});
