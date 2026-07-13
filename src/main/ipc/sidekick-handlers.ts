import type { IpcMain } from 'electron';

import type { IPC_CHANNELS as IpcChannels } from '../../shared/ipc';
import type { SidekickConfigureInput, SidekickDisplayInput, SidekickIdleConfigInput, SidekickIdleImageInput, SidekickMicrophonePlaybackInput, SidekickMicrophoneRecordingInput, SidekickPersonalAgentInput, SidekickScreenInput, SidekickSpeakInput, SidekickVoiceConfigInput, TextToSpeechState } from '../../shared/types';
import type { AgentStore } from '../personal-agents/agent-store';
import type { SidekickService } from '../sidekick-service';
import { canonicalSidekickLocale, localeForSidekickVoice } from '../sidekick-voice-profile';

interface SidekickIpcHandlersDeps {
  IPC_CHANNELS: typeof IpcChannels;
  ipcMain: IpcMain;
  getSidekickService: () => SidekickService;
  getPersonalAgentStore: () => AgentStore;
  getTextToSpeechService: () => { getState: () => Promise<TextToSpeechState> };
}

export const registerSidekickIpcHandlers = ({
  IPC_CHANNELS,
  ipcMain,
  getSidekickService,
  getPersonalAgentStore,
  getTextToSpeechService,
}: SidekickIpcHandlersDeps): void => {
  ipcMain.handle(IPC_CHANNELS.sidekicksGetState, async () => await getSidekickService().getState());
  ipcMain.handle(IPC_CHANNELS.sidekicksScanUsb, async () => await getSidekickService().scanUsb());
  ipcMain.handle(IPC_CHANNELS.sidekicksConfigureUsb, async (_event, input: SidekickConfigureInput) => await getSidekickService().configureUsb(input));
  ipcMain.handle(IPC_CHANNELS.sidekicksSendDisplay, async (_event, input: SidekickDisplayInput) => await getSidekickService().sendDisplay(input));
  ipcMain.handle(IPC_CHANNELS.sidekicksSendScreen, async (_event, input: SidekickScreenInput) => await getSidekickService().sendScreen(input));
  ipcMain.handle(IPC_CHANNELS.sidekicksSetPersonalAgent, async (_event, input: SidekickPersonalAgentInput) => {
    if (input.personalAgentId && !await getPersonalAgentStore().getAgent(input.personalAgentId)) {
      const state = await getSidekickService().getState();
      return { ...state, success: false, userMessage: 'Ese agente personal ya no está disponible.', technicalCode: 'sidekick_personal_agent_not_found' };
    }
    return await getSidekickService().setPersonalAgent(input);
  });
  ipcMain.handle(IPC_CHANNELS.sidekicksSetVoiceConfig, async (_event, input: SidekickVoiceConfigInput) => {
    const model = input.config?.model?.trim();
    const voiceId = input.config?.voice?.trim();
    if (!model && !voiceId) return await getSidekickService().setVoiceConfig(input);
    const tts = await getTextToSpeechService().getState();
    const voice = tts.voices.find((candidate) => candidate.model === model && candidate.id === voiceId);
    const locale = voice ? localeForSidekickVoice(voice) : undefined;
    const requestedLocale = canonicalSidekickLocale(input.config?.locale);
    if (!voice || !voice.installed || !voice.enabled || !locale || (requestedLocale && requestedLocale !== locale)) {
      const state = await getSidekickService().getState();
      return { ...state, success: false, userMessage: 'Esa voz ya no está disponible.', technicalCode: 'sidekick_voice_not_available' };
    }
    return await getSidekickService().setVoiceConfig({
      ...input,
      config: { ...input.config, model: voice.model, voice: voice.id, locale },
    });
  });
  ipcMain.handle(IPC_CHANNELS.sidekicksSpeak, async (_event, input: SidekickSpeakInput) => await getSidekickService().speak(input));
  ipcMain.handle(IPC_CHANNELS.sidekicksStartMicrophoneRecording, async (_event, input: SidekickMicrophoneRecordingInput) => await getSidekickService().startMicrophoneRecording(input));
  ipcMain.handle(IPC_CHANNELS.sidekicksStopMicrophoneRecording, async (_event, input: SidekickMicrophoneRecordingInput) => await getSidekickService().stopMicrophoneRecording(input));
  ipcMain.handle(IPC_CHANNELS.sidekicksReadMicrophoneRecording, async (_event, input: SidekickMicrophonePlaybackInput) => await getSidekickService().readMicrophoneRecording(input));
  ipcMain.handle(IPC_CHANNELS.sidekicksSetIdleConfig, async (_event, input: SidekickIdleConfigInput) => await getSidekickService().setIdleConfig(input));
  ipcMain.handle(IPC_CHANNELS.sidekicksSetIdleImage, async (_event, input: SidekickIdleImageInput) => await getSidekickService().setIdleImage(input));
  ipcMain.handle(IPC_CHANNELS.sidekicksForget, async (_event, sidekickId: string) => await getSidekickService().forget(sidekickId));
};
