import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { AgentStore } = require('../../dist-electron/main/personal-agents/agent-store.js');
const { WhatsAppAgentChannelService } = require('../../dist-electron/main/personal-agents/whatsapp-channel-service.js');

const waitFor = async (check) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('WhatsApp channel state did not settle');
};

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
      const conversation = { id: `conversation-${conversations.size + 1}`, agentId };
      conversations.set(conversation.id, conversation);
      return conversation;
    },
    getConversation: async (id) => conversations.get(id) ?? null,
    sendWhatsAppMessage: async (input) => {
      const runId = `run-${starts.length + steers.length + 1}`;
      starts.push({ ...input, runId });
      options.onStart?.({ runId, emit: (event) => listener?.(event) });
      return { activeRun: { id: runId } };
    },
    steerMessage: async (input) => {
      const runId = `run-${starts.length + steers.length + 1}`;
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

test('channel history is bounded to the active chat turn and revoked during an in-flight read', async (t) => {
  const f = await fixture(t);
  const saved = await f.service.putBinding(f.baseBinding);
  assert.equal(f.service.listBindings(f.agent.id).length, 1);
  assert.equal(f.service.getLatestDelivery(f.key), null);
  await f.service.handleLiveMessage(f.inbound('history-1'));
  const start = f.starts[0];
  const query = {
    channel: start.channel, runId: start.runId, agentId: f.agent.id,
    conversationId: saved.conversationId, limit: 2, beforeMessageRef: 'older',
  };
  f.setHistory(async () => ({ success: true, data: { messages: [
    { stableMessageRef: 'a', senderId: ' participant ', text: ' hi ', timestamp: 10 },
    { stableMessageRef: 'b', fromMe: true, text: 5, timestamp: 'unknown' },
  ] } }));
  const page = await f.service.readChannelHistory(query);
  assert.deepEqual(page, {
    success: true,
    messages: [
      { id: 'a', authorId: 'participant', text: 'hi', timestamp: '1970-01-01T00:00:10.000Z' },
      { id: 'b', authorId: 'owner', text: '', timestamp: '' },
    ],
    nextBeforeMessageRef: 'b',
  });
  assert.deepEqual(f.calls.at(-1).input, { chatId: 'group-1', limit: 2, beforeMessageRef: 'older' });
  const readCount = f.calls.length;
  assert.equal((await f.service.readChannelHistory({ ...query, channel: { ...query.channel, bindingId: 'other' } })).technicalCode, 'whatsapp_agent_channel_stale');
  assert.equal((await f.service.readChannelHistory({ ...query, runId: 'other' })).technicalCode, 'whatsapp_agent_channel_stale');
  assert.equal(f.calls.length, readCount);

  f.setHistory(async () => ({ success: false, technicalCode: 'offline' }));
  assert.deepEqual(await f.service.readChannelHistory({ ...query, limit: 100, beforeMessageRef: undefined }), {
    success: false, messages: [], technicalCode: 'offline', userMessage: 'No pude leer el historial de este chat.',
  });
  assert.deepEqual(f.calls.at(-1).input, { chatId: 'group-1', limit: 50 });
  f.setHistory(async () => ({ success: false }));
  assert.equal((await f.service.readChannelHistory(query)).technicalCode, 'whatsapp_agent_history_unavailable');
  f.setHistory(async () => ({ success: true, data: { messages: [] } }));
  assert.deepEqual(await f.service.readChannelHistory({ ...query, limit: 0, beforeMessageRef: undefined }), {
    success: true, messages: [],
  });
  assert.deepEqual(f.calls.at(-1).input, { chatId: 'group-1', limit: 20 });

  let releaseRead;
  let enteredRead;
  const entered = new Promise((resolve) => { enteredRead = resolve; });
  const pending = new Promise((resolve) => { releaseRead = resolve; });
  f.setHistory(async () => { enteredRead(); return await pending; });
  const reading = f.service.readChannelHistory(query);
  await entered;
  assert.equal(await f.service.deleteBinding(f.key), true);
  assert.deepEqual(f.cancels, [start.runId]);
  releaseRead({ success: true, data: { messages: [{ stableMessageRef: 'late', text: 'late' }] } });
  assert.equal((await reading).technicalCode, 'whatsapp_agent_channel_stale');
  assert.equal(await f.service.deleteBinding(f.key), false);
});

test('early completion delivers once, trims long replies, and failed runs release the chat', async (t) => {
  const f = await fixture(t, {
    onStart: ({ runId, emit }) => {
      if (runId !== 'run-1') return;
      emit({
        type: 'run.completed', run: { id: runId },
        conversation: { messages: [{ runId, role: 'assistant', kind: 'message', content: 'x'.repeat(4100) }] },
      });
    },
  });
  await f.service.putBinding(f.baseBinding);
  f.setHistory(async () => ({ success: true, data: { messages: [
    { stableMessageRef: 'context-1', senderId: 'participant', text: 'context' },
    { stableMessageRef: 'empty', text: ' ' },
  ] } }));
  await f.service.handleLiveMessage(f.inbound('early-1'));
  await waitFor(() => f.sends.length === 1);
  assert.equal(f.sends[0].input.text.length < 4000, true);
  assert.match(f.sends[0].input.text, /Respuesta abreviada/);
  assert.match(f.starts[0].content, /context/);
  assert.equal(f.service.getLatestDelivery(f.key).state, 'sent');
  f.emit({
    type: 'run.completed', run: { id: 'run-1' },
    conversation: { messages: [{ runId: 'run-1', role: 'assistant', kind: 'message', content: 'duplicate' }] },
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(f.sends.length, 1);

  await f.service.handleLiveMessage(f.inbound('failed-2', 'Casa: vuelve a revisar', { senderId: 'participant', fromMe: false }));
  assert.equal(f.starts.length, 2);
  assert.match(f.starts[1].content, /participant/);
  f.emit({ type: 'run.failed', run: { id: 'run-2' }, conversation: { messages: [] } });
  await waitFor(() => f.service.getBinding(f.key).activeTurnId === null);
  assert.equal(f.sends.length, 1);
  await f.service.handleLiveMessage(f.inbound('third-3'));
  assert.equal(f.starts.length, 3);
});

test('binding setup validates the observed account and a missing runner ID stays quarantined', async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.service.putBinding({ ...f.baseBinding, agentId: 'missing' }));
  await assert.rejects(f.service.putBinding({ ...f.baseBinding, connectionId: 'missing' }), /connection_not_found/);
  const originalCall = f.connection.call;
  f.connection.call = async (input) => input.actionId === 'whatsapp.get_chat_details'
    ? { success: false }
    : await originalCall(input);
  await assert.rejects(f.service.putBinding(f.baseBinding), /chat_not_observed/);
  f.connection.call = originalCall;
  const saved = await f.service.putBinding(f.baseBinding);
  await assert.rejects(f.service.putBinding({ ...f.baseBinding, expectedRevision: saved.revision - 1 }), /revision_conflict/);
  f.manager.sendWhatsAppMessage = async () => ({ activeRun: null });
  await f.service.handleLiveMessage(f.inbound('missing-run'));
  assert.deepEqual(f.service.listUnsettledMessages('connection-1').map((message) => message.state), ['admitting']);
  assert.equal(f.service.getBinding(f.key).activeTurnId !== null, true);
  await f.service.handleLiveMessage(f.inbound('follow-up'));
  assert.deepEqual(f.service.listUnsettledMessages('connection-1').map((message) => message.state), ['pending', 'admitting']);
});

test('service startup retires an orphaned run before processing new messages', async (t) => {
  const f = await fixture(t);
  await f.service.putBinding(f.baseBinding);
  await f.service.handleLiveMessage(f.inbound('orphan'));
  const before = f.service.getBinding(f.key);
  assert.ok(before.activeTurnId);
  f.service.close();
  const resumed = new WhatsAppAgentChannelService({
    metadataRoot: f.root,
    getConnectionsService: () => f.connection,
    getAgentStore: () => f.agentStore,
    getConversationManager: () => f.manager,
  });
  await resumed.initialize();
  t.after(() => resumed.close());
  assert.equal(resumed.getBinding(f.key).activeTurnId, null);
  assert.ok(resumed.getBinding(f.key).revision > before.revision);
  await resumed.handleLiveMessage(f.inbound('after-restart'));
  assert.equal(f.starts.length, 2);
});

test('service restart keeps an idle binding and missing account identity uses a safe label', async (t) => {
  const f = await fixture(t);
  f.connection.listInstances = async () => [{ id: 'connection-1' }];
  const saved = await f.service.putBinding(f.baseBinding);
  assert.equal(saved.ownerId, 'connected-whatsapp-account');
  f.service.close();
  const resumed = new WhatsAppAgentChannelService({
    metadataRoot: f.root,
    getConnectionsService: () => f.connection,
    getAgentStore: () => f.agentStore,
    getConversationManager: () => f.manager,
  });
  await resumed.initialize();
  t.after(() => resumed.close());
  assert.equal(resumed.getBinding(f.key).revision, saved.revision);
  const uninitialized = new WhatsAppAgentChannelService({
    metadataRoot: f.root,
    getConnectionsService: () => f.connection,
    getAgentStore: () => f.agentStore,
    getConversationManager: () => f.manager,
  });
  assert.throws(() => uninitialized.listBindings(), /channel_not_initialized/);
  await assert.rejects(uninitialized.handleLiveMessage(f.inbound('uninitialized')), /channel_not_initialized/);
});

test('delivery records definite rejection separately from uncertain transport acceptance', async (t) => {
  const f = await fixture(t);
  await f.service.putBinding(f.baseBinding);
  const complete = (runId) => f.emit({
    type: 'run.completed', run: { id: runId },
    conversation: { messages: [{ runId, role: 'assistant', kind: 'message', content: 'Listo' }] },
  });
  f.setDelivery(async () => ({ success: false, technicalCode: 'offline' }));
  await f.service.handleLiveMessage(f.inbound('rejected-1'));
  complete('run-1');
  await waitFor(() => f.service.getLatestDelivery(f.key)?.state === 'failed');
  assert.equal(f.service.getLatestDelivery(f.key).stableMessageRef, null);
  assert.equal(f.service.getBinding(f.key).activeTurnId, null);

  f.setDelivery(async () => ({ success: true, data: { sent: false } }));
  await f.service.handleLiveMessage(f.inbound('uncertain-2'));
  complete('run-2');
  await waitFor(() => f.service.getLatestDelivery(f.key)?.state === 'unknown');
  assert.equal(f.sends.length, 2);
  complete('run-2');
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(f.sends.length, 2);
});

test('steer replaces the exact run, OFF cancels it, and completion without text settles silently', async (t) => {
  const f = await fixture(t);
  await f.service.putBinding(f.baseBinding);
  await f.service.handleLiveMessage(f.inbound('first', 'Casa: first task'));
  await f.service.handleLiveMessage(f.inbound('second', 'Casa: corrected task'));
  assert.equal(f.steers.length, 1);
  assert.equal(f.steers[0].expectedRunId, 'run-1');
  assert.equal(f.steers[0].source, 'whatsapp');
  assert.match(f.steers[0].content, /corrected task/);
  await f.service.handleLiveMessage(f.inbound('off', 'Casa OFF'));
  assert.deepEqual(f.cancels, ['run-2']);
  assert.equal(f.service.getBinding(f.key).enabled, false);
  assert.equal(f.logs.some(({ event, payload }) => event === 'whatsapp_agent:inbound' && payload.status === 'steered'), true);

  await f.service.handleLiveMessage(f.inbound('on', 'Casa ON'));
  await f.service.handleLiveMessage(f.inbound('third', 'Casa: third task'));
  f.emit({ type: 'run.completed', run: { id: 'run-3' }, conversation: { messages: [] } });
  await waitFor(() => f.service.getBinding(f.key).activeTurnId === null);
  assert.equal(f.sends.length, 0);
  assert.equal(f.service.getLatestDelivery(f.key), null);
});

test('conversation event failures are logged without leaking a reply', async (t) => {
  const f = await fixture(t);
  const event = { type: 'run.completed', run: { id: 'irrelevant' }, conversation: { messages: [] } };
  f.service.onRunEvent = async () => { throw new Error('event failure'); };
  f.emit(event);
  await waitFor(() => f.logs.some(({ event: name }) => name === 'whatsapp_agent:run_event_failed'));
  assert.deepEqual(f.logs.at(-1), {
    event: 'whatsapp_agent:run_event_failed',
    payload: { runId: 'irrelevant', error: 'event failure' },
  });
  f.service.onRunEvent = async () => { throw 'non-error failure'; };
  f.emit(event);
  await waitFor(() => f.logs.length === 2);
  assert.equal(f.logs[1].payload.error, 'unknown');
  assert.equal(f.sends.length, 0);
});

test('service rejects unverified steer targets and a canceled run releases its chat', async (t) => {
  const f = await fixture(t);
  await f.service.initialize();
  await f.service.putBinding(f.baseBinding);
  const binding = f.service.getBinding(f.key);
  const input = {
    binding, previousTurnId: 'missing', revision: binding.revision,
    text: 'correction', context: [], stableMessageRef: 'ref', authorId: null, isFromMe: false,
  };
  await assert.rejects(f.service.startRun({ ...input, binding: { ...binding, conversationId: null } }), /conversation_missing/);
  await assert.rejects(f.service.steerRun({ ...input, binding: { ...binding, conversationId: null } }), /conversation_missing/);
  await assert.rejects(f.service.steerRun(input), /previous_run_unverified/);
  assert.match(f.service.runPrompt(input), /Autor de la invocación: desconocido/);
  await f.service.onRunEvent({ type: 'run.canceled', run: null, conversation: { messages: [] } });

  await f.service.handleLiveMessage(f.inbound('direct'));
  const current = f.service.getBinding(f.key);
  const turn = f.service.store.findTurnByRunId('run-1');
  f.service.store.markTurnStatus(turn.turnId, 'failed');
  await assert.rejects(f.service.steerRun({ ...input, binding: current, previousTurnId: turn.turnId }), /previous_run_unverified/);
  f.service.store.markTurnStatus(turn.turnId, 'active');
  for (const change of [{ agentId: 'different' }, { connectionId: 'other-account' }, { chatId: 'other-chat' }]) {
    await assert.rejects(f.service.steerRun({
      ...input, binding: { ...current, ...change }, previousTurnId: turn.turnId,
    }), /previous_run_unverified/);
  }
  f.manager.steerMessage = async () => ({ activeRun: null });
  await assert.rejects(f.service.steerRun({ ...input, binding: current, previousTurnId: turn.turnId }), /run_missing/);
  f.emit({ type: 'run.canceled', run: { id: 'run-1' }, conversation: { messages: [] } });
  await waitFor(() => f.service.getBinding(f.key).activeTurnId === null);
  assert.equal(f.service.getLatestDelivery(f.key), null);
});

test('unknown early events stay pending and malformed context never enters the task prompt', async (t) => {
  const f = await fixture(t);
  await f.service.putBinding(f.baseBinding);
  f.emit({ type: 'run.completed', run: { id: 'unrelated-run' }, conversation: { messages: [] } });
  await waitFor(() => f.service.earlyRunEvents.size === 1);
  f.setHistory(async () => ({ success: true, data: { messages: 'malformed' } }));
  await f.service.handleLiveMessage(f.inbound('task'));
  assert.match(f.starts[0].content, /Contexto reciente no confiable del mismo chat: \[\]/);
  assert.equal(f.service.earlyRunEvents.size, 1);
  f.setHistory(async () => ({ success: true, data: { messages: [
    { stableMessageRef: 'no-author', fromMe: false, text: 'context' },
  ] } }));
  await f.service.handleLiveMessage(f.inbound('correction', 'Casa: correction'));
  assert.match(f.steers[0].content, /unknown/);
});

test('channel initialization fails closed when SQLite is unavailable', async (t) => {
  const f = await fixture(t);
  const sqlite = require('../../dist-electron/main/personal-agents/sqlite.js');
  const open = sqlite.openPersonalAgentSqliteDatabase;
  sqlite.openPersonalAgentSqliteDatabase = () => null;
  try {
    const unavailable = new WhatsAppAgentChannelService({
      metadataRoot: path.join(f.root, 'unavailable'),
      getConnectionsService: () => f.connection,
      getAgentStore: () => f.agentStore,
      getConversationManager: () => f.manager,
    });
    await assert.rejects(unavailable.initialize(), /sqlite_unavailable/);
    assert.throws(() => unavailable.listBindings(), /channel_not_initialized/);
  } finally {
    sqlite.openPersonalAgentSqliteDatabase = open;
  }
});
