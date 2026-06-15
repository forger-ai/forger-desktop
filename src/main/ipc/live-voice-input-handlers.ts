import type { BrowserWindow, IpcMain } from 'electron';

import type { IPC_CHANNELS as IpcChannels } from '../../shared/ipc';
import type {
  LiveVoiceInputConfigInput,
  LiveVoiceInputDeviceListInput,
  LiveVoiceInputSessionInput,
  LiveVoiceInputStopInput,
  LiveVoiceInputWakeEvent,
  LiveVoiceInputWakeRuntime,
} from '../../shared/types';

interface LiveVoiceInputHandlerDeps {
  IPC_CHANNELS: typeof IpcChannels;
  ipcMain: IpcMain;
  mainWindow: BrowserWindow | null;
  getLiveVoiceInputService: () => {
    getState: () => Promise<unknown>;
    updateConfig: (input: LiveVoiceInputConfigInput) => Promise<unknown>;
    updateDevices: (input: LiveVoiceInputDeviceListInput) => Promise<unknown>;
    createSession: (input: LiveVoiceInputSessionInput) => Promise<unknown>;
    stop: (input?: LiveVoiceInputStopInput) => Promise<unknown>;
    recordWakeDetected: (input: Partial<LiveVoiceInputWakeEvent>) => Promise<unknown>;
    recordWakeReady: (input: Partial<LiveVoiceInputWakeRuntime>) => Promise<unknown>;
    recordWakeUnavailable: (input: Partial<LiveVoiceInputWakeRuntime>) => Promise<unknown>;
  };
}

export const registerLiveVoiceInputIpcHandlers = ({
  IPC_CHANNELS,
  ipcMain,
  mainWindow,
  getLiveVoiceInputService,
}: LiveVoiceInputHandlerDeps): void => {
  const emitState = (state: unknown): unknown => {
    mainWindow?.webContents.send(IPC_CHANNELS.liveVoiceInputChanged, state);
    return state;
  };
  ipcMain.handle(IPC_CHANNELS.liveVoiceInputGetState, async () => await getLiveVoiceInputService().getState());
  ipcMain.handle(IPC_CHANNELS.liveVoiceInputUpdateConfig, async (_event, input: LiveVoiceInputConfigInput) => emitState(await getLiveVoiceInputService().updateConfig(input)));
  ipcMain.handle(IPC_CHANNELS.liveVoiceInputUpdateDevices, async (_event, input: LiveVoiceInputDeviceListInput) => emitState(await getLiveVoiceInputService().updateDevices(input)));
  ipcMain.handle(IPC_CHANNELS.liveVoiceInputCreateSession, async (_event, input: LiveVoiceInputSessionInput) => {
    const session = await getLiveVoiceInputService().createSession(input);
    emitState(await getLiveVoiceInputService().getState());
    return session;
  });
  ipcMain.handle(IPC_CHANNELS.liveVoiceInputStop, async (_event, input: LiveVoiceInputStopInput = {}) => emitState(await getLiveVoiceInputService().stop(input)));
  ipcMain.handle(IPC_CHANNELS.liveVoiceInputWakeDetected, async (_event, input: Partial<LiveVoiceInputWakeEvent>) => emitState(await getLiveVoiceInputService().recordWakeDetected(input)));
  ipcMain.handle(IPC_CHANNELS.liveVoiceInputWakeReady, async (_event, input: Partial<LiveVoiceInputWakeRuntime>) => emitState(await getLiveVoiceInputService().recordWakeReady(input)));
  ipcMain.handle(IPC_CHANNELS.liveVoiceInputWakeUnavailable, async (_event, input: Partial<LiveVoiceInputWakeRuntime>) => emitState(await getLiveVoiceInputService().recordWakeUnavailable(input)));
};
