import type { IpcMain } from 'electron';

import type { IPC_CHANNELS as IpcChannels } from '../../shared/ipc';
import type { SidekickConfigureInput, SidekickDisplayInput, SidekickMicrophonePlaybackInput, SidekickMicrophoneRecordingInput, SidekickPersonalAgentInput, SidekickScreenInput, SidekickSpeakInput } from '../../shared/types';
import type { AgentStore } from '../personal-agents/agent-store';
import type { SidekickService } from '../sidekick-service';

interface SidekickIpcHandlersDeps {
  IPC_CHANNELS: typeof IpcChannels;
  ipcMain: IpcMain;
  getSidekickService: () => SidekickService;
  getPersonalAgentStore: () => AgentStore;
}

export const registerSidekickIpcHandlers = ({
  IPC_CHANNELS,
  ipcMain,
  getSidekickService,
  getPersonalAgentStore,
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
  ipcMain.handle(IPC_CHANNELS.sidekicksSpeak, async (_event, input: SidekickSpeakInput) => await getSidekickService().speak(input));
  ipcMain.handle(IPC_CHANNELS.sidekicksStartMicrophoneRecording, async (_event, input: SidekickMicrophoneRecordingInput) => await getSidekickService().startMicrophoneRecording(input));
  ipcMain.handle(IPC_CHANNELS.sidekicksStopMicrophoneRecording, async (_event, input: SidekickMicrophoneRecordingInput) => await getSidekickService().stopMicrophoneRecording(input));
  ipcMain.handle(IPC_CHANNELS.sidekicksReadMicrophoneRecording, async (_event, input: SidekickMicrophonePlaybackInput) => await getSidekickService().readMicrophoneRecording(input));
  ipcMain.handle(IPC_CHANNELS.sidekicksForget, async (_event, sidekickId: string) => await getSidekickService().forget(sidekickId));
};
