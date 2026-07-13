import assert from 'node:assert/strict';

const { ForgerMcpServer } = await import('../dist-electron/main/forger-mcp-server.js');

const gmailReadConnectionAction = {
  id: 'gmail.read_thread',
  packageId: 'connection:gmail',
  name: 'Leer correo',
  description: 'Lee una conversacion o mensaje de Gmail e identifica adjuntos.',
  category: 'consulta',
  risk: 'alto',
  defaultRequiresApproval: true,
};

const createServer = (overrides = {}) => {
  const calls = {
    logs: [],
    permissionRequests: [],
    connectionCalls: [],
  };
  const server = new ForgerMcpServer({
    getAppVersion: () => 'test',
    getToolDefinitions: () => [],
    getConnectionToolDefinitions: async () => [gmailReadConnectionAction],
    getToolSettings: () => ({ approvals: { 'gmail.read_thread': true } }),
    appendInstallLog: async (event, payload) => {
      calls.logs.push({ event, payload });
    },
    requestPermission: async (runId, request) => {
      calls.permissionRequests.push({ runId, request });
      return true;
    },
    listCatalog: async () => [],
    listInstalledApps: () => [],
    checkUpdates: async () => [],
    getRuntimeStatus: () => ({ status: 'installed' }),
    openApp: async () => ({ success: true }),
    stopApp: async () => ({ success: true }),
    restartApp: async () => ({ success: true }),
    refreshAppView: async () => ({ success: true }),
    updateApp: async () => ({ success: true }),
    listAppPrompts: async () => [],
    updateAppPrompt: async () => ({ success: true }),
    restoreAppPrompt: async () => ({ success: true }),
    memoryList: async () => [],
    memoryCreate: async () => {
      throw new Error('not_used');
    },
    memoryUpdate: async () => {
      throw new Error('not_used');
    },
    memoryDelete: async () => ({ success: true }),
    listConnectionGrantsForApp: async () => [{
      type: 'gmail',
      actions: ['gmail.read_thread'],
      multiple: false,
      connectionIds: ['gmail-1'],
    }],
    callConnectionFromSession: async (input, grants, access) => {
      calls.connectionCalls.push({ input, grants, access });
      return { success: true, data: { threadId: input.input?.threadId ?? null } };
    },
    ...overrides,
  });
  return { server, calls };
};

const callTool = async (session, actionId = 'gmail.read_thread') => {
  const response = await fetch(session.url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${session.token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'test-call',
      method: 'tools/call',
      params: {
        name: actionId,
        arguments: { threadId: 'thread-1' },
      },
    }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.id, 'test-call');
  return JSON.parse(body.result.content[0].text);
};

{
  const { server, calls } = createServer();
  await server.start();
  try {
    const session = server.createSession('automation-run-1', 'forger', {
      caller: 'automation',
      appIds: ['finance-os'],
      connectionGrants: [{
        type: 'gmail',
        actions: ['gmail.read_thread'],
        multiple: false,
        connectionIds: ['gmail-1'],
      }],
    });
    assert.ok(session);

    const result = await callTool(session);
    assert.equal(result.success, true);
    assert.equal(calls.permissionRequests.length, 0);
    assert.equal(calls.connectionCalls.length, 1);
    assert.equal(calls.connectionCalls[0].access.caller, 'automation');
    assert.ok(calls.logs.some((entry) =>
      entry.event === 'agent_tool:approval_skipped' &&
      entry.payload?.reason === 'automation_non_interactive'
    ));
  } finally {
    server.stop();
  }
}

{
  const { server, calls } = createServer();
  await server.start();
  try {
    const session = server.createSession('app-run-1', 'finance-os', {
      caller: 'app-agent',
      appIds: ['finance-os'],
    });
    assert.ok(session);

    const result = await callTool(session);
    assert.equal(result.success, true);
    assert.equal(calls.permissionRequests.length, 1);
    assert.equal(calls.connectionCalls.length, 1);
    assert.equal(calls.connectionCalls[0].access.caller, 'app-agent');
  } finally {
    server.stop();
  }
}

{
  const { server, calls } = createServer();
  await server.start();
  try {
    const session = server.createSession('automation-run-2', 'forger', {
      caller: 'automation',
      appIds: ['finance-os'],
    });
    assert.ok(session);

    const result = await callTool(session);
    assert.equal(result.success, false);
    assert.equal(result.technicalCode, 'connection_action_not_granted');
    assert.equal(calls.permissionRequests.length, 0);
    assert.equal(calls.connectionCalls.length, 0);
  } finally {
    server.stop();
  }
}

console.log('automation approval policy tests passed');
