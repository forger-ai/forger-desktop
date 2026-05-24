import assert from 'node:assert/strict';
import test, { after } from 'node:test';

import {
  clearDistModule,
  createPreloadDocumentMock,
  createPreloadElectronMock,
  createPreloadWindowMock,
  requireExposedApi,
  withMockedElectron,
} from './electron-test-helpers.mjs';

let restoreBrowserGlobals = () => undefined;

after(() => {
  restoreBrowserGlobals();
});

const installBrowserGlobals = (globals) => {
  restoreBrowserGlobals();
  const previous = new Map();
  for (const [name, value] of Object.entries(globals)) {
    previous.set(name, Object.prototype.hasOwnProperty.call(globalThis, name) ? globalThis[name] : undefined);
    globalThis[name] = value;
  }
  restoreBrowserGlobals = () => {
    for (const [name, value] of previous.entries()) {
      if (value === undefined) {
        delete globalThis[name];
      } else {
        globalThis[name] = value;
      }
    }
    restoreBrowserGlobals = () => undefined;
  };
};

const assertFunctionLeaves = (value, path = 'forgerApp') => {
  for (const [key, entry] of Object.entries(value)) {
    const nextPath = `${path}.${key}`;
    if (typeof entry === 'function') {
      continue;
    }
    assert.equal(typeof entry, 'object', `${nextPath} should be a nested API object or function`);
    assert.notEqual(entry, null, `${nextPath} should not be null`);
    assertFunctionLeaves(entry, nextPath);
  }
};

const loadAppPreloadApi = async ({ href, invokeImpl } = {}) => {
  const harness = createPreloadElectronMock({ invokeImpl });
  const { window, listeners: windowListeners } = createPreloadWindowMock({ href });
  const { document } = createPreloadDocumentMock();

  installBrowserGlobals({ window, document });
  await withMockedElectron(harness.electronMock, (require) => {
    clearDistModule('preload/app.js');
    require('../../dist-electron/preload/app.js');
  });

  return {
    api: requireExposedApi(harness.exposed, 'forgerApp'),
    document,
    windowListeners,
    ...harness,
  };
};

test('app preload exposes only the forgerApp bridge with nested function leaves', async () => {
  const { api, exposed, listeners, windowListeners } = await loadAppPreloadApi();

  assert.equal(exposed.size, 1);
  assert.equal(Object.prototype.hasOwnProperty.call(api, 'ipcRenderer'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(api, 'contextBridge'), false);

  for (const key of [
    'getContext',
    'getAiSubscriptionStatus',
    'selectExternalFolder',
    'startAgentTask',
    'createAgentConversation',
    'createCodexConversation',
  ]) {
    assert.equal(typeof api[key], 'function', `${key} should be exposed as a function`);
  }
  for (const key of ['tools', 'messages', 'agentRuns', 'agents']) {
    assert.equal(typeof api[key], 'object', `${key} should be exposed as a nested namespace`);
  }

  assertFunctionLeaves(api);
  assert.equal(typeof api.tools.call, 'function');
  assert.equal(typeof api.messages.onMessage, 'function');
  assert.equal(typeof api.agentRuns.onAgentThreadEvent, 'function');
  assert.equal(typeof api.agents.onEvent, 'function');
  assert.equal(listeners.has('forger:app:agent-task:updated'), true);
  assert.equal(listeners.has('forger:app:agent-conversation:event'), true);
  assert.equal(typeof windowListeners.get('error'), 'function');
  assert.equal(typeof windowListeners.get('unhandledrejection'), 'function');
});

test('app preload rejects representative forgerApp calls with removed bridge guidance', async () => {
  const { api, invokeCalls, sendCalls } = await loadAppPreloadApi({
    href: 'https://finance.local/accounts?forgerLocale=en-US',
    invokeImpl(channel, ...args) {
      if (channel === 'forger:app:get-context') {
        return Promise.resolve({ agents: [{ id: 'analyst' }] });
      }
      return Promise.resolve({ channel, args });
    },
  });

  await assert.rejects(api.getContext(), /forgerApp bridge has been removed/);
  await assert.rejects(api.getAiSubscriptionStatus(), /forgerApp bridge has been removed/);
  await assert.rejects(api.tools.getStatus('gmail'), /forgerApp bridge has been removed/);
  await assert.rejects(api.agentRuns.getAgentRun('thread-1', 'run-1'), /forgerApp bridge has been removed/);
  await assert.rejects(api.agents.start({ agentId: 'analyst', variables: { question: 'review' } }), /forgerApp bridge has been removed/);
  await assert.rejects(api.startAgentTask({ templateId: 'analyze' }), /forgerApp bridge has been removed/);
  await assert.rejects(api.createAgentConversation({ appId: 'finance-os' }), /forgerApp bridge has been removed/);
  assert.deepEqual(invokeCalls, []);
  assert.deepEqual(sendCalls, []);
});

test('app preload forwards every nested command or subscription leaf through the bridge', async () => {
  const { api, invokeCalls, listeners, removedListeners } = await loadAppPreloadApi({
    href: 'https://finance.local/?forgerLocale=en',
  });
  const invokeLeaves = [];
  const subscriptionLeaves = [];

  const visit = async (value, path = 'forgerApp') => {
    for (const [key, entry] of Object.entries(value)) {
      const nextPath = `${path}.${key}`;
      if (typeof entry === 'function') {
        if (key.startsWith('on')) {
          subscriptionLeaves.push(nextPath);
          const unsubscribe = entry(() => undefined);
          assert.equal(typeof unsubscribe, 'function', `${nextPath} should return an unsubscribe function`);
          unsubscribe();
        } else {
          invokeLeaves.push(nextPath);
          await assert.rejects(entry({ id: 'input' }, 'run-id', 'permission-id', 'allow'), /forgerApp bridge has been removed/);
        }
        continue;
      }
      await visit(entry, nextPath);
    }
  };

  await visit(api);

  assert.ok(invokeLeaves.length >= 35, 'expected broad app command coverage');
  assert.ok(subscriptionLeaves.length >= 7, 'expected broad app subscription coverage');
  assert.equal(invokeCalls.length, 0);
  assert.equal(removedListeners.length, 0);
  for (const channel of [
    'forger:app:messages:event',
    'forger:app:agent-thread:event',
  ]) {
    assert.equal(listeners.has(channel), false, `${channel} should be unsubscribed`);
  }
});

test('app preload event subscriptions are inert after forgerApp bridge removal', async () => {
  const { api, listeners, removedListeners } = await loadAppPreloadApi();
  const received = [];

  const unsubscribeMessage = api.messages.onMessage((payload) => received.push(['message', payload]));
  unsubscribeMessage();

  const unsubscribeAgentRun = api.agentRuns.onAgentThreadEvent((payload) => received.push(['agent-run', payload]));
  unsubscribeAgentRun();

  const unsubscribeAgent = api.agents.onEvent((payload) => received.push(['agent', payload]));
  unsubscribeAgent();

  const unsubscribeTask = api.onAgentTaskUpdated((payload) => received.push(['task', payload]));
  unsubscribeTask();

  const unsubscribeConversation = api.onAgentConversationEvent((payload) => received.push(['conversation', payload]));
  unsubscribeConversation();

  const unsubscribeCodexTask = api.onCodexTaskUpdated((payload) => received.push(['codex-task', payload]));
  unsubscribeCodexTask();

  const unsubscribeCodexConversation = api.onCodexConversationEvent((payload) =>
    received.push(['codex-conversation', payload]),
  );
  unsubscribeCodexConversation();

  assert.deepEqual(received, []);
  assert.deepEqual(removedListeners, []);
  assert.equal(listeners.has('forger:app:messages:event'), false);
  assert.equal(listeners.has('forger:app:agent-thread:event'), false);
});

test('app preload reports renderer failures with location context without throwing into the app', async () => {
  const { windowListeners, invokeCalls } = await loadAppPreloadApi({
    href: 'https://finance.local/reports?forgerLocale=es',
  });
  const error = new Error('render failed');

  windowListeners.get('error')({
    message: 'Render failed',
    filename: 'bundle.js',
    lineno: 10,
    colno: 20,
    error,
  });
  windowListeners.get('unhandledrejection')({ reason: 'plain rejection' });

  assert.equal(invokeCalls.length, 2);
  assert.deepEqual(invokeCalls[0], [
    'forger:app:renderer-error',
    {
      operation: 'app.window.error',
      message: 'Render failed',
      technicalCode: 'app_renderer_window_error',
      details: {
        origin: 'https://finance.local',
        pathname: '/reports',
        filename: 'bundle.js',
        lineno: 10,
        colno: 20,
      },
      sensitiveDetails: {
        stack: error.stack,
      },
    },
  ]);
  assert.deepEqual(invokeCalls[1], [
    'forger:app:renderer-error',
    {
      operation: 'app.window.unhandledrejection',
      message: 'plain rejection',
      technicalCode: 'app_renderer_unhandled_rejection',
      details: {
        origin: 'https://finance.local',
        pathname: '/reports',
      },
      sensitiveDetails: {
        stack: undefined,
        reason: 'plain rejection',
      },
    },
  ]);
});

test('app preload reports fallback renderer failures when browser context or rejection reason is unusual', async () => {
  const { windowListeners, invokeCalls } = await loadAppPreloadApi({
    href: 'https://finance.local/reports?forgerLocale=es',
  });
  const originalLocation = globalThis.window.location;
  Object.defineProperty(globalThis.window, 'location', {
    configurable: true,
    get() {
      throw new Error('location unavailable');
    },
  });

  windowListeners.get('error')({
    message: '',
    filename: undefined,
    lineno: undefined,
    colno: undefined,
    error: 'plain error',
  });
  windowListeners.get('unhandledrejection')({ reason: new Error('promise failed') });
  windowListeners.get('unhandledrejection')({ reason: null });

  Object.defineProperty(globalThis.window, 'location', {
    configurable: true,
    value: originalLocation,
  });

  assert.equal(invokeCalls.length, 3);
  assert.deepEqual(invokeCalls[0], [
    'forger:app:renderer-error',
    {
      operation: 'app.window.error',
      message: 'Unexpected app renderer error.',
      technicalCode: 'app_renderer_window_error',
      details: {
        filename: undefined,
        lineno: undefined,
        colno: undefined,
      },
      sensitiveDetails: {
        stack: undefined,
      },
    },
  ]);
  assert.equal(invokeCalls[1][0], 'forger:app:renderer-error');
  assert.equal(invokeCalls[1][1].message, 'promise failed');
  assert.equal(invokeCalls[1][1].sensitiveDetails.reason, undefined);
  assert.match(invokeCalls[1][1].sensitiveDetails.stack, /promise failed/);
  assert.equal(invokeCalls[2][0], 'forger:app:renderer-error');
  assert.equal(invokeCalls[2][1].message, 'Unhandled app renderer rejection.');
  assert.equal(invokeCalls[2][1].sensitiveDetails.reason, '');
});

test('app preload rejects context after bridge removal even when locale is present', async () => {
  const { api, invokeCalls } = await loadAppPreloadApi({
    href: 'https://finance.local/?forgerLocale=es-CL',
    invokeImpl(channel, ...args) {
      if (channel === 'forger:app:get-context') {
        return Promise.reject(new Error('main unavailable'));
      }
      return Promise.resolve({ channel, args });
    },
  });

  await assert.rejects(api.getContext(), /forgerApp bridge has been removed/);
  assert.deepEqual(invokeCalls, []);
});

test('app preload rejects context and conversations after bridge removal', async () => {
  const { api, invokeCalls } = await loadAppPreloadApi({
    href: 'https://finance.local/accounts',
    invokeImpl(channel, ...args) {
      if (channel === 'forger:app:get-context') {
        return Promise.resolve('not an object');
      }
      return Promise.resolve({ channel, args });
    },
  });

  await assert.rejects(api.getContext(), /forgerApp bridge has been removed/);
  await assert.rejects(api.createAgentConversation(), /forgerApp bridge has been removed/);
  await assert.rejects(
    api.sendAgentConversationMessage({ conversationId: 'conversation-1', message: 'hello' }),
    /forgerApp bridge has been removed/,
  );
  await assert.rejects(api.createCodexConversation(), /forgerApp bridge has been removed/);
  await assert.rejects(
    api.sendCodexConversationMessage({ conversationId: 'conversation-2', message: 'codex hello' }),
    /forgerApp bridge has been removed/,
  );
  assert.deepEqual(invokeCalls, []);
});

test('app preload permission overlay forwards approval decisions and removes itself', async () => {
  const { document, invokeCalls, listeners } = await loadAppPreloadApi();
  const taskListener = listeners.get('forger:app:agent-task:updated');

  taskListener(
    { sender: 'main' },
    {
      task: {
        runId: 'run-1',
        status: 'needs_permission',
        permissionRequest: {
          requestId: 'permission-1',
          permission: 'official_tool',
          reason: 'Needs to read selected messages.',
          risk: 'medium',
          resource: 'Gmail',
        },
      },
    },
  );

  const overlay = document.querySelector('[data-forger-permission-overlay="true"]');
  assert.ok(overlay);
  assert.equal(overlay.dataset.forgerPermissionKey, 'task:run-1:permission-1');

  const allowButton = overlay.children[0].children[4].children[1];
  allowButton.listeners.get('click')();
  await Promise.resolve();

  assert.deepEqual(invokeCalls, [
    ['forger:app:agent-task:approve-permission', 'run-1', 'permission-1', 'allow'],
  ]);
  assert.equal(document.querySelector('[data-forger-permission-overlay="true"]'), null);
});

test('app preload permission overlay handles conversation approvals, duplicate events, denial failures, and ignored payloads', async () => {
  const { document, invokeCalls, listeners } = await loadAppPreloadApi({
    href: 'https://finance.local/?forgerLocale=en-US',
    invokeImpl(channel, ...args) {
      if (channel === 'forger:app:agent-task:approve-permission') {
        return Promise.reject(new Error('permission unavailable'));
      }
      return Promise.resolve({ channel, args });
    },
  });
  const taskListener = listeners.get('forger:app:agent-task:updated');
  const conversationListener = listeners.get('forger:app:agent-conversation:event');

  taskListener({ sender: 'main' }, null);
  taskListener({ sender: 'main' }, { task: null });
  taskListener({ sender: 'main' }, {
    task: { runId: 'run-primitive', status: 'needs_permission', permissionRequest: null },
  });
  taskListener({ sender: 'main' }, { task: { runId: 'run-ignored', status: 'needs_permission', permissionRequest: {} } });
  taskListener({ sender: 'main' }, {
    task: {
      runId: 'run-bad-risk',
      status: 'needs_permission',
      permissionRequest: {
        requestId: 'permission-bad',
        permission: 'official_tool',
        reason: 'Needs something.',
        risk: 'critical',
        resource: 'Data',
      },
    },
  });
  assert.equal(document.querySelector('[data-forger-permission-overlay="true"]'), null);

  const request = {
    requestId: 'permission-2',
    permission: 'official_tool',
    reason: 'Needs to send a message.',
    risk: 'high',
    resource: 'Messages',
  };
  conversationListener(
    { sender: 'main' },
    {
      type: 'run.needs_permission',
      conversation: { conversationId: 'conversation-1' },
      run: { runId: 'run-2', status: 'needs_permission', permissionRequest: request },
    },
  );
  conversationListener(
    { sender: 'main' },
    {
      type: 'run.needs_permission',
      conversation: { conversationId: 'conversation-1' },
      run: { runId: 'run-2', status: 'needs_permission', permissionRequest: request },
    },
  );

  let overlay = document.querySelector('[data-forger-permission-overlay="true"]');
  assert.ok(overlay);
  assert.equal(document.documentElement.children.length, 1, 'duplicate permission event should not duplicate overlay');
  assert.equal(overlay.children[0].children[0].textContent, 'Forger needs authorization');
  assert.equal(overlay.children[0].children[3].textContent, 'High risk');

  const denyButton = overlay.children[0].children[4].children[0];
  denyButton.listeners.get('click')();
  await Promise.resolve();

  assert.deepEqual(invokeCalls, [
    ['forger:app:agent-conversation:approve-permission', 'conversation-1', 'run-2', 'permission-2', 'deny'],
  ]);
  assert.equal(document.querySelector('[data-forger-permission-overlay="true"]'), null);

  taskListener(
    { sender: 'main' },
    {
      task: {
        runId: 'run-3',
        status: 'needs_permission',
        permissionRequest: {
          requestId: 'permission-3',
          permission: 'official_tool',
          reason: 'Needs to inspect data.',
          risk: 'low',
          resource: 'Data',
        },
      },
    },
  );
  overlay = document.querySelector('[data-forger-permission-overlay="true"]');
  assert.ok(overlay);
  assert.equal(overlay.children[0].children[3].textContent, 'Low risk');

  const taskDenyButton = overlay.children[0].children[4].children[0];
  taskDenyButton.listeners.get('click')();
  await Promise.resolve();
  await Promise.resolve();

  assert.deepEqual(invokeCalls[1], [
    'forger:app:agent-task:approve-permission',
    'run-3',
    'permission-3',
    'deny',
  ]);
  assert.equal(document.querySelector('[data-forger-permission-overlay="true"]'), null);

  taskListener(
    { sender: 'main' },
    {
      task: {
        runId: 'run-4',
        status: 'needs_permission',
        permissionRequest: {
          requestId: 'permission-4',
          permission: 'official_tool',
          reason: 'Needs the first resource.',
          risk: 'medium',
          resource: 'First',
        },
      },
    },
  );
  taskListener(
    { sender: 'main' },
    {
      task: {
        runId: 'run-5',
        status: 'needs_permission',
        permissionRequest: {
          requestId: 'permission-5',
          permission: 'official_tool',
          reason: 'Needs the second resource.',
          risk: 'medium',
          resource: 'Second',
        },
      },
    },
  );
  overlay = document.querySelector('[data-forger-permission-overlay="true"]');
  assert.ok(overlay);
  assert.equal(document.documentElement.children.length, 1, 'new permission request should replace the previous overlay');
  assert.equal(overlay.dataset.forgerPermissionKey, 'task:run-5:permission-5');
  assert.match(overlay.children[0].children[1].textContent, /Second/);

  conversationListener({ sender: 'main' }, null);
  conversationListener({ sender: 'main' }, { type: 'run.needs_permission', conversation: {}, run: {} });
});
