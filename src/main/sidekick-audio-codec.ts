export const SIDEKICK_AUDIO_SAMPLE_RATE = 16_000;
export const SIDEKICK_AUDIO_MAX_CHUNK_SAMPLES = 1024;

export interface ParsedPcm16MonoWav {
  sampleRate: number;
  samples: Int16Array;
}

export interface SidekickPcmChunk {
  chunkSequence: number;
  sampleCount: number;
  pcmBase64: string;
}

interface BiquadCoefficients {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

class StatefulBiquad {
  private x1 = 0;
  private x2 = 0;
  private y1 = 0;
  private y2 = 0;

  public constructor(private readonly coefficients: BiquadCoefficients) {}

  public process(sample: number): number {
    const { b0, b1, b2, a1, a2 } = this.coefficients;
    const output = b0 * sample + b1 * this.x1 + b2 * this.x2 - a1 * this.y1 - a2 * this.y2;
    this.x2 = this.x1;
    this.x1 = sample;
    this.y2 = this.y1;
    this.y1 = output;
    return output;
  }
}

const normalizedBiquad = (
  b0: number,
  b1: number,
  b2: number,
  a0: number,
  a1: number,
  a2: number,
): BiquadCoefficients => ({ b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 });

const highPassCoefficients = (sampleRate: number, frequency: number, q: number): BiquadCoefficients => {
  const omega = 2 * Math.PI * frequency / sampleRate;
  const cosine = Math.cos(omega);
  const alpha = Math.sin(omega) / (2 * q);
  return normalizedBiquad(
    (1 + cosine) / 2,
    -(1 + cosine),
    (1 + cosine) / 2,
    1 + alpha,
    -2 * cosine,
    1 - alpha,
  );
};

const notchCoefficients = (sampleRate: number, frequency: number, q: number): BiquadCoefficients => {
  const omega = 2 * Math.PI * frequency / sampleRate;
  const cosine = Math.cos(omega);
  const alpha = Math.sin(omega) / (2 * q);
  return normalizedBiquad(1, -2 * cosine, 1, 1 + alpha, -2 * cosine, 1 - alpha);
};

/** Stateful 100 Hz HPF + 60 Hz notch for contiguous Sidekick microphone chunks. */
export class SidekickMicrophonePreprocessor {
  private readonly highPass: StatefulBiquad;
  private readonly mainsNotch: StatefulBiquad;

  public constructor(sampleRate = SIDEKICK_AUDIO_SAMPLE_RATE) {
    if (!Number.isInteger(sampleRate) || sampleRate < 8_000 || sampleRate > 96_000) {
      throw new Error('sidekick_audio_sample_rate_invalid');
    }
    this.highPass = new StatefulBiquad(highPassCoefficients(sampleRate, 100, Math.SQRT1_2));
    this.mainsNotch = new StatefulBiquad(notchCoefficients(sampleRate, 60, 20));
  }

  public process(pcm: Uint8Array): Uint8Array {
    if (pcm.byteLength % 2 !== 0) throw new Error('sidekick_audio_pcm16_required');
    const input = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    const output = Buffer.allocUnsafe(pcm.byteLength);
    for (let offset = 0; offset < pcm.byteLength; offset += 2) {
      const filtered = this.mainsNotch.process(this.highPass.process(input.getInt16(offset, true)));
      output.writeInt16LE(Math.max(-32_768, Math.min(32_767, Math.round(filtered))), offset);
    }
    return output;
  }
}

const ascii = (bytes: Uint8Array, offset: number, length: number): string =>
  Buffer.from(bytes.buffer, bytes.byteOffset + offset, length).toString('ascii');

export const parsePcm16MonoWav = (input: Uint8Array): ParsedPcm16MonoWav => {
  if (input.byteLength < 44) {
    throw new Error('sidekick_wav_invalid');
  }
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  if (ascii(input, 0, 4) !== 'RIFF' || ascii(input, 8, 4) !== 'WAVE') {
    throw new Error('sidekick_wav_invalid');
  }
  const declaredSize = view.getUint32(4, true) + 8;
  if (declaredSize > input.byteLength || declaredSize < 44) {
    throw new Error('sidekick_wav_invalid');
  }

  let audioFormat: number | undefined;
  let channels: number | undefined;
  let sampleRate: number | undefined;
  let bitsPerSample: number | undefined;
  let dataOffset: number | undefined;
  let dataLength: number | undefined;
  let cursor = 12;
  while (cursor + 8 <= declaredSize) {
    const chunkId = ascii(input, cursor, 4);
    const chunkLength = view.getUint32(cursor + 4, true);
    const payloadOffset = cursor + 8;
    const next = payloadOffset + chunkLength + (chunkLength % 2);
    if (payloadOffset + chunkLength > declaredSize || next > input.byteLength + 1) {
      throw new Error('sidekick_wav_invalid');
    }
    if (chunkId === 'fmt ') {
      if (chunkLength < 16) {
        throw new Error('sidekick_wav_invalid');
      }
      audioFormat = view.getUint16(payloadOffset, true);
      channels = view.getUint16(payloadOffset + 2, true);
      sampleRate = view.getUint32(payloadOffset + 4, true);
      bitsPerSample = view.getUint16(payloadOffset + 14, true);
    } else if (chunkId === 'data') {
      dataOffset = payloadOffset;
      dataLength = chunkLength;
    }
    cursor = next;
  }
  if (audioFormat !== 1) {
    throw new Error('sidekick_wav_pcm16_required');
  }
  if (channels !== 1) {
    throw new Error('sidekick_wav_mono_required');
  }
  if (bitsPerSample !== 16 || !sampleRate || sampleRate < 8_000 || sampleRate > 96_000) {
    throw new Error('sidekick_wav_pcm16_required');
  }
  if (dataOffset === undefined || dataLength === undefined || dataLength % 2 !== 0 || dataOffset + dataLength > declaredSize) {
    throw new Error('sidekick_wav_invalid');
  }
  const samples = new Int16Array(dataLength / 2);
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = view.getInt16(dataOffset + index * 2, true);
  }
  return { sampleRate, samples };
};

export const resamplePcm16Mono = (
  source: Int16Array,
  sourceRate: number,
  targetRate: number,
): Int16Array => {
  if (!Number.isInteger(sourceRate) || !Number.isInteger(targetRate) || sourceRate <= 0 || targetRate <= 0) {
    throw new Error('sidekick_audio_sample_rate_invalid');
  }
  if (source.length === 0 || sourceRate === targetRate) {
    return Int16Array.from(source);
  }
  const outputLength = Math.max(1, Math.round(source.length * targetRate / sourceRate));
  const output = new Int16Array(outputLength);
  const ratio = sourceRate / targetRate;
  for (let index = 0; index < outputLength; index += 1) {
    const position = index * ratio;
    const leftIndex = Math.min(source.length - 1, Math.floor(position));
    const rightIndex = Math.min(source.length - 1, leftIndex + 1);
    const fraction = position - leftIndex;
    const interpolated = source[leftIndex] + (source[rightIndex] - source[leftIndex]) * fraction;
    output[index] = Math.max(-32768, Math.min(32767, Math.round(interpolated)));
  }
  return output;
};

export const wavToSidekickPcm = (input: Uint8Array): ParsedPcm16MonoWav => {
  const parsed = parsePcm16MonoWav(input);
  return {
    sampleRate: SIDEKICK_AUDIO_SAMPLE_RATE,
    samples: resamplePcm16Mono(parsed.samples, parsed.sampleRate, SIDEKICK_AUDIO_SAMPLE_RATE),
  };
};

export const chunkSidekickPcm = (
  samples: Int16Array,
  maxChunkSamples = SIDEKICK_AUDIO_MAX_CHUNK_SAMPLES,
): SidekickPcmChunk[] => {
  if (!Number.isInteger(maxChunkSamples) || maxChunkSamples < 1 || maxChunkSamples > SIDEKICK_AUDIO_MAX_CHUNK_SAMPLES) {
    throw new Error('sidekick_audio_chunk_size_invalid');
  }
  const chunks: SidekickPcmChunk[] = [];
  for (let offset = 0, sequence = 0; offset < samples.length; offset += maxChunkSamples, sequence += 1) {
    const sampleCount = Math.min(maxChunkSamples, samples.length - offset);
    const pcm = Buffer.allocUnsafe(sampleCount * 2);
    for (let index = 0; index < sampleCount; index += 1) {
      pcm.writeInt16LE(samples[offset + index], index * 2);
    }
    chunks.push({
      chunkSequence: sequence,
      sampleCount,
      pcmBase64: pcm.toString('base64'),
    });
  }
  return chunks;
};
