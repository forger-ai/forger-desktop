import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

import { clearDistModule, createIpcMainRecorder, withMockedElectron } from './electron-test-helpers.mjs';

const require = createRequire(import.meta.url);
const { IPC_CHANNELS } = require('../../dist-electron/shared/ipc.js');
const { registerWakeWordIpcHandlers } = require('../../dist-electron/main/ipc/wake-word-handlers.js');
const { registerLiveVoiceInputIpcHandlers } = require('../../dist-electron/main/ipc/live-voice-input-handlers.js');

const createWindowRecorder = () => {
  const sends = [];
  return {
    sends,
    mainWindow: {
      webContents: {
        send: (channel, payload) => sends.push([channel, payload]),
      },
    },
  };
};

test('wake word IPC delegates to the service and broadcasts every state change to the renderer', async () => {
  const { handlers, ipcMain } = createIpcMainRecorder();
  const { sends, mainWindow } = createWindowRecorder();
  const calls = [];
  let stateVersion = 0;
  const service = {
    getState: async () => ({ status: 'idle', version: ++stateVersion }),
    install: async () => ({ status: 'installed' }),
    start: async () => ({ status: 'listening' }),
    stop: () => calls.push(['stop']),
    updateConfig: async (input) => ({ status: 'configured', input }),
    createSession: async () => ({ sessionId: 'wake-1' }),
    recordReady: async (input) => ({ status: 'ready', input }),
    recordUnavailable: async (input) => ({ status: 'unavailable', input }),
    recordDetected: async (input) => ({ status: 'detected', input }),
    recordDiagnostic: async (input) => ({ status: 'diagnostic', input }),
  };
  registerWakeWordIpcHandlers({ IPC_CHANNELS, ipcMain, mainWindow, getWakeWordService: () => service });

  assert.deepEqual(await handlers.get(IPC_CHANNELS.wakeWordGetState)(), { status: 'idle', version: 1 });
  assert.deepEqual(sends, [], 'plain state reads must not broadcast');

  assert.deepEqual(await handlers.get(IPC_CHANNELS.wakeWordInstall)(), { status: 'installed' });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.wakeWordStart)(), { status: 'listening' });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.wakeWordStop)(), { status: 'idle', version: 2 });
  assert.deepEqual(calls, [['stop']], 'stop must stop the service before reading fresh state');
  assert.deepEqual(await handlers.get(IPC_CHANNELS.wakeWordUpdateConfig)(null, { modelId: 'hey-forger' }), {
    status: 'configured',
    input: { modelId: 'hey-forger' },
  });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.wakeWordCreateSession)(), { sessionId: 'wake-1' });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.wakeWordRecordReady)(null, { deviceId: 'mic-1' }), {
    status: 'ready',
    input: { deviceId: 'mic-1' },
  });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.wakeWordRecordUnavailable)(null, { reason: 'no-mic' }), {
    status: 'unavailable',
    input: { reason: 'no-mic' },
  });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.wakeWordRecordDetected)(null, { confidence: 0.93 }), {
    status: 'detected',
    input: { confidence: 0.93 },
  });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.wakeWordRecordDiagnostic)(null, { level: 'warn' }), {
    status: 'diagnostic',
    input: { level: 'warn' },
  });

  assert.deepEqual(sends, [
    [IPC_CHANNELS.wakeWordChanged, { status: 'installed' }],
    [IPC_CHANNELS.wakeWordChanged, { status: 'listening' }],
    [IPC_CHANNELS.wakeWordChanged, { status: 'idle', version: 2 }],
    [IPC_CHANNELS.wakeWordChanged, { status: 'configured', input: { modelId: 'hey-forger' } }],
    [IPC_CHANNELS.wakeWordChanged, { status: 'idle', version: 3 }],
    [IPC_CHANNELS.wakeWordChanged, { status: 'ready', input: { deviceId: 'mic-1' } }],
    [IPC_CHANNELS.wakeWordChanged, { status: 'unavailable', input: { reason: 'no-mic' } }],
    [IPC_CHANNELS.wakeWordChanged, { status: 'detected', input: { confidence: 0.93 } }],
    [IPC_CHANNELS.wakeWordChanged, { status: 'diagnostic', input: { level: 'warn' } }],
  ]);
});

test('wake word IPC still returns state when there is no main window to notify', async () => {
  const { handlers, ipcMain } = createIpcMainRecorder();
  registerWakeWordIpcHandlers({
    IPC_CHANNELS,
    ipcMain,
    mainWindow: null,
    getWakeWordService: () => ({
      install: async () => ({ status: 'installed' }),
    }),
  });

  assert.deepEqual(await handlers.get(IPC_CHANNELS.wakeWordInstall)(), { status: 'installed' });
});

test('live voice input IPC delegates to the service and broadcasts state changes to the renderer', async () => {
  const { handlers, ipcMain } = createIpcMainRecorder();
  const { sends, mainWindow } = createWindowRecorder();
  const stopInputs = [];
  let stateVersion = 0;
  const service = {
    getState: async () => ({ status: 'idle', version: ++stateVersion }),
    updateConfig: async (input) => ({ status: 'configured', input }),
    updateDevices: async (input) => ({ status: 'devices', input }),
    createSession: async (input) => ({ sessionId: 'live-1', input }),
    stop: async (input) => {
      stopInputs.push(input);
      return { status: 'stopped', input };
    },
    recordWakeDetected: async (input) => ({ status: 'wake-detected', input }),
    recordWakeReady: async (input) => ({ status: 'wake-ready', input }),
    recordWakeUnavailable: async (input) => ({ status: 'wake-unavailable', input }),
  };
  registerLiveVoiceInputIpcHandlers({ IPC_CHANNELS, ipcMain, mainWindow, getLiveVoiceInputService: () => service });

  assert.deepEqual(await handlers.get(IPC_CHANNELS.liveVoiceInputGetState)(), { status: 'idle', version: 1 });
  assert.deepEqual(sends, [], 'plain state reads must not broadcast');

  assert.deepEqual(await handlers.get(IPC_CHANNELS.liveVoiceInputUpdateConfig)(null, { language: 'es' }), {
    status: 'configured',
    input: { language: 'es' },
  });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.liveVoiceInputUpdateDevices)(null, { inputDeviceId: 'mic-2' }), {
    status: 'devices',
    input: { inputDeviceId: 'mic-2' },
  });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.liveVoiceInputCreateSession)(null, { mode: 'dictation' }), {
    sessionId: 'live-1',
    input: { mode: 'dictation' },
  });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.liveVoiceInputStop)(null), {
    status: 'stopped',
    input: {},
  });
  assert.deepEqual(stopInputs, [{}], 'stop without payload defaults to an empty input object');
  assert.deepEqual(await handlers.get(IPC_CHANNELS.liveVoiceInputWakeDetected)(null, { confidence: 0.8 }), {
    status: 'wake-detected',
    input: { confidence: 0.8 },
  });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.liveVoiceInputWakeReady)(null, { deviceId: 'mic-2' }), {
    status: 'wake-ready',
    input: { deviceId: 'mic-2' },
  });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.liveVoiceInputWakeUnavailable)(null, { reason: 'model' }), {
    status: 'wake-unavailable',
    input: { reason: 'model' },
  });

  assert.deepEqual(sends, [
    [IPC_CHANNELS.liveVoiceInputChanged, { status: 'configured', input: { language: 'es' } }],
    [IPC_CHANNELS.liveVoiceInputChanged, { status: 'devices', input: { inputDeviceId: 'mic-2' } }],
    [IPC_CHANNELS.liveVoiceInputChanged, { status: 'idle', version: 2 }],
    [IPC_CHANNELS.liveVoiceInputChanged, { status: 'stopped', input: {} }],
    [IPC_CHANNELS.liveVoiceInputChanged, { status: 'wake-detected', input: { confidence: 0.8 } }],
    [IPC_CHANNELS.liveVoiceInputChanged, { status: 'wake-ready', input: { deviceId: 'mic-2' } }],
    [IPC_CHANNELS.liveVoiceInputChanged, { status: 'wake-unavailable', input: { reason: 'model' } }],
  ]);
});

const registerMainHandlersWithSystemPreferences = async (systemPreferences) => {
  const { handlers, ipcMain } = createIpcMainRecorder();
  await withMockedElectron({ systemPreferences }, async (mockedRequire) => {
    clearDistModule('main/ipc/main-handlers.js');
    const { registerMainIpcHandlers } = mockedRequire('../../dist-electron/main/ipc/main-handlers.js');
    registerMainIpcHandlers({
      IPC_CHANNELS,
      ipcMain,
      registry: { apps: {} },
      state: { settings: {} },
    });
  });
  clearDistModule('main/ipc/main-handlers.js');
  return handlers;
};

test('microphone permission IPC reports the macOS media access status and normalizes unknown values', async () => {
  const askCalls = [];
  const mediaAccess = { status: 'granted', askResult: true };
  const handlers = await registerMainHandlersWithSystemPreferences({
    getMediaAccessStatus: (mediaType) => {
      assert.equal(mediaType, 'microphone');
      return mediaAccess.status;
    },
    askForMediaAccess: async (mediaType) => {
      askCalls.push(mediaType);
      return mediaAccess.askResult;
    },
  });
  const darwin = process.platform === 'darwin';

  assert.equal(
    await handlers.get(IPC_CHANNELS.microphonePermissionStatus)(),
    darwin ? 'granted' : 'unsupported',
  );

  mediaAccess.status = 'some-future-status';
  assert.equal(
    await handlers.get(IPC_CHANNELS.microphonePermissionStatus)(),
    darwin ? 'unknown' : 'unsupported',
  );

  mediaAccess.status = 'denied';
  mediaAccess.askResult = true;
  assert.equal(
    await handlers.get(IPC_CHANNELS.microphonePermissionRequest)(),
    darwin ? 'granted' : 'unsupported',
  );

  mediaAccess.askResult = false;
  assert.equal(
    await handlers.get(IPC_CHANNELS.microphonePermissionRequest)(),
    darwin ? 'denied' : 'unsupported',
  );
  if (darwin) {
    assert.deepEqual(askCalls, ['microphone', 'microphone']);
  }
});

test('microphone permission IPC reports unsupported when the platform lacks media access APIs', async () => {
  const handlers = await registerMainHandlersWithSystemPreferences({});

  assert.equal(await handlers.get(IPC_CHANNELS.microphonePermissionStatus)(), 'unsupported');
  assert.equal(await handlers.get(IPC_CHANNELS.microphonePermissionRequest)(), 'unsupported');
});
