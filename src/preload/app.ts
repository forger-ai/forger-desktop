import { contextBridge, ipcRenderer } from 'electron';
import type { ForgerAppApi } from '../shared/types';

const IPC_CHANNELS = {
  appSelectExternalFolder: 'forger:app:select-external-folder',
  appCodexTaskStart: 'forger:app:codex-task:start',
  appCodexTaskGet: 'forger:app:codex-task:get',
  appCodexTaskCancel: 'forger:app:codex-task:cancel',
  appCodexTaskUpdated: 'forger:app:codex-task:updated',
  appCodexConversationCreate: 'forger:app:codex-conversation:create',
  appCodexConversationSendMessage: 'forger:app:codex-conversation:send-message',
  appCodexConversationGet: 'forger:app:codex-conversation:get',
  appCodexConversationList: 'forger:app:codex-conversation:list',
  appCodexConversationCancelRun: 'forger:app:codex-conversation:cancel-run',
  appCodexConversationEvent: 'forger:app:codex-conversation:event',
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
  createCodexConversation: (input) => ipcRenderer.invoke(IPC_CHANNELS.appCodexConversationCreate, input ?? {}),
  sendCodexConversationMessage: (input) => ipcRenderer.invoke(IPC_CHANNELS.appCodexConversationSendMessage, input),
  getCodexConversation: (conversationId) => ipcRenderer.invoke(IPC_CHANNELS.appCodexConversationGet, conversationId),
  listCodexConversations: () => ipcRenderer.invoke(IPC_CHANNELS.appCodexConversationList),
  cancelCodexConversationRun: (conversationId, runId) =>
    ipcRenderer.invoke(IPC_CHANNELS.appCodexConversationCancelRun, conversationId, runId),
  onCodexConversationEvent: (listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, event: unknown) => {
      listener(event as Parameters<typeof listener>[0]);
    };
    ipcRenderer.on(IPC_CHANNELS.appCodexConversationEvent, wrapped);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.appCodexConversationEvent, wrapped);
    };
  },
};

contextBridge.exposeInMainWorld('forgerApp', api);
