import { safeStorage } from 'electron';
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import http, { type Server } from 'node:http';
import path from 'node:path';

import Bonjour from 'bonjour-service';
import { SerialPort, ReadlineParser } from 'serialport';
import { WebSocket, WebSocketServer } from 'ws';

import type {
  SidekickBatteryStatus,
  SidekickConfigureInput,
  SidekickDisplayInput,
  SidekickMicrophonePlaybackInput,
  SidekickMicrophonePlaybackResult,
  SidekickMicrophoneRecordingInput,
  SidekickMicrophoneRecordingState,
  SidekickMicrophoneRecordingSummary,
  SidekickMutationResult,
  SidekickState,
  SidekickStatus,
  SidekickSummary,
  SidekickUsbDevice,
} from '../shared/types';

const SIDEKICK_PROTO = 'forger-sidekick-v1';
const SIDEKICK_SERVICE_TYPE = 'forger-sidekick';
const SIDEKICK_MDNS_SERVICE = '_forger-sidekick._tcp';
const SIDEKICK_WS_PATH = '/sidekick';
const SIDEKICK_BAUD_RATE = 115200;
const SIDEKICK_HEARTBEAT_TIMEOUT_MS = 35_000;
const SIDEKICK_OFFLINE_SWEEP_MS = 5_000;
const SIDEKICK_VISIBLE_NAME_MAX_LENGTH = 40;
const SIDEKICK_HOSTNAME_MAX_LENGTH = 63;
const SIDEKICK_HOSTNAME_SUFFIX_LENGTH = 10;
const SIDEKICK_WS_MAX_PAYLOAD_BYTES = 8 * 1024;
const SIDEKICK_ACK_TIMEOUT_MS = 4_000;
const SIDEKICK_MIC_SAMPLE_RATE = 16_000;
const SIDEKICK_MIC_CHANNELS = 1;
const SIDEKICK_MIC_FORMAT = 'pcm_s16le';
const SIDEKICK_MIC_MIME_TYPE = 'audio/wav';
const SIDEKICK_MIC_MAX_WAV_BYTES = 4 * 1024 * 1024;
const SIDEKICK_MIC_MAX_CHUNK_BYTES = 4096;
const SIDEKICK_MIC_RECENT_LIMIT = 20;
const WAV_HEADER_BYTES = 44;

interface StoredSidekickFile {
  version: 1;
  desktopId: string;
  records: StoredSidekickRecord[];
}

interface StoredSidekickRecord {
  sidekickId: string;
  name: string;
  hostname?: string;
  pairedAt: string;
  updatedAt: string;
  firmwareVersion?: string;
  capabilities: string[];
  desktopKeyFingerprint?: string;
  encryptedPairingSecret: string;
}

interface SidekickRuntimeState {
  status: SidekickStatus;
  lastSeenAt?: string;
  usbPath?: string;
  ipAddress?: string;
  errorMessage?: string;
  battery?: SidekickBatteryStatus;
  microphoneRecording?: ActiveSidekickRecording;
  microphoneErrorMessage?: string;
  microphoneErrorCode?: string;
  socket?: WebSocket;
  sessionId?: string;
  txSeq: number;
  rxSeq?: number;
  pendingRecordingAcks: Map<string, PendingRecordingAck>;
}

interface SidekickEncryptedEnvelope {
  v: 1;
  sidekickId: string;
  desktopId: string;
  sessionId: string;
  seq: number;
  nonce: string;
  ciphertext: string;
  tag: string;
}

interface SidekickNetworkPayload {
  v?: number;
  type?: string;
  sidekickId?: string;
  fw?: string;
  capabilities?: unknown;
  ip?: string;
  battery?: unknown;
  recordingId?: unknown;
  sampleRate?: unknown;
  channels?: unknown;
  format?: unknown;
  data?: unknown;
  sampleCount?: unknown;
  code?: unknown;
}

interface StoredSidekickRecordingFile {
  version: 1;
  recordings: StoredSidekickRecording[];
}

interface StoredSidekickRecording extends SidekickMicrophoneRecordingSummary {
  filename: string;
}

interface ActiveSidekickRecording {
  sidekickId: string;
  recordingId: string;
  status: 'starting' | 'recording' | 'stopping';
  startedAt: string;
  bytes: number;
  chunks: number;
  tempPcmPath: string;
  sampleRate: 16000;
  channels: 1;
  format: 'pcm_s16le';
}

interface PendingRecordingAck {
  recordingId: string;
  kind: 'started' | 'stopped';
  timeout: NodeJS.Timeout;
  resolve: () => void;
  reject: (error: Error) => void;
}

interface SidekickUsbHello {
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

export interface SidekickServiceOptions {
  metadataRoot: string;
  getCloudIdentity: () => Promise<{ publicKey: string; keyFingerprint: string }>;
  appendLog?: (event: string, payload?: Record<string, unknown>) => Promise<void>;
  emitState?: (state: SidekickState) => void;
  serialPortClass?: typeof SerialPort;
  safeStorageAdapter?: Pick<typeof safeStorage, 'isEncryptionAvailable' | 'encryptString' | 'decryptString'>;
  bonjourFactory?: () => Bonjour;
  maxRecordingBytes?: number;
  recentRecordingLimit?: number;
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

const sidekickFailureState = (
  base: SidekickState,
  userMessage: string,
  technicalCode: string,
): SidekickMutationResult => ({
  ...base,
  success: false,
  userMessage,
  technicalCode,
});

const isEncryptedEnvelope = (input: unknown): input is SidekickEncryptedEnvelope => {
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

const deriveSidekickKey = (
  pairingSecretBase64: string,
  sidekickId: string,
  desktopId: string,
  sessionId: string,
): Buffer => {
  const secret = Buffer.from(pairingSecretBase64, 'base64');
  const info = Buffer.from(`${sidekickId}${desktopId}${sessionId}`, 'utf8');
  return Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), info, 32));
};

const encryptSidekickPayload = (
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

const decryptSidekickEnvelope = (
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

export class SidekickService {
  private stored: StoredSidekickFile | null = null;
  private desktopId: string | null = null;
  private keyFingerprint: string | null = null;
  private detectedUsb: SidekickUsbDevice[] = [];
  private runtimes = new Map<string, SidekickRuntimeState>();
  private httpServer: Server | null = null;
  private wsServer: WebSocketServer | null = null;
  private bonjour: Bonjour | null = null;
  private bonjourService: { stop: CallableFunction } | null = null;
  private servicePort: number | null = null;
  private offlineTimer: NodeJS.Timeout | null = null;
  private readonly storePath: string;
  private readonly recordingsIndexPath: string;
  private readonly recordingsFilesDir: string;
  private readonly recordingsTmpDir: string;
  private readonly serialPortClass: typeof SerialPort;
  private readonly storage: Pick<typeof safeStorage, 'isEncryptionAvailable' | 'encryptString' | 'decryptString'>;
  private recordingsLoaded = false;
  private recordings: StoredSidekickRecording[] = [];
  private readonly maxRecordingBytes: number;
  private readonly recentRecordingLimit: number;

  constructor(private readonly options: SidekickServiceOptions) {
    this.storePath = path.join(options.metadataRoot, 'sidekicks.json');
    this.recordingsIndexPath = path.join(options.metadataRoot, 'sidekick-recordings', 'index.json');
    this.recordingsFilesDir = path.join(options.metadataRoot, 'sidekick-recordings', 'files');
    this.recordingsTmpDir = path.join(options.metadataRoot, 'sidekick-recordings', 'tmp');
    this.serialPortClass = options.serialPortClass ?? SerialPort;
    this.storage = options.safeStorageAdapter ?? safeStorage;
    this.maxRecordingBytes = options.maxRecordingBytes ?? SIDEKICK_MIC_MAX_WAV_BYTES;
    this.recentRecordingLimit = options.recentRecordingLimit ?? SIDEKICK_MIC_RECENT_LIMIT;
  }

  async getState(): Promise<SidekickState> {
    await this.load();
    await this.loadRecordingsIndex();
    if ((this.stored?.records.length ?? 0) > 0) {
      await this.ensureNetworkService().catch((error: unknown) => {
        void this.log('sidekick:network_service_start_failed', { error: String(error) });
      });
    }
    await this.refreshUsbDevices().catch((error: unknown) => {
      void this.log('sidekick:usb_scan_failed', { error: String(error) });
    });
    return this.buildState();
  }

  async scanUsb(): Promise<SidekickState> {
    await this.load();
    await this.loadRecordingsIndex();
    if ((this.stored?.records.length ?? 0) > 0) {
      await this.ensureNetworkService().catch((error: unknown) => {
        void this.log('sidekick:network_service_start_failed', { error: String(error) });
      });
    }
    await this.refreshUsbDevices();
    this.emit();
    return this.buildState();
  }

  async startIfPaired(): Promise<void> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.storePath, 'utf8')) as StoredSidekickFile;
      if (!parsed?.records?.length) {
        return;
      }
    } catch {
      return;
    }
    await this.load();
    await this.loadRecordingsIndex();
    if ((this.stored?.records.length ?? 0) === 0) {
      return;
    }
    await this.ensureNetworkService();
    this.emit();
  }

  async configureUsb(input: SidekickConfigureInput): Promise<SidekickMutationResult> {
    await this.load();
    await this.loadRecordingsIndex();
    const ssid = input.ssid.trim();
    if (!ssid) {
      return sidekickFailureState(this.buildState(), 'Ingresa el nombre de la red Wi-Fi.', 'sidekick_wifi_ssid_required');
    }
    if (!input.password) {
      return sidekickFailureState(this.buildState(), 'Ingresa la clave de la red Wi-Fi.', 'sidekick_wifi_password_required');
    }
    const visibleName = normalizeVisibleSidekickName(input.name);
    if (!visibleName) {
      return sidekickFailureState(this.buildState(), 'Ingresa un nombre para el Sidekick.', 'sidekick_name_required');
    }
    if (Array.from(visibleName).length > SIDEKICK_VISIBLE_NAME_MAX_LENGTH) {
      return sidekickFailureState(
        this.buildState(),
        `El nombre del Sidekick debe tener ${SIDEKICK_VISIBLE_NAME_MAX_LENGTH} caracteres o menos.`,
        'sidekick_name_too_long',
      );
    }
    if (!this.storage.isEncryptionAvailable()) {
      return sidekickFailureState(
        this.buildState(),
        'Forger no puede guardar el secreto del Sidekick con cifrado local en este equipo.',
        'sidekick_safe_storage_unavailable',
      );
    }

    await this.ensureNetworkService();
    await this.refreshUsbDevices();
    const device = this.selectUsbDevice(input.portPath);
    if (!device) {
      return sidekickFailureState(
        this.buildState(),
        'No encontré un Sidekick conectado por USB.',
        'sidekick_usb_not_found',
      );
    }

    const runtime = this.ensureRuntime(`usb:${device.path}`);
    runtime.status = 'pairing';
    runtime.usbPath = device.path;
    runtime.errorMessage = undefined;
    this.emit();

    try {
      const hello = await this.configureUsbSession(device.path, async (usb) => {
        const initialHello = await usb.readHello();
        if (!initialHello.sidekickId) {
          throw new Error('sidekick_usb_hello_missing_id');
        }
        const pairingSecret = randomBytes(32).toString('base64');
        const desktopId = await this.requireDesktopId();
        const keyFingerprint = await this.requireKeyFingerprint();
        const hostname = buildSidekickHostname(visibleName, initialHello.sidekickId);
        await usb.writeConfigure({
          v: 1,
          id: randomUUID(),
          cmd: 'pair.configure',
          desktopId,
          desktopKeyFingerprint: keyFingerprint,
          name: visibleName,
          hostname,
          ssid,
          password: input.password,
          pairingSecret,
          mdnsService: SIDEKICK_MDNS_SERVICE,
          wsPath: SIDEKICK_WS_PATH,
        }, {
          sidekickId: initialHello.sidekickId,
          hostname,
        });
        await this.upsertRecord({
          sidekickId: initialHello.sidekickId,
          name: visibleName,
          hostname,
          firmwareVersion: initialHello.fw,
          capabilities: normalizeCapabilities(initialHello.capabilities),
          pairingSecret,
          desktopKeyFingerprint: keyFingerprint,
        });
        return initialHello;
      });
      if (!hello.sidekickId) {
        throw new Error('sidekick_usb_hello_missing_id');
      }
      this.runtimes.delete(`usb:${device.path}`);
      const pairedRuntime = this.ensureRuntime(hello.sidekickId);
      pairedRuntime.status = 'wifi_pending';
      pairedRuntime.usbPath = device.path;
      pairedRuntime.errorMessage = undefined;
      await this.save();
      this.emit();
      return { ...this.buildState(), success: true };
    } catch (error) {
      runtime.status = 'error';
      runtime.errorMessage = 'No pude configurar el Sidekick por USB.';
      void this.log('sidekick:configure_usb_failed', {
        path: device.path,
        error: error instanceof Error ? error.message : String(error),
      });
      this.emit();
      const technicalCode = sidekickConfigureFailureCode(error);
      return sidekickFailureState(
        this.buildState(),
        sidekickConfigureFailureMessage(technicalCode),
        technicalCode,
      );
    }
  }

  async sendDisplay(input: SidekickDisplayInput): Promise<SidekickMutationResult> {
    await this.load();
    await this.loadRecordingsIndex();
    const record = this.findRecord(input.sidekickId);
    if (!record) {
      return sidekickFailureState(this.buildState(), 'Ese Sidekick ya no está registrado.', 'sidekick_not_registered');
    }
    const runtime = this.runtimes.get(record.sidekickId);
    if (!runtime?.socket || runtime.socket.readyState !== WebSocket.OPEN || !runtime.sessionId) {
      return sidekickFailureState(this.buildState(), 'El Sidekick está desconectado.', 'sidekick_offline');
    }
    const command = this.buildDisplayCommand(input);
    if (!command) {
      return sidekickFailureState(this.buildState(), 'El texto de prueba está vacío.', 'sidekick_display_text_required');
    }
    try {
      await this.sendEncrypted(record, runtime, command);
      return { ...this.buildState(), success: true };
    } catch (error) {
      runtime.status = 'error';
      runtime.errorMessage = 'No pude enviar el texto al Sidekick.';
      void this.log('sidekick:display_send_failed', {
        sidekickId: record.sidekickId,
        error: error instanceof Error ? error.message : String(error),
      });
      this.emit();
      return sidekickFailureState(this.buildState(), 'No pude enviar el texto al Sidekick.', 'sidekick_display_send_failed');
    }
  }

  async startMicrophoneRecording(input: SidekickMicrophoneRecordingInput): Promise<SidekickMutationResult> {
    await this.load();
    await this.loadRecordingsIndex();
    const record = this.findRecord(input.sidekickId);
    if (!record) {
      return sidekickFailureState(this.buildState(), 'Ese Sidekick ya no está registrado.', 'sidekick_not_registered');
    }
    const runtime = this.runtimes.get(record.sidekickId);
    const online = runtime?.socket?.readyState === WebSocket.OPEN && runtime.sessionId && runtime.status === 'online';
    if (!online) {
      return sidekickFailureState(this.buildState(), 'El Sidekick está desconectado.', 'sidekick_offline');
    }
    if (!record.capabilities.includes('microphone.record')) {
      return sidekickFailureState(
        this.buildState(),
        'Ese Sidekick no informa soporte para grabación de micrófono.',
        'sidekick_microphone_capability_missing',
      );
    }
    if (runtime.microphoneRecording) {
      return sidekickFailureState(
        this.buildState(),
        'Ese Sidekick ya tiene una grabación activa.',
        'sidekick_microphone_recording_active',
      );
    }

    const recordingId = randomUUID();
    await fs.mkdir(this.recordingsTmpDir, { recursive: true });
    runtime.microphoneRecording = {
      sidekickId: record.sidekickId,
      recordingId,
      status: 'starting',
      startedAt: new Date().toISOString(),
      bytes: 0,
      chunks: 0,
      tempPcmPath: this.stagedPcmPath(recordingId),
      sampleRate: SIDEKICK_MIC_SAMPLE_RATE,
      channels: SIDEKICK_MIC_CHANNELS,
      format: SIDEKICK_MIC_FORMAT,
    };
    runtime.microphoneErrorMessage = undefined;
    runtime.microphoneErrorCode = undefined;
    this.emit();

    const waitForStarted = this.waitForRecordingAck(runtime, 'started', recordingId);
    try {
      await this.sendEncrypted(record, runtime, {
        v: 1,
        id: randomUUID(),
        cmd: 'microphone.record.start',
        recordingId,
        sampleRate: SIDEKICK_MIC_SAMPLE_RATE,
        channels: SIDEKICK_MIC_CHANNELS,
        format: SIDEKICK_MIC_FORMAT,
      });
      await waitForStarted;
      return { ...this.buildState(), success: true };
    } catch (error) {
      this.cancelPendingRecordingAck(runtime, 'started', recordingId);
      await this.failActiveRecording(runtime, 'No pude iniciar la prueba de micrófono.', 'sidekick_microphone_start_failed');
      void this.log('sidekick:microphone_start_failed', {
        sidekickId: record.sidekickId,
        error: error instanceof Error ? error.message : String(error),
      });
      return sidekickFailureState(this.buildState(), 'No pude iniciar la prueba de micrófono.', 'sidekick_microphone_start_failed');
    }
  }

  async stopMicrophoneRecording(input: SidekickMicrophoneRecordingInput): Promise<SidekickMutationResult> {
    await this.load();
    await this.loadRecordingsIndex();
    const record = this.findRecord(input.sidekickId);
    if (!record) {
      return sidekickFailureState(this.buildState(), 'Ese Sidekick ya no está registrado.', 'sidekick_not_registered');
    }
    const runtime = this.runtimes.get(record.sidekickId);
    const active = runtime?.microphoneRecording;
    if (!runtime || !active || active.status === 'starting') {
      return sidekickFailureState(this.buildState(), 'Ese Sidekick no tiene una grabación activa.', 'sidekick_microphone_recording_not_active');
    }
    if (!runtime.socket || runtime.socket.readyState !== WebSocket.OPEN || !runtime.sessionId || runtime.status !== 'online') {
      await this.failActiveRecording(runtime, 'El Sidekick se desconectó durante la grabación.', 'sidekick_offline');
      return sidekickFailureState(this.buildState(), 'El Sidekick está desconectado.', 'sidekick_offline');
    }

    active.status = 'stopping';
    runtime.microphoneErrorMessage = undefined;
    runtime.microphoneErrorCode = undefined;
    this.emit();

    const waitForStopped = this.waitForRecordingAck(runtime, 'stopped', active.recordingId);
    try {
      await this.sendEncrypted(record, runtime, {
        v: 1,
        id: randomUUID(),
        cmd: 'microphone.record.stop',
        recordingId: active.recordingId,
      });
      await waitForStopped;
      return { ...this.buildState(), success: true };
    } catch (error) {
      this.cancelPendingRecordingAck(runtime, 'stopped', active.recordingId);
      const technicalCode = error instanceof Error ? error.message : 'sidekick_microphone_stop_failed';
      const sampleCountMismatch = technicalCode === 'sidekick_microphone_sample_count_mismatch';
      if (runtime.microphoneRecording?.recordingId === active.recordingId) {
        runtime.microphoneRecording.status = 'recording';
        runtime.microphoneErrorMessage = sampleCountMismatch
          ? 'La grabación de micrófono quedó incompleta y no se guardó.'
          : 'No pude detener la prueba de micrófono.';
        runtime.microphoneErrorCode = sampleCountMismatch
          ? 'sidekick_microphone_sample_count_mismatch'
          : 'sidekick_microphone_stop_failed';
      }
      void this.log('sidekick:microphone_stop_failed', {
        sidekickId: record.sidekickId,
        error: technicalCode,
      });
      this.emit();
      return sidekickFailureState(
        this.buildState(),
        sampleCountMismatch
          ? 'La grabación de micrófono quedó incompleta y no se guardó.'
          : 'No pude detener la prueba de micrófono.',
        sampleCountMismatch ? technicalCode : 'sidekick_microphone_stop_failed',
      );
    }
  }

  async readMicrophoneRecording(input: SidekickMicrophonePlaybackInput): Promise<SidekickMicrophonePlaybackResult> {
    await this.loadRecordingsIndex();
    const recording = this.recordings.find(
      (entry) => entry.sidekickId === input.sidekickId && entry.recordingId === input.recordingId,
    );
    if (!recording) {
      return {
        success: false,
        userMessage: 'No encontré esa grabación.',
        technicalCode: 'sidekick_microphone_recording_not_found',
      };
    }
    const filePath = path.join(this.recordingsFilesDir, recording.filename);
    if (!isPathInside(this.recordingsFilesDir, filePath)) {
      return {
        success: false,
        userMessage: 'No pude abrir esa grabación.',
        technicalCode: 'sidekick_microphone_recording_invalid_path',
      };
    }
    const stat = await fs.stat(filePath).catch(() => null);
    if (!stat || stat.size > this.maxRecordingBytes || stat.size !== recording.sizeBytes) {
      return {
        success: false,
        userMessage: 'No pude abrir esa grabación.',
        technicalCode: 'sidekick_microphone_recording_size_invalid',
      };
    }
    const bytes = await fs.readFile(filePath);
    return {
      success: true,
      mimeType: SIDEKICK_MIC_MIME_TYPE,
      bytes: new Uint8Array(bytes),
      sizeBytes: bytes.byteLength,
    };
  }

  async forget(sidekickId: string): Promise<SidekickMutationResult> {
    await this.load();
    await this.loadRecordingsIndex();
    const before = this.stored?.records.length ?? 0;
    if (this.stored) {
      this.stored.records = this.stored.records.filter((record) => record.sidekickId !== sidekickId);
    }
    const runtime = this.runtimes.get(sidekickId);
    if (runtime) {
      await this.cleanupActiveRecording(runtime, 'sidekick_forgotten');
    }
    runtime?.socket?.close();
    this.runtimes.delete(sidekickId);
    if (before !== (this.stored?.records.length ?? 0)) {
      const removedRecordings = this.recordings.filter((recording) => recording.sidekickId === sidekickId);
      this.recordings = this.recordings.filter((recording) => recording.sidekickId !== sidekickId);
      await Promise.all(removedRecordings.map(async (recording) => {
        await fs.rm(path.join(this.recordingsFilesDir, recording.filename), { force: true }).catch(() => undefined);
      }));
      await this.saveRecordingsIndex();
      await this.save();
    }
    this.emit();
    return { ...this.buildState(), success: true };
  }

  async dispose(): Promise<void> {
    if (this.offlineTimer) {
      clearInterval(this.offlineTimer);
      this.offlineTimer = null;
    }
    for (const runtime of this.runtimes.values()) {
      await this.cleanupActiveRecording(runtime, 'sidekick_disposed');
      runtime.socket?.close();
    }
    this.wsServer?.close();
    this.wsServer = null;
    if (this.httpServer) {
      await new Promise<void>((resolve) => this.httpServer?.close(() => resolve()));
      this.httpServer = null;
    }
    if (this.bonjourService) {
      await new Promise<void>((resolve) => this.bonjourService?.stop(() => resolve()));
      this.bonjourService = null;
    }
    if (this.bonjour) {
      await new Promise<void>((resolve) => this.bonjour?.destroy(() => resolve()));
      this.bonjour = null;
    }
    this.servicePort = null;
  }

  private async ensureNetworkService(): Promise<void> {
    await this.load();
    await this.requireDesktopId();
    await this.requireKeyFingerprint();
    if (this.httpServer && this.wsServer && this.servicePort) {
      return;
    }
    this.httpServer = http.createServer((_req, res) => {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('forger-sidekick');
    });
    this.wsServer = new WebSocketServer({ server: this.httpServer, path: SIDEKICK_WS_PATH, maxPayload: SIDEKICK_WS_MAX_PAYLOAD_BYTES });
    this.wsServer.on('connection', (socket, request) => {
      const ipAddress = request.socket.remoteAddress;
      let messageQueue = Promise.resolve();
      socket.on('message', (raw) => {
        messageQueue = messageQueue.then(
          async () => await this.handleSocketMessage(socket, raw.toString(), ipAddress),
          async () => await this.handleSocketMessage(socket, raw.toString(), ipAddress),
        ).catch((error: unknown) => {
          void this.log('sidekick:socket_message_failed', { error: String(error) });
          socket.close();
        });
      });
      socket.on('close', () => {
        this.markSocketClosed(socket);
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.httpServer?.once('error', reject);
      this.httpServer?.listen(0, '0.0.0.0', () => {
        this.httpServer?.off('error', reject);
        const address = this.httpServer?.address();
        if (!address || typeof address === 'string') {
          reject(new Error('sidekick_ws_address_unavailable'));
          return;
        }
        this.servicePort = address.port;
        resolve();
      });
    });
    this.publishBonjour();
    this.startOfflineSweep();
  }

  private publishBonjour(): void {
    if (!this.servicePort || !this.desktopId || !this.keyFingerprint) {
      return;
    }
    this.bonjour ??= this.options.bonjourFactory?.() ?? new Bonjour();
    this.bonjourService?.stop();
    this.bonjourService = this.bonjour.publish({
      name: `Forger Sidekick ${this.keyFingerprint.slice(0, 8)} ${this.servicePort}`,
      type: SIDEKICK_SERVICE_TYPE,
      protocol: 'tcp',
      port: this.servicePort,
      txt: {
        desktopId: this.desktopId,
        proto: SIDEKICK_PROTO,
        keyFingerprint: this.keyFingerprint,
        path: SIDEKICK_WS_PATH,
      },
    });
  }

  private async handleSocketMessage(socket: WebSocket, raw: string, ipAddress?: string): Promise<void> {
    const parsed = JSON.parse(raw) as unknown;
    if (!isEncryptedEnvelope(parsed)) {
      throw new Error('sidekick_socket_plaintext_rejected');
    }
    const desktopId = await this.requireDesktopId();
    if (parsed.desktopId !== desktopId) {
      throw new Error('sidekick_desktop_id_mismatch');
    }
    const record = this.findRecord(parsed.sidekickId);
    if (!record) {
      throw new Error('sidekick_not_registered');
    }
    const pairingSecret = this.decryptPairingSecret(record);
    const payload = decryptSidekickEnvelope(parsed, pairingSecret) as SidekickNetworkPayload;
    if (typeof payload.sidekickId === 'string' && payload.sidekickId !== record.sidekickId) {
      throw new Error('sidekick_network_payload_id_mismatch');
    }
    const runtime = this.ensureRuntime(record.sidekickId);
    const activeSession =
      runtime.socket === socket &&
      runtime.sessionId === parsed.sessionId &&
      runtime.status === 'online';
    if (payload.type !== 'network.hello') {
      if (!activeSession) {
        throw new Error('sidekick_network_hello_required');
      }
      if (typeof runtime.rxSeq === 'number' && parsed.seq <= runtime.rxSeq) {
        throw new Error('sidekick_network_sequence_replay');
      }
      runtime.rxSeq = parsed.seq;
      runtime.lastSeenAt = new Date().toISOString();
      runtime.ipAddress = typeof payload.ip === 'string' && payload.ip.trim() ? payload.ip.trim() : runtime.ipAddress ?? ipAddress;
      runtime.errorMessage = undefined;
      await this.handleActiveSessionPayload(runtime, payload);
      this.emit();
      return;
    }
    if (!isNetworkHelloPayload(payload, record.sidekickId)) {
      throw new Error('sidekick_network_hello_invalid');
    }
    runtime.socket = socket;
    runtime.sessionId = parsed.sessionId;
    runtime.rxSeq = parsed.seq;
    runtime.lastSeenAt = new Date().toISOString();
    runtime.status = 'online';
    runtime.ipAddress = typeof payload.ip === 'string' && payload.ip.trim() ? payload.ip.trim() : ipAddress;
    runtime.errorMessage = undefined;
    runtime.battery = normalizeSidekickBattery(payload.battery) ?? runtime.battery;

    record.firmwareVersion = typeof payload.fw === 'string' ? payload.fw : record.firmwareVersion;
    record.capabilities = normalizeCapabilities(payload.capabilities);
    record.updatedAt = new Date().toISOString();
    await this.save();
    this.emit();
  }

  private markSocketClosed(socket: WebSocket): void {
    let changed = false;
    for (const runtime of this.runtimes.values()) {
      if (runtime.socket === socket) {
        if (runtime.microphoneRecording) {
          void this.failActiveRecording(runtime, 'El Sidekick se desconectó durante la prueba de micrófono.', 'sidekick_socket_closed');
        }
        runtime.socket = undefined;
        runtime.status = 'offline';
        changed = true;
      }
    }
    if (changed) {
      this.emit();
    }
  }

  private startOfflineSweep(): void {
    if (this.offlineTimer) {
      return;
    }
    this.offlineTimer = setInterval(() => {
      const now = Date.now();
      let changed = false;
      for (const runtime of this.runtimes.values()) {
        if (runtime.status === 'online' && runtime.lastSeenAt && now - Date.parse(runtime.lastSeenAt) > SIDEKICK_HEARTBEAT_TIMEOUT_MS) {
          if (runtime.microphoneRecording) {
            void this.failActiveRecording(runtime, 'El Sidekick se desconectó durante la prueba de micrófono.', 'sidekick_heartbeat_timeout');
          }
          runtime.status = 'offline';
          runtime.socket = undefined;
          changed = true;
        }
      }
      if (changed) {
        this.emit();
      }
    }, SIDEKICK_OFFLINE_SWEEP_MS);
    this.offlineTimer.unref?.();
  }

  private async sendEncrypted(
    record: StoredSidekickRecord,
    runtime: SidekickRuntimeState,
    payload: unknown,
  ): Promise<void> {
    if (!runtime.socket || !runtime.sessionId) {
      throw new Error('sidekick_socket_unavailable');
    }
    runtime.txSeq += 1;
    const envelope = encryptSidekickPayload(payload, {
      pairingSecretBase64: this.decryptPairingSecret(record),
      sidekickId: record.sidekickId,
      desktopId: await this.requireDesktopId(),
      sessionId: runtime.sessionId,
      seq: runtime.txSeq,
    });
    runtime.socket.send(JSON.stringify(envelope));
  }

  private async handleActiveSessionPayload(runtime: SidekickRuntimeState, payload: SidekickNetworkPayload): Promise<void> {
    const battery = normalizeSidekickBattery(payload.battery);
    if (battery) {
      runtime.battery = battery;
    }
    switch (payload.type) {
      case 'heartbeat':
      case 'network.heartbeat':
      case 'network.status':
      case 'battery.status':
        return;
      case 'microphone.recording.started':
        await this.handleRecordingStarted(runtime, payload);
        return;
      case 'microphone.recording.chunk':
        await this.handleRecordingChunk(runtime, payload);
        return;
      case 'microphone.recording.stopped':
        await this.handleRecordingStopped(runtime, payload);
        return;
      case 'microphone.recording.error':
        await this.handleRecordingError(runtime, payload);
        return;
      default:
        return;
    }
  }

  private async handleRecordingStarted(runtime: SidekickRuntimeState, payload: SidekickNetworkPayload): Promise<void> {
    const active = runtime.microphoneRecording;
    if (
      !active ||
      active.status !== 'starting' ||
      payload.recordingId !== active.recordingId ||
      payload.sampleRate !== SIDEKICK_MIC_SAMPLE_RATE ||
      payload.channels !== SIDEKICK_MIC_CHANNELS ||
      payload.format !== SIDEKICK_MIC_FORMAT
    ) {
      throw new Error('sidekick_microphone_started_invalid');
    }
    active.status = 'recording';
    runtime.microphoneErrorMessage = undefined;
    runtime.microphoneErrorCode = undefined;
    this.resolvePendingRecordingAck(runtime, 'started', active.recordingId);
  }

  private async handleRecordingChunk(runtime: SidekickRuntimeState, payload: SidekickNetworkPayload): Promise<void> {
    const active = runtime.microphoneRecording;
    if (
      !active ||
      (active.status !== 'recording' && active.status !== 'stopping') ||
      payload.recordingId !== active.recordingId
    ) {
      throw new Error('sidekick_microphone_chunk_out_of_session');
    }
    if (typeof payload.data !== 'string') {
      await this.failActiveRecording(runtime, 'El Sidekick envió audio inválido.', 'sidekick_microphone_chunk_invalid');
      throw new Error('sidekick_microphone_chunk_invalid');
    }
    const chunk = decodeCanonicalBase64Chunk(payload.data);
    if (!chunk || chunk.byteLength > SIDEKICK_MIC_MAX_CHUNK_BYTES || chunk.byteLength % 2 !== 0) {
      await this.failActiveRecording(runtime, 'El Sidekick envió audio inválido.', 'sidekick_microphone_chunk_invalid');
      throw new Error('sidekick_microphone_chunk_invalid');
    }
    if (active.bytes + chunk.byteLength + WAV_HEADER_BYTES > this.maxRecordingBytes) {
      await this.failActiveRecording(runtime, 'La prueba de micrófono superó el tamaño máximo.', 'sidekick_microphone_recording_too_large');
      throw new Error('sidekick_microphone_recording_too_large');
    }
    await fs.appendFile(active.tempPcmPath, chunk);
    active.bytes += chunk.byteLength;
    active.chunks += 1;
  }

  private async handleRecordingStopped(runtime: SidekickRuntimeState, payload: SidekickNetworkPayload): Promise<void> {
    const active = runtime.microphoneRecording;
    if (
      !active ||
      (active.status !== 'recording' && active.status !== 'stopping') ||
      payload.recordingId !== active.recordingId ||
      typeof payload.sampleCount !== 'number' ||
      !Number.isInteger(payload.sampleCount) ||
      payload.sampleCount < 0
    ) {
      throw new Error('sidekick_microphone_stopped_invalid');
    }
    const receivedSampleCount = active.bytes / (active.channels * 2);
    if (!Number.isInteger(receivedSampleCount) || receivedSampleCount !== payload.sampleCount) {
      await this.failActiveRecording(
        runtime,
        'La grabación de micrófono quedó incompleta y no se guardó.',
        'sidekick_microphone_sample_count_mismatch',
      );
      return;
    }
    await this.finalizeActiveRecording(active, payload.sampleCount);
    runtime.microphoneRecording = undefined;
    runtime.microphoneErrorMessage = undefined;
    runtime.microphoneErrorCode = undefined;
    this.resolvePendingRecordingAck(runtime, 'stopped', active.recordingId);
  }

  private async handleRecordingError(runtime: SidekickRuntimeState, payload: SidekickNetworkPayload): Promise<void> {
    const active = runtime.microphoneRecording;
    if (!active || payload.recordingId !== active.recordingId || !isSafeCode(payload.code)) {
      throw new Error('sidekick_microphone_error_invalid');
    }
    const code = `sidekick_microphone_${String(payload.code)}`;
    await this.failActiveRecording(runtime, 'El Sidekick informó un error de micrófono.', code);
    this.rejectPendingRecordingAcks(runtime, active.recordingId, new Error(code));
  }

  private waitForRecordingAck(
    runtime: SidekickRuntimeState,
    kind: PendingRecordingAck['kind'],
    recordingId: string,
  ): Promise<void> {
    const key = recordingAckKey(kind, recordingId);
    this.cancelPendingRecordingAck(runtime, kind, recordingId);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        runtime.pendingRecordingAcks.delete(key);
        reject(new Error(`sidekick_microphone_${kind}_timeout`));
      }, SIDEKICK_ACK_TIMEOUT_MS);
      timeout.unref?.();
      runtime.pendingRecordingAcks.set(key, { recordingId, kind, timeout, resolve, reject });
    });
  }

  private resolvePendingRecordingAck(runtime: SidekickRuntimeState, kind: PendingRecordingAck['kind'], recordingId: string): void {
    const key = recordingAckKey(kind, recordingId);
    const pending = runtime.pendingRecordingAcks.get(key);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timeout);
    runtime.pendingRecordingAcks.delete(key);
    pending.resolve();
  }

  private cancelPendingRecordingAck(runtime: SidekickRuntimeState, kind: PendingRecordingAck['kind'], recordingId: string): void {
    const key = recordingAckKey(kind, recordingId);
    const pending = runtime.pendingRecordingAcks.get(key);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timeout);
    runtime.pendingRecordingAcks.delete(key);
  }

  private rejectPendingRecordingAcks(runtime: SidekickRuntimeState, recordingId: string, error: Error): void {
    for (const [key, pending] of runtime.pendingRecordingAcks.entries()) {
      if (pending.recordingId !== recordingId) {
        continue;
      }
      clearTimeout(pending.timeout);
      runtime.pendingRecordingAcks.delete(key);
      pending.reject(error);
    }
  }

  private stagedPcmPath(recordingId: string): string {
    return path.join(this.recordingsTmpDir, `${recordingId}.pcm`);
  }

  private async failActiveRecording(runtime: SidekickRuntimeState, message: string, code: string): Promise<void> {
    const active = runtime.microphoneRecording;
    if (active) {
      await this.cleanupActiveRecording(runtime, code);
      this.rejectPendingRecordingAcks(runtime, active.recordingId, new Error(code));
    }
    runtime.microphoneErrorMessage = message;
    runtime.microphoneErrorCode = code;
    this.emit();
  }

  private async cleanupActiveRecording(runtime: SidekickRuntimeState, code: string): Promise<void> {
    const active = runtime.microphoneRecording;
    if (!active) {
      return;
    }
    runtime.microphoneRecording = undefined;
    this.rejectPendingRecordingAcks(runtime, active.recordingId, new Error(code));
    await fs.rm(active.tempPcmPath, { force: true }).catch(() => undefined);
  }

  private async finalizeActiveRecording(active: ActiveSidekickRecording, sampleCount: number): Promise<void> {
    await this.loadRecordingsIndex();
    await fs.mkdir(this.recordingsFilesDir, { recursive: true });
    const pcm = await fs.readFile(active.tempPcmPath).catch(() => Buffer.alloc(0));
    if (pcm.byteLength !== active.bytes || pcm.byteLength + WAV_HEADER_BYTES > this.maxRecordingBytes) {
      await fs.rm(active.tempPcmPath, { force: true }).catch(() => undefined);
      throw new Error('sidekick_microphone_recording_size_invalid');
    }
    const wav = buildPcm16MonoWav(pcm, SIDEKICK_MIC_SAMPLE_RATE);
    const filename = `${active.recordingId}.wav`;
    const finalPath = path.join(this.recordingsFilesDir, filename);
    const tmpPath = path.join(this.recordingsTmpDir, `${active.recordingId}.wav.tmp`);
    await fs.writeFile(tmpPath, wav);
    await fs.rename(tmpPath, finalPath);
    await fs.rm(active.tempPcmPath, { force: true }).catch(() => undefined);
    const stoppedAt = new Date().toISOString();
    const durationMs = Math.round((sampleCount / SIDEKICK_MIC_SAMPLE_RATE) * 1000);
    this.recordings = [
      {
        recordingId: active.recordingId,
        sidekickId: active.sidekickId,
        createdAt: active.startedAt,
        stoppedAt,
        durationMs,
        sampleCount,
        sampleRate: SIDEKICK_MIC_SAMPLE_RATE,
        channels: SIDEKICK_MIC_CHANNELS,
        format: SIDEKICK_MIC_FORMAT,
        sizeBytes: wav.byteLength,
        filename,
      },
      ...this.recordings.filter((entry) => entry.recordingId !== active.recordingId),
    ];
    await this.pruneRecordings(active.sidekickId);
    await this.saveRecordingsIndex();
  }

  private buildDisplayCommand(input: SidekickDisplayInput): Record<string, unknown> | null {
    const id = randomUUID();
    if (input.mode === 'clear') {
      return { v: 1, id, cmd: 'display.clear' };
    }
    const text = input.text?.trimEnd();
    if (!text) {
      return null;
    }
    return {
      v: 1,
      id,
      cmd: input.mode === 'set' ? 'display.set' : 'display.append',
      text,
    };
  }

  private async configureUsbSession<T>(
    portPath: string,
    callback: (session: {
      readHello: () => Promise<SidekickUsbHello>;
      writeConfigure: (
        command: Record<string, unknown>,
        expected: { sidekickId: string; hostname: string },
      ) => Promise<void>;
    }) => Promise<T>,
  ): Promise<T> {
    const port = new this.serialPortClass({ path: portPath, baudRate: SIDEKICK_BAUD_RATE, autoOpen: false });
    const parser = port.pipe(new ReadlineParser({ delimiter: '\n' }));
    const logReceivedLine = (line: unknown) => {
      void this.log('sidekick:usb_serial_line_received', summarizeUsbSerialLine(portPath, line));
    };
    parser.on('data', logReceivedLine);
    try {
      await openSerialPort(port);
      return await callback({
        readHello: async () => {
          const requestId = randomUUID();
          const waitForHello = waitForUsbHello(parser, requestId);
          try {
            const command = { v: 1, id: requestId, cmd: 'hello.request' };
            await writeSerialLine(port, command);
            void this.log('sidekick:usb_serial_command_sent', summarizeUsbSerialCommand(portPath, command));
            return await waitForHello.promise;
          } catch (error) {
            waitForHello.cancel();
            await waitForHello.promise.catch(() => undefined);
            throw error;
          }
        },
        writeConfigure: async (command, expected) => {
          const requestId = typeof command.id === 'string' ? command.id : null;
          if (!requestId) {
            throw new Error('sidekick_usb_pair_configure_missing_id');
          }
          const waitForAck = waitForPairConfiguredAck(parser, {
            requestId,
            sidekickId: expected.sidekickId,
            hostname: expected.hostname,
          });
          try {
            await writeSerialLine(port, command);
            void this.log('sidekick:usb_serial_command_sent', summarizeUsbSerialCommand(portPath, command));
            await drainSerialPort(port);
            await waitForAck.promise;
          } catch (error) {
            waitForAck.cancel();
            await waitForAck.promise.catch(() => undefined);
            throw error;
          }
        },
      });
    } finally {
      parser.off('data', logReceivedLine);
      await closeSerialPort(port);
    }
  }

  private async refreshUsbDevices(): Promise<void> {
    const list = await this.serialPortClass.list();
    this.detectedUsb = list
      .map((entry) => normalizeSidekickUsbDevice(entry))
      .filter((entry): entry is SidekickUsbDevice => Boolean(entry))
      .sort((left, right) => Number(right.likelySidekick) - Number(left.likelySidekick) || left.path.localeCompare(right.path));
  }

  private selectUsbDevice(requestedPath?: string): SidekickUsbDevice | null {
    if (requestedPath) {
      return this.detectedUsb.find((device) => device.path === requestedPath) ?? null;
    }
    return this.detectedUsb.find((device) => device.likelySidekick) ?? this.detectedUsb[0] ?? null;
  }

  private async load(): Promise<void> {
    if (this.stored) {
      return;
    }
    const identity = await this.options.getCloudIdentity();
    this.desktopId = identity.keyFingerprint;
    this.keyFingerprint = identity.keyFingerprint;
    try {
      const parsed = JSON.parse(await fs.readFile(this.storePath, 'utf8')) as StoredSidekickFile;
      if (parsed?.version === 1 && Array.isArray(parsed.records)) {
        this.stored = {
          version: 1,
          desktopId: typeof parsed.desktopId === 'string' && parsed.desktopId ? parsed.desktopId : this.desktopId,
          records: parsed.records.filter(isStoredSidekickRecord),
        };
        return;
      }
    } catch {
      // Create a fresh store below.
    }
    this.stored = { version: 1, desktopId: this.desktopId, records: [] };
  }

  private async save(): Promise<void> {
    if (!this.stored) {
      return;
    }
    await fs.mkdir(path.dirname(this.storePath), { recursive: true });
    await writeJsonAtomic(this.storePath, this.stored);
  }

  private async loadRecordingsIndex(): Promise<void> {
    if (this.recordingsLoaded) {
      return;
    }
    try {
      const parsed = JSON.parse(await fs.readFile(this.recordingsIndexPath, 'utf8')) as StoredSidekickRecordingFile;
      this.recordings = parsed?.version === 1 && Array.isArray(parsed.recordings)
        ? parsed.recordings.filter(isStoredSidekickRecording)
        : [];
    } catch {
      this.recordings = [];
    }
    this.recordingsLoaded = true;
  }

  private async saveRecordingsIndex(): Promise<void> {
    await fs.mkdir(path.dirname(this.recordingsIndexPath), { recursive: true });
    await writeJsonAtomic(this.recordingsIndexPath, { version: 1, recordings: this.recordings } satisfies StoredSidekickRecordingFile);
  }

  private async pruneRecordings(sidekickId: string): Promise<void> {
    const kept: StoredSidekickRecording[] = [];
    const removed: StoredSidekickRecording[] = [];
    const counts = new Map<string, number>();
    for (const recording of this.recordings.sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))) {
      const count = counts.get(recording.sidekickId) ?? 0;
      if (recording.sidekickId === sidekickId && count >= this.recentRecordingLimit) {
        removed.push(recording);
        continue;
      }
      kept.push(recording);
      counts.set(recording.sidekickId, count + 1);
    }
    this.recordings = kept;
    await Promise.all(removed.map(async (recording) => {
      await fs.rm(path.join(this.recordingsFilesDir, recording.filename), { force: true }).catch(() => undefined);
    }));
  }

  private async upsertRecord(input: {
    sidekickId: string;
    name: string;
    hostname: string;
    firmwareVersion?: string;
    capabilities: string[];
    pairingSecret: string;
    desktopKeyFingerprint: string;
  }): Promise<void> {
    await this.load();
    const encryptedPairingSecret = this.storage.encryptString(input.pairingSecret).toString('base64');
    const now = new Date().toISOString();
    const existing = this.findRecord(input.sidekickId);
    if (existing) {
      existing.name = input.name;
      existing.hostname = input.hostname;
      existing.updatedAt = now;
      existing.firmwareVersion = input.firmwareVersion;
      existing.capabilities = input.capabilities;
      existing.desktopKeyFingerprint = input.desktopKeyFingerprint;
      existing.encryptedPairingSecret = encryptedPairingSecret;
      return;
    }
    this.stored?.records.push({
      sidekickId: input.sidekickId,
      name: input.name,
      hostname: input.hostname,
      pairedAt: now,
      updatedAt: now,
      firmwareVersion: input.firmwareVersion,
      capabilities: input.capabilities,
      desktopKeyFingerprint: input.desktopKeyFingerprint,
      encryptedPairingSecret,
    });
  }

  private decryptPairingSecret(record: StoredSidekickRecord): string {
    return this.storage.decryptString(Buffer.from(record.encryptedPairingSecret, 'base64'));
  }

  private findRecord(sidekickId: string): StoredSidekickRecord | undefined {
    return this.stored?.records.find((record) => record.sidekickId === sidekickId);
  }

  private ensureRuntime(sidekickId: string): SidekickRuntimeState {
    let runtime = this.runtimes.get(sidekickId);
    if (!runtime) {
      runtime = { status: 'offline', txSeq: 0, pendingRecordingAcks: new Map() };
      this.runtimes.set(sidekickId, runtime);
    }
    return runtime;
  }

  private async requireDesktopId(): Promise<string> {
    await this.load();
    if (!this.desktopId) {
      throw new Error('sidekick_desktop_id_unavailable');
    }
    return this.desktopId;
  }

  private async requireKeyFingerprint(): Promise<string> {
    await this.load();
    if (!this.keyFingerprint) {
      throw new Error('sidekick_key_fingerprint_unavailable');
    }
    return this.keyFingerprint;
  }

  private buildState(): SidekickState {
    const records = this.stored?.records ?? [];
    const sidekicks: SidekickSummary[] = records.map((record) => {
      const runtime = this.runtimes.get(record.sidekickId);
      return {
        sidekickId: record.sidekickId,
        name: record.name,
        hostname: record.hostname,
        status: runtime?.status ?? 'offline',
        pairedAt: record.pairedAt,
        lastSeenAt: runtime?.lastSeenAt,
        firmwareVersion: record.firmwareVersion,
        capabilities: record.capabilities,
        battery: runtime?.battery,
        microphoneRecording: summarizeMicrophoneRecording(runtime),
        microphoneRecordings: this.recordings
          .filter((entry) => entry.sidekickId === record.sidekickId)
          .map(stripRecordingStorageFields),
        usbPath: runtime?.usbPath,
        ipAddress: runtime?.ipAddress,
        errorMessage: runtime?.errorMessage,
      };
    });
    const usbOnly = Array.from(this.runtimes.entries())
      .filter(([id]) => id.startsWith('usb:'))
      .map(([id, runtime]): SidekickSummary => ({
        sidekickId: id,
        name: runtime.usbPath ?? 'Sidekick USB',
        status: runtime.status,
        usbPath: runtime.usbPath,
        capabilities: [],
        microphoneRecording: summarizeMicrophoneRecording(runtime),
        microphoneRecordings: [],
        errorMessage: runtime.errorMessage,
      }));
    return {
      desktopId: this.desktopId ?? '',
      keyFingerprint: this.keyFingerprint ?? undefined,
      servicePort: this.servicePort ?? undefined,
      sidekicks: [...sidekicks, ...usbOnly],
      detectedUsb: this.detectedUsb,
    };
  }

  private emit(): void {
    this.options.emitState?.(this.buildState());
  }

  private async log(event: string, payload: Record<string, unknown> = {}): Promise<void> {
    await this.options.appendLog?.(event, payload);
  }
}

const normalizeCapabilities = (input: unknown): string[] => {
  if (!Array.isArray(input)) {
    return [];
  }
  return input.filter((entry): entry is string => typeof entry === 'string' && Boolean(entry.trim())).map((entry) => entry.trim());
};

const normalizeSidekickBattery = (input: unknown): SidekickBatteryStatus | null => {
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

const isNetworkHelloPayload = (input: unknown, sidekickId: string): input is SidekickNetworkPayload => {
  const value = input as SidekickNetworkPayload | null;
  return Boolean(
    value &&
    value.v === 1 &&
    value.type === 'network.hello' &&
    value.sidekickId === sidekickId,
  );
};

const normalizeVisibleSidekickName = (input: unknown): string | null => {
  if (typeof input !== 'string') {
    return null;
  }
  const normalized = input.trim().replace(/\s+/g, ' ');
  return normalized ? normalized : null;
};

const buildSidekickHostname = (visibleName: string, sidekickId: string): string => {
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

const isStoredSidekickRecord = (input: unknown): input is StoredSidekickRecord => {
  const value = input as Partial<StoredSidekickRecord> | null;
  return Boolean(
    value &&
    typeof value.sidekickId === 'string' &&
    typeof value.name === 'string' &&
    (typeof value.hostname === 'undefined' || typeof value.hostname === 'string') &&
    typeof value.pairedAt === 'string' &&
    typeof value.updatedAt === 'string' &&
    Array.isArray(value.capabilities) &&
    typeof value.encryptedPairingSecret === 'string',
  );
};

const isStoredSidekickRecording = (input: unknown): input is StoredSidekickRecording => {
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

const stripRecordingStorageFields = (recording: StoredSidekickRecording): SidekickMicrophoneRecordingSummary => ({
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

const summarizeMicrophoneRecording = (runtime?: SidekickRuntimeState): SidekickMicrophoneRecordingState => {
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

const recordingAckKey = (kind: PendingRecordingAck['kind'], recordingId: string): string => `${kind}:${recordingId}`;

const decodeCanonicalBase64Chunk = (value: string): Buffer | null => {
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

const isSafeCode = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-z0-9_.-]{1,64}$/.test(value);

const buildPcm16MonoWav = (pcm: Buffer, sampleRate: number): Buffer => {
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

const writeJsonAtomic = async (targetPath: string, value: unknown): Promise<void> => {
  const tmpPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(value, null, 2), 'utf8');
  await fs.rename(tmpPath, targetPath);
};

const isPathInside = (rootPath: string, targetPath: string): boolean => {
  const relative = path.relative(rootPath, targetPath);
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
};

const parseJsonLine = (line: string): unknown | null => {
  try {
    return JSON.parse(line.trim());
  } catch {
    return null;
  }
};

const coerceSerialLine = (line: unknown): string => {
  if (Buffer.isBuffer(line)) {
    return line.toString('utf8');
  }
  return String(line);
};

const serialRequestIdMetadata = (value: unknown): { requestIdPresent: boolean; requestIdLength: number } => {
  if (typeof value !== 'string') {
    return { requestIdPresent: false, requestIdLength: 0 };
  }
  return { requestIdPresent: true, requestIdLength: value.length };
};

const summarizeUsbSerialLine = (portPath: string, line: unknown): Record<string, unknown> => {
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

const summarizeUsbSerialCommand = (portPath: string, command: Record<string, unknown>): Record<string, unknown> => ({
  path: portPath,
  bytes: Buffer.byteLength(`${JSON.stringify(command)}\n`, 'utf8'),
  messageType: typeof command.type === 'string' ? command.type : undefined,
  command: typeof command.cmd === 'string' ? command.cmd : undefined,
  ...serialRequestIdMetadata(command.id ?? command.requestId),
});

const waitForUsbHello = (
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

const waitForPairConfiguredAck = (
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

const normalizePairErrorTechnicalCode = (message: SidekickUsbPairError): string => {
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

const sidekickConfigureFailureCode = (error: unknown): string => {
  if (error instanceof Error && error.message.startsWith('sidekick_')) {
    return error.message;
  }
  return 'sidekick_usb_configure_failed';
};

const sidekickConfigureFailureMessage = (technicalCode: string): string => {
  if (technicalCode === 'sidekick_usb_pair_configure_timeout') {
    return 'El Sidekick no confirmó la configuración por USB.';
  }
  if (technicalCode.startsWith('sidekick_usb_pair_error')) {
    return 'El Sidekick rechazó la configuración por USB.';
  }
  return 'No pude configurar el Sidekick por USB. Revisa que esté conectado y que tenga el firmware Sidekick.';
};

const openSerialPort = async (port: SerialPort): Promise<void> => await new Promise((resolve, reject) => {
  port.open((error) => {
    if (error) {
      reject(error);
      return;
    }
    resolve();
  });
});

const closeSerialPort = async (port: SerialPort): Promise<void> => {
  if (!port.isOpen) {
    return;
  }
  await new Promise<void>((resolve) => {
    port.close(() => resolve());
  });
};

const writeSerialLine = async (port: SerialPort, payload: unknown): Promise<void> => await new Promise((resolve, reject) => {
  port.write(`${JSON.stringify(payload)}\n`, (error) => {
    if (error) {
      reject(error);
      return;
    }
    resolve();
  });
});

const drainSerialPort = async (port: SerialPort): Promise<void> => await new Promise((resolve, reject) => {
  port.drain((error) => {
    if (error) {
      reject(error);
      return;
    }
    resolve();
  });
});

export const __testSidekickInternals = {
  buildSidekickHostname,
  decryptSidekickEnvelope,
  deriveSidekickKey,
  encryptSidekickPayload,
  normalizeCapabilities,
  normalizeVisibleSidekickName,
};
