import type { WakeWordDiagnosticEvent, WakeWordRuntime, WakeWordSession, WakeWordState } from '@shared/types';

type WakeWordClientApi = {
  wakeWordCreateSession: () => Promise<WakeWordSession>;
  wakeWordRecordDetected: (input: { deviceId?: string; modelId?: string; confidence?: number }) => Promise<WakeWordState>;
  wakeWordRecordDiagnostic: (input: WakeWordDiagnosticEvent) => Promise<WakeWordState>;
  wakeWordRecordReady: (input: Partial<WakeWordRuntime>) => Promise<WakeWordState>;
  wakeWordRecordUnavailable: (input: Partial<WakeWordRuntime>) => Promise<WakeWordState>;
};

type ActiveWakeWordSession = {
  context: AudioContext;
  deviceId: string;
  generation: number;
  processor: ScriptProcessorNode;
  source: MediaStreamAudioSourceNode;
  socket: WebSocket;
  stream: MediaStream;
  wakeSignature: string;
};

const floatToPcm16 = (input: Float32Array, inputSampleRate: number): ArrayBuffer => {
  const ratio = inputSampleRate / 16000;
  const length = Math.max(1, Math.floor(input.length / ratio));
  const output = new Int16Array(length);
  for (let index = 0; index < length; index += 1) {
    const sample = input[Math.min(input.length - 1, Math.floor(index * ratio))] ?? 0;
    output[index] = Math.max(-1, Math.min(1, sample)) * 0x7fff;
  }
  return output.buffer;
};

const isSystemAudioWakeWordDevice = (deviceId?: string): boolean =>
  deviceId === 'system-audio:default' || deviceId?.startsWith('system-audio:') === true;

const openWakeWordMediaStream = async (deviceId?: string): Promise<MediaStream> => {
  if (isSystemAudioWakeWordDevice(deviceId)) {
    if (!navigator.mediaDevices.getDisplayMedia) {
      throw new Error('system_audio_capture_unavailable');
    }
    const stream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
    if (stream.getAudioTracks().length === 0) {
      stream.getTracks().forEach((track) => track.stop());
      throw new Error('system_audio_track_missing');
    }
    return stream;
  }
  const constraints: MediaStreamConstraints = deviceId && deviceId !== 'default'
    ? { audio: { deviceId: { exact: deviceId } } }
    : { audio: true };
  return await navigator.mediaDevices.getUserMedia(constraints);
};

const wakeSignatureForState = (state: WakeWordState): string => {
  const deviceId = state.config.deviceId || 'default';
  return JSON.stringify({
    deviceId,
    modelId: state.config.modelId,
    threshold: state.config.threshold,
    patience: state.config.patience,
    cooldownMs: state.config.cooldownMs,
  });
};

export class WakeWordClientRunner {
  private activeSession: ActiveWakeWordSession | null = null;
  private disposed = false;
  private generation = 0;
  private pendingStart: { promise: Promise<void>; wakeSignature: string } | null = null;

  constructor(private readonly api: WakeWordClientApi) {}

  async ensure(state: WakeWordState): Promise<void> {
    if (this.disposed) return;
    if (!state.running || !state.config.enabled) {
      this.stop('disabled_or_not_running');
      return;
    }

    const wakeSignature = wakeSignatureForState(state);
    if (this.activeSession?.wakeSignature === wakeSignature) return;
    if (this.pendingStart?.wakeSignature === wakeSignature) {
      await this.pendingStart.promise;
      return;
    }

    if (this.activeSession) {
      this.stop('config_changed');
    }

    const generation = ++this.generation;
    const promise = this.start(state, generation, wakeSignature);
    this.pendingStart = { wakeSignature, promise };
    await promise;
  }

  stop(reason = 'stop_requested'): void {
    this.generation += 1;
    const current = this.activeSession;
    this.pendingStart = null;
    if (!current) return;
    this.recordDiagnostic('stop_requested', current.generation, current.deviceId, current.wakeSignature, { technicalCode: reason });
    this.closeSession(current, true);
    this.activeSession = null;
  }

  dispose(): void {
    this.disposed = true;
    this.stop('disposed');
  }

  private async start(state: WakeWordState, generation: number, wakeSignature: string): Promise<void> {
    const configuredDeviceId = state.config.deviceId || 'default';
    let readyTimeout: number | undefined;
    let transferred = false;
    let firstAudioFrameSent = false;
    let startSent = false;
    let createdSession: ActiveWakeWordSession | null = null;

    const clearReadyTimeout = () => {
      if (readyTimeout !== undefined) {
        window.clearTimeout(readyTimeout);
        readyTimeout = undefined;
      }
    };

    try {
      this.recordDiagnostic('ensure_start', generation, configuredDeviceId, wakeSignature, { socketState: 'new' });
      const session = await this.api.wakeWordCreateSession();
      if (!this.isCurrent(generation)) {
        this.recordDiagnostic('stale_generation_ignored', generation, configuredDeviceId, wakeSignature, { technicalCode: 'after_session_created' });
        return;
      }

      const sessionDeviceId = session.config.deviceId || configuredDeviceId;
      this.recordDiagnostic('session_created', generation, sessionDeviceId, wakeSignature);
      const stream = await openWakeWordMediaStream(sessionDeviceId);
      if (!this.isCurrent(generation)) {
        this.recordDiagnostic('stale_generation_ignored', generation, sessionDeviceId, wakeSignature, { technicalCode: 'after_media_stream_opened' });
        stream.getTracks().forEach((track) => track.stop());
        return;
      }

      this.recordDiagnostic('media_stream_opened', generation, sessionDeviceId, wakeSignature, {
        audioTrackCount: stream.getAudioTracks().length,
      });
      const context = new AudioContext();
      const source = context.createMediaStreamSource(stream);
      const processor = context.createScriptProcessor(4096, 1, 1);
      const activeSocket = new WebSocket(`${session.url}?token=${encodeURIComponent(session.token)}`);
      activeSocket.binaryType = 'arraybuffer';
      const activeSession: ActiveWakeWordSession = {
        context,
        deviceId: sessionDeviceId,
        generation,
        processor,
        source,
        socket: activeSocket,
        stream,
        wakeSignature,
      };
      createdSession = activeSession;

      activeSocket.onerror = () => {
        if (!this.isCurrent(generation)) {
          this.recordDiagnostic('stale_generation_ignored', generation, sessionDeviceId, wakeSignature, { technicalCode: 'socket_error' });
          return;
        }
        this.recordDiagnostic('socket_error', generation, sessionDeviceId, wakeSignature, { socketState: String(activeSocket.readyState) });
        void this.api.wakeWordRecordUnavailable({
          modelId: state.config.modelId,
          technicalCode: 'wake_websocket_failed',
        });
      };

      activeSocket.onopen = () => {
        if (!this.isCurrent(generation)) {
          this.recordDiagnostic('stale_generation_ignored', generation, sessionDeviceId, wakeSignature, { technicalCode: 'socket_open' });
          return;
        }
        this.recordDiagnostic('socket_open', generation, sessionDeviceId, wakeSignature, { socketState: String(activeSocket.readyState) });
        try {
          activeSocket.send(JSON.stringify({
            type: 'start',
            sampleRate: session.sampleRate,
            format: session.format,
            modelId: session.config.modelId,
            threshold: session.config.threshold,
            patience: session.config.patience,
            cooldownMs: session.config.cooldownMs,
          }));
          startSent = true;
          this.recordDiagnostic('start_sent', generation, sessionDeviceId, wakeSignature, {
            modelId: session.config.modelId,
            sampleRate: session.sampleRate,
            socketState: String(activeSocket.readyState),
          });
        } catch (error) {
          const technicalCode = error instanceof Error && error.message ? error.message : 'wake_start_send_failed';
          this.recordDiagnostic('start_send_failed', generation, sessionDeviceId, wakeSignature, { technicalCode });
          void this.api.wakeWordRecordUnavailable({ modelId: session.config.modelId, technicalCode: 'wake_start_send_failed' });
          activeSocket.close();
          return;
        }
        readyTimeout = window.setTimeout(() => {
          if (!this.isCurrent(generation)) return;
          this.recordDiagnostic('ready_timeout', generation, sessionDeviceId, wakeSignature, {
            modelId: session.config.modelId,
            socketState: String(activeSocket.readyState),
          });
          void this.api.wakeWordRecordUnavailable({
            modelId: session.config.modelId,
            technicalCode: 'wake_ready_timeout',
          });
        }, 15_000);
      };

      let lastConfidenceReportAt = 0;
      activeSocket.onmessage = (event) => {
        if (!this.isCurrent(generation)) return;
        try {
          const payload = JSON.parse(String(event.data)) as { type?: string; modelId?: string; confidence?: number; technicalCode?: string };
          if (payload.type === 'wake_ready') {
            clearReadyTimeout();
            this.recordDiagnostic('ready_received', generation, sessionDeviceId, wakeSignature, { modelId: payload.modelId ?? state.config.modelId });
            void this.api.wakeWordRecordReady({ modelId: payload.modelId ?? state.config.modelId });
            return;
          }
          if (payload.type === 'wake_confidence') {
            const now = Date.now();
            if (now - lastConfidenceReportAt < 500) return;
            lastConfidenceReportAt = now;
            void this.api.wakeWordRecordReady({
              modelId: payload.modelId ?? state.config.modelId,
              confidence: payload.confidence ?? 0,
            });
            return;
          }
          if (payload.type === 'wake_unavailable') {
            clearReadyTimeout();
            this.recordDiagnostic('unavailable_received', generation, sessionDeviceId, wakeSignature, {
              modelId: payload.modelId ?? state.config.modelId,
              technicalCode: payload.technicalCode,
            });
            void this.api.wakeWordRecordUnavailable({
              modelId: payload.modelId ?? state.config.modelId,
              technicalCode: payload.technicalCode,
            });
            return;
          }
          if (payload.type === 'wake_detected') {
            this.recordDiagnostic('detected_received', generation, sessionDeviceId, wakeSignature, { modelId: payload.modelId ?? state.config.modelId });
            void this.api.wakeWordRecordDetected({
              deviceId: sessionDeviceId,
              modelId: payload.modelId ?? state.config.modelId,
              confidence: payload.confidence ?? 1,
            });
          }
        } catch {
          // Wake detection frames are local diagnostics; ignore malformed frames.
        }
      };

      activeSocket.onclose = () => {
        clearReadyTimeout();
        this.recordDiagnostic('socket_close', generation, sessionDeviceId, wakeSignature, { socketState: String(activeSocket.readyState) });
        if (!this.isCurrent(generation) || this.activeSession?.generation !== generation) {
          this.recordDiagnostic('stale_generation_ignored', generation, sessionDeviceId, wakeSignature, { technicalCode: 'socket_close' });
          return;
        }
        const current = this.activeSession;
        this.activeSession = null;
        if (current) this.closeSession(current, false);
      };

      processor.onaudioprocess = (event) => {
        if (!startSent || activeSocket.readyState !== WebSocket.OPEN || !this.isCurrent(generation)) return;
        const frame = floatToPcm16(event.inputBuffer.getChannelData(0), context.sampleRate);
        activeSocket.send(frame);
        if (!firstAudioFrameSent) {
          firstAudioFrameSent = true;
          this.recordDiagnostic('first_audio_frame_sent', generation, sessionDeviceId, wakeSignature, {
            sampleRate: context.sampleRate,
            frameBytes: frame.byteLength,
          });
        }
      };

      source.connect(processor);
      processor.connect(context.destination);
      if (!this.isCurrent(generation)) {
        this.recordDiagnostic('stale_generation_ignored', generation, sessionDeviceId, wakeSignature, { technicalCode: 'before_transfer' });
        this.closeSession(activeSession, true);
        createdSession = null;
        return;
      }
      this.activeSession = activeSession;
      transferred = true;
    } catch (error) {
      if (!this.isCurrent(generation)) {
        this.recordDiagnostic('stale_generation_ignored', generation, configuredDeviceId, wakeSignature, { technicalCode: 'ensure_failed' });
        return;
      }
      this.recordDiagnostic('ensure_failed', generation, configuredDeviceId, wakeSignature, {
        technicalCode: error instanceof Error && error.message ? error.message : 'wake_stream_failed',
      });
      throw error;
    } finally {
      clearReadyTimeout();
      if (this.pendingStart?.wakeSignature === wakeSignature) {
        this.pendingStart = null;
      }
      if (!transferred && this.activeSession?.generation === generation) {
        const current = this.activeSession;
        this.activeSession = null;
        this.closeSession(current, true);
      }
      if (!transferred && createdSession) {
        this.closeSession(createdSession, true);
      }
    }
  }

  private closeSession(session: ActiveWakeWordSession, notifyServer: boolean): void {
    session.processor.disconnect();
    session.source.disconnect();
    session.stream.getTracks().forEach((track) => track.stop());
    void session.context.close().catch(() => undefined);
    if (notifyServer && session.socket.readyState === WebSocket.OPEN) {
      session.socket.send(JSON.stringify({ type: 'end' }));
    }
    session.socket.close();
  }

  private isCurrent(generation: number): boolean {
    return !this.disposed && this.generation === generation;
  }

  private recordDiagnostic(
    event: string,
    generation: number,
    deviceId: string,
    wakeSignature: string,
    input: Partial<WakeWordDiagnosticEvent> = {},
  ): void {
    let modelId = input.modelId;
    if (!modelId) {
      try {
        const parsed = JSON.parse(wakeSignature) as { modelId?: string };
        modelId = parsed.modelId;
      } catch {
        modelId = undefined;
      }
    }
    void this.api.wakeWordRecordDiagnostic({
      event,
      deviceId,
      generation,
      modelId,
      ...input,
    }).catch(() => undefined);
  }
}
