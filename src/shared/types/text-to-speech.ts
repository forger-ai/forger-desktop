export type TextToSpeechServiceStatus = 'not_installed' | 'installed' | 'starting' | 'running' | 'stopped' | 'error';

export type TextToSpeechAudioFormat = 'wav' | 'mp3' | 'opus';

export interface TextToSpeechConfig {
  autoStart: boolean;
  maxTextCharacters: number;
  maxConcurrentJobs: number;
  enabledVoices: string[];
  defaultModel?: string;
  defaultVoice?: string;
}

export interface TextToSpeechConfigInput {
  autoStart?: boolean;
  maxTextCharacters?: number;
  maxConcurrentJobs?: number;
  enabledVoices?: string[];
  defaultModel?: string;
  defaultVoice?: string;
}

export interface TextToSpeechModelOption {
  id: string;
  label: string;
  installed: boolean;
}

export interface TextToSpeechVoice {
  id: string;
  model: string;
  label: string;
  language: string;
  locale?: string;
  installed: boolean;
  enabled: boolean;
}

export type TextToSpeechJobStatus = 'queued' | 'running' | 'completed' | 'failed';

export interface TextToSpeechJob {
  id: string;
  status: TextToSpeechJobStatus;
  model: string;
  voice: string;
  createdAt: string;
  updatedAt: string;
  textLength?: number;
  format?: TextToSpeechAudioFormat;
  durationSeconds?: number;
  error?: string;
  technicalCode?: string;
}

export interface TextToSpeechReportableError {
  success: false;
  service: 'text_to_speech';
  operation: string;
  technicalCode: string;
  userMessage: string;
  reportable: boolean;
  details?: Record<string, unknown>;
}

export interface TextToSpeechState {
  status: TextToSpeechServiceStatus;
  installed: boolean;
  running: boolean;
  config: TextToSpeechConfig;
  models: TextToSpeechModelOption[];
  voices: TextToSpeechVoice[];
  queue: TextToSpeechJob[];
  health?: {
    ok: boolean;
    activeJobs: number;
    queuedJobs: number;
  };
  lastError?: string;
}

export interface TextToSpeechSynthesizeInput {
  text: string;
  model: string;
  voice: string;
  speed?: number;
  format?: TextToSpeechAudioFormat;
}

export interface TextToSpeechSynthesizeResult {
  success: boolean;
  text?: string;
  model?: string;
  voice?: string;
  language?: string;
  locale?: string;
  format?: TextToSpeechAudioFormat;
  audioPath?: string;
  audioDataBase64?: string;
  mimeType?: string;
  durationSeconds?: number;
  userMessage?: string;
  technicalCode?: string;
  service?: 'text_to_speech';
  operation?: string;
  reportable?: boolean;
  details?: Record<string, unknown>;
}
