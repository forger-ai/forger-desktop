export type SpeechToTextServiceStatus = 'not_installed' | 'installed' | 'starting' | 'running' | 'stopped' | 'error';

export type SpeechToTextJobStatus = 'queued' | 'running' | 'completed' | 'failed';

export type SpeechToTextTask = 'transcribe' | 'translate';
export type SpeechToTextModelWorkerStatus = 'stopped' | 'starting' | 'ready' | 'busy' | 'idle' | 'stopping' | 'error';

export interface SpeechToTextConfig {
  model: string;
  maxConcurrentJobs: number;
  maxRealtimeSessions: number;
  autoStart: boolean;
}

export interface SpeechToTextModelOption {
  id: string;
  installed: boolean;
}

export interface SpeechToTextDependencyIssue {
  code: string;
  dependency: string;
  repairable: boolean;
}

export interface SpeechToTextJob {
  id: string;
  task: SpeechToTextTask;
  path: string;
  status: SpeechToTextJobStatus;
  createdAt: string;
  updatedAt: string;
  durationSeconds?: number;
  sizeBytes?: number;
  language?: string;
  model?: string;
  text?: string;
  error?: string;
  technicalCode?: string;
}

export interface SpeechToTextReportableError {
  success: false;
  service: 'speech_to_text';
  operation: string;
  technicalCode: string;
  userMessage: string;
  reportable: boolean;
  details?: Record<string, unknown>;
}

export interface SpeechToTextProcessedFile {
  path: string;
  task: SpeechToTextTask;
  processedAt: string;
  durationSeconds?: number;
  sizeBytes?: number;
  language?: string;
  model?: string;
  textPreview?: string;
}

export interface SpeechToTextState {
  status: SpeechToTextServiceStatus;
  installed: boolean;
  running: boolean;
  config: SpeechToTextConfig;
  modelOptions: SpeechToTextModelOption[];
  dependencyIssues: SpeechToTextDependencyIssue[];
  repairRequired: boolean;
  queue: SpeechToTextJob[];
  processedFiles: SpeechToTextProcessedFile[];
  modelWorkers: SpeechToTextModelWorker[];
  health?: {
    ok: boolean;
    model: string;
    activeJobs: number;
    queuedJobs: number;
    activeRealtimeSessions?: number;
    realtimeQueueDepth?: number;
    realtimeActiveJobs?: number;
    lastRealtimeFactor?: number;
    vadMode?: string;
  };
  lastError?: string;
}

export interface SpeechToTextModelWorker {
  model: string;
  status: SpeechToTextModelWorkerStatus;
  pinned: boolean;
  activeJobs: number;
  queuedJobs: number;
  activeRealtimeSessions?: number;
  lastUsedAt?: string;
  technicalCode?: string;
}

export interface SpeechToTextConfigInput {
  model?: string;
  maxConcurrentJobs?: number;
  maxRealtimeSessions?: number;
  autoStart?: boolean;
}

export interface SpeechToTextRealtimeSession {
  url: string;
  token: string;
  sampleRate: 16000;
  format: 'pcm_s16le';
}

export interface SpeechToTextProcessInput {
  path: string;
  task?: SpeechToTextTask;
  language?: string;
  model?: string;
}

export interface SpeechToTextUploadInput {
  filename: string;
  mimeType?: string;
  data: ArrayBuffer;
  task?: SpeechToTextTask;
  language?: string;
  model?: string;
}

export interface SpeechToTextProcessResult {
  success: boolean;
  job?: SpeechToTextJob;
  text?: string;
  language?: string;
  durationSeconds?: number;
  userMessage?: string;
  technicalCode?: string;
  service?: 'speech_to_text';
  operation?: string;
  reportable?: boolean;
  details?: Record<string, unknown>;
}
