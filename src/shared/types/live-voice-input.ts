import type { FailureDiagnosticFields } from './base';

export type LiveVoiceInputServiceStatus = 'disabled' | 'stt_required' | 'ready' | 'active' | 'error';
export type LiveVoiceInputConsumerKind = 'forger_wake_word' | 'settings_live_test' | 'app_transcript' | 'agent_transcript' | 'app_raw_audio';
export type LiveVoiceInputSourceKind = 'microphone' | 'system_audio';
export type LiveVoiceInputTargetType = 'forger' | 'personal_agent' | 'app_agent';
export type LiveVoiceInputTranscriptTask = 'transcribe' | 'translate';
export type LiveVoiceInputWakeRuntimeState = 'idle' | 'starting' | 'ready' | 'unavailable' | 'detected';

export interface LiveVoiceInputDevice {
  id: string;
  label: string;
  kind: LiveVoiceInputSourceKind;
  groupId?: string;
  default?: boolean;
  enabled: boolean;
  supported: boolean;
  requiresDisplayCapture?: boolean;
}

export interface LiveVoiceInputConsumer {
  id: string;
  kind: LiveVoiceInputConsumerKind;
  label: string;
  deviceId: string;
  createdAt: string;
  targetType?: LiveVoiceInputTargetType;
  targetId?: string;
}

export interface LiveVoiceInputWakeTarget {
  id: string;
  targetType: LiveVoiceInputTargetType;
  targetId?: string;
  label: string;
  modelId: string;
  deviceId?: string;
  enabled: boolean;
  threshold: number;
  patience: number;
  cooldownMs: number;
}

export interface LiveVoiceInputWakeModel {
  id: string;
  displayName: string;
  source: string;
  installedAt: string;
  thresholdDefault: number;
  filePath?: string;
}

export interface LiveVoiceInputConfig {
  defaultDeviceId: string;
  forgerWakeWordEnabled: boolean;
  wakeDeviceId: string;
  wakeModelId: string;
  wakeThreshold: number;
  wakePatience: number;
  wakeCooldownMs: number;
  maxWakeModelsPerDevice: number;
  transcriptTask: LiveVoiceInputTranscriptTask;
  transcriptLanguage?: string;
  maxTranscriptSubscribersPerDevice: number;
  autoStopWhenIdle: boolean;
}

export interface LiveVoiceInputDeviceSession {
  deviceId: string;
  active: boolean;
  consumers: LiveVoiceInputConsumer[];
  wakeTargets: LiveVoiceInputWakeTarget[];
  transcriptSubscriberCount: number;
}

export interface LiveVoiceInputState {
  status: LiveVoiceInputServiceStatus;
  running: boolean;
  sttInstalled: boolean;
  sttRunning: boolean;
  sttRepairRequired?: boolean;
  sttDependencyIssues?: Array<{ code: string; dependency: string; repairable: boolean }>;
  config: LiveVoiceInputConfig;
  devices: LiveVoiceInputDevice[];
  wakeModels: LiveVoiceInputWakeModel[];
  sessions: LiveVoiceInputDeviceSession[];
  wakeRuntime?: LiveVoiceInputWakeRuntime;
  lastWakeEvent?: LiveVoiceInputWakeEvent;
  lastError?: string;
}

export interface LiveVoiceInputWakeRuntime {
  state: LiveVoiceInputWakeRuntimeState;
  modelId: string;
  updatedAt: string;
  technicalCode?: string;
  confidence?: number;
}

export interface LiveVoiceInputConfigInput {
  defaultDeviceId?: string;
  forgerWakeWordEnabled?: boolean;
  wakeDeviceId?: string;
  wakeModelId?: string;
  wakeThreshold?: number;
  wakePatience?: number;
  wakeCooldownMs?: number;
  maxWakeModelsPerDevice?: number;
  transcriptTask?: LiveVoiceInputTranscriptTask;
  transcriptLanguage?: string;
  maxTranscriptSubscribersPerDevice?: number;
  autoStopWhenIdle?: boolean;
}

export interface LiveVoiceInputDeviceListInput {
  devices: Array<{
    id: string;
    label?: string;
    kind?: LiveVoiceInputSourceKind;
    groupId?: string;
    default?: boolean;
    supported?: boolean;
    requiresDisplayCapture?: boolean;
  }>;
}

export interface LiveVoiceInputSessionInput {
  deviceId?: string;
  consumerKind: LiveVoiceInputConsumerKind;
  label?: string;
  targetType?: LiveVoiceInputTargetType;
  targetId?: string;
  task?: LiveVoiceInputTranscriptTask;
  language?: string;
}

export interface LiveVoiceInputSession {
  sessionId: string;
  deviceId: string;
  consumerId: string;
  url: string;
  token: string;
  sampleRate: 16000;
  format: 'pcm_s16le';
  mode?: 'transcript' | 'raw_audio';
  task?: LiveVoiceInputTranscriptTask;
  language?: string;
  wake?: {
    enabled: boolean;
    modelId: string;
    threshold: number;
    patience: number;
    cooldownMs: number;
  };
}

export interface LiveVoiceInputStopInput {
  consumerId?: string;
  deviceId?: string;
  targetId?: string;
}

export interface LiveVoiceInputWakeEvent {
  id: string;
  modelId: string;
  deviceId: string;
  confidence: number;
  targetType: LiveVoiceInputTargetType;
  targetId?: string;
  detectedAt: string;
}

export interface LiveVoiceInputTranscriptEvent {
  type: 'partial_transcript' | 'final_transcript';
  deviceId: string;
  text: string;
  language?: string;
  durationSeconds?: number;
}

export interface LiveVoiceInputMutationResult extends FailureDiagnosticFields {
  success: boolean;
  userMessage?: string;
  state?: LiveVoiceInputState;
}
