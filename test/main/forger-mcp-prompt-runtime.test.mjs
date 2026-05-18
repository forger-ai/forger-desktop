import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ForgerMcpServer } = require('../../dist-electron/main/forger-mcp-server.js');
const { getMcpToolInputSchema } = require('../../dist-electron/main/forger-mcp/tool-metadata.js');

const createServer = async (overrides = {}) => {
  const toolDefinitions = [{
    id: 'forger_update_app_prompt',
    packageId: 'forger',
    name: 'Editar prompt de app',
    description: 'Actualiza un prompt local.',
    category: 'app',
    risk: 'medio',
    defaultRequiresApproval: false,
  }];
  const server = new ForgerMcpServer({
    getAppVersion: () => '0.1.test',
    getToolDefinitions: () => toolDefinitions,
    getToolSettings: () => ({ approvals: { forger_update_app_prompt: false } }),
    appendInstallLog: async () => {},
    requestPermission: () => null,
    listCatalog: async () => [],
    listInstalledApps: () => [],
    checkUpdates: async () => [],
    getRuntimeStatus: () => ({ status: 'stopped' }),
    openApp: async () => ({ success: true }),
    stopApp: async () => ({ success: true }),
    restartApp: async () => ({ success: true }),
    refreshAppView: async () => ({ success: true }),
    updateApp: async () => ({ success: true }),
    listAppPrompts: async () => [],
    updateAppPrompt: async () => ({ success: true, userMessage: 'Prompt actualizado.' }),
    restoreAppPrompt: async () => ({ success: true }),
    memoryList: async () => [],
    memoryCreate: async () => ({}),
    memoryUpdate: async () => ({}),
    memoryDelete: async () => ({ success: true }),
    listOfficialToolActionIdsForApp: async () => new Set(),
    validateOfficialTool: async () => null,
    callOfficialTool: async () => ({ success: true }),
    ...overrides,
  });
  await server.start();
  return {
    server,
    stop: () => {
      server.stop();
    },
  };
};

test('forger_update_app_prompt schema accepts agentPrompt and runtime overrides', () => {
  const schema = getMcpToolInputSchema('forger_update_app_prompt');
  assert.deepEqual(schema.properties.kind.enum, ['promptTemplate', 'agent', 'agentPrompt']);
  assert.equal(schema.properties.runtime.oneOf[0].properties.provider.const, 'codex');
  assert.equal(schema.properties.runtime.oneOf[1].properties.provider.const, 'claude');
  assert.deepEqual(schema.properties.runtime.oneOf[0].properties.effort.enum, ['none', 'low', 'medium', 'high', 'xhigh']);
  assert.deepEqual(schema.properties.runtime.oneOf[1].properties.effort.enum, ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.equal(schema.properties.model.type, 'string');
  assert.deepEqual(schema.properties.reasoningEffort.enum, ['none', 'low', 'medium', 'high', 'xhigh']);
});

test('forger_update_app_prompt forwards agentPrompt runtime arguments', async () => {
  let capturedInput;
  const harness = await createServer({
    updateAppPrompt: async (input) => {
      capturedInput = input;
      return { success: true, userMessage: 'Prompt actualizado.' };
    },
  });
  const session = harness.server.createSession('run-1', 'finance-os');
  try {
    const response = await fetch(session.url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${session.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'forger_update_app_prompt',
          arguments: {
            appId: 'finance-os',
            kind: 'agentPrompt',
            id: 'advisor:initial',
            prompt: 'Review {{item}}.',
            runtime: { provider: 'claude', model: 'sonnet', effort: 'high' },
          },
        },
      }),
    });
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.result.isError, false);
    assert.deepEqual(capturedInput, {
      appId: 'finance-os',
      kind: 'agentPrompt',
      id: 'advisor:initial',
      prompt: 'Review {{item}}.',
      runtime: { provider: 'claude', model: 'sonnet', effort: 'high' },
    });
  } finally {
    harness.stop();
  }
});
