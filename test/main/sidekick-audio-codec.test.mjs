import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SidekickMicrophonePreprocessor,
  chunkSidekickPcm,
  parsePcm16MonoWav,
  resamplePcm16Mono,
  wavToSidekickPcm,
} from '../../dist-electron/main/sidekick-audio-codec.js';

const pcmBytes = (samples) => {
  const bytes = Buffer.alloc(samples.length * 2);
  samples.forEach((sample, index) => bytes.writeInt16LE(sample, index * 2));
  return bytes;
};

const pcmSamples = (bytes) => Array.from({ length: bytes.byteLength / 2 }, (_, index) =>
  Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).readInt16LE(index * 2));

const toneAmplitude = (samples, frequency, sampleRate, skip = 0) => {
  let sin = 0;
  let cos = 0;
  const usable = samples.slice(skip);
  usable.forEach((sample, index) => {
    const phase = 2 * Math.PI * frequency * (index + skip) / sampleRate;
    sin += sample * Math.sin(phase);
    cos += sample * Math.cos(phase);
  });
  return 2 * Math.hypot(sin, cos) / usable.length;
};

const wavFixture = (samples, sampleRate = 24_000) => {
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

test('parses a canonical PCM16 mono WAV without exposing its container', () => {
  const parsed = parsePcm16MonoWav(wavFixture([0, 1000, -1000]));
  assert.equal(parsed.sampleRate, 24_000);
  assert.deepEqual(Array.from(parsed.samples), [0, 1000, -1000]);
});

test('rejects stereo, truncated and non-WAV input', () => {
  const stereo = wavFixture([1, 2]);
  stereo.writeUInt16LE(2, 22);
  assert.throws(() => parsePcm16MonoWav(stereo), /sidekick_wav_mono_required/);
  assert.throws(() => parsePcm16MonoWav(Buffer.from('nope')), /sidekick_wav_invalid/);
  assert.throws(() => parsePcm16MonoWav(wavFixture([1, 2]).subarray(0, 43)), /sidekick_wav_invalid/);
});

test('resamples Kokoro 24 kHz PCM exactly once to deterministic 16 kHz PCM', () => {
  const source = Int16Array.from([0, 3000, 6000, 9000, 12000, 15000]);
  assert.deepEqual(Array.from(resamplePcm16Mono(source, 24_000, 16_000)), [0, 4500, 9000, 13500]);
  const converted = wavToSidekickPcm(wavFixture(Array.from(source)));
  assert.equal(converted.sampleRate, 16_000);
  assert.deepEqual(Array.from(converted.samples), [0, 4500, 9000, 13500]);
});

test('chunks PCM into bounded sequenced protocol payloads', () => {
  const samples = Int16Array.from({ length: 2050 }, (_, index) => index - 1025);
  const chunks = chunkSidekickPcm(samples);
  assert.deepEqual(chunks.map(({ chunkSequence, sampleCount }) => ({ chunkSequence, sampleCount })), [
    { chunkSequence: 0, sampleCount: 1024 },
    { chunkSequence: 1, sampleCount: 1024 },
    { chunkSequence: 2, sampleCount: 2 },
  ]);
  const decoded = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk.pcmBase64, 'base64')));
  assert.equal(decoded.length, samples.length * 2);
  assert.equal(decoded.readInt16LE(0), -1025);
  assert.equal(decoded.readInt16LE(decoded.length - 2), 1024);
});

test('microphone preprocessing removes DC and mains buzz while retaining speech-band energy', () => {
  const sampleRate = 16_000;
  const samples = Array.from({ length: sampleRate }, (_, index) => Math.round(
    2_000 +
    4_000 * Math.sin(2 * Math.PI * 60 * index / sampleRate) +
    4_000 * Math.sin(2 * Math.PI * 1_000 * index / sampleRate),
  ));
  const output = pcmSamples(new SidekickMicrophonePreprocessor(sampleRate).process(pcmBytes(samples)));
  const skip = 2_000;
  const mean = output.slice(skip).reduce((sum, sample) => sum + sample, 0) / (output.length - skip);
  assert.ok(Math.abs(mean) < 5, `expected near-zero DC, received ${mean}`);
  assert.ok(toneAmplitude(output, 60, sampleRate, skip) < 200, 'expected 60 Hz notch attenuation');
  assert.ok(toneAmplitude(output, 1_000, sampleRate, skip) > 3_500, 'expected speech-band tone retention');
});

test('microphone preprocessing is sample-continuous across network chunks', () => {
  const samples = Array.from({ length: 4_000 }, (_, index) => Math.round(8_000 * Math.sin(2 * Math.PI * 330 * index / 16_000)));
  const whole = new SidekickMicrophonePreprocessor().process(pcmBytes(samples));
  const chunkedFilter = new SidekickMicrophonePreprocessor();
  const bytes = pcmBytes(samples);
  const chunked = Buffer.concat([
    chunkedFilter.process(bytes.subarray(0, 1_234)),
    chunkedFilter.process(bytes.subarray(1_234, 5_678)),
    chunkedFilter.process(bytes.subarray(5_678)),
  ]);
  assert.deepEqual(chunked, Buffer.from(whole));
  assert.throws(() => chunkedFilter.process(Uint8Array.of(1)), /sidekick_audio_pcm16_required/);
});
