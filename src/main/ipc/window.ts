import { BrowserWindow, type IpcMain, type IpcMainInvokeEvent } from 'electron';

import { IPC_CHANNELS } from '../../shared/ipc';
import type { WindowControlState } from '../../shared/types';

type RegisterWindowIpcHandlersInput = {
  ipcMain: IpcMain;
  getMainWindow: () => BrowserWindow | null;
  readWindowState: (window: BrowserWindow) => WindowControlState;
  quitApp: () => void;
};

const getInvokingWindow = (event: IpcMainInvokeEvent): BrowserWindow | null =>
  BrowserWindow.fromWebContents(event.sender);

export const createWindowStateReader = (usesCustomFrame: boolean) =>
  (window: BrowserWindow): WindowControlState => ({
    isMaximized: window.isMaximized(),
    isFullScreen: window.isFullScreen(),
    usesCustomFrame,
  });

export const createWindowStateEventRegistrar = (
  readWindowState: (window: BrowserWindow) => WindowControlState,
) =>
  (window: BrowserWindow): void => {
    const emitWindowState = (): void => {
      if (!window.isDestroyed()) {
        window.webContents.send(IPC_CHANNELS.windowStateChanged, readWindowState(window));
      }
    };
    window.on('maximize', emitWindowState);
    window.on('unmaximize', emitWindowState);
    window.on('restore', emitWindowState);
    window.on('enter-full-screen', emitWindowState);
    window.on('leave-full-screen', emitWindowState);
  };

export const registerWindowIpcHandlers = ({
  ipcMain,
  getMainWindow,
  readWindowState,
  quitApp,
}: RegisterWindowIpcHandlersInput): void => {
  ipcMain.handle(IPC_CHANNELS.windowMinimize, async (event) => {
    getInvokingWindow(event)?.minimize();
  });

  ipcMain.handle(IPC_CHANNELS.windowToggleMaximize, async (event) => {
    const window = getInvokingWindow(event);
    if (!window) {
      throw new Error('window_not_found');
    }

    if (window.isMaximized()) {
      window.unmaximize();
    } else {
      window.maximize();
    }

    return readWindowState(window);
  });

  ipcMain.handle(IPC_CHANNELS.windowClose, async (event) => {
    const window = getInvokingWindow(event);
    if (!window) {
      return;
    }
    if (window === getMainWindow()) {
      quitApp();
      return;
    }
    window.close();
  });

  ipcMain.handle(IPC_CHANNELS.windowGetState, async (event) => {
    const window = getInvokingWindow(event);
    if (!window) {
      throw new Error('window_not_found');
    }

    return readWindowState(window);
  });
};
