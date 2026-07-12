import { safeStorage } from 'electron';
import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import http, { type Server } from 'node:http';
import path from 'node:path';

import Bonjour from 'bonjour-service';
import { SerialPort, ReadlineParser } from 'serialport';
import { WebSocket, WebSocketServer } from 'ws';

import type {
  AgentProviderUsageEntry,
  SidekickConfigureInput,
  SidekickDisplayInput,
  SidekickIdleConfig,
  SidekickIdleConfigInput,
  SidekickIdleImageInput,
  SidekickIdleScreen,
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
  SidekickVoicePhase,
  SidekickVoiceConfigInput,
  SidekickWakeEvent,
} from '../shared/types';
import {
  SIDEKICK_MAX_CONVERSATION_TTL_MINUTES,
  SIDEKICK_MIN_CONVERSATION_TTL_MINUTES,
  SIDEKICK_DEFAULT_IDLE_CONFIG,
  SIDEKICK_IDLE_IMAGE_BYTES,
  SIDEKICK_IDLE_SCREENS,
} from '../shared/types';
import {
  SIDEKICK_BAUD_RATE,
  SIDEKICK_HEARTBEAT_TIMEOUT_MS,
  SIDEKICK_MDNS_SERVICE,
  SIDEKICK_OFFLINE_SWEEP_MS,
  SIDEKICK_PROTO,
  SIDEKICK_SERVICE_TYPE,
  SIDEKICK_VISIBLE_NAME_MAX_LENGTH,
  SIDEKICK_WS_MAX_PAYLOAD_BYTES,
  SIDEKICK_WS_PATH,
  buildSidekickHostname,
  closeSerialPort,
  decryptSidekickEnvelope,
  deriveSidekickKey,
  drainSerialPort,
  encryptSidekickPayload,
  isEncryptedEnvelope,
  isNetworkHelloPayload,
  isPathInside,
  isStoredSidekickRecord,
  normalizeCapabilities,
  normalizeSidekickBattery,
  normalizeSidekickTime,
  normalizeSidekickUsbDevice,
  normalizeVisibleSidekickName,
  normalizedStoredSidekickVoiceConfig,
  openSerialPort,
  sidekickConfigureFailureCode,
  sidekickConfigureFailureMessage,
  sidekickFailureState,
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
  ActiveSidekickPlayback,
  SidekickNetworkPayload,
  SidekickRuntimeState,
  SidekickUsbHello,
  StoredSidekickFile,
  StoredSidekickRecord,
} from './sidekick-service-helpers';
import { parseSidekickTimeReceipt, parseSidekickWakeReceipt, SidekickSpeakerReceipts } from './sidekick-network-receipts';
import { raceSidekickOperationWithSignal } from './sidekick-service-reliability';
import { SidekickMicrophoneController } from './sidekick-microphone-controller';
import { handleNetworkRxOverflow, handleWakeBeepResult } from './sidekick-diagnostics';

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

export interface SidekickSessionInvalidationEvent {
  sidekickId: string;
  reason: 'reconnected' | 'forgotten';
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
  onSessionInvalidated?: (event: SidekickSessionInvalidationEvent) => void | Promise<void>;
  getVoicePhase?: (sidekickId: string) => SidekickVoicePhase | undefined;
  // Uso de Claude/Codex para la pantalla idle de limites del dispositivo.
  getProviderUsage?: () => Promise<AgentProviderUsageEntry[]>;
}

// Con la pantalla de limites activa en el dispositivo, el refresco es casi en
// vivo; sin ella no se empuja nada en el sweep.
const SIDEKICK_LIMITS_PUSH_INTERVAL_MS = 20 * 1000;
const SIDEKICK_IDLE_IMAGE_CHUNK_BYTES = 4096;

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
  private readonly idleImagesDir: string;
  private readonly serialPortClass: typeof SerialPort;
  private readonly storage: Pick<typeof safeStorage, 'isEncryptionAvailable' | 'encryptString' | 'decryptString'>;
  private readonly speakerReceipts = new SidekickSpeakerReceipts();
  private readonly microphone: SidekickMicrophoneController;
  private readonly socketMessageWork = new Map<WebSocket, Promise<void>>();
  private disposing = false;

  constructor(private readonly options: SidekickServiceOptions) {
    this.storePath = path.join(options.metadataRoot, 'sidekicks.json');
    this.idleImagesDir = path.join(options.metadataRoot, 'sidekick-idle-images');
    this.serialPortClass = options.serialPortClass ?? SerialPort;
    this.storage = options.safeStorageAdapter ?? safeStorage;
    this.microphone = new SidekickMicrophoneController({
      metadataRoot: options.metadataRoot,
      maxRecordingBytes: options.maxRecordingBytes,
      recentRecordingLimit: options.recentRecordingLimit,
      findRecord: (sidekickId) => this.findRecord(sidekickId),
      getRuntime: (sidekickId) => this.runtimes.get(sidekickId),
      buildState: () => this.buildState(),
      sendEncrypted: async (record, runtime, payload) => await this.sendEncrypted(record, runtime, payload),
      emit: () => this.emit(),
      log: async (event, payload) => await this.log(event, payload),
      onMicrophonePcm: options.onMicrophonePcm,
    });
  }

  async getState(): Promise<SidekickState> {
    await this.load();
    await this.microphone.load();
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

  public notifyVoiceStateChanged(): void {
    this.emit();
  }

  async scanUsb(): Promise<SidekickState> {
    await this.load();
    await this.microphone.load();
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
    await this.microphone.load();
    if ((this.stored?.records.length ?? 0) === 0) {
      return;
    }
    await this.ensureNetworkService();
    this.emit();
  }

  async configureUsb(input: SidekickConfigureInput): Promise<SidekickMutationResult> {
    await this.load();
    await this.microphone.load();
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
    await this.microphone.load();
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

  async setVoiceConfig(input: SidekickVoiceConfigInput): Promise<SidekickMutationResult> {
    await this.load();
    const record = this.findRecord(input.sidekickId);
    if (!record) return sidekickFailureState(this.buildState(), 'Ese Sidekick ya no está registrado.', 'sidekick_not_registered');
    const model = input.config?.model?.trim();
    const voice = input.config?.voice?.trim();
    const locale = input.config?.locale?.trim();
    const ttl = input.config?.conversationTtlMinutes;
    if (!Number.isInteger(ttl) || ttl < SIDEKICK_MIN_CONVERSATION_TTL_MINUTES || ttl > SIDEKICK_MAX_CONVERSATION_TTL_MINUTES) {
      return sidekickFailureState(this.buildState(), 'El tiempo de continuidad no es válido.', 'sidekick_voice_conversation_ttl_invalid');
    }
    if (Boolean(model) !== Boolean(voice) || (locale && (!model || !voice))) {
      return sidekickFailureState(this.buildState(), 'La voz seleccionada no es válida.', 'sidekick_voice_config_incomplete');
    }
    if (
      (model && !/^[A-Za-z0-9._-]{1,128}$/.test(model)) ||
      (voice && !/^[A-Za-z0-9._-]{1,128}$/.test(voice)) ||
      (locale && !/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(locale))
    ) {
      return sidekickFailureState(this.buildState(), 'La voz seleccionada no es válida.', 'sidekick_voice_config_invalid');
    }
    record.voiceConfig = normalizedStoredSidekickVoiceConfig({
      ...(model ? { model } : {}),
      ...(voice ? { voice } : {}),
      ...(locale ? { locale } : {}),
      conversationTtlMinutes: ttl,
    });
    record.updatedAt = new Date().toISOString();
    await this.save();
    this.emit();
    return { ...this.buildState(), success: true };
  }

  async sendScreen(input: SidekickScreenInput): Promise<SidekickMutationResult> {
    await this.load();
    await this.microphone.load();
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
    if (input.template === 'state' && !['listening', 'transcribing', 'thinking', 'speaking', 'sleeping', 'error'].includes(input.icon ?? '')) {
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

  async speak(
    input: SidekickSpeakInput,
    options: { signal?: AbortSignal; manageScreen?: boolean } = {},
  ): Promise<SidekickSpeakerPlaybackResult> {
    const text = typeof input.text === 'string' ? input.text.trim() : '';
    const model = typeof input.model === 'string' ? input.model.trim() : '';
    const voice = typeof input.voice === 'string' ? input.voice.trim() : '';
    if (!text || !model || !voice) {
      return { success: false, userMessage: 'Elige una voz y escribe qué debe decir.', technicalCode: 'sidekick_speech_input_required' };
    }
    if (!this.options.synthesizeSpeech) {
      return { success: false, userMessage: 'La voz de Forger no está disponible.', technicalCode: 'sidekick_tts_unavailable' };
    }
    const manageScreen = options.manageScreen !== false;
    if (manageScreen) {
      await this.sendScreen({ sidekickId: input.sidekickId, template: 'state', icon: 'speaking' }).catch(() => undefined);
    }
    try {
      const synthesized = await raceSidekickOperationWithSignal(this.options.synthesizeSpeech({
        text,
        model,
        voice,
        speed: input.speed,
        format: 'wav',
      }), options.signal);
      if (!synthesized.success || !synthesized.audioDataBase64) {
        return {
          success: false,
          userMessage: synthesized.userMessage ?? 'No pude preparar la voz.',
          technicalCode: synthesized.technicalCode ?? 'sidekick_tts_failed',
        };
      }
      const wav = Buffer.from(synthesized.audioDataBase64, 'base64');
      const pcm = wavToSidekickPcm(wav);
      return await this.playSpeakerPcm({ sidekickId: input.sidekickId, samples: pcm.samples }, { signal: options.signal });
    } catch (error) {
      if (options.signal?.aborted) {
        return { success: false, userMessage: 'La reproducción fue interrumpida.', technicalCode: 'sidekick_speaker_playback_cancelled' };
      }
      return {
        success: false,
        userMessage: 'No pude preparar la voz para el Sidekick.',
        technicalCode: error instanceof Error ? error.message : 'sidekick_tts_failed',
      };
    } finally {
      if (manageScreen) {
        await this.sendScreen({ sidekickId: input.sidekickId, template: 'idle' }).catch(() => undefined);
      }
    }
  }

  async startMicrophoneRecording(input: SidekickMicrophoneRecordingInput): Promise<SidekickMutationResult> {
    await this.load();
    return await this.microphone.start(input);
  }

  async stopMicrophoneRecording(input: SidekickMicrophoneRecordingInput): Promise<SidekickMutationResult> {
    await this.load();
    return await this.microphone.stop(input);
  }

  async readMicrophoneRecording(input: SidekickMicrophonePlaybackInput): Promise<SidekickMicrophonePlaybackResult> {
    return await this.microphone.read(input);
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

  async playSpeakerPcm(
    input: SidekickSpeakerPcmInput,
    options: { signal?: AbortSignal } = {},
  ): Promise<SidekickSpeakerPlaybackResult> {
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
      maxInFlightChunks: 1,
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
      await raceSidekickOperationWithSignal(started, options.signal);

      // La ventana viene negociada por firmware y ya considera transporte,
      // cola de comandos y cola de audio. Firmware legado cae a lockstep para
      // evitar inferir capacidad desde queueDepth, que no describe WebSocket.
      const window = active.maxInFlightChunks;
      const pending: Array<Promise<void>> = [];
      for (const chunk of chunkSidekickPcm(input.samples)) {
        if (options.signal?.aborted) throw options.signal.reason ?? new Error('sidekick_operation_cancelled');
        while (pending.length >= window) {
          await raceSidekickOperationWithSignal(pending.shift()!, options.signal);
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
        await raceSidekickOperationWithSignal(pending.shift()!, options.signal);
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
      await raceSidekickOperationWithSignal(stopped, options.signal);
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
      const errorMessage = error instanceof Error ? error.message : String(error);
      const interrupted = errorMessage === 'sidekick_speaker_playback_interrupted' || errorMessage === 'sidekick_session_reconnected';
      const cancelled = options.signal?.aborted === true || interrupted;
      await this.log(cancelled ? 'sidekick:speaker_playback_interrupted' : 'sidekick:speaker_playback_failed', {
        sidekickId: record.sidekickId,
        playbackId,
        outcome: cancelled ? 'interrupted' : 'failed',
        technicalCode: errorMessage,
        samplesSent: active.samplesSent,
        samplesPlayed: active.samplesPlayed,
        bufferedSamples: active.bufferedSamples,
        underruns: active.underruns,
        droppedChunks: active.droppedChunks,
        pendingAcks: [...runtime.pendingSpeakerAcks.keys()],
      });
      this.speakerReceipts.reject(runtime, new Error(cancelled ? 'sidekick_speaker_playback_cancelled' : 'sidekick_speaker_playback_failed'));
      if (runtime.speakerPlayback === active && runtime.socket?.readyState === WebSocket.OPEN && runtime.sessionId) {
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
      runtime.speakerErrorMessage = cancelled ? undefined : 'No pude reproducir el audio en el Sidekick.';
      runtime.speakerErrorCode = cancelled
        ? undefined
        : error instanceof Error ? error.message : 'sidekick_speaker_playback_failed';
      this.emit();
      return {
        success: false,
        playbackId,
        userMessage: cancelled ? 'La reproducción fue interrumpida.' : runtime.speakerErrorMessage,
        technicalCode: interrupted
          ? 'sidekick_speaker_playback_interrupted'
          : cancelled ? 'sidekick_speaker_playback_cancelled' : runtime.speakerErrorCode,
      };
    }
  }

  // --- Personalizacion idle (config, imagen custom, limites) ----------------

  private normalizeIdleConfig(config?: SidekickIdleConfig): SidekickIdleConfig {
    const requestedScreens: unknown[] = Array.isArray(config?.screens) ? config.screens : [];
    const screens: SidekickIdleScreen[] = [];
    const seen = new Set<SidekickIdleScreen>();
    for (const value of requestedScreens) {
      if (!SIDEKICK_IDLE_SCREENS.includes(value as SidekickIdleScreen) || seen.has(value as SidekickIdleScreen)) {
        continue;
      }
      const screen = value as SidekickIdleScreen;
      seen.add(screen);
      screens.push(screen);
    }
    const rotateSeconds = Number.isFinite(config?.rotateSeconds)
      ? Math.min(3600, Math.max(5, Math.round(config?.rotateSeconds ?? SIDEKICK_DEFAULT_IDLE_CONFIG.rotateSeconds)))
      : SIDEKICK_DEFAULT_IDLE_CONFIG.rotateSeconds;
    return {
      screens: screens.length > 0 ? screens : [...SIDEKICK_DEFAULT_IDLE_CONFIG.screens],
      rotateSeconds,
    };
  }

  private idleImagePath(sidekickId: string): string | null {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(sidekickId)) {
      return null;
    }
    const filePath = path.join(this.idleImagesDir, `${sidekickId}.rgb565`);
    return isPathInside(this.idleImagesDir, filePath) ? filePath : null;
  }

  async setIdleConfig(input: SidekickIdleConfigInput): Promise<SidekickMutationResult> {
    await this.load();
    const record = this.findRecord(input.sidekickId);
    if (!record) {
      return sidekickFailureState(this.buildState(), 'Ese Sidekick ya no está registrado.', 'sidekick_not_registered');
    }
    record.idleConfig = this.normalizeIdleConfig(input.config);
    record.updatedAt = new Date().toISOString();
    await this.save();
    const runtime = this.runtimes.get(record.sidekickId);
    if (runtime?.socket?.readyState === WebSocket.OPEN && runtime.sessionId && runtime.status === 'online') {
      await this.pushIdleConfig(record, runtime).catch(() => undefined);
      // Si activaron la pantalla custom y hay imagen guardada, reenviarla.
      if (record.idleConfig.screens.includes('custom')) {
        await this.pushIdleImage(record, runtime).catch(() => undefined);
      }
    }
    this.emit();
    return { ...this.buildState(), success: true };
  }

  async setIdleImage(input: SidekickIdleImageInput): Promise<SidekickMutationResult> {
    await this.load();
    const record = this.findRecord(input.sidekickId);
    if (!record) {
      return sidekickFailureState(this.buildState(), 'Ese Sidekick ya no está registrado.', 'sidekick_not_registered');
    }
    const bytes = Buffer.from(input.rgb565);
    if (bytes.byteLength !== SIDEKICK_IDLE_IMAGE_BYTES) {
      return sidekickFailureState(this.buildState(), 'La imagen no tiene el tamaño exacto de la pantalla.', 'sidekick_idle_image_size_invalid');
    }
    const filePath = this.idleImagePath(record.sidekickId);
    if (!filePath) {
      return sidekickFailureState(this.buildState(), 'No pude guardar la imagen.', 'sidekick_idle_image_path_invalid');
    }
    await fs.mkdir(this.idleImagesDir, { recursive: true });
    await fs.writeFile(filePath, bytes);
    record.idleImagePreviewDataUrl =
      typeof input.previewDataUrl === 'string' && input.previewDataUrl.startsWith('data:image/') &&
      input.previewDataUrl.length <= 300_000
        ? input.previewDataUrl
        : undefined;
    record.updatedAt = new Date().toISOString();
    await this.save();
    const runtime = this.runtimes.get(record.sidekickId);
    if (runtime?.socket?.readyState === WebSocket.OPEN && runtime.sessionId && runtime.status === 'online') {
      await this.pushIdleImage(record, runtime).catch(() => undefined);
    }
    this.emit();
    return { ...this.buildState(), success: true };
  }

  private async pushIdleConfig(record: StoredSidekickRecord, runtime: SidekickRuntimeState): Promise<void> {
    const config = this.normalizeIdleConfig(record.idleConfig);
    await this.sendEncrypted(record, runtime, {
      v: 1,
      id: randomUUID(),
      cmd: 'idle.config',
      screens: config.screens,
      rotateSeconds: config.rotateSeconds,
    });
  }

  private async pushIdleImage(record: StoredSidekickRecord, runtime: SidekickRuntimeState): Promise<void> {
    const filePath = this.idleImagePath(record.sidekickId);
    if (!filePath) {
      return;
    }
    const bytes = await fs.readFile(filePath).catch(() => null);
    if (!bytes || bytes.byteLength !== SIDEKICK_IDLE_IMAGE_BYTES) {
      return;
    }
    await this.sendEncrypted(record, runtime, {
      v: 1,
      id: randomUUID(),
      cmd: 'idle.image.begin',
      bytes: bytes.byteLength,
    });
    for (let offset = 0; offset < bytes.byteLength; offset += SIDEKICK_IDLE_IMAGE_CHUNK_BYTES) {
      const chunk = bytes.subarray(offset, Math.min(offset + SIDEKICK_IDLE_IMAGE_CHUNK_BYTES, bytes.byteLength));
      await this.sendEncrypted(record, runtime, {
        v: 1,
        id: randomUUID(),
        cmd: 'idle.image.chunk',
        offset,
        dataBase64: chunk.toString('base64'),
      });
    }
    await this.sendEncrypted(record, runtime, {
      v: 1,
      id: randomUUID(),
      cmd: 'idle.image.commit',
      bytes: bytes.byteLength,
    });
  }

  private async pushLimits(record: StoredSidekickRecord, runtime: SidekickRuntimeState): Promise<void> {
    if (!this.options.getProviderUsage) {
      return;
    }
    const entries = await this.options.getProviderUsage().catch(() => [] as AgentProviderUsageEntry[]);
    const rows: Array<{ provider: string; window: string; usedPercent?: number; reset?: string }> = [];
    // Reset como en el widget del Desktop: hora local ("7:18pm") si cae en
    // las proximas 24 h, fecha corta ("Jul 18") si es mas adelante.
    const formatReset = (resetsAt?: number): string | undefined => {
      if (typeof resetsAt !== 'number') {
        return undefined;
      }
      const resetMs = resetsAt * 1000;
      if (resetMs <= Date.now()) {
        return undefined;
      }
      if (resetMs - Date.now() <= 24 * 60 * 60 * 1000) {
        return new Date(resetMs)
          .toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
          .replace(' ', '')
          .toLowerCase();
      }
      return new Date(resetMs).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    };
    for (const entry of entries) {
      if (!entry.connected) {
        continue;
      }
      for (const window of entry.windows) {
        if (rows.length >= 6) {
          break;
        }
        const reset = formatReset(window.resetsAt);
        rows.push({
          provider: entry.label.slice(0, 15),
          window: window.kind === 'five_hour' ? '5h' : 'Weekly',
          ...(typeof window.usedPercent === 'number' ? { usedPercent: Math.round(window.usedPercent) } : {}),
          ...(reset ? { reset } : {}),
        });
      }
    }
    runtime.lastLimitsPushAt = Date.now();
    await this.sendEncrypted(record, runtime, {
      v: 1,
      id: randomUUID(),
      cmd: 'limits.update',
      rows,
    });
  }

  // Al conectar (hello de red) se reenvia toda la personalizacion: el firmware
  // no persiste config de idle ni imagen, Desktop es la fuente de verdad.
  private async pushCustomization(record: StoredSidekickRecord, runtime: SidekickRuntimeState): Promise<void> {
    await this.pushIdleConfig(record, runtime).catch(() => undefined);
    await this.pushLimits(record, runtime).catch(() => undefined);
    if ((record.idleConfig ?? SIDEKICK_DEFAULT_IDLE_CONFIG).screens.includes('custom')) {
      await this.pushIdleImage(record, runtime).catch(() => undefined);
    }
  }

  async forget(sidekickId: string): Promise<SidekickMutationResult> {
    await this.load();
    await this.microphone.load();
    const before = this.stored?.records.length ?? 0;
    const registered = this.stored?.records.some((record) => record.sidekickId === sidekickId) ?? false;
    const runtime = this.runtimes.get(sidekickId);
    if (runtime) {
      await this.microphone.cleanupActive(runtime, 'sidekick_forgotten');
      this.speakerReceipts.reject(runtime, new Error('sidekick_forgotten'));
      runtime.speakerPlayback = undefined;
    }
    if (registered || runtime) {
      await this.notifySessionInvalidated(sidekickId, 'forgotten');
    }
    if (this.stored) {
      this.stored.records = this.stored.records.filter((record) => record.sidekickId !== sidekickId);
    }
    runtime?.socket?.close();
    this.runtimes.delete(sidekickId);
    if (before !== (this.stored?.records.length ?? 0)) {
      await this.microphone.forget(sidekickId);
      const idleImage = this.idleImagePath(sidekickId);
      if (idleImage) {
        await fs.rm(idleImage, { force: true }).catch(() => undefined);
      }
      await this.save();
    }
    this.emit();
    return { ...this.buildState(), success: true };
  }

  async dispose(): Promise<void> {
    this.disposing = true;
    if (this.offlineTimer) {
      clearInterval(this.offlineTimer);
      this.offlineTimer = null;
    }
    for (const runtime of this.runtimes.values()) {
      await this.microphone.cleanupActive(runtime, 'sidekick_disposed');
      this.speakerReceipts.reject(runtime, new Error('sidekick_disposed'));
      runtime.socket?.close();
    }
    await Promise.allSettled([...this.socketMessageWork.values()]);
    this.socketMessageWork.clear();
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
      this.socketMessageWork.set(socket, messageQueue);
      socket.on('message', (raw) => {
        if (this.disposing) return;
        messageQueue = messageQueue.then(
          async () => await this.handleSocketMessage(socket, raw.toString(), ipAddress),
          async () => await this.handleSocketMessage(socket, raw.toString(), ipAddress),
        ).catch((error: unknown) => {
          void this.log('sidekick:socket_message_failed', { error: String(error) });
          socket.close();
        });
        this.socketMessageWork.set(socket, messageQueue);
      });
      socket.on('close', (code, reason) => {
        this.markSocketClosed(socket, code, reason.toString('utf8'));
        const pending = this.socketMessageWork.get(socket);
        void pending?.finally(() => {
          if (this.socketMessageWork.get(socket) === pending) this.socketMessageWork.delete(socket);
        });
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
    const connectionChanged = Boolean(runtime.sessionId) && (
      runtime.socket !== socket || runtime.sessionId !== parsed.sessionId
    );
    const sessionWasInvalidated = Boolean(
      runtime.microphoneRecording ||
      runtime.speakerPlayback ||
      connectionChanged,
    );
    if (runtime.microphoneRecording) {
      await this.microphone.cleanupActive(runtime, 'sidekick_session_reconnected');
    }
    if (runtime.speakerPlayback) {
      this.speakerReceipts.reject(runtime, new Error('sidekick_session_reconnected'));
      runtime.speakerPlayback = undefined;
    }
    runtime.microphoneErrorMessage = undefined;
    runtime.microphoneErrorCode = undefined;
    runtime.speakerErrorMessage = undefined;
    runtime.speakerErrorCode = undefined;
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
    // Un Sidekick solo puede tener una sesion activa. Tras un reset USB/TCP la
    // conexion anterior puede quedar ESTABLISHED hasta el keepalive; cerrarla
    // evita recibos y comandos de dos sesiones para el mismo dispositivo.
    supersededSocket?.close(1000, 'sidekick_session_superseded');
    if (sessionWasInvalidated) {
      await this.notifySessionInvalidated(record.sidekickId, 'reconnected');
    }
    await this.save();
    await this.syncTime(record.sidekickId).catch((error: unknown) => {
      void this.log('sidekick:time_sync_failed', {
        sidekickId: record.sidekickId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
    void this.pushCustomization(record, runtime).catch(() => undefined);
    this.emit();
  }

  private markSocketClosed(socket: WebSocket, closeCode?: number, closeReason?: string): void {
    let changed = false;
    for (const [sidekickId, runtime] of this.runtimes.entries()) {
      if (runtime.socket === socket) {
        void this.log('sidekick:socket_closed', {
          sidekickId,
          closeCode,
          closeReason: closeReason || undefined,
          microphoneStatus: runtime.microphoneRecording?.status ?? 'idle',
          speakerStatus: runtime.speakerPlayback?.status ?? 'idle',
          voicePhase: this.options.getVoicePhase?.(sidekickId) ?? 'idle',
        });
        if (runtime.microphoneRecording) {
          void this.microphone.failActive(runtime, 'El Sidekick se desconectó durante la prueba de micrófono.', 'sidekick_socket_closed');
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
            void this.microphone.failActive(runtime, 'El Sidekick se desconectó durante la prueba de micrófono.', 'sidekick_heartbeat_timeout');
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
        } else if (
          runtime.status === 'online' &&
          runtime.lastLimitsPushAt !== undefined &&
          now - runtime.lastLimitsPushAt >= SIDEKICK_LIMITS_PUSH_INTERVAL_MS
        ) {
          // Refresco periodico solo si el dispositivo tiene la pantalla de
          // limites en su rotacion idle.
          const sidekickId = Array.from(this.runtimes.entries()).find(([, candidate]) => candidate === runtime)?.[0];
          const record = sidekickId ? this.findRecord(sidekickId) : null;
          if (record && (record.idleConfig ?? SIDEKICK_DEFAULT_IDLE_CONFIG).screens.includes('limits')) {
            void this.pushLimits(record, runtime).catch(() => undefined);
          } else if (runtime.lastLimitsPushAt !== undefined) {
            // Evita reevaluar cada sweep de 5 s cuando la pantalla no esta activa.
            runtime.lastLimitsPushAt = now;
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
      case 'wake.beep.result': {
        handleWakeBeepResult(runtime, payload, {
          emit: () => this.emit(),
          log: async (event, context) => await this.log(event, context),
          rejectSpeaker: (error) => this.speakerReceipts.reject(runtime, error),
        });
        return;
      }
      case 'network.rx_overflow': {
        handleNetworkRxOverflow(runtime, payload, {
          emit: () => this.emit(),
          log: async (event, context) => await this.log(event, context),
          rejectSpeaker: (error) => this.speakerReceipts.reject(runtime, error),
        });
        return;
      }
      case 'wake.detected':
        await this.handleWakeDetected(runtime, payload);
        return;
      case 'microphone.recording.started':
      case 'microphone.recording.chunk':
      case 'microphone.recording.stopped':
      case 'microphone.recording.error':
        await this.microphone.handlePayload(runtime, payload);
        return;
      default:
        return;
    }
  }

  private async handleWakeDetected(runtime: SidekickRuntimeState, payload: SidekickNetworkPayload): Promise<void> {
    await this.options.onWakeDetected?.(parseSidekickWakeReceipt(payload));
    runtime.lastSeenAt = new Date().toISOString();
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
        voiceConfig: normalizedStoredSidekickVoiceConfig(record.voiceConfig),
        battery: runtime?.battery,
        time: runtime?.time,
        wakeBeep: runtime?.wakeBeep,
        voicePhase: this.options.getVoicePhase?.(record.sidekickId) ?? 'idle',
        speakerPlayback: summarizeSpeakerPlayback(runtime),
        microphoneRecording: summarizeMicrophoneRecording(runtime),
        microphoneRecordings: this.microphone.summariesFor(record.sidekickId),
        idleConfig: this.normalizeIdleConfig(record.idleConfig),
        idleImagePreviewDataUrl: record.idleImagePreviewDataUrl,
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
        voiceConfig: normalizedStoredSidekickVoiceConfig(),
        voicePhase: 'idle',
        speakerPlayback: summarizeSpeakerPlayback(runtime),
        microphoneRecording: summarizeMicrophoneRecording(runtime),
        microphoneRecordings: [],
        idleConfig: { ...SIDEKICK_DEFAULT_IDLE_CONFIG, screens: [...SIDEKICK_DEFAULT_IDLE_CONFIG.screens] },
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

  private async notifySessionInvalidated(
    sidekickId: string,
    reason: SidekickSessionInvalidationEvent['reason'],
  ): Promise<void> {
    try {
      await this.options.onSessionInvalidated?.({ sidekickId, reason });
    } catch (error) {
      await this.log('sidekick:session_invalidation_failed', {
        sidekickId,
        reason,
        technicalCode: error instanceof Error ? error.message : String(error),
      }).catch(() => undefined);
    }
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
