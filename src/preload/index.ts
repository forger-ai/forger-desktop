import { contextBridge, ipcRenderer } from 'electron';
import type { ForgerDesktopApi } from '../shared/types';

// En modo sandbox de Electron, el preload no debe depender de imports locales en runtime.
const IPC_CHANNELS = {
  getSession: 'forger:get-session',
  login: 'forger:login',
  logout: 'forger:logout',
  listInstalledApps: 'forger:list-installed-apps',
  listCatalogApps: 'forger:list-catalog-apps',
  installApp: 'forger:install-app',
  openApp: 'forger:open-app',
  stopApp: 'forger:stop-app',
  getAppRuntimeStatus: 'forger:get-app-runtime-status',
  getSettings: 'forger:get-settings',
  getCodexAuthStatus: 'forger:get-codex-auth-status',
  connectCodexAuth: 'forger:connect-codex-auth',
  disconnectCodexAuth: 'forger:disconnect-codex-auth',
  chatStartRun: 'forger:chat:start-run',
  chatGetRun: 'forger:chat:get-run',
  chatCancelRun: 'forger:chat:cancel-run',
  chatApprovePermission: 'forger:chat:approve-permission',
  chatApplyRun: 'forger:chat:apply-run',
  chatUndo: 'forger:chat:undo',
  installProgress: 'forger:install-progress',
  runtimeStatusChanged: 'forger:runtime-status-changed',
  chatRunUpdated: 'forger:chat:run-updated',
  dbListTables: 'forger:db:list-tables',
  dbQueryTable: 'forger:db:query-table',
} as const;

const api: ForgerDesktopApi = {
  getSession: () => ipcRenderer.invoke(IPC_CHANNELS.getSession),
  login: (email, password) => ipcRenderer.invoke(IPC_CHANNELS.login, email, password),
  logout: () => ipcRenderer.invoke(IPC_CHANNELS.logout),
  listInstalledApps: () => ipcRenderer.invoke(IPC_CHANNELS.listInstalledApps),
  listCatalogApps: () => ipcRenderer.invoke(IPC_CHANNELS.listCatalogApps),
  installApp: (appId) => ipcRenderer.invoke(IPC_CHANNELS.installApp, appId),
  openApp: (appId) => ipcRenderer.invoke(IPC_CHANNELS.openApp, appId),
  stopApp: (appId) => ipcRenderer.invoke(IPC_CHANNELS.stopApp, appId),
  getAppRuntimeStatus: (appId) => ipcRenderer.invoke(IPC_CHANNELS.getAppRuntimeStatus, appId),
  onInstallProgress: (listener) => {
    const wrapped = (_event: unknown, payload: Parameters<typeof listener>[0]) => {
      listener(payload);
    };
    ipcRenderer.on(IPC_CHANNELS.installProgress, wrapped);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.installProgress, wrapped);
    };
  },
  onRuntimeStatusChanged: (listener) => {
    const wrapped = (_event: unknown, payload: Parameters<typeof listener>[0]) => {
      listener(payload);
    };
    ipcRenderer.on(IPC_CHANNELS.runtimeStatusChanged, wrapped);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.runtimeStatusChanged, wrapped);
    };
  },
  getSettings: () => ipcRenderer.invoke(IPC_CHANNELS.getSettings),
  getCodexAuthStatus: () => ipcRenderer.invoke(IPC_CHANNELS.getCodexAuthStatus),
  connectCodexAuth: () => ipcRenderer.invoke(IPC_CHANNELS.connectCodexAuth),
  disconnectCodexAuth: () => ipcRenderer.invoke(IPC_CHANNELS.disconnectCodexAuth),
  chatStartRun: (input) => ipcRenderer.invoke(IPC_CHANNELS.chatStartRun, input),
  chatGetRun: (input) => ipcRenderer.invoke(IPC_CHANNELS.chatGetRun, input),
  chatCancelRun: (input) => ipcRenderer.invoke(IPC_CHANNELS.chatCancelRun, input),
  chatApprovePermission: (input) => ipcRenderer.invoke(IPC_CHANNELS.chatApprovePermission, input),
  chatApplyRun: (input) => ipcRenderer.invoke(IPC_CHANNELS.chatApplyRun, input),
  chatUndo: (input) => ipcRenderer.invoke(IPC_CHANNELS.chatUndo, input),
  onChatRunUpdated: (listener) => {
    const wrapped = (_event: unknown, payload: Parameters<typeof listener>[0]) => {
      listener(payload);
    };
    ipcRenderer.on(IPC_CHANNELS.chatRunUpdated, wrapped);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.chatRunUpdated, wrapped);
    };
  },
  dbListTables: (appId) => ipcRenderer.invoke(IPC_CHANNELS.dbListTables, appId),
  dbQueryTable: (appId, tableName, limit) => ipcRenderer.invoke(IPC_CHANNELS.dbQueryTable, appId, tableName, limit),
};

contextBridge.exposeInMainWorld('forger', api);
