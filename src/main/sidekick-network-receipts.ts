import type { SidekickTimeStatus, SidekickWakeEvent } from '../shared/types';
import { isSafeCode, type SidekickNetworkPayload, type SidekickRuntimeState } from './sidekick-service-helpers';

const SPEAKER_ACK_TIMEOUT_MS = 4_000;

export const parseSidekickTimeReceipt = (payload: SidekickNetworkPayload): SidekickTimeStatus => {
  if (
    typeof payload.timeZone !== 'string' ||
    !/^[A-Za-z0-9_+/-]{1,63}$/.test(payload.timeZone) ||
    typeof payload.utcOffsetMinutes !== 'number' ||
    !Number.isInteger(payload.utcOffsetMinutes) ||
    payload.utcOffsetMinutes < -840 ||
    payload.utcOffsetMinutes > 840 ||
    typeof payload.deviceEpochMs !== 'number' ||
    !Number.isSafeInteger(payload.deviceEpochMs)
  ) throw new Error('sidekick_time_sync_receipt_invalid');
  return {
    synced: true,
    epochMs: payload.deviceEpochMs,
    timeZone: payload.timeZone,
    utcOffsetMinutes: payload.utcOffsetMinutes,
    ...(typeof payload.driftMs === 'number' && Number.isFinite(payload.driftMs) ? { driftMs: payload.driftMs } : {}),
    ...(typeof payload.clockAdjusted === 'boolean' ? { clockAdjusted: payload.clockAdjusted } : {}),
    lastSyncedAt: new Date().toISOString(),
  };
};

export const parseSidekickWakeReceipt = (payload: SidekickNetworkPayload): SidekickWakeEvent => {
  if (
    typeof payload.sidekickId !== 'string' ||
    typeof payload.wakeId !== 'string' ||
    !/^[A-Za-z0-9_-]{1,64}$/.test(payload.wakeId) ||
    typeof payload.model !== 'string' ||
    !payload.model.trim() ||
    typeof payload.wakeWord !== 'string' ||
    !payload.wakeWord.trim() ||
    typeof payload.wordIndex !== 'number' ||
    !Number.isInteger(payload.wordIndex) ||
    payload.wordIndex < 1 ||
    typeof payload.detectedAtMs !== 'number' ||
    !Number.isInteger(payload.detectedAtMs) ||
    payload.detectedAtMs < 0
  ) throw new Error('sidekick_wake_event_invalid');
  return {
    sidekickId: payload.sidekickId,
    wakeId: payload.wakeId,
    model: payload.model,
    wakeWord: payload.wakeWord,
    wordIndex: payload.wordIndex,
    detectedAtMs: payload.detectedAtMs,
    ...(typeof payload.epochMs === 'number' && Number.isSafeInteger(payload.epochMs) ? { epochMs: payload.epochMs } : {}),
  };
};

export class SidekickSpeakerReceipts {
  public constructor(private readonly ackTimeoutMs = SPEAKER_ACK_TIMEOUT_MS) {}

  // Los receipts que no calzan con una reproduccion activa se ignoran en vez
  // de lanzar: un `stopped` o `progress` tardio (p. ej. tras un cancel por
  // timeout) es trafico esperado, y lanzar aqui cierra el socket completo del
  // Sidekick. Solo un receipt malformado de la reproduccion activa falla la
  // reproduccion, nunca la conexion.
  public handleStarted(runtime: SidekickRuntimeState, payload: SidekickNetworkPayload): void {
    const active = runtime.speakerPlayback;
    if (!active || active.status !== 'starting' || payload.playbackId !== active.playbackId) {
      return;
    }
    if (
      payload.maxChunkSamples !== 1024 || typeof payload.queueDepth !== 'number' ||
      !Number.isInteger(payload.queueDepth) || payload.queueDepth < 1 || payload.queueDepth > 32
    ) {
      this.reject(runtime, new Error('sidekick_speaker_started_invalid'));
      return;
    }
    active.queueDepth = payload.queueDepth;
    if (payload.maxInFlightChunks === undefined) {
      // Firmware anterior no anunciaba la capacidad del transporte. Lockstep
      // es el unico fallback seguro porque queueDepth describe la cola de
      // audio, no la cola WebSocket que recibe los comandos.
      active.maxInFlightChunks = 1;
    } else if (
      typeof payload.maxInFlightChunks !== 'number' ||
      !Number.isInteger(payload.maxInFlightChunks) ||
      payload.maxInFlightChunks < 1 ||
      payload.maxInFlightChunks > payload.queueDepth
    ) {
      this.reject(runtime, new Error('sidekick_speaker_started_invalid'));
      return;
    } else {
      active.maxInFlightChunks = payload.maxInFlightChunks;
    }
    active.status = 'playing';
    this.resolve(runtime, `started:${active.playbackId}`);
  }

  public handleProgress(runtime: SidekickRuntimeState, payload: SidekickNetworkPayload): void {
    const active = runtime.speakerPlayback;
    if (
      !active || (active.status !== 'playing' && active.status !== 'stopping') ||
      payload.playbackId !== active.playbackId
    ) {
      return;
    }
    if (
      typeof payload.lastChunkSequence !== 'number' || !Number.isInteger(payload.lastChunkSequence) || payload.lastChunkSequence < 0 ||
      typeof payload.bufferedSamples !== 'number' || !Number.isInteger(payload.bufferedSamples) || payload.bufferedSamples < 0 ||
      typeof payload.underruns !== 'number' || !Number.isInteger(payload.underruns) || payload.underruns < 0
    ) {
      this.reject(runtime, new Error('sidekick_speaker_progress_invalid'));
      return;
    }
    active.bufferedSamples = payload.bufferedSamples;
    active.underruns = payload.underruns;
    this.resolve(runtime, `progress:${active.playbackId}:${payload.lastChunkSequence}`);
  }

  public handleStopped(runtime: SidekickRuntimeState, payload: SidekickNetworkPayload): void {
    const active = runtime.speakerPlayback;
    const spontaneousCancellation = payload.cancelled === true && Boolean(
      active && (active.status === 'starting' || active.status === 'playing'),
    );
    if (
      !active || (!spontaneousCancellation && active.status !== 'stopping' && active.status !== 'cancelling') ||
      payload.playbackId !== active.playbackId
    ) {
      return;
    }
    if (
      typeof payload.samplesPlayed !== 'number' || !Number.isInteger(payload.samplesPlayed) || payload.samplesPlayed < 0 ||
      typeof payload.underruns !== 'number' || !Number.isInteger(payload.underruns) || payload.underruns < 0 ||
      typeof payload.droppedChunks !== 'number' || !Number.isInteger(payload.droppedChunks) || payload.droppedChunks < 0
    ) {
      this.reject(runtime, new Error('sidekick_speaker_stopped_invalid'));
      return;
    }
    if (active.status === 'stopping' && payload.samplesPlayed !== active.samplesSent) {
      this.reject(runtime, new Error('sidekick_speaker_sample_count_mismatch'));
      return;
    }
    active.samplesPlayed = payload.samplesPlayed;
    active.underruns = payload.underruns;
    active.droppedChunks = payload.droppedChunks;
    if (spontaneousCancellation) {
      runtime.speakerPlayback = undefined;
      this.reject(runtime, new Error('sidekick_speaker_playback_interrupted'));
      return;
    }
    this.resolve(runtime, `stopped:${active.playbackId}`);
  }

  public handleError(runtime: SidekickRuntimeState, payload: SidekickNetworkPayload): void {
    const active = runtime.speakerPlayback;
    if (!active || payload.playbackId !== active.playbackId) {
      return;
    }
    if (!isSafeCode(payload.code)) {
      this.reject(runtime, new Error('sidekick_speaker_error_invalid'));
      return;
    }
    this.reject(runtime, new Error(`sidekick_speaker_${String(payload.code)}`));
  }

  public wait(runtime: SidekickRuntimeState, key: string): Promise<void> {
    const existing = runtime.pendingSpeakerAcks.get(key);
    if (existing) {
      clearTimeout(existing.timeout);
      runtime.pendingSpeakerAcks.delete(key);
      existing.reject(new Error('sidekick_speaker_ack_replaced'));
    }
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        runtime.pendingSpeakerAcks.delete(key);
        reject(new Error('sidekick_speaker_ack_timeout'));
      }, this.ackTimeoutMs);
      timeout.unref?.();
      runtime.pendingSpeakerAcks.set(key, { key, timeout, resolve, reject });
    });
  }

  public reject(runtime: SidekickRuntimeState, error: Error): void {
    for (const [key, pending] of runtime.pendingSpeakerAcks.entries()) {
      clearTimeout(pending.timeout);
      runtime.pendingSpeakerAcks.delete(key);
      pending.reject(error);
    }
  }

  private resolve(runtime: SidekickRuntimeState, key: string): void {
    const pending = runtime.pendingSpeakerAcks.get(key);
    if (!pending) return;
    clearTimeout(pending.timeout);
    runtime.pendingSpeakerAcks.delete(key);
    pending.resolve();
  }
}
