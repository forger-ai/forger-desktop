import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { AgentStore } = require('../../dist-electron/main/personal-agents/agent-store.js');
const { WhatsAppAgentChannelService } = require('../../dist-electron/main/personal-agents/whatsapp-channel-service.js');

const fixture = async (t, options = {}) => {
  const root = await mkdtemp(path.join(tmpdir(), 'forger-whatsapp-service-edge-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const agentStore = new AgentStore({ metadataRoot: root, forgerHomeRoot: root });
  const agent = await agentStore.createAgent({ name: 'Casa agent' });
  const conversations = new Map();
  const starts = [];
  const steers = [];
  const sends = [];
  const cancels = [];
  const calls = [];
  const logs = [];
  let listener = null;
  let history = async () => ({ success: true, data: { messages: [] } });
  let delivery = async () => ({ success: true, data: { sent: true, stableMessageRef: 'reply-1' } });
  const manager = {
    onConversationEvent: (callback) => { listener = callback; return () => { listener = null; }; },
    createWhatsAppConversation: async ({ agentId }) => {
      const conversation = { id: `conversation-${conversations.size + 1}`, agentId, messages: [] };
      conversations.set(conversation.id, conversation);
      return conversation;
    },
    reconcileWhatsAppConversation: async () => {},
    getConversation: async (id) => conversations.get(id) ?? null,
    sendWhatsAppMessage: async (input) => {
      const runId = input.runId ?? `steer-${steers.length + 1}`;
      starts.push({ ...input, runId });
      options.onStart?.({ runId, number: starts.length, emit: (event) => listener?.(event) });
      return { activeRun: { id: runId } };
    },
    steerMessage: async (input) => {
      const runId = input.runId ?? `steer-${steers.length + 1}`;
      steers.push({ ...input, runId });
      return { activeRun: { id: runId } };
    },
    cancelRun: async (runId) => { cancels.push(runId); return true; },
  };
  const connection = {
    listInstances: async () => [{ id: 'connection-1', accountIdentity: { phoneNumber: '56911111111' } }],
    call: async (input) => {
      calls.push(input);
      if (input.actionId === 'whatsapp.get_chat_details') return { success: true, data: { chatId: input.input.chatId } };
      if (input.actionId === 'whatsapp.read_messages') return await history(input);
      if (input.actionId === 'whatsapp.send_message') { sends.push(input); return await delivery(input); }
      throw new Error(`Unexpected connection action: ${input.actionId}`);
    },
  };
  const service = new WhatsAppAgentChannelService({
    metadataRoot: root,
    getConnectionsService: () => connection,
    getAgentStore: () => agentStore,
    getConversationManager: () => manager,
    appendLog: async (event, payload) => { logs.push({ event, payload }); },
  });
  await service.initialize();
  t.after(() => service.close());
  const baseBinding = {
    connectionId: 'connection-1', chatId: 'group-1', agentId: agent.id,
    alias: 'Casa', enabled: true, purpose: 'Ayudar con Hay Casa', scope: 'Solo este proyecto',
    participantsAllowed: ['participant'],
  };
  const key = { connectionId: baseBinding.connectionId, chatId: baseBinding.chatId, agentId: agent.id };
  const inbound = (id, text = 'Casa: revisar', overrides = {}) => ({
    connectionId: 'connection-1',
    message: {
      chatId: 'group-1', chatType: 'group', senderId: '56911111111', fromMe: true,
      text, hasAttachments: false, attachments: [],
      stableMessageRef: { chatId: 'group-1', id, fromMe: true },
      ...overrides,
    },
  });
  return {
    root, agent, agentStore, service, connection, manager, key, baseBinding, inbound,
    starts, steers, sends, cancels, calls, logs,
    setHistory: (handler) => { history = handler; },
    setDelivery: (handler) => { delivery = handler; },
    emit: (event) => listener?.(event),
    captureListener: () => listener,
  };
};

const grant = ids => ({ type: 'whatsapp', actions: ['whatsapp.download_attachment'], multiple: false, ...(ids ? { connectionIds: ids } : {}) });
const policy = grants => ({ appIds: [], toolIds: [], connectionGrants: grants, peerAgentIds: [], sharedMemoryIds: [], sharedFiles: [], networkAccess: false });
const setup = async t => {
  const f = await fixture(t);
  await f.agentStore.updateAgentPermissions({ agentId: f.agent.id, connectionGrants: [grant(['connection-1'])] });
  const saved = await f.service.putBinding({ ...f.baseBinding, policy: policy([grant(['connection-1'])]) });
  await f.service.handleLiveMessage(f.inbound('current-caption'));
  const start = f.starts[0];
  f.query = { channel: start.channel, runId: start.runId, agentId: f.agent.id, conversationId: saved.conversationId };
  f.imageCalls = [];
  f.connection.readWhatsAppCurrentImages = async (...args) => { f.imageCalls.push(args); return { success: true, images: [{ data: 'synthetic', mimeType: 'image/png' }] }; };
  return f;
};

test('photo caption metadata follows the durable current message without downloading images', async t => {
  const f = await fixture(t);
  await f.service.putBinding(f.baseBinding);
  const metadataCalls = [];
  f.connection.hasWhatsAppCurrentImage = async (...args) => { metadataCalls.push(args); return true; };
  f.connection.readWhatsAppCurrentImages = async () => { throw new Error('Admission must not download image bytes'); };
  await f.service.handleLiveMessage(f.inbound('caption-photo', '@casa qué opinas?'));
  assert.equal(f.starts.length, 1);
  assert.equal(f.starts[0].channel.currentMessageHasImage, true);
  assert.equal(metadataCalls.length, 1);
  assert.deepEqual(metadataCalls[0].slice(0, 2), ['connection-1', 'group-1']);
  assert.equal(JSON.parse(Buffer.from(metadataCalls[0][2], 'base64url').toString()).id, 'caption-photo');
});

test('plain text and unavailable photo metadata do not claim an image is attached', async t => {
  for (const reader of [async () => false, async () => { throw new Error('unavailable'); }]) {
    const f = await fixture(t);
    await f.service.putBinding(f.baseBinding);
    f.connection.hasWhatsAppCurrentImage = reader;
    await f.service.handleLiveMessage(f.inbound('plain', '@casa qué opinas?'));
    assert.equal(f.starts.length, 1);
    assert.equal(f.starts[0].channel.currentMessageHasImage, false);
  }
});

test('a queued caption loads photo metadata from its own durable message when admitted', async t => {
  const f = await fixture(t);
  await f.service.putBinding(f.baseBinding);
  const checked = [];
  f.connection.hasWhatsAppCurrentImage = async (_account, _chat, ref) => {
    const id = JSON.parse(Buffer.from(ref, 'base64url').toString()).id;
    checked.push(id);
    return id === 'queued-photo';
  };
  await f.service.handleLiveMessage(f.inbound('first-text', '@casa hola'));
  await f.service.handleLiveMessage(f.inbound('queued-photo', '@casa qué opinas?'));
  assert.deepEqual(checked, ['first-text']);
  assert.equal(f.starts[0].channel.currentMessageHasImage, false);
  const runId = f.starts[0].runId;
  await f.service.onRunEvent({ type: 'run.completed', run: { id: runId }, conversation: {
    messages: [{ runId, role: 'assistant', kind: 'message', content: 'Hola' }],
  } });
  assert.deepEqual(checked, ['first-text', 'queued-photo']);
  assert.equal(f.starts[1].channel.currentMessageHasImage, true);
});
test('current images use durable origin and require both chat and current agent account grants', async t => {
  const f = await setup(t);
  assert.equal((await f.service.readCurrentImages(f.query)).success, true);
  assert.equal(f.imageCalls.length, 1);
  assert.equal(f.imageCalls[0][0], 'connection-1'); assert.equal(f.imageCalls[0][1], 'group-1');
  assert.equal(JSON.parse(Buffer.from(f.imageCalls[0][2], 'base64url').toString()).id, 'current-caption');
  for (const grants of [[], [grant(['other'])], [{ ...grant(), actions: ['whatsapp.read_messages'] }]]) {
    await f.agentStore.updateAgentPermissions({ agentId: f.agent.id, connectionGrants: grants });
    const denied = await f.service.readCurrentImages(f.query);
    assert.equal(denied.success, false); assert.equal(denied.images, undefined);
  }
  assert.equal(f.imageCalls.length, 1);
});
test('revocation while a visual read is in flight discards all image output', async t => {
  const f = await setup(t);
  f.connection.readWhatsAppCurrentImages = async () => {
    await f.agentStore.updateAgentPermissions({ agentId: f.agent.id, connectionGrants: [] });
    return { success: true, images: [{ data: 'private', mimeType: 'image/png' }] };
  };
  assert.equal((await f.service.readCurrentImages(f.query)).images, undefined);
});
test('stale runs and provider failures expose neither photos nor raw paths', async t => {
  const f = await setup(t);
  assert.equal((await f.service.readCurrentImages({ ...f.query, runId: 'other' })).success, false);
  f.connection.readWhatsAppCurrentImages = async () => { throw new Error('/private/token SECRET'); };
  const result = await f.service.readCurrentImages(f.query);
  assert.equal(result.success, false); assert.equal(JSON.stringify(result).includes('/private'), false);
});
test('missing durable origin fails closed even when legacy turn authority remains', async t => {
  const f = await setup(t);
  const store = f.service.requireStore();
  const original = store.listActivity;
  store.listActivity = () => [];
  try { assert.equal((await f.service.readCurrentImages(f.query)).success, false); assert.equal(f.imageCalls.length, 0); }
  finally { store.listActivity = original; }
});
