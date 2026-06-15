export type AudioRuntimeInputDeviceKind = 'microphone' | 'system_audio';
export type AudioRuntimeOutputDeviceKind = 'speaker';

export interface AudioRuntimeInputDevice {
  id: string;
  label: string;
  kind: AudioRuntimeInputDeviceKind;
  groupId?: string;
  default: boolean;
  supported: boolean;
  requiresDisplayCapture?: boolean;
}

export interface AudioRuntimeOutputDevice {
  id: string;
  label: string;
  kind: AudioRuntimeOutputDeviceKind;
  groupId?: string;
  default: boolean;
  supported: boolean;
}

export interface AudioRuntimeDevices {
  inputDevices: AudioRuntimeInputDevice[];
  outputDevices: AudioRuntimeOutputDevice[];
}

export type AudioPlaybackStatus = 'queued' | 'running' | 'completed' | 'failed' | 'canceled';

export interface AudioPlaybackSummary {
  playbackId: string;
  appId: string;
  status: AudioPlaybackStatus;
  textLength: number;
  model: string;
  voice: string;
  outputDeviceId?: string;
  createdAt: string;
  updatedAt: string;
  durationSeconds?: number;
  userMessage?: string;
  technicalCode?: string;
}

export type AudioRuntimeBrokerRequest =
  | {
    requestId: string;
    type: 'list_devices';
  }
  | {
    requestId: string;
    type: 'play_audio';
    playbackId: string;
    audioDataBase64: string;
    mimeType: string;
    outputDeviceId?: string;
  }
  | {
    requestId: string;
    type: 'cancel_playback';
    playbackId: string;
  };

export interface AudioRuntimeBrokerResponse {
  requestId: string;
  success: boolean;
  result?: unknown;
  error?: string;
}
