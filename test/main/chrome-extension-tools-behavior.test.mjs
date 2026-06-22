import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ChromeExtensionBridgeManager, __test } = require('../../dist-electron/main/tools/chrome-extension/manager.js');
const { CHROME_EXTENSION_DEV_ID } = require('../../dist-electron/main/tools/chrome-extension/types.js');
const { chromeExtensionToolModule, __resetChromeExtensionToolForTests } = require('../../dist-electron/main/tools/chrome-extension/index.js');

const createContext = (metadataRoot) => {
  let nextPort = 41_000 + Math.floor(Math.random() * 1000);
  return {
    metadataRoot,
    locale: 'es',
    secretsStore: {
      hasToolSecret: async () => false,
      getToolSecret: async () => undefined,
      setToolSecret: async () => ({ success: true }),
      deleteToolSecrets: async () => undefined,
    },
    getFreePort: async () => nextPort++,
    openExternalUrl: async () => undefined,
    isForgerAccountAuthenticated: () => true,
    getGmailOAuthClientId: async () => 'gmail-client-id',
    exchangeGmailOAuthCode: async () => ({}),
    refreshGmailOAuthAccessToken: async () => ({}),
    appendLog: async () => undefined,
  };
};

const connectFakeExtension = async (metadataRoot, channel = 'dev', extensionId = CHROME_EXTENSION_DEV_ID) => {
  const config = JSON.parse(await readFile(join(metadataRoot, 'official-tools', 'chrome-extension', 'bridge.json'), 'utf8'));
  const socket = new WebSocket(`ws://127.0.0.1:${config.port}/chrome-extension-native-host?token=${config.token}`);
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  socket.send(JSON.stringify({ type: 'hello', extensionId, channel }));
  return socket;
};

test('Chrome extension manager rejects unsafe URLs before command dispatch', () => {
  assert.equal(__test.isAllowedUrl('https://example.com'), true);
  assert.equal(__test.isAllowedUrl('http://localhost:5173'), true);
  assert.equal(__test.isAllowedUrl('file:///tmp/index.html'), false);
  assert.equal(__test.isAllowedUrl('chrome://extensions'), false);
  assert.equal(__test.isAllowedUrl('https://chrome.google.com/webstore/detail/example'), false);
});

test('Chrome extension manager detects dev connection and records sessions', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'forger-chrome-extension-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const context = createContext(root);
  const manager = new ChromeExtensionBridgeManager('dev');
  t.after(async () => {
    await manager.stop();
  });

  await manager.start(context);
  assert.equal((await manager.status(context)).connected, false);

  const socket = await connectFakeExtension(root);
  t.after(() => socket.close());
  await new Promise((resolve) => setTimeout(resolve, 25));
  const connected = await manager.status(context);
  assert.equal(connected.connected, true);
  assert.equal(connected.activeChannel, 'dev');

  socket.on('message', (raw) => {
    const message = JSON.parse(String(raw));
    if (message.action === 'open_dedicated_tab') {
      socket.send(JSON.stringify({
        requestId: message.requestId,
        success: true,
        data: { sessionId: 'session-1', windowId: 100, tabId: 200 },
      }));
    }
  });
  const response = await manager.sendCommand(context, 'open_dedicated_tab', { payload: { url: 'https://example.com' } });
  assert.equal(response.success, true);
  const afterOpen = await manager.status(context);
  assert.equal(afterOpen.sessions.length, 1);
  assert.equal(afterOpen.sessions[0].sessionId, 'session-1');
});

test('Chrome extension manager handles oversized native-host websocket frames without uncaught exceptions', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'forger-chrome-extension-oversized-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const context = createContext(root);
  const manager = new ChromeExtensionBridgeManager('dev', null, 256);
  t.after(async () => {
    await manager.stop();
  });

  await manager.start(context);
  const socket = await connectFakeExtension(root);
  t.after(() => socket.close());
  await new Promise((resolve) => setTimeout(resolve, 25));

  socket.on('message', (raw) => {
    const message = JSON.parse(String(raw));
    socket.send(JSON.stringify({
      requestId: message.requestId,
      success: true,
      data: { html: 'x'.repeat(2_000) },
    }));
  });

  const response = await manager.sendCommand(context, 'get_html', {});
  assert.equal(response.success, false);
  assert.equal(response.error.code, 'chrome_extension_bridge_socket_error');
  assert.match(response.error.message, /Max payload size exceeded|payload/i);
});

test('Chrome extension manager prefers production unless dev channel is forced', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'forger-chrome-extension-channel-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const productionId = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const context = createContext(root);
  const autoManager = new ChromeExtensionBridgeManager('auto', productionId);
  t.after(async () => {
    await autoManager.stop();
  });
  await autoManager.start(context);

  const devSocket = await connectFakeExtension(root);
  const prodSocket = await connectFakeExtension(root, 'production', productionId);
  t.after(() => {
    devSocket.close();
    prodSocket.close();
  });
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal((await autoManager.status(context)).activeChannel, 'production');

  const devRoot = await mkdtemp(join(tmpdir(), 'forger-chrome-extension-channel-dev-'));
  t.after(async () => {
    await rm(devRoot, { recursive: true, force: true });
  });
  const devContext = createContext(devRoot);
  const devManager = new ChromeExtensionBridgeManager('dev', productionId);
  t.after(async () => {
    await devManager.stop();
  });
  await devManager.start(devContext);
  const forcedDevSocket = await connectFakeExtension(devRoot);
  const forcedProdSocket = await connectFakeExtension(devRoot, 'production', productionId);
  t.after(() => {
    forcedDevSocket.close();
    forcedProdSocket.close();
  });
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal((await devManager.status(devContext)).activeChannel, 'dev');
});

test('Chrome extension official module exposes connection status and input validation', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'forger-chrome-extension-module-'));
  t.after(async () => {
    await __resetChromeExtensionToolForTests();
    await rm(root, { recursive: true, force: true });
  });
  const context = createContext(root);

  const status = await chromeExtensionToolModule.execute({
    toolId: 'forger_chrome_extension',
    actionId: 'forger_chrome_extension.connection.status',
  }, context);
  assert.equal(status.success, true);
  assert.equal(status.data.connected, false);

  const invalidOpen = await chromeExtensionToolModule.execute({
    toolId: 'forger_chrome_extension',
    actionId: 'forger_chrome_extension.open_dedicated_tab',
    input: { url: 'chrome://extensions' },
  }, context);
  assert.equal(invalidOpen.success, false);
  assert.equal(invalidOpen.technicalCode, 'chrome_extension_open_input_invalid');

  const invalidNavigate = await chromeExtensionToolModule.execute({
    toolId: 'forger_chrome_extension',
    actionId: 'forger_chrome_extension.navigate',
    input: { sessionId: 'session-1', url: 'file:///tmp/index.html' },
  }, context);
  assert.equal(invalidNavigate.success, false);
  assert.equal(invalidNavigate.technicalCode, 'chrome_extension_navigate_input_invalid');
});
