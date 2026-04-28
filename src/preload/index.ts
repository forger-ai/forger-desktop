import { contextBridge, ipcRenderer } from 'electron';
import type { ForgerDesktopApi } from '../shared/types';

// En modo sandbox de Electron, el preload no debe depender de imports locales en runtime.
const IPC_CHANNELS = {
  listInstalledApps: 'forger:list-installed-apps',
  listCatalogApps: 'forger:list-catalog-apps',
  installApp: 'forger:install-app',
  updateApp: 'forger:update-app',
  restoreAppUserVersion: 'forger:restore-app-user-version',
  resolveAppUpdateConflict: 'forger:resolve-app-update-conflict',
  uninstallApp: 'forger:uninstall-app',
  getAppDetails: 'forger:get-app-details',
  installWelcome: 'forger:install-welcome',
  openApp: 'forger:open-app',
  stopApp: 'forger:stop-app',
  getAppRuntimeStatus: 'forger:get-app-runtime-status',
  getAppSecrets: 'forger:get-app-secrets',
  listUserSecrets: 'forger:list-user-secrets',
  createUserSecret: 'forger:create-user-secret',
  updateUserSecret: 'forger:update-user-secret',
  deleteUserSecret: 'forger:delete-user-secret',
  connectAppSecret: 'forger:connect-app-secret',
  disconnectAppSecret: 'forger:disconnect-app-secret',
  getSettings: 'forger:get-settings',
  getCodexAuthStatus: 'forger:get-codex-auth-status',
  openCodexUsageDashboard: 'forger:open-codex-usage-dashboard',
  connectCodexAuth: 'forger:connect-codex-auth',
  disconnectCodexAuth: 'forger:disconnect-codex-auth',
  listAgentTools: 'forger:agent-tools:list',
  getAgentToolSettings: 'forger:agent-tools:get-settings',
  updateAgentToolApproval: 'forger:agent-tools:update-approval',
  chatStartRun: 'forger:chat:start-run',
  chatGetRun: 'forger:chat:get-run',
  chatCancelRun: 'forger:chat:cancel-run',
  chatApprovePermission: 'forger:chat:approve-permission',
  chatApplyRun: 'forger:chat:apply-run',
  chatUndo: 'forger:chat:undo',
  installProgress: 'forger:install-progress',
  runtimeStatusChanged: 'forger:runtime-status-changed',
  chatRunUpdated: 'forger:chat:run-updated',
  filesPickForChat: 'forger:files:pick-for-chat',
  filesList: 'forger:files:list',
  filesListCategories: 'forger:files:list-categories',
  filesCreateCategory: 'forger:files:create-category',
  filesRenameCategory: 'forger:files:rename-category',
  filesDeleteCategory: 'forger:files:delete-category',
  filesImport: 'forger:files:import',
  filesMove: 'forger:files:move',
  filesRename: 'forger:files:rename',
  filesDelete: 'forger:files:delete',
  dbListTables: 'forger:db:list-tables',
  dbQueryTable: 'forger:db:query-table',
} as const;

const api: ForgerDesktopApi = {
  listInstalledApps: () => ipcRenderer.invoke(IPC_CHANNELS.listInstalledApps),
  listCatalogApps: () => ipcRenderer.invoke(IPC_CHANNELS.listCatalogApps),
  installApp: (appId) => ipcRenderer.invoke(IPC_CHANNELS.installApp, appId),
  updateApp: (appId) => ipcRenderer.invoke(IPC_CHANNELS.updateApp, appId),
  restoreAppUserVersion: (appId) => ipcRenderer.invoke(IPC_CHANNELS.restoreAppUserVersion, appId),
  resolveAppUpdateConflict: (appId) => ipcRenderer.invoke(IPC_CHANNELS.resolveAppUpdateConflict, appId),
  uninstallApp: (appId) => ipcRenderer.invoke(IPC_CHANNELS.uninstallApp, appId),
  getAppDetails: (appId) => ipcRenderer.invoke(IPC_CHANNELS.getAppDetails, appId),
  installWelcome: (appId, userLanguage) => ipcRenderer.invoke(IPC_CHANNELS.installWelcome, appId, userLanguage),
  openApp: (appId) => ipcRenderer.invoke(IPC_CHANNELS.openApp, appId),
  stopApp: (appId) => ipcRenderer.invoke(IPC_CHANNELS.stopApp, appId),
  getAppRuntimeStatus: (appId) => ipcRenderer.invoke(IPC_CHANNELS.getAppRuntimeStatus, appId),
  getAppSecrets: (appId) => ipcRenderer.invoke(IPC_CHANNELS.getAppSecrets, appId),
  listUserSecrets: () => ipcRenderer.invoke(IPC_CHANNELS.listUserSecrets),
  createUserSecret: (input) => ipcRenderer.invoke(IPC_CHANNELS.createUserSecret, input),
  updateUserSecret: (input) => ipcRenderer.invoke(IPC_CHANNELS.updateUserSecret, input),
  deleteUserSecret: (input) => ipcRenderer.invoke(IPC_CHANNELS.deleteUserSecret, input),
  connectAppSecret: (input) => ipcRenderer.invoke(IPC_CHANNELS.connectAppSecret, input),
  disconnectAppSecret: (input) => ipcRenderer.invoke(IPC_CHANNELS.disconnectAppSecret, input),
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
  openCodexUsageDashboard: () => ipcRenderer.invoke(IPC_CHANNELS.openCodexUsageDashboard),
  connectCodexAuth: () => ipcRenderer.invoke(IPC_CHANNELS.connectCodexAuth),
  disconnectCodexAuth: () => ipcRenderer.invoke(IPC_CHANNELS.disconnectCodexAuth),
  listAgentTools: () => ipcRenderer.invoke(IPC_CHANNELS.listAgentTools),
  getAgentToolSettings: () => ipcRenderer.invoke(IPC_CHANNELS.getAgentToolSettings),
  updateAgentToolApproval: (input) => ipcRenderer.invoke(IPC_CHANNELS.updateAgentToolApproval, input),
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
  filesPickForChat: () => ipcRenderer.invoke(IPC_CHANNELS.filesPickForChat),
  filesList: (input) => ipcRenderer.invoke(IPC_CHANNELS.filesList, input),
  filesListCategories: () => ipcRenderer.invoke(IPC_CHANNELS.filesListCategories),
  filesCreateCategory: (input) => ipcRenderer.invoke(IPC_CHANNELS.filesCreateCategory, input),
  filesRenameCategory: (input) => ipcRenderer.invoke(IPC_CHANNELS.filesRenameCategory, input),
  filesDeleteCategory: (input) => ipcRenderer.invoke(IPC_CHANNELS.filesDeleteCategory, input),
  filesImport: (input) => ipcRenderer.invoke(IPC_CHANNELS.filesImport, input),
  filesMove: (input) => ipcRenderer.invoke(IPC_CHANNELS.filesMove, input),
  filesRename: (input) => ipcRenderer.invoke(IPC_CHANNELS.filesRename, input),
  filesDelete: (input) => ipcRenderer.invoke(IPC_CHANNELS.filesDelete, input),
  dbListTables: (appId) => ipcRenderer.invoke(IPC_CHANNELS.dbListTables, appId),
  dbQueryTable: (appId, tableName, limit) => ipcRenderer.invoke(IPC_CHANNELS.dbQueryTable, appId, tableName, limit),
};

contextBridge.exposeInMainWorld('forger', api);
