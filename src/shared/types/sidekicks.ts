export type SidekickStatus = 'offline' | 'usb_detected' | 'pairing' | 'wifi_pending' | 'online' | 'error';

export interface SidekickUsbDevice {
  path: string;
  manufacturer?: string;
  serialNumber?: string;
  vendorId?: string;
  productId?: string;
  friendlyName?: string;
  likelySidekick: boolean;
}

export interface SidekickBatteryStatus {
  levelPercent: number;
  charging: boolean;
  voltageMv?: number;
}

export type SidekickMicrophoneRecordingStatus = 'idle' | 'starting' | 'recording' | 'stopping' | 'error';

export interface SidekickMicrophoneRecordingState {
  status: SidekickMicrophoneRecordingStatus;
  recordingId?: string;
  startedAt?: string;
  bytes?: number;
  errorMessage?: string;
  technicalCode?: string;
}

export interface SidekickMicrophoneRecordingSummary {
  recordingId: string;
  sidekickId: string;
  createdAt: string;
  stoppedAt: string;
  durationMs: number;
  sampleCount: number;
  sampleRate: 16000;
  channels: 1;
  format: 'pcm_s16le';
  sizeBytes: number;
}

export interface SidekickSummary {
  sidekickId: string;
  name: string;
  hostname?: string;
  status: SidekickStatus;
  pairedAt?: string;
  lastSeenAt?: string;
  firmwareVersion?: string;
  capabilities: string[];
  battery?: SidekickBatteryStatus;
  microphoneRecording: SidekickMicrophoneRecordingState;
  microphoneRecordings: SidekickMicrophoneRecordingSummary[];
  usbPath?: string;
  ipAddress?: string;
  errorMessage?: string;
}

export interface SidekickState {
  desktopId: string;
  keyFingerprint?: string;
  servicePort?: number;
  sidekicks: SidekickSummary[];
  detectedUsb: SidekickUsbDevice[];
  userMessage?: string;
  technicalCode?: string;
}

export interface SidekickConfigureInput {
  portPath?: string;
  name: string;
  ssid: string;
  password: string;
}

export interface SidekickDisplayInput {
  sidekickId: string;
  mode: 'append' | 'set' | 'clear';
  text?: string;
}

export interface SidekickMicrophoneRecordingInput {
  sidekickId: string;
}

export interface SidekickMicrophonePlaybackInput {
  sidekickId: string;
  recordingId: string;
}

export interface SidekickMicrophonePlaybackResult {
  success: boolean;
  mimeType?: 'audio/wav';
  bytes?: Uint8Array;
  sizeBytes?: number;
  userMessage?: string;
  technicalCode?: string;
}

export interface SidekickMutationResult extends SidekickState {
  success: boolean;
}
