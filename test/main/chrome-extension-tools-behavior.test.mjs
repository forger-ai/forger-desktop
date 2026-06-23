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
const { getAgentToolPackages } = require('../../dist-electron/main/core/agent-tool-packages.js');

const createContext = (metadataRoot, locale = 'es') => {
  let nextPort = 41_000 + Math.floor(Math.random() * 1000);
  return {
    metadataRoot,
    locale,
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

test('Chrome extension agent tool metadata is localized', () => {
  const englishPackage = getAgentToolPackages('en').find((toolPackage) => toolPackage.id === 'official:forger_chrome_extension');
  assert.ok(englishPackage);
  assert.equal(englishPackage.description, 'Operates a dedicated Chrome window through the Forger extension and a local bridge.');
  assert.equal(
    englishPackage.tools.find((tool) => tool.id === 'forger_chrome_extension.open_dedicated_tab')?.name,
    'Open dedicated tab',
  );

  const spanishPackage = getAgentToolPackages('es').find((toolPackage) => toolPackage.id === 'official:forger_chrome_extension');
  assert.ok(spanishPackage);
  assert.equal(spanishPackage.description, 'Opera una ventana dedicada de Chrome mediante la extension de Forger y un puente local.');
  assert.equal(
    spanishPackage.tools.find((tool) => tool.id === 'forger_chrome_extension.open_dedicated_tab')?.name,
    'Abrir pestaña dedicada',
  );
});

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
    if (message.action === 'close_window') {
      socket.send(JSON.stringify({
        requestId: message.requestId,
        success: true,
        data: { sessionId: 'session-1', windowId: 100, closed: true },
      }));
    }
  });
  const response = await manager.sendCommand(context, 'open_dedicated_tab', { payload: { url: 'https://example.com' } });
  assert.equal(response.success, true);
  const afterOpen = await manager.status(context);
  assert.equal(afterOpen.sessions.length, 1);
  assert.equal(afterOpen.sessions[0].sessionId, 'session-1');

  const closeResponse = await manager.sendCommand(context, 'close_window', { sessionId: 'session-1' });
  assert.equal(closeResponse.success, true);
  assert.equal((await manager.status(context)).sessions.length, 0);
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

test('Chrome extension manager supports per-command request timeouts', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'forger-chrome-extension-timeout-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const context = createContext(root);
  const manager = new ChromeExtensionBridgeManager('dev');
  t.after(async () => {
    await manager.stop();
  });

  await manager.start(context);
  const socket = await connectFakeExtension(root);
  t.after(() => socket.close());
  await new Promise((resolve) => setTimeout(resolve, 25));

  const startedAt = Date.now();
  const response = await manager.sendCommand(context, 'wait_for_selector', {}, { timeoutMs: 25 });
  assert.equal(response.success, false);
  assert.equal(response.error.code, 'chrome_extension_request_timeout');
  assert.ok(Date.now() - startedAt < 1000);
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

  const invalidWait = await chromeExtensionToolModule.execute({
    toolId: 'forger_chrome_extension',
    actionId: 'forger_chrome_extension.wait_for_selector',
    input: { sessionId: 'session-1', selector: '#ready', state: 'visible', timeoutMs: 60001 },
  }, context);
  assert.equal(invalidWait.success, false);
  assert.equal(invalidWait.technicalCode, 'chrome_extension_wait_for_selector_input_invalid');

  const socket = await connectFakeExtension(root);
  t.after(() => socket.close());
  socket.on('message', (raw) => {
    const message = JSON.parse(String(raw));
    if (message.action === 'open_dedicated_tab') {
      socket.send(JSON.stringify({
        requestId: message.requestId,
        success: true,
        data: { sessionId: 'session-1', windowId: 100, tabId: 200 },
      }));
    }
    if (message.action === 'wait_for_selector') {
      assert.deepEqual(message.payload, {
        selector: '#ready',
        state: 'hidden',
        timeoutMs: 1200,
      });
      socket.send(JSON.stringify({
        requestId: message.requestId,
        success: true,
        data: { matched: true, state: 'hidden', elapsedMs: 10, selector: '#ready' },
      }));
    }
    if (message.action === 'close_window') {
      socket.send(JSON.stringify({
        requestId: message.requestId,
        success: true,
        data: { sessionId: 'session-1', windowId: 100, closed: true },
      }));
    }
  });
  await new Promise((resolve) => setTimeout(resolve, 25));
  const opened = await chromeExtensionToolModule.execute({
    toolId: 'forger_chrome_extension',
    actionId: 'forger_chrome_extension.open_dedicated_tab',
    input: { url: 'https://example.com' },
  }, context);
  assert.equal(opened.success, true);
  const waited = await chromeExtensionToolModule.execute({
    toolId: 'forger_chrome_extension',
    actionId: 'forger_chrome_extension.wait_for_selector',
    input: { sessionId: 'session-1', selector: '#ready', state: 'hidden', timeoutMs: 1200 },
  }, context);
  assert.equal(waited.success, true);
  assert.equal(waited.data.state, 'hidden');

  const closedWindow = await chromeExtensionToolModule.execute({
    toolId: 'forger_chrome_extension',
    actionId: 'forger_chrome_extension.close_window',
    input: { sessionId: 'session-1' },
  }, context);
  assert.equal(closedWindow.success, true);
});

test('Chrome extension official module localizes validation messages', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'forger-chrome-extension-localized-'));
  t.after(async () => {
    await __resetChromeExtensionToolForTests();
    await rm(root, { recursive: true, force: true });
  });
  const context = createContext(root, 'en');

  const invalidOpen = await chromeExtensionToolModule.execute({
    toolId: 'forger_chrome_extension',
    actionId: 'forger_chrome_extension.open_dedicated_tab',
    input: { url: 'chrome://extensions' },
  }, context);
  assert.equal(invalidOpen.success, false);
  assert.equal(invalidOpen.technicalCode, 'chrome_extension_open_input_invalid');
  assert.equal(invalidOpen.userMessage, 'Enter a valid http or https URL.');

  const unknown = await chromeExtensionToolModule.execute({
    toolId: 'forger_chrome_extension',
    actionId: 'forger_chrome_extension.unknown',
  }, context);
  assert.equal(unknown.success, false);
  assert.equal(unknown.technicalCode, 'chrome_extension_action_unknown');
  assert.equal(unknown.userMessage, 'That Chrome action is not available.');
});
