import type { AgentConversationManager } from './personal-agents/agent-conversation-manager';
import type { AgentStore } from './personal-agents/agent-store';
import type { SidekickService } from './sidekick-service';
import { SidekickMicrophonePreprocessor } from './sidekick-audio-codec';
import { buildPcm16MonoWav } from './sidekick-service-helpers';
import {
  SidekickVoiceSessionManager,
  type SidekickDisconnectEvent,
  type SidekickPcmEvent,
  type SidekickWakeEvent,
} from './sidekick-voice-session-manager';
import type { SpeechToTextServiceManager } from './speech-to-text-service';
import type { TextToSpeechServiceManager } from './text-to-speech-service';
import type { SidekickState, SidekickWakeEvent as SidekickProtocolWakeEvent } from '../shared/types';

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
  private readonly manager: SidekickVoiceSessionManager;

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
      transcribePcmBuffer: async ({ chunks, sampleRate, signal }) => {
        if (signal.aborted) throw signal.reason;
        const wav = buildPcm16MonoWav(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))), sampleRate);
        const result = await this.deps.getSpeechToTextService().processUpload({
          filename: 'sidekick-voice.wav',
          mimeType: 'audio/wav',
          data: Uint8Array.from(wav).buffer,
          task: 'transcribe',
        });
        if (signal.aborted) throw signal.reason;
        if (!result.success) throw new Error(result.technicalCode ?? 'sidekick_voice_transcription_failed');
        return result.text?.trim() ?? '';
      },
      createOrReuseConversation: async ({ sidekickId, existingConversationId }) => {
        const conversations = this.deps.getPersonalAgentConversationManager();
        const agents = await this.deps.getPersonalAgentStore().listAgents();
        const sidekick = (await this.deps.getSidekickService().getState()).sidekicks.find((item) => item.sidekickId === sidekickId);
        const personalAgentId = selectSidekickPersonalAgentId(sidekick?.personalAgentId, agents);
        const existing = existingConversationId ? await conversations.getConversation(existingConversationId) : null;
        if (existing?.agentId === personalAgentId) {
          return { conversationId: existing.id };
        }
        const conversation = await conversations.createConversation({ agentId: personalAgentId, title: 'Sidekick' });
        return { conversationId: conversation.id };
      },
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
      onEvent: (event) => {
        if (event.type !== 'session.finished' || event.result.status === 'completed' || event.result.status === 'silence') return;
        void this.deps.appendLog?.('sidekick:voice_session_finished', {
          sidekickId: event.result.sidekickId,
          status: event.result.status,
          technicalCode: event.result.technicalCode,
        });
      },
    });
  }

  public start(): void {
    this.manager.start();
  }

  public async dispose(): Promise<void> {
    await this.manager.dispose();
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
      if (sidekick.status === 'online') continue;
      for (const listener of this.disconnectListeners) listener({ sidekickId: sidekick.sidekickId });
    }
  }

  private subscribe<T>(listeners: Set<(event: T) => void>, listener: (event: T) => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  private async sendMessageAndWaitForFinal(input: {
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
      void manager.sendMessage({ conversationId: input.conversationId, content: input.content }).catch((error: unknown) => {
        settle(() => reject(error));
      });
    });
  }

  private async speakWithTts(input: { sidekickId: string; text: string; signal: AbortSignal }): Promise<void> {
    if (input.signal.aborted) throw input.signal.reason;
    const ttsState = await this.deps.getTextToSpeechService().getState();
    const voice = ttsState.voices.find((candidate) => (
      candidate.id === ttsState.config.defaultVoice &&
      candidate.model === ttsState.config.defaultModel &&
      candidate.installed &&
      candidate.enabled
    )) ?? ttsState.voices.find((candidate) => candidate.installed && candidate.enabled);
    if (!voice) throw new Error('sidekick_voice_tts_voice_required');
    const result = await this.deps.getSidekickService().speak({
      sidekickId: input.sidekickId,
      text: input.text.slice(0, ttsState.config.maxTextCharacters),
      model: voice.model,
      voice: voice.id,
    });
    if (input.signal.aborted) throw input.signal.reason;
    if (!result.success) throw new Error(result.technicalCode ?? 'sidekick_voice_tts_failed');
  }
}
