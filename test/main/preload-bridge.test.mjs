import assert from 'node:assert/strict';
import test from 'node:test';

import {
  clearDistModule,
  createPreloadElectronMock,
  requireExposedApi,
  withMockedElectron,
} from './electron-test-helpers.mjs';

const loadPreloadApi = async () => {
  const harness = createPreloadElectronMock();

  await withMockedElectron(harness.electronMock, (require) => {
    clearDistModule('preload/index.js');
    require('../../dist-electron/preload/index.js');
  });

  return {
    api: requireExposedApi(harness.exposed, 'forger'),
    ...harness,
  };
};

test('preload exposes a function-only forger API without leaking raw Electron primitives', async () => {
  const { api, exposed } = await loadPreloadApi();

  assert.equal(exposed.size, 1);
  assert.ok(api);
  assert.equal(Object.prototype.hasOwnProperty.call(api, 'ipcRenderer'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(api, 'contextBridge'), false);

  const keys = Object.keys(api);
  assert.ok(keys.length > 100, 'expected the desktop API surface to stay broad');
  for (const key of [
    'listInstalledApps',
    'installApp',
    'getSettings',
    'chatStartRun',
    'chatCancelRun',
    'onChatRunUpdated',
    'minimizeWindow',
    'toggleMaximizeWindow',
    'closeWindow',
    'getWindowState',
    'onDeepLink',
    'updateCloudDeviceName',
    'getAgentProviderUsage',
    'listLlmProviderProfiles',
    'setActiveLlmProviderProfile',
    'updateLlmProviderProfileDefaults',
  ]) {
    assert.equal(typeof api[key], 'function', `${key} should be exposed as a function`);
  }

  for (const [key, value] of Object.entries(api)) {
    assert.equal(typeof value, 'function', `${key} should not expose mutable data`);
  }
});

test('preload forwards representative commands to the expected IPC channels with arguments', async () => {
  const { api, invokeCalls } = await loadPreloadApi();

  await api.listInstalledApps();
  await api.installApp('finance-os', 'es');
  await api.updateCodexDefaults({ provider: 'codex', model: 'gpt-5' });
  await api.chatCancelRun({ appId: 'forger', runId: 'run-1' });
  await api.filesStageForChat({ appId: 'finance-os', files: [{ path: '/tmp/input.pdf' }] });
  await api.memoryList();
  await api.getLlmRunsSnapshot();
  await api.getAgentProviderUsage();
  await api.listLlmProviderProfiles();
  await api.setActiveLlmProviderProfile({ provider: 'codex', profileId: 'codex:system' });
  await api.updateLlmProviderProfileDefaults({ provider: 'codex', profileId: 'codex:system', model: 'gpt-5' });
  await api.openExternalUrl('https://forger.ai/help');
  await api.dbQueryTable('finance-os', 'transactions', 25);
  await api.automationsGetRunTranscript('run-99');
  await api.backgroundTaskGet('task-99');
  await api.updateSocialAppVisibility(42, 'friends');
  await api.toggleMaximizeWindow();

  assert.deepEqual(invokeCalls, [
    ['forger:list-installed-apps'],
    ['forger:install-app', 'finance-os', 'es'],
    ['forger:update-codex-defaults', { provider: 'codex', model: 'gpt-5' }],
    ['forger:chat:cancel-run', { appId: 'forger', runId: 'run-1' }],
    ['forger:files:stage-for-chat', { appId: 'finance-os', files: [{ path: '/tmp/input.pdf' }] }],
    ['forger:memory:list', {}],
    ['forger:llm-runs:snapshot:get'],
    ['forger:agent-provider-usage:get'],
    ['forger:llm-provider-profiles:list'],
    ['forger:llm-provider-profiles:set-active', { provider: 'codex', profileId: 'codex:system' }],
    ['forger:llm-provider-profiles:update-defaults', { provider: 'codex', profileId: 'codex:system', model: 'gpt-5' }],
    ['forger:open-external-url', 'https://forger.ai/help'],
    ['forger:db:query-table', 'finance-os', 'transactions', 25],
    ['forger:automations:get-run-transcript', 'run-99'],
    ['forger:background-tasks:get', 'task-99'],
    ['forger:social:apps:update-visibility', 42, 'friends'],
    ['forger:window:toggle-maximize'],
  ]);
});

test('preload exposes audio runtime broker request and response channels', async () => {
  const { api, invokeCalls, listeners, removedListeners } = await loadPreloadApi();
  const received = [];

  const unsubscribe = api.onAudioRuntimeBrokerRequest((payload) => received.push(payload));
  const listener = listeners.get('forger:audio-runtime-broker:request');
  assert.equal(typeof listener, 'function');
  listener({ sender: 'main' }, { requestId: 'request-1', type: 'list_devices' });
  assert.deepEqual(received, [{ requestId: 'request-1', type: 'list_devices' }]);
  unsubscribe();
  assert.equal(removedListeners.at(-1)?.[0], 'forger:audio-runtime-broker:request');

  await api.audioRuntimeBrokerRespond({ requestId: 'request-1', success: true, result: { ok: true } });
  assert.deepEqual(invokeCalls.at(-1), ['forger:audio-runtime-broker:response', { requestId: 'request-1', success: true, result: { ok: true } }]);
});

test('preload forwards every exposed command or event subscription through the bridge', async () => {
  const { api, invokeCalls, listeners, removedListeners } = await loadPreloadApi();
  const listener = () => undefined;
  const invokeMethods = [];
  const subscriptionMethods = [];

  for (const [name, value] of Object.entries(api)) {
    if (name.startsWith('on')) {
      subscriptionMethods.push(name);
      const unsubscribe = value(listener);
      assert.equal(typeof unsubscribe, 'function', `${name} should return an unsubscribe function`);
      const registered = Array.from(listeners.values()).at(-1);
      assert.equal(typeof registered, 'function', `${name} should register a listener`);
      registered({ sender: 'main' }, { event: name });
      unsubscribe();
    } else {
      invokeMethods.push(name);
      await value('app-id', { id: 'input' }, 'locale');
    }
  }

  assert.ok(invokeMethods.length > 100, 'expected broad command coverage');
  assert.ok(subscriptionMethods.length >= 8, 'expected event subscription coverage');
  assert.equal(invokeCalls.length, invokeMethods.length);
  assert.equal(removedListeners.length, subscriptionMethods.length);
  assert.equal(listeners.size, 0);
});

test('preload event subscriptions unwrap payloads and unsubscribe the exact registered listener', async () => {
  const { api, listeners, removedListeners } = await loadPreloadApi();
  const received = [];

  const unsubscribeChat = api.onChatRunUpdated((payload) => received.push(['chat', payload]));
  const unsubscribeLlmRuns = api.onLlmRunsSnapshotChanged((payload) => received.push(['llm-runs', payload]));
  const unsubscribePersonalAgent = api.onPersonalAgentConversationEvent((payload) => received.push(['personal-agent', payload]));
  const unsubscribeWindow = api.onWindowStateChanged((payload) => received.push(['window', payload]));
  const unsubscribeDeepLink = api.onDeepLink((payload) => received.push(['deep-link', payload]));
  const unsubscribeAutomation = api.onAutomationUpdated((payload) => received.push(['automation', payload]));
  const unsubscribeBackgroundTask = api.onBackgroundTaskUpdated((payload) => received.push(['background-task', payload]));
  const unsubscribeErrorReport = api.onDesktopErrorReportRequested((payload) => received.push(['error-report', payload]));

  const chatListener = listeners.get('forger:chat:run-updated');
  const llmRunsListener = listeners.get('forger:llm-runs:snapshot:changed');
  const personalAgentListener = listeners.get('forger:personal-agents:conversation:event');
  const windowListener = listeners.get('forger:window:state-changed');
  const deepLinkListener = listeners.get('forger:deep-link');
  const automationListener = listeners.get('forger:automations:updated');
  const backgroundTaskListener = listeners.get('forger:background-tasks:updated');
  const errorReportListener = listeners.get('forger:error-report:requested');

  chatListener({ sender: 'main' }, { run: { runId: 'run-1' } });
  llmRunsListener({ sender: 'main' }, { items: [{ id: 'llm-1' }], activeCount: 1 });
  personalAgentListener({ sender: 'main' }, { type: 'run.progress', run: { id: 'run-2' } });
  windowListener({ sender: 'main' }, { isMaximized: true, isFullScreen: false, usesCustomFrame: true });
  deepLinkListener({ sender: 'main' }, { kind: 'chat', app: 'finance-os', prompt: 'hola' });
  automationListener({ sender: 'main' }, { automation: { id: 'automation-1' } });
  backgroundTaskListener({ sender: 'main' }, { task: { id: 'task-1', status: 'running' } });
  errorReportListener({ sender: 'main' }, { technicalCode: 'boom', userMessage: 'Something happened' });

  unsubscribeChat();
  unsubscribeLlmRuns();
  unsubscribePersonalAgent();
  unsubscribeWindow();
  unsubscribeDeepLink();
  unsubscribeAutomation();
  unsubscribeBackgroundTask();
  unsubscribeErrorReport();

  assert.deepEqual(received, [
    ['chat', { run: { runId: 'run-1' } }],
    ['llm-runs', { items: [{ id: 'llm-1' }], activeCount: 1 }],
    ['personal-agent', { type: 'run.progress', run: { id: 'run-2' } }],
    ['window', { isMaximized: true, isFullScreen: false, usesCustomFrame: true }],
    ['deep-link', { kind: 'chat', app: 'finance-os', prompt: 'hola' }],
    ['automation', { automation: { id: 'automation-1' } }],
    ['background-task', { task: { id: 'task-1', status: 'running' } }],
    ['error-report', { technicalCode: 'boom', userMessage: 'Something happened' }],
  ]);
  assert.deepEqual(removedListeners, [
    ['forger:chat:run-updated', chatListener],
    ['forger:llm-runs:snapshot:changed', llmRunsListener],
    ['forger:personal-agents:conversation:event', personalAgentListener],
    ['forger:window:state-changed', windowListener],
    ['forger:deep-link', deepLinkListener],
    ['forger:automations:updated', automationListener],
    ['forger:background-tasks:updated', backgroundTaskListener],
    ['forger:error-report:requested', errorReportListener],
  ]);
  assert.equal(listeners.has('forger:chat:run-updated'), false);
  assert.equal(listeners.has('forger:llm-runs:snapshot:changed'), false);
  assert.equal(listeners.has('forger:personal-agents:conversation:event'), false);
  assert.equal(listeners.has('forger:window:state-changed'), false);
  assert.equal(listeners.has('forger:deep-link'), false);
  assert.equal(listeners.has('forger:automations:updated'), false);
  assert.equal(listeners.has('forger:background-tasks:updated'), false);
  assert.equal(listeners.has('forger:error-report:requested'), false);
});

test('preload helper fails clearly when the expected bridge API is missing', () => {
  assert.throws(
    () => requireExposedApi(new Map([['otherApi', {}]]), 'forger'),
    /missing_exposed_api:forger/,
  );
});
