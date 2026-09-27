import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ForgerMcpServer } = require('../../dist-electron/main/forger-mcp-server.js');
const { parseWhatsAppChannelHistoryArgs } = require('../../dist-electron/main/forger-mcp/whatsapp-channel-history.js');

const channel = {
  kind: 'whatsapp',
  connectionId: 'connection-one',
  chatId: 'bound-chat',
  bindingId: 'binding-one',
  revision: 7,
  allowAgentCapabilities: false,
};

const createHarness = async (overrides = {}) => {
  const calls = [];
  const logs = [];
  const server = new ForgerMcpServer({
    getAppVersion: () => 'test',
    getToolDefinitions: () => [],
    getConnectionToolDefinitions: async () => [
      { id: 'whatsapp.read_messages', packageId: 'whatsapp', name: 'Read WhatsApp', description: 'Read messages', category: 'consulta', risk: 'bajo', defaultRequiresApproval: false },
      { id: 'whatsapp.send_message', packageId: 'whatsapp', name: 'Send WhatsApp', description: 'Send messages', category: 'actualizacion', risk: 'medio', defaultRequiresApproval: false },
      { id: 'slack.list_channels', packageId: 'slack', name: 'List Slack channels', description: 'List channels', category: 'consulta', risk: 'bajo', defaultRequiresApproval: false },
    ],
    getToolSettings: () => ({ approvals: {} }),
    appendInstallLog: async (event, payload) => { logs.push({ event, payload }); },
    requestPermission: () => null,
    listConnectionGrantsForApp: async () => [],
    readWhatsAppChannelHistory: async (input) => {
      calls.push(input);
      if (input.channel.revision !== 7 || input.runId !== 'active-run') {
        return { success: false, userMessage: 'Turn is no longer active.', technicalCode: 'whatsapp_channel_stale' };
      }
      return {
        success: true,
        messages: [{ id: 'message-one', authorId: 'sender-one', text: 'Hello', timestamp: '2026-09-25T12:00:00.000Z' }],
        nextBeforeMessageRef: 'older-page',
      };
    },
    ...overrides,
  });
  await server.start();
  return { server, calls, logs, stop: () => server.stop() };
};

const request = async (session, method, params) => {
  const response = await fetch(session.url, {
    method: 'POST',
    headers: { authorization: `Bearer ${session.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) }),
  });
  return await response.json();
};

const names = (result) => result.result.tools.map((tool) => tool.name);
const toolResult = (result) => JSON.parse(result.result.content[0].text);

test('WhatsApp channel context tool is only visible to its personal agent run', async () => {
  const harness = await createHarness();
  try {
    const access = { caller: 'personal-agent', personalAgentId: 'agent-one', personalAgentConversationId: 'conversation-one' };
    const channelSession = harness.server.createSession('active-run', 'forger', { ...access, whatsappChannel: channel });
    const normalSession = harness.server.createSession('normal-run', 'forger', access);
    const otherSession = harness.server.createSession('other-run', 'forger', { caller: 'workflow', whatsappChannel: channel });
    const channelList = await request(channelSession, 'tools/list');
    const tool = channelList.result.tools.find((item) => item.name === 'whatsapp_channel_history');
    assert.ok(tool);
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.equal(Object.hasOwn(tool.inputSchema.properties, 'chatId'), false);
    assert.equal(names(channelList).includes('whatsapp.read_messages'), false);
    assert.equal(names(channelList).includes('whatsapp.send_message'), false);
    assert.equal(names(await request(normalSession, 'tools/list')).includes('whatsapp_channel_history'), false);
    assert.equal(names(await request(otherSession, 'tools/list')).includes('whatsapp_channel_history'), false);
    const denied = await request(normalSession, 'tools/call', { name: 'whatsapp_channel_history', arguments: {} });
    assert.equal(toolResult(denied).technicalCode, 'whatsapp_channel_unavailable');
    assert.equal(harness.calls.length, 0);
  } finally {
    harness.stop();
  }
});

test('channel history is paged and bound by session, rejects arbitrary chat arguments, and never logs raw arguments', async () => {
  const harness = await createHarness();
  try {
    const session = harness.server.createSession('active-run', 'forger', {
      caller: 'personal-agent', personalAgentId: 'agent-one', personalAgentConversationId: 'conversation-one', whatsappChannel: channel,
    });
    const valid = await request(session, 'tools/call', {
      name: 'whatsapp_channel_history', arguments: { limit: 12, beforeMessageRef: 'cursor-one' },
    });
    assert.equal(toolResult(valid).success, true);
    assert.equal(toolResult(valid).nextBeforeMessageRef, 'older-page');
    assert.deepEqual(harness.calls[0], {
      channel, runId: 'active-run', agentId: 'agent-one', conversationId: 'conversation-one', limit: 12, beforeMessageRef: 'cursor-one',
    });
    const invalid = await request(session, 'tools/call', {
      name: 'whatsapp_channel_history', arguments: { chatId: 'another-chat', limit: 2 },
    });
    assert.equal(toolResult(invalid).technicalCode, 'whatsapp_channel_input_invalid');
    const excessive = await request(session, 'tools/call', {
      name: 'whatsapp_channel_history', arguments: { limit: 51 },
    });
    assert.equal(toolResult(excessive).technicalCode, 'whatsapp_channel_input_invalid');
    const emptyCursor = await request(session, 'tools/call', {
      name: 'whatsapp_channel_history', arguments: { beforeMessageRef: '' },
    });
    assert.equal(toolResult(emptyCursor).technicalCode, 'whatsapp_channel_input_invalid');
    assert.equal(harness.calls.length, 1);
    assert.equal(JSON.stringify(harness.logs).includes('another-chat'), false);
    assert.equal(JSON.stringify(harness.logs).includes('cursor-one'), false);
  } finally {
    harness.stop();
  }
});

test('history reader failures stay scoped and do not disclose backend exceptions', async () => {
  const harness = await createHarness({
    readWhatsAppChannelHistory: async () => { throw new Error('private backend detail'); },
  });
  try {
    const session = harness.server.createSession('active-run', 'forger', {
      caller: 'personal-agent', personalAgentId: 'agent-one', personalAgentConversationId: 'conversation-one', whatsappChannel: channel,
    });
    const result = await request(session, 'tools/call', { name: 'whatsapp_channel_history', arguments: {} });
    assert.equal(toolResult(result).technicalCode, 'whatsapp_channel_history_unavailable');
    assert.equal(JSON.stringify(result).includes('private backend detail'), false);
    assert.equal(JSON.stringify(harness.logs).includes('private backend detail'), false);
  } finally {
    harness.stop();
  }
});

test('stale or stopped channel runs cannot read; generic WhatsApp tools cannot be called through channel grants', async () => {
  const harness = await createHarness({
    callConnectionFromSession: async () => { throw new Error('generic_whatsapp_tool_must_not_run'); },
  });
  try {
    const grants = [{ type: 'whatsapp', connectionId: 'connection-one', actions: ['whatsapp.read_messages', 'whatsapp.send_message'] }];
    const access = { caller: 'personal-agent', personalAgentId: 'agent-one', personalAgentConversationId: 'conversation-one', whatsappChannel: channel, connectionGrants: grants };
    const session = harness.server.createSession('stale-run', 'forger', access);
    const list = await request(session, 'tools/list');
    assert.equal(names(list).includes('whatsapp.read_messages'), false);
    assert.equal(names(list).includes('whatsapp.send_message'), false);
    const stale = await request(session, 'tools/call', { name: 'whatsapp_channel_history', arguments: { limit: 10 } });
    assert.equal(toolResult(stale).technicalCode, 'whatsapp_channel_stale');
    const arbitrary = await request(session, 'tools/call', {
      name: 'whatsapp.read_messages', arguments: { chatId: 'unbound-chat' },
    });
    assert.equal(toolResult(arbitrary).technicalCode, 'whatsapp_channel_action_not_granted');
    assert.equal(JSON.stringify(harness.logs).includes('unbound-chat'), false);
  } finally {
    harness.stop();
  }
});

test('restricted chat cannot discover or call another configured connection', async () => {
  const harness = await createHarness({
    callConnectionFromSession: async () => { throw new Error('restricted_connection_must_not_run'); },
  });
  try {
    const session = harness.server.createSession('active-run', 'forger', {
      caller: 'personal-agent', personalAgentId: 'agent-one', personalAgentConversationId: 'conversation-one',
      whatsappChannel: channel,
      connectionGrants: [{ type: 'slack', connectionId: 'slack-one', actions: ['slack.list_channels'] }],
    });
    assert.equal(names(await request(session, 'tools/list')).includes('slack.list_channels'), false);
    const result = await request(session, 'tools/call', {
      name: 'slack.list_channels', arguments: {},
    });
    assert.equal(toolResult(result).technicalCode, 'whatsapp_channel_capability_not_granted');
  } finally {
    harness.stop();
  }
});

test('channel grants expose only the specifically allowed WhatsApp action', async () => {
  const harness = await createHarness({ getWhatsAppChannelAgent: async () => ({ appIds: [], toolIds: [], peerAgentGrants: [], connectionGrants: [{ type: 'whatsapp', connectionId: 'connection-one', actions: ['whatsapp.read_messages'] }] }) });
  try {
    const session = harness.server.createSession('active-run', 'forger', {
      caller: 'personal-agent', personalAgentId: 'agent-one', personalAgentConversationId: 'conversation-one',
      whatsappChannel: { ...channel, allowAgentCapabilities: true },
      whatsappChannelAllowedConnectionActionIds: ['whatsapp.read_messages'],
      connectionGrants: [{ type: 'whatsapp', connectionId: 'connection-one', actions: ['whatsapp.read_messages', 'whatsapp.send_message'] }],
    });
    const visible = names(await request(session, 'tools/list'));
    assert.equal(visible.includes('whatsapp.read_messages'), true);
    assert.equal(visible.includes('whatsapp.send_message'), false);
  } finally {
    harness.stop();
  }
});

test('history argument parser rejects non-object values and uses the default page size', () => {
  assert.equal(parseWhatsAppChannelHistoryArgs(null), null);
  assert.equal(parseWhatsAppChannelHistoryArgs([]), null);
  assert.equal(parseWhatsAppChannelHistoryArgs('other-chat'), null);
  assert.deepEqual(parseWhatsAppChannelHistoryArgs(undefined), { limit: 20 });
});

test('explicit live grants work without the legacy broad switch and are rechecked after approval', async () => {
  let authorized = true;
  let calls = 0;
  let requireApproval = false;
  const current = { appIds: [], toolIds: [], peerAgentGrants: [], connectionGrants: [{ type: 'slack', connectionIds: ['slack-one'], multiple: false, actions: ['slack.list_channels'] }] };
  const harness = await createHarness({
    getWhatsAppChannelAgent: async () => authorized ? current : null,
    getToolSettings: () => ({ approvals: { 'slack.list_channels': requireApproval } }),
    requestPermission: async () => { authorized = false; return true; },
    callConnectionFromSession: async () => { calls++; return { success: true }; },
  });
  try {
    const session = harness.server.createSession('active-run', 'forger', { caller: 'personal-agent', personalAgentId: 'agent', personalAgentConversationId: 'conv', whatsappChannel: channel });
    assert.equal(toolResult(await request(session, 'tools/call', { name: 'slack.list_channels', arguments: {} })).success, true);
    requireApproval = true;
    const revoked = toolResult(await request(session, 'tools/call', { name: 'slack.list_channels', arguments: {} }));
    assert.equal(revoked.technicalCode, 'whatsapp_channel_capability_not_granted');
    assert.equal(calls, 1);
    assert.equal(names(await request(session, 'tools/list')).includes('slack.list_channels'), false);
  } finally { harness.stop(); }
});

test('channel peer tools expose only selected peers and threads originating in this chat', async () => {
  const own = { id: 'own', sourceConversationId: 'conv', targetAgentId: 'allowed' };
  const privateThread = { id: 'private', sourceConversationId: 'private-conv', targetAgentId: 'allowed' };
  const other = { id: 'other', sourceConversationId: 'conv', targetAgentId: 'unselected' };
  const asked = [];
  let includeRecent = true;
  const harness = await createHarness({
    getWhatsAppChannelAgent: async () => ({ appIds: [], toolIds: [], connectionGrants: [], peerAgentGrants: [{ agentId: 'allowed' }] }),
    listAgentPeers: async () => ({ success: true, peers: [{ agentId: 'allowed' }, { agentId: 'unselected' }], ...(includeRecent ? { recentThreads: [own, privateThread, other] } : {}) }),
    readAgentThread: async ({ threadId }) => ({ success: true, thread: [own, privateThread, other].find(thread => thread.id === threadId) }),
    askAgent: async input => { asked.push(input); return { success: true }; },
  });
  try {
    const session = harness.server.createSession('active-run', 'forger', { caller: 'personal-agent', personalAgentId: 'agent', personalAgentConversationId: 'conv', whatsappChannel: { ...channel, allowAgentCapabilities: true } });
    const call = async (name, args) => toolResult(await request(session, 'tools/call', { name, arguments: args }));
    const peers = await call('forger_list_agent_peers', {});
    assert.deepEqual(peers.peers, [{ agentId: 'allowed' }]);
    assert.deepEqual(peers.recentThreads, [own]);
    includeRecent = false;
    assert.equal((await call('forger_list_agent_peers', {})).recentThreads, undefined);
    for (const id of ['private', 'other', 'missing']) {
      assert.equal((await call('forger_read_agent_thread', { threadId: id })).technicalCode, 'whatsapp_channel_thread_not_granted');
      assert.equal((await call('forger_ask_agent', { targetAgentId: 'allowed', threadId: id, message: 'hello' })).technicalCode, 'whatsapp_channel_thread_not_granted');
      assert.equal((await call('forger_ask_agent', { threadId: id, message: 'hello' })).technicalCode, 'whatsapp_channel_thread_not_granted');
    }
    assert.deepEqual((await call('forger_read_agent_thread', { threadId: 'own' })).thread, own);
    assert.equal((await call('forger_ask_agent', { targetAgentId: 'allowed', threadId: 'own', message: 'hello' })).success, true);
    assert.equal(asked.length, 1);
    assert.equal((await call('forger_ask_agent', { threadId: 'own', message: 'continue our task' })).success, true);
    assert.equal(asked.length, 2);
    assert.equal((await call('forger_ask_agent', { targetAgentId: 'unselected', message: 'hello' })).success, false);
  } finally { harness.stop(); }
});

test('host channel workspace file tools appear in MCP and reject stale access', async () => {
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-files-'));
  let granted = true;
  const harness = await createHarness({ getWhatsAppChannelAgent: async () => granted ? { appIds: [], toolIds: [], connectionGrants: [], peerAgentGrants: [] } : null });
  try {
    const session = harness.server.createSession('active-run', 'forger', { caller: 'personal-agent', personalAgentId: 'agent', personalAgentConversationId: 'conv', whatsappChannel: channel, whatsappChannelWorkspaceRoot: root });
    assert.ok(names(await request(session, 'tools/list')).includes('whatsapp_channel_files_list'));
    assert.deepEqual(toolResult(await request(session, 'tools/call', { name: 'whatsapp_channel_files_list' })), { success: true, files: [] });
    granted = false;
    assert.equal(toolResult(await request(session, 'tools/call', { name: 'whatsapp_channel_files_list', arguments: {} })).success, false);
  } finally { harness.stop(); await fs.rm(root, { recursive: true, force: true }); }
});
