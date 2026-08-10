import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

import { WebSocket } from 'ws';

import {
  createSafeStorage,
  createSidekickService,
  tmpRoot,
} from './sidekick-service-test-harness.mjs';

const require = createRequire(import.meta.url);
const {
  SidekickService,
  __testSidekickInternals,
} = require('../../dist-electron/main/sidekick-service.js');
const {
  SIDEKICK_DEFAULT_IDLE_CONFIG,
  SIDEKICK_IDLE_IMAGE_BYTES,
} = require('../../dist-electron/shared/types.js');

const SIDEKICK_ID = 'b12-sidekick';
const PAIRING_SECRET = Buffer.alloc(32, 7).toString('base64');

const storedRecord = (overrides = {}) => ({
  sidekickId: SIDEKICK_ID,
  name: 'BDD Sidekick',
  hostname: 'bdd-sidekick',
  pairedAt: '2026-08-10T00:00:00.000Z',
  updatedAt: '2026-08-10T00:00:00.000Z',
  firmwareVersion: '1.0.0',
  capabilities: ['display.text', 'display.screens', 'speaker.playback', 'system.time.sync'],
  encryptedPairingSecret: Buffer.from(`sealed:${PAIRING_SECRET}`, 'utf8').toString('base64'),
  ...overrides,
});

const runtimeState = (overrides = {}) => ({
  status: 'online',
  txSeq: 0,
  rxSeq: 0,
  sessionId: 'session-b12',
  pendingRecordingAcks: new Map(),
  pendingSpeakerAcks: new Map(),
  ...overrides,
});

const fakeSocket = (overrides = {}) => ({
  readyState: WebSocket.OPEN,
  sent: [],
  closed: [],
  send(value) { this.sent.push(value); },
  close(...args) { this.closed.push(args); },
  ...overrides,
});

const makeHarness = async (options = {}) => {
  const root = await tmpRoot('sidekick-b12');
  const states = [];
  const logs = [];
  const service = createSidekickService(SidekickService, root, {
    emitState: (state) => states.push(state),
    appendLog: async (event, payload) => logs.push({ event, payload }),
    ...options,
  });
  service.microphone.load = async () => undefined;
  return {
    root,
    service,
    states,
    logs,
    setStored(records = [storedRecord()]) {
      service.stored = { version: 1, desktopId: 'desktop-b12', records };
      service.desktopId = 'desktop-b12';
      service.keyFingerprint = 'desktop-b12';
    },
    cleanup: async () => {
      service.offlineTimer = null;
      await fs.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 });
    },
  };
};

const wavFixture = (samples = [0, 1000, -1000], sampleRate = 24_000) => {
  const pcm = Buffer.alloc(samples.length * 2);
  samples.forEach((sample, index) => pcm.writeInt16LE(sample, index * 2));
  const wav = Buffer.alloc(44 + pcm.length);
  wav.write('RIFF', 0, 'ascii');
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write('WAVE', 8, 'ascii');
  wav.write('fmt ', 12, 'ascii');
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36, 'ascii');
  wav.writeUInt32LE(pcm.length, 40);
  pcm.copy(wav, 44);
  return wav;
};

test('given service dependency failures, state and scan remain observable and log the failed boundary', async () => {
  const harness = await makeHarness();
  harness.setStored();
  let scans = 0;
  let networkStarts = 0;
  harness.service.ensureNetworkService = async () => {
    networkStarts += 1;
    throw new Error('port unavailable');
  };
  harness.service.refreshUsbDevices = async () => {
    scans += 1;
    throw new Error('usb unavailable');
  };

  try {
    const state = await harness.service.getState();
    assert.equal(state.sidekicks.length, 1);
    assert.equal(networkStarts, 1);
    assert.equal(scans, 1);
    assert.deepEqual(harness.logs.map((entry) => entry.event), [
      'sidekick:network_service_start_failed',
      'sidekick:usb_scan_failed',
    ]);

    harness.service.ensureNetworkService = async () => undefined;
    harness.service.refreshUsbDevices = async () => { harness.service.detectedUsb = [{ path: '/dev/b12', likelySidekick: true }]; };
    const scanned = await harness.service.scanUsb();
    assert.equal(scanned.detectedUsb[0].path, '/dev/b12');
    assert.equal(harness.states.length > 0, true);
    harness.service.notifyVoiceStateChanged();
    assert.equal(harness.states.at(-1).sidekicks[0].voicePhase, 'idle');

    harness.service.ensureNetworkService = async () => { throw new Error('scan network unavailable'); };
    await harness.service.scanUsb();
    assert.equal(harness.logs.at(-1).event, 'sidekick:network_service_start_failed');
  } finally {
    await harness.cleanup();
  }
});

test('given persisted pairing state, background startup ignores absent stores and starts only paired devices', async () => {
  const harness = await makeHarness();
  let starts = 0;
  harness.service.ensureNetworkService = async () => { starts += 1; };
  try {
    await harness.service.startIfPaired();
    assert.equal(starts, 0);
    await fs.writeFile(path.join(harness.root, 'sidekicks.json'), '{bad json');
    await harness.service.startIfPaired();
    assert.equal(starts, 0);
    await fs.writeFile(path.join(harness.root, 'sidekicks.json'), JSON.stringify({ version: 1, records: [] }));
    await harness.service.startIfPaired();
    assert.equal(starts, 0);

    await fs.writeFile(path.join(harness.root, 'sidekicks.json'), JSON.stringify({ version: 1, desktopId: 'desktop-b12', records: [storedRecord()] }));
    harness.service.stored = null;
    await harness.service.startIfPaired();
    assert.equal(starts, 1);
    assert.equal(harness.states.length, 1);

    harness.service.stored.records = [];
    await harness.service.startIfPaired();
    assert.equal(starts, 1);
  } finally {
    await harness.cleanup();
  }
});

test('given invalid USB setup input, configuration fails before exposing Wi-Fi or pairing material', async () => {
  const harness = await makeHarness();
  harness.setStored([]);
  harness.service.ensureNetworkService = async () => undefined;
  harness.service.refreshUsbDevices = async () => undefined;
  try {
    assert.equal((await harness.service.configureUsb({ ssid: ' ', password: 'p', name: 'Desk' })).technicalCode, 'sidekick_wifi_ssid_required');
    assert.equal((await harness.service.configureUsb({ ssid: 'WiFi', password: '', name: 'Desk' })).technicalCode, 'sidekick_wifi_password_required');
    assert.equal((await harness.service.configureUsb({ ssid: 'WiFi', password: 'p', name: ' ' })).technicalCode, 'sidekick_name_required');
    assert.equal((await harness.service.configureUsb({ ssid: 'WiFi', password: 'p', name: 'x'.repeat(65) })).technicalCode, 'sidekick_name_too_long');

    harness.service.storage = { ...createSafeStorage(), isEncryptionAvailable: () => false };
    assert.equal((await harness.service.configureUsb({ ssid: 'WiFi', password: 'p', name: 'Desk' })).technicalCode, 'sidekick_safe_storage_unavailable');
    harness.service.storage = createSafeStorage();
    assert.equal((await harness.service.configureUsb({ ssid: 'WiFi', password: 'p', name: 'Desk' })).technicalCode, 'sidekick_usb_not_found');

    harness.service.detectedUsb = [{ path: '/dev/b12', likelySidekick: true }];
    harness.service.configureUsbSession = async (_path, callback) => await callback({
      readHello: async () => ({ sidekickId: '', capabilities: [] }),
      writeConfigure: async () => undefined,
    });
    assert.equal((await harness.service.configureUsb({ ssid: 'WiFi', password: 'p', name: 'Desk', portPath: '/dev/b12' })).technicalCode, 'sidekick_usb_hello_missing_id');

    harness.service.configureUsbSession = async () => ({ sidekickId: '', capabilities: [] });
    assert.equal((await harness.service.configureUsb({ ssid: 'WiFi', password: 'p', name: 'Desk' })).technicalCode, 'sidekick_usb_hello_missing_id');
  } finally {
    await harness.cleanup();
  }
});

test('given display requests, the service validates registration, connection, content, and send failures', async () => {
  const harness = await makeHarness();
  harness.setStored();
  const record = harness.service.stored.records[0];
  try {
    assert.equal((await harness.service.sendDisplay({ sidekickId: 'missing', mode: 'set', text: 'hello' })).technicalCode, 'sidekick_not_registered');
    assert.equal((await harness.service.sendDisplay({ sidekickId: SIDEKICK_ID, mode: 'set', text: 'hello' })).technicalCode, 'sidekick_offline');

    const socket = fakeSocket();
    const runtime = runtimeState({ socket });
    harness.service.runtimes.set(SIDEKICK_ID, runtime);
    assert.equal((await harness.service.sendDisplay({ sidekickId: SIDEKICK_ID, mode: 'set', text: '  ' })).technicalCode, 'sidekick_display_text_required');

    const commands = [];
    harness.service.sendEncrypted = async (_record, _runtime, command) => commands.push(command);
    assert.equal((await harness.service.sendDisplay({ sidekickId: SIDEKICK_ID, mode: 'clear' })).success, true);
    assert.equal((await harness.service.sendDisplay({ sidekickId: SIDEKICK_ID, mode: 'set', text: 'hello  ' })).success, true);
    assert.equal((await harness.service.sendDisplay({ sidekickId: SIDEKICK_ID, mode: 'append', text: 'world' })).success, true);
    assert.deepEqual(commands.map((command) => command.cmd), ['display.clear', 'display.set', 'display.append']);
    assert.equal(commands[1].text, 'hello');

    harness.service.sendEncrypted = async () => { throw new Error('send failed'); };
    assert.equal((await harness.service.sendDisplay({ sidekickId: SIDEKICK_ID, mode: 'set', text: 'hello' })).technicalCode, 'sidekick_display_send_failed');
    assert.equal(runtime.status, 'error');
    harness.service.sendEncrypted = async () => { throw 'send failed string'; };
    runtime.status = 'online';
    await harness.service.sendDisplay({ sidekickId: SIDEKICK_ID, mode: 'set', text: 'hello' });
    assert.equal(harness.logs.at(-1).payload.error, 'send failed string');
    assert.equal(record.sidekickId, SIDEKICK_ID);
  } finally {
    await harness.cleanup();
  }
});

test('given voice and screen configuration, malformed values are rejected and valid optional fields are preserved', async () => {
  const harness = await makeHarness();
  harness.setStored();
  const record = harness.service.stored.records[0];
  try {
    assert.equal((await harness.service.setVoiceConfig({ sidekickId: SIDEKICK_ID, config: { model: 'm', conversationTtlMinutes: 10 } })).technicalCode, 'sidekick_voice_config_incomplete');
    assert.equal((await harness.service.setVoiceConfig({ sidekickId: SIDEKICK_ID, config: { locale: 'es', conversationTtlMinutes: 10 } })).technicalCode, 'sidekick_voice_config_incomplete');
    assert.equal((await harness.service.setVoiceConfig({ sidekickId: SIDEKICK_ID, config: { model: '$bad', voice: 'v', conversationTtlMinutes: 10 } })).technicalCode, 'sidekick_voice_config_invalid');
    assert.equal((await harness.service.setVoiceConfig({ sidekickId: SIDEKICK_ID, config: { model: 'm', voice: '$bad', conversationTtlMinutes: 10 } })).technicalCode, 'sidekick_voice_config_invalid');
    assert.equal((await harness.service.setVoiceConfig({ sidekickId: SIDEKICK_ID, config: { model: 'm', voice: 'v', locale: 'invalid locale', conversationTtlMinutes: 10 } })).technicalCode, 'sidekick_voice_config_invalid');

    assert.equal((await harness.service.sendScreen({ sidekickId: 'missing', template: 'idle' })).technicalCode, 'sidekick_not_registered');
    assert.equal((await harness.service.sendScreen({ sidekickId: SIDEKICK_ID, template: 'idle' })).technicalCode, 'sidekick_offline');
    const runtime = runtimeState({ socket: fakeSocket() });
    harness.service.runtimes.set(SIDEKICK_ID, runtime);
    record.capabilities = [];
    assert.equal((await harness.service.sendScreen({ sidekickId: SIDEKICK_ID, template: 'idle' })).technicalCode, 'sidekick_screen_capability_missing');
    record.capabilities = ['display.screens'];
    assert.equal((await harness.service.sendScreen({ sidekickId: SIDEKICK_ID, template: 'idle', title: 'x'.repeat(97) })).technicalCode, 'sidekick_screen_content_too_long');
    assert.equal((await harness.service.sendScreen({ sidekickId: SIDEKICK_ID, template: 'idle', body: 'x'.repeat(513) })).technicalCode, 'sidekick_screen_content_too_long');
    assert.equal((await harness.service.sendScreen({ sidekickId: SIDEKICK_ID, template: 'idle', text: 'x'.repeat(4001) })).technicalCode, 'sidekick_screen_content_too_long');
    assert.equal((await harness.service.sendScreen({ sidekickId: SIDEKICK_ID, template: 'state' })).technicalCode, 'sidekick_screen_icon_invalid');
    assert.equal((await harness.service.sendScreen({ sidekickId: SIDEKICK_ID, template: 'state', icon: 'unknown' })).technicalCode, 'sidekick_screen_icon_invalid');

    const commands = [];
    harness.service.sendEncrypted = async (_record, _runtime, command) => commands.push(command);
    assert.equal((await harness.service.sendScreen({ sidekickId: SIDEKICK_ID, template: 'state', icon: 'thinking', title: ' Title ', body: ' Body ', text: 'Text  ' })).success, true);
    assert.equal((await harness.service.sendScreen({ sidekickId: SIDEKICK_ID, template: 'idle' })).success, true);
    assert.deepEqual(commands[0], {
      v: 1,
      id: commands[0].id,
      cmd: 'screen.set',
      template: 'state',
      icon: 'thinking',
      title: 'Title',
      body: 'Body',
      text: 'Text',
    });
    assert.equal(Object.hasOwn(commands[1], 'text'), false);

    harness.service.sendEncrypted = async () => { throw 'screen failed'; };
    assert.equal((await harness.service.sendScreen({ sidekickId: SIDEKICK_ID, template: 'idle' })).technicalCode, 'sidekick_screen_send_failed');
    assert.equal(harness.logs.at(-1).payload.error, 'screen failed');
  } finally {
    await harness.cleanup();
  }
});

test('given speech requests, synthesis, cancellation, screen management, and playback errors remain explicit', async () => {
  const noTts = await makeHarness();
  try {
    assert.equal((await noTts.service.speak({ sidekickId: SIDEKICK_ID, text: null, model: 2, voice: [] })).technicalCode, 'sidekick_speech_input_required');
    assert.equal((await noTts.service.speak({ sidekickId: SIDEKICK_ID, text: 'hello', model: 'm', voice: 'v' })).technicalCode, 'sidekick_tts_unavailable');
  } finally {
    await noTts.cleanup();
  }

  let synthesis = { success: false };
  const harness = await makeHarness({ synthesizeSpeech: async () => synthesis });
  const screens = [];
  harness.service.sendScreen = async (input) => { screens.push(input); return { success: true }; };
  try {
    let result = await harness.service.speak({ sidekickId: SIDEKICK_ID, text: ' hello ', model: ' model ', voice: ' voice ' });
    assert.equal(result.technicalCode, 'sidekick_tts_failed');
    assert.deepEqual(screens.map((entry) => entry.icon ?? entry.template), ['speaking', 'idle']);

    synthesis = { success: false, userMessage: 'No audio.', technicalCode: 'no_audio' };
    result = await harness.service.speak({ sidekickId: SIDEKICK_ID, text: 'hello', model: 'model', voice: 'voice' }, { manageScreen: false });
    assert.equal(result.technicalCode, 'no_audio');

    synthesis = { success: true, audioDataBase64: wavFixture().toString('base64') };
    harness.service.playSpeakerPcm = async (input) => ({ success: true, samplesPlayed: input.samples.length });
    result = await harness.service.speak({ sidekickId: SIDEKICK_ID, text: 'hello', model: 'model', voice: 'voice', speed: 1.25 }, { manageScreen: false });
    assert.equal(result.success, true);

    harness.service.options.synthesizeSpeech = async () => { throw 'tts string failure'; };
    result = await harness.service.speak({ sidekickId: SIDEKICK_ID, text: 'hello', model: 'model', voice: 'voice' }, { manageScreen: false });
    assert.equal(result.technicalCode, 'sidekick_tts_failed');
    harness.service.options.synthesizeSpeech = async () => { throw new Error('tts error'); };
    result = await harness.service.speak({ sidekickId: SIDEKICK_ID, text: 'hello', model: 'model', voice: 'voice' }, { manageScreen: false });
    assert.equal(result.technicalCode, 'tts error');

    const abort = new AbortController();
    abort.abort(new Error('cancelled'));
    result = await harness.service.speak({ sidekickId: SIDEKICK_ID, text: 'hello', model: 'model', voice: 'voice' }, { signal: abort.signal, manageScreen: false });
    assert.equal(result.technicalCode, 'sidekick_speaker_playback_cancelled');

    harness.service.options.synthesizeSpeech = async () => ({ success: false });
    harness.service.sendScreen = async () => { throw new Error('screen lifecycle unavailable'); };
    result = await harness.service.speak({ sidekickId: SIDEKICK_ID, text: 'hello', model: 'model', voice: 'voice' });
    assert.equal(result.technicalCode, 'sidekick_tts_failed');
  } finally {
    await harness.cleanup();
  }
});

test('given an online Sidekick, time and speaker commands enforce capabilities and active-operation exclusion', async () => {
  const harness = await makeHarness({ getTimeSync: () => ({ epochMs: 1, timeZone: 'bad zone', utcOffsetMinutes: 0 }) });
  harness.setStored();
  const record = harness.service.stored.records[0];
  try {
    await assert.rejects(() => harness.service.syncTime(SIDEKICK_ID), /sidekick_offline/);
    const runtime = runtimeState({ socket: fakeSocket() });
    harness.service.runtimes.set(SIDEKICK_ID, runtime);
    await assert.rejects(() => harness.service.syncTime(SIDEKICK_ID), /sidekick_time_sync_invalid/);
    record.capabilities = [];
    await harness.service.syncTime(SIDEKICK_ID);

    assert.equal((await harness.service.playSpeakerPcm({ sidekickId: 'missing', samples: new Int16Array([1]) })).technicalCode, 'sidekick_not_registered');
    harness.service.runtimes.delete(SIDEKICK_ID);
    assert.equal((await harness.service.playSpeakerPcm({ sidekickId: SIDEKICK_ID, samples: new Int16Array([1]) })).technicalCode, 'sidekick_offline');
    harness.service.runtimes.set(SIDEKICK_ID, runtime);
    assert.equal((await harness.service.playSpeakerPcm({ sidekickId: SIDEKICK_ID, samples: new Int16Array([1]) })).technicalCode, 'sidekick_speaker_capability_missing');
    record.capabilities = ['speaker.playback'];
    assert.equal((await harness.service.playSpeakerPcm({ sidekickId: SIDEKICK_ID, samples: [] })).technicalCode, 'sidekick_speaker_audio_required');
    assert.equal((await harness.service.playSpeakerPcm({ sidekickId: SIDEKICK_ID, samples: new Int16Array() })).technicalCode, 'sidekick_speaker_audio_required');
    runtime.microphoneRecording = { status: 'recording' };
    assert.equal((await harness.service.playSpeakerPcm({ sidekickId: SIDEKICK_ID, samples: new Int16Array([1]) })).technicalCode, 'sidekick_audio_busy');
    runtime.microphoneRecording = undefined;
    runtime.speakerPlayback = { status: 'playing' };
    assert.equal((await harness.service.playSpeakerPcm({ sidekickId: SIDEKICK_ID, samples: new Int16Array([1]) })).technicalCode, 'sidekick_speaker_playback_active');
  } finally {
    await harness.cleanup();
  }
});

test('given idle customization, images are size-bound, path-safe, chunked, and usage rows are capped', async () => {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const usage = [
    { connected: false, label: 'Hidden', windows: [{ kind: 'weekly', usedPercent: 1 }] },
    {
      connected: true,
      label: 'Provider label longer than fifteen',
      windows: [
        { kind: 'five_hour', usedPercent: 10.4 },
        { kind: 'weekly', resetsAt: nowSeconds - 1 },
        { kind: 'weekly', resetsAt: nowSeconds + 60 },
        { kind: 'weekly', resetsAt: nowSeconds + 172_800 },
        { kind: 'weekly' },
        { kind: 'weekly', usedPercent: 90 },
        { kind: 'weekly', usedPercent: 99 },
      ],
    },
  ];
  const harness = await makeHarness({ getProviderUsage: async () => usage });
  harness.setStored();
  const record = harness.service.stored.records[0];
  const runtime = runtimeState({ socket: fakeSocket() });
  harness.service.runtimes.set(SIDEKICK_ID, runtime);
  const commands = [];
  harness.service.sendEncrypted = async (_record, _runtime, command) => commands.push(command);
  try {
    assert.equal((await harness.service.setIdleImage({ sidekickId: 'missing', rgb565: new Uint8Array() })).technicalCode, 'sidekick_not_registered');
    assert.equal((await harness.service.setIdleImage({ sidekickId: SIDEKICK_ID, rgb565: new Uint8Array(2) })).technicalCode, 'sidekick_idle_image_size_invalid');
    record.sidekickId = '../unsafe';
    assert.equal((await harness.service.setIdleImage({ sidekickId: '../unsafe', rgb565: new Uint8Array(SIDEKICK_IDLE_IMAGE_BYTES) })).technicalCode, 'sidekick_idle_image_path_invalid');
    record.sidekickId = SIDEKICK_ID;

    const bytes = new Uint8Array(SIDEKICK_IDLE_IMAGE_BYTES);
    assert.equal((await harness.service.setIdleImage({ sidekickId: SIDEKICK_ID, rgb565: bytes, previewDataUrl: 'not-an-image' })).success, true);
    assert.equal(record.idleImagePreviewDataUrl, undefined);
    assert.equal((await harness.service.setIdleImage({ sidekickId: SIDEKICK_ID, rgb565: bytes, previewDataUrl: 'data:image/png;base64,AA==' })).success, true);
    assert.match(record.idleImagePreviewDataUrl, /^data:image/);
    assert.equal(commands.some((command) => command.cmd === 'idle.image.begin'), true);
    assert.equal(commands.filter((command) => command.cmd === 'idle.image.chunk').length > 1, true);
    assert.equal(commands.some((command) => command.cmd === 'idle.image.commit'), true);

    await harness.service.pushLimits(record, runtime);
    const limits = commands.filter((command) => command.cmd === 'limits.update').at(-1);
    assert.equal(limits.rows.length, 6);
    assert.equal(limits.rows[0].provider.length, 15);
    assert.equal(limits.rows[0].window, '5h');
    assert.equal(limits.rows[0].usedPercent, 10);
    assert.equal(Object.hasOwn(limits.rows[0], 'reset'), false);
    assert.match(limits.rows[2].reset, /\d/);
    assert.match(limits.rows[3].reset, /[A-Z][a-z]{2}/);

    harness.service.options.getProviderUsage = async () => { throw new Error('usage unavailable'); };
    await harness.service.pushLimits(record, runtime);
    assert.deepEqual(commands.at(-1).rows, []);

    const noUsage = await makeHarness();
    noUsage.setStored();
    try {
      assert.equal(await noUsage.service.pushLimits(noUsage.service.stored.records[0], runtime), undefined);
    } finally {
      await noUsage.cleanup();
    }
  } finally {
    await harness.cleanup();
  }
});

test('given missing and malformed idle files, customization skips them and isolates independent push failures', async () => {
  const harness = await makeHarness();
  harness.setStored();
  const record = harness.service.stored.records[0];
  const runtime = runtimeState({ socket: fakeSocket() });
  const commands = [];
  harness.service.sendEncrypted = async (_record, _runtime, command) => commands.push(command);
  try {
    const invalidRecord = storedRecord({ sidekickId: '../bad' });
    await harness.service.pushIdleImage(invalidRecord, runtime);
    await harness.service.pushIdleImage(record, runtime);
    await fs.mkdir(path.join(harness.root, 'sidekick-idle-images'), { recursive: true });
    await fs.writeFile(path.join(harness.root, 'sidekick-idle-images', `${SIDEKICK_ID}.rgb565`), Buffer.alloc(2));
    await harness.service.pushIdleImage(record, runtime);
    assert.deepEqual(commands, []);

    record.idleConfig = { screens: ['custom'], rotateSeconds: 5 };
    const calls = [];
    harness.service.pushIdleConfig = async () => { calls.push('config'); throw new Error('config failed'); };
    harness.service.pushLimits = async () => { calls.push('limits'); throw new Error('limits failed'); };
    harness.service.pushIdleImage = async () => { calls.push('image'); throw new Error('image failed'); };
    await harness.service.pushCustomization(record, runtime);
    assert.deepEqual(calls, ['config', 'limits', 'image']);

    record.idleConfig = SIDEKICK_DEFAULT_IDLE_CONFIG;
    calls.length = 0;
    await harness.service.pushCustomization(record, runtime);
    assert.deepEqual(calls, ['config', 'limits']);
  } finally {
    await harness.cleanup();
  }
});

test('given runtime events, socket close, wake, overflow, encrypted send, and offline sweep update state safely', async () => {
  const wakes = [];
  const harness = await makeHarness({ onWakeDetected: async (event) => wakes.push(event) });
  harness.setStored();
  const record = harness.service.stored.records[0];
  const socket = fakeSocket();
  const runtime = runtimeState({ socket, lastSeenAt: new Date().toISOString() });
  harness.service.runtimes.set(SIDEKICK_ID, runtime);
  try {
    await assert.rejects(() => harness.service.sendEncrypted(record, runtimeState(), {}), /sidekick_socket_unavailable/);
    await harness.service.sendEncrypted(record, runtime, { cmd: 'test' });
    assert.equal(socket.sent.length, 1);

    await harness.service.handleActiveSessionPayload(runtime, { type: 'heartbeat', battery: { levelPercent: 50, charging: false }, time: { epochMs: Date.now(), timeZone: 'UTC', utcOffsetMinutes: 0 } });
    assert.equal(runtime.battery.levelPercent, 50);
    assert.equal(runtime.time.timeZone, 'UTC');
    await harness.service.handleActiveSessionPayload(runtime, {
      type: 'wake.detected',
      sidekickId: SIDEKICK_ID,
      wakeId: 'wake-b12',
      model: 'tiny',
      wakeWord: 'hey forger',
      wordIndex: 1,
      detectedAtMs: 10,
    });
    assert.equal(wakes.length, 1);
    await harness.service.handleActiveSessionPayload(runtime, { type: 'network.rx_overflow', droppedMessages: 2 });
    await harness.service.handleActiveSessionPayload(runtime, { type: 'unknown' });

    runtime.speakerPlayback = { playbackId: 'play', status: 'playing' };
    harness.service.markSocketClosed(socket, 1006, '');
    assert.equal(runtime.status, 'offline');
    assert.equal(runtime.speakerErrorCode, 'sidekick_socket_closed');

    const originalSetInterval = globalThis.setInterval;
    const originalClearInterval = globalThis.clearInterval;
    let sweep;
    globalThis.setInterval = (callback) => { sweep = callback; return { unref() {} }; };
    globalThis.clearInterval = () => undefined;
    try {
      const now = Date.now();
      const expired = runtimeState({ socket: fakeSocket(), lastSeenAt: new Date(now - 60_000).toISOString(), microphoneRecording: { status: 'recording' }, speakerPlayback: { playbackId: 'old', status: 'playing' } });
      const timeSync = runtimeState({ socket: fakeSocket(), lastSeenAt: new Date(now).toISOString() });
      const limits = runtimeState({ socket: fakeSocket(), lastSeenAt: new Date(now).toISOString(), lastTimeSyncAt: now, lastLimitsPushAt: now - 60_000 });
      const noLimits = runtimeState({ socket: fakeSocket(), lastSeenAt: new Date(now).toISOString(), lastTimeSyncAt: now, lastLimitsPushAt: now - 60_000 });
      const defaultLimits = runtimeState({ socket: fakeSocket(), lastSeenAt: new Date(now).toISOString(), lastTimeSyncAt: now, lastLimitsPushAt: now - 60_000 });
      const orphan = runtimeState({ socket: fakeSocket(), lastSeenAt: new Date(now).toISOString(), lastTimeSyncAt: now, lastLimitsPushAt: now - 60_000 });
      harness.service.runtimes = new Map([
        ['expired', expired],
        ['time-sync', timeSync],
        [SIDEKICK_ID, limits],
        ['no-limits', noLimits],
        ['default-limits', defaultLimits],
        ['', orphan],
      ]);
      record.idleConfig = { screens: ['limits'], rotateSeconds: 5 };
      harness.service.stored.records = [
        record,
        storedRecord({ sidekickId: 'no-limits', idleConfig: { screens: ['clock'], rotateSeconds: 5 } }),
        storedRecord({ sidekickId: 'default-limits' }),
      ];
      const failures = [];
      harness.service.microphone.failActive = async (_runtime, _message, code) => failures.push(code);
      const syncs = [];
      harness.service.syncTime = async (sidekickId) => syncs.push(sidekickId);
      const limitPushes = [];
      harness.service.pushLimits = async (target) => limitPushes.push(target.sidekickId);
      harness.service.startOfflineSweep();
      harness.service.startOfflineSweep();
      sweep();
      await Promise.resolve();
      assert.equal(expired.status, 'offline');
      assert.equal(expired.speakerErrorCode, 'sidekick_heartbeat_timeout');
      assert.deepEqual(failures, ['sidekick_heartbeat_timeout']);
      assert.deepEqual(syncs, ['time-sync']);
      assert.deepEqual(limitPushes, [SIDEKICK_ID]);
      assert.equal(noLimits.lastLimitsPushAt >= now, true);
      assert.equal(defaultLimits.lastLimitsPushAt >= now, true);
      assert.equal(orphan.lastLimitsPushAt >= now, true);
    } finally {
      globalThis.setInterval = originalSetInterval;
      globalThis.clearInterval = originalClearInterval;
      harness.service.offlineTimer = null;
    }
  } finally {
    await harness.cleanup();
  }
});

test('given storage and identity edge cases, load, save, upsert, lookup, and invalidation preserve the device registry', async () => {
  const invalidations = [];
  const harness = await makeHarness({
    onSessionInvalidated: async (event) => { invalidations.push(event); throw 'callback failed'; },
  });
  try {
    harness.service.stored = null;
    await fs.writeFile(path.join(harness.root, 'sidekicks.json'), JSON.stringify({ version: 1, desktopId: '', records: [storedRecord(), { bad: true }] }));
    await harness.service.load();
    assert.equal(harness.service.stored.desktopId, 'desktop-fingerprint');
    assert.equal(harness.service.stored.records.length, 1);

    await harness.service.upsertRecord({
      sidekickId: SIDEKICK_ID,
      name: 'Updated',
      hostname: 'updated-host',
      firmwareVersion: '2.0.0',
      capabilities: ['display.text'],
      pairingSecret: PAIRING_SECRET,
      desktopKeyFingerprint: 'desktop-fingerprint',
    });
    assert.equal(harness.service.findRecord(SIDEKICK_ID).name, 'Updated');
    await harness.service.upsertRecord({
      sidekickId: 'new-sidekick',
      name: 'New',
      hostname: 'new-host',
      capabilities: [],
      pairingSecret: PAIRING_SECRET,
      desktopKeyFingerprint: 'desktop-fingerprint',
    });
    assert.equal(harness.service.stored.records.length, 2);
    await harness.service.save();

    harness.service.ensureRuntime('created');
    assert.equal(harness.service.ensureRuntime('created').status, 'offline');
    await harness.service.notifySessionInvalidated(SIDEKICK_ID, 'reconnected');
    assert.equal(invalidations.length, 1);
    assert.equal(harness.logs.at(-1).event, 'sidekick:session_invalidation_failed');

    harness.service.desktopId = null;
    harness.service.keyFingerprint = null;
    harness.service.stored = { version: 1, desktopId: '', records: [] };
    await assert.rejects(() => harness.service.requireDesktopId(), /sidekick_desktop_id_unavailable/);
    harness.service.desktopId = 'desktop';
    await assert.rejects(() => harness.service.requireKeyFingerprint(), /sidekick_key_fingerprint_unavailable/);
  } finally {
    await harness.cleanup();
  }
});

test('given record mutation and idle configuration, missing devices fail and online custom screens push both settings and image', async () => {
  const harness = await makeHarness();
  harness.setStored();
  const runtime = runtimeState({ socket: fakeSocket() });
  harness.service.runtimes.set(SIDEKICK_ID, runtime);
  try {
    assert.equal((await harness.service.setPersonalAgent({ sidekickId: 'missing', personalAgentId: 'agent' })).technicalCode, 'sidekick_not_registered');
    assert.equal((await harness.service.setVoiceConfig({ sidekickId: 'missing', config: { conversationTtlMinutes: 10 } })).technicalCode, 'sidekick_not_registered');
    assert.equal((await harness.service.setIdleConfig({ sidekickId: 'missing', config: {} })).technicalCode, 'sidekick_not_registered');

    const voice = await harness.service.setVoiceConfig({
      sidekickId: SIDEKICK_ID,
      config: {
        model: 'tts-1',
        voice: 'alloy',
        locale: 'es-CL',
        sttLanguageMode: 'configured',
        sttLanguages: ['es', 'en'],
        conversationTtlMinutes: 15,
      },
    });
    assert.equal(voice.success, true);
    assert.equal(voice.sidekicks[0].voiceConfig.locale, 'es-CL');
    const clearedVoice = await harness.service.setVoiceConfig({
      sidekickId: SIDEKICK_ID,
      config: { conversationTtlMinutes: 15 },
    });
    assert.equal(clearedVoice.success, true);

    const pushes = [];
    harness.service.pushIdleConfig = async () => { pushes.push('config'); throw new Error('ignored config failure'); };
    harness.service.pushIdleImage = async () => { pushes.push('image'); throw new Error('ignored image failure'); };
    const configured = await harness.service.setIdleConfig({
      sidekickId: SIDEKICK_ID,
      config: { screens: ['custom', 'custom', 'invalid'], rotateSeconds: 5000 },
    });
    assert.equal(configured.success, true);
    assert.deepEqual(configured.sidekicks[0].idleConfig, { screens: ['custom'], rotateSeconds: 3600 });
    assert.deepEqual(pushes, ['config', 'image']);

    assert.deepEqual(harness.service.normalizeIdleConfig({ screens: [], rotateSeconds: Number.NaN }), SIDEKICK_DEFAULT_IDLE_CONFIG);
    assert.deepEqual(harness.service.normalizeIdleConfig({ screens: ['clock'], rotateSeconds: undefined }), { screens: ['clock'], rotateSeconds: 15 });
  } finally {
    await harness.cleanup();
  }
});

test('given encrypted network input, plaintext, unknown devices, mismatched payloads, replay, and invalid hello are rejected', async () => {
  const harness = await makeHarness();
  harness.setStored();
  const socket = fakeSocket();
  const context = (sidekickId = SIDEKICK_ID, sessionId = 'session-b12', seq = 1, desktopId = 'desktop-b12') => ({
    pairingSecretBase64: PAIRING_SECRET,
    sidekickId,
    desktopId,
    sessionId,
    seq,
  });
  const envelope = (payload, overrides = {}) => JSON.stringify(__testSidekickInternals.encryptSidekickPayload(payload, { ...context(), ...overrides }));
  try {
    await assert.rejects(() => harness.service.handleSocketMessage(socket, '{}'), /sidekick_socket_plaintext_rejected/);
    await assert.rejects(
      () => harness.service.handleSocketMessage(socket, envelope({ type: 'network.hello', sidekickId: SIDEKICK_ID }, { desktopId: 'other' })),
      /sidekick_desktop_id_mismatch/,
    );
    await assert.rejects(
      () => harness.service.handleSocketMessage(socket, envelope({ type: 'network.hello', sidekickId: 'missing' }, { sidekickId: 'missing' })),
      /sidekick_not_registered/,
    );
    await assert.rejects(
      () => harness.service.handleSocketMessage(socket, envelope({ type: 'heartbeat', sidekickId: 'other' })),
      /sidekick_network_payload_id_mismatch/,
    );
    await assert.rejects(
      () => harness.service.handleSocketMessage(socket, envelope({ type: 'network.hello', sidekickId: SIDEKICK_ID })),
      /sidekick_network_hello_invalid/,
    );

    const runtime = runtimeState({ socket, rxSeq: 5 });
    harness.service.runtimes.set(SIDEKICK_ID, runtime);
    await assert.rejects(
      () => harness.service.handleSocketMessage(socket, envelope({ type: 'heartbeat', sidekickId: SIDEKICK_ID }, { seq: 5 })),
      /sidekick_network_sequence_replay/,
    );
    runtime.rxSeq = undefined;
    await harness.service.handleSocketMessage(socket, envelope({ type: 'network.status', sidekickId: SIDEKICK_ID, ip: ' ' }, { seq: 6 }), '10.0.0.8');
    assert.equal(runtime.ipAddress, '10.0.0.8');
    await harness.service.handleSocketMessage(socket, envelope({ type: 'network.status', sidekickId: SIDEKICK_ID, ip: ' 192.168.1.25 ' }, { seq: 7 }), '10.0.0.9');
    assert.equal(runtime.ipAddress, '192.168.1.25');
  } finally {
    await harness.cleanup();
  }
});

test('given diagnostics with active playback, wake-beep and overflow callbacks update state and reject pending audio', async () => {
  const harness = await makeHarness();
  harness.setStored();
  const runtime = runtimeState({
    socket: fakeSocket(),
    speakerPlayback: { playbackId: 'play-b12', status: 'playing' },
  });
  const rejected = [];
  harness.service.speakerReceipts.reject = (_runtime, error) => rejected.push(error.message);
  try {
    await harness.service.handleActiveSessionPayload(runtime, {
      type: 'wake.beep.result',
      sidekickId: SIDEKICK_ID,
      wakeId: 'wake-b12',
      status: 'completed',
      durationMs: 120,
    });
    assert.equal(runtime.wakeBeep.status, 'completed');
    await harness.service.handleActiveSessionPayload(runtime, {
      type: 'network.rx_overflow',
      sidekickId: SIDEKICK_ID,
      code: 'RX_QUEUE_FULL',
      droppedMessages: 2,
    });
    assert.equal(runtime.speakerErrorCode, 'sidekick_network_rx_overflow');
    assert.deepEqual(rejected, ['sidekick_network_rx_overflow']);
    assert.equal(harness.states.length >= 2, true);
  } finally {
    await harness.cleanup();
  }
});

test('given USB write failures and malformed configure commands, the serial session cancels pending receipts and always closes', async () => {
  class FailingSerialPort extends EventEmitter {
    static async list() { return []; }
    constructor() {
      super();
      this.isOpen = false;
    }
    pipe(parser) { this.parser = parser; return parser; }
    open(callback) { this.isOpen = true; callback(); }
    write(_line, callback) { callback(new Error('serial write failed')); }
    close(callback) { this.isOpen = false; callback(); }
  }
  const harness = await makeHarness({ serialPortClass: FailingSerialPort });
  try {
    await assert.rejects(
      () => harness.service.configureUsbSession('/dev/failing', async (session) => await session.readHello()),
      /serial write failed/,
    );
    await assert.rejects(
      () => harness.service.configureUsbSession('/dev/failing', async (session) => await session.writeConfigure({}, { sidekickId: SIDEKICK_ID, hostname: 'bdd' })),
      /sidekick_usb_pair_configure_missing_id/,
    );
  } finally {
    await harness.cleanup();
  }
});

test('given network publication, the health endpoint, invalid address, and Bonjour replacement honor lifecycle boundaries', async () => {
  const harness = await makeHarness();
  harness.setStored([]);
  try {
    await harness.service.ensureNetworkService();
    const response = await new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${harness.service.servicePort}/not-found`, resolve).once('error', reject);
    });
    assert.equal(response.statusCode, 404);
    response.resume();

    let stopped = 0;
    let published = 0;
    harness.service.bonjourService = { stop: () => { stopped += 1; } };
    harness.service.bonjour = {
      publish: () => { published += 1; return { stop(callback) { callback?.(); } }; },
      destroy: (callback) => callback?.(),
    };
    harness.service.publishBonjour();
    assert.equal(stopped, 1);
    assert.equal(published, 1);
    harness.service.servicePort = null;
    harness.service.publishBonjour();

    await harness.service.dispose();
  } finally {
    await harness.cleanup();
  }
});

test('given platform defaults and internal fallback values, construction and state remain deterministic', async () => {
  const root = await tmpRoot('sidekick-b12-defaults');
  const originalDateTimeFormat = Intl.DateTimeFormat;
  try {
    const defaults = new SidekickService({
      metadataRoot: root,
      getCloudIdentity: async () => ({ publicKey: 'public', keyFingerprint: 'desktop-defaults' }),
    });
    assert.equal(typeof defaults.serialPortClass.list, 'function');
    assert.equal(defaults.storage, undefined);

    const harness = await makeHarness();
    try {
      harness.setStored();
      harness.service.detectedUsb = [{ path: '/dev/b12', likelySidekick: true }];
      assert.equal(harness.service.selectUsbDevice('/dev/missing'), null);

      harness.service.stored = null;
      harness.service.desktopId = null;
      harness.service.keyFingerprint = null;
      harness.service.runtimes = new Map([['usb:anonymous', runtimeState({ status: 'pairing' })]]);
      const emptyState = harness.service.buildState();
      assert.equal(emptyState.desktopId, '');
      assert.equal(emptyState.keyFingerprint, undefined);
      assert.equal(emptyState.sidekicks[0].name, 'Sidekick USB');

      Intl.DateTimeFormat = function DateTimeFormat() {
        return { resolvedOptions: () => ({ timeZone: '' }) };
      };
      harness.setStored();
      const commands = [];
      harness.service.sendEncrypted = async (_record, _runtime, command) => commands.push(command);
      harness.service.runtimes = new Map([[SIDEKICK_ID, runtimeState({ socket: fakeSocket() })]]);
      await harness.service.syncTime(SIDEKICK_ID);
      assert.equal(commands[0].timeZone, 'UTC');
    } finally {
      Intl.DateTimeFormat = originalDateTimeFormat;
      await harness.cleanup();
    }
  } finally {
    Intl.DateTimeFormat = originalDateTimeFormat;
    await fs.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 });
  }
});

test('given non-Error dependency failures and an unavailable listener address, failures preserve stable codes', async () => {
  const harness = await makeHarness();
  harness.setStored();
  const runtime = runtimeState({ socket: fakeSocket() });
  harness.service.runtimes.set(SIDEKICK_ID, runtime);
  try {
    harness.service.detectedUsb = [{ path: '/dev/b12', likelySidekick: true }];
    harness.service.ensureNetworkService = async () => undefined;
    harness.service.refreshUsbDevices = async () => undefined;
    harness.service.configureUsbSession = async () => { throw 'usb string failure'; };
    assert.equal((await harness.service.configureUsb({ ssid: 'WiFi', password: 'secret', name: 'Desk' })).success, false);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(harness.logs.at(-1).payload.error, 'usb string failure');

    harness.service.sendEncrypted = async () => { throw new Error('screen error'); };
    assert.equal((await harness.service.sendScreen({ sidekickId: SIDEKICK_ID, template: 'idle' })).technicalCode, 'sidekick_screen_send_failed');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(harness.logs.at(-1).payload.error, 'screen error');

    const oldSocket = fakeSocket();
    runtime.socket = oldSocket;
    runtime.sessionId = 'old-session';
    runtime.ipAddress = undefined;
    runtime.status = 'online';
    harness.service.syncTime = async () => { throw 'time sync string failure'; };
    harness.service.pushCustomization = async () => undefined;
    const envelope = JSON.stringify(__testSidekickInternals.encryptSidekickPayload({
      v: 1,
      type: 'network.hello',
      sidekickId: SIDEKICK_ID,
      capabilities: [],
      ip: '',
    }, {
      pairingSecretBase64: PAIRING_SECRET,
      sidekickId: SIDEKICK_ID,
      desktopId: 'desktop-b12',
      sessionId: 'new-session',
      seq: 10,
    }));
    const replacement = fakeSocket();
    await harness.service.handleSocketMessage(replacement, envelope, '10.0.0.25');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(runtime.ipAddress, '10.0.0.25');
    assert.equal(oldSocket.closed.length, 1);
    assert.equal(harness.logs.at(-1).payload.error, 'time sync string failure');

    const sameSessionEnvelope = JSON.stringify(__testSidekickInternals.encryptSidekickPayload({
      v: 1,
      type: 'network.hello',
      sidekickId: SIDEKICK_ID,
      capabilities: [],
      ip: '',
    }, {
      pairingSecretBase64: PAIRING_SECRET,
      sidekickId: SIDEKICK_ID,
      desktopId: 'desktop-b12',
      sessionId: 'new-session',
      seq: 11,
    }));
    await harness.service.handleSocketMessage(replacement, sameSessionEnvelope, '10.0.0.26');
    assert.equal(runtime.ipAddress, '10.0.0.26');

    const originalCreateServer = http.createServer;
    class InvalidAddressServer extends EventEmitter {
      listen(_port, _host, callback) { callback(); return this; }
      address() { return null; }
      close(callback) { callback?.(); this.emit('close'); }
    }
    http.createServer = () => new InvalidAddressServer();
    const invalidAddress = await makeHarness();
    invalidAddress.setStored([]);
    try {
      await assert.rejects(() => invalidAddress.service.ensureNetworkService(), /sidekick_ws_address_unavailable/);
      assert.equal(invalidAddress.service.wsServer, null);
      assert.equal(invalidAddress.service.httpServer, null);
    } finally {
      http.createServer = originalCreateServer;
      await invalidAddress.cleanup();
    }
  } finally {
    await harness.cleanup();
  }
});

test('given speaker transport failures, cancellation and non-Error failures map to the observable playback contract', async () => {
  const harness = await makeHarness();
  harness.setStored();
  const runtime = runtimeState({ socket: fakeSocket() });
  harness.service.runtimes.set(SIDEKICK_ID, runtime);
  harness.service.speakerReceipts.wait = async () => undefined;
  harness.service.speakerReceipts.reject = () => undefined;
  try {
    let abortReads = 0;
    const fakeAbortedSignal = {
      get aborted() { abortReads += 1; return abortReads > 1; },
      reason: null,
      addEventListener() {},
      removeEventListener() {},
    };
    let sends = 0;
    harness.service.sendEncrypted = async () => { sends += 1; };
    let result = await harness.service.playSpeakerPcm(
      { sidekickId: SIDEKICK_ID, samples: new Int16Array([1]) },
      { signal: fakeAbortedSignal },
    );
    assert.equal(result.technicalCode, 'sidekick_speaker_playback_cancelled');
    assert.equal(sends >= 1, true);

    runtime.status = 'online';
    runtime.socket = fakeSocket();
    runtime.sessionId = 'session-b12';
    harness.service.sendEncrypted = async () => { throw 'speaker string failure'; };
    result = await harness.service.playSpeakerPcm({ sidekickId: SIDEKICK_ID, samples: new Int16Array([1]) });
    assert.equal(result.technicalCode, 'sidekick_speaker_playback_failed');
    assert.equal(harness.logs.at(-1).payload.technicalCode, 'speaker string failure');
  } finally {
    await harness.cleanup();
  }
});

test('given forget and empty storage operations, only registered device data and safe image paths are removed', async () => {
  const invalidated = [];
  const harness = await makeHarness({ onSessionInvalidated: async (event) => invalidated.push(event) });
  harness.setStored();
  const socket = fakeSocket();
  harness.service.runtimes.set(SIDEKICK_ID, runtimeState({ socket }));
  harness.service.microphone.cleanupActive = async () => undefined;
  harness.service.microphone.forget = async () => undefined;
  try {
    await fs.mkdir(path.join(harness.root, 'sidekick-idle-images'), { recursive: true });
    await fs.writeFile(path.join(harness.root, 'sidekick-idle-images', `${SIDEKICK_ID}.rgb565`), 'image');
    assert.equal((await harness.service.forget(SIDEKICK_ID)).success, true);
    assert.equal(harness.service.stored.records.length, 0);
    assert.equal(socket.closed.length, 1);
    assert.deepEqual(invalidated, [{ sidekickId: SIDEKICK_ID, reason: 'forgotten' }]);
    await assert.rejects(() => fs.access(path.join(harness.root, 'sidekick-idle-images', `${SIDEKICK_ID}.rgb565`)));

    assert.equal((await harness.service.forget('missing')).success, true);
    harness.service.stored = null;
    await harness.service.save();
  } finally {
    await harness.cleanup();
  }
});
