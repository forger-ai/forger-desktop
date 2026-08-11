import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { AgentRoutineManager } = require('../../dist-electron/main/personal-agents/agent-routine-manager.js');

let sequence = 0;
const makeRoutine = (overrides = {}) => ({
  id: overrides.id ?? `routine-${++sequence}`,
  agentId: overrides.agentId ?? 'agent-1',
  conversationId: overrides.conversationId ?? 'conversation-1',
  name: 'Daily review',
  prompt: 'Review the queue.',
  frequency: { type: 'hourly' },
  missedRunPolicy: 'within_window',
  missedRunWindowMinutes: 30,
  enabled: false,
  running: false,
  nextRunAt: null,
  authorizationText: 'Approved',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

const makeConversation = (overrides = {}) => ({
  id: overrides.id ?? 'conversation-1',
  agentId: overrides.agentId ?? 'agent-1',
  title: 'Routine',
  origin: 'routine',
  messages: [],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

const makeWakeup = (overrides = {}) => ({
  id: overrides.id ?? `wakeup-${++sequence}`,
  agentId: overrides.agentId ?? 'agent-1',
  conversationId: overrides.conversationId ?? 'conversation-1',
  prompt: 'Wake up.',
  dueAt: new Date(Date.now() + 60_000).toISOString(),
  status: 'scheduled',
  createdByRunId: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

const createHarness = (overrides = {}) => {
  const calls = [];
  const routines = new Map((overrides.routines ?? []).map((routine) => [routine.id, routine]));
  const conversations = new Map((overrides.conversations ?? []).map((conversation) => [conversation.id, conversation]));
  const runs = new Map();
  const wakeups = new Map((overrides.wakeups ?? []).map((wakeup) => [wakeup.id, wakeup]));
  const store = {
    async listAgents() { return overrides.agents ?? [{ id: 'agent-1' }]; },
    async listRoutines(agentId) {
      calls.push(['listRoutines', agentId]);
      return [...routines.values()].filter((routine) => routine.agentId === agentId);
    },
    async listScheduledWakeups() { return [...wakeups.values()].filter((item) => item.status === 'scheduled'); },
    async getRoutine(id) { return overrides.getRoutine ? overrides.getRoutine(id, routines) : routines.get(id) ?? null; },
    async requireRoutine(id) {
      const routine = routines.get(id);
      if (!routine) throw new Error('personal_agent_routine_not_found');
      return routine;
    },
    async getConversation(id) {
      if (overrides.getConversation) return overrides.getConversation(id, conversations);
      return conversations.get(id) ?? null;
    },
    async requireConversation(id) {
      const conversation = conversations.get(id);
      if (!conversation) throw new Error('personal_agent_conversation_not_found');
      return conversation;
    },
    async createRoutine(input) {
      calls.push(['createRoutine', input]);
      const routine = makeRoutine({
        ...input,
        id: 'created-routine',
        conversationId: 'created-conversation',
      });
      routines.set(routine.id, routine);
      conversations.set(routine.conversationId, makeConversation({ id: routine.conversationId, agentId: routine.agentId }));
      return routine;
    },
    async updateRoutine(input) {
      calls.push(['updateRoutine', input]);
      const routine = { ...routines.get(input.routineId), ...input, id: input.routineId };
      routines.set(routine.id, routine);
      return routine;
    },
    async setRoutineEnabled(input) {
      calls.push(['setRoutineEnabled', input]);
      const routine = { ...routines.get(input.routineId), enabled: input.enabled, nextRunAt: input.nextRunAt };
      routines.set(routine.id, routine);
      return routine;
    },
    async deleteRoutine(id) {
      calls.push(['deleteRoutine', id]);
      routines.delete(id);
      return { success: true };
    },
    async createRoutineRun(input) {
      const run = {
        id: `run-${++sequence}`,
        routineId: input.routineId,
        agentId: routines.get(input.routineId)?.agentId ?? 'agent-1',
        conversationId: routines.get(input.routineId)?.conversationId ?? 'conversation-1',
        trigger: input.trigger,
        status: input.status ?? 'queued',
        startedAt: '2026-01-01T00:00:00.000Z',
        ...(input.error ? { error: input.error } : {}),
      };
      calls.push(['createRoutineRun', input, run]);
      runs.set(run.id, run);
      return run;
    },
    async updateRoutineRun(input) {
      calls.push(['updateRoutineRun', input]);
      if (overrides.updateRoutineRun) return overrides.updateRoutineRun(input, runs);
      const run = runs.get(input.runId);
      if (!run) throw new Error('personal_agent_routine_run_not_found');
      const updated = { ...run, ...input, id: run.id };
      runs.set(run.id, updated);
      return updated;
    },
    async updateRoutineSchedule(input) {
      calls.push(['updateRoutineSchedule', input]);
      const routine = routines.get(input.routineId);
      const updated = { ...routine };
      if (Object.hasOwn(input, 'running')) updated.running = input.running;
      if (Object.hasOwn(input, 'nextRunAt')) updated.nextRunAt = input.nextRunAt;
      routines.set(updated.id, updated);
      return updated;
    },
    async scheduleWakeup(input) {
      calls.push(['scheduleWakeup', input]);
      const wakeup = makeWakeup({ ...input, id: `scheduled-${++sequence}` });
      wakeups.set(wakeup.id, wakeup);
      return wakeup;
    },
    async cancelWakeup(input) {
      calls.push(['cancelWakeup', input]);
      if (overrides.cancelWakeup) return overrides.cancelWakeup(input, wakeups);
      const wakeup = input.wakeupId
        ? wakeups.get(input.wakeupId)
        : [...wakeups.values()].find((item) => item.conversationId === input.conversationId && item.status === 'scheduled');
      if (!wakeup) return null;
      const canceled = { ...wakeup, status: 'canceled' };
      wakeups.set(wakeup.id, canceled);
      return canceled;
    },
    async updateWakeupStatus(input) {
      calls.push(['updateWakeupStatus', input]);
      const wakeup = wakeups.get(input.wakeupId);
      const updated = { ...wakeup, status: input.status };
      wakeups.set(updated.id, updated);
      return updated;
    },
    async updateConversationDraft(input) {
      calls.push(['updateConversationDraft', input]);
      const conversation = { ...conversations.get(input.conversationId), draftMessage: input.draftMessage };
      conversations.set(conversation.id, conversation);
      return conversation;
    },
  };
  const conversationManager = {
    async sendScheduledMessage(input) {
      calls.push(['sendScheduledMessage', input]);
      if (overrides.sendScheduledMessage) return overrides.sendScheduledMessage(input, conversations);
      const conversation = conversations.get(input.conversationId);
      const updated = {
        ...conversation,
        messages: [...conversation.messages, {
          id: `message-${++sequence}`,
          source: input.source,
          routineId: input.routineId,
        }],
      };
      conversations.set(updated.id, updated);
      return updated;
    },
  };
  const events = [];
  const manager = new AgentRoutineManager({
    store,
    conversationManager,
    ...(overrides.withEvents === false ? {} : { onConversationEvent: (event) => events.push(event) }),
  });
  return { manager, store, conversationManager, routines, conversations, runs, wakeups, calls, events };
};

const flush = async () => await new Promise((resolve) => setImmediate(resolve));

test('given routine CRUD, authorization and lifecycle preserve scheduling defaults and conversation events', async () => {
  const existing = makeRoutine({ id: 'existing', enabled: true, nextRunAt: new Date(Date.now() + 120_000).toISOString() });
  const conversation = makeConversation({ id: existing.conversationId });
  const harness = createHarness({ routines: [existing], conversations: [conversation] });
  try {
    assert.deepEqual(await harness.manager.list({ agentId: existing.agentId }), [existing]);
    for (const operation of [
      () => harness.manager.create('agent-1', { name: 'N', prompt: 'P', frequency: { type: 'hourly' }, authorizationText: ' ' }),
      () => harness.manager.update({ routineId: existing.id, name: 'N', prompt: 'P', frequency: { type: 'hourly' } }),
      () => harness.manager.setEnabled({ routineId: existing.id, enabled: true }),
      () => harness.manager.delete({ routineId: existing.id, authorizationText: '' }),
    ]) await assert.rejects(operation, /personal_agent_routine_authorization_required/);

    const created = await harness.manager.create('agent-1', {
      name: 'Created', prompt: 'Prompt', frequency: { type: 'hourly' }, authorizationText: 'yes',
    });
    assert.equal(created.enabled, true);
    assert.equal(harness.calls.find(([name]) => name === 'createRoutine')[1].missedRunPolicy, 'within_window');
    const updated = await harness.manager.update({
      routineId: created.id,
      name: 'Updated', prompt: 'Updated prompt', frequency: { type: 'daily', timeOfDay: '09:00' },
      authorizationText: 'yes',
    });
    assert.equal(updated.enabled, true);
    assert.equal(updated.missedRunPolicy, 'within_window');
    const disabled = await harness.manager.update({
      routineId: created.id,
      name: 'Disabled', prompt: 'Prompt', frequency: { type: 'hourly' }, missedRunPolicy: 'skip',
      enabled: false, authorizationText: 'yes',
    });
    assert.equal(disabled.nextRunAt, null);
    assert.equal((await harness.manager.setEnabled({ routineId: created.id, enabled: true, authorizationText: 'yes' })).enabled, true);
    assert.equal((await harness.manager.setEnabled({ routineId: created.id, enabled: false, authorizationText: 'yes' })).enabled, false);

    const result = await harness.manager.delete({ routineId: created.id, authorizationText: 'yes' });
    assert.deepEqual(result, { success: true });
    assert.equal(harness.events.some((event) => event.type === 'conversation.updated'), true);
  } finally {
    harness.manager.dispose();
  }

  const noConversation = makeRoutine({ id: 'orphan', conversationId: 'gone' });
  const quiet = createHarness({ routines: [noConversation], withEvents: false });
  assert.deepEqual(await quiet.manager.delete({ routineId: noConversation.id, authorizationText: 'yes' }), { success: true });
  quiet.manager.dispose();
});

test('given initialization and routine timers, idempotency, stale ids, invalid dates, due work, and long delays are deterministic', async () => {
  const future = makeRoutine({ id: 'future', enabled: true, nextRunAt: new Date(Date.now() + 120_000).toISOString() });
  const disabled = makeRoutine({ id: 'disabled', enabled: false, nextRunAt: null });
  const wakeup = makeWakeup({ id: 'future-wakeup' });
  const harness = createHarness({ routines: [future, disabled], conversations: [makeConversation()], wakeups: [wakeup] });
  try {
    await harness.manager.initialize();
    await harness.manager.initialize();
    assert.equal(harness.calls.filter(([name]) => name === 'listRoutines').length, 1);
    assert.equal(harness.manager.routineTimers.has(future.id), true);
    assert.equal(harness.manager.wakeupTimers.has(wakeup.id), true);

    await harness.manager.scheduleRoutine(makeRoutine({ id: 'no-next', enabled: true, nextRunAt: null }));
    const invalid = makeRoutine({ id: 'invalid', enabled: true, nextRunAt: 'not-a-date' });
    harness.routines.set(invalid.id, invalid);
    await harness.manager.scheduleRoutine(invalid);
    assert.equal(harness.runs.values().next().value.error, 'routine_invalid_schedule');

    const huge = makeRoutine({ id: 'huge', enabled: true, nextRunAt: '9999-01-01T00:00:00.000Z' });
    harness.routines.set(huge.id, huge);
    await harness.manager.scheduleRoutine(huge);
    assert.equal(harness.manager.routineTimers.has(huge.id), true);

    await harness.manager.scheduleRoutineById('missing');
    await harness.manager.scheduleRoutineById(future.id);
    await harness.manager.handleDueRoutine('missing');
    const noNext = makeRoutine({ id: 'due-no-next', enabled: true, nextRunAt: null });
    harness.routines.set(noNext.id, noNext);
    await harness.manager.handleDueRoutine(noNext.id);

    const due = makeRoutine({ id: 'due', enabled: true, nextRunAt: new Date(Date.now() - 1_000).toISOString() });
    harness.routines.set(due.id, due);
    await harness.manager.handleDueRoutine(due.id);
    await flush();
    assert.equal([...harness.runs.values()].some((run) => run.routineId === due.id), true);
  } finally {
    harness.manager.dispose();
  }
  assert.equal(harness.manager.routineTimers.size, 0);
  assert.equal(harness.manager.wakeupTimers.size, 0);
});

test('given missed schedules, grace, always, skip, custom windows, and default windows decide exactly once', () => {
  const manager = createHarness().manager;
  try {
    const base = makeRoutine();
    assert.equal(manager.shouldRunMissedRoutine(base, 60_000), true);
    assert.equal(manager.shouldRunMissedRoutine({ ...base, missedRunPolicy: 'always' }, 999_999_999), true);
    assert.equal(manager.shouldRunMissedRoutine({ ...base, missedRunPolicy: 'skip' }, 61_000), false);
    assert.equal(manager.shouldRunMissedRoutine({ ...base, missedRunPolicy: 'within_window', missedRunWindowMinutes: 2 }, 90_000), true);
    assert.equal(manager.shouldRunMissedRoutine({ ...base, missedRunPolicy: 'within_window', missedRunWindowMinutes: 2 }, 180_000), false);
    assert.equal(manager.shouldRunMissedRoutine({ ...base, missedRunPolicy: 'within_window', missedRunWindowMinutes: undefined }, 20 * 60_000), true);
  } finally {
    manager.dispose();
  }
});

test('given routine execution outcomes, busy threads, message lookup, settlement failures, throws, and deleted rows keep stable run states', async () => {
  const routine = makeRoutine({ id: 'run-routine', enabled: false });
  const conversation = makeConversation({ id: routine.conversationId });
  let settle;
  const harness = createHarness({
    routines: [routine],
    conversations: [conversation],
    sendScheduledMessage: async (input, conversations) => {
      settle = input.onRunSettled;
      const current = conversations.get(input.conversationId);
      return {
        ...current,
        messages: [
          { id: 'other-source', source: 'human', routineId: routine.id },
          { id: 'other-routine', source: 'routine', routineId: 'different' },
          { id: 'routine-message', source: 'routine', routineId: routine.id },
        ],
      };
    },
  });
  try {
    const run = await harness.manager.runNow({ routineId: routine.id });
    assert.equal(run.status, 'running');
    assert.equal(run.messageId, 'routine-message');
    await settle({ success: true });
    assert.equal([...harness.runs.values()].at(-1).status, 'succeeded');

    const second = await harness.manager.runNow({ routineId: routine.id });
    await settle({ success: false, error: new Error('settled failure') });
    assert.equal(harness.runs.get(second.id).error, 'settled failure');
    const third = await harness.manager.runNow({ routineId: routine.id });
    await settle({ success: false, error: 'not-an-error' });
    assert.equal(harness.runs.get(third.id).error, 'routine_run_failed');

    harness.conversations.set(conversation.id, makeConversation({
      id: conversation.id,
      activeRun: { id: 'active', status: 'running' },
    }));
    const skipped = await harness.manager.runNow({ routineId: routine.id });
    assert.equal(skipped.error, 'routine_thread_busy');
  } finally {
    harness.manager.dispose();
  }

  for (const thrown of [new Error('send failed'), 'bad throw']) {
    const failingRoutine = makeRoutine({ id: `throw-${typeof thrown}`, enabled: false });
    const failing = createHarness({
      routines: [failingRoutine],
      conversations: [makeConversation({ id: failingRoutine.conversationId })],
      sendScheduledMessage: async () => { throw thrown; },
    });
    try {
      const run = await failing.manager.runNow({ routineId: failingRoutine.id });
      assert.equal(run.status, 'failed');
      assert.equal(run.error, thrown instanceof Error ? 'send failed' : 'routine_run_failed');
    } finally {
      failing.manager.dispose();
    }
  }

  const noMessageRoutine = makeRoutine({ id: 'no-message', enabled: false });
  const noMessage = createHarness({
    routines: [noMessageRoutine],
    conversations: [makeConversation({ id: noMessageRoutine.conversationId })],
    sendScheduledMessage: async (_input, conversations) => conversations.get(noMessageRoutine.conversationId),
  });
  try {
    const run = await noMessage.manager.runNow({ routineId: noMessageRoutine.id });
    assert.equal(run.messageId, undefined);
  } finally {
    noMessage.manager.dispose();
  }
});

test('given late settlement after deletion, missing runs are ignored while unexpected persistence errors propagate', async () => {
  const routine = makeRoutine({ id: 'late', enabled: true, nextRunAt: null });
  const missingRun = createHarness({
    routines: [routine], conversations: [makeConversation()],
    updateRoutineRun: async () => { throw new Error('personal_agent_routine_run_not_found'); },
  });
  await missingRun.manager.finishRoutineRun('missing', 'succeeded');
  missingRun.manager.dispose();

  const unexpected = createHarness({
    routines: [routine], conversations: [makeConversation()],
    updateRoutineRun: async () => { throw new TypeError('database unavailable'); },
  });
  await assert.rejects(() => unexpected.manager.finishRoutineRun('run', 'failed'), /database unavailable/);
  unexpected.manager.dispose();

  const deletedRoutine = createHarness({
    routines: [routine],
    conversations: [makeConversation()],
    updateRoutineRun: async (input) => ({ id: input.runId, routineId: 'gone', status: input.status }),
  });
  await deletedRoutine.manager.finishRoutineRun('run', 'succeeded');
  deletedRoutine.manager.dispose();
});

test('given wakeup scheduling, invalid delays, cancellation, stale timers, busy conversations, and firing are handle-safe', async () => {
  const conversation = makeConversation();
  const missingConversationEvents = [];
  const harness = createHarness({ conversations: [conversation] });
  try {
    for (const seconds of [Number.NaN, 4.9]) {
      await assert.rejects(() => harness.manager.scheduleWakeup({
        agentId: 'agent-1', conversationId: conversation.id, seconds, prompt: 'Soon',
      }), /personal_agent_wakeup_minimum_seconds/);
    }
    const wakeup = await harness.manager.scheduleWakeup({
      agentId: 'agent-1', conversationId: conversation.id, seconds: 60.9, prompt: 'Later', createdByRunId: 'run-1',
    });
    assert.equal(wakeup.createdByRunId, 'run-1');
    assert.equal((await harness.manager.cancelWakeup({ wakeupId: 'missing' })), null);
    assert.equal((await harness.manager.cancelWakeup({ wakeupId: wakeup.id })).status, 'canceled');

    await harness.manager.scheduleWakeupTimer(makeWakeup({ id: 'already-fired', status: 'fired' }));
    const invalid = makeWakeup({ id: 'invalid-wakeup', dueAt: 'bad' });
    harness.wakeups.set(invalid.id, invalid);
    await harness.manager.scheduleWakeupTimer(invalid);
    assert.equal(harness.wakeups.get(invalid.id).status, 'canceled');

    const future = makeWakeup({ id: 'replace-timer', dueAt: new Date(Date.now() + 120_000).toISOString() });
    harness.wakeups.set(future.id, future);
    await harness.manager.scheduleWakeupTimer(future);
    await harness.manager.scheduleWakeupTimer(future);
    await harness.manager.scheduleWakeupById('missing-wakeup');
    await harness.manager.scheduleWakeupById(future.id);

    await harness.manager.fireWakeup('missing-wakeup');
    const busy = makeWakeup({ id: 'busy', dueAt: new Date(Date.now() - 1_000).toISOString() });
    harness.wakeups.set(busy.id, busy);
    harness.conversations.set(conversation.id, makeConversation({ activeRun: { id: 'active', status: 'running' } }));
    await harness.manager.fireWakeup(busy.id);
    assert.equal(harness.manager.wakeupTimers.has(busy.id), true);

    harness.conversations.set(conversation.id, makeConversation({ activeRun: { id: 'done', status: 'completed' } }));
    await harness.manager.fireWakeup(busy.id);
    assert.equal(harness.wakeups.get(busy.id).status, 'fired');
    assert.equal(harness.calls.some(([name, input]) => name === 'sendScheduledMessage' && input.wakeupId === busy.id), true);

    const draft = await harness.manager.updateDraft({ conversationId: conversation.id, draftMessage: 'Draft' });
    assert.equal(draft.draftMessage, 'Draft');
  } finally {
    harness.manager.dispose();
  }

  const orphan = createHarness({
    conversations: [],
    getConversation: async () => null,
    withEvents: false,
  });
  const orphanWakeup = makeWakeup({ id: 'orphan-wakeup', dueAt: new Date(Date.now() + 60_000).toISOString() });
  orphan.wakeups.set(orphanWakeup.id, orphanWakeup);
  await orphan.manager.emitWakeupEvent('wakeup.scheduled', orphanWakeup);
  await orphan.manager.emitRoutineUpdated(makeRoutine({ conversationId: 'gone' }));
  missingConversationEvents.push(...orphan.events);
  assert.deepEqual(missingConversationEvents, []);
  orphan.manager.dispose();
});

test('given timer callbacks become due, routine, wakeup, and busy-retry delegates re-read persisted state without real sleeps', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const routine = makeRoutine({ id: 'timer-routine', enabled: true, nextRunAt: new Date(Date.now() + 10).toISOString() });
  const wakeup = makeWakeup({ id: 'timer-wakeup', dueAt: new Date(Date.now() + 10).toISOString() });
  const busy = makeWakeup({ id: 'timer-busy', dueAt: new Date(Date.now() - 1).toISOString() });
  const conversation = makeConversation({ activeRun: { id: 'active', status: 'running' } });
  const harness = createHarness({ routines: [routine], conversations: [conversation], wakeups: [wakeup, busy] });
  try {
    await harness.manager.scheduleRoutine(routine);
    await harness.manager.scheduleWakeupTimer(wakeup);
    await harness.manager.fireWakeup(busy.id);
    t.mock.timers.tick(1_000);
    await flush();
    assert.equal(harness.manager.routineTimers.has(routine.id), true);
    assert.equal(harness.manager.wakeupTimers.has(wakeup.id), true);
    assert.equal(harness.manager.wakeupTimers.has(busy.id), true);
  } finally {
    harness.manager.dispose();
    t.mock.timers.reset();
  }
});
