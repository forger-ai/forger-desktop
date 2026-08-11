import assert from 'node:assert/strict';
import test from 'node:test';

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { IPC_CHANNELS } = require('../../dist-electron/shared/ipc.js');
const { registerSidekickIpcHandlers } = require('../../dist-electron/main/ipc/sidekick-handlers.js');

const SIDEKICK_CHANNELS = [
  IPC_CHANNELS.sidekicksGetState,
  IPC_CHANNELS.sidekicksScanUsb,
  IPC_CHANNELS.sidekicksConfigureUsb,
  IPC_CHANNELS.sidekicksSendDisplay,
  IPC_CHANNELS.sidekicksSendScreen,
  IPC_CHANNELS.sidekicksSetPersonalAgent,
  IPC_CHANNELS.sidekicksSetVoiceConfig,
  IPC_CHANNELS.sidekicksSpeak,
  IPC_CHANNELS.sidekicksStartMicrophoneRecording,
  IPC_CHANNELS.sidekicksStopMicrophoneRecording,
  IPC_CHANNELS.sidekicksReadMicrophoneRecording,
  IPC_CHANNELS.sidekicksSetIdleConfig,
  IPC_CHANNELS.sidekicksSetIdleImage,
  IPC_CHANNELS.sidekicksForget,
];

const createHarness = () => {
  const handlers = new Map();
  const calls = [];
  const agents = new Map([['agent-1', { id: 'agent-1', name: 'Agent one' }]]);
  const sidekickState = { success: true, sidekicks: [{ id: 'sidekick-1' }] };
  let ttsState = { voices: [] };
  const operation = (name) => async (input) => {
    calls.push([name, input]);
    return { operation: name, input };
  };
  const service = {
    getState: async () => {
      calls.push(['getState']);
      return sidekickState;
    },
    scanUsb: operation('scanUsb'),
    configureUsb: operation('configureUsb'),
    sendDisplay: operation('sendDisplay'),
    sendScreen: operation('sendScreen'),
    setPersonalAgent: operation('setPersonalAgent'),
    setVoiceConfig: operation('setVoiceConfig'),
    speak: operation('speak'),
    startMicrophoneRecording: operation('startMicrophoneRecording'),
    stopMicrophoneRecording: operation('stopMicrophoneRecording'),
    readMicrophoneRecording: operation('readMicrophoneRecording'),
    setIdleConfig: operation('setIdleConfig'),
    setIdleImage: operation('setIdleImage'),
    forget: operation('forget'),
  };
  registerSidekickIpcHandlers({
    IPC_CHANNELS,
    ipcMain: {
      handle: (channel, handler) => handlers.set(channel, handler),
    },
    getSidekickService: () => service,
    getPersonalAgentStore: () => ({
      getAgent: async (agentId) => {
        calls.push(['getAgent', agentId]);
        return agents.get(agentId) ?? null;
      },
    }),
    getTextToSpeechService: () => ({ getState: async () => ttsState }),
  });
  return {
    agents,
    calls,
    handlers,
    setTtsState: (nextState) => {
      ttsState = nextState;
    },
    sidekickState,
  };
};

test('Sidekick IPC registers every channel and delegates ordinary device operations unchanged', async () => {
  const harness = createHarness();
  assert.deepEqual([...harness.handlers.keys()], SIDEKICK_CHANNELS);

  assert.deepEqual(await harness.handlers.get(IPC_CHANNELS.sidekicksGetState)(), harness.sidekickState);
  assert.equal((await harness.handlers.get(IPC_CHANNELS.sidekicksScanUsb)()).operation, 'scanUsb');

  const delegated = [
    [IPC_CHANNELS.sidekicksConfigureUsb, 'configureUsb', { sidekickId: 'sidekick-1', portPath: '/dev/ttyUSB0' }],
    [IPC_CHANNELS.sidekicksSendDisplay, 'sendDisplay', { sidekickId: 'sidekick-1', text: 'Hello' }],
    [IPC_CHANNELS.sidekicksSendScreen, 'sendScreen', { sidekickId: 'sidekick-1', screen: 'home' }],
    [IPC_CHANNELS.sidekicksSpeak, 'speak', { sidekickId: 'sidekick-1', text: 'Hello' }],
    [IPC_CHANNELS.sidekicksStartMicrophoneRecording, 'startMicrophoneRecording', { sidekickId: 'sidekick-1' }],
    [IPC_CHANNELS.sidekicksStopMicrophoneRecording, 'stopMicrophoneRecording', { sidekickId: 'sidekick-1' }],
    [IPC_CHANNELS.sidekicksReadMicrophoneRecording, 'readMicrophoneRecording', { sidekickId: 'sidekick-1' }],
    [IPC_CHANNELS.sidekicksSetIdleConfig, 'setIdleConfig', { sidekickId: 'sidekick-1', enabled: true }],
    [IPC_CHANNELS.sidekicksSetIdleImage, 'setIdleImage', { sidekickId: 'sidekick-1', imagePath: 'image.png' }],
  ];
  for (const [channel, operation, input] of delegated) {
    assert.deepEqual(await harness.handlers.get(channel)({}, input), { operation, input });
  }
  assert.deepEqual(await harness.handlers.get(IPC_CHANNELS.sidekicksForget)({}, 'sidekick-1'), {
    operation: 'forget',
    input: 'sidekick-1',
  });
});

test('Sidekick IPC rejects deleted personal agents while allowing cleared and existing selections', async () => {
  const harness = createHarness();
  const handler = harness.handlers.get(IPC_CHANNELS.sidekicksSetPersonalAgent);

  const cleared = { sidekickId: 'sidekick-1', personalAgentId: null };
  assert.deepEqual(await handler({}, cleared), { operation: 'setPersonalAgent', input: cleared });

  const existing = { sidekickId: 'sidekick-1', personalAgentId: 'agent-1' };
  assert.deepEqual(await handler({}, existing), { operation: 'setPersonalAgent', input: existing });

  const missing = await handler({}, { sidekickId: 'sidekick-1', personalAgentId: 'deleted-agent' });
  assert.deepEqual(missing, {
    ...harness.sidekickState,
    success: false,
    userMessage: 'Ese agente personal ya no está disponible.',
    technicalCode: 'sidekick_personal_agent_not_found',
  });
});

test('Sidekick IPC accepts available voices and rejects every unavailable voice state', async () => {
  const harness = createHarness();
  const handler = harness.handlers.get(IPC_CHANNELS.sidekicksSetVoiceConfig);
  const empty = { sidekickId: 'sidekick-1', config: {} };
  assert.deepEqual(await handler({}, empty), { operation: 'setVoiceConfig', input: empty });

  const expectUnavailable = async (config, voices) => {
    harness.setTtsState({ voices });
    const result = await handler({}, { sidekickId: 'sidekick-1', config });
    assert.equal(result.success, false);
    assert.equal(result.technicalCode, 'sidekick_voice_not_available');
  };
  await expectUnavailable({ model: '', voice: 'ghost' }, []);
  await expectUnavailable(
    { model: 'model-1', voice: 'voice-1' },
    [{ model: 'model-1', id: 'voice-1', installed: false, enabled: true, locale: 'en-US', language: 'English' }],
  );
  await expectUnavailable(
    { model: 'model-1', voice: 'voice-1' },
    [{ model: 'model-1', id: 'voice-1', installed: true, enabled: false, locale: 'en-US', language: 'English' }],
  );
  await expectUnavailable(
    { model: 'model-1', voice: 'voice-1' },
    [{ model: 'model-1', id: 'voice-1', installed: true, enabled: true, language: 'Unknown' }],
  );
  await expectUnavailable(
    { model: 'model-1', voice: 'voice-1', locale: 'es' },
    [{ model: 'model-1', id: 'voice-1', installed: true, enabled: true, locale: 'en-US', language: 'English' }],
  );

  const spanishVoice = {
    model: 'model-1',
    id: 'voice-1',
    installed: true,
    enabled: true,
    language: 'Spanish',
  };
  harness.setTtsState({ voices: [spanishVoice] });
  const accepted = await handler({}, {
    sidekickId: 'sidekick-1',
    config: { model: ' model-1 ', voice: ' voice-1 ' },
  });
  assert.deepEqual(accepted, {
    operation: 'setVoiceConfig',
    input: {
      sidekickId: 'sidekick-1',
      config: { model: 'model-1', voice: 'voice-1', locale: 'es' },
    },
  });

  assert.equal((await handler({}, {
    sidekickId: 'sidekick-1',
    config: { model: 'model-1', voice: 'voice-1', locale: 'es' },
  })).operation, 'setVoiceConfig');
});
