import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { createRequire } from 'node:module';
import test from 'node:test';
import { WebSocket } from 'ws';

const require = createRequire(import.meta.url);
const { DesktopRuntimeBridge } = require('../../dist-electron/main/desktop-runtime-bridge.js');

const APP_ID = 'finance-os';
const SECRET = 'test-secret';

const sign = ({ method, path, body = '' }) => {
  const bodySha = createHash('sha256').update(body).digest('hex');
  const timestamp = new Date().toISOString();
  return {
    'content-type': 'application/json',
    'x-forger-app-id': APP_ID,
    'x-forger-timestamp': timestamp,
    'x-forger-body-sha256': bodySha,
    'x-forger-signature': createHmac('sha256', SECRET)
      .update([method, path, timestamp, bodySha].join('\n'))
      .digest('hex'),
  };
};

const request = async (bridge, path, { method = 'GET', body } = {}) => {
  const rawBody = body === undefined ? '' : JSON.stringify(body);
  const response = await fetch(`${bridge.url}${path}`, {
    method,
    headers: sign({ method, path, body: rawBody }),
    body: method === 'GET' ? undefined : rawBody,
  });
  const payload = await response.json().catch(() => null);
  return { response, payload };
};

const socketStates = new WeakMap();

const attachSocketState = (socket) => {
  const state = { queue: [], waiters: [] };
  socketStates.set(socket, state);
  socket.on('message', (data) => {
    const message = JSON.parse(Buffer.from(data).toString('utf8'));
    const waiter = state.waiters.shift();
    if (waiter) {
      waiter.resolve(message);
      return;
    }
    state.queue.push(message);
  });
  socket.on('error', (error) => {
    for (const waiter of state.waiters.splice(0)) {
      waiter.reject(error);
    }
  });
};

const nextSocketMessage = (socket) => new Promise((resolve, reject) => {
  const state = socketStates.get(socket);
  if (!state) {
    reject(new Error('websocket_state_missing'));
    return;
  }
  const queued = state.queue.shift();
  if (queued) {
    resolve(queued);
    return;
  }
  const timeout = setTimeout(() => {
    const index = state.waiters.findIndex((waiter) => waiter.resolve === resolve);
    if (index >= 0) {
      state.waiters.splice(index, 1);
    }
    reject(new Error('websocket_message_timeout'));
  }, 2000);
  state.waiters.push({
    resolve: (message) => {
      clearTimeout(timeout);
      resolve(message);
    },
    reject: (error) => {
      clearTimeout(timeout);
      reject(error);
    },
  });
});

const connectRuntimeEvents = async (bridge) => {
  const eventsPath = `/v1/apps/${APP_ID}/runtime-events`;
  const socket = new WebSocket(`${bridge.url.replace('http:', 'ws:')}${eventsPath}`, {
    headers: sign({ method: 'GET', path: eventsPath, body: '' }),
  });
  attachSocketState(socket);
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
    socket.once('unexpected-response', (_request, response) => {
      reject(new Error(`websocket_unexpected_response_${response.statusCode}`));
    });
  });
  return socket;
};

const createBridge = async (options = {}) => {
  const bridge = new DesktopRuntimeBridge({
    getInstalledApp: (appId) => (appId === APP_ID ? { id: appId, installDir: '/tmp/finance-os' } : null),
    getConversationManager: () => null,
    renderManifestAgentPrompt: () => '',
    resolveInstalledAgents: async () => [],
    connections: options.connections,
    appendInstallLog: async () => undefined,
    serializeErrorForInstallLog: (error) => ({ message: error instanceof Error ? error.message : String(error) }),
  });
  await bridge.start();
  bridge.secrets.set(APP_ID, SECRET);
  return {
    bridge,
    stop: async () => await bridge.stop(),
  };
};

test('desktop runtime connection endpoints list, status, and delegate app-granted actions', async () => {
  const calls = [];
  const connectionState = {
    types: [
      {
        type: 'gmail',
        displayName: 'Gmail',
        description: 'Gmail accounts',
        setupKind: 'oauth',
        supportsMultiple: true,
        actions: [
          { id: 'gmail.connection.status', name: 'Status', description: 'Status', risk: 'low' },
          { id: 'gmail.search_messages', name: 'Search', description: 'Search messages', risk: 'medium' },
        ],
        secretsSchema: [],
        statusActionId: 'gmail.connection.status',
      },
    ],
    instances: [
      {
        id: 'conn-1',
        type: 'gmail',
        label: 'Work',
        status: 'connected',
        isDefault: true,
        createdAt: '2026-07-05T00:00:00.000Z',
        updatedAt: '2026-07-05T00:00:00.000Z',
      },
    ],
    requirements: [],
  };
  const harness = await createBridge({
    connections: {
      listConnectionsForApp: async (appId) => {
        calls.push(['listConnectionsForApp', appId]);
        return connectionState;
      },
      callFromApp: async (appId, input) => {
        calls.push(['callFromApp', appId, input]);
        return { success: true, data: { appId, input } };
      },
    },
  });
  try {
    const listed = await request(harness.bridge, `/v1/apps/${APP_ID}/connections`);
    assert.equal(listed.response.status, 200);
    assert.deepEqual(listed.payload, connectionState);

    const status = await request(harness.bridge, `/v1/apps/${APP_ID}/connections/gmail/status`);
    assert.equal(status.response.status, 200);
    assert.deepEqual(status.payload.data.input, {
      type: 'gmail',
      actionId: 'gmail.connection.status',
      input: {},
    });

    const called = await request(
      harness.bridge,
      `/v1/apps/${APP_ID}/connections/gmail/actions/gmail.search_messages`,
      {
        method: 'POST',
        body: {
          connectionId: 'conn-1',
          input: { query: 'from:client@example.com' },
        },
      },
    );
    assert.equal(called.response.status, 200);
    assert.equal(called.payload.success, true);
    assert.deepEqual(called.payload.data.input, {
      type: 'gmail',
      actionId: 'gmail.search_messages',
      input: { query: 'from:client@example.com' },
      connectionId: 'conn-1',
    });
    assert.deepEqual(calls.map(([name]) => name), ['listConnectionsForApp', 'callFromApp', 'callFromApp']);
  } finally {
    await harness.stop();
  }
});

test('desktop runtime connection setup emits runtime events and grant requests stay manifest-managed', async () => {
  const calls = [];
  const harness = await createBridge({
    connections: {
      listConnectionsForApp: async () => ({ types: [], instances: [], requirements: [] }),
      callFromApp: async () => ({ success: true }),
      configureFromApp: async (appId, input) => {
        calls.push(['configureFromApp', appId, input]);
        return {
          success: true,
          userMessage: 'configured',
          instance: {
            id: 'conn-setup',
            type: input.type,
            label: input.label ?? 'Gmail',
            status: 'connected',
            isDefault: true,
            createdAt: '2026-07-05T00:00:00.000Z',
            updatedAt: '2026-07-05T00:00:00.000Z',
          },
        };
      },
    },
  });
  const eventSocket = await connectRuntimeEvents(harness.bridge);
  try {
    await nextSocketMessage(eventSocket);
    const setup = await request(
      harness.bridge,
      `/v1/apps/${APP_ID}/connections/gmail/setup`,
      {
        method: 'POST',
        body: {
          label: 'Personal Gmail',
          connectionId: 'conn-existing',
          secrets: { refreshToken: 'must-not-pass-through' },
        },
      },
    );
    assert.equal(setup.response.status, 200);
    assert.equal(setup.payload.success, true);
    const setupEvent = await nextSocketMessage(eventSocket);
    assert.equal(setupEvent.type, 'desktop.connections.changed');
    assert.deepEqual(setupEvent.payload, {
      reason: 'setup',
      type: 'gmail',
      connectionId: 'conn-setup',
    });

    const grant = await request(
      harness.bridge,
      `/v1/apps/${APP_ID}/connections/gmail/grants/request`,
      {
        method: 'POST',
        body: {
          reason: 'Use Gmail from the app',
          connectionIds: ['conn-setup'],
        },
      },
    );
    assert.equal(grant.response.status, 200);
    assert.equal(grant.payload.success, false);
    assert.equal(grant.payload.technicalCode, 'connection_grant_manifest_managed');

    assert.deepEqual(calls, [
      ['configureFromApp', APP_ID, { type: 'gmail', label: 'Personal Gmail', connectionId: 'conn-existing' }],
    ]);
  } finally {
    eventSocket.close();
    await harness.stop();
  }
});

test('desktop runtime connection endpoints require the connections service', async () => {
  const harness = await createBridge();
  try {
    const result = await request(harness.bridge, `/v1/apps/${APP_ID}/connections`);
    assert.equal(result.response.status, 503);
    assert.equal(result.payload.error, 'desktop_runtime_connections_unavailable');
  } finally {
    await harness.stop();
  }
});
