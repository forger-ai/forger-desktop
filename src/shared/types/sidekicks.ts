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

export interface SidekickTimeStatus {
  synced: boolean;
  epochMs?: number;
  timeZone?: string;
  utcOffsetMinutes?: number;
  driftMs?: number;
  clockAdjusted?: boolean;
  lastSyncedAt?: string;
}

export type SidekickSpeakerPlaybackStatus = 'idle' | 'starting' | 'playing' | 'stopping' | 'cancelling' | 'error';

export interface SidekickSpeakerPlaybackState {
  status: SidekickSpeakerPlaybackStatus;
  playbackId?: string;
  samplesSent?: number;
  samplesPlayed?: number;
  bufferedSamples?: number;
  underruns?: number;
  errorMessage?: string;
  technicalCode?: string;
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

// Pantallas idle que rotan en el dispositivo. 'custom' requiere una imagen
// cargada; 'limits' muestra el uso de Claude/Codex que empuja Desktop.
export type SidekickIdleScreen = 'eyes' | 'sleep' | 'clock' | 'limits' | 'custom';

export interface SidekickIdleConfig {
  screens: SidekickIdleScreen[];
  rotateSeconds: number;
}

export const SIDEKICK_IDLE_SCREENS: readonly SidekickIdleScreen[] = ['eyes', 'sleep', 'clock', 'limits', 'custom'];
export const SIDEKICK_DEFAULT_IDLE_CONFIG: SidekickIdleConfig = { screens: ['eyes', 'clock'], rotateSeconds: 15 };
// La imagen custom viaja como RGB565 little-endian del tamano exacto del LCD.
export const SIDEKICK_IDLE_IMAGE_WIDTH = 240;
export const SIDEKICK_IDLE_IMAGE_HEIGHT = 240;
export const SIDEKICK_IDLE_IMAGE_BYTES = SIDEKICK_IDLE_IMAGE_WIDTH * SIDEKICK_IDLE_IMAGE_HEIGHT * 2;

export interface SidekickIdleConfigInput {
  sidekickId: string;
  config: SidekickIdleConfig;
}

export interface SidekickIdleImageInput {
  sidekickId: string;
  rgb565: ArrayBuffer;
  previewDataUrl?: string;
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
  personalAgentId?: string;
  battery?: SidekickBatteryStatus;
  time?: SidekickTimeStatus;
  speakerPlayback: SidekickSpeakerPlaybackState;
  microphoneRecording: SidekickMicrophoneRecordingState;
  microphoneRecordings: SidekickMicrophoneRecordingSummary[];
  idleConfig: SidekickIdleConfig;
  idleImagePreviewDataUrl?: string;
  usbPath?: string;
  ipAddress?: string;
  errorMessage?: string;
}

export interface SidekickPersonalAgentInput {
  sidekickId: string;
  personalAgentId?: string;
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

export type SidekickScreenTemplate = 'idle' | 'state' | 'card' | 'transcript';

export interface SidekickScreenInput {
  sidekickId: string;
  template: SidekickScreenTemplate;
  icon?: 'listening' | 'transcribing' | 'thinking' | 'speaking' | 'sleeping' | 'error' | 'bell' | 'info' | 'audio' | 'wifi' | 'warning' | 'ok' | 'battery' | 'settings' | 'home' | 'download' | 'upload' | 'play' | 'pause';
  title?: string;
  body?: string;
  text?: string;
}

export interface SidekickSpeakInput {
  sidekickId: string;
  text: string;
  model: string;
  voice: string;
  speed?: number;
}

export interface SidekickMicrophoneRecordingInput {
  sidekickId: string;
  transient?: boolean;
}

export interface SidekickWakeEvent {
  sidekickId: string;
  wakeId: string;
  model: string;
  wakeWord: string;
  wordIndex: number;
  detectedAtMs: number;
  epochMs?: number;
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

export interface SidekickSpeakerPcmInput {
  sidekickId: string;
  samples: Int16Array;
}

export interface SidekickSpeakerPlaybackResult {
  success: boolean;
  playbackId?: string;
  samplesPlayed?: number;
  underruns?: number;
  droppedChunks?: number;
  userMessage?: string;
  technicalCode?: string;
}

export interface SidekickMutationResult extends SidekickState {
  success: boolean;
}
