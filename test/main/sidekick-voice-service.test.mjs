import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { WebSocket } from 'ws';

import { clearDistModule, withMockedElectron } from './electron-test-helpers.mjs';
import {
  SIDEKICK_ID,
  connectPairedSidekick,
  createSafeStorage,
  createSidekickService,
  readDesktopCommand,
  tmpRoot,
  waitForState,
  writePairedSidekickStore,
} from './sidekick-service-test-harness.mjs';

test('SidekickService treats repeated microphone stop as one idempotent acknowledgement', async (t) => {
  const root = await tmpRoot('sidekick-service-mic-stop-retry');
  t.after(async () => await fs.rm(root, { recursive: true, force: true }));

  await withMockedElectron({ safeStorage: createSafeStorage() }, async (require) => {
    clearDistModule('main/sidekick-service.js');
    const { SidekickService, __testSidekickInternals } = require('../../dist-electron/main/sidekick-service.js');
    const pairingSecret = randomBytes(32).toString('base64');
    await writePairedSidekickStore(root, pairingSecret, ['wifi.websocket', 'microphone.record']);
    const service = createSidekickService(SidekickService, root);
    const { socket, sendPayload } = await connectPairedSidekick({ service, internals: __testSidekickInternals, pairingSecret });
    const startPromise = service.startMicrophoneRecording({ sidekickId: SIDEKICK_ID, transient: true });
    const start = await readDesktopCommand(socket, __testSidekickInternals, pairingSecret);
    sendPayload({
      v: 1,
      type: 'microphone.recording.started',
      recordingId: start.recordingId,
      sampleRate: 16000,
      channels: 1,
      format: 'pcm_s16le',
    });
    await startPromise;

    const firstStop = service.stopMicrophoneRecording({ sidekickId: SIDEKICK_ID, transient: true });
    const firstCommand = await readDesktopCommand(socket, __testSidekickInternals, pairingSecret);
    const secondStop = service.stopMicrophoneRecording({ sidekickId: SIDEKICK_ID, transient: true });
    const secondCommand = await readDesktopCommand(socket, __testSidekickInternals, pairingSecret);
    assert.equal(secondCommand.recordingId, firstCommand.recordingId);
    sendPayload({
      v: 1,
      type: 'microphone.recording.stopped',
      recordingId: firstCommand.recordingId,
      sampleCount: 0,
      durationMs: 0,
    });
    assert.equal((await firstStop).success, true);
    assert.equal((await secondStop).success, true);
    assert.equal((await service.getState()).sidekicks[0].microphoneRecording.status, 'idle');
    socket.close();
    await service.dispose();
  });
});

test('SidekickService hello reconciliation clears stale microphone and speaker operations from the prior socket', async (t) => {
  const root = await tmpRoot('sidekick-service-session-reconnect');
  t.after(async () => await fs.rm(root, { recursive: true, force: true }));

  await withMockedElectron({ safeStorage: createSafeStorage() }, async (require) => {
    clearDistModule('main/sidekick-service.js');
    const { SidekickService, __testSidekickInternals } = require('../../dist-electron/main/sidekick-service.js');
    const pairingSecret = randomBytes(32).toString('base64');
    const capabilities = ['wifi.websocket', 'microphone.record', 'speaker.playback'];
    await writePairedSidekickStore(root, pairingSecret, capabilities);
    const invalidations = [];
    const service = createSidekickService(SidekickService, root, {
      onSessionInvalidated: async (event) => {
        const current = (await service.getState()).sidekicks[0];
        invalidations.push({
          ...event,
          status: current.status,
          microphoneStatus: current.microphoneRecording.status,
          speakerStatus: current.speakerPlayback.status,
        });
      },
    });
    const first = await connectPairedSidekick({ service, internals: __testSidekickInternals, pairingSecret, capabilities });

    const startMic = service.startMicrophoneRecording({ sidekickId: SIDEKICK_ID, transient: true });
    const micCommand = await readDesktopCommand(first.socket, __testSidekickInternals, pairingSecret);
    first.sendPayload({
      v: 1,
      type: 'microphone.recording.started',
      recordingId: micCommand.recordingId,
      sampleRate: 16000,
      channels: 1,
      format: 'pcm_s16le',
    });
    await startMic;
    const second = await connectPairedSidekick({ service, internals: __testSidekickInternals, pairingSecret, capabilities });
    const microphoneReconciled = await waitForState(
      () => service.getState(),
      (state) => state.sidekicks[0]?.microphoneRecording.status === 'idle',
    );
    assert.equal(microphoneReconciled.sidekicks[0].microphoneRecording.status, 'idle');
    assert.deepEqual(invalidations, [{
      sidekickId: SIDEKICK_ID,
      reason: 'reconnected',
      status: 'online',
      microphoneStatus: 'idle',
      speakerStatus: 'idle',
    }]);

    const playback = service.playSpeakerPcm({
      sidekickId: SIDEKICK_ID,
      samples: Int16Array.from({ length: 1024 }, (_, index) => index),
    });
    const playStart = await readDesktopCommand(second.socket, __testSidekickInternals, pairingSecret);
    second.sendPayload({
      v: 1,
      type: 'speaker.playback.started',
      playbackId: playStart.playbackId,
      maxChunkSamples: 1024,
      queueDepth: 8,
    });
    await readDesktopCommand(second.socket, __testSidekickInternals, pairingSecret);
    const third = await connectPairedSidekick({ service, internals: __testSidekickInternals, pairingSecret, capabilities });
    const playbackResult = await playback;
    assert.equal(playbackResult.success, false);
    assert.equal(playbackResult.technicalCode, 'sidekick_speaker_playback_interrupted');
    const speakerReconciled = await waitForState(
      () => service.getState(),
      (state) => state.sidekicks[0]?.speakerPlayback.status === 'idle',
    );
    assert.equal(speakerReconciled.sidekicks[0].speakerPlayback.status, 'idle');
    assert.deepEqual(invalidations, [
      {
        sidekickId: SIDEKICK_ID,
        reason: 'reconnected',
        status: 'online',
        microphoneStatus: 'idle',
        speakerStatus: 'idle',
      },
      {
        sidekickId: SIDEKICK_ID,
        reason: 'reconnected',
        status: 'online',
        microphoneStatus: 'idle',
        speakerStatus: 'idle',
      },
    ]);
    third.socket.close();
    await service.dispose();
  });
});

test('SidekickService invalidates the voice lifecycle before forgetting a paired device', async (t) => {
  const root = await tmpRoot('sidekick-service-forget-lifecycle');
  t.after(async () => await fs.rm(root, { recursive: true, force: true }));

  await withMockedElectron({ safeStorage: createSafeStorage() }, async (require) => {
    clearDistModule('main/sidekick-service.js');
    const { SidekickService, __testSidekickInternals } = require('../../dist-electron/main/sidekick-service.js');
    const pairingSecret = randomBytes(32).toString('base64');
    await writePairedSidekickStore(root, pairingSecret, ['wifi.websocket', 'microphone.record']);
    const invalidations = [];
    const service = createSidekickService(SidekickService, root, {
      onSessionInvalidated: async (event) => {
        invalidations.push({ event, registeredBeforeInvalidation: (await service.getState()).sidekicks.length });
      },
    });
    const { socket } = await connectPairedSidekick({
      service,
      internals: __testSidekickInternals,
      pairingSecret,
    });

    const result = await service.forget(SIDEKICK_ID);

    assert.deepEqual(invalidations, [{
      event: { sidekickId: SIDEKICK_ID, reason: 'forgotten' },
      registeredBeforeInvalidation: 1,
    }]);
    assert.equal(result.success, true);
    assert.equal(result.sidekicks.length, 0);
    socket.close();
    await service.dispose();
  });
});

test('SidekickService keeps reconnect and forget deterministic when a lifecycle observer fails', async (t) => {
  const root = await tmpRoot('sidekick-service-lifecycle-observer-failure');
  t.after(async () => await fs.rm(root, { recursive: true, force: true }));

  await withMockedElectron({ safeStorage: createSafeStorage() }, async (require) => {
    clearDistModule('main/sidekick-service.js');
    const { SidekickService, __testSidekickInternals } = require('../../dist-electron/main/sidekick-service.js');
    const pairingSecret = randomBytes(32).toString('base64');
    await writePairedSidekickStore(root, pairingSecret);
    const logs = [];
    const service = createSidekickService(SidekickService, root, {
      appendLog: async (event, payload) => { logs.push({ event, payload }); },
      onSessionInvalidated: async () => { throw new Error('observer_failed'); },
    });
    const first = await connectPairedSidekick({ service, internals: __testSidekickInternals, pairingSecret });
    const second = await connectPairedSidekick({ service, internals: __testSidekickInternals, pairingSecret });
    const reconnected = await waitForState(
      () => service.getState(),
      (state) => (
        state.sidekicks[0]?.status === 'online' &&
        logs.some((entry) => entry.event === 'sidekick:session_invalidation_failed' && entry.payload.reason === 'reconnected')
      ),
    );
    assert.equal(reconnected.sidekicks[0].status, 'online');
    assert.equal(second.socket.readyState, WebSocket.OPEN);

    const forgotten = await service.forget(SIDEKICK_ID);

    assert.equal(forgotten.success, true);
    assert.equal(forgotten.sidekicks.length, 0);
    assert.deepEqual(
      logs.filter((entry) => entry.event === 'sidekick:session_invalidation_failed').map((entry) => entry.payload.reason),
      ['reconnected', 'forgotten'],
    );
    first.socket.close();
    second.socket.close();
    await service.dispose();
  });
});

test('SidekickService persists normalized voice, locale, and conversation TTL per paired device', async (t) => {
  const root = await tmpRoot('sidekick-service-voice-config');
  t.after(async () => await fs.rm(root, { recursive: true, force: true }));

  await withMockedElectron({ safeStorage: createSafeStorage() }, async (require) => {
    clearDistModule('main/sidekick-service.js');
    const { SidekickService } = require('../../dist-electron/main/sidekick-service.js');
    const pairingSecret = randomBytes(32).toString('base64');
    await writePairedSidekickStore(root, pairingSecret);
    const service = createSidekickService(SidekickService, root);
    assert.deepEqual((await service.getState()).sidekicks[0].voiceConfig, {
      sttLanguageMode: 'subset',
      sttLanguages: ['es', 'en'],
      conversationTtlMinutes: 30,
    });
    const updated = await service.setVoiceConfig({
      sidekickId: SIDEKICK_ID,
      config: {
        model: 'kokoro',
        voice: 'ef_dora',
        locale: 'es-CL',
        sttLanguageMode: 'subset',
        sttLanguages: ['ES', 'en', 'en', 'nope'],
        conversationTtlMinutes: 45,
      },
    });
    assert.equal(updated.success, true);
    assert.deepEqual(updated.sidekicks[0].voiceConfig, {
      model: 'kokoro',
      voice: 'ef_dora',
      locale: 'es-CL',
      sttLanguageMode: 'subset',
      sttLanguages: ['es', 'en'],
      conversationTtlMinutes: 45,
    });
    const persisted = JSON.parse(await fs.readFile(path.join(root, 'sidekicks.json'), 'utf8'));
    assert.deepEqual(persisted.records[0].voiceConfig, updated.sidekicks[0].voiceConfig);
    const invalid = await service.setVoiceConfig({
      sidekickId: SIDEKICK_ID,
      config: { model: 'kokoro', voice: 'ef_dora', locale: 'es-CL', conversationTtlMinutes: 0 },
    });
    assert.equal(invalid.success, false);
    assert.equal(invalid.technicalCode, 'sidekick_voice_conversation_ttl_invalid');
    await service.dispose();

    persisted.records[0].voiceConfig = {
      model: '../invalid',
      voice: 'ef_dora',
      locale: 'not a locale',
      conversationTtlMinutes: 99_999,
    };
    await fs.writeFile(path.join(root, 'sidekicks.json'), JSON.stringify(persisted), 'utf8');
    const reloaded = createSidekickService(SidekickService, root);
    assert.deepEqual((await reloaded.getState()).sidekicks[0].voiceConfig, {
      sttLanguageMode: 'subset',
      sttLanguages: ['es', 'en'],
      conversationTtlMinutes: 30,
    });
    await reloaded.dispose();
  });
});

test('SidekickService aborts active playback and waits for the stopped receipt', async (t) => {
  const root = await tmpRoot('sidekick-service-speaker-signal-cancel');
  t.after(async () => await fs.rm(root, { recursive: true, force: true }));

  await withMockedElectron({ safeStorage: createSafeStorage() }, async (require) => {
    clearDistModule('main/sidekick-service.js');
    const { SidekickService, __testSidekickInternals } = require('../../dist-electron/main/sidekick-service.js');
    const pairingSecret = randomBytes(32).toString('base64');
    await writePairedSidekickStore(root, pairingSecret, ['wifi.websocket', 'speaker.playback']);
    const service = createSidekickService(SidekickService, root);
    const { socket, sendPayload } = await connectPairedSidekick({
      service,
      internals: __testSidekickInternals,
      pairingSecret,
      capabilities: ['wifi.websocket', 'speaker.playback'],
    });
    const controller = new AbortController();
    const playbackPromise = service.playSpeakerPcm({
      sidekickId: SIDEKICK_ID,
      samples: Int16Array.from({ length: 1024 }, (_, index) => index),
    }, { signal: controller.signal });
    const start = await readDesktopCommand(socket, __testSidekickInternals, pairingSecret);
    sendPayload({ v: 1, type: 'speaker.playback.started', playbackId: start.playbackId, maxChunkSamples: 1024, queueDepth: 8 });
    await readDesktopCommand(socket, __testSidekickInternals, pairingSecret);
    controller.abort(new Error('barge_in'));
    const cancel = await readDesktopCommand(socket, __testSidekickInternals, pairingSecret);
    assert.equal(cancel.cmd, 'speaker.play.cancel');
    sendPayload({
      v: 1,
      type: 'speaker.playback.stopped',
      playbackId: start.playbackId,
      samplesPlayed: 0,
      underruns: 0,
      droppedChunks: 0,
      cancelled: true,
    });
    const result = await playbackPromise;
    assert.equal(result.technicalCode, 'sidekick_speaker_playback_cancelled');
    assert.equal((await service.getState()).sidekicks[0].speakerPlayback.status, 'idle');
    assert.equal(socket.readyState, WebSocket.OPEN);
    socket.close();
    await service.dispose();
  });
});

test('SidekickService accepts firmware barge-in without sending a duplicate cancel', async (t) => {
  const root = await tmpRoot('sidekick-service-speaker-firmware-barge-in');
  t.after(async () => await fs.rm(root, { recursive: true, force: true }));

  await withMockedElectron({ safeStorage: createSafeStorage() }, async (require) => {
    clearDistModule('main/sidekick-service.js');
    const { SidekickService, __testSidekickInternals } = require('../../dist-electron/main/sidekick-service.js');
    const pairingSecret = randomBytes(32).toString('base64');
    await writePairedSidekickStore(root, pairingSecret, ['wifi.websocket', 'speaker.playback']);
    const service = createSidekickService(SidekickService, root);
    const { socket, sendPayload } = await connectPairedSidekick({
      service,
      internals: __testSidekickInternals,
      pairingSecret,
      capabilities: ['wifi.websocket', 'speaker.playback'],
    });
    const playbackPromise = service.playSpeakerPcm({
      sidekickId: SIDEKICK_ID,
      samples: Int16Array.from({ length: 1024 }, (_, index) => index),
    });
    const start = await readDesktopCommand(socket, __testSidekickInternals, pairingSecret);
    sendPayload({ v: 1, type: 'speaker.playback.started', playbackId: start.playbackId, maxChunkSamples: 1024, queueDepth: 8 });
    await readDesktopCommand(socket, __testSidekickInternals, pairingSecret);
    sendPayload({
      v: 1,
      type: 'speaker.playback.stopped',
      playbackId: start.playbackId,
      samplesPlayed: 0,
      underruns: 0,
      droppedChunks: 0,
      cancelled: true,
    });
    const result = await playbackPromise;
    assert.equal(result.technicalCode, 'sidekick_speaker_playback_interrupted');
    await assert.rejects(readDesktopCommand(socket, __testSidekickInternals, pairingSecret), /desktop_command_timeout/);
    assert.equal(socket.readyState, WebSocket.OPEN);
    socket.close();
    await service.dispose();
  });
});
