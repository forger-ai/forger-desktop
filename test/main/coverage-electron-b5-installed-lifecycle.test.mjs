import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createInstalledAppLifecycleController } = require('../../dist-electron/main/installed-apps/lifecycle.js');

const socialDownload = (downloadUrl, overrides = {}) => ({
  downloadUrl,
  app: { id: 44, slug: 'shared-ledger', name: 'Shared Ledger', ownerUsername: 'Ana.User' },
  version: {
    id: 8,
    version: '2.1.0',
    capabilities: ['local_business_data'],
    checksumSha256: '',
    fileSizeBytes: 12,
    platformCapabilities: { workspaceFolders: true },
    tools: [{ id: 'browser' }],
    agents: [{ id: 'analyst', title: 'Analyst' }],
    promptTemplates: [{ id: 'review', title: 'Review' }],
  },
  install: { id: 77 },
  ...overrides,
});

const makeHarness = async (overrides = {}) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forger-b5-lifecycle-'));
  const metadataRoot = path.join(root, 'metadata');
  const tempRoot = path.join(root, 'temp');
  const privateAppsRoot = path.join(root, 'apps');
  const sourceZip = path.join(root, 'social source.zip');
  await fs.writeFile(sourceZip, 'social archive', 'utf8');
  const calls = [];
  const registry = { apps: {} };
  const backendPythonEnvironmentLocks = new Map();
  const backend = overrides.forgerBackendClient === undefined ? {
    resolveSocialCode: async (code) => {
      calls.push(['resolve', code]);
      return { app: { id: 44 } };
    },
    requestSocialAppDownload: async (input) => {
      calls.push(['download', input]);
      return socialDownload(pathToFileURL(sourceZip).href);
    },
  } : overrides.forgerBackendClient;
  const deps = {
    DEFAULT_NODE_VERSION: '22.0.0',
    DEFAULT_PYTHON_VERSION: '3.12.0',
    appendInstallLog: async (event, payload) => calls.push(['log', event, payload]),
    app: { getPath: () => root },
    catalogApps: overrides.catalogApps ?? [],
    clearMacQuarantine: async () => undefined,
    closeAppWindow: () => undefined,
    collectPersistentInstallPaths: () => [],
    copyReleaseContentsForUpdate: async () => undefined,
    emitInstallProgress: () => undefined,
    emitRuntimeStatus: () => undefined,
    ensureAppGitRepository: async () => undefined,
    ensureCatalogStatuses: () => undefined,
    ensureGlobalAgentsContext: async () => undefined,
    ensureRuntimeInstalled: async (type) => type === 'node'
      ? { node: '/runtime/node', npm: '/runtime/npm' }
      : { python: '/runtime/python', pip: '/runtime/pip' },
    ensureUserModifiedBranch: async () => undefined,
    extractArchive: async (_archive, destination) => {
      await fs.mkdir(path.join(destination, 'backend'), { recursive: true });
      await fs.mkdir(path.join(destination, 'frontend'), { recursive: true });
      await fs.writeFile(path.join(destination, 'manifest.json'), '{}', 'utf8');
    },
    failureDiagnostic: (error, fallback) => ({
      technicalCode: error instanceof Error ? error.message : fallback,
      details: { fallback },
    }),
    flattenSingleTopLevelDirectory: async () => undefined,
    fs,
    getBackupsManager: () => ({ createBackup: async () => ({ success: false }) }),
    getForgerHomeRoot: () => path.join(root, 'home'),
    getForgerMetadataRoot: () => metadataRoot,
    getGitHead: async () => 'head',
    getInstallLogPath: () => path.join(root, 'install.log'),
    getLegacyForgerMetadataRoot: () => path.join(root, 'legacy'),
    getOfficialToolsService: () => ({ getInstallGate: async () => ({ required: [] }) }),
    getOriginalCommitSha: async () => 'original',
    getPrivateAppsRoot: () => privateAppsRoot,
    getRuntimeStatus: (appId) => ({ appId, status: 'installed' }),
    getTempRoot: () => tempRoot,
    getUserVisibleGitStatusLines: async () => [],
    gitCommitAllExcept: async () => 'commit',
    installAppDependencies: async () => undefined,
    installFrontendDependenciesWithNpm: async () => undefined,
    isVersionNewer: (candidate, current) => candidate !== current,
    listAppPrompts: async () => [],
    listCatalogFromBackend: async () => [],
    normalizeInstalledAgentContext: async () => undefined,
    normalizeNodeRuntimeVersion: (value) => value ?? '22.0.0',
    normalizeVersionForFolder: (value) => value,
    openInstalledAppUnlocked: async (appId) => ({ success: true, appId }),
    path,
    removeInstalledRecord: async (appId) => { delete registry.apps[appId]; },
    resolveInstalledAgents: async () => [],
    resolveInstalledManifest: async () => ({ name: 'Shared Ledger', services: [], scripts: {} }),
    resolveInstalledPromptTemplates: async () => [],
    resolvePlatformAlias: () => 'darwin_arm64',
    runCommand: async (...args) => calls.push(['run', ...args]),
    runCommandCapture: async () => ({ code: 0, stdout: '', stderr: '' }),
    runtimeError: (userMessage, technicalCode, phase = 'failed') => ({
      success: false, phase, userMessage, technicalCode, progress: 1,
    }),
    runningApps: new Map(),
    serializeErrorForInstallLog: (error) => ({ message: String(error) }),
    stopInstalledApp: async () => ({ success: true, userMessage: 'stopped' }),
    syncAppToCloudIfEnabled: async () => undefined,
    syncReleaseIntoInstalledApp: async () => undefined,
    toAppSummary: (record) => record,
    truncateForInstallLog: (value) => value,
    upsertInstalledRecord: async (record) => { registry.apps[record.appId] = { ...record }; },
    validateArchiveEntries: async () => undefined,
    ...overrides,
    forgerBackendClient: backend,
    backendPythonEnvironmentLocks,
    registry,
  };
  return {
    root,
    metadataRoot,
    sourceZip,
    calls,
    registry,
    deps,
    controller: createInstalledAppLifecycleController(deps),
    cleanup: async () => fs.rm(root, { recursive: true, force: true }),
  };
};

test('social review stages an untrusted app, exposes its review context, then installs the approved archive', async (t) => {
  const harness = await makeHarness({
    catalogApps: [{
      id: 'catalog-social', socialUserAppId: 44, name: 'Catalog Ledger', shortDescription: 'Short',
      description: 'Catalog description', longDescription: 'Long', category: 'finance',
    }],
  });
  t.after(harness.cleanup);

  const prepared = await harness.controller.prepareSocialAppReview({
    appSlug: 'shared-ledger', shareCode: 'SHARE-44',
  }, 'en');
  assert.equal(prepared.success, true);
  assert.equal(prepared.quarantine.status, 'pending_review');
  assert.equal(prepared.quarantine.name, 'Catalog Ledger');
  assert.equal(prepared.quarantine.category, 'finance');
  assert.equal(await fs.readFile(prepared.quarantine.zipPath, 'utf8'), 'social archive');
  assert.deepEqual(await harness.controller.getSocialAppReviewPromptContext(prepared.quarantine.quarantineId), {
    appRoot: prepared.quarantine.stagedDir,
    runRoot: prepared.quarantine.stagedDir,
    appStack: 'quarantined Social app package',
    runtime: 'social review 2.1.0',
  });

  const installed = await harness.controller.finishSocialAppInstall({
    quarantineId: prepared.quarantine.quarantineId,
  }, 'en');
  assert.equal(installed.success, true);
  assert.equal(installed.appId, 'social-ana-user-shared-ledger');
  assert.deepEqual(harness.registry.apps[installed.appId].socialSource, {
    userAppId: 44,
    slug: 'shared-ledger',
    ownerUsername: 'Ana.User',
    installId: 77,
  });
  const index = JSON.parse(await fs.readFile(path.join(harness.metadataRoot, 'social-app-quarantine', 'index.json'), 'utf8'));
  assert.equal(index[prepared.quarantine.quarantineId].status, 'approved');

  const deleted = await harness.controller.deleteQuarantinedSocialApp({
    quarantineId: prepared.quarantine.quarantineId,
  }, 'en');
  assert.deepEqual(deleted, { success: true, userMessage: 'Review files deleted.' });
  assert.equal(await harness.controller.getSocialAppReviewPromptContext(prepared.quarantine.quarantineId), null);
  assert.equal((await harness.controller.deleteQuarantinedSocialApp({
    quarantineId: prepared.quarantine.quarantineId,
  }, 'es')).userMessage, 'Archivos de revisión eliminados.');
  assert.equal((await harness.controller.finishSocialAppInstall({ quarantineId: prepared.quarantine.quarantineId }, 'es')).technicalCode, 'social_quarantine_not_found');
});

test('social quarantine storage recovers from missing, malformed and array indexes', async (t) => {
  const harness = await makeHarness();
  t.after(harness.cleanup);
  const indexPath = path.join(harness.metadataRoot, 'social-app-quarantine', 'index.json');

  assert.equal(await harness.controller.getSocialAppReviewPromptContext('missing'), null);
  await fs.mkdir(path.dirname(indexPath), { recursive: true });
  await fs.writeFile(indexPath, '{bad-json', 'utf8');
  assert.equal(await harness.controller.getSocialAppReviewPromptContext('missing'), null);
  await fs.writeFile(indexPath, '[]', 'utf8');
  assert.equal(await harness.controller.getSocialAppReviewPromptContext('missing'), null);
  assert.equal((await harness.controller.finishSocialAppInstall({ quarantineId: 'missing' }, 'en')).userMessage, 'Review not found.');
  assert.equal((await harness.controller.deleteQuarantinedSocialApp({ quarantineId: 'missing' }, 'en')).userMessage, 'Review not found.');
  assert.equal((await harness.controller.deleteQuarantinedSocialApp({ quarantineId: 'missing' }, 'es')).userMessage, 'No encontramos esta revisión.');
});

test('social review resolves share codes and produces stable safe ids for hostile public slugs', async (t) => {
  let hostileSource;
  const harness = await makeHarness({
    forgerBackendClient: {
      resolveSocialCode: async () => ({ app: { id: 99 } }),
      requestSocialAppDownload: async () => socialDownload(pathToFileURL(hostileSource).href, {
        downloadUrl: pathToFileURL(hostileSource).href,
        app: { id: 99, slug: '___', ownerUsername: '!!!' },
      }),
    },
  });
  t.after(harness.cleanup);
  hostileSource = harness.sourceZip;

  const result = await harness.controller.prepareSocialAppReview({ shareCode: 'CODE-99' });
  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(result.quarantine.localAppId, 'social-user-app');
  assert.equal(result.quarantine.appSlug, undefined);
  assert.equal(result.quarantine.shareCode, 'CODE-99');
});

test('social lifecycle returns localized diagnostics for missing cloud sessions and download failures', async (t) => {
  const missing = await makeHarness({ forgerBackendClient: null });
  t.after(missing.cleanup);
  assert.equal((await missing.controller.prepareSocialAppReview({}, 'en')).technicalCode, 'backend_client_missing');
  assert.equal((await missing.controller.finishSocialAppInstall({ quarantineId: 'none' })).technicalCode, 'backend_client_missing');
  assert.equal((await missing.controller.installSocialAppRuntime({})).technicalCode, 'backend_client_missing');

  const failing = await makeHarness({
    forgerBackendClient: {
      resolveSocialCode: async () => ({ app: { id: 44 } }),
      requestSocialAppDownload: async () => { throw new Error('download_denied'); },
    },
  });
  t.after(failing.cleanup);
  const reviewEn = await failing.controller.prepareSocialAppReview({ appId: 44 }, 'en');
  assert.equal(reviewEn.success, false);
  assert.equal(reviewEn.userMessage, 'We could not prepare this app for review.');
  const reviewEs = await failing.controller.prepareSocialAppReview({ appId: 44 }, 'es');
  assert.equal(reviewEs.userMessage, 'No pudimos preparar esta app para revisión.');

  const expired = new Error('Please sign in again.');
  expired.technicalCode = 'forger_cloud_auth_expired';
  expired.details = { source: 'cloud' };
  const expiredHarness = await makeHarness({
    forgerBackendClient: { requestSocialAppDownload: async () => { throw expired; } },
  });
  t.after(expiredHarness.cleanup);
  const expiredResult = await expiredHarness.controller.installSocialAppRuntime({ appId: 44 });
  assert.equal(expiredResult.technicalCode, 'forger_cloud_auth_expired');
  assert.equal(expiredResult.userMessage, 'Please sign in again.');
  assert.deepEqual(expiredResult.details, { source: 'cloud' });

  const technical = new Error('Denied');
  technical.technicalCode = 'social_denied';
  const technicalHarness = await makeHarness({
    forgerBackendClient: { requestSocialAppDownload: async () => { throw technical; } },
  });
  t.after(technicalHarness.cleanup);
  const technicalResult = await technicalHarness.controller.installSocialAppRuntime({ appId: 44 });
  assert.equal(technicalResult.technicalCode, 'social_denied');
  assert.equal(technicalResult.details, undefined);

  const primitive = await makeHarness({
    forgerBackendClient: { requestSocialAppDownload: async () => { throw 'offline'; } },
  });
  t.after(primitive.cleanup);
  assert.equal((await primitive.controller.installSocialAppRuntime({ appSlug: 'x' })).technicalCode, 'social_install_failed');
});

test('skipped Social review is explicit and still installs through the private app lifecycle', async (t) => {
  const harness = await makeHarness({
    forgerBackendClient: {
      requestSocialAppDownload: async () => socialDownload(pathToFileURL(harness.sourceZip).href, {
        app: { id: 44, slug: 'shared-ledger', ownerUsername: 'Ana.User' },
      }),
    },
  });
  t.after(harness.cleanup);
  const result = await harness.controller.installSocialAppRuntime({ appId: 44, trustDecision: 'skipped_review' });
  assert.equal(result.success, true);
  assert.equal(result.appId, 'social-ana-user-shared-ledger');
  assert.ok(harness.calls.some((entry) => entry[0] === 'log' && entry[1] === 'social_install:review_skipped'));
});

test('reviewed Social share codes reuse resolution and accept manifests without service metadata', async (t) => {
  const harness = await makeHarness({ resolveInstalledManifest: async () => null });
  t.after(harness.cleanup);
  const result = await harness.controller.installSocialAppRuntime({ shareCode: 'REVIEW-44', trustDecision: 'reviewed' });
  assert.equal(result.success, true);
  assert.equal(harness.calls.filter((entry) => entry[0] === 'resolve').length, 1);
  assert.equal(harness.calls.filter((entry) => entry[0] === 'download').length, 2);
});

test('local file downloads decode URLs, verify checksums and use safe version fallbacks', async (t) => {
  const harness = await makeHarness();
  t.after(harness.cleanup);
  const buffer = await fs.readFile(harness.sourceZip);
  const checksum = createHash('sha256').update(buffer).digest('hex');
  const copied = await harness.controller.fetchDownloadBundle({
    id: 'local', downloadUrl: pathToFileURL(harness.sourceZip).href, checksumSha256: checksum,
  });
  assert.equal(copied.version, '0.0.0');
  assert.equal(copied.checksumSha256, checksum);
  assert.equal(await fs.readFile(copied.zipPath, 'utf8'), 'social archive');
  await assert.rejects(() => harness.controller.fetchDownloadBundle({
    id: 'local-bad', downloadUrl: pathToFileURL(harness.sourceZip).href, checksumSha256: 'bad',
  }), /app_zip_checksum_mismatch/);
  const withoutChecksum = await harness.controller.fetchDownloadBundle({
    id: 'local-no-checksum', downloadUrl: pathToFileURL(harness.sourceZip).href,
  });
  assert.equal(withoutChecksum.checksumSha256, undefined);
});

test('download resolution retains catalog checksums and defaults missing remote versions', async (t) => {
  const originalFetch = globalThis.fetch;
  const buffer = Buffer.from('remote archive');
  const checksum = createHash('sha256').update(buffer).digest('hex');
  const harness = await makeHarness({
    forgerBackendClient: {
      requestDownload: async () => ({
        download_url: '',
        version: { version: undefined, checksum_sha256: undefined },
      }),
    },
  });
  t.after(async () => {
    globalThis.fetch = originalFetch;
    await harness.cleanup();
  });
  harness.deps.forgerBackendClient.requestDownload = async () => ({
    download_url: pathToFileURL(harness.sourceZip).href,
    version: { version: '3.0.0', checksum_sha256: undefined },
  });
  const resolved = await harness.controller.fetchDownloadBundle({
    id: 'signed-local', latestVersionId: 'v3', checksumSha256: createHash('sha256').update('social archive').digest('hex'),
  });
  assert.equal(resolved.version, '3.0.0');

  globalThis.fetch = async () => new Response(buffer, { status: 200 });
  const remote = await harness.controller.fetchDownloadBundle({ id: 'remote', downloadUrl: 'https://download.test/archive.zip' });
  assert.equal(remote.version, '0.0.0');
  assert.equal(remote.checksumSha256, undefined);
  assert.equal(await fs.readFile(remote.zipPath, 'utf8'), 'remote archive');
  assert.notEqual(checksum, '');
});

test('minimal catalog records install with safe visible defaults and no official-tool gate payload', async (t) => {
  const harness = await makeHarness({
    catalogApps: [{
      id: 'minimal',
      category: 'productivity',
      downloadUrl: undefined,
      latestVersionId: 'minimal-v1',
    }],
    forgerBackendClient: {
      requestDownload: async () => ({
        download_url: pathToFileURL(harness.sourceZip).href,
        version: { version: undefined },
      }),
    },
    getOfficialToolsService: () => ({
      getInstallGate: async () => ({
        required: [{ declaration: { toolId: 'browser' }, available: true, configured: false }],
      }),
    }),
  });
  t.after(harness.cleanup);
  const result = await harness.controller.installAppRuntime('minimal');
  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(harness.registry.apps.minimal.name, 'minimal');
  assert.equal(harness.registry.apps.minimal.description, '');
  assert.equal(harness.registry.apps.minimal.version, '0.0.0');
});

test('approved Social reviews update existing installs and preserve fallback quarantine metadata', async (t) => {
  const harness = await makeHarness();
  t.after(harness.cleanup);
  const prepared = await harness.controller.prepareSocialAppReview({ appId: 44 });
  const record = prepared.quarantine;
  const indexPath = path.join(harness.metadataRoot, 'social-app-quarantine', 'index.json');
  const index = JSON.parse(await fs.readFile(indexPath, 'utf8'));
  delete index[record.quarantineId].category;
  await fs.writeFile(indexPath, JSON.stringify(index), 'utf8');
  const installDir = path.join(harness.root, 'existing-social');
  await fs.mkdir(installDir, { recursive: true });
  harness.registry.apps[record.localAppId] = {
    appId: record.localAppId,
    name: record.name,
    description: record.description,
    category: 'productivity',
    version: '2.1.0',
    installDir,
    status: 'installed',
    installedAt: new Date().toISOString(),
  };
  const result = await harness.controller.finishSocialAppInstall({ quarantineId: record.quarantineId });
  assert.equal(result.success, true);
  assert.equal(result.appId, record.localAppId);
});

test('failed approved Social installation returns the underlying install result unchanged', async (t) => {
  const harness = await makeHarness({ validateArchiveEntries: async () => { throw new Error('archive_invalid'); } });
  t.after(harness.cleanup);
  const quarantineRoot = path.join(harness.metadataRoot, 'social-app-quarantine');
  const quarantineDir = path.join(quarantineRoot, 'review-failed');
  await fs.mkdir(quarantineDir, { recursive: true });
  const zipPath = path.join(quarantineDir, 'source.zip');
  await fs.copyFile(harness.sourceZip, zipPath);
  const quarantine = {
    quarantineId: 'review-failed',
    userAppId: 44,
    localAppId: 'social-ana-user-shared-ledger',
    status: 'pending_review',
    name: 'Shared Ledger',
    slug: 'shared-ledger',
    ownerUsername: 'Ana.User',
    version: '2.1.0',
    zipPath,
    stagedDir: path.join(quarantineDir, 'staged'),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await fs.writeFile(path.join(quarantineRoot, 'index.json'), JSON.stringify({ [quarantine.quarantineId]: quarantine }), 'utf8');
  const result = await harness.controller.finishSocialAppInstall({ quarantineId: quarantine.quarantineId }, 'es');
  assert.equal(result.success, false);
  assert.equal(result.technicalCode, 'archive_invalid');
  assert.equal(result.appId, undefined);
});

test('managed Python locks and thrown native import probes serialize recovery without duplicate installers', async (t) => {
  const pendingHarness = await makeHarness();
  t.after(pendingHarness.cleanup);
  const python = '/runtime/python';
  const managedKey = `managed-python-uv:${path.resolve(python)}`;
  pendingHarness.deps.backendPythonEnvironmentLocks.set(managedKey, Promise.resolve());
  await pendingHarness.controller.installBackendDependenciesWithUv(python, path.join(pendingHarness.root, 'backend'), 'demo');

  let captureCount = 0;
  let recoveringBackendDir;
  const recovering = await makeHarness({
    runCommandCapture: async (_command, args) => {
      captureCount += 1;
      if (args[0] === '-m') return { code: 0, stdout: 'uv', stderr: '' };
      if (captureCount < 3) throw 'native import crashed';
      return { code: 0, stdout: '', stderr: '' };
    },
    runCommand: async (_command, args) => {
      if (args.includes('sync')) {
        await fs.mkdir(path.join(recoveringBackendDir, '.venv', 'bin'), { recursive: true });
        await fs.writeFile(path.join(recoveringBackendDir, '.venv', 'bin', 'python'), '', 'utf8');
      }
    },
  });
  t.after(recovering.cleanup);
  const backendDir = path.join(recovering.root, 'backend');
  recoveringBackendDir = backendDir;
  await fs.mkdir(path.join(backendDir, '.venv', 'bin'), { recursive: true });
  await fs.writeFile(path.join(backendDir, '.venv', 'bin', 'python'), '', 'utf8');
  await recovering.controller.ensureBackendPythonEnvironment(python, backendDir, 'demo', 'open');
  assert.ok(recovering.calls.some((entry) => entry[0] === 'log' && entry[1] === 'backend_python_env:repair_ready'));
});

test('Python environment diagnostics preserve signal, non-Error and stackless Error details', async (t) => {
  let accessCalls = 0;
  const missing = await makeHarness({
    fs: {
      ...fs,
      access: async () => {
        accessCalls += 1;
        if (accessCalls === 1) throw 'missing executable';
      },
    },
  });
  t.after(missing.cleanup);
  await missing.controller.ensureBackendPythonEnvironment('/runtime/python', '/virtual/backend', 'demo', 'open');

  let signalCalls = 0;
  const signal = await makeHarness({
    fs: { ...fs, access: async () => undefined },
    runCommandCapture: async (_command, args) => {
      signalCalls += 1;
      if (signalCalls === 1) return { code: null };
      return args[0] === '-m' ? { code: 0 } : { code: 0 };
    },
  });
  t.after(signal.cleanup);
  await signal.controller.ensureBackendPythonEnvironment('/runtime/python', '/virtual/backend', 'demo', 'open');
  assert.ok(signal.calls.some((entry) => entry[0] === 'log' && entry[1] === 'backend_python_env:repair_start'));

  let stacklessCalls = 0;
  const stackless = await makeHarness({
    fs: { ...fs, access: async () => undefined },
    runCommandCapture: async (_command, args) => {
      stacklessCalls += 1;
      if (stacklessCalls === 1) {
        const error = new Error('uv probe failed');
        error.stack = undefined;
        throw error;
      }
      return args[0] === '-m' ? { code: 0 } : { code: 0 };
    },
  });
  t.after(stackless.cleanup);
  await stackless.controller.ensureBackendPythonEnvironment('/runtime/python', '/virtual/backend', 'demo', 'open');

  let importCalls = 0;
  const importFailure = await makeHarness({
    fs: { ...fs, access: async () => undefined },
    runCommandCapture: async (_command, args) => {
      importCalls += 1;
      if (importCalls === 2) {
        const error = new Error('native import failed');
        error.stack = undefined;
        throw error;
      }
      return args[0] === '-m' ? { code: 0 } : { code: 0 };
    },
  });
  t.after(importFailure.cleanup);
  await importFailure.controller.ensureBackendPythonEnvironment('/runtime/python', '/virtual/backend', 'demo', 'open');

  let primitiveProbeCalls = 0;
  const primitiveProbe = await makeHarness({
    fs: { ...fs, access: async () => undefined },
    runCommandCapture: async () => {
      primitiveProbeCalls += 1;
      if (primitiveProbeCalls === 1) throw 'uv probe crashed';
      return { code: 0 };
    },
  });
  t.after(primitiveProbe.cleanup);
  await primitiveProbe.controller.ensureBackendPythonEnvironment('/runtime/python', '/virtual/backend', 'demo', 'open');

  let signaledImportCalls = 0;
  const signaledImport = await makeHarness({
    fs: { ...fs, access: async () => undefined },
    runCommandCapture: async () => {
      signaledImportCalls += 1;
      return { code: signaledImportCalls === 2 ? null : 0 };
    },
  });
  t.after(signaledImport.cleanup);
  await signaledImport.controller.ensureBackendPythonEnvironment('/runtime/python', '/virtual/backend', 'demo', 'open');

  const unrepaired = await makeHarness({
    fs: { ...fs, access: async () => undefined },
    runCommandCapture: async () => ({ code: 1 }),
  });
  t.after(unrepaired.cleanup);
  await assert.rejects(
    () => unrepaired.controller.ensureBackendPythonEnvironment('/runtime/python', '/virtual/backend', 'demo', 'open'),
    /backend_python_env_unusable_managed_uv_missing_1/,
  );
});

test('app updates preserve explicit stop fallbacks, missing heads and empty merge diagnostics', async (t) => {
  const updateCatalog = (sourceZip) => ({
    id: 'update-app',
    name: 'Update App',
    description: 'Updates',
    category: 'productivity',
    latestVersion: '2.0.0',
    downloadUrl: pathToFileURL(sourceZip).href,
  });
  const seed = async (harness) => {
    const installDir = path.join(harness.root, 'apps', 'update-app');
    await fs.mkdir(installDir, { recursive: true });
    harness.registry.apps['update-app'] = {
      appId: 'update-app',
      name: 'Update App',
      description: 'Updates',
      category: 'productivity',
      version: '1.0.0',
      installDir,
      requiredNodeVersion: '22.0.0',
      requiredPythonVersion: '3.12.0',
      status: 'installed',
      installedAt: new Date().toISOString(),
    };
  };

  const runningApps = new Map([['update-app', {}]]);
  const stopped = await makeHarness({
    catalogApps: [],
    runningApps,
    stopInstalledApp: async () => ({ success: false, userMessage: '', technicalCode: '' }),
  });
  t.after(stopped.cleanup);
  stopped.deps.catalogApps.push(updateCatalog(stopped.sourceZip));
  await seed(stopped);
  const stoppedResult = await stopped.controller.updateAppRuntime('update-app');
  assert.equal(stoppedResult.technicalCode, 'update_stop_failed');

  let volatileRegistry;
  const volatile = await makeHarness({
    catalogApps: [],
    runningApps: new Map([['update-app', {}]]),
    stopInstalledApp: async () => ({ success: false, userMessage: '', technicalCode: '' }),
    upsertInstalledRecord: async (record) => { delete volatileRegistry.apps[record.appId]; },
  });
  t.after(volatile.cleanup);
  volatileRegistry = volatile.registry;
  volatile.deps.catalogApps.push(updateCatalog(volatile.sourceZip));
  await seed(volatile);
  assert.equal((await volatile.controller.updateAppRuntime('update-app')).technicalCode, 'update_stop_failed');

  const headless = await makeHarness({ catalogApps: [], getGitHead: async () => null });
  t.after(headless.cleanup);
  headless.deps.catalogApps.push(updateCatalog(headless.sourceZip));
  await seed(headless);
  assert.equal((await headless.controller.updateAppRuntime('update-app')).technicalCode, 'missing_user_branch_head');

  const conflicted = await makeHarness({
    catalogApps: [],
    getBackupsManager: () => ({
      createBackup: async () => ({
        success: true,
        backup: { backupId: 'backup-1', appId: 'update-app', files: [] },
      }),
    }),
    runCommandCapture: async (_command, args) => args[0] === 'merge'
      ? { code: 1, stdout: '', stderr: '' }
      : { code: 0, stdout: '', stderr: '' },
  });
  t.after(conflicted.cleanup);
  conflicted.deps.catalogApps.push(updateCatalog(conflicted.sourceZip));
  await seed(conflicted);
  const conflict = await conflicted.controller.updateAppRuntime('update-app');
  assert.equal(conflict.phase, 'conflict');
  assert.equal(conflicted.registry.apps['update-app'].pendingUpdate.message, 'merge_conflict');
});

test('app details expose safe catalog-only and sparse installed summaries', async (t) => {
  const catalogOnly = await makeHarness({
    catalogApps: [{
      id: 'catalog-only', name: 'Catalog Only', category: 'productivity', version: '1.0.0', latestVersion: '1.1.0',
    }],
  });
  t.after(catalogOnly.cleanup);
  const catalogDetails = await catalogOnly.controller.getAppDetails('catalog-only');
  assert.equal(catalogDetails.installed, false);
  assert.equal(catalogDetails.status, 'not_installed');
  assert.equal(catalogDetails.version, '1.0.0');
  assert.deepEqual(catalogDetails.agents, []);
  assert.deepEqual(catalogDetails.operations, []);
  assert.deepEqual(catalogDetails.localChanges, []);
  assert.deepEqual(catalogDetails.promptTemplates, []);

  const sparse = await makeHarness({ catalogApps: [] });
  t.after(sparse.cleanup);
  sparse.registry.apps.sparse = {
    appId: 'sparse', name: 'Sparse', description: '', category: 'productivity', version: undefined,
    installDir: '', status: undefined, installedAt: new Date().toISOString(), originalCommitSha: 'original',
  };
  const sparseDetails = await sparse.controller.getAppDetails('sparse');
  assert.equal(sparseDetails.installed, true);
  assert.equal(sparseDetails.status, undefined);
  assert.equal(sparseDetails.codexConversation, undefined);

  const welcomeDir = path.join(sparse.root, 'welcome-empty');
  sparse.registry.apps.welcome = {
    appId: 'welcome', name: 'Lista', description: '', category: 'productivity', version: '1.0.0',
    installDir: welcomeDir, status: 'installed', installedAt: new Date().toISOString(),
  };
  const welcome = await sparse.controller.installWelcome('welcome', 'es-CL');
  assert.equal(welcome.success, true);
  assert.match(welcome.message, /Lista ya esta lista para usar\./);
});
