import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { AgentStore } = require('../../dist-electron/main/personal-agents/agent-store.js');
const { AgentConversationManager } = require('../../dist-electron/main/personal-agents/agent-conversation-manager.js');
const { WhatsAppAgentChannelService } = require('../../dist-electron/main/personal-agents/whatsapp-channel-service.js');

const waitFor = async (check) => {
  for (let index = 0; index < 100; index += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('Timed out waiting for WhatsApp agent delivery');
};

test('live wake runs an existing agent in an isolated channel workspace and delivers once to the bound chat', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'forger-whatsapp-channel-service-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const agentStore = new AgentStore({ metadataRoot: root, forgerHomeRoot: root });
  const agent = await agentStore.createAgent({ name: 'Casa agent' });
  const seen = { runs: [], sends: [] };
  const manager = new AgentConversationManager({
    store: agentStore,
    runner: async ({ workspaceRoot, mcpContext, prompt }) => {
      seen.runs.push({ workspaceRoot, channel: mcpContext.channel, prompt });
      return { assistantText: 'Ya quedó revisado.' };
    },
  });
  const connection = {
    listInstances: async () => [
      { id: 'connection-1', accountIdentity: { phoneNumber: '56911111111' } },
      { id: 'connection-2', accountIdentity: { phoneNumber: '56922222222' } },
    ],
    call: async (input) => {
      if (input.actionId === 'whatsapp.get_chat_details') return { success: true, data: { chatId: 'group-1' } };
      if (input.actionId === 'whatsapp.read_messages') return { success: true, data: { messages: [] } };
      if (input.actionId === 'whatsapp.send_message') {
        seen.sends.push(input);
        return { success: true, data: { sent: true, stableMessageRef: `sent-${seen.sends.length}` } };
      }
      throw new Error(`Unexpected connection action: ${input.actionId}`);
    },
  };
  const service = new WhatsAppAgentChannelService({
    metadataRoot: root,
    getConnectionsService: () => connection,
    getAgentStore: () => agentStore,
    getConversationManager: () => manager,
  });
  await service.initialize();
  t.after(() => service.close());
  await service.putBinding({
    connectionId: 'connection-1', chatId: 'group-1', agentId: agent.id,
    alias: 'Casa', enabled: true, purpose: 'Revisar Hay Casa', scope: 'Solo este proyecto',
    participantsAllowed: [],
  });
  const inbound = {
    connectionId: 'connection-1',
    message: {
      chatId: 'group-1', chatType: 'group', senderId: '56911111111', fromMe: true,
      text: 'Casa: revisa la publicación', hasAttachments: false, attachments: [],
      stableMessageRef: { chatId: 'group-1', id: 'live-1', fromMe: true },
    },
  };
  await service.handleLiveMessage(inbound);
  await waitFor(() => seen.sends.length === 1);
  await service.handleLiveMessage(inbound);
  assert.equal(seen.runs.length, 1);
  assert.equal(seen.sends.length, 1);
  assert.equal(seen.sends[0].input.chatId, 'group-1');
  assert.equal(seen.sends[0].input.text, 'Ya quedó revisado.');
  assert.notEqual(seen.runs[0].workspaceRoot, await agentStore.workspaceRootForAgent(agent.id));
  assert.equal(seen.runs[0].channel.chatId, 'group-1');
  assert.match(seen.runs[0].prompt, /revisa la publicación/);
  assert.match(seen.runs[0].prompt, /sin acceso a los archivos privados del agente/);
  assert.deepEqual(service.listUnsettledMessages(), []);
});

test('channel carries explicit policy and alias updates are explicit across affected chats', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'forger-whatsapp-channel-alias-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const agentStore = new AgentStore({ metadataRoot: root, forgerHomeRoot: root });
  const agent = await agentStore.createAgent({ name: 'Casa agent' });
  const runs = [];
  const canceled = [];
  const conversations = new Map();
  const manager = {
    onConversationEvent: () => () => {},
    createWhatsAppConversation: async ({ agentId }) => {
      const conversation = { id: `conversation-${conversations.size + 1}`, agentId };
      conversations.set(conversation.id, conversation);
      return conversation;
    },
    getConversation: async (id) => conversations.get(id) ?? null,
    sendWhatsAppMessage: async (input) => {
      const id = input.runId;
      runs.push({ id, channel: input.channel });
      return { activeRun: { id } };
    },
    cancelRun: async (id) => { canceled.push(id); return true; },
  };
  const connection = {
    listInstances: async () => [{ id: 'connection-1', accountIdentity: { phoneNumber: '56911111111' } }],
    call: async (input) => {
      if (input.actionId === 'whatsapp.get_chat_details') return { success: true, data: { chatId: input.input.chatId } };
      if (input.actionId === 'whatsapp.read_messages') return { success: true, data: { messages: [] } };
      throw new Error(`Unexpected connection action: ${input.actionId}`);
    },
  };
  const service = new WhatsAppAgentChannelService({
    metadataRoot: root,
    getConnectionsService: () => connection,
    getAgentStore: () => agentStore,
    getConversationManager: () => manager,
  });
  await service.initialize();
  t.after(() => service.close());
  const base = {
    connectionId: 'connection-1', agentId: agent.id, alias: 'Casa', enabled: true,
    purpose: 'Revisar Hay Casa', scope: 'Solo este proyecto', participantsAllowed: [],
    allowAgentCapabilities: true,
  };
  const first = await service.putBinding({ ...base, chatId: 'group-1' });
  await service.putBinding({ ...base, chatId: 'group-2', allowAgentCapabilities: false });
  for (const [index, chatId] of ['group-1', 'group-2'].entries()) {
    await service.handleLiveMessage({
      connectionId: 'connection-1',
      message: {
        chatId, chatType: 'group', fromMe: true, text: 'Casa: revisar',
        hasAttachments: false, attachments: [],
        stableMessageRef: { chatId, id: `live-${index}`, fromMe: true },
      },
    });
  }
  assert.deepEqual(runs.map((run) => run.channel.allowAgentCapabilities), [true, false]);
  await assert.rejects(service.putBinding({ ...base, chatId: 'group-1', alias: 'Nuevo Casa', expectedRevision: service.getBinding(first).revision }), /alias_requires_explicit_update/);
  await service.updateAlias(base.connectionId, agent.id, 'Nuevo Casa');
  assert.deepEqual(canceled, []);
  assert.equal(service.listBindings(agent.id).every(binding => binding.alias === 'Nuevo Casa'), true);
  assert.ok(service.getBinding({ connectionId: 'connection-1', chatId: 'group-2', agentId: agent.id }).activeTurnId);
});
