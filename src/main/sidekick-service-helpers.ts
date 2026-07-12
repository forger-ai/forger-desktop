import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import type { ReadlineParser, SerialPort } from 'serialport';
import type { WebSocket } from 'ws';

import type {
  SidekickBatteryStatus,
  SidekickIdleConfig,
  SidekickMicrophoneRecordingState,
  SidekickMicrophoneRecordingSummary,
  SidekickSpeakerPlaybackState,
  SidekickMutationResult,
  SidekickState,
  SidekickStatus,
  SidekickUsbDevice,
  SidekickTimeStatus,
  SidekickSttLanguageMode,
  SidekickVoiceConfig,
  SidekickWakeBeepState,
} from '../shared/types';
import {
  SIDEKICK_DEFAULT_CONVERSATION_TTL_MINUTES,
  SIDEKICK_DEFAULT_STT_LANGUAGE_SUBSET,
  SIDEKICK_MAX_CONVERSATION_TTL_MINUTES,
  SIDEKICK_MIN_CONVERSATION_TTL_MINUTES,
} from '../shared/types';
export const SIDEKICK_PROTO = 'forger-sidekick-v1';
export const SIDEKICK_SERVICE_TYPE = 'forger-sidekick';
export const SIDEKICK_MDNS_SERVICE = '_forger-sidekick._tcp';
export const SIDEKICK_WS_PATH = '/sidekick';
export const SIDEKICK_BAUD_RATE = 115200;
export const SIDEKICK_HEARTBEAT_TIMEOUT_MS = 35_000;
export const SIDEKICK_OFFLINE_SWEEP_MS = 5_000;
export const SIDEKICK_VISIBLE_NAME_MAX_LENGTH = 40;
export const SIDEKICK_HOSTNAME_MAX_LENGTH = 63;
export const SIDEKICK_HOSTNAME_SUFFIX_LENGTH = 10;
export const SIDEKICK_WS_MAX_PAYLOAD_BYTES = 8 * 1024;
export const SIDEKICK_ACK_TIMEOUT_MS = 4_000;
export const SIDEKICK_MIC_SAMPLE_RATE = 16_000;
export const SIDEKICK_MIC_CHANNELS = 1;
export const SIDEKICK_MIC_FORMAT = 'pcm_s16le';
export const SIDEKICK_MIC_MIME_TYPE = 'audio/wav';
export const SIDEKICK_MIC_MAX_WAV_BYTES = 4 * 1024 * 1024;
export const SIDEKICK_MIC_MAX_CHUNK_BYTES = 4096;
export const SIDEKICK_MIC_RECENT_LIMIT = 20;
export const WAV_HEADER_BYTES = 44;

export interface StoredSidekickFile {
  version: 1;
  desktopId: string;
  records: StoredSidekickRecord[];
}

export interface StoredSidekickRecord {
  sidekickId: string;
  name: string;
  hostname?: string;
  pairedAt: string;
  updatedAt: string;
  firmwareVersion?: string;
  capabilities: string[];
  personalAgentId?: string;
  voiceConfig?: SidekickVoiceConfig;
  desktopKeyFingerprint?: string;
  encryptedPairingSecret: string;
  idleConfig?: SidekickIdleConfig;
  idleImagePreviewDataUrl?: string;
}

export interface SidekickRuntimeState {
  status: SidekickStatus;
  lastSeenAt?: string;
  usbPath?: string;
  ipAddress?: string;
  errorMessage?: string;
  battery?: SidekickBatteryStatus;
  time?: SidekickTimeStatus;
  wakeBeep?: SidekickWakeBeepState;
  microphoneRecording?: ActiveSidekickRecording;
  microphoneErrorMessage?: string;
  microphoneErrorCode?: string;
  speakerPlayback?: ActiveSidekickPlayback;
  speakerErrorMessage?: string;
  speakerErrorCode?: string;
  socket?: WebSocket;
  sessionId?: string;
  txSeq: number;
  rxSeq?: number;
  pendingRecordingAcks: Map<string, PendingRecordingAck>;
  pendingSpeakerAcks: Map<string, PendingSpeakerAck>;
  lastTimeSyncAt?: number;
  lastLimitsPushAt?: number;
}

export interface SidekickNetworkPayload {
  v?: number;
  type?: string;
  sidekickId?: string;
  fw?: string;
  capabilities?: unknown;
  ip?: string;
  battery?: unknown;
  time?: unknown;
  recordingId?: unknown;
  playbackId?: unknown;
  sampleRate?: unknown;
  channels?: unknown;
  format?: unknown;
  data?: unknown;
  sampleCount?: unknown;
  maxChunkSamples?: unknown;
  queueDepth?: unknown;
  maxInFlightChunks?: unknown;
  audioQueueDepth?: unknown;
  playbackProtocolVersion?: unknown;
  lastChunkSequence?: unknown;
  bufferedSamples?: unknown;
  underruns?: unknown;
  droppedChunks?: unknown;
  samplesPlayed?: unknown;
  cancelled?: unknown;
  requestId?: unknown;
  timeZone?: unknown;
  utcOffsetMinutes?: unknown;
  epochMs?: unknown;
  deviceEpochMs?: unknown;
  driftMs?: unknown;
  clockAdjusted?: unknown;
  wakeId?: unknown;
  status?: unknown;
  durationMs?: unknown;
  droppedMessages?: unknown;
  totalDroppedMessages?: unknown;
  maxInFlightMessages?: unknown;
  model?: unknown;
  wakeWord?: unknown;
  wordIndex?: unknown;
  detectedAtMs?: unknown;
  chunkSequence?: unknown;
  code?: unknown;
}

export interface StoredSidekickRecordingFile {
  version: 1;
  recordings: StoredSidekickRecording[];
}

export interface StoredSidekickRecording extends SidekickMicrophoneRecordingSummary {
  filename: string;
}

export interface ActiveSidekickRecording {
  sidekickId: string;
  recordingId: string;
  status: 'starting' | 'recording' | 'stopping';
  startedAt: string;
  bytes: number;
  chunks: number;
  tempPcmPath: string;
  persist: boolean;
  nextChunkSequence: number;
  sampleRate: 16000;
  channels: 1;
  format: 'pcm_s16le';
}

export interface ActiveSidekickPlayback {
  sidekickId: string;
  playbackId: string;
  status: 'starting' | 'playing' | 'stopping' | 'cancelling';
  samplesSent: number;
  samplesPlayed: number;
  bufferedSamples: number;
  underruns: number;
  droppedChunks: number;
  queueDepth: number;
  maxInFlightChunks: number;
}

export interface PendingSpeakerAck {
  key: string;
  timeout: NodeJS.Timeout;
  resolve: () => void;
  reject: (error: Error) => void;
}

export interface PendingRecordingAck {
  recordingId: string;
  kind: 'started' | 'stopped';
  timeout: NodeJS.Timeout;
  resolve: () => void;
  reject: (error: Error) => void;
  promise: Promise<void>;
}

export interface SidekickUsbHello {
  v?: number;
  type?: string;
  transport?: string;
  requestId?: string;
  sidekickId?: string;
  fw?: string;
  capabilities?: unknown;
  paired?: boolean;
}

interface SidekickUsbPairConfigured {
  v?: number;
  type?: string;
  requestId?: string;
  sidekickId?: string;
  hostname?: string;
  paired?: boolean;
}

interface SidekickUsbPairError {
  v?: number;
  type?: string;
  requestId?: string;
  sidekickId?: string;
  code?: unknown;
  error?: unknown;
  message?: unknown;
}

export interface SidekickEncryptedEnvelope {
  v: 1;
  sidekickId: string;
  desktopId: string;
  sessionId: string;
  seq: number;
  nonce: string;
  ciphertext: string;
  tag: string;
}

export const normalizeSidekickUsbDevice = (input: unknown): SidekickUsbDevice | null => {
  if (!input || typeof input !== 'object') {
    return null;
  }
  const candidate = input as {
    path?: unknown;
    manufacturer?: unknown;
    serialNumber?: unknown;
    vendorId?: unknown;
    productId?: unknown;
    friendlyName?: unknown;
    pnpId?: unknown;
  };
  if (typeof candidate.path !== 'string' || !candidate.path.trim()) {
    return null;
  }
  const stringOrUndefined = (value: unknown): string | undefined =>
    typeof value === 'string' && value.trim() ? value.trim() : undefined;
  const vendorId = stringOrUndefined(candidate.vendorId)?.toUpperCase();
  const productId = stringOrUndefined(candidate.productId)?.toUpperCase();
  const portPath = candidate.path.trim();
  const manufacturer = stringOrUndefined(candidate.manufacturer);
  const pnpId = stringOrUndefined(candidate.pnpId);
  const haystack = [portPath, manufacturer, pnpId, vendorId, productId].filter(Boolean).join(' ').toLowerCase();
  const likelySidekick =
    vendorId === '303A' ||
    haystack.includes('esp32') ||
    haystack.includes('wch') ||
    haystack.includes('usbmodem') ||
    haystack.includes('ttyacm') ||
    haystack.includes('ttyusb') ||
    /^com\d+$/i.test(portPath);

  return {
    path: portPath,
    manufacturer,
    serialNumber: stringOrUndefined(candidate.serialNumber),
    vendorId,
    productId,
    friendlyName: stringOrUndefined(candidate.friendlyName),
    likelySidekick,
  };
};

export const sidekickFailureState = (
  base: SidekickState,
  userMessage: string,
  technicalCode: string,
): SidekickMutationResult => ({
  ...base,
  success: false,
  userMessage,
  technicalCode,
});

export const isEncryptedEnvelope = (input: unknown): input is SidekickEncryptedEnvelope => {
  const value = input as Partial<SidekickEncryptedEnvelope> | null;
  return Boolean(
    value &&
    value.v === 1 &&
    typeof value.sidekickId === 'string' &&
    Boolean(value.sidekickId.trim()) &&
    typeof value.desktopId === 'string' &&
    Boolean(value.desktopId.trim()) &&
    typeof value.sessionId === 'string' &&
    Boolean(value.sessionId.trim()) &&
    typeof value.seq === 'number' &&
    typeof value.nonce === 'string' &&
    typeof value.ciphertext === 'string' &&
    typeof value.tag === 'string',
  );
};

export const deriveSidekickKey = (
  pairingSecretBase64: string,
  sidekickId: string,
  desktopId: string,
  sessionId: string,
): Buffer => {
  const secret = Buffer.from(pairingSecretBase64, 'base64');
  const info = Buffer.from(`${sidekickId}${desktopId}${sessionId}`, 'utf8');
  return Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), info, 32));
};

export const encryptSidekickPayload = (
  payload: unknown,
  params: {
    pairingSecretBase64: string;
    sidekickId: string;
    desktopId: string;
    sessionId: string;
    seq: number;
  },
): SidekickEncryptedEnvelope => {
  const nonce = randomBytes(12);
  const key = deriveSidekickKey(params.pairingSecretBase64, params.sidekickId, params.desktopId, params.sessionId);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  return {
    v: 1,
    sidekickId: params.sidekickId,
    desktopId: params.desktopId,
    sessionId: params.sessionId,
    seq: params.seq,
    nonce: nonce.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  };
};

export const decryptSidekickEnvelope = (
  envelope: SidekickEncryptedEnvelope,
  pairingSecretBase64: string,
): unknown => {
  const key = deriveSidekickKey(pairingSecretBase64, envelope.sidekickId, envelope.desktopId, envelope.sessionId);
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.nonce, 'base64'));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8');
  return JSON.parse(plaintext);
};

export const normalizeCapabilities = (input: unknown): string[] => {
  if (!Array.isArray(input)) {
    return [];
  }
  return input.filter((entry): entry is string => typeof entry === 'string' && Boolean(entry.trim())).map((entry) => entry.trim());
};

export const normalizeSidekickBattery = (input: unknown): SidekickBatteryStatus | null => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return null;
  }
  const value = input as { levelPercent?: unknown; charging?: unknown; voltageMv?: unknown };
  if (
    typeof value.levelPercent !== 'number' ||
    !Number.isInteger(value.levelPercent) ||
    value.levelPercent < 0 ||
    value.levelPercent > 100 ||
    typeof value.charging !== 'boolean'
  ) {
    return null;
  }
  const voltageMv =
    typeof value.voltageMv === 'number' &&
    Number.isInteger(value.voltageMv) &&
    value.voltageMv > 0
      ? value.voltageMv
      : undefined;
  return {
    levelPercent: value.levelPercent,
    charging: value.charging,
    voltageMv,
  };
};

export const normalizeSidekickTime = (input: unknown): SidekickTimeStatus | null => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return null;
  }
  const value = input as Record<string, unknown>;
  const epochMs = typeof value.epochMs === 'number' && Number.isSafeInteger(value.epochMs) ? value.epochMs : undefined;
  const offset = typeof value.utcOffsetMinutes === 'number' && Number.isInteger(value.utcOffsetMinutes) &&
    value.utcOffsetMinutes >= -840 && value.utcOffsetMinutes <= 840
    ? value.utcOffsetMinutes
    : undefined;
  const timeZone = typeof value.timeZone === 'string' && /^[A-Za-z0-9_+/-]{1,63}$/.test(value.timeZone)
    ? value.timeZone
    : undefined;
  if (typeof value.synced !== 'boolean' && epochMs === undefined && offset === undefined && !timeZone) {
    return null;
  }
  return {
    synced: value.synced === true,
    ...(epochMs !== undefined ? { epochMs } : {}),
    ...(offset !== undefined ? { utcOffsetMinutes: offset } : {}),
    ...(timeZone ? { timeZone } : {}),
  };
};

export const isNetworkHelloPayload = (input: unknown, sidekickId: string): input is SidekickNetworkPayload => {
  const value = input as SidekickNetworkPayload | null;
  return Boolean(
    value &&
    value.v === 1 &&
    value.type === 'network.hello' &&
    value.sidekickId === sidekickId,
  );
};

export const normalizeVisibleSidekickName = (input: unknown): string | null => {
  if (typeof input !== 'string') {
    return null;
  }
  const normalized = input.trim().replace(/\s+/g, ' ');
  return normalized ? normalized : null;
};

export const buildSidekickHostname = (visibleName: string, sidekickId: string): string => {
  const suffix = createHash('sha256').update(sidekickId).digest('hex').slice(0, SIDEKICK_HOSTNAME_SUFFIX_LENGTH);
  const maxBaseLength = SIDEKICK_HOSTNAME_MAX_LENGTH - suffix.length - 1;
  const asciiBase = visibleName
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  const base = (asciiBase || 'sidekick').slice(0, maxBaseLength).replace(/-+$/g, '') || 'sidekick';
  return `${base}-${suffix}`;
};

export const isStoredSidekickRecord = (input: unknown): input is StoredSidekickRecord => {
  const value = input as Partial<StoredSidekickRecord> | null;
  return Boolean(
    value &&
    typeof value.sidekickId === 'string' &&
    typeof value.name === 'string' &&
    (typeof value.hostname === 'undefined' || typeof value.hostname === 'string') &&
    typeof value.pairedAt === 'string' &&
    typeof value.updatedAt === 'string' &&
    Array.isArray(value.capabilities) &&
    (typeof value.personalAgentId === 'undefined' || typeof value.personalAgentId === 'string') &&
    (typeof value.voiceConfig === 'undefined' || (typeof value.voiceConfig === 'object' && value.voiceConfig !== null)) &&
    typeof value.encryptedPairingSecret === 'string',
  );
};

export const normalizedStoredSidekickVoiceConfig = (value?: Partial<SidekickVoiceConfig>): SidekickVoiceConfig => {
  const model = typeof value?.model === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(value.model.trim())
    ? value.model.trim()
    : undefined;
  const voice = typeof value?.voice === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(value.voice.trim())
    ? value.voice.trim()
    : undefined;
  let locale: string | undefined;
  if (model && voice && typeof value?.locale === 'string') {
    try {
      locale = Intl.getCanonicalLocales(value.locale.trim())[0];
    } catch {
      locale = undefined;
    }
  }
  const ttl = Number(value?.conversationTtlMinutes);
  const sttLanguages = Array.isArray(value?.sttLanguages)
    ? [...new Set(
        value.sttLanguages
          .filter((code): code is string => typeof code === 'string')
          .map((code) => code.trim().toLowerCase())
          .filter((code) => /^[a-z]{2}$/.test(code)),
      )]
    : [];
  const rawMode = value?.sttLanguageMode;
  let sttLanguageMode: SidekickSttLanguageMode = 'subset';
  if (rawMode === 'auto') {
    sttLanguageMode = 'auto';
  } else if (rawMode === 'voice') {
    sttLanguageMode = 'voice';
  } else if (rawMode === 'fixed' && sttLanguages.length >= 1) {
    sttLanguageMode = 'fixed';
  } else if (rawMode === 'subset' && sttLanguages.length >= 2) {
    sttLanguageMode = 'subset';
  }
  return {
    ...(model && voice ? { model, voice } : {}),
    ...(locale ? { locale } : {}),
    sttLanguageMode,
    ...(sttLanguageMode === 'fixed' ? { sttLanguages: [sttLanguages[0]] } : {}),
    ...(sttLanguageMode === 'subset' ? {
      sttLanguages: sttLanguages.length >= 2
        ? sttLanguages
        : [...SIDEKICK_DEFAULT_STT_LANGUAGE_SUBSET],
    } : {}),
    conversationTtlMinutes: Number.isInteger(ttl) &&
      ttl >= SIDEKICK_MIN_CONVERSATION_TTL_MINUTES &&
      ttl <= SIDEKICK_MAX_CONVERSATION_TTL_MINUTES
      ? ttl
      : SIDEKICK_DEFAULT_CONVERSATION_TTL_MINUTES,
  };
};

export const isStoredSidekickRecording = (input: unknown): input is StoredSidekickRecording => {
  const value = input as Partial<StoredSidekickRecording> | null;
  return Boolean(
    value &&
    typeof value.recordingId === 'string' &&
    typeof value.sidekickId === 'string' &&
    typeof value.createdAt === 'string' &&
    typeof value.stoppedAt === 'string' &&
    typeof value.durationMs === 'number' &&
    Number.isInteger(value.durationMs) &&
    value.durationMs >= 0 &&
    typeof value.sampleCount === 'number' &&
    Number.isInteger(value.sampleCount) &&
    value.sampleCount >= 0 &&
    value.sampleRate === SIDEKICK_MIC_SAMPLE_RATE &&
    value.channels === SIDEKICK_MIC_CHANNELS &&
    value.format === SIDEKICK_MIC_FORMAT &&
    typeof value.sizeBytes === 'number' &&
    Number.isInteger(value.sizeBytes) &&
    value.sizeBytes > WAV_HEADER_BYTES &&
    typeof value.filename === 'string' &&
    /^[0-9a-f-]+\.wav$/i.test(value.filename),
  );
};

export const stripRecordingStorageFields = (recording: StoredSidekickRecording): SidekickMicrophoneRecordingSummary => ({
  recordingId: recording.recordingId,
  sidekickId: recording.sidekickId,
  createdAt: recording.createdAt,
  stoppedAt: recording.stoppedAt,
  durationMs: recording.durationMs,
  sampleCount: recording.sampleCount,
  sampleRate: recording.sampleRate,
  channels: recording.channels,
  format: recording.format,
  sizeBytes: recording.sizeBytes,
});

export const summarizeMicrophoneRecording = (runtime?: SidekickRuntimeState): SidekickMicrophoneRecordingState => {
  if (runtime?.microphoneRecording) {
    return {
      status: runtime.microphoneRecording.status,
      recordingId: runtime.microphoneRecording.recordingId,
      startedAt: runtime.microphoneRecording.startedAt,
      bytes: runtime.microphoneRecording.bytes,
    };
  }
  if (runtime?.microphoneErrorMessage || runtime?.microphoneErrorCode) {
    return {
      status: 'error',
      errorMessage: runtime.microphoneErrorMessage,
      technicalCode: runtime.microphoneErrorCode,
    };
  }
  return { status: 'idle' };
};

export const summarizeSpeakerPlayback = (runtime?: SidekickRuntimeState): SidekickSpeakerPlaybackState => {
  if (runtime?.speakerPlayback) {
    return {
      status: runtime.speakerPlayback.status,
      playbackId: runtime.speakerPlayback.playbackId,
      samplesSent: runtime.speakerPlayback.samplesSent,
      samplesPlayed: runtime.speakerPlayback.samplesPlayed,
      bufferedSamples: runtime.speakerPlayback.bufferedSamples,
      underruns: runtime.speakerPlayback.underruns,
    };
  }
  if (runtime?.speakerErrorMessage || runtime?.speakerErrorCode) {
    return {
      status: 'error',
      errorMessage: runtime.speakerErrorMessage,
      technicalCode: runtime.speakerErrorCode,
    };
  }
  return { status: 'idle' };
};

export const recordingAckKey = (kind: PendingRecordingAck['kind'], recordingId: string): string => `${kind}:${recordingId}`;

export const decodeCanonicalBase64Chunk = (value: string): Buffer | null => {
  if (!value || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    return null;
  }
  try {
    const decoded = Buffer.from(value, 'base64');
    if (decoded.length === 0 || decoded.toString('base64') !== value) {
      return null;
    }
    return decoded;
  } catch {
    return null;
  }
};

export const isSafeCode = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-z0-9_.-]{1,64}$/.test(value);

export const buildPcm16MonoWav = (pcm: Buffer, sampleRate: number): Buffer => {
  const header = Buffer.alloc(WAV_HEADER_BYTES);
  const byteRate = sampleRate * 2;
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.byteLength, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.byteLength, 40);
  return Buffer.concat([header, pcm]);
};

export const writeJsonAtomic = async (targetPath: string, value: unknown): Promise<void> => {
  const tmpPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(value, null, 2), 'utf8');
  await fs.rename(tmpPath, targetPath);
};

export const isPathInside = (rootPath: string, targetPath: string): boolean => {
  const relative = path.relative(rootPath, targetPath);
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
};

export const parseJsonLine = (line: string): unknown | null => {
  try {
    return JSON.parse(line.trim());
  } catch {
    return null;
  }
};

export const coerceSerialLine = (line: unknown): string => {
  if (Buffer.isBuffer(line)) {
    return line.toString('utf8');
  }
  return String(line);
};

export const serialRequestIdMetadata = (value: unknown): { requestIdPresent: boolean; requestIdLength: number } => {
  if (typeof value !== 'string') {
    return { requestIdPresent: false, requestIdLength: 0 };
  }
  return { requestIdPresent: true, requestIdLength: value.length };
};

export const summarizeUsbSerialLine = (portPath: string, line: unknown): Record<string, unknown> => {
  const rawLine = coerceSerialLine(line);
  const message = parseJsonLine(rawLine) as Record<string, unknown> | null;
  const requestId = message?.requestId ?? message?.id;
  return {
    path: portPath,
    bytes: Buffer.byteLength(rawLine, 'utf8'),
    messageType: typeof message?.type === 'string' ? message.type : undefined,
    command: typeof message?.cmd === 'string' ? message.cmd : undefined,
    ...serialRequestIdMetadata(requestId),
  };
};

export const summarizeUsbSerialCommand = (portPath: string, command: Record<string, unknown>): Record<string, unknown> => ({
  path: portPath,
  bytes: Buffer.byteLength(`${JSON.stringify(command)}\n`, 'utf8'),
  messageType: typeof command.type === 'string' ? command.type : undefined,
  command: typeof command.cmd === 'string' ? command.cmd : undefined,
  ...serialRequestIdMetadata(command.id ?? command.requestId),
});

export const waitForUsbHello = (
  parser: ReadlineParser,
  requestId: string,
): { promise: Promise<SidekickUsbHello>; cancel: () => void } => {
  let cancel: () => void = () => undefined;
  const promise = new Promise<SidekickUsbHello>((resolve, reject) => {
    let settled = false;
    const onData = (line: string) => {
      const message = parseJsonLine(line) as SidekickUsbHello | null;
      if (
        message?.type === 'hello' &&
        message.transport === 'usb' &&
        message.requestId === requestId &&
        typeof message.sidekickId === 'string'
      ) {
        settle(() => resolve(message));
      }
    };
    const cleanup = () => {
      if (timeout) {
        clearTimeout(timeout);
      }
      parser.off('data', onData);
    };
    const settle = (callback: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      callback();
    };
    const timeout = setTimeout(() => settle(() => reject(new Error('sidekick_usb_hello_timeout'))), 6_000);
    cancel = () => settle(() => reject(new Error('sidekick_usb_hello_cancelled')));
    parser.on('data', onData);
  });
  return { promise, cancel };
};

export const waitForPairConfiguredAck = (
  parser: ReadlineParser,
  expected: { requestId: string; sidekickId: string; hostname: string },
): { promise: Promise<void>; cancel: () => void } => {
  let cancel: () => void = () => undefined;
  const promise = new Promise<void>((resolve, reject) => {
    let settled = false;
    const onData = (line: string) => {
      const message = parseJsonLine(line) as (SidekickUsbPairConfigured & SidekickUsbPairError) | null;
      if (!message || message.requestId !== expected.requestId) {
        return;
      }
      if (typeof message.sidekickId === 'string' && message.sidekickId !== expected.sidekickId) {
        return;
      }
      if (message.type === 'pair.error') {
        settle(() => reject(new Error(normalizePairErrorTechnicalCode(message))));
        return;
      }
      if (
        message.type === 'pair.configured' &&
        message.sidekickId === expected.sidekickId &&
        message.hostname === expected.hostname &&
        message.paired === true
      ) {
        settle(() => resolve());
      }
    };
    const cleanup = () => {
      if (timeout) {
        clearTimeout(timeout);
      }
      parser.off('data', onData);
    };
    const settle = (callback: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      callback();
    };
    const timeout = setTimeout(() => settle(() => reject(new Error('sidekick_usb_pair_configure_timeout'))), 6_000);
    cancel = () => settle(() => reject(new Error('sidekick_usb_pair_configure_cancelled')));
    parser.on('data', onData);
  });
  return { promise, cancel };
};

export const normalizePairErrorTechnicalCode = (message: SidekickUsbPairError): string => {
  const rawCode = [message.code, message.error, message.message].find((value) => typeof value === 'string' && value.trim());
  if (typeof rawCode !== 'string') {
    return 'sidekick_usb_pair_error';
  }
  const normalized = rawCode
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
  return normalized ? `sidekick_usb_pair_error_${normalized}` : 'sidekick_usb_pair_error';
};

export const sidekickConfigureFailureCode = (error: unknown): string => {
  if (error instanceof Error && error.message.startsWith('sidekick_')) {
    return error.message;
  }
  return 'sidekick_usb_configure_failed';
};

export const sidekickConfigureFailureMessage = (technicalCode: string): string => {
  if (technicalCode === 'sidekick_usb_pair_configure_timeout') {
    return 'El Sidekick no confirmó la configuración por USB.';
  }
  if (technicalCode.startsWith('sidekick_usb_pair_error')) {
    return 'El Sidekick rechazó la configuración por USB.';
  }
  return 'No pude configurar el Sidekick por USB. Revisa que esté conectado y que tenga el firmware Sidekick.';
};

export const openSerialPort = async (port: SerialPort): Promise<void> => await new Promise((resolve, reject) => {
  port.open((error) => {
    if (error) {
      reject(error);
      return;
    }
    resolve();
  });
});

export const closeSerialPort = async (port: SerialPort): Promise<void> => {
  if (!port.isOpen) {
    return;
  }
  await new Promise<void>((resolve) => {
    port.close(() => resolve());
  });
};

export const writeSerialLine = async (port: SerialPort, payload: unknown): Promise<void> => await new Promise((resolve, reject) => {
  port.write(`${JSON.stringify(payload)}\n`, (error) => {
    if (error) {
      reject(error);
      return;
    }
    resolve();
  });
});

export const drainSerialPort = async (port: SerialPort): Promise<void> => await new Promise((resolve, reject) => {
  port.drain((error) => {
    if (error) {
      reject(error);
      return;
    }
    resolve();
  });
});
