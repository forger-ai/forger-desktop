import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { WebSocket } from 'ws';

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { DesktopRuntimeBridge } = require('../../dist-electron/main/desktop-runtime-bridge.js');

const APP_ID = 'finance-os';
const SECRET = 'test-secret';

const sign = ({ method, path, body = '', secret = SECRET, appId = APP_ID, bodySha, timestamp = new Date().toISOString() }) => {
  const sha = bodySha ?? createHash('sha256').update(body).digest('hex');
  const signature = createHmac('sha256', secret)
    .update([method, path, timestamp, sha].join('\n'))
    .digest('hex');
  return {
    'content-type': 'application/json',
    'x-forger-app-id': appId,
    'x-forger-timestamp': timestamp,
    'x-forger-body-sha256': sha,
    'x-forger-signature': signature,
  };
};

const request = async (bridge, path, { method = 'GET', body, rawBody: explicitRawBody, headers } = {}) => {
  const rawBody = explicitRawBody ?? (body === undefined ? '' : JSON.stringify(body));
  const response = await fetch(`${bridge.url}${path}`, {
    method,
    headers: headers ?? sign({ method, path, body: rawBody }),
    body: method === 'GET' ? undefined : rawBody,
  });
  const payload = await response.json().catch(() => null);
  return { response, payload };
};

const createBridge = async (options = {}) => {
  const tasks = new Map();
  const taskManager = {
    async start(appId, input) {
      const task = {
        runId: 'run-1',
        appId,
        templateId: input.templateId,
        status: 'queued',
        createdAt: '2026-05-17T00:00:00.000Z',
        updatedAt: '2026-05-17T00:00:00.000Z',
        progressLog: [],
      };
      tasks.set(task.runId, task);
      return task;
    },
    get(appId, runId) {
      const task = tasks.get(runId);
      return task?.appId === appId ? task : null;
    },
    cancel(appId, runId) {
      const task = tasks.get(runId);
      return { success: Boolean(task && task.appId === appId) };
    },
  };
  const bridge = new DesktopRuntimeBridge({
    getInstalledApp: options.getInstalledApp ?? ((appId) => (appId === APP_ID ? { id: appId, installDir: '/tmp/finance-os' } : null)),
    getConversationManager: options.getConversationManager ?? (() => null),
    getTaskManager: options.getTaskManager ?? (() => taskManager),
    getTaskStatus: options.getTaskStatus ?? (async () => ({ connected: true, codex: true, claude: false })),
    resolveInstalledAgents: options.resolveInstalledAgents ?? (async () => [{ id: 'analyst', title: 'Analyst', prompts: {} }]),
    renderManifestAgentPrompt: options.renderManifestAgentPrompt ?? (({ kind, variables }) => `${kind}:${variables?.topic ?? 'default'}`),
    appendInstallLog: async (event, payload) => options.logs?.push([event, payload]),
    serializeErrorForInstallLog: (error) => ({ message: error instanceof Error ? error.message : String(error) }),
    maxBodyBytes: options.maxBodyBytes ?? 1024,
  });
  await bridge.start();
  if (options.seedSecret !== false) {
    bridge.secrets.set(APP_ID, SECRET);
  }
  return {
    bridge,
    taskManager,
    tasks,
    stop: async () => {
      await bridge.stop();
    },
  };
};

const websocketMessage = (client) => new Promise((resolve, reject) => {
  client.once('message', (raw) => {
    try {
      resolve(JSON.parse(raw.toString()));
    } catch (error) {
      reject(error);
    }
  });
  client.once('error', reject);
});

const conversation = {
  conversationId: 'thread-1',
  appId: APP_ID,
  title: 'Budget review',
  messages: [
    {
      messageId: 'msg-1',
      role: 'user',
      text: 'Review May',
      createdAt: '2026-05-17T00:00:00.000Z',
    },
  ],
  activeRun: {
    runId: 'run-9',
    status: 'running',
    progressLog: ['starting'],
  },
};

test('desktop runtime bridge starts once, exposes per-app environment, and clears it on stop', async () => {
  const logs = [];
  const harness = await createBridge({ logs, seedSecret: false });
  try {
    const env = harness.bridge.environmentForApp(APP_ID);
    assert.equal(env.FORGER_DESKTOP_RUNTIME_URL, harness.bridge.url);
    assert.equal(env.FORGER_DESKTOP_RUNTIME_APP_ID, APP_ID);
    assert.equal(env.FORGER_DESKTOP_RUNTIME_SECRET, harness.bridge.secrets.get(APP_ID));
    const firstUrl = harness.bridge.url;
    await harness.bridge.start();
    assert.equal(harness.bridge.url, firstUrl);
    assert.equal(logs.filter(([event]) => event === 'desktop_runtime_bridge:started').length, 1);
  } finally {
    await harness.stop();
  }

  assert.deepEqual(harness.bridge.environmentForApp(APP_ID), {});
  await harness.bridge.stop();
});

test('desktop runtime bridge rejects a listener without an assigned port', async (t) => {
  const http = require('node:http');
  const originalCreateServer = http.createServer;
  const fakeServer = new EventEmitter();
  fakeServer.listen = (_port, _host, callback) => callback();
  fakeServer.once = fakeServer.once.bind(fakeServer);
  fakeServer.on = fakeServer.on.bind(fakeServer);
  fakeServer.close = (callback) => callback?.();
  fakeServer.address = () => null;
  http.createServer = () => fakeServer;
  t.after(() => {
    http.createServer = originalCreateServer;
  });

  const bridge = new DesktopRuntimeBridge({
    getInstalledApp: () => null,
    getConversationManager: () => null,
    getTaskManager: () => null,
    appendInstallLog: async () => undefined,
    serializeErrorForInstallLog: (error) => ({ message: String(error) }),
  });

  await assert.rejects(bridge.start(), /desktop_runtime_bridge_address_unavailable/);
});

test('desktop runtime task endpoints require signatures', async () => {
  const harness = await createBridge();
  try {
    const { response, payload } = await request(
      harness.bridge,
      `/v1/apps/${APP_ID}/agent-tasks/status`,
      { headers: {} },
    );
    assert.equal(response.status, 401);
    assert.equal(payload.error, 'desktop_runtime_signature_required');
  } finally {
    await harness.stop();
  }
});

test('desktop runtime task status reports unavailable without a task manager', async () => {
  const harness = await createBridge({
    getTaskManager: () => null,
    getTaskStatus: async (appId) => ({ appId, connected: false }),
  });
  try {
    const { response, payload } = await request(harness.bridge, `/v1/apps/${APP_ID}/agent-tasks/status`);
    assert.equal(response.status, 200);
    assert.deepEqual(payload, { available: false, appId: APP_ID, connected: false });
  } finally {
    await harness.stop();
  }
});

test('desktop runtime task endpoints reject invalid body hashes', async () => {
  const harness = await createBridge();
  try {
    const path = `/v1/apps/${APP_ID}/agent-tasks`;
    const body = JSON.stringify({ templateId: 'recommend_budget' });
    const { response, payload } = await request(harness.bridge, path, {
      method: 'POST',
      body: { templateId: 'recommend_budget' },
      headers: sign({ method: 'POST', path, body, bodySha: 'bad-hash' }),
    });
    assert.equal(response.status, 401);
    assert.equal(payload.error, 'desktop_runtime_body_hash_invalid');
  } finally {
    await harness.stop();
  }
});

test('desktop runtime task endpoints reject stale timestamps, unknown secrets, and bad signatures', async () => {
  const stale = await createBridge();
  try {
    const path = `/v1/apps/${APP_ID}/agent-tasks/status`;
    const { response, payload } = await request(stale.bridge, path, {
      headers: sign({ method: 'GET', path, timestamp: '2020-01-01T00:00:00.000Z' }),
    });
    assert.equal(response.status, 401);
    assert.equal(payload.error, 'desktop_runtime_timestamp_invalid');
  } finally {
    await stale.stop();
  }

  const missingSecret = await createBridge({ seedSecret: false });
  try {
    const path = `/v1/apps/${APP_ID}/agent-tasks/status`;
    const { response, payload } = await request(missingSecret.bridge, path);
    assert.equal(response.status, 401);
    assert.equal(payload.error, 'desktop_runtime_secret_unknown');
  } finally {
    await missingSecret.stop();
  }

  const badSignature = await createBridge();
  try {
    const path = `/v1/apps/${APP_ID}/agent-tasks/status`;
    const { response, payload } = await request(badSignature.bridge, path, {
      headers: sign({ method: 'GET', path, secret: 'wrong-secret' }),
    });
    assert.equal(response.status, 401);
    assert.equal(payload.error, 'desktop_runtime_signature_invalid');
  } finally {
    await badSignature.stop();
  }
});

test('desktop runtime task endpoints reject invalid JSON bodies', async () => {
  const harness = await createBridge();
  try {
    const path = `/v1/apps/${APP_ID}/agent-tasks`;
    const { response, payload } = await request(harness.bridge, path, {
      method: 'POST',
      rawBody: '{"templateId":',
    });
    assert.equal(response.status, 400);
    assert.equal(payload.error, 'desktop_runtime_body_invalid');
  } finally {
    await harness.stop();
  }
});

test('desktop runtime task endpoints reject non-object JSON bodies', async () => {
  const harness = await createBridge();
  try {
    const path = `/v1/apps/${APP_ID}/agent-tasks`;
    const { response, payload } = await request(harness.bridge, path, {
      method: 'POST',
      rawBody: '[]',
    });
    assert.equal(response.status, 400);
    assert.equal(payload.error, 'desktop_runtime_body_invalid');
  } finally {
    await harness.stop();
  }
});

test('desktop runtime task endpoints reject wrong apps', async () => {
  const harness = await createBridge();
  try {
    const path = '/v1/apps/missing-app/agent-tasks/status';
    const { response, payload } = await request(harness.bridge, path, {
      headers: sign({ method: 'GET', path, appId: 'missing-app' }),
    });
    assert.equal(response.status, 403);
    assert.equal(payload.error, 'desktop_runtime_app_forbidden');
  } finally {
    await harness.stop();
  }
});

test('desktop runtime task routes reject path/header mismatches, unavailable managers, and unsupported methods', async () => {
  const mismatch = await createBridge({
    getInstalledApp: (appId) => ({ id: appId }),
  });
  try {
    mismatch.bridge.secrets.set('other-app', SECRET);
    const path = '/v1/apps/other-app/agent-tasks/status';
    const { response, payload } = await request(mismatch.bridge, path, {
      headers: sign({ method: 'GET', path, appId: APP_ID }),
    });
    assert.equal(response.status, 403);
    assert.equal(payload.error, 'desktop_runtime_app_forbidden');

    const taskPath = '/v1/apps/other-app/agent-tasks/run-1';
    const task = await request(mismatch.bridge, taskPath, {
      headers: sign({ method: 'GET', path: taskPath, appId: APP_ID }),
    });
    assert.equal(task.response.status, 403);
    assert.equal(task.payload.error, 'desktop_runtime_app_forbidden');
  } finally {
    await mismatch.stop();
  }

  const unavailable = await createBridge({ getTaskManager: () => null });
  try {
    const path = `/v1/apps/${APP_ID}/agent-tasks`;
    const { response, payload } = await request(unavailable.bridge, path, {
      method: 'POST',
      body: { templateId: 'recommend_budget' },
    });
    assert.equal(response.status, 503);
    assert.equal(payload.error, 'desktop_runtime_agent_task_manager_unavailable');
  } finally {
    await unavailable.stop();
  }

  const unsupported = await createBridge();
  try {
    const statusPath = `/v1/apps/${APP_ID}/agent-tasks/status`;
    const status = await request(unsupported.bridge, statusPath, { method: 'POST', body: {} });
    assert.equal(status.response.status, 404);
    assert.equal(status.payload.error, 'desktop_runtime_route_not_found');

    const taskPath = `/v1/apps/${APP_ID}/agent-tasks/run-1`;
    const task = await request(unsupported.bridge, taskPath, { method: 'POST', body: {} });
    assert.equal(task.response.status, 404);
    assert.equal(task.payload.error, 'desktop_runtime_route_not_found');
  } finally {
    await unsupported.stop();
  }
});

test('desktop runtime task endpoints start, get, and cancel tasks', async () => {
  const harness = await createBridge();
  try {
    const start = await request(harness.bridge, `/v1/apps/${APP_ID}/agent-tasks`, {
      method: 'POST',
      body: { templateId: 'recommend_budget', arguments: { month: '5' } },
    });
    assert.equal(start.response.status, 200);
    assert.equal(start.payload.runId, 'run-1');
    assert.equal(start.payload.templateId, 'recommend_budget');

    const get = await request(harness.bridge, `/v1/apps/${APP_ID}/agent-tasks/run-1`);
    assert.equal(get.response.status, 200);
    assert.equal(get.payload.runId, 'run-1');

    const cancel = await request(harness.bridge, `/v1/apps/${APP_ID}/agent-tasks/run-1/cancel`, {
      method: 'POST',
      body: {},
    });
    assert.equal(cancel.response.status, 200);
    assert.deepEqual(cancel.payload, { success: true });
  } finally {
    await harness.stop();
  }
});

test('desktop runtime task endpoints reject oversized payloads', async () => {
  const harness = await createBridge({ maxBodyBytes: 8 });
  try {
    const path = `/v1/apps/${APP_ID}/agent-tasks`;
    const body = JSON.stringify({ templateId: 'recommend_budget' });
    const { response, payload } = await request(harness.bridge, path, {
      method: 'POST',
      body: { templateId: 'recommend_budget' },
      headers: sign({ method: 'POST', path, body }),
    });
    assert.equal(response.status, 413);
    assert.equal(payload.error, 'desktop_runtime_body_too_large');
  } finally {
    await harness.stop();
  }
});

test('desktop runtime bridge serves manifest-first conversation thread routes and normalizes runtime options', async () => {
  const calls = [];
  const manager = {
    async create(appId, input) {
      calls.push(['create', appId, input]);
      return { ...conversation, title: input.title ?? conversation.title };
    },
    async sendMessage(appId, input) {
      calls.push(['sendMessage', appId, input]);
      return conversation;
    },
    async get(appId, threadId) {
      calls.push(['get', appId, threadId]);
      return threadId === conversation.conversationId ? conversation : null;
    },
    async cancel(appId, threadId, runId) {
      calls.push(['cancel', appId, threadId, runId]);
      return { success: true };
    },
    async getMetadata() {
      return { manifestAgentId: 'analyst' };
    },
    async steerRun(appId, threadId, runId, input) {
      calls.push(['steerRun', appId, threadId, runId, input]);
      return { accepted: true, mode: 'queued_for_next_run' };
    },
  };
  const harness = await createBridge({ getConversationManager: () => manager });
  try {
    const createPath = `/v1/apps/${APP_ID}/agents/analyst/start`;
    const created = await request(harness.bridge, createPath, {
      method: 'POST',
      body: {
        title: 'Budget review',
        variables: { topic: 'May' },
        metadata: { source: 'test' },
      },
    });
    assert.equal(created.response.status, 200);
    assert.equal(created.payload.desktop_thread_id, 'thread-1');
    assert.equal(calls[0][2].metadata.promptApi, 'manifest-http');
    assert.equal(calls[0][2].metadata.manifestAgentId, 'analyst');
    assert.equal(calls[1][2].message, 'initial:May');

    const runPath = `/v1/apps/${APP_ID}/agent-threads/thread-1/resume`;
    const run = await request(harness.bridge, runPath, {
      method: 'POST',
      body: {
        variables: { topic: 'June' },
        workspacePath: '/tmp/workspace',
        runtime: { provider: 'claude', model: 'auto', effort: 'high' },
      },
    });
    assert.equal(run.response.status, 200);
    assert.equal(run.payload.desktop_run_id, 'run-9');
    assert.equal(calls[2][2].message, 'resume:June');
    assert.equal(calls[2][2].provider, 'claude');
    assert.equal(calls[2][2].model, undefined);
    assert.equal(calls[2][2].effort, 'high');

    await request(harness.bridge, runPath, {
      method: 'POST',
      body: {
        variables: { topic: 'July' },
        runtime: { provider: 'codex', model: 'gpt-5.3-codex', effort: 'default' },
      },
    });
    assert.equal(calls[3][2].message, 'resume:July');
    assert.equal(calls[3][2].provider, 'codex');
    assert.equal(calls[3][2].model, 'gpt-5.3-codex');
    assert.equal(calls[3][2].effort, undefined);

    await request(harness.bridge, runPath, {
      method: 'POST',
      body: {
        variables: { topic: 'August' },
        runtime: { provider: 'unknown', model: 'auto', effort: 'default' },
      },
    });
    assert.equal(calls[4][2].message, 'resume:August');
    assert.equal(calls[4][2].provider, undefined);
    assert.equal(calls[4][2].model, undefined);
    assert.equal(calls[4][2].effort, undefined);

    const steer = await request(harness.bridge, `/v1/apps/${APP_ID}/agent-threads/thread-1/runs/run-9/steer`, {
      method: 'POST',
      body: { variables: { topic: 'steer' } },
    });
    assert.equal(steer.response.status, 200);
    assert.deepEqual(steer.payload, { accepted: true, mode: 'queued_for_next_run' });
    assert.equal(calls[5][0], 'steerRun');
    assert.equal(calls[5][4].message, 'steer:steer');

    const thread = await request(harness.bridge, `/v1/apps/${APP_ID}/agent-threads/thread-1`);
    assert.equal(thread.response.status, 200);
    assert.equal(thread.payload.active_run.desktop_run_id, 'run-9');

    const runStatus = await request(harness.bridge, `/v1/apps/${APP_ID}/agent-threads/thread-1/runs/run-9`);
    assert.equal(runStatus.response.status, 200);
    assert.equal(runStatus.payload.status, 'running');

    const missingRun = await request(harness.bridge, `/v1/apps/${APP_ID}/agent-threads/thread-1/runs/missing`);
    assert.equal(missingRun.response.status, 200);
    assert.equal(missingRun.payload, null);

    const cancel = await request(harness.bridge, `/v1/apps/${APP_ID}/agent-threads/thread-1/runs/run-9/cancel`, {
      method: 'POST',
      body: {},
    });
    assert.equal(cancel.response.status, 200);
    assert.deepEqual(cancel.payload, { success: true });
  } finally {
    await harness.stop();
  }
});

test('desktop runtime bridge includes active and historical conversation run result text', async () => {
  const resultConversation = {
    conversationId: 'thread-results',
    appId: APP_ID,
    title: 'Result review',
    messages: [
      {
        messageId: 'msg-user',
        role: 'user',
        text: 'Start',
        runId: 'run-active',
        createdAt: '2026-05-17T00:00:00.000Z',
      },
      {
        messageId: 'msg-old-user',
        role: 'user',
        text: 'Old request',
        runId: 'run-old',
        createdAt: '2026-05-17T00:00:01.000Z',
      },
      {
        messageId: 'msg-unrelated',
        role: 'assistant',
        text: 'Ignore me',
        runId: 'other-run',
        createdAt: '2026-05-17T00:00:02.000Z',
      },
      {
        messageId: 'msg-old',
        role: 'assistant',
        text: 'Historical result',
        runId: 'run-old',
        createdAt: '2026-05-17T00:00:03.000Z',
      },
      {
        messageId: 'msg-active',
        role: 'assistant',
        text: 'Active result',
        runId: 'run-active',
        createdAt: '2026-05-17T00:00:04.000Z',
      },
    ],
    activeRun: {
      runId: 'run-active',
      status: 'completed',
      progressLog: ['done'],
    },
  };
  const harness = await createBridge({
    getConversationManager: () => ({
      create: async () => resultConversation,
      sendMessage: async () => resultConversation,
      get: async (_appId, threadId) => (threadId === resultConversation.conversationId ? resultConversation : null),
      cancel: async () => ({ success: true }),
    }),
  });
  try {
    const thread = await request(harness.bridge, `/v1/apps/${APP_ID}/agent-threads/thread-results`);
    assert.equal(thread.response.status, 200);
    assert.equal(thread.payload.active_run.resultText, 'Active result');

    const active = await request(harness.bridge, `/v1/apps/${APP_ID}/agent-threads/thread-results/runs/run-active`);
    assert.equal(active.response.status, 200);
    assert.equal(active.payload.resultText, 'Active result');

    const historical = await request(harness.bridge, `/v1/apps/${APP_ID}/agent-threads/thread-results/runs/run-old`);
    assert.equal(historical.response.status, 200);
    assert.deepEqual(historical.payload, {
      desktop_thread_id: 'thread-results',
      desktop_run_id: 'run-old',
      status: 'completed',
      resultText: 'Historical result',
    });

    const missingRun = await request(harness.bridge, `/v1/apps/${APP_ID}/agent-threads/thread-results/runs/missing`);
    assert.equal(missingRun.response.status, 200);
    assert.equal(missingRun.payload, null);
  } finally {
    await harness.stop();
  }
});

test('desktop runtime bridge rejects invalid conversation thread requests', async () => {
  const harness = await createBridge({
    getConversationManager: () => ({
      create: async () => conversation,
      sendMessage: async () => ({ ...conversation, activeRun: undefined }),
      get: async () => null,
      cancel: async () => ({ success: false }),
    }),
  });
  try {
    const createPath = `/v1/apps/${APP_ID}/agent-threads`;
    const missingPrompt = await request(harness.bridge, createPath, {
      method: 'POST',
      body: { initialPrompt: '   ' },
    });
    assert.equal(missingPrompt.response.status, 410);
    assert.match(missingPrompt.payload.error, /forgerApp bridge has been removed/);

    const wrongAppPath = '/v1/apps/other-app/agent-threads';
    const wrongAppBody = JSON.stringify({ initialPrompt: 'hello' });
    const wrongApp = await request(harness.bridge, wrongAppPath, {
      method: 'POST',
      rawBody: wrongAppBody,
      headers: sign({ method: 'POST', path: wrongAppPath, body: wrongAppBody }),
    });
    assert.equal(wrongApp.response.status, 404);
    assert.equal(wrongApp.payload.error, 'desktop_runtime_route_not_found');
  } finally {
    await harness.stop();
  }
});

test('desktop runtime bridge handles queued conversation runs and unsupported conversation routes', async () => {
  const harness = await createBridge({
    getConversationManager: () => ({
      create: async () => conversation,
      sendMessage: async () => ({ ...conversation, activeRun: undefined }),
      get: async () => conversation,
      cancel: async () => ({ success: false }),
      getMetadata: async () => ({ manifestAgentId: 'analyst' }),
    }),
  });
  try {
    const runPath = `/v1/apps/${APP_ID}/agent-threads/thread-1/resume`;
    const queued = await request(harness.bridge, runPath, {
      method: 'POST',
      body: { variables: { topic: 'Queue this' } },
    });
    assert.equal(queued.response.status, 200);
    assert.deepEqual(queued.payload, {
      desktop_thread_id: 'thread-1',
      desktop_run_id: '',
      status: 'queued',
    });

    const unsupported = await request(harness.bridge, runPath, { method: 'DELETE' });
    assert.equal(unsupported.response.status, 404);
    assert.equal(unsupported.payload.error, 'desktop_runtime_route_not_found');
  } finally {
    await harness.stop();
  }
});

test('desktop runtime bridge reports removed freeform thread routes before manager availability', async () => {
  const harness = await createBridge();
  try {
    const path = `/v1/apps/${APP_ID}/agent-threads`;
    const { response, payload } = await request(harness.bridge, path, {
      method: 'POST',
      body: { initialPrompt: 'hello' },
    });
    assert.equal(response.status, 410);
    assert.match(payload.error, /forgerApp bridge has been removed/);
  } finally {
    await harness.stop();
  }
});

test('desktop runtime bridge signs websocket system and agent events', async () => {
  const harness = await createBridge();
  const path = `/v1/apps/${APP_ID}/agent-events`;
  const headers = sign({ method: 'GET', path });
  const client = new WebSocket(`${harness.bridge.url.replace('http:', 'ws:')}${path}`, { headers });
  try {
    const connected = await websocketMessage(client);
    assert.equal(connected.type, 'desktop_runtime.connected');
    assert.equal(connected.app_id, APP_ID);
    assert.ok(connected.signature);

    harness.bridge.publishAgentEvent({
      type: 'run.message.completed',
      conversation,
      run: conversation.activeRun,
      message: {
        messageId: 'msg-2',
        role: 'assistant',
        text: 'Done',
        createdAt: '2026-05-17T00:01:00.000Z',
      },
      progress: { label: 'Finished' },
    });
    const event = await websocketMessage(client);
    assert.equal(event.type, 'assistant.message.appended');
    assert.equal(event.thread_id, 'thread-1');
    assert.equal(event.run_id, 'run-9');
    assert.equal(event.payload.message.content, 'Done');
    assert.ok(event.signature);

    client.close();
    await new Promise((resolve) => client.once('close', resolve));
    harness.bridge.publishAgentEvent({ type: 'conversation.created', conversation });
  } finally {
    client.close();
    await harness.stop();
  }
});

test('desktop runtime bridge refuses to sign agent events when the app secret has been cleared', async () => {
  const harness = await createBridge();
  try {
    harness.bridge.eventClients.set(APP_ID, new Set([
      {
        close: () => {},
        readyState: WebSocket.OPEN,
        send: () => {},
      },
    ]));
    harness.bridge.secrets.delete(APP_ID);
    assert.throws(
      () => harness.bridge.publishAgentEvent({ type: 'message.created', conversation }),
      /desktop_runtime_secret_unknown/,
    );
  } finally {
    await harness.stop();
  }
});

test('desktop runtime bridge signs minimal agent events and skips closed clients', async () => {
  const harness = await createBridge();
  const sent = [];
  try {
    harness.bridge.eventClients.set(APP_ID, new Set([
      {
        close: () => {},
        readyState: WebSocket.OPEN,
        send: (raw) => sent.push(JSON.parse(raw)),
      },
      {
        close: () => {},
        readyState: WebSocket.CLOSED,
        send: () => {
          throw new Error('closed_client_should_not_receive');
        },
      },
    ]));

    harness.bridge.publishAgentEvent({
      type: 'conversation.created',
      conversation: {
        ...conversation,
        activeRun: undefined,
        messages: [],
      },
    });

    assert.equal(sent.length, 1);
    assert.equal(sent[0].type, 'thread.created');
    assert.equal(sent[0].status, 'idle');
    assert.equal(sent[0].payload.run, undefined);
    assert.deepEqual(sent[0].payload.conversation.messages, []);
    assert.ok(sent[0].signature);

    harness.bridge.publishAgentEvent({
      type: 'custom.desktop.event',
      conversation: {
        ...conversation,
        activeRun: undefined,
        messages: [],
      },
    });
    assert.equal(sent[1].type, 'custom.desktop.event');
  } finally {
    await harness.stop();
  }
});

test('desktop runtime websocket upgrades reject unsigned event clients and unknown routes', async () => {
  const logs = [];
  const harness = await createBridge({ logs });
  try {
    const mismatchPath = '/v1/apps/other-app/agent-events';
    const mismatch = new WebSocket(`${harness.bridge.url.replace('http:', 'ws:')}${mismatchPath}`, {
      headers: sign({ method: 'GET', path: mismatchPath, appId: APP_ID }),
    });
    const mismatchClose = await new Promise((resolve) => {
      mismatch.once('error', () => undefined);
      mismatch.once('close', (code) => resolve(code));
    });
    assert.equal(mismatchClose, 1006);

    const unsigned = new WebSocket(`${harness.bridge.url.replace('http:', 'ws:')}/v1/apps/${APP_ID}/agent-events`);
    const unsignedClose = await new Promise((resolve) => {
      unsigned.once('error', () => undefined);
      unsigned.once('close', (code) => resolve(code));
    });
    assert.equal(unsignedClose, 1006);

    const unknown = new WebSocket(`${harness.bridge.url.replace('http:', 'ws:')}/v1/apps/${APP_ID}/unknown-events`);
    const unknownClose = await new Promise((resolve) => {
      unknown.once('error', () => undefined);
      unknown.once('close', (code) => resolve(code));
    });
    assert.equal(unknownClose, 1006);
    assert.ok(logs.some(([event]) => event === 'desktop_runtime_bridge:websocket_error'));
  } finally {
    await harness.stop();
  }
});
