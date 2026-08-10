import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const electronPath = require.resolve('electron');
require.cache[electronPath] = {
  id: electronPath,
  filename: electronPath,
  loaded: true,
  exports: { shell: { openPath: async () => '' } },
};
const { DesktopUpdater } = require('../../dist-electron/main/desktop-updater.js');
const { DevCatalogService, __testDevCatalogInternals } = require('../../dist-electron/main/dev-catalog-service.js');

const tempRoot = async (t, name) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `forger-b29-${name}-`));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
};

const withFetch = async (fetchImpl, action) => {
  const previous = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    return await action();
  } finally {
    globalThis.fetch = previous;
  }
};

const release = (version, overrides = {}) => ({
  schemaVersion: 1,
  version,
  publishedAt: `2026-08-${version === '1.2.0' ? '10' : '09'}T00:00:00.000Z`,
  releaseNotes: { changes: ['Visible change'] },
  assets: [{
    platform: process.platform,
    arch: process.arch,
    kind: process.platform === 'win32' ? 'nsis' : 'dmg',
    url: `https://github.com/forger-ai/desktop/releases/download/v${version}/forger-installer`,
  }],
  ...overrides,
});

test('desktop updater accepts a valid metadata index and supplies release-summary fallbacks', async (t) => {
  const root = await tempRoot(t, 'updater-index');
  const updater = new DesktopUpdater({
    currentVersion: '1.0.0',
    metadataUrl: 'https://metadata.test/latest.json',
    userDataPath: root,
  });
  const state = await withFetch(async (url) => String(url).endsWith('/index.json')
    ? Response.json({ schemaVersion: 1, releases: [release('1.1.0', { releaseNotes: { changes: [] } })] })
    : Response.json(release('1.2.0')), () => updater.check());
  assert.equal(state.status, 'available');
  assert.deepEqual(state.pendingReleaseSummaries, [{
    version: '1.1.0',
    publishedAt: '2026-08-09T00:00:00.000Z',
    summary: 'Forger Desktop v1.1.0',
  }]);
  assert.equal(state.diagnosticDetails, undefined);
});

test('desktop updater classifies malformed index entries without blocking valid latest metadata', async (t) => {
  const root = await tempRoot(t, 'updater-invalid-index');
  const updater = new DesktopUpdater({
    currentVersion: '1.0.0',
    metadataUrl: 'https://metadata.test/latest.json',
    userDataPath: root,
  });
  const state = await withFetch(async (url) => String(url).endsWith('/index.json')
    ? Response.json({ schemaVersion: 1, releases: [null] })
    : Response.json(release('1.2.0')), () => updater.check());
  assert.equal(state.status, 'available');
  assert.deepEqual(state.pendingReleaseSummaries, []);
});

test('desktop updater redacts empty failure causes and maps non-Error network failures to a stable diagnostic', async (t) => {
  const root = await tempRoot(t, 'updater-errors');
  const blankCause = new Error('fetch failed', { cause: { code: ' ', name: ' ' } });
  let requestCount = 0;
  const withBlankCause = new DesktopUpdater({
    currentVersion: '1.0.0',
    metadataUrl: 'https://metadata.test/latest.json',
    userDataPath: root,
  });
  const blankState = await withFetch(async () => {
    requestCount += 1;
    if (requestCount === 1) return Response.json({ schemaVersion: 1, releases: [] });
    throw blankCause;
  }, () => withBlankCause.check());
  assert.equal(blankState.technicalCode, 'desktop_update_metadata_fetch_failed');
  assert.equal(blankState.diagnosticDetails.errorCauseCode, undefined);
  assert.equal(blankState.diagnosticDetails.errorCauseName, undefined);

  const nullFailure = new DesktopUpdater({
    currentVersion: '1.0.0',
    metadataUrl: 'https://metadata.test/latest.json',
    userDataPath: root,
  });
  const nullState = await withFetch(async () => { throw null; }, () => nullFailure.check());
  assert.equal(nullState.technicalCode, 'desktop_update_metadata_failed');
  assert.equal(nullState.diagnosticDetails.reason, 'unknown_error');
  assert.equal(nullState.diagnosticDetails.errorName, 'object');
});

test('desktop updater opens Windows installers without requesting an app quit', async (t) => {
  const root = await tempRoot(t, 'updater-windows-install');
  const installerPath = path.join(root, 'installer.exe');
  await fs.writeFile(installerPath, 'installer');
  const updater = new DesktopUpdater({ currentVersion: '1.0.0', userDataPath: root });
  updater.state = {
    status: 'ready',
    currentVersion: '1.0.0',
    availableVersion: '1.1.0',
    downloadedPath: installerPath,
    asset: { platform: 'win32', arch: 'x64', kind: 'nsis', url: 'https://github.com/forger/installer.exe' },
    userMessage: 'Ready',
  };
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  try {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' });
    const state = await updater.install();
    assert.equal(state.status, 'installer_opened');
    assert.equal(state.installerRequiresQuit, false);
    assert.equal(state.installerQuitDelaySeconds, undefined);
  } finally {
    Object.defineProperty(process, 'platform', platform);
  }
});

const mockResponse = (options = {}) => ({
  statusCode: 0,
  headers: {},
  body: '',
  writeCalls: 0,
  writeHead(statusCode, headers) {
    this.writeCalls += 1;
    if (options.throwFirstWrite && this.writeCalls === 1) throw 'response failed';
    this.statusCode = statusCode;
    this.headers = headers;
  },
  end(body = '') {
    this.body = Buffer.isBuffer(body) ? body.toString('utf8') : String(body);
  },
});

const withLocalApps = async (value, action) => {
  const previous = process.env.FORGER_LOCAL_APPS;
  if (value === undefined) delete process.env.FORGER_LOCAL_APPS;
  else process.env.FORGER_LOCAL_APPS = value;
  try {
    return await action();
  } finally {
    if (previous === undefined) delete process.env.FORGER_LOCAL_APPS;
    else process.env.FORGER_LOCAL_APPS = previous;
  }
};

test('dev catalog command runner supports commands without a timeout and an empty local-app environment', async () => {
  const command = await __testDevCatalogInternals.runCommand(process.execPath, ['-e', 'process.stdout.write("ok")'], {
    cwd: process.cwd(),
    timeoutMs: 0,
  });
  assert.equal(command.stdout, 'ok');

  const service = new DevCatalogService();
  const response = mockResponse();
  await withLocalApps(undefined, () => service.handleRequest({ method: 'GET' }, response));
  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(response.body), { ok: true, local_apps: [] });
});

test('dev catalog skips non-file manifests and reports unexpected filesystem failures', async (t) => {
  const root = await tempRoot(t, 'dev-catalog-stat');
  const directoryManifestApp = path.join(root, 'directory-manifest');
  await fs.mkdir(path.join(directoryManifestApp, 'manifest.json'), { recursive: true });
  const skipped = mockResponse();
  await withLocalApps(directoryManifestApp, () => new DevCatalogService().handleRequest({ method: 'GET', url: '/health' }, skipped));
  assert.deepEqual(JSON.parse(skipped.body), { ok: true, local_apps: [] });

  const loopApp = path.join(root, 'loop-manifest');
  await fs.mkdir(loopApp, { recursive: true });
  await fs.symlink(path.join(loopApp, 'manifest.json'), path.join(loopApp, 'manifest.json'));
  const failed = mockResponse();
  await withLocalApps(loopApp, () => new DevCatalogService().handleRequest({ method: 'GET', url: '/health' }, failed));
  assert.equal(failed.statusCode, 500);
  assert.equal(JSON.parse(failed.body).error, 'dev_catalog_error');
});

test('dev catalog accepts successful empty git metadata and sanitizes non-Error response failures', async (t) => {
  const root = await tempRoot(t, 'dev-catalog-git');
  const appDir = path.join(root, 'app');
  const fakeBin = path.join(root, 'bin');
  await fs.mkdir(appDir, { recursive: true });
  await fs.mkdir(fakeBin, { recursive: true });
  await fs.writeFile(path.join(appDir, 'manifest.json'), JSON.stringify({ name: 'Local App', version: '1.0.0' }));
  const fakeGit = path.join(fakeBin, 'git');
  await fs.writeFile(fakeGit, '#!/usr/bin/env node\nprocess.exit(0);\n');
  await fs.chmod(fakeGit, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${fakeBin}${path.delimiter}${previousPath ?? ''}`;
  try {
    const catalog = mockResponse();
    await withLocalApps(appDir, () => new DevCatalogService().handleRequest({ method: 'GET', url: '/catalog.json' }, catalog));
    assert.equal(catalog.statusCode, 200);
    assert.equal(JSON.parse(catalog.body)[0].slug, 'Local App-dev');
  } finally {
    process.env.PATH = previousPath;
  }

  const recovered = mockResponse({ throwFirstWrite: true });
  await withLocalApps(undefined, () => new DevCatalogService().handleRequest({ method: 'GET', url: '/missing' }, recovered));
  assert.equal(recovered.statusCode, 500);
  assert.equal(JSON.parse(recovered.body).detail, 'response failed');
});
