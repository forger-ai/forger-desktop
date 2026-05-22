import { contextBridge, ipcRenderer } from 'electron';
import type { ForgerDesktopApi } from '../shared/types';

// En modo sandbox de Electron, el preload no debe depender de imports locales en runtime.
const IPC_CHANNELS = {
  listInstalledApps: 'forger:list-installed-apps',
  listCatalogApps: 'forger:list-catalog-apps',
  installApp: 'forger:install-app',
  updateApp: 'forger:update-app',
  listBackups: 'forger:backups:list',
  createBackup: 'forger:backups:create',
  deleteBackup: 'forger:backups:delete',
  restoreBackup: 'forger:backups:restore',
  listRemoteBackups: 'forger:backups:remote:list',
  createRemoteBackup: 'forger:backups:remote:create',
  deleteRemoteBackup: 'forger:backups:remote:delete',
  restoreRemoteBackup: 'forger:backups:remote:restore',
  getCloudSyncSettings: 'forger:cloud-sync:get-settings',
  setAppAutoSync: 'forger:cloud-sync:set-app-auto-sync',
  restoreAppUserVersion: 'forger:restore-app-user-version',
  resolveAppUpdateConflict: 'forger:resolve-app-update-conflict',
  uninstallApp: 'forger:uninstall-app',
  getAppDetails: 'forger:get-app-details',
  listAppPrompts: 'forger:app-prompts:list',
  validateAppPrompt: 'forger:app-prompts:validate',
  updateAppPrompt: 'forger:app-prompts:update',
  restoreAppPrompt: 'forger:app-prompts:restore',
  installWelcome: 'forger:install-welcome',
  openApp: 'forger:open-app',
  stopApp: 'forger:stop-app',
  getAppRuntimeStatus: 'forger:get-app-runtime-status',
  startLocalNetworkShare: 'forger:local-network-share:start',
  stopLocalNetworkShare: 'forger:local-network-share:stop',
  getLocalNetworkShareStatus: 'forger:local-network-share:get-status',
  startRemoteNetworkShare: 'forger:remote-network-share:start',
  stopRemoteNetworkShare: 'forger:remote-network-share:stop',
  getRemoteNetworkShareStatus: 'forger:remote-network-share:get-status',
  getAppSecrets: 'forger:get-app-secrets',
  listUserSecrets: 'forger:list-user-secrets',
  createUserSecret: 'forger:create-user-secret',
  updateUserSecret: 'forger:update-user-secret',
  deleteUserSecret: 'forger:delete-user-secret',
  connectAppSecret: 'forger:connect-app-secret',
  disconnectAppSecret: 'forger:disconnect-app-secret',
  getSettings: 'forger:get-settings',
  updateCodexDefaults: 'forger:update-codex-defaults',
  updateAgentDefaults: 'forger:update-agent-defaults',
  getDesktopUpdateState: 'forger:desktop-update:get-state',
  checkDesktopUpdates: 'forger:desktop-update:check',
  downloadDesktopUpdate: 'forger:desktop-update:download',
  installDesktopUpdate: 'forger:desktop-update:install',
  desktopUpdateProgress: 'forger:desktop-update:progress',
  getForgerAccount: 'forger:account:get',
  registerForgerAccount: 'forger:account:register',
  loginForgerAccount: 'forger:account:login',
  loginForgerAccountWithGoogle: 'forger:account:login-google',
  updateForgerAccountProfile: 'forger:account:update-profile',
  logoutForgerAccount: 'forger:account:logout',
  forgerAccountUpdated: 'forger:account:updated',
  getCloudDevices: 'forger:cloud-devices:get',
  generateDevicePairingCode: 'forger:cloud-devices:pairing-code',
  listFriends: 'forger:friends:list',
  searchFriends: 'forger:friends:search',
  sendFriendRequest: 'forger:friends:request',
  acceptFriendRequest: 'forger:friends:accept',
  declineFriendRequest: 'forger:friends:decline',
  cancelFriendRequest: 'forger:friends:cancel',
  markFriendChatRead: 'forger:friends:mark-chat-read',
  listCloudMessages: 'forger:cloud-messages:list',
  sendCloudMessage: 'forger:cloud-messages:send',
  decideAppMessagePermission: 'forger:cloud-messages:permission',
  openFriendChatWindow: 'forger:friends:open-chat-window',
  cloudFriendshipEvent: 'forger:cloud-friendship:event',
  getCloudIdentity: 'forger:cloud-identity:get',
  revealCloudSecretKey: 'forger:cloud-identity:reveal',
  regenerateCloudSecretKey: 'forger:cloud-identity:regenerate',
  submitAppRating: 'forger:catalog:rating:submit',
  submitProductFeedback: 'forger:feedback:submit',
  submitUsageEvent: 'forger:usage-events:submit',
  openExternalUrl: 'forger:open-external-url',
  getCodexAuthStatus: 'forger:get-codex-auth-status',
  openCodexUsageDashboard: 'forger:open-codex-usage-dashboard',
  connectCodexAuth: 'forger:connect-codex-auth',
  disconnectCodexAuth: 'forger:disconnect-codex-auth',
  reinstallCodex: 'forger:reinstall-codex',
  getClaudeAuthStatus: 'forger:get-claude-auth-status',
  connectClaudeAuth: 'forger:connect-claude-auth',
  reinstallClaude: 'forger:reinstall-claude',
  submitDesktopErrorReport: 'forger:error-report:submit',
  desktopErrorReportRequested: 'forger:error-report:requested',
  listAgentTools: 'forger:agent-tools:list',
  getAgentToolSettings: 'forger:agent-tools:get-settings',
  updateAgentToolApproval: 'forger:agent-tools:update-approval',
  listOfficialTools: 'forger:official-tools:list',
  refreshOfficialTools: 'forger:official-tools:refresh',
  activateOfficialTool: 'forger:official-tools:activate',
  configureOfficialTool: 'forger:official-tools:configure',
  deactivateOfficialTool: 'forger:official-tools:deactivate',
  getAppToolsInstallGate: 'forger:app-tools:install-gate',
  setAppToolGrant: 'forger:app-tools:set-grant',
  memoryList: 'forger:memory:list',
  memoryCreate: 'forger:memory:create',
  memoryUpdate: 'forger:memory:update',
  memoryDelete: 'forger:memory:delete',
  chatStartRun: 'forger:chat:start-run',
  chatGetRun: 'forger:chat:get-run',
  chatCancelRun: 'forger:chat:cancel-run',
  chatApprovePermission: 'forger:chat:approve-permission',
  chatApplyRun: 'forger:chat:apply-run',
  chatUndo: 'forger:chat:undo',
  chatTrace: 'forger:chat:trace',
  installProgress: 'forger:install-progress',
  runtimeStatusChanged: 'forger:runtime-status-changed',
  chatRunUpdated: 'forger:chat:run-updated',
  filesPickForChat: 'forger:files:pick-for-chat',
  filesStageForChat: 'forger:files:stage-for-chat',
  filesDiscardStagedForChat: 'forger:files:discard-staged-for-chat',
  filesList: 'forger:files:list',
  filesListCategories: 'forger:files:list-categories',
  filesCreateCategory: 'forger:files:create-category',
  filesRenameCategory: 'forger:files:rename-category',
  filesDeleteCategory: 'forger:files:delete-category',
  filesImport: 'forger:files:import',
  filesMove: 'forger:files:move',
  filesRename: 'forger:files:rename',
  filesDelete: 'forger:files:delete',
  appSelectExternalFolder: 'forger:app:select-external-folder',
  dbListTables: 'forger:db:list-tables',
  dbQueryTable: 'forger:db:query-table',
  automationsList: 'forger:automations:list',
  automationsCreate: 'forger:automations:create',
  automationsUpdate: 'forger:automations:update',
  automationsDelete: 'forger:automations:delete',
  automationsPause: 'forger:automations:pause',
  automationsResume: 'forger:automations:resume',
  automationsRunNow: 'forger:automations:run-now',
  automationsListRuns: 'forger:automations:list-runs',
  automationsGetRunTranscript: 'forger:automations:get-run-transcript',
  automationUpdated: 'forger:automations:updated',
  windowMinimize: 'forger:window:minimize',
  windowToggleMaximize: 'forger:window:toggle-maximize',
  windowClose: 'forger:window:close',
  windowGetState: 'forger:window:get-state',
  windowStateChanged: 'forger:window:state-changed',
  deepLink: 'forger:deep-link',
} as const;

const api: ForgerDesktopApi = {
  listInstalledApps: () => ipcRenderer.invoke(IPC_CHANNELS.listInstalledApps),
  listCatalogApps: () => ipcRenderer.invoke(IPC_CHANNELS.listCatalogApps),
  installApp: (appId, locale) => ipcRenderer.invoke(IPC_CHANNELS.installApp, appId, locale),
  updateApp: (appId, locale) => ipcRenderer.invoke(IPC_CHANNELS.updateApp, appId, locale),
  listBackups: (appId) => ipcRenderer.invoke(IPC_CHANNELS.listBackups, appId),
  createBackup: (input) => ipcRenderer.invoke(IPC_CHANNELS.createBackup, input),
  deleteBackup: (input) => ipcRenderer.invoke(IPC_CHANNELS.deleteBackup, input),
  restoreBackup: (input) => ipcRenderer.invoke(IPC_CHANNELS.restoreBackup, input),
  listRemoteBackups: (appId) => ipcRenderer.invoke(IPC_CHANNELS.listRemoteBackups, appId),
  createRemoteBackup: (input) => ipcRenderer.invoke(IPC_CHANNELS.createRemoteBackup, input),
  deleteRemoteBackup: (remoteBackupId) => ipcRenderer.invoke(IPC_CHANNELS.deleteRemoteBackup, remoteBackupId),
  restoreRemoteBackup: (input) => ipcRenderer.invoke(IPC_CHANNELS.restoreRemoteBackup, input),
  getCloudSyncSettings: () => ipcRenderer.invoke(IPC_CHANNELS.getCloudSyncSettings),
  setAppAutoSync: (appId, autoSync) => ipcRenderer.invoke(IPC_CHANNELS.setAppAutoSync, appId, autoSync),
  restoreAppUserVersion: (appId) => ipcRenderer.invoke(IPC_CHANNELS.restoreAppUserVersion, appId),
  resolveAppUpdateConflict: (appId) => ipcRenderer.invoke(IPC_CHANNELS.resolveAppUpdateConflict, appId),
  uninstallApp: (appId) => ipcRenderer.invoke(IPC_CHANNELS.uninstallApp, appId),
  getAppDetails: (appId) => ipcRenderer.invoke(IPC_CHANNELS.getAppDetails, appId),
  listAppPrompts: (appId) => ipcRenderer.invoke(IPC_CHANNELS.listAppPrompts, appId),
  validateAppPrompt: (input) => ipcRenderer.invoke(IPC_CHANNELS.validateAppPrompt, input),
  updateAppPrompt: (input) => ipcRenderer.invoke(IPC_CHANNELS.updateAppPrompt, input),
  restoreAppPrompt: (input) => ipcRenderer.invoke(IPC_CHANNELS.restoreAppPrompt, input),
  installWelcome: (appId, userLanguage) => ipcRenderer.invoke(IPC_CHANNELS.installWelcome, appId, userLanguage),
  openApp: (appId, locale) => ipcRenderer.invoke(IPC_CHANNELS.openApp, appId, locale),
  stopApp: (appId) => ipcRenderer.invoke(IPC_CHANNELS.stopApp, appId),
  getAppRuntimeStatus: (appId) => ipcRenderer.invoke(IPC_CHANNELS.getAppRuntimeStatus, appId),
  startLocalNetworkShare: (appId) => ipcRenderer.invoke(IPC_CHANNELS.startLocalNetworkShare, appId),
  stopLocalNetworkShare: (appId) => ipcRenderer.invoke(IPC_CHANNELS.stopLocalNetworkShare, appId),
  getLocalNetworkShareStatus: (appId) => ipcRenderer.invoke(IPC_CHANNELS.getLocalNetworkShareStatus, appId),
  startRemoteNetworkShare: (appId) => ipcRenderer.invoke(IPC_CHANNELS.startRemoteNetworkShare, appId),
  stopRemoteNetworkShare: (appId) => ipcRenderer.invoke(IPC_CHANNELS.stopRemoteNetworkShare, appId),
  getRemoteNetworkShareStatus: (appId) => ipcRenderer.invoke(IPC_CHANNELS.getRemoteNetworkShareStatus, appId),
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
  updateCodexDefaults: (input) => ipcRenderer.invoke(IPC_CHANNELS.updateCodexDefaults, input),
  updateAgentDefaults: (input) => ipcRenderer.invoke(IPC_CHANNELS.updateAgentDefaults, input),
  getDesktopUpdateState: () => ipcRenderer.invoke(IPC_CHANNELS.getDesktopUpdateState),
  checkDesktopUpdates: () => ipcRenderer.invoke(IPC_CHANNELS.checkDesktopUpdates),
  downloadDesktopUpdate: () => ipcRenderer.invoke(IPC_CHANNELS.downloadDesktopUpdate),
  installDesktopUpdate: () => ipcRenderer.invoke(IPC_CHANNELS.installDesktopUpdate),
  onDesktopUpdateProgress: (listener) => {
    const wrapped = (_event: unknown, payload: Parameters<typeof listener>[0]) => {
      listener(payload);
    };
    ipcRenderer.on(IPC_CHANNELS.desktopUpdateProgress, wrapped);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.desktopUpdateProgress, wrapped);
    };
  },
  getForgerAccount: () => ipcRenderer.invoke(IPC_CHANNELS.getForgerAccount),
  registerForgerAccount: (input) => ipcRenderer.invoke(IPC_CHANNELS.registerForgerAccount, input),
  loginForgerAccount: (input) => ipcRenderer.invoke(IPC_CHANNELS.loginForgerAccount, input),
  loginForgerAccountWithGoogle: () => ipcRenderer.invoke(IPC_CHANNELS.loginForgerAccountWithGoogle),
  updateForgerAccountProfile: (input) => ipcRenderer.invoke(IPC_CHANNELS.updateForgerAccountProfile, input),
  logoutForgerAccount: () => ipcRenderer.invoke(IPC_CHANNELS.logoutForgerAccount),
  onForgerAccountUpdated: (listener) => {
    const wrapped = (_event: unknown, payload: Parameters<typeof listener>[0]) => {
      listener(payload);
    };
    ipcRenderer.on(IPC_CHANNELS.forgerAccountUpdated, wrapped);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.forgerAccountUpdated, wrapped);
    };
  },
  getCloudDevices: () => ipcRenderer.invoke(IPC_CHANNELS.getCloudDevices),
  generateDevicePairingCode: () => ipcRenderer.invoke(IPC_CHANNELS.generateDevicePairingCode),
  listFriends: () => ipcRenderer.invoke(IPC_CHANNELS.listFriends),
  searchFriends: (username) => ipcRenderer.invoke(IPC_CHANNELS.searchFriends, username),
  sendFriendRequest: (username) => ipcRenderer.invoke(IPC_CHANNELS.sendFriendRequest, username),
  acceptFriendRequest: (id) => ipcRenderer.invoke(IPC_CHANNELS.acceptFriendRequest, id),
  declineFriendRequest: (id) => ipcRenderer.invoke(IPC_CHANNELS.declineFriendRequest, id),
  cancelFriendRequest: (id) => ipcRenderer.invoke(IPC_CHANNELS.cancelFriendRequest, id),
  markFriendChatRead: (friendUserId) => ipcRenderer.invoke(IPC_CHANNELS.markFriendChatRead, friendUserId),
  openFriendChatWindow: (friendship) => ipcRenderer.invoke(IPC_CHANNELS.openFriendChatWindow, friendship),
  listCloudMessages: (friendUserId) => ipcRenderer.invoke(IPC_CHANNELS.listCloudMessages, friendUserId),
  sendCloudMessage: (input) => ipcRenderer.invoke(IPC_CHANNELS.sendCloudMessage, input),
  decideAppMessagePermission: (cloudMessageId, decision) =>
    ipcRenderer.invoke(IPC_CHANNELS.decideAppMessagePermission, cloudMessageId, decision),
  onCloudFriendshipEvent: (listener) => {
    const wrapped = (_event: unknown, payload: Parameters<typeof listener>[0]) => {
      listener(payload);
    };
    ipcRenderer.on(IPC_CHANNELS.cloudFriendshipEvent, wrapped);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.cloudFriendshipEvent, wrapped);
    };
  },
  getCloudIdentity: () => ipcRenderer.invoke(IPC_CHANNELS.getCloudIdentity),
  revealCloudSecretKey: () => ipcRenderer.invoke(IPC_CHANNELS.revealCloudSecretKey),
  regenerateCloudSecretKey: () => ipcRenderer.invoke(IPC_CHANNELS.regenerateCloudSecretKey),
  submitAppRating: (input) => ipcRenderer.invoke(IPC_CHANNELS.submitAppRating, input),
  submitProductFeedback: (input) => ipcRenderer.invoke(IPC_CHANNELS.submitProductFeedback, input),
  submitUsageEvent: (input) => ipcRenderer.invoke(IPC_CHANNELS.submitUsageEvent, input),
  openExternalUrl: (url) => ipcRenderer.invoke(IPC_CHANNELS.openExternalUrl, url),
  getCodexAuthStatus: () => ipcRenderer.invoke(IPC_CHANNELS.getCodexAuthStatus),
  openCodexUsageDashboard: () => ipcRenderer.invoke(IPC_CHANNELS.openCodexUsageDashboard),
  connectCodexAuth: () => ipcRenderer.invoke(IPC_CHANNELS.connectCodexAuth),
  disconnectCodexAuth: () => ipcRenderer.invoke(IPC_CHANNELS.disconnectCodexAuth),
  reinstallCodex: () => ipcRenderer.invoke(IPC_CHANNELS.reinstallCodex),
  getClaudeAuthStatus: () => ipcRenderer.invoke(IPC_CHANNELS.getClaudeAuthStatus),
  connectClaudeAuth: () => ipcRenderer.invoke(IPC_CHANNELS.connectClaudeAuth),
  reinstallClaude: () => ipcRenderer.invoke(IPC_CHANNELS.reinstallClaude),
  submitDesktopErrorReport: (input) => ipcRenderer.invoke(IPC_CHANNELS.submitDesktopErrorReport, input),
  onDesktopErrorReportRequested: (listener) => {
    const wrapped = (_event: unknown, payload: Parameters<typeof listener>[0]) => {
      listener(payload);
    };
    ipcRenderer.on(IPC_CHANNELS.desktopErrorReportRequested, wrapped);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.desktopErrorReportRequested, wrapped);
    };
  },
  listAgentTools: () => ipcRenderer.invoke(IPC_CHANNELS.listAgentTools),
  getAgentToolSettings: () => ipcRenderer.invoke(IPC_CHANNELS.getAgentToolSettings),
  updateAgentToolApproval: (input) => ipcRenderer.invoke(IPC_CHANNELS.updateAgentToolApproval, input),
  listOfficialTools: (locale) => ipcRenderer.invoke(IPC_CHANNELS.listOfficialTools, locale),
  refreshOfficialTools: (locale) => ipcRenderer.invoke(IPC_CHANNELS.refreshOfficialTools, locale),
  activateOfficialTool: (toolId, locale) => ipcRenderer.invoke(IPC_CHANNELS.activateOfficialTool, toolId, locale),
  configureOfficialTool: (input) => ipcRenderer.invoke(IPC_CHANNELS.configureOfficialTool, input),
  deactivateOfficialTool: (toolId, locale) => ipcRenderer.invoke(IPC_CHANNELS.deactivateOfficialTool, toolId, locale),
  getAppToolsInstallGate: (appId, locale) => ipcRenderer.invoke(IPC_CHANNELS.getAppToolsInstallGate, appId, locale),
  setAppToolGrant: (input, locale) => ipcRenderer.invoke(IPC_CHANNELS.setAppToolGrant, input, locale),
  memoryList: (input) => ipcRenderer.invoke(IPC_CHANNELS.memoryList, input ?? {}),
  memoryCreate: (input) => ipcRenderer.invoke(IPC_CHANNELS.memoryCreate, input),
  memoryUpdate: (input) => ipcRenderer.invoke(IPC_CHANNELS.memoryUpdate, input),
  memoryDelete: (id) => ipcRenderer.invoke(IPC_CHANNELS.memoryDelete, id),
  chatStartRun: (input) => ipcRenderer.invoke(IPC_CHANNELS.chatStartRun, input),
  chatGetRun: (input) => ipcRenderer.invoke(IPC_CHANNELS.chatGetRun, input),
  chatCancelRun: (input) => ipcRenderer.invoke(IPC_CHANNELS.chatCancelRun, input),
  chatApprovePermission: (input) => ipcRenderer.invoke(IPC_CHANNELS.chatApprovePermission, input),
  chatApplyRun: (input) => ipcRenderer.invoke(IPC_CHANNELS.chatApplyRun, input),
  chatUndo: (input) => ipcRenderer.invoke(IPC_CHANNELS.chatUndo, input),
  traceChatEvent: (event) => ipcRenderer.invoke(IPC_CHANNELS.chatTrace, event),
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
  filesStageForChat: (input) => ipcRenderer.invoke(IPC_CHANNELS.filesStageForChat, input),
  filesDiscardStagedForChat: (input) => ipcRenderer.invoke(IPC_CHANNELS.filesDiscardStagedForChat, input),
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
  automationsList: () => ipcRenderer.invoke(IPC_CHANNELS.automationsList),
  automationsCreate: (input) => ipcRenderer.invoke(IPC_CHANNELS.automationsCreate, input),
  automationsUpdate: (input) => ipcRenderer.invoke(IPC_CHANNELS.automationsUpdate, input),
  automationsDelete: (id) => ipcRenderer.invoke(IPC_CHANNELS.automationsDelete, id),
  automationsPause: (id) => ipcRenderer.invoke(IPC_CHANNELS.automationsPause, id),
  automationsResume: (id) => ipcRenderer.invoke(IPC_CHANNELS.automationsResume, id),
  automationsRunNow: (id) => ipcRenderer.invoke(IPC_CHANNELS.automationsRunNow, id),
  automationsListRuns: (automationId) => ipcRenderer.invoke(IPC_CHANNELS.automationsListRuns, automationId),
  automationsGetRunTranscript: (runId) => ipcRenderer.invoke(IPC_CHANNELS.automationsGetRunTranscript, runId),
  onAutomationUpdated: (listener) => {
    const wrapped = (_event: unknown, payload: Parameters<typeof listener>[0]) => {
      listener(payload);
    };
    ipcRenderer.on(IPC_CHANNELS.automationUpdated, wrapped);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.automationUpdated, wrapped);
    };
  },
  minimizeWindow: () => ipcRenderer.invoke(IPC_CHANNELS.windowMinimize),
  toggleMaximizeWindow: () => ipcRenderer.invoke(IPC_CHANNELS.windowToggleMaximize),
  closeWindow: () => ipcRenderer.invoke(IPC_CHANNELS.windowClose),
  getWindowState: () => ipcRenderer.invoke(IPC_CHANNELS.windowGetState),
  onWindowStateChanged: (listener) => {
    const wrapped = (_event: unknown, payload: Parameters<typeof listener>[0]) => {
      listener(payload);
    };
    ipcRenderer.on(IPC_CHANNELS.windowStateChanged, wrapped);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.windowStateChanged, wrapped);
    };
  },
  onDeepLink: (listener) => {
    const wrapped = (_event: unknown, payload: Parameters<typeof listener>[0]) => {
      listener(payload);
    };
    ipcRenderer.on(IPC_CHANNELS.deepLink, wrapped);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.deepLink, wrapped);
    };
  },
};

contextBridge.exposeInMainWorld('forger', api);
