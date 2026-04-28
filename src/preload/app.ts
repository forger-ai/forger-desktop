import { contextBridge, ipcRenderer } from 'electron';
import type { ForgerAppApi } from '../shared/types';

const IPC_CHANNELS = {
  appSelectExternalFolder: 'forger:app:select-external-folder',
} as const;

const api: ForgerAppApi = {
  selectExternalFolder: () => ipcRenderer.invoke(IPC_CHANNELS.appSelectExternalFolder),
};

contextBridge.exposeInMainWorld('forgerApp', api);
