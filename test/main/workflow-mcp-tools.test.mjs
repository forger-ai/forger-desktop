import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ForgerMcpServer } = require('../../dist-electron/main/forger-mcp-server.js');
const { AGENT_TOOL_DEFINITIONS } = require('../../dist-electron/main/core/agent-tool-packages.js');
const {
  getMcpToolInputSchema,
} = require('../../dist-electron/main/forger-mcp/tool-metadata.js');

const createHarness = async (overrides = {}) => {
  const logs = [];
  const completions = [];
  const failures = [];
  const server = new ForgerMcpServer({
    getAppVersion: () => '0.1.test',
    getToolDefinitions: () => AGENT_TOOL_DEFINITIONS,
    getToolSettings: () => ({ approvals: {} }),
    appendInstallLog: async (event, payload) => logs.push({ event, payload }),
    requestPermission: () => Promise.resolve(true),
    listCatalog: async () => [],
    listInstalledApps: () => [],
    checkUpdates: async () => [],
    createLocalApp: async () => ({ success: false }),
    finishSocialAppInstall: async () => ({ success: false }),
    deleteQuarantinedSocialApp: async () => ({ success: false }),
    registerQuestion: async () => ({ requestId: 'q', chatId: 'c', questions: [], createdAt: '' }),
    getRuntimeStatus: () => ({ status: 'stopped' }),
    openApp: async () => ({ success: false }),
    stopApp: async () => ({ success: false }),
    restartApp: async () => ({ success: false }),
    refreshAppView: async () => ({ success: false }),
    updateApp: async () => ({ success: false }),
    listAppPrompts: async () => [],
    testAppPrompt: async () => ({ success: false }),
    updateAppPrompt: async () => ({ success: false }),
    restoreAppPrompt: async () => ({ success: false }),
    previewAppToolGrant: async () => ({ success: false, appId: 'x' }),
    setAppToolGrant: async () => ({ success: false, appId: 'x' }),
    memoryList: async () => [],
    memoryCreate: async () => ({ id: 'm' }),
    memoryUpdate: async () => ({ id: 'm' }),
    memoryDelete: async () => ({ success: true }),
    listOfficialToolActionIdsForApp: async () => new Set(),
    validateOfficialTool: async () => null,
    callOfficialTool: async () => ({ success: true }),
    listConnectionGrantsForApp: async () => [],
    listConnectionsForSession: async (grants) => ({ types: [], instances: [], grants }),
    callConnectionFromSession: async (input) => ({ success: true, data: input }),
    getSpeechToTextState: async () => ({}),
    getTextToSpeechState: async () => ({}),
    synthesizeTextToSpeech: async () => ({ success: false }),
    processSpeechToText: async () => ({ success: false }),
    workflowGetNodeContext: (nodeRunKey) => nodeRunKey === 'run-1:paso1'
      ? { workflowId: 'wf-1', runId: 'run-1', nodeId: 'paso1', input: { trigger: { type: 'manual' } } }
      : null,
    workflowCompleteNode: (nodeRunKey, args) => {
      completions.push({ nodeRunKey, args });
      return args.output && typeof args.output === 'object'
        ? { success: true }
        : { success: false, errors: ['output.total es requerido'], technicalCode: 'workflow_output_schema_invalid' };
    },
    workflowFailNode: (nodeRunKey, args) => {
      failures.push({ nodeRunKey, args });
      return { success: true };
    },
    workflowsList: () => [{ id: 'wf-1', name: 'Flujo demo' }],
    workflowsGet: (workflowId) => workflowId === 'wf-1' ? { id: 'wf-1', name: 'Flujo demo' } : null,
    workflowsUpsert: async (input) => ({ id: 'wf-new', ...input }),
    workflowsRun: async (workflowId) => ({ id: 'run-x', workflowId, status: 'queued' }),
    ...overrides,
  });
  await server.start();
  return { server, logs, completions, failures, stop: () => server.stop() };
};

const callMcp = async (session, body) => {
  const response = await fetch(session.url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${session.token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  return await response.json();
};

const listTools = async (session) => {
  const payload = await callMcp(session, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
  return payload.result.tools.map((tool) => tool.name);
};

const callTool = async (session, name, args = {}) => {
  const payload = await callMcp(session, {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name, arguments: args },
  });
  return JSON.parse(payload.result.content[0].text);
};

test('published app info tool exposes schema and updates Social app metadata', async () => {
  const schema = getMcpToolInputSchema('forger_update_published_app_info');
  assert.deepEqual(schema.anyOf, [{ required: ['userAppId'] }, { required: ['appId'] }]);
  assert.equal(schema.properties.userAppId.type, 'number');
  assert.equal(schema.properties.appId.type, 'string');
  assert.deepEqual(schema.properties.visibility.enum, ['public', 'friends', 'private']);
  assert.ok(schema.properties.category.enum.includes('productivity'));
  assert.equal(schema.additionalProperties, false);

  const updates = [];
  const harness = await createHarness({
    updatePublishedAppInfo: async (input) => {
      updates.push(input);
      return {
        success: true,
        userMessage: 'Informacion publicada actualizada.',
        app: {
          id: input.userAppId,
          slug: 'demo',
          name: input.name,
          visibility: input.visibility,
          status: 'published',
          owner: { id: 1, username: 'ada' },
        },
      };
    },
  });
  try {
    const session = harness.server.createSession('run-social', 'forger', { caller: 'free-chat' });
    const tools = await listTools(session);
    assert.ok(tools.includes('forger_update_published_app_info'));

    const result = await callTool(session, 'forger_update_published_app_info', {
      userAppId: 42,
      name: 'Nueva App',
      shortDescription: '',
      description: 'Descripcion larga',
      category: 'utilities',
      visibility: 'private',
    });

    assert.equal(result.success, true);
    assert.equal(result.app.id, 42);
    assert.deepEqual(updates, [{
      userAppId: 42,
      name: 'Nueva App',
      shortDescription: '',
      description: 'Descripcion larga',
      category: 'utilities',
      visibility: 'private',
    }]);
    assert.deepEqual(result.authorization, {
      required: true,
      status: 'approved',
      userMessage: 'Autorización recibida. La herramienta continuó con la acción solicitada.',
    });
  } finally {
    harness.stop();
  }
});

test('published app info tool rejects calls without update fields', async () => {
  const updates = [];
  const harness = await createHarness({
    updatePublishedAppInfo: async (input) => {
      updates.push(input);
      return { success: true, userMessage: 'ok' };
    },
  });
  try {
    const session = harness.server.createSession('run-social', 'forger', { caller: 'free-chat' });
    const result = await callTool(session, 'forger_update_published_app_info', { userAppId: 42 });

    assert.equal(result.success, false);
    assert.equal(result.technicalCode, 'published_app_info_input_invalid');
    assert.deepEqual(updates, []);

    const invalidVisibility = await callTool(session, 'forger_update_published_app_info', {
      userAppId: 42,
      visibility: 'restricted',
    });
    assert.equal(invalidVisibility.success, false);
    assert.equal(invalidVisibility.technicalCode, 'published_app_info_input_invalid');
    assert.deepEqual(updates, []);
  } finally {
    harness.stop();
  }
});

test('workflow node tools are only visible to workflow sessions', async () => {
  const harness = await createHarness({
    getToolDefinitions: () => [
      ...AGENT_TOOL_DEFINITIONS,
      {
        id: 'slack.send_message',
        packageId: 'connection:slack',
        name: 'Send Slack message',
        description: 'Send a Slack message.',
        category: 'app',
        risk: 'alto',
        defaultRequiresApproval: false,
      },
    ],
  });
  try {
    const workflowSession = harness.server.createSession('run-1:paso1', 'forger', {
      caller: 'workflow',
      appIds: [],
      connectionGrants: [{ type: 'slack', actions: ['slack.send_message'], multiple: true }],
    });
    const chatSession = harness.server.createSession('run-chat', 'forger', { caller: 'free-chat' });

    const workflowTools = await listTools(workflowSession);
    assert.ok(workflowTools.includes('workflow_get_context'));
    assert.ok(workflowTools.includes('workflow_complete_node'));
    assert.ok(workflowTools.includes('workflow_fail_node'));
    assert.ok(!workflowTools.includes('forger_workflow_upsert'), 'workflow nodes cannot manage workflows');
    assert.ok(workflowTools.includes('slack.send_message'), 'granted connection action is listed');
    assert.ok(!workflowTools.includes('gmail.send_email'), 'ungranted connection action is hidden');

    const chatTools = await listTools(chatSession);
    assert.ok(!chatTools.includes('workflow_complete_node'));
    assert.ok(chatTools.includes('forger_workflow_list'));
    assert.ok(chatTools.includes('forger_workflow_upsert'));
    assert.ok(chatTools.includes('forger_workflow_run'));
  } finally {
    harness.stop();
  }
});

test('MCP exposes granted connection actions from connection definitions', async () => {
  const harness = await createHarness({
    getConnectionToolDefinitions: async () => [
      {
        id: 'trello.update_card',
        packageId: 'connection:trello',
        name: 'Update Trello card',
        description: 'Update a Trello card.',
        category: 'app',
        risk: 'alto',
        defaultRequiresApproval: false,
      },
    ],
  });
  try {
    const session = harness.server.createSession('run-1', 'forger', {
      caller: 'personal-agent',
      appIds: [],
      connectionGrants: [{ type: 'trello', actions: ['trello.update_card'], multiple: true }],
    });
    const tools = await listTools(session);
    assert.ok(tools.includes('trello.update_card'), 'dynamic granted connection action is listed');

    const result = await callTool(session, 'trello.update_card', { cardId: 'card-1', name: 'Nuevo titulo' });
    assert.equal(result.success, true);
    assert.equal(result.data.actionId, 'trello.update_card');
  } finally {
    harness.stop();
  }
});

test('workflow node tools dispatch to the manager bridge', async () => {
  const harness = await createHarness();
  try {
    const session = harness.server.createSession('run-1:paso1', 'forger', {
      caller: 'workflow',
      appIds: [],
      officialToolActionIds: [],
    });

    const context = await callTool(session, 'workflow_get_context');
    assert.equal(context.success, true);
    assert.equal(context.context.nodeId, 'paso1');

    const completed = await callTool(session, 'workflow_complete_node', {
      output: { total: 3 },
      summary: 'listo',
    });
    assert.equal(completed.success, true);
    assert.deepEqual(harness.completions[0].args.output, { total: 3 });

    const invalid = await callTool(session, 'workflow_complete_node', { output: 'texto' });
    assert.equal(invalid.success, false);
    assert.ok(invalid.userMessage.includes('esquema'));

    const failed = await callTool(session, 'workflow_fail_node', { reason: 'sin datos' });
    assert.equal(failed.success, true);
    assert.equal(harness.failures[0].args.reason, 'sin datos');
  } finally {
    harness.stop();
  }
});

test('workflow node tools are rejected outside workflow sessions', async () => {
  const harness = await createHarness();
  try {
    const chatSession = harness.server.createSession('run-chat', 'forger', { caller: 'free-chat' });
    const result = await callTool(chatSession, 'workflow_complete_node', { output: {}, summary: 'x' });
    assert.equal(result.success, false);
    assert.equal(result.technicalCode, 'workflow_node_context_required');
  } finally {
    harness.stop();
  }
});

test('chat sessions manage workflows through forger_workflow_* tools', async () => {
  const harness = await createHarness();
  try {
    const session = harness.server.createSession('run-chat', 'forger', { caller: 'free-chat' });

    const list = await callTool(session, 'forger_workflow_list');
    assert.equal(list.success, true);
    assert.equal(list.workflows[0].id, 'wf-1');

    const get = await callTool(session, 'forger_workflow_get', { workflowId: 'wf-1' });
    assert.equal(get.success, true);
    const missing = await callTool(session, 'forger_workflow_get', { workflowId: 'nope' });
    assert.equal(missing.success, false);
    assert.equal(missing.technicalCode, 'workflow_not_found');

    const upserted = await callTool(session, 'forger_workflow_upsert', {
      name: 'Nuevo',
      trigger: { type: 'manual' },
      nodes: [],
    });
    assert.equal(upserted.success, true);
    assert.equal(upserted.workflow.id, 'wf-new');

    const run = await callTool(session, 'forger_workflow_run', { workflowId: 'wf-1' });
    assert.equal(run.success, true);
    assert.equal(run.run.workflowId, 'wf-1');
  } finally {
    harness.stop();
  }
});

test('workflow upsert errors are translated for the agent', async () => {
  const harness = await createHarness({
    workflowsUpsert: async () => {
      throw new Error('workflow_graph_has_cycle');
    },
  });
  try {
    const session = harness.server.createSession('run-chat', 'forger', { caller: 'free-chat' });
    const result = await callTool(session, 'forger_workflow_upsert', {
      name: 'Ciclo',
      trigger: { type: 'manual' },
      nodes: [],
    });
    assert.equal(result.success, false);
    assert.equal(result.technicalCode, 'workflow_graph_has_cycle');
    assert.ok(result.userMessage.includes('ciclo'));
  } finally {
    harness.stop();
  }
});

test('workflow tool schemas are strict', () => {
  assert.deepEqual(getMcpToolInputSchema('workflow_complete_node').required, ['output', 'summary']);
  assert.deepEqual(getMcpToolInputSchema('workflow_fail_node').required, ['reason']);
  assert.deepEqual(getMcpToolInputSchema('forger_workflow_get').required, ['workflowId']);
  assert.deepEqual(getMcpToolInputSchema('forger_workflow_upsert').required, ['name', 'trigger', 'nodes']);
  assert.deepEqual(getMcpToolInputSchema('slack.send_message').required, ['channelId', 'text']);
  assert.deepEqual(getMcpToolInputSchema('trello.create_card').required, ['listId', 'name']);
  assert.deepEqual(getMcpToolInputSchema('trello.update_card').required, ['cardId']);
  assert.deepEqual(getMcpToolInputSchema('trello.delete_card').required, ['cardId']);
  assert.deepEqual(getMcpToolInputSchema('trello.comment_card').required, ['cardId', 'text']);
  assert.deepEqual(getMcpToolInputSchema('trello.download_attachment').required, ['cardId', 'attachmentId']);
  assert.deepEqual(getMcpToolInputSchema('trello.upload_attachment').required, ['cardId', 'filePath']);
});
