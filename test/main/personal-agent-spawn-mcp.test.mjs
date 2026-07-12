import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ForgerMcpServer } = require('../../dist-electron/main/forger-mcp-server.js');

const createHarness = async (options = {}) => {
  const server = new ForgerMcpServer({
    getAppVersion: () => '0.1.test',
    getToolDefinitions: () => [],
    getToolSettings: () => ({ approvals: {} }),
    appendInstallLog: async () => undefined,
    requestPermission: () => null,
    listCatalog: async () => [],
    listInstalledApps: () => [],
    checkUpdates: async () => [],
    createLocalApp: async () => ({ success: false, userMessage: 'Unavailable.' }),
    getRuntimeStatus: () => ({ status: 'stopped' }),
    openApp: async (appId) => ({ success: true, appId }),
    stopApp: async (appId) => ({ success: true, appId }),
    restartApp: async (appId) => ({ success: true, appId }),
    refreshAppView: async () => ({ success: true }),
    updateApp: async (appId) => ({ success: true, appId }),
    listAppPrompts: async () => [],
    testAppPrompt: async () => ({ success: true, valid: true, errors: [] }),
    updateAppPrompt: async () => ({ success: true }),
    restoreAppPrompt: async () => ({ success: true }),
    memoryList: async () => [],
    memoryCreate: async (input) => input,
    memoryUpdate: async (input) => input,
    memoryDelete: async () => ({ success: true }),
    listOfficialToolActionIdsForApp: async () => new Set(),
    validateOfficialTool: async () => null,
    callOfficialTool: async () => ({ success: true }),
    listConnectionGrantsForApp: async () => [],
    ...options,
  });
  await server.start();
  return { server, stop: () => server.stop() };
};

const callMcp = async (session, body) => await fetch(session.url, {
  method: 'POST',
  headers: {
    authorization: `Bearer ${session.token}`,
    'content-type': 'application/json',
  },
  body: JSON.stringify(body),
});

const parseToolResult = (payload) => JSON.parse(payload.result.content[0].text);

test('forger_create_personal_agent stays hidden and denied when the current agent lacks spawn permission', async () => {
  let createCalls = 0;
  const harness = await createHarness({
    createPersonalAgentFromAgent: async () => {
      createCalls += 1;
      throw new Error('must_not_run');
    },
  });
  try {
    const session = harness.server.createSession('run-no-spawn', 'forger', {
      caller: 'personal-agent',
      personalAgentId: 'creator-agent',
      personalAgentConversationId: 'creator-conversation',
      personalAgentCanSpawnAgents: false,
    });

    const listed = await (await callMcp(session, {
      jsonrpc: '2.0', id: 1, method: 'tools/list',
    })).json();
    assert.equal(listed.result.tools.some((tool) => tool.name === 'forger_create_personal_agent'), false);

    const deniedPayload = await (await callMcp(session, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'forger_create_personal_agent', arguments: { name: 'Forbidden child' } },
    })).json();
    const denied = parseToolResult(deniedPayload);
    assert.equal(denied.success, false);
    assert.equal(denied.technicalCode, 'personal_agent_spawn_permission_required');
    assert.equal(deniedPayload.result.isError, true);
    assert.equal(createCalls, 0);
  } finally {
    await harness.stop();
  }
});

test('forger_create_personal_agent is listed only for enabled creators and exposes a bounded name-first input schema', async () => {
  const harness = await createHarness();
  try {
    const session = harness.server.createSession('run-can-spawn', 'forger', {
      caller: 'personal-agent',
      personalAgentId: 'creator-agent',
      personalAgentConversationId: 'creator-conversation',
      personalAgentCanSpawnAgents: true,
    });
    const listed = await (await callMcp(session, {
      jsonrpc: '2.0', id: 1, method: 'tools/list',
    })).json();
    const tool = listed.result.tools.find((item) => item.name === 'forger_create_personal_agent');

    assert.ok(tool);
    assert.equal(tool.inputSchema.type, 'object');
    assert.deepEqual(tool.inputSchema.required, ['name']);
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.equal(tool.inputSchema.properties.name.type, 'string');
    assert.ok(tool.inputSchema.properties.name.maxLength <= 120);
    assert.equal(tool.inputSchema.properties.groupId.type, 'string');
  } finally {
    await harness.stop();
  }
});

test('an enabled personal-agent session can spawn a child and provenance is supplied by trusted session context', async () => {
  const calls = [];
  const child = {
    id: 'child-agent',
    name: 'Budget reviewer',
    description: 'Checks launch costs.',
    purpose: 'Review launch budgets.',
    instructions: '',
    permissionMode: 'safe',
    networkAccess: false,
    canSpawnAgents: false,
    appIds: [],
    toolIds: [],
    connectionGrants: [],
    peerAgentGrants: [],
    createdByAgentId: 'creator-agent',
    groupId: 'inherited-group',
    createdAt: '2026-07-12T00:00:00.000Z',
    updatedAt: '2026-07-12T00:00:00.000Z',
  };
  const harness = await createHarness({
    createPersonalAgentFromAgent: async (input) => {
      calls.push(input);
      return child;
    },
  });
  try {
    const session = harness.server.createSession('run-can-spawn-call', 'forger', {
      caller: 'personal-agent',
      personalAgentId: 'creator-agent',
      personalAgentConversationId: 'creator-conversation',
      personalAgentCanSpawnAgents: true,
      locale: 'en',
    });

    const invalidPayload = await (await callMcp(session, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'forger_create_personal_agent', arguments: { purpose: 'Missing a name.' } },
    })).json();
    const invalid = parseToolResult(invalidPayload);
    assert.equal(invalid.success, false);
    assert.equal(invalid.technicalCode, 'personal_agent_name_required');
    assert.equal(calls.length, 0);

    const createdPayload = await (await callMcp(session, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'forger_create_personal_agent',
        arguments: {
          name: 'Budget reviewer',
          description: 'Checks launch costs.',
          purpose: 'Review launch budgets.',
        },
      },
    })).json();
    const created = parseToolResult(createdPayload);

    assert.deepEqual(calls, [{
      creatorAgentId: 'creator-agent',
      name: 'Budget reviewer',
      description: 'Checks launch costs.',
      purpose: 'Review launch budgets.',
    }]);
    assert.equal(created.success, true);
    assert.equal(created.agent.id, child.id);
    assert.equal(created.agent.createdByAgentId, 'creator-agent');
    assert.equal(created.agent.groupId, 'inherited-group');
    assert.equal(createdPayload.result.isError, false);
  } finally {
    await harness.stop();
  }
});
