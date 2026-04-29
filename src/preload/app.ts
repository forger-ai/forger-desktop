import { contextBridge, ipcRenderer } from 'electron';
import type { ForgerAppApi } from '../shared/types';

const IPC_CHANNELS = {
  appSelectExternalFolder: 'forger:app:select-external-folder',
  appCodexTaskStart: 'forger:app:codex-task:start',
  appCodexTaskGet: 'forger:app:codex-task:get',
  appCodexTaskCancel: 'forger:app:codex-task:cancel',
  appCodexTaskUpdated: 'forger:app:codex-task:updated',
} as const;

const api: ForgerAppApi = {
  selectExternalFolder: () => ipcRenderer.invoke(IPC_CHANNELS.appSelectExternalFolder),
  startCodexTask: (input) => ipcRenderer.invoke(IPC_CHANNELS.appCodexTaskStart, input),
  getCodexTask: (runId) => ipcRenderer.invoke(IPC_CHANNELS.appCodexTaskGet, runId),
  cancelCodexTask: (runId) => ipcRenderer.invoke(IPC_CHANNELS.appCodexTaskCancel, runId),
  onCodexTaskUpdated: (listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, event: unknown) => {
      listener(event as Parameters<typeof listener>[0]);
    };
    ipcRenderer.on(IPC_CHANNELS.appCodexTaskUpdated, wrapped);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.appCodexTaskUpdated, wrapped);
    };
  },
};

contextBridge.exposeInMainWorld('forgerApp', api);
