import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import test from 'node:test';

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { DesktopRuntimeBridge } = require('../../dist-electron/main/desktop-runtime-bridge.js');

const APP_ID = 'finance-os';
const SECRET = 'test-secret';

const sign = ({ method, path, body = '', secret = SECRET, appId = APP_ID, bodySha }) => {
  const timestamp = new Date().toISOString();
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
    getInstalledApp: (appId) => (appId === APP_ID ? { id: appId } : null),
    getConversationManager: () => null,
    getTaskManager: () => taskManager,
    getTaskStatus: async () => ({ connected: true, codex: true, claude: false }),
    appendInstallLog: async () => {},
    serializeErrorForInstallLog: (error) => ({ message: error instanceof Error ? error.message : String(error) }),
    maxBodyBytes: options.maxBodyBytes ?? 1024,
  });
  await bridge.start();
  bridge.secrets.set(APP_ID, SECRET);
  return {
    bridge,
    stop: async () => {
      await bridge.stop();
    },
  };
};

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
