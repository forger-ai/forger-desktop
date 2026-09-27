import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  WhatsAppAgentChannelStore,
  WhatsAppAgentChannelCoordinator,
  parseAgentWakeMessage,
  normalizeAgentAliasKey,
} = require('../../dist-electron/main/personal-agents/whatsapp-channel/index.js');
const { openPersonalAgentSqliteDatabase } = require('../../dist-electron/main/personal-agents/sqlite.js');

let sequence = 0;
const nextRef = () => `message-${++sequence}`;

const harness = async ({ sendReply, readContext, startRun, resolveIdentityIds } = {}) => {
  const root = await mkdtemp(path.join(tmpdir(), 'forger-whatsapp-agent-'));
  const db = openPersonalAgentSqliteDatabase(path.join(root, 'channel.sqlite'));
  assert.ok(db);
  const store = new WhatsAppAgentChannelStore(db);
  const calls = { start: [], steer: [], cancel: [], send: [], context: [], runIds: [] };
  const coordinator = new WhatsAppAgentChannelCoordinator(store, {
    resolveIdentityIds,
    readContext:
      readContext ??
      (async (_binding, limit) => {
        calls.context.push(limit);
        return Array.from({ length: 40 }, (_, index) => ({
          stableMessageRef: `old-${index}`,
          authorId: 'member',
          text: 'x'.repeat(2000),
        }));
      }),
    startRun:
      startRun ??
      (async (input) => {
        calls.start.push(input);
        const runId = input.runId;
        calls.runIds.push(runId);
        return { runId };
      }),
    steerRun: async (input) => {
      calls.steer.push(input);
      const runId = input.runId;
      calls.runIds.push(runId);
      return { runId };
    },
    cancelRun: async (input) => {
      calls.cancel.push(input);
    },
    sendReply:
      sendReply ??
      (async (input) => {
        calls.send.push(input);
        return { sent: true, stableMessageRef: nextRef() };
      }),
  });
  const put = (input = {}) =>
    store.putBinding({
      connectionId: 'account',
      chatId: 'chat',
      agentId: 'agent-a',
      alias: 'Hal',
      ownerId: 'owner',
      enabled: false,
      purpose: 'Help on this project',
      scope: 'Only this workspace',
      participantsAllowed: ['member'],
      conversationId: 'conversation-a',
      ...input,
    });
  const inbound = (text, input = {}) =>
    coordinator.handleInbound({
      connectionId: 'account',
      chatId: 'chat',
      stableMessageRef: nextRef(),
      authorId: 'owner',
      text,
      isLive: true,
      isFromMe: true,
      isForwarded: false,
      isQuoted: false,
      isAgentEcho: false,
      ...input,
    });
  return { store, coordinator, calls, put, inbound, db, root };
};

test('wake parser matches exact case-insensitive prefix and recognizes only exact controls', () => {
  assert.equal(normalizeAgentAliasKey('  HＡＬ   Casa  '), 'hal casa');
  assert.deepEqual(parseAgentWakeMessage('  hAL: arregla esto', 'Hal'), { kind: 'task', text: 'arregla esto' });
  assert.deepEqual(parseAgentWakeMessage('HAL ON', 'Hal'), { kind: 'on' });
  assert.deepEqual(parseAgentWakeMessage('Hal OFF.', 'Hal'), { kind: 'off' });
  assert.deepEqual(parseAgentWakeMessage('Hal ON revisar', 'Hal'), { kind: 'task', text: 'ON revisar' });
  assert.equal(parseAgentWakeMessage('Halo: revisar', 'Hal'), null);
  assert.equal(parseAgentWakeMessage('revisar Hal', 'Hal'), null);
  assert.equal(parseAgentWakeMessage('Hal', 'Hal'), null);
  assert.equal(parseAgentWakeMessage('Hal:', 'Hal'), null);
  assert.equal(parseAgentWakeMessage('Hal: task', '  '), null);
  assert.equal(parseAgentWakeMessage('Hal-task', 'Hal'), null);
});

test('database aborts roll back binding, deletion, and admission as atomic operations', async () => {
  const { put, store, db } = await harness();
  db.exec(`CREATE TRIGGER reject_participant BEFORE INSERT ON whatsapp_agent_binding_participants
    BEGIN SELECT RAISE(ABORT, 'participant rejected'); END`);
  assert.throws(() => put({ participantsAllowed: ['member'] }), /participant rejected/);
  assert.equal(store.getBinding('account', 'chat', 'agent-a'), null);
  db.exec('DROP TRIGGER reject_participant');
  const binding = put({ enabled: true });
  db.exec(`CREATE TRIGGER reject_delete BEFORE DELETE ON whatsapp_agent_bindings
    BEGIN SELECT RAISE(ABORT, 'delete rejected'); END`);
  assert.throws(() => store.deleteBinding(binding), /delete rejected/);
  assert.deepEqual(store.getBinding('account', 'chat', 'agent-a'), binding);
  db.exec('DROP TRIGGER reject_delete');
  assert.equal(store.claimMessage('account', 'chat', 'atomic-ref'), 'new');
  db.exec(`CREATE TRIGGER reject_admission BEFORE UPDATE ON whatsapp_agent_seen_messages
    BEGIN SELECT RAISE(ABORT, 'admission rejected'); END`);
  assert.throws(() => store.prepareTurn(binding, binding.revision, 'atomic-turn', 'atomic-ref'), /admission rejected/);
  assert.equal(store.getBinding('account', 'chat', 'agent-a').revision, binding.revision);
  assert.equal(store.listUnsettledMessages()[0].state, 'pending');
  db.exec('DROP TRIGGER reject_admission');
});

test('binding validation and failed admission leave durable chat state unchanged', async () => {
  const { put, store } = await harness();
  for (const [change, code] of [
    [{ connectionId: ' ' }, 'connection_id_required'],
    [{ chatId: ' ' }, 'chat_id_required'],
    [{ agentId: ' ' }, 'agent_id_required'],
    [{ alias: ' ' }, 'alias_required'],
    [{ alias: 'x'.repeat(81) }, 'alias_invalid'],
    [{ alias: 'Hal\nOther' }, 'alias_invalid'],
    [{ ownerId: ' ' }, 'owner_id_required'],
    [{ expectedRevision: 1 }, 'binding_revision_conflict'],
  ]) {
    assert.throws(() => put(change), new RegExp(`whatsapp_agent_${code}`));
  }
  const binding = put({ enabled: true, participantsAllowed: ['member', ' member ', '', 'other'] });
  assert.deepEqual(binding.participantsAllowed, ['member', 'other']);
  assert.equal(store.prepareTurn(binding, binding.revision - 1, 'stale-turn', 'missing'), null);
  assert.equal(store.prepareTurn(binding, binding.revision, 'unclaimed-turn', 'missing'), null);
  assert.equal(store.getBinding('account', 'chat', 'agent-a').revision, binding.revision);
  assert.equal(store.claimMessage('account', 'chat', 'claimed'), 'new');
  const admitted = store.prepareTurn(binding, binding.revision, 'claimed-turn', 'claimed');
  assert.ok(admitted);
  assert.throws(() => store.recordRun(admitted, 'claimed-turn', admitted.revision, ' '), /run_id_required/);
  assert.equal(store.findTurnByTurnId('claimed-turn'), null);
  assert.equal(store.getDelivery(binding, 'missing'), null);
  assert.equal(store.claimDelivery(binding, 'claimed-turn', admitted.revision), true);
  assert.equal(store.claimDelivery(binding, 'claimed-turn', admitted.revision), false);
  assert.deepEqual(
    store.listUnsettledMessages().map((message) => message.state),
    ['admitting'],
  );
  assert.equal(store.transition(binding, binding.revision, false, null), null);
  assert.equal(store.deleteBinding(binding), true);
  assert.equal(store.deleteBinding(binding), false);
  assert.equal(store.getBinding('account', 'chat', 'agent-a'), null);
});

test('a committed binding read failure is surfaced explicitly', async () => {
  const { put, store } = await harness();
  const getBinding = store.getBinding.bind(store);
  let reads = 0;
  store.getBinding = (...args) => (++reads === 2 ? null : getBinding(...args));
  assert.throws(() => put(), /binding_not_saved/);
  store.getBinding = getBinding;
  assert.equal(store.getBinding('account', 'chat', 'agent-a')?.alias, 'Hal');
});

test('bindings persist across store instances and aliases are unique per connection across chats', async () => {
  const { db, put } = await harness();
  const first = put();
  assert.equal(first.revision, 1);
  assert.deepEqual(first.participantsAllowed, ['member']);
  const reloaded = new WhatsAppAgentChannelStore(db).getBinding('account', 'chat', 'agent-a');
  assert.deepEqual(reloaded, first);
  put({ chatId: 'other-chat' });
  assert.throws(() => put({ chatId: 'other-chat', agentId: 'agent-b', alias: 'hAL' }), /whatsapp_agent_alias_conflict/);
  const otherConnection = put({ connectionId: 'another-account', chatId: 'chat', agentId: 'agent-b', alias: 'hAL' });
  assert.equal(otherConnection.alias, 'hAL');
});

test('existing databases default chat capability access to off and persist explicit opt-in', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'forger-whatsapp-agent-legacy-'));
  const db = openPersonalAgentSqliteDatabase(path.join(root, 'channel.sqlite'));
  assert.ok(db);
  db.exec(`CREATE TABLE whatsapp_agent_bindings (
    connection_id TEXT NOT NULL, chat_id TEXT NOT NULL, agent_id TEXT NOT NULL,
    owner_id TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 0,
    purpose TEXT NOT NULL DEFAULT '', scope TEXT NOT NULL DEFAULT '',
    conversation_id TEXT, revision INTEGER NOT NULL DEFAULT 1, active_turn_id TEXT,
    PRIMARY KEY (connection_id, chat_id, agent_id)
  )`);
  const store = new WhatsAppAgentChannelStore(db);
  const base = {
    connectionId: 'account',
    chatId: 'chat',
    agentId: 'agent-a',
    alias: 'Hal',
    ownerId: 'owner',
    enabled: true,
    purpose: 'Help',
    scope: 'Here',
    participantsAllowed: [],
  };
  const initial = store.putBinding(base);
  assert.equal(initial.allowAgentCapabilities, false);
  const optedIn = store.putBinding({ ...base, allowAgentCapabilities: true, expectedRevision: initial.revision });
  assert.equal(new WhatsAppAgentChannelStore(db).getBinding('account', 'chat', 'agent-a').allowAgentCapabilities, true);
  const preserved = store.putBinding({ ...base, expectedRevision: optedIn.revision });
  assert.equal(preserved.allowAgentCapabilities, true);
});

test('changing a shared alias invalidates active turns in every bound chat', async () => {
  const { put, store } = await harness();
  put({ enabled: true });
  put({ chatId: 'other-chat', enabled: true });
  const other = store.getBinding('account', 'other-chat', 'agent-a');
  assert.equal(store.claimMessage('account', 'other-chat', 'other-ref'), 'new');
  const running = store.prepareTurn(other, other.revision, 'other-turn', 'other-ref');
  assert.ok(running);
  store.recordRun(running, 'other-turn', running.revision, 'other-run');
  const current = store.getBinding('account', 'chat', 'agent-a');
  put({ alias: 'New Hal', enabled: true, expectedRevision: current.revision });
  const updated = store.getBinding('account', 'other-chat', 'agent-a');
  assert.equal(updated.alias, 'New Hal');
  assert.equal(updated.activeTurnId, null);
  assert.ok(updated.revision > running.revision);
});

test('a stale settings edit cannot re-enable a binding after OFF', async () => {
  const { put, inbound, store } = await harness();
  const original = put({ enabled: true });
  assert.equal((await inbound('Hal OFF')).status, 'disabled');
  assert.throws(
    () => put({ enabled: true, expectedRevision: original.revision }),
    /whatsapp_agent_binding_revision_conflict/,
  );
  assert.equal(store.getBinding('account', 'chat', 'agent-a').enabled, false);
});

test('a binding cannot be enabled before its purpose is explicit', async () => {
  const { put, inbound, store } = await harness();
  assert.throws(() => put({ purpose: '', enabled: true }), /whatsapp_agent_purpose_required/);
  put({ purpose: '', enabled: false });
  assert.equal((await inbound('Hal ON')).status, 'purpose_required');
  assert.equal(store.getBinding('account', 'chat', 'agent-a').enabled, false);
});

test('owner-only controls require native own-message proof and ignore quoted, forwarded, history, echoes, and attachment-only', async () => {
  const { put, inbound, calls, store } = await harness();
  put();
  assert.equal((await inbound('Hal ON', { authorId: 'member', isFromMe: false })).status, 'unauthorized');
  assert.equal((await inbound('Hal ON', { isFromMe: false })).status, 'unauthorized');
  assert.equal((await inbound('Hal ON', { isQuoted: true })).status, 'ignored');
  assert.equal((await inbound('Hal ON', { isForwarded: true })).status, 'ignored');
  assert.equal((await inbound('Hal ON', { isLive: false })).status, 'ignored');
  assert.equal((await inbound('Hal ON', { isAgentEcho: true })).status, 'ignored');
  assert.equal((await inbound('', { hasAttachment: true })).status, 'ignored');
  assert.equal(store.getBinding('account', 'chat', 'agent-a').enabled, false);
  assert.equal((await inbound('Hal ON')).status, 'enabled');
  assert.equal(calls.start.length, 0);
});

test('deduplicates stable message refs and bounds context before invoking the selected agent', async () => {
  const { put, inbound, calls } = await harness();
  put({ enabled: true });
  const stableMessageRef = nextRef();
  const input = { stableMessageRef, authorId: 'member', isFromMe: false };
  const started = await inbound('HAL: fix the listing', input);
  assert.equal(started.status, 'started');
  assert.equal((await inbound('HAL: fix the listing', input)).status, 'duplicate');
  assert.equal(calls.start.length, 1);
  assert.equal(calls.start[0].binding.agentId, 'agent-a');
  assert.equal(calls.start[0].text, 'fix the listing');
  assert.equal(calls.start[0].authorId, 'member');
  assert.equal(calls.start[0].isFromMe, false);
  assert.equal(calls.context[0], 30);
  assert.ok(calls.start[0].context.length <= 30);
  assert.ok(calls.start[0].context.every((message) => message.text.length <= 1600));
  assert.ok(calls.start[0].context.reduce((total, message) => total + message.text.length, 0) <= 12_000);
  assert.equal(calls.start[0].context.at(-1).stableMessageRef, 'old-39');
});

test('a context read failure still admits the direct task once and records its run', async () => {
  const { put, inbound, calls, store, db } = await harness({
    readContext: async () => {
      throw new Error('history unavailable');
    },
  });
  put({ enabled: true });
  const result = await inbound('Hal: direct task');
  assert.equal(result.status, 'started');
  assert.deepEqual(calls.start[0].context, []);
  assert.equal(new WhatsAppAgentChannelStore(db).findTurnByRunId(calls.runIds[0])?.revision, result.revision);
  assert.equal(store.findTurnByRunId('unknown-run'), null);
});

test('replays a pending message before admission but quarantines an uncertain admission', async () => {
  const { put, inbound, calls, store } = await harness();
  put({ enabled: true });
  assert.equal(store.claimMessage('account', 'chat', 'pending-ref'), 'new');
  assert.equal((await inbound('Hal: recover', { stableMessageRef: 'pending-ref' })).status, 'started');
  assert.equal(calls.start.length, 1);
  assert.equal(store.claimMessage('account', 'chat', 'pending-ref'), 'duplicate');

  assert.equal(store.claimMessage('account', 'chat', 'uncertain-ref'), 'new');
  const binding = store.getBinding('account', 'chat', 'agent-a');
  assert.ok(store.prepareTurn(binding, binding.revision, 'uncertain-turn', 'uncertain-ref'));
  assert.equal(
    (await inbound('Hal: uncertain', { stableMessageRef: 'uncertain-ref' })).status,
    'reconciliation_required',
  );
  assert.equal(calls.start.length, 1);
  assert.deepEqual(
    store.listUnsettledMessages('account').map((message) => message.state),
    ['admitting'],
  );
});

test('a rejected admission leaves a durable interrupted request and frees the channel', async () => {
  const { put, inbound, calls, store } = await harness({
    startRun: async () => {
      throw new Error('admission rejected');
    },
  });
  put({ enabled: true });
  assert.equal((await inbound('Hal: original')).status, 'failed');
  assert.equal(store.getBinding('account', 'chat', 'agent-a').activeTurnId, null);
  assert.equal((await inbound('Hal: next')).status, 'failed');
  assert.equal(calls.steer.length, 0);
  assert.deepEqual(
    store.listActivity().map((r) => r.status),
    ['interrupted', 'interrupted'],
  );
});

test('routes distinct aliases to distinct agents in one chat and refuses unauthorized participant', async () => {
  const { put, inbound, calls } = await harness();
  put({ enabled: true });
  put({ agentId: 'agent-b', alias: 'Casa', conversationId: 'conversation-b', enabled: true });
  assert.equal((await inbound('Casa: review', { authorId: 'stranger', isFromMe: false })).status, 'unauthorized');
  assert.equal((await inbound('Casa: review', { authorId: 'member', isFromMe: false })).agentId, 'agent-b');
  assert.equal((await inbound('Hal: code', { authorId: 'member', isFromMe: false })).agentId, 'agent-a');
  assert.deepEqual(
    calls.start.map((item) => item.binding.agentId),
    ['agent-b', 'agent-a'],
  );
});

test('steer and OFF invalidate prior revisions and suppress stale completion', async () => {
  const { put, inbound, coordinator, calls, store } = await harness();
  put({ enabled: true });
  const first = await inbound('Hal: initial task');
  const second = await inbound(`Hal CORREGIR ${first.turnId} correction`);
  assert.equal(second.status, 'started');
  assert.equal(calls.steer.length, 0);
  assert.equal(calls.cancel[0].turnId, first.turnId);
  const firstRun = store.findTurnByRunId(calls.runIds[0]);
  assert.equal(firstRun?.turnId, first.turnId);
  assert.equal(store.findTurnByTurnId(first.turnId)?.runId, calls.runIds[0]);
  assert.equal(store.findTurnByRunId(calls.runIds[1])?.turnId, second.turnId);
  assert.equal(
    await coordinator.deliverCandidate({
      connectionId: 'account',
      chatId: 'chat',
      agentId: 'agent-a',
      turnId: first.turnId,
      revision: first.revision,
      text: 'old answer',
    }),
    'stale',
  );
  assert.equal((await inbound('Hal OFF')).status, 'disabled');
  assert.equal(calls.cancel.length, 2);
  assert.equal(calls.cancel[1].turnId, second.turnId);
  assert.equal(
    await coordinator.deliverCandidate({
      connectionId: 'account',
      chatId: 'chat',
      agentId: 'agent-a',
      turnId: second.turnId,
      revision: second.revision,
      text: 'late answer',
    }),
    'stale',
  );
  assert.equal(calls.send.length, 0);
  assert.equal(store.getBinding('account', 'chat', 'agent-a').enabled, false);
});

test('failed or canceled completion clears only its own active turn', async () => {
  const { put, inbound, coordinator, calls, store } = await harness();
  put({ enabled: true });
  const first = await inbound('Hal: start');
  const second = await inbound(`Hal CORREGIR ${first.turnId} correction`);
  assert.equal(await coordinator.settleWithoutReply(calls.runIds[0], 'failed'), 'stale');
  assert.equal(store.getBinding('account', 'chat', 'agent-a').activeTurnId, second.turnId);
  assert.equal(await coordinator.settleWithoutReply(calls.runIds[1], 'canceled'), 'settled');
  assert.equal(store.getBinding('account', 'chat', 'agent-a').activeTurnId, null);
  assert.equal(store.findTurnByRunId(calls.runIds[1]).status, 'canceled');
  assert.equal((await inbound('Hal: new work')).status, 'started');
  assert.notEqual(first.turnId, second.turnId);
});

test('final delivery is claimed once before sending and an uncertain send is never retried automatically', async () => {
  const { put, inbound, coordinator, calls, store } = await harness();
  put({ enabled: true });
  const started = await inbound('Hal: do work');
  const candidate = {
    connectionId: 'account',
    chatId: 'chat',
    agentId: 'agent-a',
    turnId: started.turnId,
    revision: started.revision,
    text: 'Done',
  };
  assert.equal(await coordinator.deliverCandidate(candidate), 'sent');
  assert.equal(await coordinator.deliverCandidate(candidate), 'duplicate');
  assert.equal(calls.send.length, 1);
  assert.equal(store.getLatestDelivery(candidate)?.state, 'sent');

  const failing = await harness({
    sendReply: async () => {
      throw new Error('transport timeout');
    },
  });
  failing.put({ enabled: true });
  const next = await failing.inbound('Hal: another task');
  const uncertain = { ...candidate, turnId: next.turnId, revision: next.revision };
  assert.equal(await failing.coordinator.deliverCandidate(uncertain), 'unknown');
  assert.equal(await failing.coordinator.deliverCandidate(uncertain), 'duplicate');
  assert.equal(failing.store.getLatestDelivery(uncertain)?.state, 'unknown');
});

test('a rejected reply is marked failed and unknown run settlement is inert', async () => {
  const { put, inbound, coordinator, store } = await harness({
    sendReply: async () => ({ sent: false, definiteFailure: true }),
  });
  put({ enabled: true });
  const started = await inbound('Hal: review');
  const candidate = {
    connectionId: 'account',
    chatId: 'chat',
    agentId: 'agent-a',
    turnId: started.turnId,
    revision: started.revision,
    text: 'Could not send',
  };
  assert.equal(await coordinator.deliverCandidate(candidate), 'failed');
  assert.equal(store.getDelivery(candidate, started.turnId).state, 'failed');
  assert.equal(store.getBinding('account', 'chat', 'agent-a').activeTurnId, null);
  assert.equal(await coordinator.deliverCandidate(candidate), 'duplicate');
  assert.equal(await coordinator.settleWithoutReply('missing-run', 'failed'), 'unknown');
});

test('a competing activation leaves the request queued without starting an agent', async () => {
  const { put, inbound, store, calls } = await harness();
  const binding = put({ enabled: true });
  store.activateRequest = () => null;
  assert.equal((await inbound('Hal: direct task')).status, 'queued');
  assert.equal(store.getBinding('account', 'chat', 'agent-a').revision, binding.revision);
  assert.equal(calls.start.length, 0);
});

test('OFF remains safe when already disabled and still invalidates a run when cancellation fails', async () => {
  const { put, inbound, coordinator, store } = await harness();
  put();
  assert.equal((await inbound('Hal OFF')).status, 'disabled');
  put({ enabled: true, expectedRevision: 1 });
  const started = await inbound('Hal: run');
  coordinator.ports.cancelRun = async () => {
    throw new Error('runner already gone');
  };
  assert.equal((await inbound('Hal OFF')).status, 'disabled');
  assert.equal(store.getBinding('account', 'chat', 'agent-a').enabled, false);
  assert.equal(
    await coordinator.deliverCandidate({
      connectionId: 'account',
      chatId: 'chat',
      agentId: 'agent-a',
      turnId: started.turnId,
      revision: started.revision,
      text: 'late',
    }),
    'stale',
  );
});

test('activation checks current binding and purpose before admitting work', async () => {
  const { put, inbound, store, calls, db } = await harness();
  put();
  assert.equal((await inbound('ordinary conversation')).status, 'ignored');
  assert.equal((await inbound('Hal: task')).status, 'inactive');
  assert.equal((await inbound('Hal ON')).status, 'enabled');
  assert.equal((await inbound('Hal ON')).status, 'enabled');
  db.prepare(
    'UPDATE whatsapp_agent_bindings SET purpose = ? WHERE connection_id = ? AND chat_id = ? AND agent_id = ?',
  ).run('', 'account', 'chat', 'agent-a');
  assert.equal((await inbound('Hal: task')).status, 'purpose_required');
  assert.equal(calls.start.length, 0);

  const getBinding = store.getBinding.bind(store);
  store.getBinding = () => null;
  assert.equal((await inbound('Hal OFF')).status, 'ignored');
  store.getBinding = (...args) => ({ ...getBinding(...args), alias: 'Other' });
  assert.equal((await inbound('Hal OFF')).status, 'ignored');
  store.getBinding = getBinding;
});

test('untrusted context is normalized and a prior delivery suppresses sending', async () => {
  const { put, inbound, coordinator, store, calls } = await harness({
    readContext: async () => [
      { stableMessageRef: 'invalid', authorId: 'sender', text: 7 },
      { stableMessageRef: null, authorId: null, text: 'context' },
    ],
  });
  put({ enabled: true });
  const started = await inbound('Hal: work');
  assert.deepEqual(calls.start[0].context, [{ stableMessageRef: '', authorId: '', text: 'context' }]);
  const candidate = {
    connectionId: 'account',
    chatId: 'chat',
    agentId: 'agent-a',
    turnId: started.turnId,
    revision: started.revision,
    text: 'done',
  };
  store.claimDelivery(candidate, started.turnId, started.revision);
  assert.equal(await coordinator.deliverCandidate(candidate), 'duplicate');
  assert.equal(calls.send.length, 0);
  coordinator.ports.readContext = undefined;
  assert.equal((await inbound(`Hal CORREGIR ${started.turnId} correction`)).status, 'started');
  assert.deepEqual(calls.start[1].context, []);
});

test('request reservation and completion roll back together when SQLite rejects either side', async () => {
  const { put, store, db } = await harness();
  const binding = put({ enabled: true });
  const request = {
    ...binding,
    requestId: 'request',
    runId: 'run',
    requestText: 'work',
    authorId: 'member',
    isFromMe: false,
    createdAt: '2026-09-26T12:00:00.000Z',
    updatedAt: '2026-09-26T12:00:00.000Z',
    stableMessageRef: 'request-ref',
  };
  store.claimMessage('account', 'chat', 'request-ref');
  db.exec(
    `CREATE TRIGGER reject_queue BEFORE INSERT ON whatsapp_agent_requests BEGIN SELECT RAISE(ABORT,'no queue'); END`,
  );
  assert.throws(() => store.queueRequest(request), /no queue/);
  assert.equal(store.listActivity().length, 0);
  db.exec('DROP TRIGGER reject_queue');
  store.queueRequest(request);
  db.exec(`CREATE TRIGGER reject_run BEFORE INSERT ON whatsapp_agent_turns BEGIN SELECT RAISE(ABORT,'no run'); END`);
  assert.throws(() => store.activateRequest(store.listActivity()[0], binding), /no run/);
  assert.equal(store.getBinding('account', 'chat', 'agent-a').activeTurnId, null);
  assert.equal(store.listActivity()[0].status, 'queued');
  db.exec('DROP TRIGGER reject_run');
  const active = store.activateRequest(store.listActivity()[0], binding);
  assert.equal(store.activateRequest(store.listActivity()[0], binding), null);
  db.exec(
    `CREATE TRIGGER reject_finish BEFORE UPDATE OF active_turn_id ON whatsapp_agent_bindings BEGIN SELECT RAISE(ABORT,'no finish'); END`,
  );
  assert.throws(
    () => store.settleRequest(binding, 'request', active.revision, { status: 'completed', deliveryState: 'pending' }),
    /no finish/,
  );
  assert.equal(store.listActivity()[0].status, 'active');
  assert.equal(store.getBinding('account', 'chat', 'agent-a').activeTurnId, 'request');
  db.exec('DROP TRIGGER reject_finish');
  store.settleRequest(binding, 'request', active.revision, { status: 'completed', deliveryState: 'pending' });
  assert.equal(store.getBinding('account', 'chat', 'agent-a').activeTurnId, null);
});

test('explicit policy roundtrips empty account selections, default-account grants and file metadata', async () => {
  const { put, store, db } = await harness();
  const policy = {
    appIds: [],
    toolIds: [],
    peerAgentIds: [],
    networkAccess: false,
    sharedMemoryIds: [],
    connectionGrants: [
      { type: 'gmail', actions: ['read'], multiple: false },
      { type: 'whatsapp', actions: ['read', 'send'], multiple: true, connectionIds: [] },
    ],
    sharedFiles: [{ id: 'file', path: 'relative.txt' }],
  };
  const binding = put({ policy });
  assert.deepEqual(new WhatsAppAgentChannelStore(db).getBinding('account', 'chat', 'agent-a').policy, policy);
  assert.throws(
    () =>
      put({
        policy: { ...policy, sharedFiles: [{ path: 'untrusted' }] },
        expectedConfigurationVersion: binding.configurationVersion,
      }),
    /shared_file_id_required/,
  );
  assert.deepEqual(store.getBinding('account', 'chat', 'agent-a').policy, policy);
  assert.throws(() => store.setEnabled({ ...binding, chatId: 'missing' }, false), /not_found/);
  assert.throws(() => store.updateAlias('account', 'agent-a', 'bad\nalias'), /alias_invalid/);
  assert.throws(() => store.updateAlias('account', 'agent-a', 'x'.repeat(81)), /alias_invalid/);
  const empty = put({ chatId: 'empty', purpose: '' });
  assert.throws(() => store.setEnabled(empty, true), /purpose_required/);
});

test('revoked queued authors cannot run, completed requests cannot be corrected and ON preserves current work', async () => {
  const { put, inbound, store, coordinator, calls } = await harness();
  let binding = put({ enabled: true });
  const first = await inbound('Hal first', { authorId: 'member', isFromMe: false });
  const second = await inbound('Hal second', { authorId: 'member', isFromMe: false });
  assert.equal((await inbound('Hal ON')).status, 'enabled');
  assert.equal(calls.cancel.length, 0);
  const active = store.getBinding('account', 'chat', 'agent-a');
  // Revoke audience atomically while leaving the existing execution for its terminal reconciliation.
  store.db.prepare('DELETE FROM whatsapp_agent_binding_participants').run();
  assert.equal(await coordinator.settleWithoutReply(calls.runIds[0], 'failed'), 'settled');
  assert.equal(store.listActivity()[1].status, 'canceled');
  assert.equal((await inbound(`Hal CORREGIR ${first.turnId} revise`)).status, 'failed');
  assert.equal((await inbound(`Hal CORREGIR ${second.turnId} revise`)).status, 'failed');
  binding = store.getBinding('account', 'chat', 'agent-a');
  await coordinator.setEnabled(binding, false);
  assert.equal((await coordinator.setEnabled(binding, true)).enabled, true);
  assert.throws(() => put({ expectedConfigurationVersion: 999 }), /revision_conflict/);
  assert.throws(() => put({ chatId: 'new', expectedConfigurationVersion: 999 }), /revision_conflict/);
  assert.equal(store.transition(active, -1, false, null), null);
  const updated = store.getBinding('account', 'chat', 'agent-a');
  assert.ok(store.transition(updated, updated.revision, true, null));
  coordinator.close();
  await coordinator.resume();
});

test('resume dispatches persisted safe outbox work and a closed sender never retries an uncertain attempt', async () => {
  for (const reject of [false, true]) {
    let finish;
    const { put, inbound, store, coordinator } = await harness({
      sendReply: async () =>
        new Promise((resolve, rejectPromise) => {
          finish = () => (reject ? rejectPromise(new Error('lost')) : resolve({ sent: true }));
        }),
    });
    const binding = put({ enabled: true });
    const active = await inbound('Hal run');
    const candidate = { ...binding, turnId: active.turnId, revision: active.revision, text: 'answer' };
    const delivery = coordinator.deliverCandidate(candidate);
    while (!finish) await new Promise((resolve) => setImmediate(resolve));
    coordinator.close();
    finish();
    assert.equal(await delivery, 'unknown');
    const next = new WhatsAppAgentChannelCoordinator(store, {
      startRun: async (input) => ({ runId: input.runId }),
      cancelRun: async () => {},
      sendReply: async () => ({ sent: true }),
    });
    // Unknown remains untouched after reopening; only explicitly proven unsent work is pending.
    await next.resume();
    assert.equal(store.listActivity()[0].deliveryState, 'unknown');
    store.updateRequest(active.turnId, { deliveryState: 'pending' });
    store.reserveSend('account', 0);
    await next.resume();
    assert.equal(store.listActivity()[0].deliveryState, 'sent');
    next.close();
  }
});

test('mismatched admission is quarantined and queued missing-author requests are rejected at resumption', async () => {
  const { put, inbound, store, coordinator } = await harness({ startRun: async () => ({ runId: 'unexpected-run' }) });
  const binding = put({ enabled: true });
  assert.equal((await inbound('Hal run')).status, 'failed');
  const now = new Date().toISOString();
  store.queueRequest({
    ...binding,
    requestId: 'missing-author',
    runId: 'missing-run',
    requestText: 'never run',
    authorId: null,
    isFromMe: false,
    createdAt: now,
    updatedAt: now,
    stableMessageRef: 'missing-ref',
  });
  await coordinator.resume();
  assert.equal(store.listActivity()[1].reason, 'participant_access_removed');
  await assert.rejects(() => coordinator.dismissRequest(binding, 'missing'), /not_dismissible/);
});

test('explicit cancellation remains durable when the runner process already disappeared', async () => {
  const { put, inbound, coordinator, store } = await harness();
  const binding = put({ enabled: true });
  assert.equal(store.getLatestDelivery(binding), null);
  const task = await inbound('Hal work');
  coordinator.ports.cancelRun = async () => {
    throw new Error('already exited');
  };
  await coordinator.cancelRequest(binding, task.turnId);
  assert.equal(store.listActivity()[0].status, 'canceled');
  const policy = {
    appIds: [],
    toolIds: [],
    peerAgentIds: [],
    networkAccess: false,
    sharedMemoryIds: [],
    connectionGrants: [],
  };
  put({ policy });
  assert.deepEqual(store.getBinding('account', 'chat', 'agent-a').policy.sharedFiles, []);
});

test('outbox rechecks current availability and never sends an absent persisted response', async () => {
  const { put, inbound, coordinator, store, calls } = await harness();
  const binding = put({ enabled: true });
  const task = await inbound('Hal work');
  store.settleRequest(binding, task.turnId, task.revision, {
    status: 'completed',
    deliveryState: 'pending',
    responseText: null,
  });
  const get = store.getBinding.bind(store);
  let reads = 0;
  store.getBinding = (...args) => (++reads === 2 ? null : get(...args));
  await coordinator.outbox.flushAccount('account');
  assert.equal(calls.send.length, 0);
  store.getBinding = get;
  await coordinator.outbox.flushAccount('account');
  assert.equal(store.listActivity()[0].reason, 'response_missing');
  assert.equal(calls.send.length, 0);
  await assert.rejects(() => coordinator.retryDelivery(binding, task.turnId), /not_retryable/);
  coordinator.close();
  await coordinator.outbox.flushAccount('account');
});

test('CORREGIR MI ULTIMA identifies only the invoking authors latest unfinished request without needing a UUID', async () => {
  const { put, inbound, store, calls } = await harness();
  put({ enabled: true, participantsAllowed: ['alice', 'bob'] });
  assert.equal(
    (await inbound('Hal CORREGIR MI ULTIMA no task', { authorId: 'alice', isFromMe: false })).status,
    'ignored',
  );
  const first = await inbound('Hal task alice', { authorId: 'alice', isFromMe: false });
  const second = await inbound('Hal task bob', { authorId: 'bob', isFromMe: false });
  assert.equal(
    (await inbound('Hal CORREGIR MI ÚLTIMA revised bob', { authorId: 'bob', isFromMe: false })).status,
    'queued',
  );
  assert.equal(store.listActivity()[0].requestText, 'task alice');
  assert.equal(store.listActivity()[1].requestText, 'revised bob');
  assert.equal(store.listActivity()[1].requestId, second.turnId);
  assert.equal(calls.cancel.length, 0);
  assert.equal((await inbound('Hal CORREGIR MI ULTIMA owner has no task')).status, 'ignored');
  await inbound('Hal CORREGIR MI ULTIMA revised alice', { authorId: 'alice', isFromMe: false });
  assert.equal(calls.cancel[0].turnId, first.turnId);
  assert.equal(store.listActivity()[1].status, 'active');
  assert.equal(store.listActivity()[2].requestText, 'revised alice');
  assert.equal(store.listActivity()[2].status, 'queued');
});

test('native owner proof authorizes a task without sender metadata and latest-own correction preserves that ownership', async () => {
  const { put, inbound, store } = await harness();
  put({ enabled: true });
  assert.equal((await inbound('Hal work', { authorId: undefined })).status, 'started');
  assert.equal(store.listActivity()[0].authorId, null);
  assert.equal((await inbound('Hal CORREGIR MI ULTIMA revised', { authorId: undefined })).status, 'started');
  assert.equal(store.listActivity()[0].status, 'canceled');
  assert.equal(store.listActivity()[1].isFromMe, true);
});

test('mentions use the same exact alias and control boundaries as plain invocations', () => {
  for (const prefix of ['Kupita', '@kupita', '@KUPITA']) {
    assert.deepEqual(parseAgentWakeMessage(`${prefix}: hola`, 'Kupita'), { kind: 'task', text: 'hola' });
    assert.deepEqual(parseAgentWakeMessage(`${prefix} ON`, 'Kupita'), { kind: 'on' });
    assert.deepEqual(parseAgentWakeMessage(`${prefix} OFF.`, 'Kupita'), { kind: 'off' });
    assert.deepEqual(parseAgentWakeMessage(`${prefix} CORREGIR MI ÚLTIMA cambio`, 'Kupita'), { kind: 'correct-own', text: 'cambio' });
    assert.deepEqual(parseAgentWakeMessage(`${prefix} CORREGIR abc cambio`, 'Kupita'), { kind: 'correct', requestId: 'abc', text: 'cambio' });
  }
  for (const text of ['@kupitabot hola', '@@kupita hola', '@kupita', '@kupita.com hola'])
    assert.equal(parseAgentWakeMessage(text, 'Kupita'), null);
});

test('group access admits everyone explicitly while owner-only controls and author-bound corrections remain enforced', async (t) => {
  const h = await harness();
  t.after(() => { h.coordinator.close(); h.db.close(); });
  const key = { chatId: 'group@g.us', participantAccess: 'all', participantsAllowed: [], enabled: true };
  h.put(key);
  const member = { chatId: key.chatId, isFromMe: false, authorId: 'new-member' };
  assert.equal((await h.inbound('@HAL first', member)).status, 'started');
  assert.equal((await h.inbound('@hal OFF', member)).status, 'unauthorized');
  assert.equal((await h.inbound('@hal second', { ...member, authorId: 'another' })).status, 'queued');
  const first = h.store.listActivity()[0];
  assert.equal((await h.inbound(`@hal CORREGIR ${first.requestId} stolen`, { ...member, authorId: 'another' })).status, 'unauthorized');
  for (const authorId of [undefined, '', '   '])
    assert.equal((await h.inbound('@hal missing identity', { ...member, authorId })).status, 'unauthorized');
  h.put({ ...key, participantAccess: 'selected', participantsAllowed: ['new-member'] });
  await h.coordinator.resume();
  assert.equal(h.store.listActivity()[1].reason, 'participant_access_removed');
  assert.equal((await h.inbound('@hal excluded', { ...member, authorId: 'another' })).status, 'unauthorized');
  h.put({ ...key, participantAccess: 'owner', participantsAllowed: ['new-member'] });
  assert.equal((await h.inbound('@hal excluded', member)).status, 'unauthorized');
  assert.equal((await h.inbound('@hal owner', { chatId: key.chatId })).status, 'started');
});

test('participant access validates groups and explicit selection, persists and safely migrates legacy bindings', async (t) => {
  const h = await harness();
  t.after(() => { h.coordinator.close(); h.db.close(); });
  assert.throws(() => h.put({ participantAccess: 'all' }), /participant_access_invalid/);
  assert.throws(() => h.put({ participantAccess: 'selected', participantsAllowed: [] }), /participants_required/);
  assert.throws(() => h.put({ participantAccess: 'invalid' }), /participant_access_invalid/);
  assert.equal(h.put({ participantsAllowed: [] }).participantAccess, 'owner');
  assert.equal(h.put().participantAccess, 'selected');
  h.put({ chatId: 'group@g.us', participantAccess: 'all', participantsAllowed: [] });
  const reopened = new WhatsAppAgentChannelStore(h.db);
  assert.equal(reopened.getBinding('account', 'group@g.us', 'agent-a').participantAccess, 'all');
  h.db.exec('ALTER TABLE whatsapp_agent_bindings DROP COLUMN participant_access');
  const migrated = new WhatsAppAgentChannelStore(h.db);
  assert.equal(migrated.getBinding('account', 'chat', 'agent-a').participantAccess, 'selected');
  assert.equal(migrated.getBinding('account', 'group@g.us', 'agent-a').participantAccess, 'owner');
});

test('trusted chat identities select one active binding and participant identities reauthorize queued work', async (t) => {
  let identities = true;
  const h = await harness({ resolveIdentityIds: async (_account, id) =>
    identities && ['member@lid', 'member@s.whatsapp.net'].includes(id) ? ['member@lid', 'member@s.whatsapp.net'] : [id] });
  t.after(() => { h.coordinator.close(); h.db.close(); });
  h.put({ chatId: 'self@s.whatsapp.net', enabled: false });
  h.put({ chatId: 'self@lid', enabled: true });
  const chatIdentityIds = ['self@s.whatsapp.net', 'self@lid'];
  const message = { chatId: 'self@s.whatsapp.net', chatIdentityIds };
  assert.equal((await h.inbound('@hal owner', message)).status, 'started');
  assert.equal(h.calls.start[0].binding.chatId, 'self@lid');
  h.put({ chatId: 'self@s.whatsapp.net', enabled: true });
  assert.equal((await h.inbound('@hal ambiguous', message)).status, 'ignored');
  h.put({ chatId: 'group@g.us', enabled: true, participantAccess: 'selected', participantsAllowed: ['member@s.whatsapp.net'] });
  const member = { chatId: 'group@g.us', isFromMe: false, authorId: 'member@lid' };
  assert.equal((await h.inbound('@hal first', member)).status, 'started');
  assert.equal((await h.inbound('@hal second', member)).status, 'queued');
  const [first, second] = h.store.listActivity().filter(r => r.chatId === 'group@g.us');
  assert.equal((await h.inbound(`@hal CORREGIR ${second.requestId} correction`, { ...member, authorId: 'member@s.whatsapp.net' })).status, 'queued');
  identities = false;
  await h.coordinator.cancelRequest(first, first.requestId);
  assert.equal(h.store.listActivity().find(r => r.requestId === second.requestId).reason, 'participant_access_removed');
});

test('trusted equivalent message copies deduplicate on one binding while preserving original stable references', async (t) => {
  const h = await harness();
  t.after(() => { h.coordinator.close(); h.db.close(); });
  h.put({ chatId: 'self@lid', enabled: true });
  const identities = { chatIdentityIds: ['self@s.whatsapp.net', 'self@lid'], equivalentStableMessageRefs: ['phone-ref', 'lid-ref'] };
  const [first, second] = await Promise.all([
    h.inbound('@hal task', { ...identities, chatId: 'self@s.whatsapp.net', stableMessageRef: 'phone-ref' }),
    h.inbound('@hal task', { ...identities, chatId: 'self@lid', stableMessageRef: 'lid-ref' }),
  ]);
  assert.equal(first.status, 'started');
  assert.equal(second.status, 'duplicate');
  assert.equal(h.calls.start.length, 1);
  assert.equal(h.store.listActivity()[0].stableMessageRef, 'phone-ref');
  // A pre-admission pending claim may retry; an ambiguous legacy admission must reconcile instead.
  h.store.claimMessage('account', 'self@s.whatsapp.net', 'pending-phone');
  assert.equal((await h.inbound('@hal pending', { ...identities, chatId: 'self@lid', stableMessageRef: 'pending-lid',
    equivalentStableMessageRefs: ['pending-phone', 'pending-lid'] })).status, 'queued');
  h.store.claimMessage('account', 'self@s.whatsapp.net', 'admitting-phone');
  h.db.prepare("UPDATE whatsapp_agent_seen_messages SET state='admitting' WHERE stable_message_ref=?").run('admitting-phone');
  assert.equal((await h.inbound('@hal ambiguous', { ...identities, chatId: 'self@lid', stableMessageRef: 'admitting-lid',
    equivalentStableMessageRefs: ['admitting-phone', 'admitting-lid'] })).status, 'reconciliation_required');
});

test('participant access migration rolls back schema and values if preserving legacy grants fails', async (t) => {
  const h = await harness();
  t.after(() => { h.coordinator.close(); h.db.close(); });
  h.put();
  h.db.exec(`ALTER TABLE whatsapp_agent_bindings DROP COLUMN participant_access;
    CREATE TRIGGER fail_access_migration BEFORE UPDATE ON whatsapp_agent_bindings BEGIN
    SELECT RAISE(ABORT, 'migration blocked'); END;`);
  assert.throws(() => new WhatsAppAgentChannelStore(h.db), /migration blocked/);
  assert.equal(h.db.prepare('PRAGMA table_info(whatsapp_agent_bindings)').all().some(c => c.name === 'participant_access'), false);
  h.db.exec('DROP TRIGGER fail_access_migration');
  assert.equal(new WhatsAppAgentChannelStore(h.db).getBinding('account', 'chat', 'agent-a').participantAccess, 'selected');
});

test('identity lookup failure keeps the explicit participant restriction and owner access', async (t) => {
  const h = await harness({ resolveIdentityIds: async () => { throw new Error('offline'); } });
  t.after(() => { h.coordinator.close(); h.db.close(); });
  h.put({ enabled: true });
  assert.equal((await h.inbound('@hal task', { isFromMe: false, authorId: 'unknown' })).status, 'unauthorized');
  assert.equal((await h.inbound('@hal task', { isFromMe: false, authorId: 'member' })).status, 'started');
  assert.equal((await h.inbound('@hal OFF', { authorId: undefined })).status, 'disabled');
  assert.equal((await h.inbound('@hal ON')).status, 'enabled');
});

test('concurrent owner ON commands cannot activate both trusted identities of the same chat', async (t) => {
  const h = await harness({ resolveIdentityIds: async (_account, id) =>
    id.startsWith('self@') ? ['self@lid', 'self@s.whatsapp.net'] : [id] });
  t.after(() => { h.coordinator.close(); h.db.close(); });
  h.put({ chatId: 'self@lid', enabled: false });
  h.put({ chatId: 'self@s.whatsapp.net', enabled: false });
  const results = await Promise.all(['self@lid', 'self@s.whatsapp.net'].map(chatId =>
    h.inbound('@hal ON', { chatId, chatIdentityIds: ['self@lid', 'self@s.whatsapp.net'] })));
  assert.deepEqual(results.map(r => r.status).sort(), ['enabled', 'failed']);
  assert.equal(h.store.listBindings().filter(b => b.enabled).length, 1);
});

test('pause during queued identity authorization prevents a run from starting', async (t) => {
  let release;
  let lookups = 0;
  const h = await harness({ resolveIdentityIds: async (_account, id) => {
    if (++lookups === 2) await new Promise(resolve => { release = resolve; });
    return [id];
  } });
  t.after(() => { h.coordinator.close(); h.db.close(); });
  const binding = h.put({ enabled: true });
  const pending = h.inbound('@hal task');
  while (!release) await new Promise(resolve => setImmediate(resolve));
  await h.coordinator.setEnabled(binding, false);
  release();
  await pending;
  assert.equal(h.calls.start.length, 0);
});

test('owner controls propagate storage failures rather than claiming activation succeeded', async (t) => {
  const h = await harness();
  t.after(() => { h.coordinator.close(); h.db.close(); });
  h.put({ enabled: false });
  h.db.exec(`CREATE TRIGGER reject_channel_enable BEFORE UPDATE ON whatsapp_agent_bindings BEGIN
    SELECT RAISE(ABORT, 'storage failure'); END;`);
  await assert.rejects(() => h.inbound('@hal ON'), /storage failure/);
  assert.equal(h.store.listBindings()[0].enabled, false);
});

test('legacy participant policy is owner-only unless an explicit allowlist exists', () => {
  const { participantCanInvoke } = require('../../dist-electron/main/personal-agents/whatsapp-channel/participant-access.js');
  assert.equal(participantCanInvoke({ participantsAllowed: [] }, false, 'member'), false);
  assert.equal(participantCanInvoke({ participantsAllowed: ['member'] }, false, 'member'), true);
  assert.equal(participantCanInvoke({ participantAccess: 'all', participantsAllowed: [], chatId: 'direct@s.whatsapp.net' }, false, 'member'), false);
});

test('inline mentions preserve context and use the first addressed agent, one task per message', async () => {
  const h = await harness({ readContext: async () => [{ stableMessageRef: 'prior', authorId: 'member', text: 'Estoy en Santiago' }] });
  h.put({ alias: 'Kupita', enabled: true });
  h.put({ agentId: 'agent-b', alias: 'Kupita Casa', enabled: true, conversationId: 'conversation-b' });
  const text = 'revisa como está el clima, y luego @kupita dime que poleron ponerme; @Kupita Casa espera';
  const result = await h.inbound(text, { stableMessageRef: 'inline-once' });
  assert.equal(result.status, 'started');
  assert.equal(result.agentId, 'agent-a');
  assert.equal(h.calls.start[0].text, text);
  assert.deepEqual(h.calls.start[0].context, [{ stableMessageRef: 'prior', authorId: 'member', text: 'Estoy en Santiago' }]);
  assert.equal((await h.inbound(text, { stableMessageRef: 'inline-once' })).status, 'duplicate');
  assert.equal(h.calls.start.length, 1);
  assert.equal((await h.inbound('Revisa @Kupita Casa y luego @kupita')).agentId, 'agent-b');
});

test('inline mentions retain participant, pause, provenance and command safety checks', async () => {
  const h = await harness();
  h.put({ alias: 'Kupita', enabled: true });
  assert.equal((await h.inbound('Revisa @kupita esto', { authorId: 'stranger', isFromMe: false })).status, 'unauthorized');
  for (const override of [{ isForwarded: true }, { isLive: false }, { isAgentEcho: true }]) {
    assert.equal((await h.inbound('Revisa @kupita esto', override)).status, 'ignored');
  }
  const own = await h.inbound('Revisa @kupita esto', { authorId: 'member', isFromMe: false });
  assert.equal(own.status, 'started');
  for (const suffix of ['OFF', 'ON', `CORREGIR ${own.turnId} cambio`, 'CORREGIR MI ÚLTIMA cambio']) {
    assert.equal((await h.inbound(`Analiza @kupita ${suffix}`, { authorId: 'member', isFromMe: false })).status, 'queued');
  }
  assert.equal((await h.inbound('@kupita! OFF')).status, 'queued');
  assert.equal(h.calls.cancel.length, 0);
  assert.equal(h.store.getBinding('account', 'chat', 'agent-a').enabled, true);
  assert.equal((await h.inbound('@kupita OFF')).status, 'disabled');
  assert.equal((await h.inbound('Revisa @kupita esto')).status, 'inactive');
});
