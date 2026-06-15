import { randomUUID } from 'node:crypto';
import type { BrowserWindow, IpcMain } from 'electron';

import type { IPC_CHANNELS as IpcChannels } from '../shared/ipc';
import type {
  AudioRuntimeBrokerRequest,
  AudioRuntimeBrokerResponse,
  AudioRuntimeDevices,
} from '../shared/types';

interface AudioRuntimeBrokerDeps {
  IPC_CHANNELS: typeof IpcChannels;
  ipcMain: IpcMain;
  getMainWindow: () => BrowserWindow | null;
  appendInstallLog: (event: string, payload?: Record<string, unknown>) => Promise<void>;
}

interface PendingBrokerRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

type AudioRuntimeBrokerRequestInput =
  | { type: 'list_devices' }
  | {
    type: 'play_audio';
    playbackId: string;
    audioDataBase64: string;
    mimeType: string;
    outputDeviceId?: string;
  }
  | {
    type: 'cancel_playback';
    playbackId: string;
  };

const REQUEST_TIMEOUT_MS = 30_000;
const PLAYBACK_TIMEOUT_MS = 10 * 60_000;

export class AudioRuntimeBroker {
  private readonly pending = new Map<string, PendingBrokerRequest>();
  private registered = false;

  constructor(private readonly deps: AudioRuntimeBrokerDeps) {}

  registerIpcHandlers(): void {
    if (this.registered) return;
    this.registered = true;
    this.deps.ipcMain.handle(this.deps.IPC_CHANNELS.audioRuntimeBrokerResponse, async (_event, response: AudioRuntimeBrokerResponse) => {
      this.resolveResponse(response);
    });
  }

  async listDevices(): Promise<AudioRuntimeDevices> {
    return normalizeDevices(await this.request({ type: 'list_devices' }, REQUEST_TIMEOUT_MS));
  }

  async playAudio(input: {
    playbackId: string;
    audioDataBase64: string;
    mimeType: string;
    outputDeviceId?: string;
  }): Promise<{ success: boolean; durationSeconds?: number; error?: string }> {
    const result = await this.request({
      type: 'play_audio',
      playbackId: input.playbackId,
      audioDataBase64: input.audioDataBase64,
      mimeType: input.mimeType,
      ...(input.outputDeviceId ? { outputDeviceId: input.outputDeviceId } : {}),
    }, PLAYBACK_TIMEOUT_MS);
    return normalizePlaybackResult(result);
  }

  async cancelPlayback(playbackId: string): Promise<void> {
    await this.request({ type: 'cancel_playback', playbackId }, REQUEST_TIMEOUT_MS).catch((error) => {
      void this.deps.appendInstallLog('audio_runtime_broker:cancel_failed', {
        playbackId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  stop(): void {
    for (const [requestId, pending] of this.pending.entries()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('audio_runtime_broker_stopped'));
      this.pending.delete(requestId);
    }
  }

  private async request(input: AudioRuntimeBrokerRequestInput, timeoutMs: number): Promise<unknown> {
    const window = this.deps.getMainWindow();
    if (!window || window.isDestroyed()) {
      throw new Error('audio_runtime_renderer_unavailable');
    }
    const requestId = randomUUID();
    const payload = { ...input, requestId } as AudioRuntimeBrokerRequest;
    const promise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error('audio_runtime_broker_timeout'));
      }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
    });
    window.webContents.send(this.deps.IPC_CHANNELS.audioRuntimeBrokerRequest, payload);
    return await promise;
  }

  private resolveResponse(response: AudioRuntimeBrokerResponse): void {
    const pending = this.pending.get(response.requestId);
    if (!pending) return;
    this.pending.delete(response.requestId);
    clearTimeout(pending.timer);
    if (response.success) {
      pending.resolve(response.result);
      return;
    }
    pending.reject(new Error(response.error || 'audio_runtime_broker_failed'));
  }
}

const normalizeDevices = (value: unknown): AudioRuntimeDevices => {
  const record = isRecord(value) ? value : {};
  return {
    inputDevices: Array.isArray(record.inputDevices) ? record.inputDevices.map(normalizeInputDevice).filter(Boolean) as AudioRuntimeDevices['inputDevices'] : [],
    outputDevices: Array.isArray(record.outputDevices) ? record.outputDevices.map(normalizeOutputDevice).filter(Boolean) as AudioRuntimeDevices['outputDevices'] : [],
  };
};

const normalizeInputDevice = (value: unknown): AudioRuntimeDevices['inputDevices'][number] | null => {
  if (!isRecord(value)) return null;
  const id = cleanString(value.id);
  if (!id) return null;
  const kind = value.kind === 'system_audio' ? 'system_audio' : 'microphone';
  return {
    id,
    label: cleanString(value.label) || (kind === 'system_audio' ? 'System audio' : 'Microphone'),
    kind,
    ...(cleanString(value.groupId) ? { groupId: cleanString(value.groupId) } : {}),
    default: value.default === true,
    supported: value.supported !== false,
    ...(value.requiresDisplayCapture === true ? { requiresDisplayCapture: true } : {}),
  };
};

const normalizeOutputDevice = (value: unknown): AudioRuntimeDevices['outputDevices'][number] | null => {
  if (!isRecord(value)) return null;
  const id = cleanString(value.id);
  if (!id) return null;
  return {
    id,
    label: cleanString(value.label) || 'Speaker',
    kind: 'speaker',
    ...(cleanString(value.groupId) ? { groupId: cleanString(value.groupId) } : {}),
    default: value.default === true,
    supported: value.supported !== false,
  };
};

const normalizePlaybackResult = (value: unknown): { success: boolean; durationSeconds?: number; error?: string } => {
  const record = isRecord(value) ? value : {};
  return {
    success: record.success === true,
    ...(Number.isFinite(record.durationSeconds) ? { durationSeconds: Number(record.durationSeconds) } : {}),
    ...(cleanString(record.error) ? { error: cleanString(record.error) } : {}),
  };
};

const cleanString = (value: unknown): string => typeof value === 'string' ? value.trim() : '';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);
