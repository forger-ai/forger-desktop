import type { BrowserWindow, IpcMain } from 'electron';

import type { IPC_CHANNELS as IpcChannels } from '../../shared/ipc';
import type { WakeWordConfigInput, WakeWordDiagnosticEvent, WakeWordRuntime } from '../../shared/types';

interface WakeWordHandlerDeps {
  IPC_CHANNELS: typeof IpcChannels;
  ipcMain: IpcMain;
  mainWindow: BrowserWindow | null;
  getWakeWordService: () => {
    getState: () => Promise<unknown>;
    install: () => Promise<unknown>;
    start: () => Promise<unknown>;
    stop: () => void;
    updateConfig: (input: WakeWordConfigInput) => Promise<unknown>;
    createSession: () => Promise<unknown>;
    recordReady: (input: Partial<WakeWordRuntime>) => Promise<unknown>;
    recordUnavailable: (input: Partial<WakeWordRuntime>) => Promise<unknown>;
    recordDetected: (input: { deviceId?: string; modelId?: string; confidence?: number }) => Promise<unknown>;
    recordDiagnostic: (input: WakeWordDiagnosticEvent) => Promise<unknown>;
  };
}

export const registerWakeWordIpcHandlers = ({
  IPC_CHANNELS,
  ipcMain,
  mainWindow,
  getWakeWordService,
}: WakeWordHandlerDeps): void => {
  const emitState = (state: unknown): unknown => {
    mainWindow?.webContents.send(IPC_CHANNELS.wakeWordChanged, state);
    return state;
  };
  ipcMain.handle(IPC_CHANNELS.wakeWordGetState, async () => await getWakeWordService().getState());
  ipcMain.handle(IPC_CHANNELS.wakeWordInstall, async () => emitState(await getWakeWordService().install()));
  ipcMain.handle(IPC_CHANNELS.wakeWordStart, async () => emitState(await getWakeWordService().start()));
  ipcMain.handle(IPC_CHANNELS.wakeWordStop, async () => {
    getWakeWordService().stop();
    return emitState(await getWakeWordService().getState());
  });
  ipcMain.handle(IPC_CHANNELS.wakeWordUpdateConfig, async (_event, input: WakeWordConfigInput) => emitState(await getWakeWordService().updateConfig(input)));
  ipcMain.handle(IPC_CHANNELS.wakeWordCreateSession, async () => {
    const session = await getWakeWordService().createSession();
    emitState(await getWakeWordService().getState());
    return session;
  });
  ipcMain.handle(IPC_CHANNELS.wakeWordRecordReady, async (_event, input: Partial<WakeWordRuntime>) => emitState(await getWakeWordService().recordReady(input)));
  ipcMain.handle(IPC_CHANNELS.wakeWordRecordUnavailable, async (_event, input: Partial<WakeWordRuntime>) => emitState(await getWakeWordService().recordUnavailable(input)));
  ipcMain.handle(IPC_CHANNELS.wakeWordRecordDetected, async (_event, input: { deviceId?: string; modelId?: string; confidence?: number }) => emitState(await getWakeWordService().recordDetected(input)));
  ipcMain.handle(IPC_CHANNELS.wakeWordRecordDiagnostic, async (_event, input: WakeWordDiagnosticEvent) => emitState(await getWakeWordService().recordDiagnostic(input)));
};
