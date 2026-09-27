import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { clearDistModule, withMockedElectron } from './electron-test-helpers.mjs';
import {
  SIDEKICK_ID,
  connectPairedSidekick,
  createSafeStorage,
  createSidekickService,
  readDesktopCommand,
  tmpRoot,
  waitForSocketClose,
  waitForState,
  writePairedSidekickStore,
} from './sidekick-service-test-harness.mjs';

test('SidekickService does not recreate staged PCM when a pending append resumes after socket close', { timeout: 15_000 }, async (t) => {
  const root = await tmpRoot('sidekick-service-mic-close-cleanup');
  let service;
  let stagedPath;
  const originalAppend = fs.appendFile;
  let enter, release, complete;
  const entered = new Promise((resolve) => { enter = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const completed = new Promise((resolve) => { complete = resolve; });
  fs.appendFile = async (...args) => {
    if (args[0] !== stagedPath) return originalAppend(...args);
    enter();
    await gate;
    try { return await originalAppend(...args); } finally { complete(); }
  };
  t.after(async () => {
    release();
    fs.appendFile = originalAppend;
    try {
      await service?.dispose();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  await withMockedElectron({ safeStorage: createSafeStorage() }, async (require) => {
    clearDistModule('main/sidekick-service.js');
    const { SidekickService, __testSidekickInternals } = require('../../dist-electron/main/sidekick-service.js');
    const pairingSecret = randomBytes(32).toString('base64');
    const logs = [];
    await writePairedSidekickStore(root, pairingSecret, ['display.text', 'wifi.websocket', 'microphone.record']);
    service = createSidekickService(SidekickService, root, {
      appendLog: async (event, payload) => { logs.push({ event, payload }); },
      getVoicePhase: () => 'listening',
    });
    const { socket, sendPayload } = await connectPairedSidekick({ service, internals: __testSidekickInternals, pairingSecret });

    const startPromise = service.startMicrophoneRecording({ sidekickId: SIDEKICK_ID });
    const startCommand = await readDesktopCommand(socket, __testSidekickInternals, pairingSecret);
    sendPayload({
      v: 1,
      type: 'microphone.recording.started',
      recordingId: startCommand.recordingId,
      sampleRate: 16000,
      channels: 1,
      format: 'pcm_s16le',
    });
    await startPromise;
    stagedPath = path.join(root, 'sidekick-recordings', 'tmp', `${startCommand.recordingId}.pcm`);
    sendPayload({
      v: 1,
      type: 'microphone.recording.chunk',
      recordingId: startCommand.recordingId,
      data: Buffer.from([0x00, 0x00]).toString('base64'),
    });
    await entered;
    socket.close(4001, 'wifi_reset');
    await waitForSocketClose(socket);
    const state = await waitForState(
      () => service.getState(),
      (candidate) => candidate.sidekicks[0]?.microphoneRecording?.status === 'error',
    );
    assert.equal(state.sidekicks[0].microphoneRecording.status, 'error');
    assert.equal(state.sidekicks[0].microphoneRecording.technicalCode, 'sidekick_socket_closed');
    await waitForState(async () => logs, (entries) => entries.some((entry) => entry.event === 'sidekick:socket_closed'));
    const socketLog = logs.find((entry) => entry.event === 'sidekick:socket_closed');
    assert.deepEqual(socketLog.payload, {
      sidekickId: SIDEKICK_ID,
      closeCode: 4001,
      closeReason: 'wifi_reset',
      microphoneStatus: 'recording',
      speakerStatus: 'idle',
      voicePhase: 'listening',
    });
    await assert.rejects(fs.stat(stagedPath), { code: 'ENOENT' });
    release();
    await completed;
    // Wait for the handler's post-write cleanup, not only the filesystem write.
    await waitForState(async () => await fs.stat(stagedPath).catch(() => null), (stat) => stat === null);
    await assert.rejects(fs.stat(stagedPath), { code: 'ENOENT' });
  });
});

for (const boundary of ['callback', 'append']) {
  for (const fails of [false, true]) {
    test(`a cancelled ${boundary} ${fails ? 'failure' : 'completion'} preserves the replacement recording`, { timeout: 15_000 }, async (t) => {
      const root = await tmpRoot('sidekick-mic-replacement');
      const originalAppend = fs.appendFile;
      let release, entered;
      const gate = new Promise((resolve) => { release = resolve; });
      const waiting = new Promise((resolve) => { entered = resolve; });
      const oldPath = path.join(root, 'old.pcm');
      const newPath = path.join(root, 'new.pcm');
      let pending;
      t.after(async () => {
        release();
        fs.appendFile = originalAppend;
        await pending;
        await fs.rm(root, { recursive: true, force: true });
      });
      await withMockedElectron({ safeStorage: createSafeStorage() }, async (require) => {
        const { SidekickMicrophoneController } = require('../../dist-electron/main/sidekick-microphone-controller.js');
        const old = { sidekickId: SIDEKICK_ID, recordingId: 'old', status: 'recording', persist: true,
          tempPcmPath: oldPath, bytes: 0, chunks: 0, nextChunkSequence: 0 };
        const replacement = { ...old, recordingId: 'new', tempPcmPath: newPath };
        const runtime = { microphoneRecording: old, pendingRecordingAcks: new Map() };
        await fs.writeFile(oldPath, Buffer.alloc(0));
        await fs.writeFile(newPath, Buffer.from([1, 2]));
        const pause = async () => { entered(); await gate; };
        fs.appendFile = async (...args) => {
          if (args[0] !== oldPath) return originalAppend(...args);
          await pause();
          await originalAppend(...args);
          if (fails) throw new Error('delayed append failure');
        };
        const controller = new SidekickMicrophoneController({ metadataRoot: root,
          onMicrophonePcm: async () => {
            if (boundary !== 'callback') return;
            await pause();
            if (fails) throw new Error('delayed callback failure');
          },
        });
        pending = controller.handlePayload(runtime, { type: 'microphone.recording.chunk', recordingId: 'old', data: 'AAA=' });
        await waiting;
        await controller.cleanupActive(runtime, 'disconnected');
        runtime.microphoneRecording = replacement;
        release();
        await pending;
        assert.equal(runtime.microphoneRecording, replacement);
        assert.equal(replacement.bytes, 0);
        assert.equal(old.bytes, 0);
        assert.deepEqual(await fs.readFile(newPath), Buffer.from([1, 2]));
        await assert.rejects(fs.stat(oldPath), { code: 'ENOENT' });
      });
    });
  }
}

test('an active recording still reports a PCM consumer failure', async () => {
  await withMockedElectron({ safeStorage: createSafeStorage() }, async (require) => {
    const { SidekickMicrophoneController } = require('../../dist-electron/main/sidekick-microphone-controller.js');
    const active = { sidekickId: SIDEKICK_ID, recordingId: 'active', status: 'recording',
      persist: false, bytes: 0, chunks: 0, nextChunkSequence: 0 };
    const runtime = { microphoneRecording: active };
    const failure = new Error('PCM consumer unavailable');
    const controller = new SidekickMicrophoneController({ metadataRoot: '.',
      onMicrophonePcm: async () => { throw failure; },
    });
    await assert.rejects(controller.handlePayload(runtime, {
      type: 'microphone.recording.chunk', recordingId: 'active', data: 'AAA=',
    }), (error) => error === failure);
    assert.equal(runtime.microphoneRecording, active);
    assert.equal(active.bytes, 0);
  });
});
