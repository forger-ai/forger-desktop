import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { createRequire } from 'node:module';
import test from 'node:test';

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

const createBridge = async (options = {}) => {
  const bridge = new DesktopRuntimeBridge({
    getInstalledApp: (appId) => (appId === APP_ID ? { id: appId, installDir: '/tmp/finance-os' } : null),
    getConversationManager: () => null,
    renderManifestAgentPrompt: () => '',
    resolveInstalledAgents: async () => [],
    officialTools: options.officialTools,
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

test('desktop runtime official tool endpoints list, describe, and delegate app-granted actions', async () => {
  const calls = [];
  const chromeTool = {
    id: 'forger_chrome_extension',
    name: 'Forger Chrome Extension',
    description: 'Controls Chrome through Forger.',
    version: '0.1.0',
    runtime: 'builtin',
    official: true,
    secrets: [],
    configured: true,
    status: 'configured',
    actions: [
      {
        id: 'forger_chrome_extension.set_styles',
        name: 'Set styles',
        description: 'Applies allowed CSS styles.',
        risk: 'medium',
      },
      {
        id: 'forger_chrome_extension.submit_form',
        name: 'Submit form',
        description: 'Submits a form.',
        risk: 'high',
      },
    ],
  };
  const harness = await createBridge({
    officialTools: {
      listToolsForApp: async (appId) => {
        calls.push(['listToolsForApp', appId]);
        return [chromeTool];
      },
      callFromApp: async (appId, input) => {
        calls.push(['callFromApp', appId, input]);
        return { success: true, data: { appId, input } };
      },
    },
  });
  try {
    const listed = await request(harness.bridge, `/v1/apps/${APP_ID}/tools`);
    assert.equal(listed.response.status, 200);
    assert.deepEqual(listed.payload, { tools: [chromeTool] });

    const described = await request(harness.bridge, `/v1/apps/${APP_ID}/tools/forger_chrome_extension`);
    assert.equal(described.response.status, 200);
    assert.deepEqual(described.payload, chromeTool);

    const called = await request(
      harness.bridge,
      `/v1/apps/${APP_ID}/tools/forger_chrome_extension/actions/forger_chrome_extension.set_styles`,
      {
        method: 'POST',
        body: {
          input: {
            sessionId: 'chrome-session',
            selector: '#total',
            styles: {
              outline: '2px solid #dd782b',
              boxShadow: '0 0 0 4px rgba(221,120,43,0.2)',
            },
          },
        },
      },
    );
    assert.equal(called.response.status, 200);
    assert.equal(called.payload.success, true);
    assert.deepEqual(called.payload.data.input, {
      toolId: 'forger_chrome_extension',
      actionId: 'forger_chrome_extension.set_styles',
      input: {
        sessionId: 'chrome-session',
        selector: '#total',
        styles: {
          outline: '2px solid #dd782b',
          boxShadow: '0 0 0 4px rgba(221,120,43,0.2)',
        },
      },
    });
    assert.deepEqual(calls.map(([name]) => name), ['listToolsForApp', 'listToolsForApp', 'callFromApp']);
  } finally {
    await harness.stop();
  }
});

test('desktop runtime official tool endpoints hide undeclared tools and require the official tool service', async () => {
  const harness = await createBridge({
    officialTools: {
      listToolsForApp: async () => [],
      callFromApp: async () => ({ success: false }),
    },
  });
  try {
    const missing = await request(harness.bridge, `/v1/apps/${APP_ID}/tools/forger_chrome_extension`);
    assert.equal(missing.response.status, 404);
    assert.equal(missing.payload.error, 'desktop_runtime_tool_not_found');
  } finally {
    await harness.stop();
  }

  const withoutService = await createBridge();
  try {
    const result = await request(withoutService.bridge, `/v1/apps/${APP_ID}/tools`);
    assert.equal(result.response.status, 503);
    assert.equal(result.payload.error, 'desktop_runtime_official_tools_unavailable');
  } finally {
    await withoutService.stop();
  }
});
