import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { AgentStore } = require('../../dist-electron/main/personal-agents/agent-store.js');
const { AgentRoutineStore, PERSONAL_AGENT_ROUTINE_SCHEMA_SQL } = require('../../dist-electron/main/personal-agents/agent-store-routines.js');

const createHarness = async () => {
  const metadataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'forger-routine-store-b17-meta-'));
  const forgerHomeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'forger-routine-store-b17-home-'));
  const store = new AgentStore({ metadataRoot, forgerHomeRoot });
  const cleanup = async () => {
    await fs.rm(metadataRoot, { recursive: true, force: true });
    await fs.rm(forgerHomeRoot, { recursive: true, force: true });
  };
  return { store, cleanup };
};

const validRoutine = (agentId, overrides = {}) => ({
  agentId,
  name: 'Review queue',
  prompt: 'Review everything waiting.',
  frequency: { type: 'hourly' },
  missedRunPolicy: 'within_window',
  missedRunWindowMinutes: 30,
  enabled: false,
  nextRunAt: null,
  authorizationText: 'User approved this routine.',
  ...overrides,
});

test('given malformed and missing routine input, persistence rejects it before creating unsafe records', async () => {
  const { store, cleanup } = await createHarness();
  try {
    const agent = await store.createAgent({ name: 'Validation agent' });
    assert.match(PERSONAL_AGENT_ROUTINE_SCHEMA_SQL, /personal_agent_routines/);
    assert.equal(await store.getRoutine(' '), null);
    await assert.rejects(() => store.requireRoutine('missing'), /personal_agent_routine_not_found/);
    for (const field of ['name', 'prompt', 'authorizationText']) {
      await assert.rejects(
        () => store.createRoutine(validRoutine(agent.id, { [field]: '  ' })),
        new RegExp(`personal_agent_routine_${field === 'authorizationText' ? 'authorization' : field}_required`),
      );
    }
  } finally {
    await cleanup();
  }
});

test('given every supported frequency, routine storage normalizes schedules, missed-run windows, ordering, and updates', async () => {
  const { store, cleanup } = await createHarness();
  try {
    const agent = await store.createAgent({ name: 'Frequency agent' });
    const cases = [
      { frequency: null, missedRunPolicy: 'invalid', missedRunWindowMinutes: 'bad', expected: { type: 'hourly' }, window: 30 },
      { frequency: { type: 'interval', intervalMinutes: 0 }, missedRunPolicy: 'skip', missedRunWindowMinutes: 'bad', expected: { type: 'interval', intervalMinutes: 15 }, window: 15 },
      { frequency: { type: 'interval', intervalMinutes: 99_999 }, missedRunPolicy: 'always', missedRunWindowMinutes: 99_999, expected: { type: 'interval', intervalMinutes: 1_440 }, window: 43_200 },
      { frequency: { type: 'daily', timeOfDay: 'bad' }, missedRunWindowMinutes: undefined, expected: { type: 'daily', timeOfDay: '09:00' }, window: 360 },
      { frequency: { type: 'daily', timeOfDay: '99:99' }, missedRunWindowMinutes: -1, expected: { type: 'daily', timeOfDay: '23:59' }, window: 360 },
      { frequency: { type: 'weekly', timeOfDay: '1:02', weeklyDay: 'bad' }, missedRunWindowMinutes: undefined, expected: { type: 'weekly', timeOfDay: '01:02', weeklyDay: 1 }, window: 1_440 },
      { frequency: { type: 'weekly', timeOfDay: '00:00', weeklyDay: -3 }, expected: { type: 'weekly', timeOfDay: '00:00', weeklyDay: 0 }, window: 1_440 },
      { frequency: { type: 'weekly', timeOfDay: '23:59', weeklyDay: 9 }, expected: { type: 'weekly', timeOfDay: '23:59', weeklyDay: 6 }, window: 1_440 },
    ];
    const routines = [];
    for (const [index, item] of cases.entries()) {
      const routine = await store.createRoutine(validRoutine(agent.id, {
        name: `Routine ${index}`,
        frequency: item.frequency,
        missedRunPolicy: item.missedRunPolicy,
        missedRunWindowMinutes: item.missedRunWindowMinutes,
        enabled: index === 0,
        nextRunAt: '2030-01-01T00:00:00.000Z',
      }));
      assert.deepEqual(routine.frequency, item.expected);
      assert.equal(routine.missedRunWindowMinutes, item.window);
      assert.equal(routine.nextRunAt, index === 0 ? '2030-01-01T00:00:00.000Z' : null);
      routines.push(routine);
    }
    assert.equal((await store.listRoutines(agent.id)).length, cases.length);

    for (const field of ['name', 'prompt', 'authorizationText']) {
      await assert.rejects(
        () => store.updateRoutine({
          routineId: routines[0].id,
          name: 'Updated',
          prompt: 'Updated prompt',
          frequency: { type: 'interval', intervalMinutes: '7' },
          missedRunPolicy: 'skip',
          enabled: true,
          nextRunAt: '2031-01-01T00:00:00.000Z',
          authorizationText: 'Approved update',
          [field]: '',
        }),
        new RegExp(`personal_agent_routine_${field === 'authorizationText' ? 'authorization' : field}_required`),
      );
    }
    const updated = await store.updateRoutine({
      routineId: routines[0].id,
      name: ' Updated ',
      prompt: ' Updated prompt ',
      frequency: { type: 'interval', intervalMinutes: '7' },
      missedRunPolicy: 'unexpected',
      missedRunWindowMinutes: 4.6,
      enabled: true,
      nextRunAt: '2031-01-01T00:00:00.000Z',
      authorizationText: ' Approved update ',
    });
    assert.equal(updated.name, 'Updated');
    assert.deepEqual(updated.frequency, { type: 'interval', intervalMinutes: 7 });
    assert.equal(updated.missedRunPolicy, 'within_window');
    assert.equal(updated.missedRunWindowMinutes, 5);
    assert.equal((await store.requireConversation(updated.conversationId)).title, 'Updated');
    const updatedDisabled = await store.updateRoutine({
      routineId: updated.id,
      name: 'Disabled update',
      prompt: 'No schedule',
      frequency: { type: 'hourly' },
      missedRunPolicy: 'skip',
      missedRunWindowMinutes: 2,
      enabled: false,
      nextRunAt: 'ignored',
      authorizationText: 'Approved update',
    });
    assert.equal(updatedDisabled.enabled, false);
    assert.equal(updatedDisabled.nextRunAt, null);

    const disabled = await store.setRoutineEnabled({ routineId: updated.id, enabled: false, nextRunAt: 'ignored' });
    assert.equal(disabled.nextRunAt, null);
    const enabled = await store.setRoutineEnabled({ routineId: updated.id, enabled: true, nextRunAt: '2032-01-01T00:00:00.000Z' });
    assert.equal(enabled.nextRunAt, '2032-01-01T00:00:00.000Z');

    await store.updateRoutineSchedule({ routineId: updated.id, running: true, nextRunAt: null, lastUpdatedAt: '2030-02-02T00:00:00.000Z' });
    const retained = await store.updateRoutineSchedule({ routineId: updated.id });
    assert.equal(retained.running, true);
    assert.equal(retained.nextRunAt, null);
    const stopped = await store.updateRoutineSchedule({ routineId: updated.id, running: false, nextRunAt: '2033-01-01T00:00:00.000Z' });
    assert.equal(stopped.running, false);
    assert.equal(stopped.nextRunAt, '2033-01-01T00:00:00.000Z');
    const retainedStopped = await store.updateRoutineSchedule({ routineId: updated.id });
    assert.equal(retainedStopped.running, false);
    assert.equal(retainedStopped.nextRunAt, '2033-01-01T00:00:00.000Z');

    assert.deepEqual(await store.deleteRoutine(routines.at(-1).id), { success: true });
    const detached = await store.requireConversation(routines.at(-1).conversationId);
    assert.equal(detached.origin, 'user');
    assert.equal(detached.routineId, undefined);
  } finally {
    await cleanup();
  }
});

test('given routine executions, run persistence retains terminal timing, safe errors, messages, and trigger identity', async () => {
  const { store, cleanup } = await createHarness();
  try {
    const agent = await store.createAgent({ name: 'Run agent' });
    const routine = await store.createRoutine(validRoutine(agent.id));
    const message = await store.addMessage({
      agentId: agent.id,
      conversationId: routine.conversationId,
      role: 'user',
      source: 'routine',
      routineId: routine.id,
      content: 'Run now.',
    });
    await assert.rejects(
      () => store.updateRoutineRun({ runId: 'missing', status: 'running' }),
      /personal_agent_routine_run_not_found/,
    );
    await assert.rejects(
      () => store.updateRoutineRun({ runId: ' ', status: 'running' }),
      /personal_agent_routine_run_not_found/,
    );
    const queued = await store.createRoutineRun({ routineId: routine.id, trigger: 'manual' });
    assert.equal(queued.status, 'queued');
    assert.equal(queued.finishedAt, undefined);
    const running = await store.updateRoutineRun({ runId: queued.id, status: 'running', messageId: message.id });
    assert.equal(running.trigger, 'manual');
    assert.equal(running.finishedAt, undefined);
    assert.equal(running.messageId, message.id);
    for (const status of ['succeeded', 'failed', 'skipped']) {
      const updated = await store.updateRoutineRun({ runId: queued.id, status, error: status === 'failed' ? ' failed safely ' : '' });
      assert.equal(updated.status, status);
      assert.equal(typeof updated.finishedAt, 'string');
      assert.equal(updated.messageId, message.id);
      assert.equal(updated.error, status === 'failed' ? 'failed safely' : undefined);
    }
    const skipped = await store.createRoutineRun({
      routineId: routine.id,
      trigger: 'scheduled',
      status: 'skipped',
      error: ' missed ',
      messageId: message.id,
    });
    assert.equal(skipped.trigger, 'scheduled');
    assert.equal(typeof skipped.finishedAt, 'string');
    assert.equal(skipped.error, 'missed');
    assert.equal(skipped.messageId, message.id);
    assert.equal((await store.requireRoutine(routine.id)).lastRun.id, skipped.id);
  } finally {
    await cleanup();
  }
});

test('given scheduled wakeups, storage enforces ownership, one-active semantics, cancellation selectors, status, sorting, and drafts', async () => {
  const { store, cleanup } = await createHarness();
  try {
    const firstAgent = await store.createAgent({ name: 'Wake agent' });
    const secondAgent = await store.createAgent({ name: 'Other agent' });
    const firstConversation = await store.createConversation({ agentId: firstAgent.id, title: 'First' });
    const secondConversation = await store.createConversation({ agentId: firstAgent.id, title: 'Second' });
    await assert.rejects(() => store.scheduleWakeup({
      agentId: secondAgent.id,
      conversationId: firstConversation.id,
      prompt: 'Wrong owner',
      dueAt: '2030-01-01T00:00:00.000Z',
    }), /personal_agent_conversation_mismatch/);
    await assert.rejects(() => store.scheduleWakeup({
      agentId: firstAgent.id,
      conversationId: firstConversation.id,
      prompt: ' ',
      dueAt: '2030-01-01T00:00:00.000Z',
    }), /personal_agent_wakeup_prompt_required/);

    const run = await store.createRun({ agentId: firstAgent.id, conversationId: firstConversation.id });
    const later = await store.scheduleWakeup({
      agentId: firstAgent.id,
      conversationId: firstConversation.id,
      prompt: ' Later ',
      dueAt: '2030-01-02T00:00:00.000Z',
      createdByRunId: run.id,
    });
    const earlier = await store.scheduleWakeup({
      agentId: firstAgent.id,
      conversationId: secondConversation.id,
      prompt: 'Earlier',
      dueAt: '2030-01-01T00:00:00.000Z',
    });
    assert.equal(later.prompt, 'Later');
    assert.equal(later.createdByRunId, run.id);
    assert.equal(earlier.createdByRunId, null);
    assert.deepEqual((await store.listScheduledWakeups()).map((item) => item.id), [earlier.id, later.id]);
    assert.equal(store.routineStore.scheduledWakeupForConversation(' '), null);
    assert.equal(store.routineStore.scheduledWakeupForConversation(firstConversation.id).id, later.id);
    await assert.rejects(() => store.scheduleWakeup({
      agentId: firstAgent.id,
      conversationId: firstConversation.id,
      prompt: 'Duplicate',
      dueAt: '2030-01-03T00:00:00.000Z',
    }), /personal_agent_wakeup_active/);

    assert.equal(await store.cancelWakeup({}), null);
    assert.equal(await store.cancelWakeup({ wakeupId: ' ' }), null);
    const canceled = await store.cancelWakeup({ conversationId: secondConversation.id });
    assert.equal(canceled.status, 'canceled');
    assert.equal(await store.cancelWakeup({ wakeupId: canceled.id }), null);
    assert.equal((await store.cancelWakeup({ wakeupId: later.id })).status, 'canceled');
    await assert.rejects(
      () => store.updateWakeupStatus({ wakeupId: 'missing', status: 'fired' }),
      /personal_agent_wakeup_not_found/,
    );
    assert.deepEqual(await store.listScheduledWakeups(), []);

    const drafted = await store.updateConversationDraft({
      conversationId: firstConversation.id,
      draftMessage: ' Draft safely ',
    });
    assert.equal(drafted.draftMessage, 'Draft safely');
  } finally {
    await cleanup();
  }
});

test('given a row disappears between validation and reload, update methods surface their stable not-found contract', async () => {
  const routineRow = {
    id: 'routine', agent_id: 'agent', conversation_id: 'conversation', name: 'Name', prompt: 'Prompt',
    frequency_type: 'hourly', frequency_time_of_day: null, frequency_weekly_day: null,
    frequency_interval_minutes: null, missed_run_policy: 'skip', missed_run_window_minutes: null,
    enabled: 1, running: 0, next_run_at: null, authorization_text: 'yes',
    created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
  };
  const runRow = {
    id: 'run', routine_id: 'routine', agent_id: 'agent', conversation_id: 'conversation',
    trigger: 'manual', status: 'running', started_at: '2026-01-01T00:00:00.000Z',
    finished_at: null, error: null, message_id: null,
  };
  const wakeupRow = {
    id: 'wakeup', agent_id: 'agent', conversation_id: 'conversation', prompt: 'Wake',
    due_at: '2026-01-01T00:00:00.000Z', status: 'scheduled', created_by_run_id: null,
    created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
  };
  let runReads = 0;
  let wakeupReads = 0;
  const db = {
    prepare(sql) {
      return {
        get() {
          if (sql.includes('personal_agent_routine_runs')) return runReads++ === 0 ? runRow : undefined;
          if (sql.includes('personal_agent_wakeups')) return wakeupReads++ === 0 ? wakeupRow : undefined;
          if (sql.includes('personal_agent_routines')) return routineRow;
          return undefined;
        },
        run() { return {}; },
      };
    },
  };
  const store = new AgentRoutineStore({
    load: async () => {},
    requireDb: () => db,
    requireAgent: async () => ({ id: 'agent' }),
    requireConversation: async () => ({ id: 'conversation', agentId: 'agent' }),
    createConversation: async () => ({ id: 'conversation', agentId: 'agent' }),
    updateConversationTitle: async () => ({ id: 'conversation', agentId: 'agent' }),
    touchConversation: () => {},
  });
  await assert.rejects(
    () => store.updateRoutineRun({ runId: 'run', status: 'succeeded' }),
    /personal_agent_routine_run_not_found/,
  );
  await assert.rejects(
    () => store.updateWakeupStatus({ wakeupId: 'wakeup', status: 'fired' }),
    /personal_agent_wakeup_not_found/,
  );
});

test('given legacy routine rows with nullable frequency fields, reads restore safe defaults for every frequency', async () => {
  const row = {
    id: 'routine', agent_id: 'agent', conversation_id: 'conversation', name: 'Name', prompt: 'Prompt',
    frequency_type: 'interval', frequency_time_of_day: null, frequency_weekly_day: null,
    frequency_interval_minutes: null, missed_run_policy: 'unknown', missed_run_window_minutes: null,
    enabled: 0, running: 0, next_run_at: null, authorization_text: 'yes',
    created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
  };
  const db = {
    prepare(sql) {
      return {
        get() {
          if (sql.includes('personal_agent_routine_runs')) return undefined;
          return row;
        },
      };
    },
  };
  const store = new AgentRoutineStore({
    load: async () => {},
    requireDb: () => db,
    requireAgent: async () => ({ id: 'agent' }),
    requireConversation: async () => ({ id: 'conversation', agentId: 'agent' }),
    createConversation: async () => ({ id: 'conversation', agentId: 'agent' }),
    updateConversationTitle: async () => ({ id: 'conversation', agentId: 'agent' }),
    touchConversation: () => {},
  });
  assert.deepEqual((await store.getRoutine('routine')).frequency, { type: 'interval', intervalMinutes: 15 });
  row.frequency_type = 'daily';
  assert.deepEqual((await store.getRoutine('routine')).frequency, { type: 'daily', timeOfDay: '09:00' });
  row.frequency_type = 'weekly';
  assert.deepEqual((await store.getRoutine('routine')).frequency, { type: 'weekly', timeOfDay: '09:00', weeklyDay: 1 });
});
