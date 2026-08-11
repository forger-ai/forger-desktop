import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { LiveVoiceInputServiceManager, normalizeLiveVoiceInputConfig } = require('../../dist-electron/main/live-voice-input-service.js');

const managerFor = (overrides = {}) => {
  let configText;
  let stt = { installed: true, running: true, repairRequired: false, dependencyIssues: [] };
  const events = [];
  const deps = {
    appendInstallLog: async (...args) => events.push(args),
    fs: {
      readFile: async () => {
        if (configText === undefined) throw new Error('missing');
        return configText;
      },
      mkdir: async () => undefined,
      writeFile: async (_file, text) => { configText = text; },
    },
    getMetadataRoot: () => '/metadata',
    getSpeechToTextState: async () => stt,
    createSpeechRealtimeSession: async () => ({ url: 'ws://voice', token: 'token', sampleRate: 16000, format: 'pcm_s16le' }),
    path,
    ...overrides,
  };
  const manager = new LiveVoiceInputServiceManager(deps);
  return { manager, deps, events, setStt: (value) => { stt = value; }, setConfig: (value) => { configText = value; } };
};

test('live voice input handles state failures, device normalization, subscriber bounds, and wake fallbacks', async () => {
  assert.equal(normalizeLiveVoiceInputConfig({ transcriptLanguage: ' es ', autoStopWhenIdle: false }).transcriptLanguage, 'es');
  assert.equal(normalizeLiveVoiceInputConfig({ transcriptLanguage: ' ' }).transcriptLanguage, undefined);
  assert.equal(normalizeLiveVoiceInputConfig({ wakeThreshold: 'invalid' }).wakeThreshold, 0.5);

  const failed = managerFor({ getSpeechToTextState: async () => { throw 'primitive'; } });
  assert.equal((await failed.manager.getState()).lastError, 'speech_to_text_state_failed');
  failed.deps.getSpeechToTextState = async () => { throw new Error('state failed'); };
  assert.equal((await failed.manager.getState()).lastError, 'state failed');

  const harness = managerFor();
  const state = await harness.manager.updateDevices({ devices: [
    { id: '', label: '' },
    { id: 'mic', label: '', groupId: ' group ', supported: false },
    { id: 'mic', label: 'duplicate' },
    { id: 'system', kind: 'system_audio', label: '' },
  ] });
  assert.equal(state.devices.length, 2);
  assert.equal(state.devices[0].groupId, 'group');
  assert.equal(state.devices[1].label, 'System audio');

  await harness.manager.updateConfig({ defaultDeviceId: 'mic', maxTranscriptSubscribersPerDevice: 1, transcriptTask: 'translate', transcriptLanguage: 'fr' });
  const first = await harness.manager.createSession({ consumerKind: 'app_transcript', deviceId: 'mic', task: 'transcribe', label: '' });
  assert.equal(first.task, 'transcribe');
  await assert.rejects(harness.manager.createSession({ consumerKind: 'app_transcript', deviceId: 'mic' }), /subscriber_limit/);
  await harness.manager.stop({ consumerId: first.consumerId });
  const configured = await harness.manager.createSession({ consumerKind: 'agent_transcript', deviceId: 'mic' });
  assert.equal(configured.task, 'translate');
  assert.equal(configured.language, 'fr');
  await harness.manager.stop({ deviceId: 'mic', targetId: undefined });
  const targeted = await harness.manager.createSession({ consumerKind: 'agent_transcript', deviceId: 'mic', targetId: 'agent' });
  await harness.manager.stop({ deviceId: 'mic', targetId: 'agent' });
  assert.equal(harness.manager.consumers.has(targeted.consumerId), false);

  harness.setStt({ installed: false, running: false });
  await assert.rejects(harness.manager.createSession({ consumerKind: 'settings_live_test' }), /stt_not_installed/);
  harness.setStt({ installed: true, running: false });
  const idle = await harness.manager.updateConfig({ forgerWakeWordEnabled: true, wakeDeviceId: '', defaultDeviceId: '' });
  assert.equal(idle.wakeRuntime.state, 'idle');
  const disabled = await harness.manager.updateConfig({ forgerWakeWordEnabled: false });
  assert.equal(disabled.wakeRuntime.state, 'idle');

  harness.setStt({ installed: true, running: true });
  await harness.manager.updateConfig({ forgerWakeWordEnabled: true });
  const wake = [...harness.manager.consumers.values()].find((consumer) => consumer.kind === 'forger_wake_word');
  harness.manager.wakeRuntime = { state: 'ready', modelId: 'hey jarvis', updatedAt: 'now' };
  assert.equal((await harness.manager.stop({ consumerId: wake.id })).wakeRuntime.state, 'idle');
  await harness.manager.recordWakeReady({});
  await harness.manager.recordWakeUnavailable({});
  const personal = await harness.manager.recordWakeDetected({ modelId: '', targetType: 'personal_agent', targetId: ' agent ' });
  assert.equal(personal.lastWakeEvent.targetType, 'personal_agent');
  assert.equal(personal.lastWakeEvent.targetId, 'agent');
  const app = await harness.manager.recordWakeDetected({ targetType: 'app_agent' });
  assert.equal(app.lastWakeEvent.targetType, 'app_agent');

  const empty = managerFor();
  assert.equal((await empty.manager.createSession({ consumerKind: 'app_raw_audio' })).deviceId, 'default');
  empty.manager.config = { ...empty.manager.config, defaultDeviceId: '', wakeDeviceId: '' };
  empty.manager.devices = [];
  assert.equal(empty.manager.resolveWakeDeviceId(), 'default');
  empty.manager.devices = [{ id: 'first', default: false }];
  assert.equal(empty.manager.resolveDeviceId(), 'first');
  assert.equal(empty.manager.resolveWakeDeviceId(), 'first');
  empty.manager.devices = [{ id: 'default-device', default: true }];
  assert.equal(empty.manager.resolveDeviceId(), 'default-device');
});
