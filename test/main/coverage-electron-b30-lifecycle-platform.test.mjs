import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import fsModule from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

import {
  clearDistModule,
  createElectronAppMock,
  createIpcMainRecorder,
  withMockedElectron,
} from './electron-test-helpers.mjs';

const require = createRequire(import.meta.url);
const { IPC_CHANNELS } = require('../../dist-electron/shared/ipc.js');
const { AudioRuntimeBroker } = require('../../dist-electron/main/audio-runtime-broker.js');
const { AppFolderGrantStore } = require('../../dist-electron/main/app-folder-grants.js');
const permissionMode = require('../../dist-electron/main/agent-permission-mode.js');
const { LocalNetworkShareManager } = require('../../dist-electron/main/local-network-share-manager.js');
const { registerGracefulShutdownHandlers } = require('../../dist-electron/main/core/main-lifecycle-shutdown.js');

const fixture = async (t, name) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `forger-b30-${name}-`));
  t.after(async () => await fs.rm(root, { recursive: true, force: true }));
  return root;
};

const waitFor = async (predicate, label) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`condition_not_reached:${label}`);
};

test('Given renderer payload edge shapes, when the audio broker normalizes responses, then fallbacks stay typed and cancellation logs primitive failures', async (t) => {
  const { handlers, ipcMain } = createIpcMainRecorder();
  const requests = [];
  const logs = [];
  const broker = new AudioRuntimeBroker({
    IPC_CHANNELS,
    ipcMain,
    getMainWindow: () => ({
      isDestroyed: () => false,
      webContents: { send: (_channel, payload) => requests.push(payload) },
    }),
    appendInstallLog: async (event, payload) => { logs.push([event, payload]); },
  });
  broker.registerIpcHandlers();
  const respond = (payload) => handlers.get(IPC_CHANNELS.audioRuntimeBrokerResponse)(null, payload);

  const emptyDevices = broker.listDevices();
  await waitFor(() => requests.length === 1, 'empty-devices');
  await respond({ requestId: requests[0].requestId, success: true, result: null });
  assert.deepEqual(await emptyDevices, { inputDevices: [], outputDevices: [] });

  const devices = broker.listDevices();
  await waitFor(() => requests.length === 2, 'device-fallbacks');
  await respond({
    requestId: requests[1].requestId,
    success: true,
    result: {
      inputDevices: [{ id: 'mic', label: '', groupId: 7 }, null],
      outputDevices: [{ id: 'speaker', label: ' Main ', groupId: ' group ' }, null],
    },
  });
  assert.deepEqual(await devices, {
    inputDevices: [{ id: 'mic', label: 'Microphone', kind: 'microphone', default: false, supported: true }],
    outputDevices: [{ id: 'speaker', label: 'Main', kind: 'speaker', groupId: 'group', default: false, supported: true }],
  });

  const defaultFailure = broker.playAudio({ playbackId: 'failed', audioDataBase64: 'YQ==', mimeType: 'audio/wav' });
  await waitFor(() => requests.length === 3, 'default-failure');
  await respond({ requestId: requests[2].requestId, success: false });
  await assert.rejects(defaultFailure, /audio_runtime_broker_failed/);

  const normalizedFailure = broker.playAudio({ playbackId: 'result', audioDataBase64: 'YQ==', mimeType: 'audio/wav' });
  await waitFor(() => requests.length === 4, 'normalized-failure');
  await respond({ requestId: requests[3].requestId, success: true, result: { success: false, durationSeconds: Infinity, error: ' denied ' } });
  assert.deepEqual(await normalizedFailure, { success: false, error: 'denied' });

  const emptyPlayback = broker.playAudio({ playbackId: 'empty', audioDataBase64: 'YQ==', mimeType: 'audio/wav' });
  await waitFor(() => requests.length === 5, 'empty-playback');
  await respond({ requestId: requests[4].requestId, success: true, result: null });
  assert.deepEqual(await emptyPlayback, { success: false });

  broker.request = async () => { throw 'primitive cancel failure'; };
  await broker.cancelPlayback('primitive');
  assert.equal(logs.at(-1)[1].error, 'primitive cancel failure');
  broker.stop();
  t.after(() => broker.stop());
});

test('Given persisted grants with changed canonical paths and legacy shapes, when loaded, then unsafe grants fail and public fallbacks stay stable', async (t) => {
  const root = await fixture(t, 'folder-grants');
  const folder = path.join(root, 'shared');
  await fs.mkdir(folder);
  const store = new AppFolderGrantStore(root);
  const created = await store.create('finance', folder);
  const storePath = path.join(root, 'app-folder-grants.json');
  const persisted = JSON.parse(await fs.readFile(storePath, 'utf8'));
  persisted.grants[0].realPath = `${created.realPath}${path.sep}..${path.sep}${path.basename(created.realPath)}`;
  await fs.writeFile(storePath, JSON.stringify(persisted));
  await assert.rejects(new AppFolderGrantStore(root).resolve('finance', created.grantId), /folder_grant_path_changed/);

  await fs.writeFile(storePath, JSON.stringify({}));
  assert.deepEqual(await new AppFolderGrantStore(root).list('finance'), []);

  await fs.writeFile(storePath, JSON.stringify({
    grants: [{
      grantId: 'root',
      appId: 'finance',
      path: path.parse(root).root,
      realPath: path.parse(root).root,
      access: 'readWrite',
      createdAt: '2026-08-10T00:00:00.000Z',
    }],
  }));
  assert.deepEqual((await new AppFolderGrantStore(root).list('finance'))[0], {
    grantId: 'root',
    path: path.parse(root).root,
    realPath: path.parse(root).root,
    name: path.parse(root).root,
    access: 'readWrite',
    createdAt: '2026-08-10T00:00:00.000Z',
  });
});

test('Given Windows environment variants, when unsafe Claude roots are resolved, then windir, relative-drive fallback, mounted drives, and missing system roots are covered', () => {
  const original = {
    SystemRoot: process.env.SystemRoot,
    SystemDrive: process.env.SystemDrive,
    windir: process.env.windir,
    statSync: fsModule.statSync,
  };
  try {
    delete process.env.SystemRoot;
    process.env.windir = 'D:\\Windows';
    process.env.SystemDrive = 'relative-drive';
    fsModule.statSync = (candidate) => ({ isDirectory: () => candidate === 'Z:\\' });
    const roots = permissionMode.windowsMountedDriveRoots();
    assert.ok(roots.includes('relative-drive'));
    assert.ok(roots.includes('Z:\\'));

    delete process.env.windir;
    delete process.env.SystemDrive;
    assert.ok(permissionMode.windowsMountedDriveRoots().includes('Z:\\'));
  } finally {
    fsModule.statSync = original.statSync;
    for (const [key, value] of Object.entries(original)) {
      if (key === 'statSync') continue;
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test('Given complete and absent lifecycle services, when quit begins twice, then cleanup runs once, settles failures, and resumes Electron quit only after completion', async () => {
  const listeners = new Map();
  const calls = [];
  const app = {
    on: (event, listener) => listeners.set(event, listener),
    quit: () => calls.push('quit'),
  };
  const service = (name) => ({
    dispose: () => calls.push(`${name}:dispose`),
    stop: () => calls.push(`${name}:stop`),
    stopAll: async () => calls.push(`${name}:stopAll`),
    stopActiveTools: async () => calls.push(`${name}:stopActiveTools`),
  });
  const state = {
    memoryMaintenanceManager: service('memory'),
    personalAgentRoutineManager: service('routine'),
    automationManager: service('automation'),
    workflowFeatureController: service('workflow'),
    workflowManager: {},
    appMcpManager: service('mcp'),
    localNetworkShareManager: service('local'),
    remoteNetworkShareManager: service('remote'),
    remoteAgentSessionService: service('session'),
    desktopRuntimeBridge: service('runtime'),
    selfOAuthCallbackService: service('oauth'),
    officialToolsService: service('tools'),
    cloudDeviceManager: service('cloud'),
    devCatalogService: service('catalog'),
    forgerMcpServer: service('server'),
    speechToTextService: service('stt'),
    textToSpeechService: service('tts'),
    wakeWordService: service('wake'),
  };
  const runningApps = new Map([['finance', { backend: 'backend', frontend: 'frontend', proxyServer: 'proxy' }]]);
  registerGracefulShutdownHandlers({
    app,
    state,
    runningApps,
    stopInstalledApp: async (appId) => { calls.push(`stop:${appId}`); throw new Error('contained'); },
    terminateProcess: async (child) => calls.push(`terminate:${child}`),
    closeServer: async (server) => calls.push(`close:${server}`),
  });
  let prevented = 0;
  listeners.get('before-quit')({ preventDefault: () => { prevented += 1; } });
  listeners.get('before-quit')({ preventDefault: () => { prevented += 1; } });
  await waitFor(() => calls.includes('quit'), 'graceful-quit');
  assert.equal(prevented, 1);
  assert.equal(calls.filter((entry) => entry === 'routine:dispose').length, 1);
  assert.ok(calls.includes('terminate:backend'));
  assert.equal(state.workflowFeatureController, null);
  assert.equal(state.forgerMcpServer, null);

  const absentListeners = new Map();
  let absentStopped = false;
  registerGracefulShutdownHandlers({
    app: { on: (event, listener) => absentListeners.set(event, listener), quit: () => undefined },
    state: {},
    runningApps: new Map([['empty', { backend: null, frontend: null, proxyServer: null }]]),
    stopInstalledApp: async () => { absentStopped = true; },
    terminateProcess: async () => undefined,
    closeServer: async () => undefined,
  });
  absentListeners.get('before-quit')();
  await waitFor(() => absentStopped, 'absent-services');
});

const responseDouble = () => ({
  statusCode: 0,
  headers: new Map(),
  body: undefined,
  setHeader(key, value) { this.headers.set(key, value); },
  end(value) { this.body = value; },
});

const requestDouble = ({ url, method = 'GET', cookie } = {}) => {
  const request = new EventEmitter();
  request.url = url;
  request.method = method;
  request.headers = cookie ? { cookie } : {};
  request.destroy = () => undefined;
  return request;
};

test('Given synthetic HTTP edge requests, when LAN sharing handles them, then URL fallbacks, encoded traversal, primitive failures, and header absence fail safely', async (t) => {
  const events = [];
  const upstream = http.createServer((_request, response) => response.end('no content type'));
  const upstreamUrl = await new Promise((resolve, reject) => {
    upstream.once('error', reject);
    upstream.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${upstream.address().port}`));
  });
  t.after(() => new Promise((resolve) => upstream.close(resolve)));
  const runningApps = new Map([['finance', { frontendUrl: upstreamUrl }]]);
  const manager = new LocalNetworkShareManager({
    runningApps,
    openInstalledApp: async () => ({ success: false, userMessage: 'closed' }),
    appendInstallLog: async (event, payload) => { events.push([event, payload]); },
  });

  assert.equal((await manager.start('missing-code')).technicalCode, 'local_network_open_failed');

  const unauthorized = responseDouble();
  await manager.handleRequest({ appId: 'finance', url: '', sessions: new Set() }, requestDouble({ url: undefined }), unauthorized);
  assert.equal(unauthorized.statusCode, 401);

  const state = { appId: 'finance', url: 'http://public.test', sessions: new Set(['session']) };
  for (const url of ['/../secret', '/%2e%2e/secret']) {
    const response = responseDouble();
    await manager.handleRequest(state, requestDouble({ url, cookie: 'forger_lan_share=session' }), response);
    assert.equal(response.statusCode, 403);
  }

  const proxiedRequest = requestDouble({ url: '', cookie: 'forger_lan_share=session' });
  const proxiedResponse = responseDouble();
  const proxyPromise = manager.handleRequest(state, proxiedRequest, proxiedResponse);
  queueMicrotask(() => proxiedRequest.emit('end'));
  await proxyPromise;
  assert.equal(proxiedResponse.statusCode, 200);
  assert.equal(proxiedResponse.body.toString(), 'no content type');

  const undefinedUrlRequest = requestDouble({ url: undefined, cookie: 'forger_lan_share=session' });
  const undefinedUrlResponse = responseDouble();
  const undefinedUrlPromise = manager.handleRequest(state, undefinedUrlRequest, undefinedUrlResponse);
  queueMicrotask(() => undefinedUrlRequest.emit('end'));
  await undefinedUrlPromise;
  assert.equal(undefinedUrlResponse.statusCode, 200);

  manager.consumeToken = () => { throw 'primitive connect failure'; };
  const primitiveResponse = responseDouble();
  await manager.handleRequest(state, requestDouble({ url: '/connect/token' }), primitiveResponse);
  assert.equal(primitiveResponse.statusCode, 502);
  assert.equal(events.at(-1)[1].message, 'primitive connect failure');

  runningApps.delete('finance');
  manager.stop = async () => { throw 'primitive stop failure'; };
  const missingResponse = responseDouble();
  await manager.handleRequest(state, requestDouble({ url: '/', cookie: 'forger_lan_share=session' }), missingResponse);
  await waitFor(() => events.some(([, payload]) => payload?.message === 'primitive stop failure'), 'primitive-stop-log');
  assert.equal(missingResponse.statusCode, 424);

  const originalInterfaces = os.networkInterfaces;
  os.networkInterfaces = () => ({ ethernet: undefined });
  try {
    const fallbackManager = new LocalNetworkShareManager({
      runningApps: new Map([['fallback', { frontendUrl: upstreamUrl }]]),
      openInstalledApp: async () => ({ success: true }),
      appendInstallLog: async () => undefined,
    });
    t.after(() => fallbackManager.stopAll());
    assert.match((await fallbackManager.start('fallback')).status.url, /127\.0\.0\.1/);
  } finally {
    os.networkInterfaces = originalInterfaces;
  }
});

test('Given empty, file, and malformed navigation URLs, when window guards run, then only same-document destinations stay in the privileged window', async () => {
  const app = createElectronAppMock();
  const opened = [];
  const external = [];
  const windows = [];
  class BrowserWindowDouble {
    constructor() {
      this.currentUrl = '';
      this.webContents = {
        getURL: () => this.currentUrl,
        isLoading: () => false,
        on: (event, listener) => { this.webContents[event] = listener; },
        once: () => undefined,
        send: () => undefined,
        setWindowOpenHandler: (listener) => { this.webContents.openHandler = listener; },
      };
      windows.push(this);
    }
    async loadURL(url) { this.currentUrl = url; }
  }
  const { createWindowBootstrapController } = await withMockedElectron({ app, BrowserWindow: BrowserWindowDouble }, (mockedRequire) => {
    clearDistModule('main/deep-links.js');
    clearDistModule('main/core/window-bootstrap.js');
    return mockedRequire('../../dist-electron/main/core/window-bootstrap.js');
  });
  const state = { mainWindow: null, pendingDeepLink: null, pendingDeepLinkFlushScheduled: false };
  const controller = createWindowBootstrapController({
    BrowserWindow: BrowserWindowDouble,
    IPC_CHANNELS,
    app,
    desktopErrorReporter: null,
    focusDeepLinkWindow: () => undefined,
    getMainProcessIpcDeps: () => ({}),
    getMainWindow: () => state.mainWindow,
    getWindowState: () => ({}),
    ipcMain: createIpcMainRecorder().ipcMain,
    isDev: false,
    loadDesktopWindow: async () => undefined,
    path,
    registerAgentIpcHandlers: () => undefined,
    registerMainIpcHandlers: () => undefined,
    registerWindowIpcHandlers: () => undefined,
    registerWindowStateEvents: () => undefined,
    shell: {
      openExternal: async (url) => { external.push(url); },
      openPath: async (target) => { opened.push(target); return ''; },
    },
    state,
    useCustomWindowFrame: false,
  });
  await controller.createWindow();
  const [window] = windows;

  const prevented = [];
  window.webContents['will-navigate']({ preventDefault: () => prevented.push('empty') }, 'https://example.com');
  window.currentUrl = 'http://desktop.local/';
  window.webContents['will-navigate']({ preventDefault: () => prevented.push('invalid') }, 'not a valid url');

  const currentFile = path.join(os.tmpdir(), 'desktop.html');
  const otherFile = path.join(os.tmpdir(), 'other.html');
  window.currentUrl = pathToFileURL(currentFile).toString();
  window.webContents['will-navigate']({ preventDefault: () => prevented.push('same') }, pathToFileURL(currentFile).toString());
  window.webContents['will-navigate']({ preventDefault: () => prevented.push('other') }, pathToFileURL(otherFile).toString());
  window.webContents['will-navigate']({ preventDefault: () => prevented.push('http') }, 'https://example.com/docs');
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(prevented, ['empty', 'invalid', 'other', 'http']);
  assert.deepEqual(opened, [otherFile]);
  assert.deepEqual(external, ['https://example.com/', 'https://example.com/docs']);
});
