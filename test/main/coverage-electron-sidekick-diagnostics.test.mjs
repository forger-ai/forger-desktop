import assert from 'node:assert/strict';
import test from 'node:test';

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  handleNetworkRxOverflow,
  handleWakeBeepResult,
} = require('../../dist-electron/main/sidekick-diagnostics.js');

const createDeps = () => {
  const emitted = [];
  const logs = [];
  const rejected = [];
  return {
    emitted,
    logs,
    rejected,
    deps: {
      emit: () => emitted.push('emit'),
      log: async (event, payload) => {
        logs.push([event, payload]);
      },
      rejectSpeaker: (error) => rejected.push(error),
    },
  };
};

test('wake beep diagnostics reject malformed device results without changing runtime state', () => {
  const invalidPayloads = [
    { wakeId: null, status: 'completed', durationMs: 1 },
    { wakeId: ' '.repeat(2), status: 'completed', durationMs: 1 },
    { wakeId: 'w'.repeat(129), status: 'completed', durationMs: 1 },
    { wakeId: 'wake-1', status: 'pending', durationMs: 1 },
    { wakeId: 'wake-1', status: 'completed', durationMs: '1' },
    { wakeId: 'wake-1', status: 'completed', durationMs: 1.5 },
    { wakeId: 'wake-1', status: 'completed', durationMs: -1 },
    { wakeId: 'wake-1', status: 'completed', durationMs: 5_001 },
    { wakeId: 'wake-1', status: 'failed', durationMs: 1, code: null },
    { wakeId: 'wake-1', status: 'failed', durationMs: 1, code: 'invalid code!' },
  ];

  for (const payload of invalidPayloads) {
    const runtime = {};
    const harness = createDeps();
    handleWakeBeepResult(runtime, { sidekickId: 'sidekick-1', ...payload }, harness.deps);
    assert.equal(runtime.wakeBeep, undefined);
    assert.deepEqual(harness.logs, [[
      'sidekick:wake_beep_result_invalid',
      { sidekickId: 'sidekick-1' },
    ]]);
    assert.deepEqual(harness.emitted, []);
  }
});

test('wake beep diagnostics persist completed and failed results with normalized technical codes', () => {
  const runtime = {};
  const completed = createDeps();
  handleWakeBeepResult(runtime, {
    sidekickId: 'sidekick-1',
    wakeId: '  wake-completed  ',
    status: 'completed',
    durationMs: 0,
  }, completed.deps);
  assert.deepEqual(runtime.wakeBeep, {
    wakeId: 'wake-completed',
    status: 'completed',
    durationMs: 0,
    updatedAt: runtime.wakeBeep.updatedAt,
  });
  assert.match(runtime.wakeBeep.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(completed.logs[0], ['sidekick:wake_beep_result', {
    sidekickId: 'sidekick-1',
    wakeId: 'wake-completed',
    status: 'completed',
    durationMs: 0,
  }]);
  assert.deepEqual(completed.emitted, ['emit']);

  const completedWithCode = createDeps();
  handleWakeBeepResult(runtime, {
    sidekickId: 'sidekick-1',
    wakeId: 'wake-completed-code',
    status: 'completed',
    durationMs: 5_000,
    code: 'DEVICE.OK',
  }, completedWithCode.deps);
  assert.equal(completedWithCode.logs[0][1].technicalCode, 'device.ok');

  const failed = createDeps();
  handleWakeBeepResult(runtime, {
    sidekickId: 'sidekick-1',
    wakeId: 'wake-failed',
    status: 'failed',
    durationMs: 25,
    code: 'SPEAKER-TIMEOUT',
  }, failed.deps);
  assert.equal(runtime.wakeBeep.technicalCode, 'sidekick_wake_beep_speaker-timeout');
  assert.equal(failed.logs[0][1].technicalCode, 'speaker-timeout');
  assert.deepEqual(failed.emitted, ['emit']);
});

test('network overflow diagnostics log fallback codes and only interrupt active playback', () => {
  const idleRuntime = { speakerPlayback: null };
  const idle = createDeps();
  handleNetworkRxOverflow(idleRuntime, {
    sidekickId: 'sidekick-1',
    code: {},
    droppedMessages: 1,
    totalDroppedMessages: 2,
    queueDepth: 8,
    maxInFlightMessages: 8,
  }, idle.deps);
  assert.equal(idle.logs[0][1].technicalCode, 'rx_queue_full');
  assert.deepEqual(idle.rejected, []);
  assert.deepEqual(idle.emitted, []);

  const playingRuntime = { speakerPlayback: { requestId: 'speaker-1' } };
  const playing = createDeps();
  handleNetworkRxOverflow(playingRuntime, {
    sidekickId: 'sidekick-1',
    code: 'QUEUE.OVERFLOW',
    droppedMessages: 3,
    totalDroppedMessages: 9,
    queueDepth: 12,
    maxInFlightMessages: 8,
  }, playing.deps);
  assert.deepEqual(playing.logs[0], ['sidekick:network_rx_overflow', {
    sidekickId: 'sidekick-1',
    technicalCode: 'queue.overflow',
    droppedMessages: 3,
    totalDroppedMessages: 9,
    queueDepth: 12,
    maxInFlightMessages: 8,
  }]);
  assert.equal(playingRuntime.speakerErrorMessage, 'La conexión del Sidekick no pudo recibir el audio a tiempo.');
  assert.equal(playingRuntime.speakerErrorCode, 'sidekick_network_rx_overflow');
  assert.equal(playing.rejected[0].message, 'sidekick_network_rx_overflow');
  assert.deepEqual(playing.emitted, ['emit']);
});
