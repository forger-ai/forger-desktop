import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  parseSidekickTimeReceipt,
  parseSidekickWakeReceipt,
  SidekickSpeakerReceipts,
} = require('../../dist-electron/main/sidekick-network-receipts.js');

const activeRuntime = (status = 'starting') => ({
  pendingSpeakerAcks: new Map(),
  speakerPlayback: {
    playbackId: 'playback-1',
    status,
    queueDepth: 1,
    maxInFlightChunks: 1,
    samplesSent: 4,
  },
});

const pendingRuntime = (status = 'starting') => {
  const runtime = activeRuntime(status);
  const outcomes = [];
  const timeout = setTimeout(() => {}, 10_000);
  timeout.unref();
  runtime.pendingSpeakerAcks.set('pending', {
    key: 'pending',
    timeout,
    resolve: () => outcomes.push('resolved'),
    reject: (error) => outcomes.push(error.message),
  });
  return { runtime, outcomes };
};

test('Given device time and wake receipts, valid optional fields are normalized and every unsafe boundary is rejected', () => {
  const timeBase = {
    timeZone: 'America/Santiago',
    utcOffsetMinutes: -180,
    deviceEpochMs: 1_786_363_200_000,
  };
  const fullTime = parseSidekickTimeReceipt({ ...timeBase, driftMs: 1.5, clockAdjusted: false });
  assert.equal(fullTime.synced, true);
  assert.equal(fullTime.driftMs, 1.5);
  assert.equal(fullTime.clockAdjusted, false);
  assert.equal(typeof fullTime.lastSyncedAt, 'string');
  const timeWithoutInvalidOptions = parseSidekickTimeReceipt({ ...timeBase, driftMs: Infinity, clockAdjusted: 'no' });
  assert.deepEqual({ ...timeWithoutInvalidOptions, lastSyncedAt: '<dynamic>' }, {
    synced: true,
    epochMs: timeBase.deviceEpochMs,
    timeZone: timeBase.timeZone,
    utcOffsetMinutes: timeBase.utcOffsetMinutes,
    lastSyncedAt: '<dynamic>',
  });
  parseSidekickTimeReceipt({ ...timeBase });

  for (const patch of [
    { timeZone: undefined },
    { timeZone: 'contains space' },
    { utcOffsetMinutes: '0' },
    { utcOffsetMinutes: 1.5 },
    { utcOffsetMinutes: -841 },
    { utcOffsetMinutes: 841 },
    { deviceEpochMs: 'now' },
    { deviceEpochMs: Number.MAX_SAFE_INTEGER + 1 },
  ]) {
    assert.throws(() => parseSidekickTimeReceipt({ ...timeBase, ...patch }), /sidekick_time_sync_receipt_invalid/);
  }

  const wakeBase = {
    sidekickId: 'sidekick-1',
    wakeId: 'wake_1',
    model: 'tiny',
    wakeWord: 'forger',
    wordIndex: 1,
    detectedAtMs: 0,
  };
  assert.deepEqual(parseSidekickWakeReceipt({ ...wakeBase, epochMs: 123 }), { ...wakeBase, epochMs: 123 });
  assert.deepEqual(parseSidekickWakeReceipt({ ...wakeBase, epochMs: 1.2 }), wakeBase);
  for (const patch of [
    { sidekickId: undefined },
    { wakeId: undefined },
    { wakeId: 'bad id' },
    { model: undefined },
    { model: '  ' },
    { wakeWord: undefined },
    { wakeWord: '  ' },
    { wordIndex: '1' },
    { wordIndex: 1.5 },
    { wordIndex: 0 },
    { detectedAtMs: '0' },
    { detectedAtMs: 0.5 },
    { detectedAtMs: -1 },
  ]) {
    assert.throws(() => parseSidekickWakeReceipt({ ...wakeBase, ...patch }), /sidekick_wake_event_invalid/);
  }
});

test('Given a starting playback, started receipts negotiate credits and isolate malformed or stale traffic', async () => {
  const receipts = new SidekickSpeakerReceipts(20);
  receipts.handleStarted({ pendingSpeakerAcks: new Map() }, { playbackId: 'playback-1' });
  receipts.handleStarted(activeRuntime('playing'), { playbackId: 'playback-1' });
  receipts.handleStarted(activeRuntime(), { playbackId: 'other' });

  for (const patch of [
    { maxChunkSamples: 512, queueDepth: 1 },
    { maxChunkSamples: 1024, queueDepth: '1' },
    { maxChunkSamples: 1024, queueDepth: 1.5 },
    { maxChunkSamples: 1024, queueDepth: 0 },
    { maxChunkSamples: 1024, queueDepth: 33 },
    { maxChunkSamples: 1024, queueDepth: 2, maxInFlightChunks: '1' },
    { maxChunkSamples: 1024, queueDepth: 2, maxInFlightChunks: 1.5 },
    { maxChunkSamples: 1024, queueDepth: 2, maxInFlightChunks: 0 },
    { maxChunkSamples: 1024, queueDepth: 2, maxInFlightChunks: 3 },
  ]) {
    const { runtime } = pendingRuntime();
    receipts.handleStarted(runtime, { playbackId: 'playback-1', ...patch });
    assert.equal(runtime.pendingSpeakerAcks.size, 0);
  }

  const legacy = activeRuntime();
  const legacyAck = receipts.wait(legacy, 'started:playback-1');
  receipts.handleStarted(legacy, { playbackId: 'playback-1', maxChunkSamples: 1024, queueDepth: 4 });
  await legacyAck;
  assert.equal(legacy.speakerPlayback.maxInFlightChunks, 1);

  const negotiated = activeRuntime();
  receipts.handleStarted(negotiated, {
    playbackId: 'playback-1',
    maxChunkSamples: 1024,
    queueDepth: 4,
    maxInFlightChunks: 2,
  });
  assert.equal(negotiated.speakerPlayback.status, 'playing');
  assert.equal(negotiated.speakerPlayback.maxInFlightChunks, 2);
});

test('Given active playback, progress, stop, and error receipts settle only matching acknowledgements', async () => {
  const receipts = new SidekickSpeakerReceipts(20);
  const progressPayload = {
    playbackId: 'playback-1',
    lastChunkSequence: 0,
    bufferedSamples: 2,
    underruns: 0,
  };
  receipts.handleProgress({ pendingSpeakerAcks: new Map() }, progressPayload);
  receipts.handleProgress(activeRuntime('starting'), progressPayload);
  receipts.handleProgress(activeRuntime('playing'), { ...progressPayload, playbackId: 'other' });
  for (const patch of [
    { lastChunkSequence: '0' },
    { lastChunkSequence: 0.5 },
    { lastChunkSequence: -1 },
    { bufferedSamples: '2' },
    { bufferedSamples: 1.5 },
    { bufferedSamples: -1 },
    { underruns: '0' },
    { underruns: 0.5 },
    { underruns: -1 },
  ]) {
    const { runtime } = pendingRuntime('playing');
    receipts.handleProgress(runtime, { ...progressPayload, ...patch });
    assert.equal(runtime.pendingSpeakerAcks.size, 0);
  }
  for (const status of ['playing', 'stopping']) {
    const runtime = activeRuntime(status);
    const ack = receipts.wait(runtime, 'progress:playback-1:0');
    receipts.handleProgress(runtime, progressPayload);
    await ack;
    assert.equal(runtime.speakerPlayback.bufferedSamples, 2);
  }

  const stoppedPayload = {
    playbackId: 'playback-1',
    samplesPlayed: 4,
    underruns: 0,
    droppedChunks: 0,
  };
  receipts.handleStopped({ pendingSpeakerAcks: new Map() }, stoppedPayload);
  receipts.handleStopped(activeRuntime('playing'), stoppedPayload);
  receipts.handleStopped(activeRuntime('stopping'), { ...stoppedPayload, playbackId: 'other' });
  for (const patch of [
    { samplesPlayed: '4' },
    { samplesPlayed: 1.5 },
    { samplesPlayed: -1 },
    { underruns: '0' },
    { underruns: 0.5 },
    { underruns: -1 },
    { droppedChunks: '0' },
    { droppedChunks: 0.5 },
    { droppedChunks: -1 },
  ]) {
    const { runtime } = pendingRuntime('stopping');
    receipts.handleStopped(runtime, { ...stoppedPayload, ...patch });
    assert.equal(runtime.pendingSpeakerAcks.size, 0);
  }
  const mismatch = pendingRuntime('stopping');
  receipts.handleStopped(mismatch.runtime, { ...stoppedPayload, samplesPlayed: 3 });
  assert.deepEqual(mismatch.outcomes, ['sidekick_speaker_sample_count_mismatch']);

  const stopped = activeRuntime('stopping');
  const stoppedAck = receipts.wait(stopped, 'stopped:playback-1');
  receipts.handleStopped(stopped, stoppedPayload);
  await stoppedAck;
  assert.equal(stopped.speakerPlayback.samplesPlayed, 4);

  const cancelled = pendingRuntime('starting');
  receipts.handleStopped(cancelled.runtime, { ...stoppedPayload, cancelled: true });
  assert.equal(cancelled.runtime.speakerPlayback, undefined);
  assert.deepEqual(cancelled.outcomes, ['sidekick_speaker_playback_interrupted']);
  const cancelledWhilePlaying = pendingRuntime('playing');
  receipts.handleStopped(cancelledWhilePlaying.runtime, { ...stoppedPayload, cancelled: true });
  assert.equal(cancelledWhilePlaying.runtime.speakerPlayback, undefined);

  const cancelling = activeRuntime('cancelling');
  const cancellingAck = receipts.wait(cancelling, 'stopped:playback-1');
  receipts.handleStopped(cancelling, stoppedPayload);
  await cancellingAck;

  receipts.handleError({ pendingSpeakerAcks: new Map() }, { playbackId: 'playback-1', code: 'device' });
  receipts.handleError(activeRuntime('playing'), { playbackId: 'other', code: 'device' });
  const invalidError = pendingRuntime('playing');
  receipts.handleError(invalidError.runtime, { playbackId: 'playback-1', code: 'unsafe code' });
  assert.deepEqual(invalidError.outcomes, ['sidekick_speaker_error_invalid']);
  const deviceError = pendingRuntime('playing');
  receipts.handleError(deviceError.runtime, { playbackId: 'playback-1', code: 'decoder.failed' });
  assert.deepEqual(deviceError.outcomes, ['sidekick_speaker_decoder.failed']);
});

test('Given duplicate and missing acknowledgements, wait replaces, times out, and rejects deterministically', async () => {
  const receipts = new SidekickSpeakerReceipts(5);
  const runtime = activeRuntime('playing');
  const first = receipts.wait(runtime, 'progress:playback-1:1');
  const second = receipts.wait(runtime, 'progress:playback-1:1');
  await assert.rejects(first, /sidekick_speaker_ack_replaced/);
  receipts.handleProgress(runtime, {
    playbackId: 'playback-1',
    lastChunkSequence: 1,
    bufferedSamples: 0,
    underruns: 0,
  });
  await second;

  const timedOut = receipts.wait(runtime, 'never');
  await assert.rejects(timedOut, /sidekick_speaker_ack_timeout/);
  assert.equal(runtime.pendingSpeakerAcks.size, 0);

  receipts.handleProgress(runtime, {
    playbackId: 'playback-1',
    lastChunkSequence: 99,
    bufferedSamples: 0,
    underruns: 0,
  });
  receipts.reject(runtime, new Error('nothing-pending'));
});
