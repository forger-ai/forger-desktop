import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import { WebSocket } from 'ws';

const require = createRequire(import.meta.url);
const { SidekickMicrophoneController } = require('../../dist-electron/main/sidekick-microphone-controller.js');
const {
  SIDEKICK_MIC_CHANNELS,
  SIDEKICK_MIC_FORMAT,
  SIDEKICK_MIC_MAX_CHUNK_BYTES,
  SIDEKICK_MIC_SAMPLE_RATE,
  WAV_HEADER_BYTES,
} = require('../../dist-electron/main/sidekick-service-helpers.js');

const SIDEKICK_ID = 'sidekick-b18';
const record = (overrides = {}) => ({ sidekickId: SIDEKICK_ID, capabilities: ['microphone.record'], ...overrides });
const socket = (readyState = WebSocket.OPEN) => ({ readyState });
const runtimeState = (overrides = {}) => ({
  status: 'online', sessionId: 'session-b18', socket: socket(),
  pendingRecordingAcks: new Map(), pendingSpeakerAcks: new Map(),
  ...overrides,
});
const activeRecording = (overrides = {}) => ({
  sidekickId: SIDEKICK_ID, recordingId: 'recording-b18', status: 'recording',
  startedAt: '2026-01-01T00:00:00.000Z', bytes: 0, chunks: 0,
  tempPcmPath: '', persist: false, nextChunkSequence: 0,
  sampleRate: SIDEKICK_MIC_SAMPLE_RATE, channels: SIDEKICK_MIC_CHANNELS, format: SIDEKICK_MIC_FORMAT,
  ...overrides,
});
const storedRecording = (overrides = {}) => ({
  recordingId: overrides.recordingId ?? 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  sidekickId: overrides.sidekickId ?? SIDEKICK_ID,
  createdAt: overrides.createdAt ?? '2026-01-01T00:00:00.000Z',
  stoppedAt: '2026-01-01T00:00:01.000Z', durationMs: 1_000, sampleCount: SIDEKICK_MIC_SAMPLE_RATE,
  sampleRate: SIDEKICK_MIC_SAMPLE_RATE, channels: SIDEKICK_MIC_CHANNELS, format: SIDEKICK_MIC_FORMAT,
  sizeBytes: overrides.sizeBytes ?? WAV_HEADER_BYTES + 2,
  filename: overrides.filename ?? `${overrides.recordingId ?? 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'}.wav`,
});

const createHarness = async (overrides = {}) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forger-microphone-b18-'));
  const runtime = overrides.runtime ?? runtimeState();
  const records = new Map(overrides.records ?? [[SIDEKICK_ID, record()]]);
  const runtimes = new Map(overrides.runtimes ?? [[SIDEKICK_ID, runtime]]);
  const sent = [];
  const logs = [];
  const pcm = [];
  let controller;
  controller = new SidekickMicrophoneController({
    metadataRoot: root,
    maxRecordingBytes: overrides.maxRecordingBytes,
    recentRecordingLimit: overrides.recentRecordingLimit,
    findRecord: (id) => records.get(id),
    getRuntime: (id) => runtimes.get(id),
    buildState: () => ({ sidekicks: [] }),
    sendEncrypted: async (stored, state, payload) => {
      sent.push(payload);
      if (overrides.sendEncrypted) return await overrides.sendEncrypted(stored, state, payload, controller);
    },
    emit: () => {},
    log: async (event, payload) => { logs.push({ event, payload }); },
    ...(overrides.withPcm === false ? {} : { onMicrophonePcm: async (event) => { pcm.push(event); } }),
  });
  return {
    root, runtime, records, runtimes, sent, logs, pcm, controller,
    cleanup: async () => await fs.rm(root, { recursive: true, force: true }),
  };
};

test('given persisted indexes and files, load, summaries, read validation, pruning, finalization, and forget are safe', async () => {
  const harness = await createHarness({ recentRecordingLimit: 1, maxRecordingBytes: 1_000 });
  try {
    const indexDir = path.join(harness.root, 'sidekick-recordings');
    const filesDir = path.join(indexDir, 'files');
    const tmpDir = path.join(indexDir, 'tmp');
    await fs.mkdir(filesDir, { recursive: true });
    await fs.mkdir(tmpDir, { recursive: true });
    const valid = storedRecording();
    await fs.writeFile(path.join(indexDir, 'index.json'), JSON.stringify({ version: 1, recordings: [null, valid] }));
    const controller = harness.controller;
    await controller.load();
    await controller.load();
    assert.equal(controller.summariesFor(SIDEKICK_ID).length, 1);
    assert.equal(controller.summariesFor('other').length, 0);
    assert.equal((await controller.read({ sidekickId: SIDEKICK_ID, recordingId: 'missing' })).technicalCode, 'sidekick_microphone_recording_not_found');

    controller.recordings.push(storedRecording({ recordingId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', filename: '../escape.wav' }));
    assert.equal((await controller.read({ sidekickId: SIDEKICK_ID, recordingId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' })).technicalCode, 'sidekick_microphone_recording_invalid_path');
    assert.equal((await controller.read({ sidekickId: SIDEKICK_ID, recordingId: valid.recordingId })).technicalCode, 'sidekick_microphone_recording_size_invalid');
    await fs.writeFile(path.join(filesDir, valid.filename), Buffer.alloc(valid.sizeBytes));
    assert.equal((await controller.read({ sidekickId: SIDEKICK_ID, recordingId: valid.recordingId })).success, true);
    await fs.writeFile(path.join(filesDir, valid.filename), Buffer.alloc(1_001));
    assert.equal((await controller.read({ sidekickId: SIDEKICK_ID, recordingId: valid.recordingId })).technicalCode, 'sidekick_microphone_recording_size_invalid');

    const invalidActive = activeRecording({ recordingId: 'invalid-final', persist: true, tempPcmPath: path.join(tmpDir, 'missing.pcm'), bytes: 2 });
    await assert.rejects(() => controller.finalize(invalidActive, 1), /sidekick_microphone_recording_size_invalid/);

    const oldId = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
    const otherId = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
    const old = storedRecording({ recordingId: oldId, createdAt: '2025-01-01T00:00:00.000Z' });
    const other = storedRecording({ recordingId: otherId, sidekickId: 'other', createdAt: '2024-01-01T00:00:00.000Z' });
    controller.recordings = [old, other];
    await fs.writeFile(path.join(filesDir, old.filename), Buffer.alloc(old.sizeBytes));
    await fs.writeFile(path.join(filesDir, other.filename), Buffer.alloc(other.sizeBytes));
    const pcmPath = path.join(tmpDir, 'new.pcm');
    await fs.writeFile(pcmPath, Buffer.from([0, 0]));
    await controller.finalize(activeRecording({
      recordingId: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', persist: true, tempPcmPath: pcmPath, bytes: 2,
      startedAt: '2026-02-01T00:00:00.000Z',
    }), 1);
    assert.deepEqual(controller.recordings.map((item) => item.recordingId).sort(), [otherId, 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'].sort());
    await assert.rejects(fs.stat(path.join(filesDir, old.filename)), { code: 'ENOENT' });
    await controller.forget(SIDEKICK_ID);
    assert.deepEqual(controller.summariesFor(SIDEKICK_ID), []);
    await controller.forget('missing');
  } finally {
    await harness.cleanup();
  }

  for (const content of ['bad json', JSON.stringify({ version: 2, recordings: [] })]) {
    const malformed = await createHarness();
    try {
      await fs.mkdir(path.dirname(malformed.controller.recordingsIndexPath), { recursive: true });
      await fs.writeFile(malformed.controller.recordingsIndexPath, content);
      await malformed.controller.load();
      assert.deepEqual(malformed.controller.recordings, []);
    } finally {
      await malformed.cleanup();
    }
  }
});

test('given start and stop preconditions or transport failures, runtime state and stable error codes recover without dangling ACKs', async () => {
  const missing = await createHarness({ records: [] });
  try {
    assert.equal((await missing.controller.start({ sidekickId: SIDEKICK_ID })).technicalCode, 'sidekick_not_registered');
    assert.equal((await missing.controller.stop({ sidekickId: SIDEKICK_ID })).technicalCode, 'sidekick_not_registered');
  } finally { await missing.cleanup(); }

  for (const scenario of [
    { runtime: runtimeState({ socket: socket(WebSocket.CLOSED) }), code: 'sidekick_offline' },
    { runtime: runtimeState(), record: record({ capabilities: [] }), code: 'sidekick_microphone_capability_missing' },
    { runtime: runtimeState({ microphoneRecording: activeRecording() }), code: 'sidekick_microphone_recording_active' },
    { runtime: runtimeState({ speakerPlayback: { playbackId: 'playing' } }), code: 'sidekick_audio_busy' },
  ]) {
    const harness = await createHarness({ runtime: scenario.runtime, records: [[SIDEKICK_ID, scenario.record ?? record()]] });
    try { assert.equal((await harness.controller.start({ sidekickId: SIDEKICK_ID })).technicalCode, scenario.code); }
    finally { await harness.cleanup(); }
  }

  for (const thrown of [new Error('send failed'), 'string failure']) {
    const harness = await createHarness({ sendEncrypted: async () => { throw thrown; } });
    try {
      const failed = await harness.controller.start({ sidekickId: SIDEKICK_ID, transient: true });
      assert.equal(failed.technicalCode, 'sidekick_microphone_start_failed');
      assert.equal(harness.runtime.microphoneRecording, undefined);
      assert.equal(harness.runtime.pendingRecordingAcks.size, 0);
    } finally { await harness.cleanup(); }
  }

  for (const scenario of [
    { runtime: runtimeState(), code: 'sidekick_microphone_recording_not_active' },
    { runtime: runtimeState({ microphoneRecording: activeRecording({ status: 'starting' }) }), code: 'sidekick_microphone_recording_not_active' },
    { runtime: runtimeState({ microphoneRecording: activeRecording(), socket: null }), code: 'sidekick_offline' },
  ]) {
    const harness = await createHarness({ runtime: scenario.runtime });
    try { assert.equal((await harness.controller.stop({ sidekickId: SIDEKICK_ID })).technicalCode, scenario.code); }
    finally { await harness.cleanup(); }
  }

  for (const thrown of [new Error('sidekick_microphone_sample_count_mismatch'), 'non-error']) {
    const runtime = runtimeState({ microphoneRecording: activeRecording() });
    const harness = await createHarness({ runtime, sendEncrypted: async () => { throw thrown; } });
    try {
      const failed = await harness.controller.stop({ sidekickId: SIDEKICK_ID });
      assert.equal(failed.technicalCode, thrown instanceof Error ? thrown.message : 'sidekick_microphone_stop_failed');
      assert.equal(runtime.microphoneRecording.status, 'recording');
    } finally { await harness.cleanup(); }
  }

  const replacedRuntime = runtimeState({ microphoneRecording: activeRecording() });
  const replaced = await createHarness({
    runtime: replacedRuntime,
    sendEncrypted: async () => {
      replacedRuntime.microphoneRecording = activeRecording({ recordingId: 'replacement' });
      throw new Error('stop failed');
    },
  });
  try {
    assert.equal((await replaced.controller.stop({ sidekickId: SIDEKICK_ID })).technicalCode, 'sidekick_microphone_stop_failed');
    assert.equal(replacedRuntime.microphoneRecording.recordingId, 'replacement');
  } finally { await replaced.cleanup(); }
});

test('given microphone payload variants, started, chunk, stopped, device error, and abort paths validate identity and format', async () => {
  const harness = await createHarness({ maxRecordingBytes: WAV_HEADER_BYTES + 4 });
  const { controller, runtime } = harness;
  const reset = (overrides = {}) => { runtime.microphoneRecording = activeRecording(overrides); };
  try {
    await controller.handlePayload(runtime, { type: 'unknown' });
    await controller.handlePayload(runtime, { type: 'microphone.recording.started', recordingId: 'other' });
    reset({ status: 'starting' });
    await controller.handlePayload(runtime, {
      type: 'microphone.recording.started', recordingId: 'recording-b18', sampleRate: 8_000, channels: 1, format: 'pcm_s16le',
    });
    assert.equal(runtime.microphoneErrorCode, 'sidekick_microphone_started_invalid');

    reset({ status: 'starting' });
    await controller.handlePayload(runtime, {
      type: 'microphone.recording.started', recordingId: 'recording-b18', sampleRate: SIDEKICK_MIC_SAMPLE_RATE,
      channels: SIDEKICK_MIC_CHANNELS, format: SIDEKICK_MIC_FORMAT,
    });
    assert.equal(runtime.microphoneRecording.status, 'recording');

    await controller.handlePayload(runtime, { type: 'microphone.recording.chunk', recordingId: 'other', data: 'AAA=' });
    reset();
    await controller.handlePayload(runtime, { type: 'microphone.recording.chunk', recordingId: 'recording-b18', data: 9 });
    assert.equal(runtime.microphoneErrorCode, 'sidekick_microphone_chunk_invalid');
    for (const sequence of [0.5, 2]) {
      reset();
      await controller.handlePayload(runtime, { type: 'microphone.recording.chunk', recordingId: 'recording-b18', data: 'AAA=', chunkSequence: sequence });
      assert.equal(runtime.microphoneErrorCode, 'sidekick_microphone_chunk_sequence_invalid');
    }
    for (const data of ['not canonical', Buffer.alloc(3).toString('base64'), Buffer.alloc(SIDEKICK_MIC_MAX_CHUNK_BYTES + 2).toString('base64')]) {
      reset();
      await controller.handlePayload(runtime, { type: 'microphone.recording.chunk', recordingId: 'recording-b18', data });
      assert.equal(runtime.microphoneErrorCode, 'sidekick_microphone_chunk_invalid');
    }
    reset({ bytes: 4 });
    await controller.handlePayload(runtime, { type: 'microphone.recording.chunk', recordingId: 'recording-b18', data: 'AAA=' });
    assert.equal(runtime.microphoneErrorCode, 'sidekick_microphone_recording_too_large');

    reset();
    await controller.handlePayload(runtime, { type: 'microphone.recording.chunk', recordingId: 'recording-b18', data: 'AAA=' });
    assert.equal(runtime.microphoneRecording.bytes, 2);
    assert.equal(harness.pcm.length, 1);
    const noCallback = await createHarness({ withPcm: false });
    try {
      noCallback.runtime.microphoneRecording = activeRecording();
      await noCallback.controller.handlePayload(noCallback.runtime, { type: 'microphone.recording.chunk', recordingId: 'recording-b18', data: 'AAA=' });
      assert.equal(noCallback.runtime.microphoneRecording.bytes, 2);
    } finally { await noCallback.cleanup(); }

    for (const sampleCount of ['bad', 0.5, -1]) {
      reset();
      await controller.handlePayload(runtime, { type: 'microphone.recording.stopped', recordingId: 'recording-b18', sampleCount });
      assert.equal(runtime.microphoneErrorCode, 'sidekick_microphone_stopped_invalid');
    }
    reset({ bytes: 1 });
    await controller.handlePayload(runtime, { type: 'microphone.recording.stopped', recordingId: 'recording-b18', sampleCount: 1 });
    assert.equal(runtime.microphoneErrorCode, 'sidekick_microphone_sample_count_mismatch');
    reset({ bytes: 2 });
    await controller.handlePayload(runtime, { type: 'microphone.recording.stopped', recordingId: 'recording-b18', sampleCount: 1 });
    assert.equal(runtime.microphoneRecording, undefined);
    await controller.handlePayload(runtime, { type: 'microphone.recording.stopped', recordingId: 'recording-b18', sampleCount: 0 });

    reset();
    await controller.handlePayload(runtime, { type: 'microphone.recording.error', recordingId: 'other', code: 'safe' });
    assert.equal(runtime.microphoneRecording.recordingId, 'recording-b18');
    await controller.handlePayload(runtime, { type: 'microphone.recording.error', recordingId: 'recording-b18', code: '../bad' });
    assert.equal(runtime.microphoneErrorCode, 'sidekick_microphone_error_invalid');
    reset();
    await controller.handlePayload(runtime, { type: 'microphone.recording.error', recordingId: 'recording-b18', code: 'device_failed' });
    assert.equal(runtime.microphoneErrorCode, 'sidekick_microphone_device_failed');

    await controller.failActive(runtime, 'No active', 'none');
    await controller.cleanupActive(runtime, 'none');
    await controller.abortActive(runtime, 'No active', 'none');
    reset();
    harness.records.clear();
    await controller.abortActive(runtime, 'No record', 'none');
  } finally {
    await harness.cleanup();
  }
});

test('given ACK concurrency and timeouts, duplicate waiters share promises while resolve, cancel, reject, and expiry clean the map', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const harness = await createHarness();
  const runtime = harness.runtime;
  try {
    const started = harness.controller.waitForAck(runtime, 'started', 'one');
    assert.equal(harness.controller.waitForAck(runtime, 'started', 'one'), started);
    harness.controller.resolveAck(runtime, 'started', 'missing');
    harness.controller.resolveAck(runtime, 'started', 'one');
    await started;

    const canceled = harness.controller.waitForAck(runtime, 'stopped', 'two');
    harness.controller.cancelAck(runtime, 'stopped', 'missing');
    harness.controller.cancelAck(runtime, 'stopped', 'two');
    await assert.rejects(canceled, /sidekick_microphone_stopped_cancelled/);

    const unrelated = harness.controller.waitForAck(runtime, 'started', 'other');
    const rejected = harness.controller.waitForAck(runtime, 'started', 'three');
    harness.controller.rejectAcks(runtime, 'three', new Error('closed'));
    await assert.rejects(rejected, /closed/);
    harness.controller.resolveAck(runtime, 'started', 'other');
    await unrelated;

    const expired = harness.controller.waitForAck(runtime, 'started', 'timeout');
    t.mock.timers.tick(30_000);
    await assert.rejects(expired, /sidekick_microphone_started_timeout/);
  } finally {
    harness.controller.rejectAcks(runtime, 'timeout', new Error('cleanup'));
    t.mock.timers.reset();
    await harness.cleanup();
  }

  const realSetTimeout = globalThis.setTimeout;
  const noUnref = await createHarness();
  try {
    globalThis.setTimeout = () => ({ token: true });
    const promise = noUnref.controller.waitForAck(noUnref.runtime, 'started', 'no-unref');
    noUnref.controller.resolveAck(noUnref.runtime, 'started', 'no-unref');
    await promise;
  } finally {
    globalThis.setTimeout = realSetTimeout;
    await noUnref.cleanup();
  }
});
