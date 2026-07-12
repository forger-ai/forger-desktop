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
    listConnectionGrantsForApp: async () => [],
    listConnectionsForSession: async (grants) => ({ types: [], instances: [], grants }),
    callConnectionFromSession: async (input) => ({ success: true, data: input }),
    getSpeechToTextState: async () => ({ status: 'not_installed', installed: false, running: false }),
    processSpeechToText: async () => ({ success: true }),
    getTextToSpeechState: async () => ({ status: 'not_installed', installed: false, running: false, models: [], voices: [], queue: [] }),
    synthesizeTextToSpeech: async () => ({ success: true }),
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
  assert.deepEqual(schema.properties.runtime.oneOf[0].properties.effort.enum, ['none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
  assert.deepEqual(schema.properties.runtime.oneOf[1].properties.effort.enum, ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.equal(schema.properties.model.type, 'string');
  assert.deepEqual(schema.properties.reasoningEffort.enum, ['none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
});

test('forger_test_app_prompt schema accepts prompt candidates and variables', () => {
  const schema = getMcpToolInputSchema('forger_test_app_prompt');
  assert.deepEqual(schema.required, ['appId', 'kind', 'id']);
  assert.deepEqual(schema.properties.kind.enum, ['promptTemplate', 'agent', 'agentPrompt']);
  assert.equal(schema.properties.prompt.type, 'string');
  assert.equal(schema.properties.variables.type, 'object');
  assert.equal(schema.additionalProperties, false);
});

test('forger_add_app_to_personal_agent schema requires only an appId', () => {
  const schema = getMcpToolInputSchema('forger_add_app_to_personal_agent');
  assert.deepEqual(schema.required, ['appId']);
  assert.equal(schema.properties.appId.type, 'string');
  assert.equal(schema.additionalProperties, false);
});

test('Sidekick response tools require text and reject extra fields', () => {
  for (const toolId of ['respond_and_end', 'respond_and_wait']) {
    const schema = getMcpToolInputSchema(toolId);
    assert.deepEqual(schema.required, ['text']);
    assert.equal(schema.properties.text.type, 'string');
    assert.equal(schema.properties.text.maxLength, 4000);
    assert.equal(schema.additionalProperties, false);
  }
});

test('BDD: Sidekick tools are scoped to the matching personal-agent run and dispatch exactly once', async () => {
  const outcomes = [];
  const harness = await createServer({
    resolveSidekickVoiceOutcome: (input) => {
      outcomes.push(input);
      return outcomes.length === 1 ? { accepted: true } : { accepted: false };
    },
  });
  const sidekickSession = harness.server.createSession('run-voice-1', 'forger', {
    caller: 'personal-agent',
    personalAgentId: 'agent-1',
    personalAgentConversationId: 'conversation-1',
    sidekick: { sidekickId: 'sidekick-1' },
    appIds: [],
  });
  const plainSession = harness.server.createSession('run-plain', 'forger', {
    caller: 'personal-agent',
    personalAgentId: 'agent-1',
    personalAgentConversationId: 'conversation-1',
    appIds: [],
  });
  try {
    const list = async (session) => {
      const response = await fetch(session.url, {
        method: 'POST',
        headers: { authorization: `Bearer ${session.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
      return (await response.json()).result.tools.map((tool) => tool.name);
    };
    assert.ok((await list(sidekickSession)).includes('respond_and_wait'));
    assert.ok(!(await list(plainSession)).includes('respond_and_wait'));

    const call = async (text = '¿En qué habitación?') => {
      const response = await fetch(sidekickSession.url, {
        method: 'POST',
        headers: { authorization: `Bearer ${sidekickSession.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 2, method: 'tools/call',
          params: { name: 'respond_and_wait', arguments: { text } },
        }),
      });
      const payload = await response.json();
      return JSON.parse(payload.result.content[0].text);
    };
    assert.deepEqual(await call('x'.repeat(4_001)), {
      success: false,
      accepted: false,
      userMessage: 'La respuesta de voz supera el largo permitido.',
      technicalCode: 'sidekick_voice_response_text_too_long',
    });
    assert.equal(outcomes.length, 0);
    assert.deepEqual(await call(), { success: true, accepted: true, mode: 'wait' });
    assert.deepEqual(await call(), {
      success: false,
      accepted: false,
      technicalCode: 'sidekick_voice_outcome_not_pending',
    });
    assert.deepEqual(outcomes, [
      {
        sidekickId: 'sidekick-1', conversationId: 'conversation-1', runId: 'run-voice-1',
        mode: 'wait', text: '¿En qué habitación?',
      },
      {
        sidekickId: 'sidekick-1', conversationId: 'conversation-1', runId: 'run-voice-1',
        mode: 'wait', text: '¿En qué habitación?',
      },
    ]);
  } finally {
    harness.stop();
  }
});

test('speech-to-text MCP schemas expose status and authorized audio paths', () => {
  const statusSchema = getMcpToolInputSchema('forger_speech_to_text_status');
  assert.deepEqual(statusSchema, {
    type: 'object',
    properties: {},
    additionalProperties: false,
  });

  const transcribeSchema = getMcpToolInputSchema('forger_transcribe_audio');
  assert.deepEqual(transcribeSchema.required, ['path']);
  assert.equal(transcribeSchema.properties.path.type, 'string');
  assert.deepEqual(transcribeSchema.properties.model.enum, ['tiny', 'base', 'small', 'medium', 'large-v3']);
  assert.equal(transcribeSchema.additionalProperties, false);

  const translateSchema = getMcpToolInputSchema('forger_translate_audio');
  assert.deepEqual(translateSchema.required, ['path']);
  assert.equal(translateSchema.properties.language.type, 'string');
  assert.deepEqual(translateSchema.properties.model.enum, ['tiny', 'base', 'small', 'medium', 'large-v3']);
});

test('text-to-speech MCP schemas expose status voices and explicit synthesize parameters', () => {
  assert.deepEqual(getMcpToolInputSchema('forger_text_to_speech_status'), {
    type: 'object',
    properties: {},
    additionalProperties: false,
  });
  assert.deepEqual(getMcpToolInputSchema('forger_text_to_speech_voices'), {
    type: 'object',
    properties: {},
    additionalProperties: false,
  });
  const synthesizeSchema = getMcpToolInputSchema('forger_synthesize_speech');
  assert.deepEqual(synthesizeSchema.required, ['text', 'model', 'voice']);
  assert.equal(synthesizeSchema.properties.text.type, 'string');
  assert.equal(synthesizeSchema.properties.model.type, 'string');
  assert.equal(synthesizeSchema.properties.voice.type, 'string');
  assert.deepEqual(synthesizeSchema.properties.format.enum, ['wav', 'mp3', 'opus']);
  assert.equal(synthesizeSchema.additionalProperties, false);
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

test('forger_add_app_to_personal_agent is listed only for personal-agent sessions and forwards the active agent id', async () => {
  let capturedInput;
  const harness = await createServer({
    getToolDefinitions: () => [{
      id: 'forger_add_app_to_personal_agent',
      packageId: 'forger',
      name: 'Agregar app al agente',
      description: 'Permite una app para el agente.',
      category: 'app',
      risk: 'medio',
      defaultRequiresApproval: false,
    }],
    addAppToPersonalAgent: async (input) => {
      capturedInput = input;
      return {
        success: true,
        appId: input.appId,
        alreadyGranted: false,
        userMessage: 'App agregada.',
      };
    },
  });
  const personalSession = harness.server.createSession('run-1', 'forger', {
    caller: 'personal-agent',
    personalAgentId: 'agent-1',
    appIds: [],
  });
  const freeSession = harness.server.createSession('run-2', 'forger', {
    caller: 'free-chat',
    appIds: [],
  });
  try {
    const personalList = await fetch(personalSession.url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${personalSession.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    const personalPayload = await personalList.json();
    assert.ok(personalPayload.result.tools.some((tool) => tool.name === 'forger_add_app_to_personal_agent'));

    const freeList = await fetch(freeSession.url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${freeSession.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    });
    const freePayload = await freeList.json();
    assert.ok(!freePayload.result.tools.some((tool) => tool.name === 'forger_add_app_to_personal_agent'));

    const response = await fetch(personalSession.url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${personalSession.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'forger_add_app_to_personal_agent',
          arguments: { appId: 'finance-os' },
        },
      }),
    });
    const payload = await response.json();
    const result = JSON.parse(payload.result.content[0].text);

    assert.equal(response.status, 200);
    assert.equal(payload.result.isError, false);
    assert.deepEqual(capturedInput, { agentId: 'agent-1', appId: 'finance-os' });
    assert.equal(result.success, true);
    assert.equal(result.appId, 'finance-os');
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
