import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { LiveVoiceInputServiceManager, normalizeLiveVoiceInputConfig } = require('../../dist-electron/main/live-voice-input-service.js');

const createHarness = async ({ sttInstalled = true, sttRunning = true } = {}) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forger-live-voice-test-'));
  const installLog = [];
  const wakeEvents = [];
  let sttState = {
    installed: sttInstalled,
    running: sttRunning,
    status: sttRunning ? 'running' : sttInstalled ? 'installed' : 'not_installed',
    config: {
      model: 'base',
      maxConcurrentJobs: 1,
      maxRealtimeSessions: 3,
      autoStart: false,
    },
    modelOptions: [],
    dependencyIssues: [],
    repairRequired: false,
    queue: [],
    processedFiles: [],
  };
  const manager = new LiveVoiceInputServiceManager({
    appendInstallLog: async (event, payload) => {
      installLog.push({ event, payload });
    },
    fs,
    getMetadataRoot: () => path.join(root, 'metadata'),
    getSpeechToTextState: async () => sttState,
    createSpeechRealtimeSession: async () => ({
      url: 'ws://127.0.0.1:45123/v1/realtime/transcribe',
      token: 'test-token',
      sampleRate: 16000,
      format: 'pcm_s16le',
    }),
    onForgerWakeDetected: (event) => wakeEvents.push(event),
    path,
  });
  return {
    root,
    manager,
    installLog,
    wakeEvents,
    setSttState: (next) => {
      sttState = { ...sttState, ...next };
    },
    cleanup: async () => await fs.rm(root, { recursive: true, force: true }),
  };
};

test('LiveVoiceInputServiceManager gates active controls on running speech to text', async () => {
  const harness = await createHarness({ sttInstalled: true, sttRunning: false });
  try {
    const state = await harness.manager.getState();
    assert.equal(state.status, 'stt_required');
    assert.equal(state.sttInstalled, true);
    assert.equal(state.sttRunning, false);
    await assert.rejects(
      () => harness.manager.createSession({ consumerKind: 'settings_live_test' }),
      /live_voice_stt_not_running/,
    );
  } finally {
    await harness.cleanup();
  }
});

test('LiveVoiceInputServiceManager persists config and attaches Forger wake consumer only when STT is running', async () => {
  const harness = await createHarness();
  try {
    await harness.manager.updateDevices({ devices: [{ id: 'default', label: 'MacBook Mic', default: true }] });
    const state = await harness.manager.updateConfig({
      enabled: false,
      defaultDeviceId: 'default',
      forgerWakeWordEnabled: true,
      wakeThreshold: 0.7,
      wakePatience: 3,
      wakeCooldownMs: 4000,
    });
    assert.equal(state.status, 'active');
    assert.equal(state.sessions.length, 1);
    assert.equal(state.sessions[0].deviceId, 'default');
    assert.equal(state.sessions[0].consumers[0].kind, 'forger_wake_word');
    assert.equal(state.sessions[0].wakeTargets[0].threshold, 0.7);

    const reloaded = await harness.manager.getState();
    assert.equal(reloaded.config.forgerWakeWordEnabled, true);
    assert.equal(reloaded.config.wakePatience, 3);

    const session = await harness.manager.createSession({
      consumerKind: 'forger_wake_word',
      deviceId: 'default',
      label: 'Forger wake word',
      targetType: 'forger',
    });
    const withRealtimeSession = await harness.manager.getState();
    assert.equal(withRealtimeSession.sessions.length, 1);
    assert.equal(withRealtimeSession.sessions[0].consumers.length, 1);
    assert.equal(withRealtimeSession.sessions[0].consumers[0].id, session.consumerId);
  } finally {
    await harness.cleanup();
  }
});

test('LiveVoiceInputServiceManager uses wakeDeviceId for Forger wake word', async () => {
  const harness = await createHarness();
  try {
    await harness.manager.updateDevices({
      devices: [
        { id: 'mic-1', label: 'Built-in Mic', default: true },
        { id: 'mic-2', label: 'Studio Mic' },
      ],
    });
    const state = await harness.manager.updateConfig({
      defaultDeviceId: 'mic-1',
      wakeDeviceId: 'mic-2',
      forgerWakeWordEnabled: true,
    });
    assert.equal(state.sessions.length, 1);
    assert.equal(state.sessions[0].deviceId, 'mic-2');
    assert.equal(state.sessions[0].wakeTargets[0].deviceId, 'mic-2');
  } finally {
    await harness.cleanup();
  }
});

test('LiveVoiceInputServiceManager surfaces STT repair requirement for wake word', async () => {
  const harness = await createHarness();
  try {
    harness.setSttState({
      repairRequired: true,
      dependencyIssues: [{ code: 'speech_dependency_missing', dependency: 'openwakeword', repairable: true }],
    });
    await harness.manager.updateDevices({ devices: [{ id: 'default', label: 'MacBook Mic', default: true }] });
    const state = await harness.manager.updateConfig({ forgerWakeWordEnabled: true });
    assert.equal(state.status, 'stt_required');
    assert.equal(state.sttRepairRequired, true);
    assert.equal(state.wakeRuntime.state, 'unavailable');
    assert.equal(state.wakeRuntime.technicalCode, 'speech_to_text_repair_required');
    assert.equal(state.sessions.length, 0);
  } finally {
    await harness.cleanup();
  }
});

test('LiveVoiceInputServiceManager creates transcript sessions without raw audio data', async () => {
  const harness = await createHarness();
  try {
    await harness.manager.updateDevices({ devices: [{ id: 'mic-1', label: 'Studio Mic' }] });
    const session = await harness.manager.createSession({
      consumerKind: 'app_transcript',
      deviceId: 'mic-1',
      label: 'Finance OS',
      targetType: 'app_agent',
      targetId: 'finance-os',
      task: 'translate',
      language: 'es',
    });
    assert.deepEqual(session, {
      sessionId: session.sessionId,
      deviceId: 'mic-1',
      consumerId: session.consumerId,
      url: 'ws://127.0.0.1:45123/v1/realtime/transcribe',
      token: 'test-token',
      sampleRate: 16000,
      format: 'pcm_s16le',
      mode: 'transcript',
      task: 'translate',
      language: 'es',
    });
    const forbidden = /audio|buffer|chunk|stream|pcm|rawAudio/i;
    assert.equal(Object.keys(session).some((key) => forbidden.test(key) && key !== 'format'), false);
    assert.equal(JSON.stringify(session).includes('RAW_AUDIO_SENTINEL'), false);

    const state = await harness.manager.getState();
    assert.equal(state.sessions[0].transcriptSubscriberCount, 1);
    assert.equal(state.sessions[0].consumers[0].kind, 'app_transcript');
  } finally {
    await harness.cleanup();
  }
});

test('LiveVoiceInputServiceManager creates raw audio sessions without requiring speech to text', async () => {
  const harness = await createHarness({ sttInstalled: false, sttRunning: false });
  try {
    await harness.manager.updateDevices({ devices: [{ id: 'mic-1', label: 'Studio Mic' }] });
    const session = await harness.manager.createSession({
      consumerKind: 'app_raw_audio',
      deviceId: 'mic-1',
      label: 'Recorder',
      targetType: 'app_agent',
      targetId: 'recorder',
    });
    assert.equal(session.deviceId, 'mic-1');
    assert.equal(session.mode, 'raw_audio');
    assert.equal(session.sampleRate, 16000);
    assert.equal(session.format, 'pcm_s16le');

    const state = await harness.manager.getState();
    assert.equal(state.sessions[0].consumers[0].kind, 'app_raw_audio');
    assert.equal(state.sessions[0].transcriptSubscriberCount, 0);
  } finally {
    await harness.cleanup();
  }
});

test('LiveVoiceInputServiceManager lists system audio as a supported live source', async () => {
  const harness = await createHarness();
  try {
    const state = await harness.manager.updateDevices({
      devices: [
        { id: 'mic-1', label: 'Studio Mic', kind: 'microphone', default: true },
        { id: 'system-audio:default', label: 'System audio', kind: 'system_audio', requiresDisplayCapture: true },
      ],
    });
    assert.equal(state.devices.length, 2);
    assert.equal(state.devices[1].kind, 'system_audio');
    assert.equal(state.devices[1].supported, true);
    assert.equal(state.devices[1].requiresDisplayCapture, true);

    const session = await harness.manager.createSession({
      consumerKind: 'settings_live_test',
      deviceId: 'system-audio:default',
      label: 'System audio test',
    });
    assert.equal(session.deviceId, 'system-audio:default');
    assert.equal(Object.prototype.hasOwnProperty.call(session, 'rawAudio'), false);
  } finally {
    await harness.cleanup();
  }
});

test('LiveVoiceInputServiceManager stops consumers by id, device, or all', async () => {
  const harness = await createHarness();
  try {
    await harness.manager.updateDevices({ devices: [{ id: 'mic-1' }, { id: 'mic-2' }] });
    const first = await harness.manager.createSession({ consumerKind: 'settings_live_test', deviceId: 'mic-1' });
    await harness.manager.createSession({ consumerKind: 'app_transcript', deviceId: 'mic-1' });
    await harness.manager.createSession({ consumerKind: 'app_raw_audio', deviceId: 'mic-1' });
    await harness.manager.createSession({ consumerKind: 'agent_transcript', deviceId: 'mic-2' });

    let state = await harness.manager.stop({ consumerId: first.consumerId });
    assert.equal(state.sessions.find((session) => session.deviceId === 'mic-1').consumers.length, 2);

    state = await harness.manager.stop({ deviceId: 'mic-1' });
    assert.equal(state.sessions.some((session) => session.deviceId === 'mic-1'), false);
    assert.equal(state.sessions.some((session) => session.deviceId === 'mic-2'), true);

    state = await harness.manager.stop();
    assert.equal(state.sessions.length, 0);
    assert.equal(state.running, false);
  } finally {
    await harness.cleanup();
  }
});

test('LiveVoiceInputServiceManager stop all leaves global wake word controlled by config', async () => {
  const harness = await createHarness();
  try {
    await harness.manager.updateDevices({ devices: [{ id: 'default', label: 'MacBook Mic', default: true }] });
    await harness.manager.updateConfig({ forgerWakeWordEnabled: true });
    await harness.manager.createSession({ consumerKind: 'settings_live_test', deviceId: 'default' });

    const state = await harness.manager.stop();
    assert.equal(state.config.forgerWakeWordEnabled, true);
    assert.equal(state.sessions.length, 1);
    assert.equal(state.sessions[0].consumers.length, 1);
    assert.equal(state.sessions[0].consumers[0].kind, 'forger_wake_word');
  } finally {
    await harness.cleanup();
  }
});

test('LiveVoiceInputServiceManager scopes targeted stops to the owning target', async () => {
  const harness = await createHarness();
  try {
    await harness.manager.updateDevices({ devices: [{ id: 'mic-1' }] });
    const session = await harness.manager.createSession({
      consumerKind: 'app_transcript',
      deviceId: 'mic-1',
      targetId: 'app-1',
    });

    let state = await harness.manager.stop({ consumerId: session.consumerId, targetId: 'app-2' });
    assert.equal(state.sessions[0].consumers.length, 1);

    state = await harness.manager.stop({ consumerId: session.consumerId, targetId: 'app-1' });
    assert.equal(state.sessions.length, 0);
  } finally {
    await harness.cleanup();
  }
});

test('LiveVoiceInputServiceManager records Forger wake without creating a chat run payload', async () => {
  const harness = await createHarness();
  try {
    await harness.manager.updateDevices({ devices: [{ id: 'default' }] });
    const state = await harness.manager.recordWakeDetected({
      deviceId: 'default',
      modelId: 'hey_mycroft',
      confidence: 0.91,
    });
    assert.equal(state.lastWakeEvent.targetType, 'forger');
    assert.equal(state.lastWakeEvent.confidence, 0.91);
    assert.equal(harness.wakeEvents.length, 1);
    assert.equal(Object.prototype.hasOwnProperty.call(harness.wakeEvents[0], 'runId'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(harness.wakeEvents[0], 'appId'), false);
  } finally {
    await harness.cleanup();
  }
});

test('LiveVoiceInputServiceManager records wake detector readiness and unavailable diagnostics', async () => {
  const harness = await createHarness();
  try {
    const ready = await harness.manager.recordWakeReady({ modelId: 'hey jarvis' });
    assert.equal(ready.wakeRuntime.state, 'ready');
    assert.equal(ready.wakeRuntime.modelId, 'hey jarvis');

    const unavailable = await harness.manager.recordWakeUnavailable({
      modelId: 'hey jarvis',
      technicalCode: 'wake_model_unavailable',
    });
    assert.equal(unavailable.wakeRuntime.state, 'unavailable');
    assert.equal(unavailable.wakeRuntime.technicalCode, 'wake_model_unavailable');
  } finally {
    await harness.cleanup();
  }
});

test('normalizeLiveVoiceInputConfig clamps thresholds and future wake model limits', () => {
  assert.deepEqual(normalizeLiveVoiceInputConfig({
    enabled: false,
    wakeDeviceId: ' studio ',
    forgerWakeWordEnabled: true,
    wakeThreshold: 5,
    wakePatience: 99,
    wakeCooldownMs: 1,
    maxWakeModelsPerDevice: 99,
    transcriptTask: 'translate',
  }), {
    defaultDeviceId: '',
    forgerWakeWordEnabled: true,
    wakeDeviceId: 'studio',
    wakeModelId: 'hey jarvis',
    wakeThreshold: 0.99,
    wakePatience: 8,
    wakeCooldownMs: 250,
    maxWakeModelsPerDevice: 4,
    transcriptTask: 'translate',
    maxTranscriptSubscribersPerDevice: 3,
    autoStopWhenIdle: true,
  });
});
