export type WakeWordServiceStatus = 'not_installed' | 'installed' | 'starting' | 'listening' | 'ready' | 'detected' | 'stopped' | 'error';

export type WakeWordRuntimeState = 'idle' | 'starting' | 'waiting_for_audio_session' | 'ready' | 'unavailable' | 'detected';

export interface WakeWordConfig {
  enabled: boolean;
  deviceId: string;
  modelId: string;
  threshold: number;
  patience: number;
  cooldownMs: number;
}

export interface WakeWordModel {
  id: string;
  displayName: string;
  source: string;
  installedAt: string;
  thresholdDefault: number;
  filePath?: string;
}

export interface WakeWordRuntime {
  state: WakeWordRuntimeState;
  modelId: string;
  updatedAt: string;
  confidence?: number;
  technicalCode?: string;
}

export interface WakeWordDiagnosticEvent {
  event: string;
  modelId?: string;
  deviceId?: string;
  technicalCode?: string;
  generation?: number;
  socketState?: string;
  audioTrackCount?: number;
  sampleRate?: number;
  frameBytes?: number;
}

export interface WakeWordDetectionEvent {
  id: string;
  deviceId: string;
  modelId: string;
  confidence: number;
  detectedAt: string;
}

export interface WakeWordState {
  status: WakeWordServiceStatus;
  installed: boolean;
  running: boolean;
  repairRequired: boolean;
  config: WakeWordConfig;
  models: WakeWordModel[];
  runtime: WakeWordRuntime;
  dependencyIssues: Array<{ code: string; dependency: string; repairable: boolean }>;
  lastDetection?: WakeWordDetectionEvent;
  session?: WakeWordSession;
  lastError?: string;
}

export interface WakeWordConfigInput {
  enabled?: boolean;
  deviceId?: string;
  modelId?: string;
  threshold?: number;
  patience?: number;
  cooldownMs?: number;
}

export interface WakeWordSession {
  sessionId: string;
  url: string;
  token: string;
  sampleRate: 16000;
  format: 'pcm_s16le';
  config: WakeWordConfig;
}
