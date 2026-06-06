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
  }, {
    id: 'forger_test_app_prompt',
    packageId: 'forger',
    name: 'Probar prompt de app',
    description: 'Valida un prompt local.',
    category: 'consulta',
    risk: 'bajo',
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
    testAppPrompt: async () => ({ success: true, valid: true, errors: [], declaredVariables: [], usedVariables: [], missingVariables: [], extraVariables: [] }),
    updateAppPrompt: async () => ({ success: true, userMessage: 'Prompt actualizado.' }),
    restoreAppPrompt: async () => ({ success: true }),
    previewAppToolGrant: async (input) => ({
      success: false,
      appId: input.appId,
      userMessage: 'Sin declaracion.',
      technicalCode: 'app_tools_not_declared',
    }),
    setAppToolGrant: async (input) => ({
      success: true,
      appId: input.appId,
      userMessage: 'Grant actualizado.',
      gate: null,
    }),
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

test('forger_test_app_prompt schema accepts prompt candidates and variables', () => {
  const schema = getMcpToolInputSchema('forger_test_app_prompt');
  assert.deepEqual(schema.required, ['appId', 'kind', 'id']);
  assert.deepEqual(schema.properties.kind.enum, ['promptTemplate', 'agent', 'agentPrompt']);
  assert.equal(schema.properties.prompt.type, 'string');
  assert.equal(schema.properties.variables.type, 'object');
  assert.equal(schema.additionalProperties, false);
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

test('forger_test_app_prompt forwards prompt candidates without saving', async () => {
  let capturedInput;
  const harness = await createServer({
    testAppPrompt: async (input) => {
      capturedInput = input;
      return {
        success: false,
        valid: false,
        technicalCode: 'agent_prompt_placeholder_not_declared',
        errors: ['bad variable'],
        declaredVariables: ['game_ids'],
        usedVariables: ['#game_ids'],
        missingVariables: [],
        extraVariables: ['#game_ids'],
      };
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
          name: 'forger_test_app_prompt',
          arguments: {
            appId: 'finance-os',
            kind: 'agentPrompt',
            id: 'advisor:initial',
            prompt: 'Review {{#game_ids}}.',
            variables: { game_ids: [1, 2] },
          },
        },
      }),
    });
    const payload = await response.json();
    const result = JSON.parse(payload.result.content[0].text);

    assert.equal(response.status, 200);
    assert.equal(payload.result.isError, true);
    assert.deepEqual(capturedInput, {
      appId: 'finance-os',
      kind: 'agentPrompt',
      id: 'advisor:initial',
      prompt: 'Review {{#game_ids}}.',
      variables: { game_ids: [1, 2] },
    });
    assert.equal(result.success, false);
    assert.equal(result.technicalCode, 'agent_prompt_placeholder_not_declared');
  } finally {
    harness.stop();
  }
});
