import assert from 'node:assert/strict';
import test from 'node:test';
import { registerWhatsAppAgentChannelIpcHandlers } from '../../dist-electron/main/ipc/whatsapp-agent-channel-handlers.js';
import { createTrustedIpcMain } from '../../dist-electron/main/ipc/trusted-ipc.js';
import { IPC_CHANNELS } from '../../dist-electron/shared/ipc.js';

const setup = (wrapIpcMain = (ipcMain) => ipcMain) => {
  const handlers = new Map();
  const calls = [];
  const service = {
    listBindings: (agentId) => { calls.push(['list', agentId]); return []; },
    getBinding: (key) => { calls.push(['get', key]); return null; },
    putBinding: async (input) => { calls.push(['put', input]); return input; },
    deleteBinding: async (key) => { calls.push(['delete', key]); return true; },
    listUnsettledMessages: (connectionId) => { calls.push(['unsettled', connectionId]); return []; },
    getLatestDelivery: (key) => { calls.push(['delivery', key]); return null; },
  };
  registerWhatsAppAgentChannelIpcHandlers({
    IPC_CHANNELS,
    ipcMain: wrapIpcMain({ handle: (channel, handler) => handlers.set(channel, handler) }),
    getWhatsAppAgentChannelService: () => service,
  });
  return { handlers, calls };
};

test('WhatsApp binding IPC keeps owner identity under host control', async () => {
  const { handlers, calls } = setup();
  const put = handlers.get(IPC_CHANNELS.personalAgentWhatsAppBindingPut);
  await put(null, {
    connectionId: 'wa-1', chatId: 'chat-1', agentId: 'agent-1',
    alias: ' Casa ', purpose: ' Assist in this chat ', scope: '', enabled: true, allowAgentCapabilities: false,
    participantsAllowed: ['member-1', 'member-1'], ownerId: 'spoofed-owner',
    conversationId: 'spoofed-conversation', revision: 500,
  });
  assert.deepEqual(calls[0], ['put', {
    connectionId: 'wa-1', chatId: 'chat-1', agentId: 'agent-1',
    alias: 'Casa', purpose: 'Assist in this chat', scope: '', enabled: true, allowAgentCapabilities: false,
    participantsAllowed: ['member-1'],
  }]);
});

test('WhatsApp binding IPC rejects invalid or purposeless enabled bindings', async () => {
  const { handlers, calls } = setup();
  const put = handlers.get(IPC_CHANNELS.personalAgentWhatsAppBindingPut);
  await assert.rejects(() => put(null, {
    connectionId: 'wa-1', chatId: 'chat-1', agentId: 'agent-1',
    alias: 'Casa', purpose: '', scope: '', enabled: true, allowAgentCapabilities: false, participantsAllowed: [],
  }), /whatsapp_agent_purpose_required/);
  await assert.rejects(() => put(null, {
    connectionId: 'wa-1', chatId: 'chat-1', agentId: 'agent-1',
    alias: 'Casa', purpose: 'Help', scope: '', enabled: true, allowAgentCapabilities: false, participantsAllowed: 'everyone',
  }), /whatsapp_agent_invalid_input/);
  await assert.rejects(() => put(null, {
    connectionId: 'wa-1', chatId: 'chat-1', agentId: 'agent-1',
    alias: 'Casa', purpose: 'Help', scope: '', enabled: true, allowAgentCapabilities: false, participantsAllowed: [], expectedRevision: -1,
  }), /whatsapp_agent_invalid_input/);
  assert.deepEqual(calls, []);
});

test('WhatsApp binding IPC forwards a validated revision for optimistic concurrency', async () => {
  const { handlers, calls } = setup();
  await handlers.get(IPC_CHANNELS.personalAgentWhatsAppBindingPut)(null, {
    connectionId: 'wa-1', chatId: 'chat-1', agentId: 'agent-1',
    alias: 'Casa', purpose: 'Help', scope: '', enabled: true, allowAgentCapabilities: false, participantsAllowed: [], expectedRevision: 4,
  });
  assert.equal(calls[0][1].expectedRevision, 4);
});

test('WhatsApp binding IPC filters reads by agent and exposes unsettled status', () => {
  const { handlers, calls } = setup();
  handlers.get(IPC_CHANNELS.personalAgentWhatsAppBindingsList)(null, { agentId: 'agent-1' });
  handlers.get(IPC_CHANNELS.personalAgentWhatsAppUnsettledList)(null, { agentId: 'agent-1', connectionId: 'wa-1' });
  handlers.get(IPC_CHANNELS.personalAgentWhatsAppUnsettledList)(null, { agentId: 'agent-1' });
  handlers.get(IPC_CHANNELS.personalAgentWhatsAppLatestDeliveryGet)(null, { connectionId: 'wa-1', chatId: 'chat-1', agentId: 'agent-1' });
  assert.deepEqual(calls, [['list', 'agent-1'], ['unsettled', 'wa-1'], ['unsettled', undefined], ['delivery', { connectionId: 'wa-1', chatId: 'chat-1', agentId: 'agent-1' }]]);
});

test('WhatsApp binding IPC rejects malformed keys and policy fields before reaching the service', async () => {
  const { handlers, calls } = setup();
  const put = handlers.get(IPC_CHANNELS.personalAgentWhatsAppBindingPut);
  const base = {
    connectionId: 'wa-1', chatId: 'chat-1', agentId: 'agent-1', alias: 'Casa',
    purpose: 'Help with houses', scope: '', enabled: true,
    allowAgentCapabilities: false, participantsAllowed: [],
  };
  for (const input of [null, {}, { ...base, chatId: ' ' }, { ...base, agentId: 'x'.repeat(129) }]) {
    await assert.rejects(() => put(null, input), /whatsapp_agent_invalid_input/);
  }
  for (const input of [
    { ...base, participantsAllowed: Array(65).fill('member') },
    { ...base, participantsAllowed: [' '] },
    { ...base, alias: 'Casa\nspoofed' },
    { ...base, scope: 42 },
    { ...base, purpose: 'x'.repeat(4001) },
  ]) {
    await assert.rejects(() => put(null, input), /whatsapp_agent_invalid_input/);
  }
  const list = handlers.get(IPC_CHANNELS.personalAgentWhatsAppBindingsList);
  const unsettled = handlers.get(IPC_CHANNELS.personalAgentWhatsAppUnsettledList);
  assert.throws(() => list(null, null), /whatsapp_agent_invalid_input/);
  assert.throws(() => unsettled(null, null), /whatsapp_agent_invalid_input/);
  assert.throws(() => unsettled(null, { agentId: 'agent-1', connectionId: '' }), /whatsapp_agent_invalid_input/);
  assert.throws(() => handlers.get(IPC_CHANNELS.personalAgentWhatsAppBindingGet)(null, null), /whatsapp_agent_invalid_input/);
  assert.deepEqual(calls, []);

  await put(null, { ...base, enabled: false, purpose: null, scope: null });
  assert.equal(calls[0][1].purpose, '');
  assert.equal(calls[0][1].scope, '');
});

test('WhatsApp binding IPC rejects foreign windows and child frames before reaching policy state', async () => {
  const mainFrame = { routingId: 1 };
  const sender = { mainFrame, isDestroyed: () => false };
  const mainWindow = { webContents: sender, isDestroyed: () => false };
  const { handlers, calls } = setup((ipcMain) => createTrustedIpcMain({
    ipcMain,
    getMainWindow: () => mainWindow,
  }));
  const binding = {
    connectionId: 'wa-1', chatId: 'chat-1', agentId: 'agent-1', alias: 'Casa',
    purpose: 'Help with houses', scope: '', enabled: true,
    allowAgentCapabilities: false, participantsAllowed: [],
  };
  const key = { connectionId: binding.connectionId, chatId: binding.chatId, agentId: binding.agentId };
  const cases = [
    [IPC_CHANNELS.personalAgentWhatsAppBindingsList, { agentId: binding.agentId }],
    [IPC_CHANNELS.personalAgentWhatsAppBindingGet, key],
    [IPC_CHANNELS.personalAgentWhatsAppBindingPut, binding],
    [IPC_CHANNELS.personalAgentWhatsAppBindingDelete, key],
    [IPC_CHANNELS.personalAgentWhatsAppUnsettledList, { agentId: binding.agentId }],
    [IPC_CHANNELS.personalAgentWhatsAppLatestDeliveryGet, key],
  ];
  for (const [channel, input] of cases) {
    const invoke = handlers.get(channel);
    await assert.rejects(invoke({ sender: {}, senderFrame: mainFrame }, input), /ipc_sender_not_authorized/);
    await assert.rejects(invoke({ sender, senderFrame: { routingId: 2 } }, input), /ipc_sender_not_authorized/);
  }
  assert.deepEqual(calls, []);
  await handlers.get(IPC_CHANNELS.personalAgentWhatsAppBindingPut)({ sender, senderFrame: mainFrame }, binding);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'put');
});
