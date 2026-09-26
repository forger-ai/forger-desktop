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
const until = async (check) => {
  for (let i = 0; i < 300; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail('timed out');
};
const setup = async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'wa-reliable-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new AgentStore({ metadataRoot: root, forgerHomeRoot: root });
  const agent = await store.createAgent({ name: 'Ana' });
  const runs = [];
  const sends = [];
  let read = async () => ({ success: true, data: { messages: [] } });
  let send = async (input) => {
    sends.push(input);
    return { success: true, data: { sent: true } };
  };
  const connection = {
    listInstances: async () => [{ id: 'account' }],
    call: async (input) =>
      input.actionId === 'whatsapp.get_chat_details'
        ? { success: true }
        : input.actionId === 'whatsapp.read_messages'
          ? read()
          : send(input),
  };
  const build = () => {
    const agentStore = new AgentStore({ metadataRoot: root, forgerHomeRoot: root });
    const manager = new AgentConversationManager({
      store: agentStore,
      runner: (input) => new Promise((resolve) => runs.push({ input, resolve })),
    });
    const service = new WhatsAppAgentChannelService({
      metadataRoot: root,
      getAgentStore: () => agentStore,
      getConversationManager: () => manager,
      getConnectionsService: () => connection,
    });
    t.after(() => service.close());
    return { service, manager };
  };
  let { service, manager } = build();
  await service.initialize();
  const key = { connectionId: 'account', chatId: 'chat', agentId: agent.id };
  await service.putBinding({
    ...key,
    alias: 'Ana',
    enabled: true,
    purpose: 'Help',
    scope: '',
    participantsAllowed: ['alice', 'bob'],
  });
  let seq = 0;
  const inbound = (text, author = 'alice') =>
    service.handleLiveMessage({
      connectionId: 'account',
      message: {
        chatId: 'chat',
        senderId: author,
        fromMe: author === 'owner',
        text,
        hasAttachments: false,
        stableMessageRef: { chatId: 'chat', id: `in-${++seq}`, fromMe: author === 'owner' },
      },
    });
  return {
    key,
    runs,
    sends,
    inbound,
    get service() {
      return service;
    },
    get manager() {
      return manager;
    },
    setRead(fn) {
      read = fn;
    },
    setSend(fn) {
      send = fn;
    },
    async restart() {
      service.close();
      ({ service, manager } = build());
      await service.initialize();
    },
  };
};
test('restart reconciles the real conversation and preserves queued requests without replaying the interrupted run', async (t) => {
  const h = await setup(t);
  await h.inbound('Ana primero');
  await until(() => h.runs.length === 1);
  await h.inbound('Ana segundo');
  assert.equal(h.runs.length, 1);
  await h.restart();
  await until(() => h.runs.length === 2);
  const a = h.service.listActivity(h.key);
  assert.equal(a[0].status, 'interrupted');
  assert.equal(a[1].status, 'active');
  h.runs[1].resolve({ assistantText: 'segunda' });
  await until(() => h.sends.length === 1);
  await h.inbound('Ana tercero');
  await until(() => h.runs.length === 3);
});
test('a completion while the next context is read keeps both independent results and configuration version stable', async (t) => {
  const h = await setup(t);
  const version = h.service.getBinding(h.key).configurationVersion;
  await h.inbound('Ana primero');
  await until(() => h.runs.length === 1);
  let release;
  h.setRead(
    () =>
      new Promise((r) => {
        release = r;
      }),
  );
  const next = h.inbound('Ana segundo', 'bob');
  h.runs[0].resolve({ assistantText: 'primera' });
  await until(() => release);
  release({ success: true, data: { messages: [] } });
  await next;
  await until(() => h.runs.length === 2);
  h.runs[1].resolve({ assistantText: 'segunda' });
  await until(() => h.sends.length === 2);
  assert.equal(h.service.getBinding(h.key).configurationVersion, version);
  assert.equal(h.service.listActivity(h.key).filter((x) => x.status === 'completed').length, 2);
});
test('outbox retries only definite transient pre-send failures and never retries uncertain delivery', async (t) => {
  const h = await setup(t);
  let attempts = 0;
  h.setSend(async () =>
    ++attempts === 1
      ? { success: false, technicalCode: 'whatsapp_send_rate_limited', data: { deliveryState: 'not_sent' } }
      : { success: true, data: { sent: true } },
  );
  await h.inbound('Ana primero');
  await until(() => h.runs.length === 1);
  h.runs[0].resolve({ assistantText: 'respuesta completa' });
  await until(() => attempts === 2);
  assert.equal(h.service.listActivity(h.key)[0].deliveryState, 'sent');
  h.setSend(async () => {
    attempts++;
    throw new Error('transport timeout');
  });
  await h.inbound('Ana segundo');
  await until(() => h.runs.length === 2);
  h.runs[1].resolve({ assistantText: 'incierta' });
  await until(() => h.service.listActivity(h.key)[1]?.deliveryState === 'unknown');
  const n = attempts;
  await h.restart();
  assert.equal(attempts, n);
  await assert.rejects(
    () => h.service.retryDelivery(h.key, h.service.listActivity(h.key)[1].requestId),
    /not_retryable/,
  );
});
test('independent participants queue FIFO and only author or owner can explicitly correct a request', async (t) => {
  const h = await setup(t);
  await h.inbound('Ana original');
  await until(() => h.runs.length === 1);
  await h.inbound('Ana siguiente', 'bob');
  const [first, second] = h.service.listActivity(h.key);
  assert.equal(second.status, 'queued');
  assert.equal(h.runs.length, 1);
  await h.inbound(`Ana CORREGIR ${first.requestId} overwrite`, 'bob');
  assert.equal(h.service.listActivity(h.key)[0].status, 'active');
  await h.inbound(`Ana CORREGIR ${second.requestId} segundo corregido`, 'bob');
  assert.equal(h.service.listActivity(h.key)[1].requestText, 'segundo corregido');
  await h.service.cancelRequest(h.key, first.requestId);
  await until(() => h.runs.length === 2);
  assert.equal(h.service.listActivity(h.key)[0].status, 'canceled');
  assert.match(h.runs[1].input.prompt, /segundo corregido/);
  h.runs[0].resolve({ assistantText: 'obsoleta' });
  h.runs[1].resolve({ assistantText: 'vigente' });
  await until(() => h.sends.length === 1);
  assert.equal(h.sends[0].input.text, 'vigente');
});
test('local pause succeeds offline and a configuration draft is unaffected by task admission', async (t) => {
  const h = await setup(t);
  const binding = h.service.getBinding(h.key);
  await h.inbound('Ana trabaja');
  await until(() => h.runs.length === 1);
  await h.service.putBinding({
    ...binding,
    expectedConfigurationVersion: binding.configurationVersion,
    purpose: 'Updated purpose',
  });
  assert.equal(h.service.listActivity(h.key)[0].status, 'canceled');
  const updated = h.service.getBinding(h.key);
  h.setRead(async () => {
    throw new Error('offline');
  });
  const paused = await h.service.setEnabled(h.key, false, updated.configurationVersion);
  assert.equal(paused.enabled, false);
  await assert.rejects(() => h.service.setEnabled(h.key, true, binding.configurationVersion), /revision_conflict/);
});
test('unrelated conversation completions cannot exhaust WhatsApp terminal event handling', async (t) => {
  const h = await setup(t);
  for (let i = 0; i < 100; i++)
    h.manager.emit({ type: 'run.completed', run: { id: `unrelated-${i}` }, conversation: { messages: [] } });
  await h.inbound('Ana respuesta');
  await until(() => h.runs.length === 1);
  h.runs[0].resolve({ assistantText: 'llega' });
  await until(() => h.sends.length === 1);
  assert.equal(h.service.listActivity(h.key)[0].deliveryState, 'sent');
});
test('global alias update is explicit and preserves running requests across bound chats', async (t) => {
  const h = await setup(t);
  const binding = h.service.getBinding(h.key);
  await assert.rejects(
    () =>
      h.service.putBinding({ ...binding, alias: 'Nueva', expectedConfigurationVersion: binding.configurationVersion }),
    /explicit_update/,
  );
  await h.inbound('Ana original');
  await until(() => h.runs.length === 1);
  const activity = h.service.listActivity(h.key)[0];
  const updated = await h.service.updateAlias('account', h.key.agentId, 'Nueva');
  assert.equal(updated[0].alias, 'Nueva');
  assert.equal(h.service.listActivity(h.key)[0].requestId, activity.requestId);
  assert.equal(h.service.listActivity(h.key)[0].status, 'active');
  h.runs[0].resolve({ assistantText: 'completa' });
  await until(() => h.sends.length === 1);
});

test('pausing interrupts a blocked context read immediately and prevents the reserved runner from starting', async (t) => {
  const h = await setup(t);
  let release;
  h.setRead(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const receiving = h.inbound('Ana espera');
  await until(() => release);
  const result = await Promise.race([
    h.service.setEnabled(h.key, false),
    new Promise((_, reject) => setTimeout(() => reject(new Error('pause waited for network')), 100)),
  ]);
  assert.equal(result.enabled, false);
  release({ success: true, data: { messages: [] } });
  await receiving;
  assert.equal(h.runs.length, 0);
  assert.equal(h.service.listActivity(h.key)[0].status, 'canceled');
});

test('a completed durable response is recovered after a lost completion event without rerunning its task', async (t) => {
  const h = await setup(t);
  await h.inbound('Ana completa');
  await until(() => h.runs.length === 1);
  const { conversationId } = h.service.getBinding(h.key);
  h.service.close();
  h.runs[0].resolve({ assistantText: 'resultado durable' });
  await until(async () => (await h.manager.getConversation(conversationId)).activeRun?.status === 'completed');
  await h.restart();
  await until(() => h.sends.length === 1);
  assert.equal(h.runs.length, 1);
  assert.equal(h.sends[0].input.text, 'resultado durable');
  assert.equal(h.service.listActivity(h.key)[0].status, 'completed');
});

test('explicit policy survives reopening as relational selections and current access expires immediately on pause', async (t) => {
  const h = await setup(t);
  const binding = h.service.getBinding(h.key);
  const policy = {
    appIds: ['selected-app'],
    toolIds: ['memory'],
    peerAgentIds: ['peer'],
    networkAccess: true,
    sharedMemoryIds: ['memory-1'],
    connectionGrants: [
      { type: 'whatsapp', actions: ['whatsapp.read_messages'], multiple: true, connectionIds: ['account'] },
    ],
    sharedFiles: [{ id: 'file-1', path: 'shared.txt', name: 'Shared file' }],
  };
  await h.service.putBinding({ ...binding, policy, expectedConfigurationVersion: binding.configurationVersion });
  await h.restart();
  assert.deepEqual(h.service.getBinding(h.key).policy, policy);
  const options = await h.service.getPolicyOptions(h.key.agentId);
  assert.equal(options.agent.id, h.key.agentId);
  // Remove files for the runner fixture; file-library staging has independent security integration tests.
  const current = h.service.getBinding(h.key);
  await h.service.putBinding({
    ...current,
    policy: { ...policy, sharedFiles: [] },
    expectedConfigurationVersion: current.configurationVersion,
  });
  await h.inbound('Ana permisos');
  await until(() => h.runs.length === 1);
  const { input } = h.runs[0];
  const access = {
    channel: input.mcpContext.channel,
    agentId: h.key.agentId,
    conversationId: input.conversation.id,
    runId: input.run.id,
  };
  assert.equal(h.service.isChannelCurrent(access), true);
  const effective = await h.service.getCurrentPolicyAgent(access);
  assert.deepEqual(effective.appIds, []); // A saved selection never invents a grant on the agent.
  await h.service.setEnabled(h.key, false);
  assert.equal(await h.service.getCurrentPolicyAgent(access), null);
});

test('known unsent replies can retry while uncertain replies only allow review and dismissal', async (t) => {
  const h = await setup(t);
  h.setSend(async () => ({
    success: false,
    technicalCode: 'invalid_destination',
    data: { deliveryState: 'not_sent' },
  }));
  await h.inbound('Ana respuesta');
  await until(() => h.runs.length === 1);
  h.runs[0].resolve({ assistantText: 'respuesta' });
  await until(() => h.service.listActivity(h.key)[0].deliveryState === 'failed');
  const first = h.service.listActivity(h.key)[0];
  assert.equal(first.canRetryDelivery, true);
  await assert.rejects(() => h.service.dismissRequest(h.key, first.requestId), /not_dismissible/);
  h.setSend(async () => ({ success: true, data: { sent: true } }));
  await h.service.retryDelivery(h.key, first.requestId);
  await until(() => h.service.listActivity(h.key)[0].deliveryState === 'sent');
  h.setSend(async () => ({ success: false, technicalCode: 'unknown_transport' }));
  await h.inbound('Ana segunda');
  await until(() => h.runs.length === 2);
  h.runs[1].resolve({ assistantText: 'segunda' });
  await until(() => h.service.listActivity(h.key)[1].deliveryState === 'unknown');
  const second = h.service.listActivity(h.key)[1];
  await h.service.dismissRequest(h.key, second.requestId);
  assert.equal(h.service.listActivity(h.key)[1].status, 'dismissed');
  await assert.rejects(() => h.service.cancelRequest(h.key, 'missing'), /not_cancelable/);
});

test('a slow WhatsApp delivery does not hold the task admission lock', async (t) => {
  const h = await setup(t);
  let release;
  h.setSend(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  await h.inbound('Ana primero');
  await until(() => h.runs.length === 1);
  h.runs[0].resolve({ assistantText: 'primero' });
  await until(() => release);
  await h.inbound('Ana segundo');
  await until(() => h.runs.length === 2);
  release({ success: true, data: { sent: true } });
  await until(() => h.service.listActivity(h.key)[0].deliveryState === 'sent');
  assert.equal(h.service.listActivity(h.key)[1].status, 'active');
});

test('admission distinguishes rejection, confirmed acceptance with a lost response, and an unconfirmed store read', async (t) => {
  const h = await setup(t);
  const send = h.manager.sendWhatsAppMessage.bind(h.manager);
  h.manager.sendWhatsAppMessage = async () => {
    throw new Error('rejected before start');
  };
  await h.inbound('Ana rejected');
  assert.equal(h.service.listActivity(h.key)[0].status, 'failed');
  const getRun = h.manager.options.store.getRun.bind(h.manager.options.store);
  h.manager.options.store.getRun = async () => {
    throw new Error('storage unavailable');
  };
  await h.inbound('Ana uncertain');
  assert.equal(h.service.listActivity(h.key)[1].status, 'interrupted');
  h.manager.options.store.getRun = getRun;
  await h.service.dismissRequest(h.key, h.service.listActivity(h.key)[1].requestId);
  h.manager.sendWhatsAppMessage = async (input) => {
    await send(input);
    throw new Error('response lost after admission');
  };
  await h.inbound('Ana accepted');
  await until(() => h.runs.length === 1);
  assert.equal(h.service.listActivity(h.key)[2].status, 'active');
  h.runs[0].resolve({ assistantText: 'exactly once' });
  await until(() => h.sends.length === 1);
  assert.equal(h.service.listActivity(h.key)[2].deliveryState, 'sent');
});

test('durable run identity is idempotent and reconciliation cannot modify a personal conversation', async (t) => {
  const h = await setup(t);
  await h.inbound('Ana first');
  await until(() => h.runs.length === 1);
  const { input } = h.runs[0];
  const repeated = await h.manager.sendWhatsAppMessage({
    runId: input.run.id,
    conversationId: input.conversation.id,
    content: 'duplicate',
    channel: input.mcpContext.channel,
  });
  assert.equal(repeated.messages.filter((m) => m.role === 'user').length, 1);
  assert.equal(h.runs.length, 1);
  const personal = await h.manager.createConversation({ agentId: h.key.agentId });
  await assert.rejects(() => h.manager.reconcileWhatsAppConversation(personal.id), /whatsapp_conversation_required/);
});

test('unsupported channel runtimes fail before execution and shared files require the file library resolver', async (t) => {
  const h = await setup(t);
  h.manager.options.getAgentRuntime = async () => ({ provider: 'antigravity', permissionMode: 'safe' });
  await h.inbound('Ana unsupported');
  await until(() => h.service.listActivity(h.key)[0]?.status === 'failed');
  assert.equal(h.runs.length, 0);
  h.manager.options.getAgentRuntime = undefined;
  const binding = h.service.getBinding(h.key);
  const policy = { ...binding.policy, sharedFiles: [{ id: 'selected', path: 'selected.txt' }] };
  await h.service.putBinding({ ...binding, policy, expectedConfigurationVersion: binding.configurationVersion });
  await h.inbound('Ana unavailable file');
  await until(() => h.service.listActivity(h.key)[1]?.status === 'failed');
  assert.equal(h.runs.length, 0);
  const fs = await import('node:fs/promises');
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'wa-shared-file-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'selected.txt');
  await fs.writeFile(filename, 'EXPLICIT_FILE');
  h.manager.options.resolveWhatsAppSharedFiles = async (refs) =>
    refs.map((ref) => ({ id: ref.id, name: 'selected.txt', absolutePath: filename }));
  await h.inbound('Ana selected file');
  await until(() => h.runs.length === 1);
  const files = await fs.readdir(path.join(h.runs[0].input.workspaceRoot, 'shared'));
  assert.equal(
    await fs.readFile(path.join(h.runs[0].input.workspaceRoot, 'shared', files[0]), 'utf8'),
    'EXPLICIT_FILE',
  );
});

test('the actual provider adapter receives MCP-only access and app sessions receive the live channel context', async (t) => {
  const h = await setup(t);
  await h.inbound('Ana provider');
  await until(() => h.runs.length === 1);
  const provider = require('../../dist-electron/main/llm-provider/run-service.js');
  const original = provider.createLlmProviderRunService;
  const directory = await mkdtemp(path.join(tmpdir(), 'wa-provider-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const seen = [];
  const sessions = [];
  provider.createLlmProviderRunService = () => ({
    run: async (input) => {
      seen.push(input);
      return { code: 0, assistantText: 'safe result' };
    },
  });
  t.after(() => {
    provider.createLlmProviderRunService = original;
  });
  const runtime = { provider: 'codex', permissionMode: 'safe' };
  Object.assign(h.manager.options, {
    metadataRoot: directory,
    codexHome: directory,
    getAgentRuntime: async () => runtime,
    listenAppMcps: async (...args) => {
      sessions.push(args);
      return [];
    },
  });
  await h.manager.runWithConfiguredProvider({ ...h.runs[0].input, runtime });
  assert.equal(seen[0].localToolPolicy, 'mcp-only');
  assert.equal(seen[0].permissionMode, 'safe');
  assert.equal(sessions[0][2].channel.bindingId, h.runs[0].input.mcpContext.channel.bindingId);
  assert.equal(sessions[0][3], h.key.agentId);
});

test('migration quarantines a legacy admission gap as visible interrupted activity without replaying it', async (t) => {
  const h = await setup(t);
  const binding = h.service.getBinding(h.key);
  const store = h.service.store;
  store.claimMessage('account', 'chat', 'legacy-ref');
  store.prepareTurn(binding, binding.revision, 'legacy-request', 'legacy-ref');
  await h.restart();
  const activity = h.service.listActivity(h.key);
  assert.equal(activity.length, 1);
  assert.equal(activity[0].status, 'interrupted');
  assert.equal(activity[0].reason, 'legacy_admission_unconfirmed');
  assert.equal(h.service.listUnsettledMessages().length, 0);
  assert.equal(h.runs.length, 0);
  await h.service.dismissRequest(h.key, 'legacy-request');
  assert.equal(h.service.listActivity(h.key)[0].status, 'dismissed');
  await h.inbound('Ana next');
  await until(() => h.runs.length === 1);
});

test('a terminal event without a usable answer retires its request and allows the next request to run', async (t) => {
  const h = await setup(t);
  await h.inbound('Ana first');
  await until(() => h.runs.length === 1);
  const { input } = h.runs[0];
  const run = await h.manager.options.store.updateRunStatus({ runId: input.run.id, status: 'completed' });
  h.manager.emit({ type: 'run.completed', run, conversation: await h.manager.getConversation(input.conversation.id) });
  await until(() => h.service.listActivity(h.key)[0].status === 'failed');
  assert.equal(h.sends.length, 0);
  await h.inbound('Ana next');
  await until(() => h.runs.length === 2);
});

test('real WhatsApp transport classification preserves an offline reply through account rate limiting and reconnection', async (t) => {
  const h = await setup(t);
  const { WhatsAppLocalStore } = require('../../dist-electron/main/connections/modules/whatsapp/store.js');
  const { WhatsAppConnectionManager } = require('../../dist-electron/main/connections/modules/whatsapp/manager.js');
  const root = await mkdtemp(path.join(tmpdir(), 'wa-real-transport-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const transport = new WhatsAppConnectionManager(new WhatsAppLocalStore(root));
  transport.ensureStarted = async () => {}; // Network establishment is the external boundary; all send gates and persistence remain real.
  const chatId = '56900000001@s.whatsapp.net';
  const key = { ...h.key, chatId };
  await transport.ingestMessages([
    { key: { remoteJid: chatId, id: 'observed', fromMe: false }, message: { conversation: 'hello' } },
  ]);
  await h.service.putBinding({
    ...key,
    alias: 'Ana',
    enabled: true,
    purpose: 'Help',
    scope: '',
    participantsAllowed: [],
  });
  const outcomes = [];
  const network = [];
  let attempts = 0;
  h.setSend(async (input) => {
    attempts++;
    if (attempts === 2)
      await transport.sendMessage({ metadataRoot: root }, { chatId, text: 'another authorized sender' });
    const result = await transport.sendMessage({ metadataRoot: root }, input.input);
    outcomes.push(result.technicalCode ?? 'sent');
    return result.success === false ? result : { success: true, data: result };
  });
  await h.service.handleLiveMessage({
    connectionId: 'account',
    message: {
      chatId,
      fromMe: true,
      text: 'Ana prepare',
      hasAttachments: false,
      stableMessageRef: { chatId, id: 'request', fromMe: true },
    },
  });
  await until(() => h.runs.length === 1);
  h.runs[0].resolve({ assistantText: 'durable answer' });
  await until(() => outcomes.length === 1);
  assert.equal(outcomes[0], 'whatsapp_send_unavailable');
  assert.equal(h.service.listActivity(key)[0].deliveryState, 'pending');
  transport.socket = {
    sendMessage: async (id, { text }) => {
      network.push(text);
      return {
        key: { remoteJid: id, id: `sent-${network.length}`, fromMe: true },
        message: { conversation: text },
        messageTimestamp: Math.floor(Date.now() / 1000),
      };
    },
  };
  for (let i = 0; i < 500 && h.service.listActivity(key)[0].deliveryState !== 'sent'; i++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(outcomes, ['whatsapp_send_unavailable', 'whatsapp_send_rate_limited', 'sent']);
  assert.deepEqual(network, ['another authorized sender', 'durable answer']);
  assert.equal(h.service.listActivity(key)[0].deliveryState, 'sent');
});

test('saving a policy restarts eligible queued work without another message and cancels newly unauthorized requests', async (t) => {
  for (const revoke of [false, true]) {
    const h = await setup(t);
    await h.inbound('Ana active');
    await until(() => h.runs.length === 1);
    await h.inbound('Ana queued', 'bob');
    const binding = h.service.getBinding(h.key);
    await h.service.putBinding({
      ...binding,
      purpose: 'New instructions',
      participantsAllowed: revoke ? ['alice'] : ['alice', 'bob'],
      expectedConfigurationVersion: binding.configurationVersion,
    });
    await until(() => h.service.listActivity(h.key)[1].status !== 'queued');
    const activity = h.service.listActivity(h.key);
    assert.equal(activity[0].status, 'canceled');
    assert.equal(activity[1].status, revoke ? 'canceled' : 'active');
    if (!revoke) await until(() => h.runs.length === 2);
    assert.equal(h.runs.length, revoke ? 1 : 2);
  }
});

test('changing a channel runtime starts a fresh provider session without replaying the previous thread', async (t) => {
  const h = await setup(t);
  let provider = 'codex';
  h.manager.options.getAgentRuntime = async () => ({ provider, permissionMode: 'safe' });
  await h.inbound('Ana first');
  await until(() => h.runs.length === 1);
  h.runs[0].resolve({ assistantText: 'first', providerThreadId: 'previous-private-session' });
  await until(() => h.service.listActivity(h.key)[0].status === 'completed');
  provider = 'claude';
  await h.inbound('Ana second');
  await until(() => h.runs.length === 2);
  assert.equal(h.runs[1].input.runtime.provider, 'claude');
  assert.equal(h.runs[1].input.conversation.providerThreadId ?? null, null);
  assert.doesNotMatch(h.runs[1].input.prompt, /previous-private-session/);
});
