import { randomUUID } from 'node:crypto';

export const SIDEKICK_VOICE_CONVERSATION_TTL_MS = 30 * 60 * 1_000;

export type SidekickVoiceScreen =
  | 'idle'
  | 'listening'
  | 'transcribing'
  | 'thinking'
  | 'transcript'
  | 'speaking'
  | 'error';

export type SidekickVoiceSessionPhase = SidekickVoiceScreen;

export interface SidekickWakeEvent {
  sidekickId: string;
  detectedAt?: string;
}

export interface SidekickPcmEvent {
  sidekickId: string;
  pcm: Uint8Array;
  recordingId?: string;
  sequence?: number;
  sampleRate?: number;
}

export interface SidekickDisconnectEvent {
  sidekickId: string;
}

export interface SidekickTransientMicrophone {
  recordingId?: string;
}

export interface SidekickRealtimeSttSession {
  appendPcm: (pcm: Uint8Array) => Promise<void> | void;
  finish: (signal: AbortSignal) => Promise<string>;
  cancel: () => Promise<void> | void;
}

export interface SidekickVoiceConversationRef {
  conversationId: string;
}

export interface SidekickVoiceScreenInput {
  sidekickId: string;
  screen: SidekickVoiceScreen;
  transcript?: string;
  response?: string;
}

export interface SidekickVoiceSessionSnapshot {
  sessionId: string;
  sidekickId: string;
  phase: SidekickVoiceSessionPhase;
  startedAt: number;
  heardSpeech: boolean;
  receivedSamples: number;
  eventSequence: number;
  phaseChangedAt: number;
  transcript?: string;
  conversationId?: string;
}

export type SidekickVoiceSessionStatus =
  | 'completed'
  | 'silence'
  | 'cancelled'
  | 'disconnected'
  | 'timeout'
  | 'error'
  | 'ignored';

export interface SidekickVoiceSessionResult {
  sessionId?: string;
  sidekickId: string;
  status: SidekickVoiceSessionStatus;
  transcript?: string;
  assistantText?: string;
  conversationId?: string;
  technicalCode?: string;
}

export type SidekickVoiceSessionEvent = (
  | { type: 'session.started'; session: SidekickVoiceSessionSnapshot }
  | { type: 'phase.changed'; session: SidekickVoiceSessionSnapshot }
  | { type: 'session.finished'; result: SidekickVoiceSessionResult }
) & { eventSequence: number; occurredAt: number };

export interface SidekickVoiceSessionManagerOptions {
  conversationTtlMs?: number;
  maxListeningMs?: number;
  speechOnsetTimeoutMs?: number;
  silenceAfterSpeechMs?: number;
  maxSessionMs?: number;
  maxPcmChunkBytes?: number;
  speechRmsThreshold?: number;
  speechStartRmsThreshold?: number;
  speechContinueRmsThreshold?: number;
  speechStartChunks?: number;
  microphoneStopTimeoutMs?: number;
  speechCancellationTimeoutMs?: number;
  terminalScreenTimeoutMs?: number;
  terminalStateDwellMs?: number;
}

export interface SidekickVoiceSessionManagerDeps {
  subscribeWake: (listener: (event: SidekickWakeEvent) => void) => () => void;
  subscribePcm: (listener: (event: SidekickPcmEvent) => void) => () => void;
  subscribeDisconnect?: (listener: (event: SidekickDisconnectEvent) => void) => () => void;
  startTransientMicrophone: (input: {
    sidekickId: string;
    sessionId: string;
    signal: AbortSignal;
  }) => Promise<SidekickTransientMicrophone | void>;
  stopTransientMicrophone: (input: {
    sidekickId: string;
    sessionId: string;
    recordingId?: string;
    reason: 'complete' | 'cancelled' | 'disconnected' | 'timeout' | 'error' | 'disposed';
  }) => Promise<void>;
  createRealtimeSttSession?: (input: {
    sidekickId: string;
    sessionId: string;
    signal: AbortSignal;
  }) => Promise<SidekickRealtimeSttSession>;
  transcribePcmBuffer?: (input: {
    sidekickId: string;
    sessionId: string;
    chunks: readonly Uint8Array[];
    sampleRate: number;
    signal: AbortSignal;
  }) => Promise<string>;
  createOrReuseConversation: (input: {
    sidekickId: string;
    existingConversationId?: string;
    ttlMs: number;
  }) => Promise<SidekickVoiceConversationRef>;
  getConversationTtlMs?: (sidekickId: string) => Promise<number>;
  sendMessageAndWaitForFinal: (input: {
    sidekickId: string;
    conversationId: string;
    content: string;
    signal: AbortSignal;
  }) => Promise<string>;
  sendScreen: (input: SidekickVoiceScreenInput) => Promise<void>;
  speakWithTts: (input: {
    sidekickId: string;
    text: string;
    signal: AbortSignal;
    onPlaybackStarted: () => Promise<void> | void;
  }) => Promise<void>;
  detectSpeech?: (pcm: Uint8Array) => boolean;
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => unknown;
  clearTimer?: (timer: unknown) => void;
  onEvent?: (event: SidekickVoiceSessionEvent) => void;
}

interface ConversationLease {
  conversationId: string;
  expiresAt: number;
}

type InterruptKind = 'cancelled' | 'disconnected' | 'timeout' | 'disposed';
type StopReason = Parameters<SidekickVoiceSessionManagerDeps['stopTransientMicrophone']>[0]['reason'];

interface ActiveVoiceSession {
  sessionId: string;
  sidekickId: string;
  phase: SidekickVoiceSessionPhase;
  eventSequence: number;
  phaseChangedAt: number;
  startedAt: number;
  controller: AbortController;
  interruptKind?: InterruptKind;
  microphoneStarted: boolean;
  microphoneState: 'not_started' | 'started' | 'stopping' | 'stopped';
  microphoneStopAttempt: number;
  recordingId?: string;
  realtimeStt?: SidekickRealtimeSttSession;
  sttSettled: boolean;
  acceptingPcm: boolean;
  heardSpeech: boolean;
  speechActive: boolean;
  speechCandidateChunks: number;
  receivedSamples: number;
  sampleRate: number;
  pcmChunks: Uint8Array[];
  pcmWork: Promise<void>;
  pcmError?: unknown;
  captureDone: Promise<void>;
  resolveCaptureDone: () => void;
  captureRequested: boolean;
  listeningTimer?: unknown;
  silenceTimer?: unknown;
  sessionTimer?: unknown;
  transcript?: string;
  assistantText?: string;
  speechWork?: Promise<void>;
  playbackStarted: boolean;
  conversationId?: string;
  completion?: Promise<SidekickVoiceSessionResult>;
}

const DEFAULT_OPTIONS: Required<SidekickVoiceSessionManagerOptions> = {
  conversationTtlMs: SIDEKICK_VOICE_CONVERSATION_TTL_MS,
  maxListeningMs: 15_000,
  speechOnsetTimeoutMs: 6_000,
  silenceAfterSpeechMs: 1_000,
  maxSessionMs: 120_000,
  maxPcmChunkBytes: 32_768,
  // Calibrado para el mic del Sidekick con PGA 30 dB + 12 dB digitales: el
  // piso de ruido ronda 400-700 RMS y la voz cercana supera 2000. Con el
  // umbral antiguo (250) el ruido contaba como voz y el silencio nunca
  // cortaba la escucha.
  speechRmsThreshold: 1000,
  speechStartRmsThreshold: 1000,
  speechContinueRmsThreshold: 700,
  speechStartChunks: 2,
  microphoneStopTimeoutMs: 5_000,
  speechCancellationTimeoutMs: 5_000,
  terminalScreenTimeoutMs: 2_000,
  terminalStateDwellMs: 1_500,
};

class SidekickVoiceInterruptedError extends Error {
  public constructor(public readonly kind: InterruptKind) {
    super(`sidekick_voice_${kind}`);
  }
}

const errorCode = (error: unknown): string => {
  if (error instanceof Error && error.message.trim()) return error.message;
  return 'sidekick_voice_session_failed';
};

const pcmRms = (pcm: Uint8Array): number => {
  const byteLength = pcm.byteLength - (pcm.byteLength % 2);
  if (byteLength === 0) return 0;
  const view = new DataView(pcm.buffer, pcm.byteOffset, byteLength);
  let energy = 0;
  const sampleCount = byteLength / 2;
  for (let offset = 0; offset < byteLength; offset += 2) {
    const sample = view.getInt16(offset, true);
    energy += sample * sample;
  }
  return Math.sqrt(energy / sampleCount);
};

const cleanText = (value: string): string => value.replace(/\s+/g, ' ').trim();

/**
 * Coordinates one in-memory voice turn per Sidekick. It owns no persistence and
 * deliberately receives every hardware, STT, agent, screen and TTS capability
 * as an adapter so the Electron main process remains the only privileged layer.
 */
export class SidekickVoiceSessionManager {
  private readonly options: Required<SidekickVoiceSessionManagerOptions>;
  private readonly active = new Map<string, ActiveVoiceSession>();
  private readonly conversations = new Map<string, ConversationLease>();
  private readonly terminalStates = new Map<string, {
    sessionId: string;
    phase: SidekickVoiceScreen;
    timer: unknown;
  }>();
  private readonly listeners = new Set<(event: SidekickVoiceSessionEvent) => void>();
  private unsubscribers: Array<() => void> = [];
  private started = false;
  private disposed = false;

  public constructor(private readonly deps: SidekickVoiceSessionManagerDeps, options: SidekickVoiceSessionManagerOptions = {}) {
    if (!deps.createRealtimeSttSession && !deps.transcribePcmBuffer) {
      throw new Error('sidekick_voice_stt_adapter_required');
    }
    this.options = {
      ...DEFAULT_OPTIONS,
      ...options,
      speechStartRmsThreshold: options.speechStartRmsThreshold ?? options.speechRmsThreshold ?? DEFAULT_OPTIONS.speechStartRmsThreshold,
    };
    for (const [name, value] of Object.entries(this.options)) {
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error(`sidekick_voice_${name}_invalid`);
      }
    }
    if (!Number.isInteger(this.options.speechStartChunks)) {
      throw new Error('sidekick_voice_speechStartChunks_invalid');
    }
    if (this.options.speechContinueRmsThreshold > this.options.speechStartRmsThreshold) {
      throw new Error('sidekick_voice_speech_threshold_hysteresis_invalid');
    }
  }

  public start(): void {
    if (this.started) return;
    if (this.disposed) throw new Error('sidekick_voice_manager_disposed');
    this.started = true;
    this.unsubscribers = [
      this.deps.subscribeWake((event) => {
        void this.triggerWake(event);
      }),
      this.deps.subscribePcm((event) => {
        this.receivePcm(event);
      }),
    ];
    if (this.deps.subscribeDisconnect) {
      this.unsubscribers.push(this.deps.subscribeDisconnect((event) => {
        void this.disconnect(event.sidekickId);
      }));
    }
  }

  public onEvent(listener: (event: SidekickVoiceSessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public getActiveSession(sidekickId: string): SidekickVoiceSessionSnapshot | null {
    const session = this.active.get(sidekickId);
    return session ? this.snapshot(session) : null;
  }

  public getVisiblePhase(sidekickId: string): SidekickVoiceSessionPhase {
    return this.active.get(sidekickId)?.phase ?? this.terminalStates.get(sidekickId)?.phase ?? 'idle';
  }

  public listActiveSessions(): SidekickVoiceSessionSnapshot[] {
    return [...this.active.values()].map((session) => this.snapshot(session));
  }

  public async reconcileScreen(sidekickId: string): Promise<void> {
    const session = this.active.get(sidekickId);
    const phase = session?.phase ?? this.terminalStates.get(sidekickId)?.phase ?? 'idle';
    await this.withDeadline(
      this.deps.sendScreen({
        sidekickId,
        screen: phase,
        ...(phase === 'transcript' && session?.transcript ? { transcript: session.transcript } : {}),
        ...(phase === 'transcript' && session?.assistantText ? { response: session.assistantText } : {}),
      }),
      this.options.terminalScreenTimeoutMs,
      'sidekick_voice_reconcile_screen_timeout',
    );
  }

  public async triggerWake(event: SidekickWakeEvent): Promise<SidekickVoiceSessionResult> {
    const sidekickId = event.sidekickId.trim();
    if (!sidekickId) {
      return { sidekickId: '', status: 'ignored', technicalCode: 'sidekick_voice_sidekick_id_required' };
    }
    if (this.disposed) {
      return { sidekickId, status: 'ignored', technicalCode: 'sidekick_voice_manager_disposed' };
    }
    this.clearTerminalState(sidekickId);
    const current = this.active.get(sidekickId);
    if (current) {
      if (current.phase !== 'speaking') {
        return { sidekickId, status: 'ignored', technicalCode: 'sidekick_voice_session_active' };
      }
      this.abortSession(current, 'cancelled');
      await current.completion;
      if (this.disposed) {
        return { sidekickId, status: 'ignored', technicalCode: 'sidekick_voice_manager_disposed' };
      }
      if (this.active.has(sidekickId)) {
        return { sidekickId, status: 'ignored', technicalCode: 'sidekick_voice_session_active' };
      }
    }

    const session = this.createSession(sidekickId);
    this.active.set(sidekickId, session);
    this.emitSessionStarted(session);
    const completion = this.runSession(session);
    session.completion = completion;
    return await completion;
  }

  public async cancel(sidekickId: string): Promise<SidekickVoiceSessionResult | null> {
    return await this.interrupt(sidekickId, 'cancelled');
  }

  public async disconnect(sidekickId: string): Promise<SidekickVoiceSessionResult | null> {
    return await this.interrupt(sidekickId, 'disconnected');
  }

  public async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.started = false;
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
    const completions = [...this.active.values()].map(async (session) => {
      this.abortSession(session, 'disposed');
      await session.completion;
    });
    await Promise.allSettled(completions);
    for (const state of this.terminalStates.values()) this.clearTimer(state.timer);
    this.terminalStates.clear();
    this.conversations.clear();
    this.listeners.clear();
  }

  private createSession(sidekickId: string): ActiveVoiceSession {
    let resolveCaptureDone = (): void => undefined;
    const captureDone = new Promise<void>((resolve) => {
      resolveCaptureDone = resolve;
    });
    return {
      sessionId: randomUUID(),
      sidekickId,
      phase: 'idle',
      eventSequence: 0,
      phaseChangedAt: this.now(),
      startedAt: this.now(),
      controller: new AbortController(),
      microphoneStarted: false,
      microphoneState: 'not_started',
      microphoneStopAttempt: 0,
      sttSettled: false,
      acceptingPcm: false,
      heardSpeech: false,
      speechActive: false,
      speechCandidateChunks: 0,
      receivedSamples: 0,
      sampleRate: 16_000,
      pcmChunks: [],
      pcmWork: Promise.resolve(),
      captureDone,
      resolveCaptureDone,
      captureRequested: false,
      playbackStarted: false,
    };
  }

  private async runSession(session: ActiveVoiceSession): Promise<SidekickVoiceSessionResult> {
    let result!: SidekickVoiceSessionResult;
    try {
      session.sessionTimer = this.setTimer(() => this.abortSession(session, 'timeout'), this.options.maxSessionMs);
      await this.transitionBestEffort(session, 'listening');
      session.realtimeStt = this.deps.createRealtimeSttSession
        ? await this.raceWithAbort(this.deps.createRealtimeSttSession({
          sidekickId: session.sidekickId,
          sessionId: session.sessionId,
          signal: session.controller.signal,
        }), session)
        : undefined;
      const microphone = await this.raceWithAbort(this.deps.startTransientMicrophone({
        sidekickId: session.sidekickId,
        sessionId: session.sessionId,
        signal: session.controller.signal,
      }), session);
      session.microphoneStarted = true;
      session.microphoneState = 'started';
      session.recordingId = microphone?.recordingId;
      session.acceptingPcm = true;
      session.listeningTimer = this.setTimer(
        () => this.requestCaptureFinish(session),
        this.options.speechOnsetTimeoutMs,
      );
      await this.raceWithAbort(session.captureDone, session);

      const transcript = await this.finishCapture(session);
      if (!session.heardSpeech || !cleanText(transcript)) {
        result = this.result(session, 'silence');
        await this.transitionBestEffort(session, 'error');
      } else {
        session.transcript = cleanText(transcript);
        await this.transitionBestEffort(session, 'thinking');
        const conversation = await this.raceWithAbort(this.resolveConversation(session), session);
        session.conversationId = conversation.conversationId;
        const assistantText = cleanText(await this.raceWithAbort(this.deps.sendMessageAndWaitForFinal({
          sidekickId: session.sidekickId,
          conversationId: conversation.conversationId,
          content: session.transcript,
          signal: session.controller.signal,
        }), session));
        if (!assistantText) throw new Error('sidekick_voice_agent_response_empty');
        session.assistantText = assistantText;
        // TTS puede tardar varios segundos en sintetizar. La pantalla sigue en
        // thinking hasta que el adaptador confirma que el hardware comenzo a
        // reproducir; `speaking` representa audio real, no preparacion.
        const speechWork = Promise.resolve(this.deps.speakWithTts({
          sidekickId: session.sidekickId,
          text: assistantText,
          signal: session.controller.signal,
          onPlaybackStarted: async () => {
            if (session.playbackStarted || session.controller.signal.aborted || !this.isCurrent(session)) return;
            session.playbackStarted = true;
            await this.transitionBestEffort(session, 'speaking');
          },
        }));
        session.speechWork = speechWork;
        await this.raceWithAbort(speechWork, session);
        session.speechWork = undefined;
        if (!session.playbackStarted) throw new Error('sidekick_voice_playback_start_unconfirmed');
        result = this.result(session, 'completed');
      }
    } catch (error) {
      const interrupted = error instanceof SidekickVoiceInterruptedError ? error.kind : session.interruptKind;
      if (interrupted) {
        result = this.result(session, interrupted === 'disposed' ? 'cancelled' : interrupted);
      } else {
        const technicalCode = errorCode(error);
        if (technicalCode === 'sidekick_speaker_playback_interrupted' || technicalCode === 'sidekick_speaker_playback_cancelled') {
          result = this.result(session, 'cancelled', technicalCode);
        } else {
          result = this.result(session, 'error', technicalCode);
          await this.transitionBestEffort(session, 'error');
        }
      }
    } finally {
      await this.cleanupSession(session, result);
    }
    this.emitSessionFinished(session, result);
    return result;
  }

  private receivePcm(event: SidekickPcmEvent): void {
    const session = this.active.get(event.sidekickId);
    if (!session || !session.acceptingPcm || session.captureRequested || session.controller.signal.aborted) return;
    if (session.recordingId && event.recordingId && session.recordingId !== event.recordingId) return;
    if (!(event.pcm instanceof Uint8Array) || event.pcm.byteLength === 0 || event.pcm.byteLength > this.options.maxPcmChunkBytes) return;

    const pcm = Uint8Array.from(event.pcm);
    session.sampleRate = Number.isInteger(event.sampleRate) && Number(event.sampleRate) > 0
      ? Number(event.sampleRate)
      : session.sampleRate;
    session.receivedSamples += Math.floor(pcm.byteLength / 2);
    const level = this.deps.detectSpeech
      ? (this.deps.detectSpeech(pcm) ? this.options.speechStartRmsThreshold : 0)
      : pcmRms(pcm);
    if (!session.speechActive) {
      session.speechCandidateChunks = level >= this.options.speechStartRmsThreshold
        ? session.speechCandidateChunks + 1
        : 0;
      if (session.speechCandidateChunks >= this.options.speechStartChunks) {
        session.speechActive = true;
        session.heardSpeech = true;
        this.clearTimer(session.listeningTimer);
        session.listeningTimer = this.setTimer(
          () => this.requestCaptureFinish(session),
          this.options.maxListeningMs,
        );
      }
    }
    if (session.speechActive && level >= this.options.speechContinueRmsThreshold) {
      this.clearTimer(session.silenceTimer);
      session.silenceTimer = this.setTimer(() => this.requestCaptureFinish(session), this.options.silenceAfterSpeechMs);
    }
    session.pcmWork = session.pcmWork.then(async () => {
      if (session.realtimeStt) {
        await session.realtimeStt.appendPcm(pcm);
      } else {
        session.pcmChunks.push(pcm);
      }
    }).catch((error: unknown) => {
      session.pcmError ??= error;
      this.requestCaptureFinish(session);
    });
  }

  private requestCaptureFinish(session: ActiveVoiceSession): void {
    if (session.captureRequested || !this.isCurrent(session)) return;
    session.captureRequested = true;
    session.resolveCaptureDone();
  }

  private async finishCapture(session: ActiveVoiceSession): Promise<string> {
    this.clearCaptureTimers(session);
    await this.stopMicrophone(session, 'complete');
    await this.raceWithAbort(session.pcmWork, session);
    if (session.pcmError) throw session.pcmError;
    session.acceptingPcm = false;
    if (!session.heardSpeech || session.receivedSamples === 0) {
      await Promise.resolve(session.realtimeStt?.cancel()).catch(() => undefined);
      session.sttSettled = true;
      session.pcmChunks.length = 0;
      return '';
    }
    // Primer paso visible del pipeline en el dispositivo:
    // transcribiendo -> pensando -> hablando.
    await this.transitionBestEffort(session, 'transcribing');
    if (session.realtimeStt) {
      const transcript = await this.raceWithAbort(session.realtimeStt.finish(session.controller.signal), session);
      session.sttSettled = true;
      return transcript;
    }
    const chunks = session.pcmChunks.splice(0);
    try {
      const transcript = await this.raceWithAbort(this.deps.transcribePcmBuffer!({
        sidekickId: session.sidekickId,
        sessionId: session.sessionId,
        chunks,
        sampleRate: session.sampleRate,
        signal: session.controller.signal,
      }), session);
      session.sttSettled = true;
      return transcript;
    } finally {
      chunks.length = 0;
    }
  }

  private async resolveConversation(session: ActiveVoiceSession): Promise<SidekickVoiceConversationRef> {
    const configuredTtlMs = await this.deps.getConversationTtlMs?.(session.sidekickId);
    const ttlMs = Number.isFinite(configuredTtlMs) && Number(configuredTtlMs) > 0
      ? Number(configuredTtlMs)
      : this.options.conversationTtlMs;
    const cached = this.conversations.get(session.sidekickId);
    const existingConversationId = cached && cached.expiresAt > this.now()
      ? cached.conversationId
      : undefined;
    if (!existingConversationId) this.conversations.delete(session.sidekickId);
    const conversation = await this.deps.createOrReuseConversation({
      sidekickId: session.sidekickId,
      ...(existingConversationId ? { existingConversationId } : {}),
      ttlMs,
    });
    if (!conversation.conversationId.trim()) throw new Error('sidekick_voice_conversation_id_required');
    this.conversations.set(session.sidekickId, {
      conversationId: conversation.conversationId,
      expiresAt: this.now() + ttlMs,
    });
    return conversation;
  }

  private async interrupt(sidekickId: string, kind: Exclude<InterruptKind, 'disposed'>): Promise<SidekickVoiceSessionResult | null> {
    const session = this.active.get(sidekickId);
    if (!session) return null;
    this.abortSession(session, kind);
    return await session.completion!;
  }

  private abortSession(session: ActiveVoiceSession, kind: InterruptKind): void {
    if (session.controller.signal.aborted || !this.isCurrent(session)) return;
    session.interruptKind = kind;
    session.controller.abort(new SidekickVoiceInterruptedError(kind));
  }

  private async cleanupSession(session: ActiveVoiceSession, result: SidekickVoiceSessionResult): Promise<void> {
    this.clearCaptureTimers(session);
    this.clearTimer(session.sessionTimer);
    session.acceptingPcm = false;
    const reason: StopReason = session.interruptKind ?? (session.phase === 'error' ? 'error' : 'complete');
    await this.stopMicrophone(session, reason).catch(() => undefined);
    if (session.speechWork) {
      await this.withDeadline(
        session.speechWork,
        this.options.speechCancellationTimeoutMs,
        'sidekick_voice_speech_cancellation_timeout',
      ).catch(() => undefined);
      session.speechWork = undefined;
    }
    if (!session.sttSettled) {
      await Promise.resolve(session.realtimeStt?.cancel()).catch(() => undefined);
      session.sttSettled = true;
    }
    session.pcmChunks.length = 0;
    if (result.status === 'silence' || result.status === 'error') {
      this.scheduleTerminalIdle(session);
      if (this.isCurrent(session)) this.active.delete(session.sidekickId);
      return;
    }
    await this.transitionTerminal(session, 'idle');
    if (this.isCurrent(session)) this.active.delete(session.sidekickId);
  }

  private scheduleTerminalIdle(session: ActiveVoiceSession): void {
    this.clearTerminalState(session.sidekickId);
    const timer = this.setTimer(() => {
      const current = this.terminalStates.get(session.sidekickId);
      if (!current || current.sessionId !== session.sessionId) return;
      this.terminalStates.delete(session.sidekickId);
      void this.transitionTerminal(session, 'idle');
    }, this.options.terminalStateDwellMs);
    this.terminalStates.set(session.sidekickId, {
      sessionId: session.sessionId,
      phase: session.phase,
      timer,
    });
  }

  private clearTerminalState(sidekickId: string): void {
    const state = this.terminalStates.get(sidekickId);
    if (!state) return;
    this.clearTimer(state.timer);
    this.terminalStates.delete(sidekickId);
  }

  private async stopMicrophone(session: ActiveVoiceSession, reason: StopReason): Promise<void> {
    if (session.microphoneState === 'not_started' || session.microphoneState === 'stopped') return;
    const attempt = ++session.microphoneStopAttempt;
    session.microphoneState = 'stopping';
    const stopWork = this.deps.stopTransientMicrophone({
      sidekickId: session.sidekickId,
      sessionId: session.sessionId,
      ...(session.recordingId ? { recordingId: session.recordingId } : {}),
      reason,
    });
    try {
      await this.withDeadline(stopWork, this.options.microphoneStopTimeoutMs, 'sidekick_voice_microphone_stop_timeout');
      if (session.microphoneStopAttempt === attempt) {
        session.microphoneState = 'stopped';
        session.microphoneStarted = false;
      }
    } catch (error) {
      if (session.microphoneStopAttempt === attempt) session.microphoneState = 'started';
      throw error;
    }
  }

  private async transition(session: ActiveVoiceSession, phase: SidekickVoiceScreen): Promise<void> {
    session.phase = phase;
    this.emitPhase(session);
    await this.raceWithAbort(this.deps.sendScreen({
      sidekickId: session.sidekickId,
      screen: phase,
      ...(phase === 'transcript' && session.transcript ? { transcript: session.transcript } : {}),
      ...(phase === 'transcript' && session.assistantText ? { response: session.assistantText } : {}),
    }), session);
  }

  private async transitionBestEffort(session: ActiveVoiceSession, phase: SidekickVoiceScreen): Promise<void> {
    try {
      await this.transition(session, phase);
    } catch {
      // A disconnected Sidekick cannot render its terminal state.
    }
  }

  private async transitionTerminal(session: ActiveVoiceSession, phase: SidekickVoiceScreen): Promise<void> {
    session.phase = phase;
    this.emitPhase(session);
    await this.withDeadline(
      this.deps.sendScreen({ sidekickId: session.sidekickId, screen: phase }),
      this.options.terminalScreenTimeoutMs,
      'sidekick_voice_terminal_screen_timeout',
    ).catch(() => undefined);
  }

  private withDeadline<T>(promise: Promise<T>, timeoutMs: number, technicalCode: string): Promise<T> {
    promise.catch(() => undefined);
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const timer = this.setTimer(() => {
        if (settled) return;
        settled = true;
        reject(new Error(technicalCode));
      }, timeoutMs);
      promise.then(
        (value) => {
          if (settled) return;
          settled = true;
          this.clearTimer(timer);
          resolve(value);
        },
        (error: unknown) => {
          if (settled) return;
          settled = true;
          this.clearTimer(timer);
          reject(error);
        },
      );
    });
  }

  private raceWithAbort<T>(promise: Promise<T>, session: ActiveVoiceSession): Promise<T> {
    const signal = session.controller.signal;
    if (signal.aborted) {
      // La promesa en vuelo pierde la carrera pero sigue viva: sin este catch
      // su rechazo posterior (p. ej. sidekick_offline) queda sin observador y
      // revienta como unhandledRejection del proceso main.
      promise.catch(() => undefined);
      return Promise.reject(new SidekickVoiceInterruptedError(session.interruptKind ?? 'cancelled'));
    }
    return new Promise<T>((resolve, reject) => {
      const onAbort = (): void => {
        signal.removeEventListener('abort', onAbort);
        reject(new SidekickVoiceInterruptedError(session.interruptKind ?? 'cancelled'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      promise.then(
        (value) => {
          signal.removeEventListener('abort', onAbort);
          resolve(value);
        },
        (error: unknown) => {
          signal.removeEventListener('abort', onAbort);
          reject(error);
        },
      );
    });
  }

  private snapshot(session: ActiveVoiceSession): SidekickVoiceSessionSnapshot {
    return {
      sessionId: session.sessionId,
      sidekickId: session.sidekickId,
      phase: session.phase,
      startedAt: session.startedAt,
      heardSpeech: session.heardSpeech,
      receivedSamples: session.receivedSamples,
      eventSequence: session.eventSequence,
      phaseChangedAt: session.phaseChangedAt,
      ...(session.transcript ? { transcript: session.transcript } : {}),
      ...(session.conversationId ? { conversationId: session.conversationId } : {}),
    };
  }

  private result(session: ActiveVoiceSession, status: SidekickVoiceSessionStatus, technicalCode?: string): SidekickVoiceSessionResult {
    return {
      sessionId: session.sessionId,
      sidekickId: session.sidekickId,
      status,
      ...(session.transcript ? { transcript: session.transcript } : {}),
      ...(session.assistantText ? { assistantText: session.assistantText } : {}),
      ...(session.conversationId ? { conversationId: session.conversationId } : {}),
      ...(technicalCode ? { technicalCode } : {}),
    };
  }

  private emitPhase(session: ActiveVoiceSession): void {
    session.eventSequence += 1;
    session.phaseChangedAt = this.now();
    this.emit({
      type: 'phase.changed',
      session: this.snapshot(session),
      eventSequence: session.eventSequence,
      occurredAt: session.phaseChangedAt,
    });
  }

  private emitSessionStarted(session: ActiveVoiceSession): void {
    session.eventSequence += 1;
    this.emit({
      type: 'session.started',
      session: this.snapshot(session),
      eventSequence: session.eventSequence,
      occurredAt: this.now(),
    });
  }

  private emitSessionFinished(session: ActiveVoiceSession, result: SidekickVoiceSessionResult): void {
    session.eventSequence += 1;
    this.emit({
      type: 'session.finished',
      result,
      eventSequence: session.eventSequence,
      occurredAt: this.now(),
    });
  }

  private emit(event: SidekickVoiceSessionEvent): void {
    try {
      this.deps.onEvent?.(event);
    } catch {
      // Observability callbacks cannot break a voice turn.
    }
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Event consumers are isolated from orchestration.
      }
    }
  }

  private isCurrent(session: ActiveVoiceSession): boolean {
    return this.active.get(session.sidekickId) === session;
  }

  private clearCaptureTimers(session: ActiveVoiceSession): void {
    this.clearTimer(session.listeningTimer);
    this.clearTimer(session.silenceTimer);
    session.listeningTimer = undefined;
    session.silenceTimer = undefined;
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private setTimer(callback: () => void, delayMs: number): unknown {
    return this.deps.setTimer?.(callback, delayMs) ?? setTimeout(callback, delayMs);
  }

  private clearTimer(timer: unknown): void {
    if (timer === undefined) return;
    if (this.deps.clearTimer) this.deps.clearTimer(timer);
    else clearTimeout(timer as ReturnType<typeof setTimeout>);
  }
}
