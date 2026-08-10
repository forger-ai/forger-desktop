import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ChromeExtensionBridgeManager } = require('../../dist-electron/main/tools/chrome-extension/manager.js');
const {
  CHROME_EXTENSION_NATIVE_HOST_NAME,
  chromeExtensionToolModule,
  __resetChromeExtensionToolForTests,
} = require('../../dist-electron/main/tools/chrome-extension/index.js');

const createContext = (metadataRoot, locale = 'en') => ({
  metadataRoot,
  locale,
  secretsStore: {
    hasToolSecret: async () => false,
    getToolSecret: async () => undefined,
    setToolSecret: async () => ({ success: true }),
    deleteToolSecrets: async () => undefined,
  },
  getFreePort: async () => 41_234,
  openExternalUrl: async () => undefined,
  isForgerAccountAuthenticated: () => true,
  getGmailOAuthClientId: async () => 'gmail-client-id',
  exchangeGmailOAuthCode: async () => ({}),
  refreshGmailOAuthAccessToken: async () => ({}),
  appendLog: async () => undefined,
});

test('Given the Chrome extension tool, each action validates and dispatches its normalized bridge command', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'forger-chrome-b9-'));
  t.after(async () => {
    await __resetChromeExtensionToolForTests();
    await rm(root, { recursive: true, force: true });
  });
  const calls = [];
  let configureMode = 'connected';
  let commandMode = 'success';
  ChromeExtensionBridgeManager.prototype.configure = async () => {
    calls.push(['configure']);
    if (configureMode === 'error') throw new Error('manifest_denied');
    if (configureMode === 'value') throw 'manifest_denied';
    return { connected: configureMode === 'connected' };
  };
  ChromeExtensionBridgeManager.prototype.status = async () => ({ configured: true, connected: true, sessions: [] });
  ChromeExtensionBridgeManager.prototype.isConfigured = async () => true;
  ChromeExtensionBridgeManager.prototype.start = async () => calls.push(['start']);
  ChromeExtensionBridgeManager.prototype.stop = async () => calls.push(['stop']);
  ChromeExtensionBridgeManager.prototype.sendCommand = async (_context, action, input, options) => {
    calls.push([action, input, options]);
    if (commandMode === 'error') throw new Error('bridge_failed');
    if (commandMode === 'value') throw 'bridge_failed';
    if (commandMode === 'failure-full') {
      return { requestId: 'request', success: false, error: { code: 'extension_rejected', message: 'Rejected by extension.' } };
    }
    if (commandMode === 'failure-empty') return { requestId: 'request', success: false };
    return { requestId: 'request', success: true, data: { action, input, options } };
  };

  const context = createContext(root);
  const invoke = async (action, input) => chromeExtensionToolModule.execute({
    toolId: 'forger_chrome_extension',
    actionId: `forger_chrome_extension.${action}`,
    input,
  }, context);

  assert.equal(CHROME_EXTENSION_NATIVE_HOST_NAME, 'com.forger.chrome_extension');
  await chromeExtensionToolModule.stop();
  await chromeExtensionToolModule.deactivate();

  const connected = await chromeExtensionToolModule.configure(context);
  assert.equal(connected.success, true);
  assert.match(connected.userMessage, /connected/i);
  configureMode = 'waiting';
  const waiting = await chromeExtensionToolModule.configure(context);
  assert.equal(waiting.success, true);
  assert.match(waiting.userMessage, /prepared|load|esperando/i);
  configureMode = 'error';
  assert.equal((await chromeExtensionToolModule.configure(context)).technicalCode, 'manifest_denied');
  configureMode = 'value';
  assert.equal((await chromeExtensionToolModule.configure(context)).technicalCode, 'chrome_extension_configure_failed');
  configureMode = 'connected';

  assert.equal((await invoke('connection.status')).data.connected, true);

  assert.equal((await invoke('open_dedicated_tab', { url: 'chrome://extensions' })).technicalCode, 'chrome_extension_open_input_invalid');
  assert.equal((await invoke('open_dedicated_tab', { url: ' https://example.com ' })).success, true);

  assert.equal((await invoke('get_current_url', null)).technicalCode, 'chrome_extension_session_input_invalid');
  assert.equal((await invoke('get_current_url', { sessionId: ' session-1 ' })).success, true);

  assert.equal((await invoke('navigate', { sessionId: 'session-1', url: 'file:///tmp/unsafe' })).technicalCode, 'chrome_extension_navigate_input_invalid');
  commandMode = 'failure-full';
  assert.deepEqual(await invoke('navigate', { sessionId: 'session-1', url: 'https://example.com/next' }), {
    success: false,
    userMessage: 'Rejected by extension.',
    technicalCode: 'extension_rejected',
  });
  commandMode = 'success';

  assert.equal((await invoke('get_html', {})).technicalCode, 'chrome_extension_html_input_invalid');
  commandMode = 'failure-empty';
  const htmlFailure = await invoke('get_html', { sessionId: 'session-1' });
  assert.equal(htmlFailure.success, false);
  assert.equal(htmlFailure.technicalCode, 'chrome_extension_html_failed');
  assert.equal(typeof htmlFailure.userMessage, 'string');
  commandMode = 'success';

  assert.equal((await invoke('wait_for_selector', {
    sessionId: 'session-1', selector: '#ready', state: 'eventually',
  })).technicalCode, 'chrome_extension_wait_for_selector_input_invalid');
  assert.equal((await invoke('wait_for_selector', {
    sessionId: 'session-1', selector: '#ready', state: 'hidden', timeoutMs: 1_200,
  })).success, true);
  assert.deepEqual(calls.find(([action]) => action === 'wait_for_selector')[2], { timeoutMs: 6_200 });

  for (const action of ['click', 'focus', 'hover']) {
    assert.equal((await invoke(action, { sessionId: 'session-1', selector: '#button' })).success, true);
  }
  assert.equal((await invoke('click', { sessionId: 'session-1' })).technicalCode, 'chrome_extension_selector_input_invalid');

  assert.equal((await invoke('input_text', { sessionId: 'session-1' })).technicalCode, 'chrome_extension_input_text_invalid');
  assert.equal((await invoke('input_text', { sessionId: 'session-1', selector: '#name', text: 'Ada' })).success, true);

  assert.equal((await invoke('submit_form', null)).technicalCode, 'chrome_extension_submit_form_invalid');
  assert.equal((await invoke('submit_form', {
    sessionId: 'session-1', selector: 'form', submitSelector: '#submit',
  })).success, true);

  assert.equal((await invoke('get_styles', null)).technicalCode, 'chrome_extension_get_styles_invalid');
  assert.equal((await invoke('get_styles', {
    sessionId: 'session-1', selector: '#box', properties: [' color ', 'display'],
  })).success, true);

  assert.equal((await invoke('set_styles', {
    sessionId: 'session-1', selector: '#box', styles: {},
  })).technicalCode, 'chrome_extension_set_styles_invalid');
  assert.equal((await invoke('set_styles', {
    sessionId: 'session-1', selector: '#box', styles: { color: 'red' },
  })).success, true);

  assert.equal((await invoke('close_window', {})).technicalCode, 'chrome_extension_close_window_input_invalid');
  assert.equal((await invoke('close_window', { sessionId: 'session-1' })).success, true);
  assert.equal((await invoke('close_session', {})).technicalCode, 'chrome_extension_close_input_invalid');
  assert.equal((await invoke('close_session', { sessionId: 'session-1' })).success, true);
  assert.equal((await invoke('unknown', {})).technicalCode, 'chrome_extension_action_unknown');

  commandMode = 'error';
  assert.equal((await invoke('get_current_url', { sessionId: 'session-1' })).technicalCode, 'bridge_failed');
  commandMode = 'value';
  assert.equal((await invoke('get_current_url', { sessionId: 'session-1' })).technicalCode, 'chrome_extension_action_failed');
  commandMode = 'success';

  assert.equal(await chromeExtensionToolModule.isConfigured(context), true);
  await chromeExtensionToolModule.start(context);
  await chromeExtensionToolModule.stop();
  await chromeExtensionToolModule.deactivate();
  await __resetChromeExtensionToolForTests();
  await chromeExtensionToolModule.configure(context);
  await __resetChromeExtensionToolForTests();
  assert.ok(calls.filter(([name]) => name === 'stop').length >= 2);
});
