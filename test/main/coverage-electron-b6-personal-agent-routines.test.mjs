import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { executePersonalAgentRoutineTool } = require('../../dist-electron/main/forger-mcp/personal-agent-routine-tools.js');

const session = (overrides = {}) => ({
  caller: 'personal-agent',
  appId: 'desktop',
  personalAgentId: 'agent-1',
  personalAgentConversationId: 'conversation-1',
  runId: 'run-1',
  locale: 'en',
  connectionGrants: [],
  ...overrides,
});

test('personal-agent routine MCP tools fail closed outside a complete personal conversation context', async () => {
  for (const invalid of [
    session({ caller: 'chat' }),
    session({ personalAgentId: undefined }),
    session({ personalAgentConversationId: undefined }),
  ]) {
    assert.equal((await executePersonalAgentRoutineTool(invalid, 'wakeup_in', {}, {})).technicalCode,
      'personal_agent_context_required');
  }

  const unavailable = [
    ['wakeup_in', 'personal_agent_wakeup_unavailable'],
    ['cancel_wakeup', 'personal_agent_wakeup_unavailable'],
    ['list_agent_routines', 'personal_agent_routines_unavailable'],
    ['create_agent_routine', 'personal_agent_routines_unavailable'],
    ['update_agent_routine', 'personal_agent_routines_unavailable'],
    ['delete_agent_routine', 'personal_agent_routines_unavailable'],
  ];
  for (const [toolId, code] of unavailable) {
    assert.equal((await executePersonalAgentRoutineTool(session(), toolId, {}, {})).technicalCode, code);
  }
  assert.equal((await executePersonalAgentRoutineTool(session({ locale: 'en' }), 'unknown_tool', {}, {})).technicalCode,
    'tool_not_found');
});

test('personal-agent wakeup tools validate inputs, clamp visible delays, and preserve thread identity', async () => {
  const calls = [];
  const options = {
    schedulePersonalAgentWakeup: async (input) => {
      calls.push(['schedule', input]);
      return { id: 'wakeup-1', ...input, status: 'scheduled' };
    },
    cancelPersonalAgentWakeup: async (input) => {
      calls.push(['cancel', input]);
      return input.wakeupId === 'missing' ? null : { id: 'wakeup-1', status: 'canceled' };
    },
  };

  assert.equal((await executePersonalAgentRoutineTool(session(), 'wakeup_in', {
    seconds: 'not-a-number', prompt: 'Wake me',
  }, options)).technicalCode, 'personal_agent_wakeup_input_invalid');
  assert.equal((await executePersonalAgentRoutineTool(session(), 'wakeup_in', {
    seconds: 5, prompt: '   ',
  }, options)).technicalCode, 'personal_agent_wakeup_input_invalid');

  const scheduled = await executePersonalAgentRoutineTool(session(), 'wakeup_in', {
    seconds: '3.9', prompt: ' Continue the review ',
  }, options);
  assert.equal(scheduled.success, true);
  assert.match(scheduled.userMessage, /5 segundos/);
  assert.deepEqual(calls[0], ['schedule', {
    agentId: 'agent-1', conversationId: 'conversation-1', runId: 'run-1',
    seconds: 3.9, prompt: 'Continue the review',
  }]);

  const canceled = await executePersonalAgentRoutineTool(session(), 'cancel_wakeup', {}, options);
  assert.equal(canceled.success, true);
  assert.deepEqual(calls[1], ['cancel', { wakeupId: undefined, conversationId: 'conversation-1' }]);
  const absent = await executePersonalAgentRoutineTool(session(), 'cancel_wakeup', { wakeupId: ' missing ' }, options);
  assert.deepEqual({ success: absent.success, code: absent.technicalCode }, {
    success: false, code: 'personal_agent_wakeup_not_found',
  });
});

test('personal-agent routine mutations normalize schedules and retain explicit authorization', async () => {
  const calls = [];
  const options = {
    listAgentRoutines: async (input) => {
      calls.push(['list', input]);
      return [{ id: 'routine-1' }];
    },
    createAgentRoutine: async (input) => {
      calls.push(['create', input]);
      return { id: `routine-${calls.length}`, ...input };
    },
    updateAgentRoutine: async (input) => {
      calls.push(['update', input]);
      return { id: input.routineId, ...input };
    },
    deleteAgentRoutine: async (input) => {
      calls.push(['delete', input]);
      return { success: input.routineId !== 'blocked' };
    },
  };

  assert.deepEqual(await executePersonalAgentRoutineTool(session(), 'list_agent_routines', {}, options), {
    success: true, routines: [{ id: 'routine-1' }],
  });

  const invalidCreateInputs = [
    {},
    { name: 'Name', prompt: 'Prompt', authorizationText: 'Approved', periodicity: [] },
    { name: 'Name', prompt: 'Prompt', authorizationText: 'Approved', periodicity: { type: 'unknown' } },
  ];
  for (const args of invalidCreateInputs) {
    assert.equal((await executePersonalAgentRoutineTool(session(), 'create_agent_routine', args, options)).technicalCode,
      'personal_agent_routine_input_invalid');
  }

  const hourly = await executePersonalAgentRoutineTool(session(), 'create_agent_routine', {
    name: ' Hourly ', prompt: ' Check ', authorizationText: ' Approved ',
    frequency: { type: 'hourly' }, enabled: false, missedRunPolicy: 'skip', missedRunWindowMinutes: '7.9',
  }, options);
  assert.equal(hourly.success, true);
  assert.deepEqual(calls.at(-1)[1], {
    agentId: 'agent-1', name: 'Hourly', prompt: 'Check', frequency: { type: 'hourly' },
    missedRunPolicy: 'skip', missedRunWindowMinutes: 7, enabled: false, authorizationText: 'Approved',
  });

  await executePersonalAgentRoutineTool(session(), 'create_agent_routine', {
    name: 'Daily', prompt: 'Check', authorizationText: 'Approved',
    periodicity: { type: 'daily', timeOfDay: 'bad' }, missedRunPolicy: 'invalid', missedRunWindowMinutes: 0,
  }, options);
  assert.deepEqual(calls.at(-1)[1].frequency, { type: 'daily', timeOfDay: '09:00' });
  assert.equal(calls.at(-1)[1].missedRunPolicy, undefined);
  assert.equal(calls.at(-1)[1].missedRunWindowMinutes, undefined);

  await executePersonalAgentRoutineTool(session(), 'create_agent_routine', {
    name: 'Weekly', prompt: 'Check', authorizationText: 'Approved',
    periodicity: { type: 'weekly', timeOfDay: '29:99', weeklyDay: '9.8' },
    missedRunPolicy: 'always', missedRunWindowMinutes: 'not-a-number',
  }, options);
  assert.deepEqual(calls.at(-1)[1].frequency, { type: 'weekly', timeOfDay: '23:59', weeklyDay: 6 });

  await executePersonalAgentRoutineTool(session(), 'create_agent_routine', {
    name: 'Weekly default', prompt: 'Check', authorizationText: 'Approved',
    periodicity: { type: 'weekly', timeOfDay: 10, weeklyDay: 'bad' },
    missedRunPolicy: 'within_window',
  }, options);
  assert.deepEqual(calls.at(-1)[1].frequency, { type: 'weekly', timeOfDay: '09:00', weeklyDay: 1 });

  assert.equal((await executePersonalAgentRoutineTool(session(), 'update_agent_routine', {
    name: 'Missing id', prompt: 'Check', authorizationText: 'Approved', frequency: { type: 'hourly' },
  }, options)).technicalCode, 'personal_agent_routine_input_invalid');
  const updated = await executePersonalAgentRoutineTool(session(), 'update_agent_routine', {
    routineId: ' routine-1 ', name: ' Updated ', prompt: ' Continue ', authorizationText: ' Approved ',
    periodicity: { type: 'daily', timeOfDay: '08:05' }, enabled: true,
  }, options);
  assert.equal(updated.success, true);
  assert.equal(calls.at(-1)[1].routineId, 'routine-1');

  assert.equal((await executePersonalAgentRoutineTool(session(), 'delete_agent_routine', {
    routineId: '', authorizationText: '',
  }, options)).technicalCode, 'personal_agent_routine_input_invalid');
  assert.match((await executePersonalAgentRoutineTool(session(), 'delete_agent_routine', {
    routineId: 'routine-1', authorizationText: 'Approved',
  }, options)).userMessage, /eliminada/);
  assert.equal((await executePersonalAgentRoutineTool(session(), 'delete_agent_routine', {
    routineId: 'blocked', authorizationText: 'Approved',
  }, options)).userMessage, 'No pudimos borrar la rutina.');
});

test('personal-agent routine MCP tools translate known service errors and contain unknown failures', async () => {
  const cases = [
    ['personal_agent_wakeup_minimum_seconds', 'al menos 5 segundos'],
    ['personal_agent_wakeup_active', 'ya tiene un despertar'],
    ['personal_agent_routine_authorization_required', 'autorizacion textual'],
    ['personal_agent_routine_not_found', 'No encontramos esa rutina'],
    ['unexpected_failure', 'No pudimos completar'],
  ];
  for (const [code, message] of cases) {
    const result = await executePersonalAgentRoutineTool(session(), 'wakeup_in', {
      seconds: 10, prompt: 'Continue',
    }, {
      schedulePersonalAgentWakeup: async () => {
        const error = new Error(code);
        error.technicalCode = code;
        throw error;
      },
    });
    assert.equal(result.success, false);
    assert.match(result.userMessage, new RegExp(message));
  }

  const primitive = await executePersonalAgentRoutineTool(session(), 'wakeup_in', {
    seconds: 10, prompt: 'Continue',
  }, {
    schedulePersonalAgentWakeup: async () => { throw 'offline'; },
  });
  assert.equal(primitive.technicalCode, 'personal_agent_routine_failed');
});
