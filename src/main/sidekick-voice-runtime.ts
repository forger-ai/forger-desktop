import type { AgentConversationManager } from './personal-agents/agent-conversation-manager';
import type { AgentStore } from './personal-agents/agent-store';
import type { SidekickService, SidekickSessionInvalidationEvent } from './sidekick-service';
import { SidekickMicrophonePreprocessor } from './sidekick-audio-codec';
import { buildPcm16MonoWav } from './sidekick-service-helpers';
import {
  SidekickVoiceSessionManager,
  type SidekickDisconnectEvent,
  type SidekickPcmEvent,
  type SidekickVoiceSessionEvent,
  type SidekickWakeEvent,
} from './sidekick-voice-session-manager';
import type { SpeechToTextServiceManager } from './speech-to-text-service';
import type { TextToSpeechServiceManager } from './text-to-speech-service';
import type {
  SidekickState,
  SidekickSummary,
  SidekickVoicePhase,
  SidekickWakeEvent as SidekickProtocolWakeEvent,
} from '../shared/types';
import { resolveSidekickVoiceProfile, type ResolvedSidekickVoiceProfile } from './sidekick-voice-profile';

interface SidekickVoiceRuntimeDeps {
  getSidekickService: () => SidekickService;
  getSpeechToTextService: () => SpeechToTextServiceManager;
  getTextToSpeechService: () => TextToSpeechServiceManager;
  getPersonalAgentStore: () => AgentStore;
  getPersonalAgentConversationManager: () => AgentConversationManager;
  appendLog?: (event: string, payload?: Record<string, unknown>) => Promise<void>;
}

export const selectSidekickPersonalAgentId = (
  configuredId: string | undefined,
  agents: readonly { id: string }[],
): string => {
  if (configuredId) {
    if (agents.some((agent) => agent.id === configuredId)) return configuredId;
    throw new Error('sidekick_voice_personal_agent_binding_invalid');
  }
  if (agents.length === 1) return agents[0].id;
  if (agents.length === 0) throw new Error('sidekick_voice_personal_agent_required');
  throw new Error('sidekick_voice_personal_agent_selection_required');
};

export class SidekickVoiceRuntime {
  private readonly wakeListeners = new Set<(event: SidekickWakeEvent) => void>();
  private readonly pcmListeners = new Set<(event: SidekickPcmEvent) => void>();
  private readonly disconnectListeners = new Set<(event: SidekickDisconnectEvent) => void>();
  private readonly microphonePreprocessors = new Map<string, SidekickMicrophonePreprocessor>();
  private readonly deviceStatuses = new Map<string, SidekickSummary['status']>();
  private readonly playbackStartedListeners = new Map<string, Set<() => void>>();
  private readonly manager: SidekickVoiceSessionManager;
  private logWork: Promise<void> = Promise.resolve();

  public constructor(private readonly deps: SidekickVoiceRuntimeDeps) {
    this.manager = new SidekickVoiceSessionManager({
      subscribeWake: (listener) => this.subscribe(this.wakeListeners, listener),
      subscribePcm: (listener) => this.subscribe(this.pcmListeners, listener),
      subscribeDisconnect: (listener) => this.subscribe(this.disconnectListeners, listener),
      startTransientMicrophone: async ({ sidekickId, signal }) => {
        if (signal.aborted) throw signal.reason;
        const result = await this.deps.getSidekickService().startMicrophoneRecording({ sidekickId, transient: true });
        if (!result.success) throw new Error(result.technicalCode ?? 'sidekick_voice_microphone_start_failed');
        const recordingId = result.sidekicks.find((item) => item.sidekickId === sidekickId)?.microphoneRecording.recordingId;
        if (!recordingId) throw new Error('sidekick_voice_recording_id_missing');
        return { recordingId };
      },
      stopTransientMicrophone: async ({ sidekickId }) => {
        const service = this.deps.getSidekickService();
        const state = await service.getState();
        const recording = state.sidekicks.find((item) => item.sidekickId === sidekickId)?.microphoneRecording;
        if (!recording || recording.status === 'idle' || recording.status === 'error') return;
        const result = await service.stopMicrophoneRecording({ sidekickId, transient: true });
        if (!result.success && result.technicalCode !== 'sidekick_microphone_recording_not_active') {
          throw new Error(result.technicalCode ?? 'sidekick_voice_microphone_stop_failed');
        }
      },
      transcribePcmBuffer: async ({ sidekickId, chunks, sampleRate, signal }) => {
        if (signal.aborted) throw signal.reason;
        const profile = await this.resolveVoiceProfile(sidekickId);
        const wav = buildPcm16MonoWav(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))), sampleRate);
        const result = await this.deps.getSpeechToTextService().processUpload({
          filename: 'sidekick-voice.wav',
          mimeType: 'audio/wav',
          data: Uint8Array.from(wav).buffer,
          task: 'transcribe',
          language: profile.locale.split('-')[0],
          ephemeral: true,
        });
        if (signal.aborted) throw signal.reason;
        if (!result.success) throw new Error(result.technicalCode ?? 'sidekick_voice_transcription_failed');
        return result.text?.trim() ?? '';
      },
      getConversationTtlMs: async (sidekickId) => (await this.resolveVoiceProfile(sidekickId)).conversationTtlMs,
      createOrReuseConversation: (input) => this.createOrReuseConversation(input),
      sendMessageAndWaitForFinal: (input) => this.sendMessageAndWaitForFinal(input),
      sendScreen: async ({ sidekickId, screen, transcript, response }) => {
        const service = this.deps.getSidekickService();
        const result = screen === 'idle'
          ? await service.sendScreen({ sidekickId, template: 'idle' })
          : screen === 'transcript'
            ? await service.sendScreen({
              sidekickId,
              template: 'transcript',
              text: [transcript, response].filter(Boolean).join('\n\n').slice(0, 4_000),
            })
            : await service.sendScreen({ sidekickId, template: 'state', icon: screen });
        if (!result.success) throw new Error(result.technicalCode ?? 'sidekick_voice_screen_failed');
      },
      speakWithTts: (input) => this.speakWithTts(input),
      onEvent: (event) => this.logVoiceEvent(event),
    });
  }

  public start(): void {
    this.manager.start();
  }

  public async dispose(): Promise<void> {
    await this.manager.dispose();
    this.playbackStartedListeners.clear();
    await this.logWork.catch(() => undefined);
  }

  public getActivePhase(sidekickId: string): SidekickVoicePhase | undefined {
    return this.manager.getActiveSession(sidekickId)?.phase as SidekickVoicePhase | undefined;
  }

  public getVisiblePhase(sidekickId: string): SidekickVoicePhase {
    return this.manager.getVisiblePhase(sidekickId) as SidekickVoicePhase;
  }

  public async onSidekickSessionInvalidated(event: SidekickSessionInvalidationEvent): Promise<void> {
    const result = await this.manager.disconnect(event.sidekickId);
    if (!result && event.reason === 'reconnected') {
      await this.manager.reconcileScreen(event.sidekickId);
    }
    void this.deps.appendLog?.('sidekick:voice_session_invalidated', {
      sidekickId: event.sidekickId,
      reason: event.reason,
      activeSessionCancelled: Boolean(result),
    });
  }

  public onWakeDetected(event: SidekickProtocolWakeEvent): void {
    const detectedAt = new Date(event.epochMs ?? Date.now()).toISOString();
    for (const listener of this.wakeListeners) listener({ sidekickId: event.sidekickId, detectedAt });
  }

  public onMicrophonePcm(event: { sidekickId: string; recordingId: string; chunkSequence: number; pcm: Uint8Array }): void {
    let preprocessor = this.microphonePreprocessors.get(event.recordingId);
    if (!preprocessor) {
      preprocessor = new SidekickMicrophonePreprocessor();
      this.microphonePreprocessors.set(event.recordingId, preprocessor);
    }
    const pcm = preprocessor.process(event.pcm);
    for (const listener of this.pcmListeners) {
      listener({
        sidekickId: event.sidekickId,
        recordingId: event.recordingId,
        sequence: event.chunkSequence,
        sampleRate: 16_000,
        pcm,
      });
    }
  }

  public onSidekickState(state: SidekickState): void {
    const activeRecordings = new Set(state.sidekicks
      .map((sidekick) => sidekick.microphoneRecording.recordingId)
      .filter((recordingId): recordingId is string => Boolean(recordingId)));
    for (const recordingId of this.microphonePreprocessors.keys()) {
      if (!activeRecordings.has(recordingId)) this.microphonePreprocessors.delete(recordingId);
    }
    for (const sidekick of state.sidekicks) {
      if (sidekick.speakerPlayback.status === 'playing') {
        for (const listener of this.playbackStartedListeners.get(sidekick.sidekickId) ?? []) listener();
      }
      const previous = this.deviceStatuses.get(sidekick.sidekickId);
      this.deviceStatuses.set(sidekick.sidekickId, sidekick.status);
      if (sidekick.status === 'online') {
        if (previous !== 'online') {
          void this.manager.reconcileScreen(sidekick.sidekickId).catch((error: unknown) => {
            void this.deps.appendLog?.('sidekick:voice_screen_reconcile_failed', {
              sidekickId: sidekick.sidekickId,
              technicalCode: error instanceof Error ? error.message : String(error),
            });
          });
        }
        continue;
      }
      if (previous === 'online') {
        for (const listener of this.disconnectListeners) listener({ sidekickId: sidekick.sidekickId });
      }
    }
  }

  private subscribe<T>(listeners: Set<(event: T) => void>, listener: (event: T) => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  private async createOrReuseConversation(input: {
    sidekickId: string;
    existingConversationId?: string;
    ttlMs: number;
  }): Promise<{ conversationId: string }> {
    const conversations = this.deps.getPersonalAgentConversationManager();
    const store = this.deps.getPersonalAgentStore();
    const agents = await store.listAgents();
    const sidekick = await this.requireSidekick(input.sidekickId);
    const personalAgentId = selectSidekickPersonalAgentId(sidekick.personalAgentId, agents);
    const persisted = await store.findLatestSidekickConversation({ sidekickId: input.sidekickId, agentId: personalAgentId });
    const candidates = [...new Set(
      [input.existingConversationId, persisted?.id].filter((id): id is string => Boolean(id)),
    )];
    for (const conversationId of candidates) {
      const existing = await conversations.getConversation(conversationId);
      if (
        existing && Date.now() - Date.parse(existing.updatedAt) <= input.ttlMs &&
        await conversations.canReuseSidekickConversation({
          conversationId,
          sidekickId: input.sidekickId,
          agentId: personalAgentId,
        })
      ) return { conversationId };
    }
    const conversation = await conversations.createSidekickConversation({
      agentId: personalAgentId,
      sidekickId: input.sidekickId,
      title: `Sidekick · ${sidekick.name}`,
    });
    return { conversationId: conversation.id };
  }

  private async sendMessageAndWaitForFinal(input: {
    sidekickId: string;
    conversationId: string;
    content: string;
    signal: AbortSignal;
  }): Promise<string> {
    const manager = this.deps.getPersonalAgentConversationManager();
    return await new Promise<string>((resolve, reject) => {
      let settled = false;
      const settle = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        unsubscribe();
        input.signal.removeEventListener('abort', onAbort);
        callback();
      };
      const onAbort = (): void => settle(() => reject(input.signal.reason ?? new Error('sidekick_voice_cancelled')));
      const unsubscribe = manager.onConversationEvent((event) => {
        if (event.conversation.id !== input.conversationId) return;
        if (event.type === 'run.completed') {
          const assistant = [...event.conversation.messages]
            .reverse()
            .find((message) => message.role === 'assistant' && (!event.run?.id || message.runId === event.run.id));
          settle(() => resolve(assistant?.content ?? ''));
        } else if (event.type === 'run.failed' || event.type === 'run.canceled') {
          settle(() => reject(new Error(event.run?.error ?? `sidekick_voice_agent_${event.type}`)));
        }
      });
      input.signal.addEventListener('abort', onAbort, { once: true });
      void this.resolveVoiceProfile(input.sidekickId).then(async (profile) => {
        if (input.signal.aborted) throw input.signal.reason ?? new Error('sidekick_voice_cancelled');
        return await manager.sendSidekickMessage({
          conversationId: input.conversationId,
          sidekickId: input.sidekickId,
          content: input.content,
          locale: profile.locale,
          model: profile.model,
          voice: profile.voice,
        });
      }).catch((error: unknown) => {
        settle(() => reject(error));
      });
    });
  }

  private async speakWithTts(input: {
    sidekickId: string;
    text: string;
    signal: AbortSignal;
    onPlaybackStarted: () => Promise<void> | void;
  }): Promise<void> {
    if (input.signal.aborted) throw input.signal.reason;
    const ttsState = await this.deps.getTextToSpeechService().getState();
    const sidekick = await this.requireSidekick(input.sidekickId);
    const profile = resolveSidekickVoiceProfile(sidekick, ttsState);
    const playbackStarted = this.waitForPlaybackStarted(input.sidekickId, input.signal);
    try {
      const playbackWork = this.deps.getSidekickService().speak({
        sidekickId: input.sidekickId,
        text: input.text.slice(0, ttsState.config.maxTextCharacters),
        model: profile.model,
        voice: profile.voice,
      }, { signal: input.signal, manageScreen: false });
      const first = await Promise.race([
        playbackStarted.promise.then(() => 'started' as const),
        playbackWork.then(() => 'settled' as const),
      ]);
      if (first === 'started') await input.onPlaybackStarted();
      const result = await playbackWork;
      if (input.signal.aborted) throw input.signal.reason;
      if (!result.success) throw new Error(result.technicalCode ?? 'sidekick_voice_tts_failed');
    } finally {
      playbackStarted.cancel();
    }
  }

  private waitForPlaybackStarted(sidekickId: string, signal: AbortSignal): {
    promise: Promise<void>;
    cancel: () => void;
  } {
    let settled = false;
    let resolveStarted = (): void => undefined;
    let rejectStarted = (_error: unknown): void => undefined;
    const promise = new Promise<void>((resolve, reject) => {
      resolveStarted = resolve;
      rejectStarted = reject;
    });
    const listeners = this.playbackStartedListeners.get(sidekickId) ?? new Set<() => void>();
    this.playbackStartedListeners.set(sidekickId, listeners);
    const cleanup = (): void => {
      listeners.delete(onStarted);
      if (listeners.size === 0) this.playbackStartedListeners.delete(sidekickId);
      signal.removeEventListener('abort', onAbort);
    };
    const onStarted = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolveStarted();
    };
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectStarted(signal.reason ?? new Error('sidekick_voice_cancelled'));
    };
    listeners.add(onStarted);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    return {
      promise,
      cancel: () => {
        if (settled) return;
        settled = true;
        cleanup();
        // The waiter lost a race against a terminal playback result. Resolve
        // it so no detached rejection remains after the voice turn settles.
        resolveStarted();
      },
    };
  }

  private async requireSidekick(sidekickId: string): Promise<SidekickSummary> {
    const sidekick = (await this.deps.getSidekickService().getState()).sidekicks.find((item) => item.sidekickId === sidekickId);
    if (!sidekick) throw new Error('sidekick_not_registered');
    return sidekick;
  }

  private async resolveVoiceProfile(sidekickId: string): Promise<ResolvedSidekickVoiceProfile> {
    const [sidekick, ttsState] = await Promise.all([
      this.requireSidekick(sidekickId),
      this.deps.getTextToSpeechService().getState(),
    ]);
    return resolveSidekickVoiceProfile(sidekick, ttsState);
  }

  private logVoiceEvent(event: SidekickVoiceSessionEvent): void {
    this.deps.getSidekickService().notifyVoiceStateChanged();
    if (event.type === 'session.started') {
      this.queueVoiceLog('sidekick:voice_session_started', event, {
        sidekickId: event.session.sidekickId,
        sessionId: event.session.sessionId,
      });
      return;
    }
    if (event.type === 'phase.changed') {
      this.queueVoiceLog('sidekick:voice_phase_changed', event, {
        sidekickId: event.session.sidekickId,
        sessionId: event.session.sessionId,
        phase: event.session.phase,
        heardSpeech: event.session.heardSpeech,
        receivedSamples: event.session.receivedSamples,
      });
      return;
    }
    this.queueVoiceLog('sidekick:voice_session_finished', event, {
      sidekickId: event.result.sidekickId,
      sessionId: event.result.sessionId,
      status: event.result.status,
      technicalCode: event.result.technicalCode,
    });
  }

  private queueVoiceLog(
    name: string,
    event: SidekickVoiceSessionEvent,
    payload: Record<string, unknown>,
  ): void {
    if (!this.deps.appendLog) return;
    this.logWork = this.logWork
      .catch(() => undefined)
      .then(async () => await this.deps.appendLog!(name, {
        ...payload,
        eventSequence: event.eventSequence,
        occurredAt: new Date(event.occurredAt).toISOString(),
      }));
  }
}
