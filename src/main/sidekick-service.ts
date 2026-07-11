import { safeStorage } from 'electron';
import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import http, { type Server } from 'node:http';
import path from 'node:path';

import Bonjour from 'bonjour-service';
import { SerialPort, ReadlineParser } from 'serialport';
import { WebSocket, WebSocketServer } from 'ws';

import type {
  SidekickConfigureInput,
  SidekickDisplayInput,
  SidekickMicrophonePlaybackInput,
  SidekickMicrophonePlaybackResult,
  SidekickMicrophoneRecordingInput,
  SidekickMutationResult,
  SidekickPersonalAgentInput,
  SidekickScreenInput,
  SidekickSpeakInput,
  SidekickSpeakerPcmInput,
  SidekickSpeakerPlaybackResult,
  SidekickState,
  SidekickSummary,
  SidekickUsbDevice,
  SidekickWakeEvent,
} from '../shared/types';
import {
  SIDEKICK_ACK_TIMEOUT_MS,
  SIDEKICK_BAUD_RATE,
  SIDEKICK_HEARTBEAT_TIMEOUT_MS,
  SIDEKICK_MDNS_SERVICE,
  SIDEKICK_MIC_CHANNELS,
  SIDEKICK_MIC_FORMAT,
  SIDEKICK_MIC_MAX_CHUNK_BYTES,
  SIDEKICK_MIC_MAX_WAV_BYTES,
  SIDEKICK_MIC_MIME_TYPE,
  SIDEKICK_MIC_RECENT_LIMIT,
  SIDEKICK_MIC_SAMPLE_RATE,
  SIDEKICK_OFFLINE_SWEEP_MS,
  SIDEKICK_PROTO,
  SIDEKICK_SERVICE_TYPE,
  SIDEKICK_VISIBLE_NAME_MAX_LENGTH,
  SIDEKICK_WS_MAX_PAYLOAD_BYTES,
  SIDEKICK_WS_PATH,
  WAV_HEADER_BYTES,
  buildPcm16MonoWav,
  buildSidekickHostname,
  closeSerialPort,
  decodeCanonicalBase64Chunk,
  decryptSidekickEnvelope,
  deriveSidekickKey,
  drainSerialPort,
  encryptSidekickPayload,
  isEncryptedEnvelope,
  isNetworkHelloPayload,
  isPathInside,
  isSafeCode,
  isStoredSidekickRecord,
  isStoredSidekickRecording,
  normalizeCapabilities,
  normalizeSidekickBattery,
  normalizeSidekickTime,
  normalizeSidekickUsbDevice,
  normalizeVisibleSidekickName,
  openSerialPort,
  recordingAckKey,
  sidekickConfigureFailureCode,
  sidekickConfigureFailureMessage,
  sidekickFailureState,
  stripRecordingStorageFields,
  summarizeMicrophoneRecording,
  summarizeSpeakerPlayback,
  summarizeUsbSerialCommand,
  summarizeUsbSerialLine,
  waitForPairConfiguredAck,
  waitForUsbHello,
  writeJsonAtomic,
  writeSerialLine,
} from './sidekick-service-helpers';
import { chunkSidekickPcm, wavToSidekickPcm } from './sidekick-audio-codec';
import type {
  ActiveSidekickRecording,
  ActiveSidekickPlayback,
  PendingRecordingAck,
  SidekickNetworkPayload,
  SidekickRuntimeState,
  SidekickUsbHello,
  StoredSidekickFile,
  StoredSidekickRecord,
  StoredSidekickRecording,
  StoredSidekickRecordingFile,
} from './sidekick-service-helpers';
import { parseSidekickTimeReceipt, parseSidekickWakeReceipt, SidekickSpeakerReceipts } from './sidekick-network-receipts';

export { normalizeSidekickUsbDevice } from './sidekick-service-helpers';

const SIDEKICK_TIME_RESYNC_MS = 15 * 60 * 1000;

const localTimeSync = (): { epochMs: number; timeZone: string; utcOffsetMinutes: number } => {
  const now = new Date();
  return {
    epochMs: now.getTime(),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    utcOffsetMinutes: -now.getTimezoneOffset(),
  };
};

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
  getTimeSync?: () => { epochMs: number; timeZone: string; utcOffsetMinutes: number };
  synthesizeSpeech?: (input: { text: string; model: string; voice: string; speed?: number; format: 'wav' }) => Promise<{
    success: boolean;
    audioDataBase64?: string;
    userMessage?: string;
    technicalCode?: string;
  }>;
  onWakeDetected?: (event: SidekickWakeEvent) => void | Promise<void>;
  onMicrophonePcm?: (event: {
    sidekickId: string;
    recordingId: string;
    chunkSequence: number;
    pcm: Uint8Array;
  }) => void | Promise<void>;
}

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
  private readonly speakerReceipts = new SidekickSpeakerReceipts();

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

  async setPersonalAgent(input: SidekickPersonalAgentInput): Promise<SidekickMutationResult> {
    await this.load();
    const record = this.findRecord(input.sidekickId);
    if (!record) return sidekickFailureState(this.buildState(), 'Ese Sidekick ya no está registrado.', 'sidekick_not_registered');
    const personalAgentId = input.personalAgentId?.trim();
    if (personalAgentId && !/^[A-Za-z0-9_-]{1,64}$/.test(personalAgentId)) {
      return sidekickFailureState(this.buildState(), 'El agente personal no es válido.', 'sidekick_personal_agent_id_invalid');
    }
    record.personalAgentId = personalAgentId || undefined;
    record.updatedAt = new Date().toISOString();
    await this.save();
    this.emit();
    return { ...this.buildState(), success: true };
  }

  async sendScreen(input: SidekickScreenInput): Promise<SidekickMutationResult> {
    await this.load();
    await this.loadRecordingsIndex();
    const record = this.findRecord(input.sidekickId);
    if (!record) {
      return sidekickFailureState(this.buildState(), 'Ese Sidekick ya no está registrado.', 'sidekick_not_registered');
    }
    const runtime = this.runtimes.get(record.sidekickId);
    if (!runtime?.socket || runtime.socket.readyState !== WebSocket.OPEN || !runtime.sessionId || runtime.status !== 'online') {
      return sidekickFailureState(this.buildState(), 'El Sidekick está desconectado.', 'sidekick_offline');
    }
    if (!record.capabilities.includes('display.screens')) {
      return sidekickFailureState(this.buildState(), 'Ese Sidekick no admite pantallas visuales.', 'sidekick_screen_capability_missing');
    }
    const title = input.title?.trim();
    const body = input.body?.trim();
    const text = input.text?.trimEnd();
    if ((title?.length ?? 0) > 96 || (body?.length ?? 0) > 512 || (text?.length ?? 0) > 4000) {
      return sidekickFailureState(this.buildState(), 'El contenido de la pantalla es demasiado largo.', 'sidekick_screen_content_too_long');
    }
    if (input.template === 'state' && !['listening', 'thinking', 'speaking', 'sleeping', 'error'].includes(input.icon ?? '')) {
      return sidekickFailureState(this.buildState(), 'El estado visual no es válido.', 'sidekick_screen_icon_invalid');
    }
    try {
      await this.sendEncrypted(record, runtime, {
        v: 1,
        id: randomUUID(),
        cmd: 'screen.set',
        template: input.template,
        ...(input.icon ? { icon: input.icon } : {}),
        ...(title ? { title } : {}),
        ...(body ? { body } : {}),
        ...(typeof text === 'string' ? { text } : {}),
      });
      return { ...this.buildState(), success: true };
    } catch (error) {
      void this.log('sidekick:screen_send_failed', {
        sidekickId: record.sidekickId,
        error: error instanceof Error ? error.message : String(error),
      });
      return sidekickFailureState(this.buildState(), 'No pude actualizar la pantalla.', 'sidekick_screen_send_failed');
    }
  }

  async speak(input: SidekickSpeakInput): Promise<SidekickSpeakerPlaybackResult> {
    const text = typeof input.text === 'string' ? input.text.trim() : '';
    const model = typeof input.model === 'string' ? input.model.trim() : '';
    const voice = typeof input.voice === 'string' ? input.voice.trim() : '';
    if (!text || !model || !voice) {
      return { success: false, userMessage: 'Elige una voz y escribe qué debe decir.', technicalCode: 'sidekick_speech_input_required' };
    }
    if (!this.options.synthesizeSpeech) {
      return { success: false, userMessage: 'La voz de Forger no está disponible.', technicalCode: 'sidekick_tts_unavailable' };
    }
    await this.sendScreen({ sidekickId: input.sidekickId, template: 'state', icon: 'speaking' }).catch(() => undefined);
    try {
      const synthesized = await this.options.synthesizeSpeech({
        text,
        model,
        voice,
        speed: input.speed,
        format: 'wav',
      });
      if (!synthesized.success || !synthesized.audioDataBase64) {
        return {
          success: false,
          userMessage: synthesized.userMessage ?? 'No pude preparar la voz.',
          technicalCode: synthesized.technicalCode ?? 'sidekick_tts_failed',
        };
      }
      const wav = Buffer.from(synthesized.audioDataBase64, 'base64');
      const pcm = wavToSidekickPcm(wav);
      return await this.playSpeakerPcm({ sidekickId: input.sidekickId, samples: pcm.samples });
    } catch (error) {
      return {
        success: false,
        userMessage: 'No pude preparar la voz para el Sidekick.',
        technicalCode: error instanceof Error ? error.message : 'sidekick_tts_failed',
      };
    } finally {
      await this.sendScreen({ sidekickId: input.sidekickId, template: 'idle' }).catch(() => undefined);
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
    if (runtime.speakerPlayback) {
      return sidekickFailureState(this.buildState(), 'Espera a que termine el audio antes de usar el micrófono.', 'sidekick_audio_busy');
    }

    const recordingId = randomUUID();
    const persist = input.transient !== true;
    if (persist) {
      await fs.mkdir(this.recordingsTmpDir, { recursive: true });
    }
    runtime.microphoneRecording = {
      sidekickId: record.sidekickId,
      recordingId,
      status: 'starting',
      startedAt: new Date().toISOString(),
      bytes: 0,
      chunks: 0,
      tempPcmPath: persist ? this.stagedPcmPath(recordingId) : '',
      persist,
      nextChunkSequence: 0,
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

  async syncTime(sidekickId: string): Promise<void> {
    await this.load();
    const record = this.findRecord(sidekickId);
    const runtime = this.runtimes.get(sidekickId);
    if (!record || !runtime?.socket || runtime.socket.readyState !== WebSocket.OPEN || !runtime.sessionId || runtime.status !== 'online') {
      throw new Error('sidekick_offline');
    }
    if (!record.capabilities.includes('system.time.sync')) {
      return;
    }
    const value = this.options.getTimeSync?.() ?? localTimeSync();
    if (
      !Number.isSafeInteger(value.epochMs) ||
      !Number.isInteger(value.utcOffsetMinutes) ||
      value.utcOffsetMinutes < -840 ||
      value.utcOffsetMinutes > 840 ||
      !/^[A-Za-z0-9_+/-]{1,63}$/.test(value.timeZone)
    ) {
      throw new Error('sidekick_time_sync_invalid');
    }
    await this.sendEncrypted(record, runtime, {
      v: 1,
      id: randomUUID(),
      cmd: 'system.time.sync',
      epochMs: value.epochMs,
      timeZone: value.timeZone,
      utcOffsetMinutes: value.utcOffsetMinutes,
    });
    runtime.lastTimeSyncAt = Date.now();
  }

  async playSpeakerPcm(input: SidekickSpeakerPcmInput): Promise<SidekickSpeakerPlaybackResult> {
    await this.load();
    const record = this.findRecord(input.sidekickId);
    if (!record) {
      return { success: false, userMessage: 'Ese Sidekick ya no está registrado.', technicalCode: 'sidekick_not_registered' };
    }
    const runtime = this.runtimes.get(record.sidekickId);
    if (!runtime?.socket || runtime.socket.readyState !== WebSocket.OPEN || !runtime.sessionId || runtime.status !== 'online') {
      return { success: false, userMessage: 'El Sidekick está desconectado.', technicalCode: 'sidekick_offline' };
    }
    if (!record.capabilities.includes('speaker.playback')) {
      return { success: false, userMessage: 'Ese Sidekick no tiene reproducción de audio.', technicalCode: 'sidekick_speaker_capability_missing' };
    }
    if (!(input.samples instanceof Int16Array) || input.samples.length === 0) {
      return { success: false, userMessage: 'El audio está vacío.', technicalCode: 'sidekick_speaker_audio_required' };
    }
    if (runtime.microphoneRecording) {
      return { success: false, userMessage: 'Detén el micrófono antes de reproducir audio.', technicalCode: 'sidekick_audio_busy' };
    }
    if (runtime.speakerPlayback) {
      return { success: false, userMessage: 'El Sidekick ya está reproduciendo audio.', technicalCode: 'sidekick_speaker_playback_active' };
    }

    const playbackId = randomUUID();
    const active: ActiveSidekickPlayback = {
      sidekickId: record.sidekickId,
      playbackId,
      status: 'starting',
      samplesSent: 0,
      samplesPlayed: 0,
      bufferedSamples: 0,
      underruns: 0,
      droppedChunks: 0,
      queueDepth: 1,
    };
    runtime.speakerPlayback = active;
    runtime.speakerErrorMessage = undefined;
    runtime.speakerErrorCode = undefined;
    this.emit();

    try {
      const started = this.speakerReceipts.wait(runtime, `started:${playbackId}`);
      await this.sendEncrypted(record, runtime, {
        v: 1,
        id: randomUUID(),
        cmd: 'speaker.play.start',
        playbackId,
        sampleRate: 16_000,
        channels: 1,
        format: 'pcm_s16le',
      });
      await started;

      // Ventana deslizante: hasta `window` chunks en vuelo (la cola del
      // firmware admite queueDepth; se deja margen para no gatillar
      // playback_backpressure). Con lockstep estricto el round trip completo
      // tenia que caber en los 64 ms de un chunk y cualquier jitter cortaba
      // el audio; con la ventana el Sidekick acumula ~380 ms de colchon.
      const window = Math.min(6, Math.max(1, active.queueDepth - 2));
      const pending: Array<Promise<void>> = [];
      for (const chunk of chunkSidekickPcm(input.samples)) {
        while (pending.length >= window) {
          await pending.shift();
        }
        const progressed = this.speakerReceipts.wait(runtime, `progress:${playbackId}:${chunk.chunkSequence}`);
        // Un fallo rechaza todos los acks pendientes a la vez; el catch vacio
        // evita unhandledRejection en los que aun no llegan a su await (el
        // await posterior sobre la promesa original sigue rechazando).
        progressed.catch(() => undefined);
        pending.push(progressed);
        await this.sendEncrypted(record, runtime, {
          v: 1,
          id: randomUUID(),
          cmd: 'speaker.play.chunk',
          playbackId,
          chunkSequence: chunk.chunkSequence,
          sampleCount: chunk.sampleCount,
          pcmBase64: chunk.pcmBase64,
        });
        active.samplesSent += chunk.sampleCount;
        this.emit();
      }
      while (pending.length > 0) {
        await pending.shift();
      }

      active.status = 'stopping';
      const stopped = this.speakerReceipts.wait(runtime, `stopped:${playbackId}`);
      await this.sendEncrypted(record, runtime, {
        v: 1,
        id: randomUUID(),
        cmd: 'speaker.play.stop',
        playbackId,
      });
      this.emit();
      await stopped;
      const result: SidekickSpeakerPlaybackResult = {
        success: true,
        playbackId,
        samplesPlayed: active.samplesPlayed,
        underruns: active.underruns,
        droppedChunks: active.droppedChunks,
      };
      runtime.speakerPlayback = undefined;
      this.emit();
      return result;
    } catch (error) {
      await this.log('sidekick:speaker_playback_failed', {
        sidekickId: record.sidekickId,
        playbackId,
        error: error instanceof Error ? error.message : String(error),
        samplesSent: active.samplesSent,
        samplesPlayed: active.samplesPlayed,
        bufferedSamples: active.bufferedSamples,
        underruns: active.underruns,
        droppedChunks: active.droppedChunks,
        pendingAcks: [...runtime.pendingSpeakerAcks.keys()],
      });
      this.speakerReceipts.reject(runtime, new Error('sidekick_speaker_playback_failed'));
      if (runtime.socket?.readyState === WebSocket.OPEN && runtime.sessionId) {
        active.status = 'cancelling';
        const stopped = this.speakerReceipts.wait(runtime, `stopped:${playbackId}`);
        void stopped.catch(() => undefined);
        await this.sendEncrypted(record, runtime, {
            v: 1,
            id: randomUUID(),
            cmd: 'speaker.play.cancel',
            playbackId,
          })
          .then(async () => await stopped)
          .catch(() => undefined);
      }
      runtime.speakerPlayback = undefined;
      runtime.speakerErrorMessage = 'No pude reproducir el audio en el Sidekick.';
      runtime.speakerErrorCode = error instanceof Error ? error.message : 'sidekick_speaker_playback_failed';
      this.emit();
      return {
        success: false,
        playbackId,
        userMessage: runtime.speakerErrorMessage,
        technicalCode: runtime.speakerErrorCode,
      };
    }
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
      this.speakerReceipts.reject(runtime, new Error('sidekick_forgotten'));
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
      this.speakerReceipts.reject(runtime, new Error('sidekick_disposed'));
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
    const supersededSocket = runtime.socket !== socket ? runtime.socket : undefined;
    runtime.socket = socket;
    runtime.sessionId = parsed.sessionId;
    runtime.rxSeq = parsed.seq;
    runtime.lastSeenAt = new Date().toISOString();
    runtime.status = 'online';
    runtime.ipAddress = typeof payload.ip === 'string' && payload.ip.trim() ? payload.ip.trim() : ipAddress;
    runtime.errorMessage = undefined;
    runtime.battery = normalizeSidekickBattery(payload.battery) ?? runtime.battery;
    // Un Sidekick solo puede tener una sesion activa. Tras un reset USB/TCP la
    // conexion anterior puede quedar ESTABLISHED hasta el keepalive; cerrarla
    // evita recibos y comandos de dos sesiones para el mismo dispositivo.
    supersededSocket?.close(1000, 'sidekick_session_superseded');

    record.firmwareVersion = typeof payload.fw === 'string' ? payload.fw : record.firmwareVersion;
    record.capabilities = normalizeCapabilities(payload.capabilities);
    record.updatedAt = new Date().toISOString();
    await this.save();
    await this.syncTime(record.sidekickId).catch((error: unknown) => {
      void this.log('sidekick:time_sync_failed', {
        sidekickId: record.sidekickId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
    this.emit();
  }

  private markSocketClosed(socket: WebSocket): void {
    let changed = false;
    for (const runtime of this.runtimes.values()) {
      if (runtime.socket === socket) {
        if (runtime.microphoneRecording) {
          void this.failActiveRecording(runtime, 'El Sidekick se desconectó durante la prueba de micrófono.', 'sidekick_socket_closed');
        }
        if (runtime.speakerPlayback) {
          this.speakerReceipts.reject(runtime, new Error('sidekick_socket_closed'));
          runtime.speakerPlayback = undefined;
          runtime.speakerErrorMessage = 'El Sidekick se desconectó durante la reproducción.';
          runtime.speakerErrorCode = 'sidekick_socket_closed';
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
          if (runtime.speakerPlayback) {
            this.speakerReceipts.reject(runtime, new Error('sidekick_heartbeat_timeout'));
            runtime.speakerPlayback = undefined;
            runtime.speakerErrorMessage = 'El Sidekick se desconectó durante la reproducción.';
            runtime.speakerErrorCode = 'sidekick_heartbeat_timeout';
          }
          changed = true;
        } else if (
          runtime.status === 'online' &&
          (!runtime.lastTimeSyncAt || now - runtime.lastTimeSyncAt >= SIDEKICK_TIME_RESYNC_MS)
        ) {
          const sidekickId = Array.from(this.runtimes.entries()).find(([, candidate]) => candidate === runtime)?.[0];
          if (sidekickId && !sidekickId.startsWith('usb:')) {
            void this.syncTime(sidekickId).catch(() => undefined);
          }
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
    const clock = normalizeSidekickTime(payload.time);
    if (clock) {
      runtime.time = { ...runtime.time, ...clock };
    }
    switch (payload.type) {
      case 'heartbeat':
      case 'network.heartbeat':
      case 'network.status':
      case 'battery.status':
        return;
      case 'system.time.synced':
        runtime.time = parseSidekickTimeReceipt(payload);
        return;
      case 'speaker.playback.started':
        this.speakerReceipts.handleStarted(runtime, payload);
        return;
      case 'speaker.playback.progress':
        this.speakerReceipts.handleProgress(runtime, payload);
        return;
      case 'speaker.playback.stopped':
        this.speakerReceipts.handleStopped(runtime, payload);
        return;
      case 'speaker.playback.error':
        this.speakerReceipts.handleError(runtime, payload);
        return;
      case 'wake.detected':
        await this.handleWakeDetected(runtime, payload);
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

  private async handleWakeDetected(runtime: SidekickRuntimeState, payload: SidekickNetworkPayload): Promise<void> {
    await this.options.onWakeDetected?.(parseSidekickWakeReceipt(payload));
    runtime.lastSeenAt = new Date().toISOString();
  }

  // Igual que con los receipts de speaker: los mensajes de microfono que no
  // calzan con la grabacion activa se ignoran (chunks tardios tras cancelar
  // son trafico esperado); lanzar aqui cerraba el socket completo y forzaba
  // la reconexion del Sidekick. Solo datos malformados de la grabacion activa
  // fallan esa grabacion, avisando al dispositivo para que deje de grabar.
  private async handleRecordingStarted(runtime: SidekickRuntimeState, payload: SidekickNetworkPayload): Promise<void> {
    const active = runtime.microphoneRecording;
    if (!active || active.status !== 'starting' || payload.recordingId !== active.recordingId) {
      return;
    }
    if (
      payload.sampleRate !== SIDEKICK_MIC_SAMPLE_RATE ||
      payload.channels !== SIDEKICK_MIC_CHANNELS ||
      payload.format !== SIDEKICK_MIC_FORMAT
    ) {
      await this.abortActiveRecording(runtime, 'El Sidekick inició la grabación con un formato inválido.', 'sidekick_microphone_started_invalid');
      return;
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
      return;
    }
    if (typeof payload.data !== 'string') {
      await this.abortActiveRecording(runtime, 'El Sidekick envió audio inválido.', 'sidekick_microphone_chunk_invalid');
      return;
    }
    const sequence = typeof payload.chunkSequence === 'number' ? payload.chunkSequence : active.nextChunkSequence;
    if (!Number.isInteger(sequence) || sequence !== active.nextChunkSequence) {
      await this.abortActiveRecording(runtime, 'El Sidekick envió audio fuera de secuencia.', 'sidekick_microphone_chunk_sequence_invalid');
      return;
    }
    const chunk = decodeCanonicalBase64Chunk(payload.data);
    if (!chunk || chunk.byteLength > SIDEKICK_MIC_MAX_CHUNK_BYTES || chunk.byteLength % 2 !== 0) {
      await this.abortActiveRecording(runtime, 'El Sidekick envió audio inválido.', 'sidekick_microphone_chunk_invalid');
      return;
    }
    if (active.bytes + chunk.byteLength + WAV_HEADER_BYTES > this.maxRecordingBytes) {
      await this.abortActiveRecording(runtime, 'La prueba de micrófono superó el tamaño máximo.', 'sidekick_microphone_recording_too_large');
      return;
    }
    await this.options.onMicrophonePcm?.({
      sidekickId: active.sidekickId,
      recordingId: active.recordingId,
      chunkSequence: sequence,
      pcm: new Uint8Array(chunk),
    });
    if (active.persist) {
      await fs.appendFile(active.tempPcmPath, chunk);
    }
    active.bytes += chunk.byteLength;
    active.chunks += 1;
    active.nextChunkSequence += 1;
  }

  private async handleRecordingStopped(runtime: SidekickRuntimeState, payload: SidekickNetworkPayload): Promise<void> {
    const active = runtime.microphoneRecording;
    if (
      !active ||
      (active.status !== 'recording' && active.status !== 'stopping') ||
      payload.recordingId !== active.recordingId
    ) {
      return;
    }
    if (typeof payload.sampleCount !== 'number' || !Number.isInteger(payload.sampleCount) || payload.sampleCount < 0) {
      await this.failActiveRecording(
        runtime,
        'El Sidekick cerró la grabación con datos inválidos.',
        'sidekick_microphone_stopped_invalid',
      );
      return;
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
    if (active.persist) {
      await this.finalizeActiveRecording(active, payload.sampleCount);
    }
    runtime.microphoneRecording = undefined;
    runtime.microphoneErrorMessage = undefined;
    runtime.microphoneErrorCode = undefined;
    this.resolvePendingRecordingAck(runtime, 'stopped', active.recordingId);
  }

  private async handleRecordingError(runtime: SidekickRuntimeState, payload: SidekickNetworkPayload): Promise<void> {
    const active = runtime.microphoneRecording;
    if (!active || payload.recordingId !== active.recordingId) {
      return;
    }
    const code = isSafeCode(payload.code)
      ? `sidekick_microphone_${String(payload.code)}`
      : 'sidekick_microphone_error_invalid';
    await this.failActiveRecording(runtime, 'El Sidekick informó un error de micrófono.', code);
    this.rejectPendingRecordingAcks(runtime, active.recordingId, new Error(code));
  }

  // Falla la grabacion activa y pide al Sidekick que deje de grabar. Antes el
  // socket se cerraba y la desconexion cancelaba la captura del dispositivo;
  // sin ese cierre hay que avisarle explicitamente (best effort: si el stop no
  // llega, el dispositivo cancela solo al perder la sesion).
  private async abortActiveRecording(runtime: SidekickRuntimeState, message: string, code: string): Promise<void> {
    const active = runtime.microphoneRecording;
    await this.failActiveRecording(runtime, message, code);
    if (!active) {
      return;
    }
    const record = this.findRecord(active.sidekickId);
    if (!record || !runtime.socket || runtime.socket.readyState !== WebSocket.OPEN || !runtime.sessionId) {
      return;
    }
    await this.sendEncrypted(record, runtime, {
      v: 1,
      id: randomUUID(),
      cmd: 'microphone.record.stop',
      recordingId: active.recordingId,
    }).catch(() => undefined);
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
    if (active.tempPcmPath) {
      await fs.rm(active.tempPcmPath, { force: true }).catch(() => undefined);
    }
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
      runtime = { status: 'offline', txSeq: 0, pendingRecordingAcks: new Map(), pendingSpeakerAcks: new Map() };
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
        personalAgentId: record.personalAgentId,
        battery: runtime?.battery,
        time: runtime?.time,
        speakerPlayback: summarizeSpeakerPlayback(runtime),
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
        speakerPlayback: summarizeSpeakerPlayback(runtime),
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

export const __testSidekickInternals = {
  buildSidekickHostname,
  decryptSidekickEnvelope,
  deriveSidekickKey,
  encryptSidekickPayload,
  normalizeCapabilities,
  normalizeVisibleSidekickName,
};
