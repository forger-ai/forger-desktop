import { randomUUID } from 'node:crypto';
import type fs from 'node:fs/promises';
import type path from 'node:path';

import type {
  LiveVoiceInputConfig,
  LiveVoiceInputConfigInput,
  LiveVoiceInputConsumer,
  LiveVoiceInputDevice,
  LiveVoiceInputDeviceListInput,
  LiveVoiceInputDeviceSession,
  LiveVoiceInputSession,
  LiveVoiceInputSessionInput,
  LiveVoiceInputSourceKind,
  LiveVoiceInputState,
  LiveVoiceInputStopInput,
  LiveVoiceInputWakeEvent,
  LiveVoiceInputWakeModel,
  LiveVoiceInputWakeRuntime,
  LiveVoiceInputWakeTarget,
  SpeechToTextRealtimeSession,
  SpeechToTextState,
} from '../shared/types';

interface LiveVoiceInputDeps {
  appendInstallLog: (event: string, payload?: Record<string, unknown>) => Promise<void>;
  fs: typeof fs;
  getMetadataRoot: () => string;
  getSpeechToTextState: () => Promise<SpeechToTextState>;
  createSpeechRealtimeSession: () => Promise<SpeechToTextRealtimeSession>;
  onForgerWakeDetected?: (event: LiveVoiceInputWakeEvent) => void;
  path: typeof path;
}

const DEFAULT_WAKE_MODEL_ID = 'hey jarvis';

const DEFAULT_WAKE_MODELS: LiveVoiceInputWakeModel[] = [
  {
    id: 'hey jarvis',
    displayName: 'Hey Jarvis',
    source: 'openwakeword-pretrained',
    installedAt: 'bundled',
    thresholdDefault: 0.5,
  },
  {
    id: 'hey mycroft',
    displayName: 'Hey Mycroft',
    source: 'openwakeword-pretrained',
    installedAt: 'bundled',
    thresholdDefault: 0.5,
  },
  {
    id: 'alexa',
    displayName: 'Alexa',
    source: 'openwakeword-pretrained',
    installedAt: 'bundled',
    thresholdDefault: 0.5,
  },
  {
    id: 'hey rhasspy',
    displayName: 'Hey Rhasspy',
    source: 'openwakeword-pretrained',
    installedAt: 'bundled',
    thresholdDefault: 0.5,
  },
];

const INSTALLED_WAKE_MODEL_IDS = new Set(DEFAULT_WAKE_MODELS.map((model) => model.id));
const WAKE_MODEL_ALIASES = new Map([
  ['hey_jarvis', 'hey jarvis'],
  ['hey_mycroft', 'hey mycroft'],
  ['hey_rhasspy', 'hey rhasspy'],
]);

const DEFAULT_CONFIG: LiveVoiceInputConfig = {
  defaultDeviceId: '',
  forgerWakeWordEnabled: false,
  wakeDeviceId: '',
  wakeModelId: DEFAULT_WAKE_MODEL_ID,
  wakeThreshold: 0.5,
  wakePatience: 2,
  wakeCooldownMs: 2500,
  maxWakeModelsPerDevice: 1,
  transcriptTask: 'transcribe',
  maxTranscriptSubscribersPerDevice: 3,
  autoStopWhenIdle: true,
};

const clampNumber = (value: unknown, fallback: number, min: number, max: number): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
};

const cleanId = (value: unknown): string =>
  typeof value === 'string' ? value.trim().slice(0, 160) : '';

const cleanLabel = (value: unknown, fallback: string): string => {
  const cleaned = typeof value === 'string' ? value.trim() : '';
  return (cleaned || fallback).slice(0, 160);
};

const normalizeSourceKind = (value: unknown): LiveVoiceInputSourceKind =>
  value === 'system_audio' ? 'system_audio' : 'microphone';

const normalizeWakeModelId = (value: unknown): string => {
  const rawModelId = cleanId(value);
  const modelId = WAKE_MODEL_ALIASES.get(rawModelId) ?? rawModelId;
  return modelId && INSTALLED_WAKE_MODEL_IDS.has(modelId) ? modelId : DEFAULT_WAKE_MODEL_ID;
};

export const normalizeLiveVoiceInputConfig = (input?: Partial<LiveVoiceInputConfig> | null): LiveVoiceInputConfig => ({
  defaultDeviceId: cleanId(input?.defaultDeviceId),
  forgerWakeWordEnabled: input?.forgerWakeWordEnabled === true,
  wakeDeviceId: cleanId(input?.wakeDeviceId),
  wakeModelId: normalizeWakeModelId(input?.wakeModelId),
  wakeThreshold: clampNumber(input?.wakeThreshold, DEFAULT_CONFIG.wakeThreshold, 0.05, 0.99),
  wakePatience: Math.round(clampNumber(input?.wakePatience, DEFAULT_CONFIG.wakePatience, 1, 8)),
  wakeCooldownMs: Math.round(clampNumber(input?.wakeCooldownMs, DEFAULT_CONFIG.wakeCooldownMs, 250, 60_000)),
  maxWakeModelsPerDevice: Math.round(clampNumber(input?.maxWakeModelsPerDevice, DEFAULT_CONFIG.maxWakeModelsPerDevice, 1, 4)),
  transcriptTask: input?.transcriptTask === 'translate' ? 'translate' : 'transcribe',
  ...(typeof input?.transcriptLanguage === 'string' && input.transcriptLanguage.trim()
    ? { transcriptLanguage: input.transcriptLanguage.trim().slice(0, 32) }
    : {}),
  maxTranscriptSubscribersPerDevice: Math.round(clampNumber(input?.maxTranscriptSubscribersPerDevice, DEFAULT_CONFIG.maxTranscriptSubscribersPerDevice, 1, 12)),
  autoStopWhenIdle: input?.autoStopWhenIdle !== false,
});

export class LiveVoiceInputServiceManager {
  private config: LiveVoiceInputConfig = DEFAULT_CONFIG;
  private devices: LiveVoiceInputDevice[] = [];
  private readonly consumers = new Map<string, LiveVoiceInputConsumer>();
  private lastError: string | undefined;
  private lastWakeEvent: LiveVoiceInputWakeEvent | undefined;
  private wakeRuntime: LiveVoiceInputWakeRuntime | undefined;

  constructor(private readonly deps: LiveVoiceInputDeps) {}

  async load(): Promise<void> {
    this.config = await this.readConfig();
  }

  async getState(): Promise<LiveVoiceInputState> {
    await this.load();
    const stt = await this.deps.getSpeechToTextState().catch((error: unknown) => {
      this.lastError = error instanceof Error ? error.message : 'speech_to_text_state_failed';
      return null;
    });
    const sttInstalled = stt?.installed === true;
    const sttRepairRequired = stt?.repairRequired === true;
    const sttRunning = stt?.running === true && !sttRepairRequired;
    const active = this.consumers.size > 0;
    return {
      status: this.lastError ? 'error' : !sttRunning || sttRepairRequired ? 'stt_required' : active ? 'active' : 'ready',
      running: active,
      sttInstalled,
      sttRunning,
      ...(sttRepairRequired ? { sttRepairRequired: true } : {}),
      ...(stt?.dependencyIssues?.length ? { sttDependencyIssues: stt.dependencyIssues } : {}),
      config: this.config,
      devices: this.devices,
      wakeModels: DEFAULT_WAKE_MODELS,
      sessions: this.buildSessions(),
      ...(this.wakeRuntime ? { wakeRuntime: this.wakeRuntime } : {}),
      ...(this.lastWakeEvent ? { lastWakeEvent: this.lastWakeEvent } : {}),
      ...(this.lastError ? { lastError: this.lastError } : {}),
    };
  }

  async updateConfig(input: LiveVoiceInputConfigInput): Promise<LiveVoiceInputState> {
    await this.load();
    this.config = normalizeLiveVoiceInputConfig({ ...this.config, ...input });
    await this.writeConfig();
    await this.reconcileForgerWakeConsumer();
    return await this.getState();
  }

  async updateDevices(input: LiveVoiceInputDeviceListInput): Promise<LiveVoiceInputState> {
    const seen = new Set<string>();
    this.devices = input.devices
      .map((device, index) => ({
        id: cleanId(device.id),
        kind: normalizeSourceKind(device.kind),
        label: cleanLabel(device.label, normalizeSourceKind(device.kind) === 'system_audio' ? 'System audio' : index === 0 ? 'Default microphone' : 'Microphone'),
        ...(cleanId(device.groupId) ? { groupId: cleanId(device.groupId) } : {}),
        default: device.default === true || index === 0,
        enabled: true,
        supported: device.supported !== false,
        ...(device.requiresDisplayCapture === true ? { requiresDisplayCapture: true } : {}),
      }))
      .filter((device) => {
        if (!device.id || seen.has(device.id)) return false;
        seen.add(device.id);
        return true;
      });
    await this.reconcileForgerWakeConsumer();
    return await this.getState();
  }

  async createSession(input: LiveVoiceInputSessionInput): Promise<LiveVoiceInputSession> {
    await this.load();
    const deviceId = this.resolveDeviceId(input.deviceId);
    if (input.consumerKind !== 'app_raw_audio') {
      await this.assertSttRunning();
    }
    const transcriptConsumers = [...this.consumers.values()]
      .filter((consumer) => consumer.deviceId === deviceId && consumer.kind === 'app_transcript');
    if (input.consumerKind === 'app_transcript' && transcriptConsumers.length >= this.config.maxTranscriptSubscribersPerDevice) {
      throw new Error('live_voice_transcript_subscriber_limit');
    }
    const realtime = input.consumerKind === 'app_raw_audio'
      ? {
        url: 'forger://live-voice/raw-audio',
        token: '',
        sampleRate: 16000 as const,
        format: 'pcm_s16le' as const,
      }
      : await this.deps.createSpeechRealtimeSession();
    const sessionTask = input.consumerKind === 'app_raw_audio'
      ? undefined
      : input.task === 'translate'
        ? 'translate'
        : input.task === 'transcribe'
          ? 'transcribe'
          : this.config.transcriptTask;
    const sessionLanguage = input.consumerKind === 'app_raw_audio'
      ? undefined
      : cleanId(input.language) || this.config.transcriptLanguage;
    if (input.consumerKind === 'forger_wake_word') {
      this.stopForgerWakeConsumers();
    }
    const consumerId = randomUUID();
    this.consumers.set(consumerId, {
      id: consumerId,
      kind: input.consumerKind,
      label: cleanLabel(input.label, consumerLabel(input.consumerKind)),
      deviceId,
      createdAt: new Date().toISOString(),
      ...(input.targetType ? { targetType: input.targetType } : {}),
      ...(input.targetId ? { targetId: cleanId(input.targetId) } : {}),
    });
    void this.deps.appendInstallLog('live_voice_input:session_created', {
      consumerKind: input.consumerKind,
      deviceId,
    });
    const wake = this.config.forgerWakeWordEnabled && input.consumerKind === 'forger_wake_word'
      ? {
        enabled: true,
        modelId: this.config.wakeModelId,
        threshold: this.config.wakeThreshold,
        patience: this.config.wakePatience,
        cooldownMs: this.config.wakeCooldownMs,
      }
      : undefined;
    return {
      sessionId: randomUUID(),
      deviceId,
      consumerId,
      ...realtime,
      ...(input.consumerKind === 'app_raw_audio' ? { mode: 'raw_audio' as const } : { mode: 'transcript' as const }),
      ...(sessionTask ? { task: sessionTask } : {}),
      ...(sessionLanguage ? { language: sessionLanguage } : {}),
      ...(wake ? { wake } : {}),
    };
  }

  async stop(input: LiveVoiceInputStopInput = {}): Promise<LiveVoiceInputState> {
    if (input.consumerId) {
      const consumer = this.consumers.get(input.consumerId);
      if (consumer && (!input.targetId || consumer.targetId === input.targetId)) {
        this.consumers.delete(input.consumerId);
        if (consumer.kind === 'forger_wake_word' && this.wakeRuntime?.state !== 'unavailable') {
          this.wakeRuntime = { state: 'idle', modelId: this.config.wakeModelId, updatedAt: new Date().toISOString() };
        }
      }
    } else if (input.deviceId) {
      for (const consumer of [...this.consumers.values()]) {
        if (consumer.kind !== 'forger_wake_word' && consumer.deviceId === input.deviceId && (!input.targetId || consumer.targetId === input.targetId)) {
          this.consumers.delete(consumer.id);
        }
      }
    } else {
      for (const consumer of [...this.consumers.values()]) {
        if (consumer.kind !== 'forger_wake_word') {
          this.consumers.delete(consumer.id);
        }
      }
    }
    return await this.getState();
  }

  async recordWakeDetected(input: { deviceId?: string; modelId?: string; confidence?: number; targetType?: string; targetId?: string }): Promise<LiveVoiceInputState> {
    await this.load();
    const event: LiveVoiceInputWakeEvent = {
      id: randomUUID(),
      deviceId: this.resolveDeviceId(input.deviceId),
      modelId: cleanId(input.modelId) || this.config.wakeModelId,
      confidence: clampNumber(input.confidence, 1, 0, 1),
      targetType: input.targetType === 'personal_agent' || input.targetType === 'app_agent' ? input.targetType : 'forger',
      ...(cleanId(input.targetId) ? { targetId: cleanId(input.targetId) } : {}),
      detectedAt: new Date().toISOString(),
    };
    this.lastWakeEvent = event;
    this.wakeRuntime = {
      state: 'detected',
      modelId: event.modelId,
      confidence: event.confidence,
      updatedAt: event.detectedAt,
    };
    void this.deps.appendInstallLog('live_voice_input:wake_detected', {
      deviceId: event.deviceId,
      modelId: event.modelId,
      confidence: event.confidence,
      targetType: event.targetType,
    });
    if (event.targetType === 'forger') {
      this.deps.onForgerWakeDetected?.(event);
    }
    return await this.getState();
  }

  async recordWakeReady(input: { modelId?: string }): Promise<LiveVoiceInputState> {
    await this.load();
    this.wakeRuntime = {
      state: 'ready',
      modelId: cleanId(input.modelId) || this.config.wakeModelId,
      updatedAt: new Date().toISOString(),
    };
    return await this.getState();
  }

  async recordWakeUnavailable(input: { modelId?: string; technicalCode?: string }): Promise<LiveVoiceInputState> {
    await this.load();
    this.wakeRuntime = {
      state: 'unavailable',
      modelId: cleanId(input.modelId) || this.config.wakeModelId,
      updatedAt: new Date().toISOString(),
      ...(cleanId(input.technicalCode) ? { technicalCode: cleanId(input.technicalCode) } : {}),
    };
    return await this.getState();
  }

  private async reconcileForgerWakeConsumer(): Promise<void> {
    this.stopForgerWakeConsumers();
    if (!this.config.forgerWakeWordEnabled) {
      this.wakeRuntime = { state: 'idle', modelId: this.config.wakeModelId, updatedAt: new Date().toISOString() };
      return;
    }
    const stt = await this.deps.getSpeechToTextState().catch(() => null);
    if (stt?.repairRequired) {
      this.wakeRuntime = { state: 'unavailable', modelId: this.config.wakeModelId, updatedAt: new Date().toISOString(), technicalCode: 'speech_to_text_repair_required' };
      return;
    }
    if (!stt?.running) {
      this.wakeRuntime = { state: 'idle', modelId: this.config.wakeModelId, updatedAt: new Date().toISOString() };
      return;
    }
    this.wakeRuntime = { state: 'starting', modelId: this.config.wakeModelId, updatedAt: new Date().toISOString() };
    const deviceId = this.resolveWakeDeviceId();
    const consumerId = randomUUID();
    this.consumers.set(consumerId, {
      id: consumerId,
      kind: 'forger_wake_word',
      label: 'Forger wake word',
      deviceId,
      createdAt: new Date().toISOString(),
      targetType: 'forger',
    });
  }

  private stopForgerWakeConsumers(): void {
    for (const consumer of [...this.consumers.values()]) {
      if (consumer.kind === 'forger_wake_word') {
        this.consumers.delete(consumer.id);
      }
    }
  }

  private async assertSttRunning(): Promise<void> {
    const stt = await this.deps.getSpeechToTextState();
    if (!stt.installed) throw new Error('live_voice_stt_not_installed');
    if (!stt.running) throw new Error('live_voice_stt_not_running');
  }

  private resolveDeviceId(candidate?: string): string {
    const configured = cleanId(candidate) || this.config.defaultDeviceId;
    const fallback = this.devices.find((device) => device.default)?.id ?? this.devices[0]?.id ?? 'default';
    return configured || fallback;
  }

  private resolveWakeDeviceId(): string {
    const configured = cleanId(this.config.wakeDeviceId);
    const fallback = this.config.defaultDeviceId || this.devices.find((device) => device.default)?.id || this.devices[0]?.id || 'default';
    return configured || fallback;
  }

  private buildSessions(): LiveVoiceInputDeviceSession[] {
    const byDevice = new Map<string, LiveVoiceInputConsumer[]>();
    for (const consumer of this.consumers.values()) {
      byDevice.set(consumer.deviceId, [...(byDevice.get(consumer.deviceId) ?? []), consumer]);
    }
    return [...byDevice.entries()].map(([deviceId, consumers]) => ({
      deviceId,
      active: consumers.length > 0,
      consumers,
      wakeTargets: this.buildWakeTargets(deviceId, consumers),
      transcriptSubscriberCount: consumers.filter((consumer) => consumer.kind === 'app_transcript' || consumer.kind === 'agent_transcript' || consumer.kind === 'settings_live_test').length,
    }));
  }

  private buildWakeTargets(deviceId: string, consumers: LiveVoiceInputConsumer[]): LiveVoiceInputWakeTarget[] {
    if (!consumers.some((consumer) => consumer.kind === 'forger_wake_word')) return [];
    return [{
      id: 'forger',
      targetType: 'forger',
      label: 'Forger',
      modelId: this.config.wakeModelId,
      deviceId,
      enabled: true,
      threshold: this.config.wakeThreshold,
      patience: this.config.wakePatience,
      cooldownMs: this.config.wakeCooldownMs,
    }];
  }

  private root(): string {
    return this.deps.path.join(this.deps.getMetadataRoot(), 'live-voice-input');
  }

  private configPath(): string {
    return this.deps.path.join(this.root(), 'config.json');
  }

  private async readConfig(): Promise<LiveVoiceInputConfig> {
    try {
      const raw = JSON.parse(await this.deps.fs.readFile(this.configPath(), 'utf8')) as Partial<LiveVoiceInputConfig>;
      return normalizeLiveVoiceInputConfig(raw);
    } catch {
      return DEFAULT_CONFIG;
    }
  }

  private async writeConfig(): Promise<void> {
    await this.deps.fs.mkdir(this.root(), { recursive: true });
    await this.deps.fs.writeFile(this.configPath(), JSON.stringify(this.config, null, 2), 'utf8');
  }
}

const consumerLabel = (kind: LiveVoiceInputConsumer['kind']): string => {
  if (kind === 'forger_wake_word') return 'Forger wake word';
  if (kind === 'settings_live_test') return 'Live transcription test';
  if (kind === 'agent_transcript') return 'Agent transcript subscriber';
  if (kind === 'app_raw_audio') return 'App raw audio subscriber';
  return 'App transcript subscriber';
};
