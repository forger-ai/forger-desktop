import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import { WebSocket } from 'ws';

const require = createRequire(import.meta.url);
const { ChromeExtensionBridgeManager, __test } = require('../../dist-electron/main/tools/chrome-extension/manager.js');
const { CHROME_EXTENSION_DEV_ID } = require('../../dist-electron/main/tools/chrome-extension/types.js');

const getFreePort = async () => await new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    server.close(() => resolve(address.port));
  });
});

const createContext = (metadataRoot, logs = []) => ({
  metadataRoot,
  locale: 'en',
  getFreePort,
  appendLog: (...args) => logs.push(args),
});

class FakeSocket extends EventEmitter {
  constructor(readyState = WebSocket.OPEN) {
    super();
    this.readyState = readyState;
    this.sent = [];
    this.closed = 0;
  }

  send(message) {
    this.sent.push(JSON.parse(String(message)));
  }

  close() {
    this.closed += 1;
  }
}

const emitJson = (socket, payload) => socket.emit('message', Buffer.from(JSON.stringify(payload)));

const withPlatform = async (platform, operation) => {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: platform });
  try {
    return await operation();
  } finally {
    Object.defineProperty(process, 'platform', descriptor);
  }
};

test('Given tool inputs, parsers enforce URL, selector, timeout, form, and style safety boundaries', () => {
  const manager = new ChromeExtensionBridgeManager();

  assert.deepEqual(manager.parseOpenDedicatedTabInput(null), { payload: {} });
  assert.deepEqual(manager.parseOpenDedicatedTabInput({}), { payload: {} });
  assert.deepEqual(manager.parseOpenDedicatedTabInput({ url: ' https://example.com ' }), { payload: { url: 'https://example.com' } });
  for (const url of ['not a url', 'file:///tmp/index.html', 'chrome://extensions', 'https://chrome.google.com/store', 'https://chromewebstore.google.com/item']) {
    assert.equal(manager.parseOpenDedicatedTabInput({ url }), null);
  }

  assert.equal(manager.parseSessionInput(null), null);
  assert.equal(manager.parseSessionInput({ sessionId: 1 }), null);
  assert.deepEqual(manager.parseSessionInput({ sessionId: ' session ' }), { sessionId: 'session' });
  assert.equal(manager.parseNavigateInput(null), null);
  assert.equal(manager.parseNavigateInput({ sessionId: '', url: 'https://example.com' }), null);
  assert.equal(manager.parseNavigateInput({ sessionId: 'session', url: '' }), null);
  assert.equal(manager.parseNavigateInput({ sessionId: 'session', url: 'ftp://example.com' }), null);
  assert.deepEqual(manager.parseNavigateInput({ sessionId: ' session ', url: ' http://localhost:3000 ' }), {
    sessionId: 'session', payload: { url: 'http://localhost:3000' },
  });

  assert.equal(manager.parseSelectorInput(null), null);
  assert.equal(manager.parseSelectorInput({ sessionId: '', selector: '#x' }), null);
  assert.equal(manager.parseSelectorInput({ sessionId: 'session' }), null);
  assert.deepEqual(manager.parseSelectorInput({ sessionId: 'session' }, { allowMissingSelector: true }), { sessionId: 'session', payload: {} });
  assert.deepEqual(manager.parseSelectorInput({ sessionId: 'session', selector: '#x', text: 4 }, { includeText: true }), {
    sessionId: 'session', payload: { selector: '#x', text: '' },
  });
  assert.deepEqual(manager.parseSelectorInput({ sessionId: 'session', selector: '#x', text: 'hello' }, { includeText: true }), {
    sessionId: 'session', payload: { selector: '#x', text: 'hello' },
  });

  assert.equal(manager.parseWaitForSelectorInput(null), null);
  assert.equal(manager.parseWaitForSelectorInput({ sessionId: 'session', selector: '#x', state: 'later' }), null);
  for (const timeoutMs of ['10', Infinity, 0, 60_001]) {
    assert.equal(manager.parseWaitForSelectorInput({ sessionId: 'session', selector: '#x', timeoutMs }), null);
  }
  for (const state of ['attached', 'visible', 'hidden', 'detached']) {
    const parsed = manager.parseWaitForSelectorInput({ sessionId: 'session', selector: '#x', state });
    assert.equal(parsed.payload.state, state);
    assert.equal(parsed.payload.timeoutMs, 10_000);
  }
  assert.equal(manager.parseWaitForSelectorInput({ sessionId: 'session', selector: '#x', timeoutMs: 1.9 }).payload.timeoutMs, 1);
  assert.equal(manager.parseWaitForSelectorInput({ sessionId: 'session', selector: '#x', timeoutMs: 60_000 }).commandTimeoutMs, 65_000);

  assert.equal(manager.parseSubmitFormInput(null), null);
  assert.deepEqual(manager.parseSubmitFormInput({ sessionId: 'session', selector: 'form' }), {
    sessionId: 'session', payload: { selector: 'form' },
  });
  assert.deepEqual(manager.parseSubmitFormInput({ sessionId: 'session', selector: 'form', submitSelector: ' button ' }), {
    sessionId: 'session', payload: { selector: 'form', submitSelector: 'button' },
  });

  assert.equal(manager.parseStylesInput(null, { includeStyles: false }), null);
  assert.deepEqual(manager.parseStylesInput({
    sessionId: 'session', selector: '#x', properties: [1, ' ', ' color ', ...Array.from({ length: 25 }, (_, index) => `p${index}`)],
  }, { includeStyles: false }).payload.properties.length, 20);
  assert.equal(manager.parseStylesInput({ sessionId: 'session', selector: '#x' }, { includeStyles: true }), null);
  assert.equal(manager.parseStylesInput({ sessionId: 'session', selector: '#x', styles: {} }, { includeStyles: true }), null);
  assert.equal(manager.parseStylesInput({
    sessionId: 'session', selector: '#x', styles: { ' ': 'ignored', color: 4, huge: 'x'.repeat(301) },
  }, { includeStyles: true }), null);
  assert.deepEqual(manager.parseStylesInput({
    sessionId: 'session', selector: '#x', styles: { color: 'red', display: 'block' },
  }, { includeStyles: true }).payload.styles, { color: 'red', display: 'block' });
});

test('Given native socket traffic, registration authenticates channels and settles response, error, close, and stop paths', async () => {
  const manager = new ChromeExtensionBridgeManager('auto', 'prod-extension');
  const unauthorized = new FakeSocket();
  manager.registerNativeHostSocket(unauthorized);
  unauthorized.emit('message', Buffer.from('{bad json'));
  for (const hello of [
    { type: 'hello', extensionId: '', channel: 'dev' },
    { type: 'hello', extensionId: CHROME_EXTENSION_DEV_ID, channel: 'unknown' },
    { type: 'hello', extensionId: 'wrong', channel: 'dev' },
    { type: 'hello', extensionId: 'wrong', channel: 'production' },
  ]) emitJson(unauthorized, hello);
  assert.equal(unauthorized.closed, 4);

  const dev = new FakeSocket();
  const production = new FakeSocket();
  manager.registerNativeHostSocket(dev);
  manager.registerNativeHostSocket(production);
  emitJson(dev, { type: 'hello', extensionId: CHROME_EXTENSION_DEV_ID, channel: 'dev' });
  const firstConnectedAt = manager.clients.get(`dev:${CHROME_EXTENSION_DEV_ID}`).connectedAt;
  emitJson(dev, { type: 'heartbeat', extensionId: CHROME_EXTENSION_DEV_ID, channel: 'dev' });
  assert.equal(manager.clients.get(`dev:${CHROME_EXTENSION_DEV_ID}`).connectedAt, firstConnectedAt);
  emitJson(production, { type: 'hello', extensionId: 'prod-extension', channel: 'production' });
  assert.equal(manager.getSelectedClient().channel, 'production');
  assert.equal(new ChromeExtensionBridgeManager('dev').getSelectedClient(), null);
  const devPreferred = new ChromeExtensionBridgeManager('dev');
  devPreferred.clients = manager.clients;
  assert.equal(devPreferred.getSelectedClient().channel, 'dev');
  production.readyState = WebSocket.CLOSED;
  assert.equal(manager.getSelectedClient().channel, 'dev');

  emitJson(dev, { requestId: 'missing', success: true });
  const responses = [];
  const makePending = (requestId) => {
    const timeout = setTimeout(() => {}, 10_000);
    timeout.unref();
    manager.pending.set(requestId, { timeout, resolve: (response) => responses.push(response) });
  };
  makePending('data');
  emitJson(dev, { requestId: 'data', success: true, data: { ok: true } });
  makePending('object-error');
  emitJson(dev, { requestId: 'object-error', success: false, error: { message: 'No.', code: 'denied' } });
  makePending('empty-object-error');
  emitJson(dev, { requestId: 'empty-object-error', success: false, error: {} });
  makePending('string-error');
  emitJson(dev, { requestId: 'string-error', success: false, error: 'Offline' });
  makePending('other-error');
  emitJson(dev, { requestId: 'other-error', success: false, error: 4 });
  assert.deepEqual(responses.map((response) => response.error), [
    undefined,
    { message: 'No.', code: 'denied' },
    {},
    { message: 'Offline' },
    { message: 'Chrome extension request failed.' },
  ]);

  makePending('socket-error');
  dev.emit('error', new Error(''));
  assert.equal(responses.at(-1).error.code, 'chrome_extension_bridge_socket_error');
  assert.equal(responses.at(-1).error.message, 'Chrome extension bridge socket failed.');
  makePending('socket-close');
  production.emit('close');
  assert.equal(responses.at(-1).error.code, 'chrome_extension_bridge_disconnected');

  const unregistered = new FakeSocket();
  manager.registerNativeHostSocket(unregistered);
  unregistered.emit('error', new Error('before hello'));
  unregistered.emit('close');
  manager.failPendingRequests('none', 'none');

  makePending('stopped');
  manager.clients.set('extra', { socket: new FakeSocket(), extensionId: 'x', channel: 'dev' });
  const serverCalls = [];
  manager.bridge = {
    websocketServer: { close: () => serverCalls.push('websocket') },
    server: {
      closeIdleConnections: () => serverCalls.push('idle'),
      closeAllConnections: () => serverCalls.push('all'),
      close: (callback) => { serverCalls.push('server'); callback(); },
    },
  };
  await manager.stop();
  assert.equal(responses.at(-1).error.code, 'chrome_extension_bridge_stopped');
  assert.deepEqual(serverCalls, ['websocket', 'idle', 'all', 'server']);
  await manager.stop();
});

test('Given command responses, sessions are persisted only for valid open and close mutations', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'forger-chrome-sessions-b10-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const context = createContext(root);
  const manager = new ChromeExtensionBridgeManager();

  await manager.loadSessions(context);
  await mkdir(manager.getMetadataDir(context), { recursive: true });
  await writeFile(manager.getSessionsPath(context), '{}', 'utf8');
  await manager.loadSessions(context);
  await writeFile(manager.getSessionsPath(context), JSON.stringify([
    null,
    {},
    { sessionId: 1, windowId: 1, tabId: 1, extensionChannel: 'dev', createdAt: 'now', updatedAt: 'now' },
    { sessionId: 'one', windowId: '1', tabId: 1, extensionChannel: 'dev', createdAt: 'now', updatedAt: 'now' },
    { sessionId: 'one', windowId: 1, tabId: '1', extensionChannel: 'dev', createdAt: 'now', updatedAt: 'now' },
    { sessionId: 'one', windowId: 1, tabId: 1, extensionChannel: 'other', createdAt: 'now', updatedAt: 'now' },
    { sessionId: 'one', windowId: 1, tabId: 1, extensionChannel: 'dev', createdAt: 1, updatedAt: 'now' },
    { sessionId: 'one', windowId: 1, tabId: 1, extensionChannel: 'dev', createdAt: 'now', updatedAt: 1 },
    { sessionId: 'dev', windowId: 1, tabId: 2, extensionChannel: 'dev', createdAt: 'now', updatedAt: 'now' },
    { sessionId: 'prod', windowId: 2, tabId: 3, extensionChannel: 'production', createdAt: 'now', updatedAt: 'now' },
  ]), 'utf8');
  await manager.loadSessions(context);
  assert.deepEqual([...manager.sessions.keys()], ['dev', 'prod']);

  await manager.applySessionMutation(context, 'open_dedicated_tab', 'dev', { success: false });
  for (const data of [null, {}, { sessionId: '', windowId: 3, tabId: 4 }, { sessionId: 'bad-window', windowId: '3', tabId: 4 }, { sessionId: 'bad-tab', windowId: 3, tabId: '4' }]) {
    await manager.applySessionMutation(context, 'open_dedicated_tab', 'dev', { success: true, data });
  }
  await manager.applySessionMutation(context, 'open_dedicated_tab', 'dev', {
    success: true, data: { sessionId: 'new', windowId: 8, tabId: 9 },
  });
  assert.equal(manager.sessions.get('new').extensionChannel, 'dev');

  await manager.applySessionMutation(context, 'close_session', 'dev', { success: true, data: null });
  await manager.applySessionMutation(context, 'close_session', 'dev', { success: true, data: { sessionId: '' } });
  await manager.applySessionMutation(context, 'close_session', 'dev', { success: true, data: { sessionId: 'missing' } });
  await manager.applySessionMutation(context, 'close_session', 'dev', { success: true, data: { sessionId: 'new' } });
  assert.equal(manager.sessions.has('new'), false);

  await manager.applySessionMutation(context, 'close_window', 'dev', { success: true, data: null });
  await manager.applySessionMutation(context, 'close_window', 'dev', { success: true, data: { sessionId: '', windowId: 'bad' } });
  manager.sessions.set('same-window', { sessionId: 'same-window', windowId: 2, tabId: 5, extensionChannel: 'dev', createdAt: 'now', updatedAt: 'now' });
  manager.sessions.set('other-window', { sessionId: 'other-window', windowId: 99, tabId: 6, extensionChannel: 'dev', createdAt: 'now', updatedAt: 'now' });
  await manager.applySessionMutation(context, 'close_window', 'dev', { success: true, data: { sessionId: 'dev', windowId: 2 } });
  assert.equal(manager.sessions.has('dev'), false);
  assert.equal(manager.sessions.has('prod'), false);
  assert.equal(manager.sessions.has('same-window'), false);
  assert.equal(manager.sessions.has('other-window'), true);
  assert.ok(JSON.parse(await readFile(manager.getSessionsPath(context), 'utf8')).length > 0);
});

test('Given platform-specific native host registration, paths stay portable and configuration writes only inside the selected root', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'forger-chrome-manifest-b10-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  assert.equal(typeof __test.nativeMessagingManifestPath, 'function');
  await withPlatform('darwin', async () => assert.match(__test.nativeMessagingManifestPath(), /Library\/Application Support/));
  await withPlatform('linux', async () => assert.match(__test.nativeMessagingManifestPath(), /\.config\/google-chrome/));
  const previousLocalAppData = process.env.LOCALAPPDATA;
  t.after(() => {
    if (previousLocalAppData === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = previousLocalAppData;
  });
  process.env.LOCALAPPDATA = root;
  try {
    await withPlatform('win32', async () => assert.equal(__test.nativeMessagingManifestPath(), join(root, 'Forger', 'ChromeNativeMessagingHosts', 'com.forger.chrome_extension.json')));
    delete process.env.LOCALAPPDATA;
    await withPlatform('win32', async () => assert.match(__test.nativeMessagingManifestPath(), /AppData\/Local/));
    await withPlatform('freebsd', async () => assert.match(__test.nativeMessagingManifestPath(), /\.com\.forger\.chrome_extension\.json$/));
  } finally {
    if (previousLocalAppData === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = previousLocalAppData;
  }

  process.env.LOCALAPPDATA = root;
  const logs = [];
  const manager = new ChromeExtensionBridgeManager('auto', 'prod-extension');
  t.after(async () => manager.stop());
  await withPlatform('win32', async () => {
    const status = await manager.configure(createContext(root, logs));
    assert.equal(status.connected, false);
    assert.equal(status.nativeHostManifestPath, join(root, 'Forger', 'ChromeNativeMessagingHosts', 'com.forger.chrome_extension.json'));
  });
  const manifest = JSON.parse(await readFile(join(root, 'Forger', 'ChromeNativeMessagingHosts', 'com.forger.chrome_extension.json'), 'utf8'));
  assert.deepEqual(manifest.allowed_origins, [
    `chrome-extension://${CHROME_EXTENSION_DEV_ID}/`,
    'chrome-extension://prod-extension/',
  ]);
  assert.equal(logs[0][0], 'chrome_extension:native_host_registered');
  assert.equal(await manager.isConfigured(createContext(root)), false);
  await manager.start(createContext(root));

  const contextWithoutLog = createContext(root);
  delete contextWithoutLog.appendLog;
  const withoutProduction = new ChromeExtensionBridgeManager('auto', null);
  withoutProduction.bridge = manager.bridge;
  await withPlatform('win32', async () => withoutProduction.writeNativeMessagingManifest(contextWithoutLog));
  withoutProduction.bridge = null;

  const notStarted = new ChromeExtensionBridgeManager();
  await assert.rejects(notStarted.writeNativeMessagingManifest(createContext(root)), /chrome_extension_bridge_not_started/);
});

test('Given environment defaults and command state, construction and dispatch cover disconnected, missing-session, response, timeout, and upgrade rejection', async (t) => {
  const previousChannel = process.env.FORGER_CHROME_EXTENSION_CHANNEL;
  const previousId = process.env.FORGER_CHROME_EXTENSION_ID;
  process.env.FORGER_CHROME_EXTENSION_CHANNEL = 'dev';
  process.env.FORGER_CHROME_EXTENSION_ID = ' production-id ';
  const fromEnvironment = new ChromeExtensionBridgeManager();
  assert.equal(fromEnvironment.preferredChannel, 'dev');
  assert.equal(fromEnvironment.productionExtensionId, 'production-id');
  delete process.env.FORGER_CHROME_EXTENSION_CHANNEL;
  process.env.FORGER_CHROME_EXTENSION_ID = '   ';
  const defaults = new ChromeExtensionBridgeManager();
  assert.equal(defaults.preferredChannel, 'auto');
  assert.equal(defaults.productionExtensionId, null);
  if (previousChannel === undefined) delete process.env.FORGER_CHROME_EXTENSION_CHANNEL;
  else process.env.FORGER_CHROME_EXTENSION_CHANNEL = previousChannel;
  if (previousId === undefined) delete process.env.FORGER_CHROME_EXTENSION_ID;
  else process.env.FORGER_CHROME_EXTENSION_ID = previousId;

  const root = await mkdtemp(join(tmpdir(), 'forger-chrome-command-b10-'));
  t.after(async () => {
    await defaults.stop();
    await rm(root, { recursive: true, force: true });
  });
  const context = createContext(root);
  defaults.start = async () => undefined;
  assert.equal((await defaults.sendCommand(context, 'get_html', {})).error.code, 'chrome_extension_not_connected');
  const socket = new FakeSocket();
  defaults.clients.set('dev', { socket, extensionId: CHROME_EXTENSION_DEV_ID, channel: 'dev', connectedAt: 'now', lastHeartbeatAt: 'now' });
  assert.equal((await defaults.sendCommand(context, 'get_html', { sessionId: 'missing' })).error.code, 'chrome_extension_session_not_found');
  defaults.sessions.set('session', { sessionId: 'session', windowId: 1, tabId: 2, extensionChannel: 'dev', createdAt: 'now', updatedAt: 'now' });
  socket.send = (message) => {
    const command = JSON.parse(String(message));
    queueMicrotask(() => {
      const pending = defaults.pending.get(command.requestId);
      clearTimeout(pending.timeout);
      defaults.pending.delete(command.requestId);
      pending.resolve({ requestId: command.requestId, success: true, data: {} });
    });
  };
  assert.equal((await defaults.sendCommand(context, 'noop', { sessionId: 'session', payload: { value: 1 } }, { timeoutMs: 1.9 })).success, true);
  assert.equal((await defaults.sendCommand(context, 'noop', {}, { timeoutMs: Infinity })).success, true);

  const timedOut = new ChromeExtensionBridgeManager();
  timedOut.start = async () => undefined;
  timedOut.clients.set('dev', { socket: new FakeSocket(), extensionId: CHROME_EXTENSION_DEV_ID, channel: 'dev', connectedAt: 'now', lastHeartbeatAt: 'now' });
  assert.equal((await timedOut.sendCommand(context, 'timeout', {}, { timeoutMs: 1 })).error.code, 'chrome_extension_request_timeout');

  const actual = new ChromeExtensionBridgeManager();
  t.after(async () => actual.stop());
  await actual.start(context);
  const upgrade = actual.bridge.server.listeners('upgrade')[0];
  const rejected = { destroyed: 0, destroy() { this.destroyed += 1; } };
  upgrade({ url: undefined, headers: {} }, rejected, Buffer.alloc(0));
  upgrade({ url: '/wrong', headers: { host: undefined } }, rejected, Buffer.alloc(0));
  assert.equal(rejected.destroyed, 2);
});
