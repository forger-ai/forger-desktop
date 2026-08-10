import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const helpers = require('../../dist-electron/main/sidekick-service-helpers.js');

test('Sidekick discovery normalizers reject unsafe shapes and retain valid time metadata', () => {
  assert.deepEqual(helpers.normalizeCapabilities(null), []);
  assert.deepEqual(helpers.normalizeCapabilities([' microphone ', '', 7, 'speaker']), ['microphone', 'speaker']);
  assert.equal(helpers.normalizeSidekickTime(null), null);
  assert.equal(helpers.normalizeSidekickTime([]), null);
  assert.equal(helpers.normalizeSidekickTime({ epochMs: 1.2, utcOffsetMinutes: 900, timeZone: 'bad zone' }), null);
  assert.deepEqual(helpers.normalizeSidekickTime({ synced: false }), { synced: false });
  assert.deepEqual(helpers.normalizeSidekickTime({
    synced: true,
    epochMs: 1_754_819_200_000,
    utcOffsetMinutes: -240,
    timeZone: 'America/Santiago',
  }), {
    synced: true,
    epochMs: 1_754_819_200_000,
    utcOffsetMinutes: -240,
    timeZone: 'America/Santiago',
  });
  assert.equal(helpers.normalizeVisibleSidekickName(7), null);
  assert.equal(helpers.normalizeVisibleSidekickName('   '), null);
  assert.equal(helpers.normalizeVisibleSidekickName('  Kitchen   Sidekick '), 'Kitchen Sidekick');
  assert.match(helpers.buildSidekickHostname('---', 'sidekick-1'), /^sidekick-[0-9a-f]+$/);
});

test('stored Sidekick voice profiles canonicalize modes, locales and language subsets', () => {
  assert.deepEqual(helpers.normalizedStoredSidekickVoiceConfig({
    model: ' tts.model ', voice: ' voice_1 ', locale: 'en-us', sttLanguageMode: 'auto',
    sttLanguages: ['EN', 'en', 'es'], conversationTtlMinutes: 15,
  }), {
    model: 'tts.model', voice: 'voice_1', locale: 'en-US', sttLanguageMode: 'auto', conversationTtlMinutes: 15,
  });
  assert.equal(helpers.normalizedStoredSidekickVoiceConfig({
    sttLanguageMode: 'voice',
  }).sttLanguageMode, 'voice');
  assert.deepEqual(helpers.normalizedStoredSidekickVoiceConfig({
    sttLanguageMode: 'fixed', sttLanguages: ['ES', 'en'],
  }).sttLanguages, ['es']);
  assert.deepEqual(helpers.normalizedStoredSidekickVoiceConfig({
    sttLanguageMode: 'subset', sttLanguages: ['ES', 'en', 'xx-invalid'],
  }).sttLanguages, ['es', 'en']);
  const invalidLocale = helpers.normalizedStoredSidekickVoiceConfig({
    model: 'model', voice: 'voice', locale: 'not a locale', sttLanguageMode: 'fixed', sttLanguages: [],
    conversationTtlMinutes: Number.NaN,
  });
  assert.equal(invalidLocale.locale, undefined);
  assert.equal(invalidLocale.sttLanguageMode, 'subset');
  assert.ok(invalidLocale.sttLanguages.length >= 2);
});

test('stored Sidekick recording validation enforces the complete audio storage contract', () => {
  const valid = {
    recordingId: 'recording-1',
    sidekickId: 'sidekick-1',
    createdAt: '2026-08-10T10:00:00Z',
    stoppedAt: '2026-08-10T10:00:01Z',
    durationMs: 1_000,
    sampleCount: 16_000,
    sampleRate: helpers.SIDEKICK_MIC_SAMPLE_RATE,
    channels: helpers.SIDEKICK_MIC_CHANNELS,
    format: helpers.SIDEKICK_MIC_FORMAT,
    sizeBytes: helpers.WAV_HEADER_BYTES + 32_000,
    filename: 'be0a96df-742a-41ac-b7cc-4ef47bcb1c62.wav',
  };
  assert.equal(helpers.isStoredSidekickRecording(valid), true);
  assert.equal(helpers.isStoredSidekickRecording(null), false);
  const invalidMutations = [
    { recordingId: 1 }, { sidekickId: 1 }, { createdAt: 1 }, { stoppedAt: 1 },
    { durationMs: '1000' }, { durationMs: 1.5 }, { durationMs: -1 },
    { sampleCount: '16000' }, { sampleCount: 1.5 }, { sampleCount: -1 },
    { sampleRate: helpers.SIDEKICK_MIC_SAMPLE_RATE + 1 },
    { channels: helpers.SIDEKICK_MIC_CHANNELS + 1 },
    { format: 'float32' }, { sizeBytes: '32044' }, { sizeBytes: 1.5 },
    { sizeBytes: helpers.WAV_HEADER_BYTES }, { filename: 7 }, { filename: '../recording.wav' },
  ];
  for (const mutation of invalidMutations) {
    assert.equal(helpers.isStoredSidekickRecording({ ...valid, ...mutation }), false, JSON.stringify(mutation));
  }
});

test('Sidekick audio and serial diagnostics are safe for malformed peripheral input', () => {
  assert.deepEqual(helpers.summarizeSpeakerPlayback({
    speakerErrorMessage: 'Speaker unavailable', speakerErrorCode: 'speaker_unavailable',
  }), { status: 'error', errorMessage: 'Speaker unavailable', technicalCode: 'speaker_unavailable' });
  assert.equal(helpers.decodeCanonicalBase64Chunk(''), null);
  assert.equal(helpers.decodeCanonicalBase64Chunk('abc'), null);
  assert.equal(helpers.decodeCanonicalBase64Chunk('Zh=='), null);
  assert.deepEqual(helpers.decodeCanonicalBase64Chunk('Zg=='), Buffer.from('f'));

  const originalFrom = Buffer.from;
  try {
    Buffer.from = function throwingBase64(value, encoding, ...rest) {
      if (value === 'Zm9v' && encoding === 'base64') throw new Error('decoder unavailable');
      return originalFrom.call(Buffer, value, encoding, ...rest);
    };
    assert.equal(helpers.decodeCanonicalBase64Chunk('Zm9v'), null);
  } finally {
    Buffer.from = originalFrom;
  }

  assert.equal(helpers.parseJsonLine('{not-json'), null);
  assert.deepEqual(helpers.parseJsonLine(' {"type":"hello"} '), { type: 'hello' });
  assert.equal(helpers.coerceSerialLine(Buffer.from('hello')), 'hello');
  assert.equal(helpers.coerceSerialLine(42), '42');
  assert.deepEqual(helpers.summarizeUsbSerialLine('/dev/test', Buffer.from('{"type":"hello","requestId":"r1"}')), {
    path: '/dev/test', bytes: 33, messageType: 'hello', command: undefined, requestIdPresent: true, requestIdLength: 2,
  });
  assert.deepEqual(helpers.summarizeUsbSerialLine('/dev/test', '{"type":7,"cmd":8}'), {
    path: '/dev/test', bytes: 18, messageType: undefined, command: undefined,
    requestIdPresent: false, requestIdLength: 0,
  });
  assert.equal(helpers.summarizeUsbSerialLine('/dev/test', '{"cmd":"pair"}').command, 'pair');
  assert.deepEqual(helpers.summarizeUsbSerialCommand('/dev/test', { type: 7, cmd: 8, requestId: 'fallback-id' }), {
    path: '/dev/test', bytes: 45, messageType: undefined, command: undefined,
    requestIdPresent: true, requestIdLength: 11,
  });
  assert.equal(helpers.summarizeUsbSerialCommand('/dev/test', { type: 'command', cmd: 'pair' }).messageType, 'command');
});

test('Sidekick USB hello waits for the matching peripheral and cancellation is idempotent', async () => {
  const parser = new EventEmitter();
  const hello = helpers.waitForUsbHello(parser, 'request-1');
  parser.emit('data', '{"type":"hello","transport":"network","requestId":"request-1","sidekickId":"s1"}');
  parser.emit('data', '{"type":"hello","transport":"usb","requestId":"request-1","sidekickId":"s1"}');
  assert.equal((await hello.promise).sidekickId, 's1');
  hello.cancel();

  const cancelled = helpers.waitForUsbHello(parser, 'request-2');
  cancelled.cancel();
  cancelled.cancel();
  await assert.rejects(cancelled.promise, /sidekick_usb_hello_cancelled/);
});

test('Sidekick pairing wait rejects peripheral errors, resolves exact acknowledgements and cancels safely', async () => {
  const parser = new EventEmitter();
  const expected = { requestId: 'pair-1', sidekickId: 's1', hostname: 'kitchen-s1' };
  const rejected = helpers.waitForPairConfiguredAck(parser, expected);
  parser.emit('data', '{"type":"pair.error","requestId":"other","code":"busy"}');
  parser.emit('data', '{"type":"pair.error","requestId":"pair-1","sidekickId":"other","code":"busy"}');
  parser.emit('data', '{"type":"pair.error","requestId":"pair-1","sidekickId":"s1","code":"Already Paired!"}');
  await assert.rejects(rejected.promise, /sidekick_usb_pair_error_already_paired/);

  const accepted = helpers.waitForPairConfiguredAck(parser, expected);
  parser.emit('data', '{"type":"pair.configured","requestId":"pair-1","sidekickId":"s1","hostname":"wrong","paired":true}');
  parser.emit('data', '{"type":"pair.configured","requestId":"pair-1","sidekickId":"s1","hostname":"kitchen-s1","paired":true}');
  await accepted.promise;
  accepted.cancel();

  const cancelled = helpers.waitForPairConfiguredAck(parser, { ...expected, requestId: 'pair-2' });
  cancelled.cancel();
  cancelled.cancel();
  await assert.rejects(cancelled.promise, /sidekick_usb_pair_configure_cancelled/);
});

test('Sidekick USB failure translation and serial callbacks preserve actionable errors', async () => {
  assert.equal(helpers.normalizePairErrorTechnicalCode({}), 'sidekick_usb_pair_error');
  assert.equal(helpers.normalizePairErrorTechnicalCode({ code: '!!!' }), 'sidekick_usb_pair_error');
  assert.equal(helpers.sidekickConfigureFailureCode(new Error('sidekick_usb_pair_error_busy')), 'sidekick_usb_pair_error_busy');
  assert.equal(helpers.sidekickConfigureFailureCode(new Error('offline')), 'sidekick_usb_configure_failed');
  assert.match(helpers.sidekickConfigureFailureMessage('sidekick_usb_pair_configure_timeout'), /confirmó/);
  assert.match(helpers.sidekickConfigureFailureMessage('sidekick_usb_pair_error_busy'), /rechazó/);
  assert.match(helpers.sidekickConfigureFailureMessage('sidekick_usb_configure_failed'), /No pude/);

  await assert.rejects(helpers.openSerialPort({ open: (callback) => callback(new Error('open failed')) }), /open failed/);
  let closeCalled = false;
  await helpers.closeSerialPort({ isOpen: false, close: () => { closeCalled = true; } });
  assert.equal(closeCalled, false);
  await assert.rejects(helpers.writeSerialLine({
    write: (_line, callback) => callback(new Error('write failed')),
  }, { cmd: 'pair' }), /write failed/);
  await assert.rejects(helpers.drainSerialPort({
    drain: (callback) => callback(new Error('drain failed')),
  }), /drain failed/);
});
