import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { WebSocket } from 'ws';

import type {
  SidekickMicrophonePlaybackInput,
  SidekickMicrophonePlaybackResult,
  SidekickMicrophoneRecordingInput,
  SidekickMutationResult,
  SidekickState,
} from '../shared/types';
import {
  SIDEKICK_ACK_TIMEOUT_MS,
  SIDEKICK_MIC_CHANNELS,
  SIDEKICK_MIC_FORMAT,
  SIDEKICK_MIC_MAX_CHUNK_BYTES,
  SIDEKICK_MIC_MAX_WAV_BYTES,
  SIDEKICK_MIC_MIME_TYPE,
  SIDEKICK_MIC_RECENT_LIMIT,
  SIDEKICK_MIC_SAMPLE_RATE,
  WAV_HEADER_BYTES,
  buildPcm16MonoWav,
  decodeCanonicalBase64Chunk,
  isPathInside,
  isSafeCode,
  isStoredSidekickRecording,
  recordingAckKey,
  sidekickFailureState,
  stripRecordingStorageFields,
  writeJsonAtomic,
} from './sidekick-service-helpers';
import type {
  ActiveSidekickRecording,
  PendingRecordingAck,
  SidekickNetworkPayload,
  SidekickRuntimeState,
  StoredSidekickRecord,
  StoredSidekickRecording,
  StoredSidekickRecordingFile,
} from './sidekick-service-helpers';

interface SidekickMicrophoneControllerOptions {
  metadataRoot: string;
  maxRecordingBytes?: number;
  recentRecordingLimit?: number;
  findRecord: (sidekickId: string) => StoredSidekickRecord | undefined;
  getRuntime: (sidekickId: string) => SidekickRuntimeState | undefined;
  buildState: () => SidekickState;
  sendEncrypted: (record: StoredSidekickRecord, runtime: SidekickRuntimeState, payload: unknown) => Promise<void>;
  emit: () => void;
  log: (event: string, payload?: Record<string, unknown>) => Promise<void>;
  onMicrophonePcm?: (event: {
    sidekickId: string;
    recordingId: string;
    chunkSequence: number;
    pcm: Uint8Array;
  }) => void | Promise<void>;
}

export class SidekickMicrophoneController {
  private readonly recordingsIndexPath: string;
  private readonly recordingsFilesDir: string;
  private readonly recordingsTmpDir: string;
  private readonly maxRecordingBytes: number;
  private readonly recentRecordingLimit: number;
  private loaded = false;
  private recordings: StoredSidekickRecording[] = [];

  constructor(private readonly options: SidekickMicrophoneControllerOptions) {
    this.recordingsIndexPath = path.join(options.metadataRoot, 'sidekick-recordings', 'index.json');
    this.recordingsFilesDir = path.join(options.metadataRoot, 'sidekick-recordings', 'files');
    this.recordingsTmpDir = path.join(options.metadataRoot, 'sidekick-recordings', 'tmp');
    this.maxRecordingBytes = options.maxRecordingBytes ?? SIDEKICK_MIC_MAX_WAV_BYTES;
    this.recentRecordingLimit = options.recentRecordingLimit ?? SIDEKICK_MIC_RECENT_LIMIT;
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const parsed = JSON.parse(await fs.readFile(this.recordingsIndexPath, 'utf8')) as StoredSidekickRecordingFile;
      this.recordings = parsed?.version === 1 && Array.isArray(parsed.recordings)
        ? parsed.recordings.filter(isStoredSidekickRecording)
        : [];
    } catch {
      this.recordings = [];
    }
    this.loaded = true;
  }

  summariesFor(sidekickId: string) {
    return this.recordings
      .filter((entry) => entry.sidekickId === sidekickId)
      .map(stripRecordingStorageFields);
  }

  async start(input: SidekickMicrophoneRecordingInput): Promise<SidekickMutationResult> {
    await this.load();
    const record = this.options.findRecord(input.sidekickId);
    if (!record) {
      return sidekickFailureState(this.options.buildState(), 'Ese Sidekick ya no está registrado.', 'sidekick_not_registered');
    }
    const runtime = this.options.getRuntime(record.sidekickId);
    const online = runtime?.socket?.readyState === WebSocket.OPEN && runtime.sessionId && runtime.status === 'online';
    if (!online) {
      return sidekickFailureState(this.options.buildState(), 'El Sidekick está desconectado.', 'sidekick_offline');
    }
    if (!record.capabilities.includes('microphone.record')) {
      return sidekickFailureState(
        this.options.buildState(),
        'Ese Sidekick no informa soporte para grabación de micrófono.',
        'sidekick_microphone_capability_missing',
      );
    }
    if (runtime.microphoneRecording) {
      return sidekickFailureState(
        this.options.buildState(),
        'Ese Sidekick ya tiene una grabación activa.',
        'sidekick_microphone_recording_active',
      );
    }
    if (runtime.speakerPlayback) {
      return sidekickFailureState(this.options.buildState(), 'Espera a que termine el audio antes de usar el micrófono.', 'sidekick_audio_busy');
    }

    const recordingId = randomUUID();
    const persist = input.transient !== true;
    if (persist) await fs.mkdir(this.recordingsTmpDir, { recursive: true });
    runtime.microphoneRecording = {
      sidekickId: record.sidekickId,
      recordingId,
      status: 'starting',
      startedAt: new Date().toISOString(),
      bytes: 0,
      chunks: 0,
      tempPcmPath: persist ? this.stagedPcmPath(recordingId) : '',
      persist,
      nextChunkSequence: 0,
      sampleRate: SIDEKICK_MIC_SAMPLE_RATE,
      channels: SIDEKICK_MIC_CHANNELS,
      format: SIDEKICK_MIC_FORMAT,
    };
    runtime.microphoneErrorMessage = undefined;
    runtime.microphoneErrorCode = undefined;
    this.options.emit();

    const waitForStarted = this.waitForAck(runtime, 'started', recordingId);
    try {
      await this.options.sendEncrypted(record, runtime, {
        v: 1,
        id: randomUUID(),
        cmd: 'microphone.record.start',
        recordingId,
        sampleRate: SIDEKICK_MIC_SAMPLE_RATE,
        channels: SIDEKICK_MIC_CHANNELS,
        format: SIDEKICK_MIC_FORMAT,
      });
      await waitForStarted;
      return { ...this.options.buildState(), success: true };
    } catch (error) {
      this.cancelAck(runtime, 'started', recordingId);
      await this.failActive(runtime, 'No pude iniciar la prueba de micrófono.', 'sidekick_microphone_start_failed');
      void this.options.log('sidekick:microphone_start_failed', {
        sidekickId: record.sidekickId,
        error: error instanceof Error ? error.message : String(error),
      });
      return sidekickFailureState(this.options.buildState(), 'No pude iniciar la prueba de micrófono.', 'sidekick_microphone_start_failed');
    }
  }

  async stop(input: SidekickMicrophoneRecordingInput): Promise<SidekickMutationResult> {
    await this.load();
    const record = this.options.findRecord(input.sidekickId);
    if (!record) {
      return sidekickFailureState(this.options.buildState(), 'Ese Sidekick ya no está registrado.', 'sidekick_not_registered');
    }
    const runtime = this.options.getRuntime(record.sidekickId);
    const active = runtime?.microphoneRecording;
    if (!runtime || !active || active.status === 'starting') {
      return sidekickFailureState(this.options.buildState(), 'Ese Sidekick no tiene una grabación activa.', 'sidekick_microphone_recording_not_active');
    }
    if (!runtime.socket || runtime.socket.readyState !== WebSocket.OPEN || !runtime.sessionId || runtime.status !== 'online') {
      await this.failActive(runtime, 'El Sidekick se desconectó durante la grabación.', 'sidekick_offline');
      return sidekickFailureState(this.options.buildState(), 'El Sidekick está desconectado.', 'sidekick_offline');
    }

    active.status = 'stopping';
    runtime.microphoneErrorMessage = undefined;
    runtime.microphoneErrorCode = undefined;
    this.options.emit();
    const waitForStopped = this.waitForAck(runtime, 'stopped', active.recordingId);
    try {
      await this.options.sendEncrypted(record, runtime, {
        v: 1,
        id: randomUUID(),
        cmd: 'microphone.record.stop',
        recordingId: active.recordingId,
      });
      await waitForStopped;
      return { ...this.options.buildState(), success: true };
    } catch (error) {
      this.cancelAck(runtime, 'stopped', active.recordingId);
      const technicalCode = error instanceof Error ? error.message : 'sidekick_microphone_stop_failed';
      const sampleCountMismatch = technicalCode === 'sidekick_microphone_sample_count_mismatch';
      if (runtime.microphoneRecording?.recordingId === active.recordingId) {
        runtime.microphoneRecording.status = 'recording';
        runtime.microphoneErrorMessage = sampleCountMismatch
          ? 'La grabación de micrófono quedó incompleta y no se guardó.'
          : 'No pude detener la prueba de micrófono.';
        runtime.microphoneErrorCode = sampleCountMismatch
          ? 'sidekick_microphone_sample_count_mismatch'
          : 'sidekick_microphone_stop_failed';
      }
      void this.options.log('sidekick:microphone_stop_failed', { sidekickId: record.sidekickId, error: technicalCode });
      this.options.emit();
      return sidekickFailureState(
        this.options.buildState(),
        sampleCountMismatch ? 'La grabación de micrófono quedó incompleta y no se guardó.' : 'No pude detener la prueba de micrófono.',
        sampleCountMismatch ? technicalCode : 'sidekick_microphone_stop_failed',
      );
    }
  }

  async read(input: SidekickMicrophonePlaybackInput): Promise<SidekickMicrophonePlaybackResult> {
    await this.load();
    const recording = this.recordings.find(
      (entry) => entry.sidekickId === input.sidekickId && entry.recordingId === input.recordingId,
    );
    if (!recording) {
      return { success: false, userMessage: 'No encontré esa grabación.', technicalCode: 'sidekick_microphone_recording_not_found' };
    }
    const filePath = path.join(this.recordingsFilesDir, recording.filename);
    if (!isPathInside(this.recordingsFilesDir, filePath)) {
      return { success: false, userMessage: 'No pude abrir esa grabación.', technicalCode: 'sidekick_microphone_recording_invalid_path' };
    }
    const stat = await fs.stat(filePath).catch(() => null);
    if (!stat || stat.size > this.maxRecordingBytes || stat.size !== recording.sizeBytes) {
      return { success: false, userMessage: 'No pude abrir esa grabación.', technicalCode: 'sidekick_microphone_recording_size_invalid' };
    }
    const bytes = await fs.readFile(filePath);
    return { success: true, mimeType: SIDEKICK_MIC_MIME_TYPE, bytes: new Uint8Array(bytes), sizeBytes: bytes.byteLength };
  }

  async handlePayload(runtime: SidekickRuntimeState, payload: SidekickNetworkPayload): Promise<void> {
    switch (payload.type) {
      case 'microphone.recording.started': await this.handleStarted(runtime, payload); return;
      case 'microphone.recording.chunk': await this.handleChunk(runtime, payload); return;
      case 'microphone.recording.stopped': await this.handleStopped(runtime, payload); return;
      case 'microphone.recording.error': await this.handleError(runtime, payload); return;
      default: return;
    }
  }

  async failActive(runtime: SidekickRuntimeState, message: string, code: string): Promise<void> {
    const active = runtime.microphoneRecording;
    if (active) {
      await this.cleanupActive(runtime, code);
      this.rejectAcks(runtime, active.recordingId, new Error(code));
    }
    runtime.microphoneErrorMessage = message;
    runtime.microphoneErrorCode = code;
    this.options.emit();
  }

  async cleanupActive(runtime: SidekickRuntimeState, code: string): Promise<void> {
    const active = runtime.microphoneRecording;
    if (!active) return;
    runtime.microphoneRecording = undefined;
    this.rejectAcks(runtime, active.recordingId, new Error(code));
    if (active.tempPcmPath) await fs.rm(active.tempPcmPath, { force: true }).catch(() => undefined);
  }

  async forget(sidekickId: string): Promise<void> {
    await this.load();
    const removed = this.recordings.filter((recording) => recording.sidekickId === sidekickId);
    this.recordings = this.recordings.filter((recording) => recording.sidekickId !== sidekickId);
    await Promise.all(removed.map(async (recording) => {
      await fs.rm(path.join(this.recordingsFilesDir, recording.filename), { force: true }).catch(() => undefined);
    }));
    await this.save();
  }

  private async handleStarted(runtime: SidekickRuntimeState, payload: SidekickNetworkPayload): Promise<void> {
    const active = runtime.microphoneRecording;
    if (!active || active.status !== 'starting' || payload.recordingId !== active.recordingId) return;
    if (payload.sampleRate !== SIDEKICK_MIC_SAMPLE_RATE || payload.channels !== SIDEKICK_MIC_CHANNELS || payload.format !== SIDEKICK_MIC_FORMAT) {
      await this.abortActive(runtime, 'El Sidekick inició la grabación con un formato inválido.', 'sidekick_microphone_started_invalid');
      return;
    }
    active.status = 'recording';
    runtime.microphoneErrorMessage = undefined;
    runtime.microphoneErrorCode = undefined;
    this.resolveAck(runtime, 'started', active.recordingId);
  }

  private async handleChunk(runtime: SidekickRuntimeState, payload: SidekickNetworkPayload): Promise<void> {
    const active = runtime.microphoneRecording;
    if (!active || (active.status !== 'recording' && active.status !== 'stopping') || payload.recordingId !== active.recordingId) return;
    if (typeof payload.data !== 'string') {
      await this.abortActive(runtime, 'El Sidekick envió audio inválido.', 'sidekick_microphone_chunk_invalid');
      return;
    }
    const sequence = typeof payload.chunkSequence === 'number' ? payload.chunkSequence : active.nextChunkSequence;
    if (!Number.isInteger(sequence) || sequence !== active.nextChunkSequence) {
      await this.abortActive(runtime, 'El Sidekick envió audio fuera de secuencia.', 'sidekick_microphone_chunk_sequence_invalid');
      return;
    }
    const chunk = decodeCanonicalBase64Chunk(payload.data);
    if (!chunk || chunk.byteLength > SIDEKICK_MIC_MAX_CHUNK_BYTES || chunk.byteLength % 2 !== 0) {
      await this.abortActive(runtime, 'El Sidekick envió audio inválido.', 'sidekick_microphone_chunk_invalid');
      return;
    }
    if (active.bytes + chunk.byteLength + WAV_HEADER_BYTES > this.maxRecordingBytes) {
      await this.abortActive(runtime, 'La prueba de micrófono superó el tamaño máximo.', 'sidekick_microphone_recording_too_large');
      return;
    }
    await this.options.onMicrophonePcm?.({
      sidekickId: active.sidekickId,
      recordingId: active.recordingId,
      chunkSequence: sequence,
      pcm: new Uint8Array(chunk),
    });
    if (active.persist) await fs.appendFile(active.tempPcmPath, chunk);
    active.bytes += chunk.byteLength;
    active.chunks += 1;
    active.nextChunkSequence += 1;
  }

  private async handleStopped(runtime: SidekickRuntimeState, payload: SidekickNetworkPayload): Promise<void> {
    const active = runtime.microphoneRecording;
    if (!active || (active.status !== 'recording' && active.status !== 'stopping') || payload.recordingId !== active.recordingId) return;
    if (typeof payload.sampleCount !== 'number' || !Number.isInteger(payload.sampleCount) || payload.sampleCount < 0) {
      await this.failActive(runtime, 'El Sidekick cerró la grabación con datos inválidos.', 'sidekick_microphone_stopped_invalid');
      return;
    }
    const receivedSampleCount = active.bytes / (active.channels * 2);
    if (!Number.isInteger(receivedSampleCount) || receivedSampleCount !== payload.sampleCount) {
      await this.failActive(runtime, 'La grabación de micrófono quedó incompleta y no se guardó.', 'sidekick_microphone_sample_count_mismatch');
      return;
    }
    if (active.persist) await this.finalize(active, payload.sampleCount);
    runtime.microphoneRecording = undefined;
    runtime.microphoneErrorMessage = undefined;
    runtime.microphoneErrorCode = undefined;
    this.resolveAck(runtime, 'stopped', active.recordingId);
  }

  private async handleError(runtime: SidekickRuntimeState, payload: SidekickNetworkPayload): Promise<void> {
    const active = runtime.microphoneRecording;
    if (!active || payload.recordingId !== active.recordingId) return;
    const code = isSafeCode(payload.code) ? `sidekick_microphone_${String(payload.code)}` : 'sidekick_microphone_error_invalid';
    await this.failActive(runtime, 'El Sidekick informó un error de micrófono.', code);
    this.rejectAcks(runtime, active.recordingId, new Error(code));
  }

  private async abortActive(runtime: SidekickRuntimeState, message: string, code: string): Promise<void> {
    const active = runtime.microphoneRecording;
    await this.failActive(runtime, message, code);
    if (!active) return;
    const record = this.options.findRecord(active.sidekickId);
    if (!record || !runtime.socket || runtime.socket.readyState !== WebSocket.OPEN || !runtime.sessionId) return;
    await this.options.sendEncrypted(record, runtime, {
      v: 1,
      id: randomUUID(),
      cmd: 'microphone.record.stop',
      recordingId: active.recordingId,
    }).catch(() => undefined);
  }

  private waitForAck(runtime: SidekickRuntimeState, kind: PendingRecordingAck['kind'], recordingId: string): Promise<void> {
    const key = recordingAckKey(kind, recordingId);
    const existing = runtime.pendingRecordingAcks.get(key);
    if (existing) return existing.promise;
    let resolveAck!: () => void;
    let rejectAck!: (error: Error) => void;
    const promise = new Promise<void>((resolve, reject) => { resolveAck = resolve; rejectAck = reject; });
    const timeout = setTimeout(() => {
      runtime.pendingRecordingAcks.delete(key);
      rejectAck(new Error(`sidekick_microphone_${kind}_timeout`));
    }, SIDEKICK_ACK_TIMEOUT_MS);
    timeout.unref?.();
    const pending: PendingRecordingAck = { recordingId, kind, timeout, resolve: resolveAck, reject: rejectAck, promise };
    promise.catch(() => undefined);
    runtime.pendingRecordingAcks.set(key, pending);
    return promise;
  }

  private resolveAck(runtime: SidekickRuntimeState, kind: PendingRecordingAck['kind'], recordingId: string): void {
    const key = recordingAckKey(kind, recordingId);
    const pending = runtime.pendingRecordingAcks.get(key);
    if (!pending) return;
    clearTimeout(pending.timeout);
    runtime.pendingRecordingAcks.delete(key);
    pending.resolve();
  }

  private cancelAck(runtime: SidekickRuntimeState, kind: PendingRecordingAck['kind'], recordingId: string): void {
    const key = recordingAckKey(kind, recordingId);
    const pending = runtime.pendingRecordingAcks.get(key);
    if (!pending) return;
    clearTimeout(pending.timeout);
    runtime.pendingRecordingAcks.delete(key);
    pending.reject(new Error(`sidekick_microphone_${kind}_cancelled`));
  }

  private rejectAcks(runtime: SidekickRuntimeState, recordingId: string, error: Error): void {
    for (const [key, pending] of runtime.pendingRecordingAcks.entries()) {
      if (pending.recordingId !== recordingId) continue;
      clearTimeout(pending.timeout);
      runtime.pendingRecordingAcks.delete(key);
      pending.reject(error);
    }
  }

  private stagedPcmPath(recordingId: string): string {
    return path.join(this.recordingsTmpDir, `${recordingId}.pcm`);
  }

  private async finalize(active: ActiveSidekickRecording, sampleCount: number): Promise<void> {
    await this.load();
    await fs.mkdir(this.recordingsFilesDir, { recursive: true });
    const pcm = await fs.readFile(active.tempPcmPath).catch(() => Buffer.alloc(0));
    if (pcm.byteLength !== active.bytes || pcm.byteLength + WAV_HEADER_BYTES > this.maxRecordingBytes) {
      await fs.rm(active.tempPcmPath, { force: true }).catch(() => undefined);
      throw new Error('sidekick_microphone_recording_size_invalid');
    }
    const wav = buildPcm16MonoWav(pcm, SIDEKICK_MIC_SAMPLE_RATE);
    const filename = `${active.recordingId}.wav`;
    const finalPath = path.join(this.recordingsFilesDir, filename);
    const tmpPath = path.join(this.recordingsTmpDir, `${active.recordingId}.wav.tmp`);
    await fs.writeFile(tmpPath, wav);
    await fs.rename(tmpPath, finalPath);
    await fs.rm(active.tempPcmPath, { force: true }).catch(() => undefined);
    const stoppedAt = new Date().toISOString();
    const durationMs = Math.round((sampleCount / SIDEKICK_MIC_SAMPLE_RATE) * 1000);
    this.recordings = [{
      recordingId: active.recordingId,
      sidekickId: active.sidekickId,
      createdAt: active.startedAt,
      stoppedAt,
      durationMs,
      sampleCount,
      sampleRate: SIDEKICK_MIC_SAMPLE_RATE,
      channels: SIDEKICK_MIC_CHANNELS,
      format: SIDEKICK_MIC_FORMAT,
      sizeBytes: wav.byteLength,
      filename,
    }, ...this.recordings.filter((entry) => entry.recordingId !== active.recordingId)];
    await this.prune(active.sidekickId);
    await this.save();
  }

  private async save(): Promise<void> {
    await fs.mkdir(path.dirname(this.recordingsIndexPath), { recursive: true });
    await writeJsonAtomic(this.recordingsIndexPath, { version: 1, recordings: this.recordings } satisfies StoredSidekickRecordingFile);
  }

  private async prune(sidekickId: string): Promise<void> {
    const kept: StoredSidekickRecording[] = [];
    const removed: StoredSidekickRecording[] = [];
    const counts = new Map<string, number>();
    for (const recording of this.recordings.sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))) {
      const count = counts.get(recording.sidekickId) ?? 0;
      if (recording.sidekickId === sidekickId && count >= this.recentRecordingLimit) {
        removed.push(recording);
        continue;
      }
      kept.push(recording);
      counts.set(recording.sidekickId, count + 1);
    }
    this.recordings = kept;
    await Promise.all(removed.map(async (recording) => {
      await fs.rm(path.join(this.recordingsFilesDir, recording.filename), { force: true }).catch(() => undefined);
    }));
  }
}
