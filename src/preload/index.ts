import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { ForgerDesktopApi, PersonalAgentConversationEvent } from '../shared/types';

// En modo sandbox de Electron, el preload no debe depender de imports locales en runtime.
const IPC_CHANNELS = {
  listInstalledApps: 'forger:list-installed-apps',
  listCatalogApps: 'forger:list-catalog-apps',
  installApp: 'forger:install-app',
  createLocalApp: 'forger:create-local-app',
  updateApp: 'forger:update-app',
  listBackups: 'forger:backups:list',
  createBackup: 'forger:backups:create',
  deleteBackup: 'forger:backups:delete',
  deleteBackups: 'forger:backups:delete-batch',
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
  renameInstalledApp: 'forger:rename-installed-app',
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
  getRemoteActivity: 'forger:remote-activity:get',
  remoteActivityChanged: 'forger:remote-activity:changed',
  getAppSecrets: 'forger:get-app-secrets',
  listUserSecrets: 'forger:list-user-secrets',
  createUserSecret: 'forger:create-user-secret',
  updateUserSecret: 'forger:update-user-secret',
  deleteUserSecret: 'forger:delete-user-secret',
  connectAppSecret: 'forger:connect-app-secret',
  disconnectAppSecret: 'forger:disconnect-app-secret',
  getSettings: 'forger:get-settings',
  speechToTextGetState: 'forger:speech-to-text:get-state',
  speechToTextInstall: 'forger:speech-to-text:install',
  speechToTextStart: 'forger:speech-to-text:start',
  speechToTextStop: 'forger:speech-to-text:stop',
  speechToTextUpdateConfig: 'forger:speech-to-text:update-config',
  speechToTextPickAudio: 'forger:speech-to-text:pick-audio',
  speechToTextProcess: 'forger:speech-to-text:process',
  speechToTextProcessUpload: 'forger:speech-to-text:process-upload',
  speechToTextCreateRealtimeSession: 'forger:speech-to-text:create-realtime-session',
  sidekicksGetState: 'forger:sidekicks:get-state',
  sidekicksScanUsb: 'forger:sidekicks:scan-usb',
  sidekicksConfigureUsb: 'forger:sidekicks:configure-usb',
  sidekicksSendDisplay: 'forger:sidekicks:send-display',
  sidekicksSendScreen: 'forger:sidekicks:send-screen',
  sidekicksSetPersonalAgent: 'forger:sidekicks:set-personal-agent',
  sidekicksSetVoiceConfig: 'forger:sidekicks:set-voice-config',
  sidekicksSpeak: 'forger:sidekicks:speak',
  sidekicksStartMicrophoneRecording: 'forger:sidekicks:microphone:start',
  sidekicksStopMicrophoneRecording: 'forger:sidekicks:microphone:stop',
  sidekicksReadMicrophoneRecording: 'forger:sidekicks:microphone:read',
  sidekicksSetIdleConfig: 'forger:sidekicks:idle:set-config',
  sidekicksSetIdleImage: 'forger:sidekicks:idle:set-image',
  sidekicksForget: 'forger:sidekicks:forget',
  sidekicksChanged: 'forger:sidekicks:changed',
  microphonePermissionStatus: 'forger:microphone-permission:status',
  microphonePermissionRequest: 'forger:microphone-permission:request',
  liveVoiceInputGetState: 'forger:live-voice-input:get-state',
  liveVoiceInputUpdateConfig: 'forger:live-voice-input:update-config',
  liveVoiceInputUpdateDevices: 'forger:live-voice-input:update-devices',
  liveVoiceInputCreateSession: 'forger:live-voice-input:create-session',
  liveVoiceInputStop: 'forger:live-voice-input:stop',
  liveVoiceInputWakeDetected: 'forger:live-voice-input:wake-detected',
  liveVoiceInputWakeReady: 'forger:live-voice-input:wake-ready',
  liveVoiceInputWakeUnavailable: 'forger:live-voice-input:wake-unavailable',
  liveVoiceInputChanged: 'forger:live-voice-input:changed',
  liveVoiceInputForgerWake: 'forger:live-voice-input:forger-wake',
  wakeWordGetState: 'forger:wake-word:get-state',
  wakeWordInstall: 'forger:wake-word:install',
  wakeWordStart: 'forger:wake-word:start',
  wakeWordStop: 'forger:wake-word:stop',
  wakeWordUpdateConfig: 'forger:wake-word:update-config',
  wakeWordCreateSession: 'forger:wake-word:create-session',
  wakeWordRecordReady: 'forger:wake-word:record-ready',
  wakeWordRecordUnavailable: 'forger:wake-word:record-unavailable',
  wakeWordRecordDetected: 'forger:wake-word:record-detected',
  wakeWordRecordDiagnostic: 'forger:wake-word:record-diagnostic',
  wakeWordChanged: 'forger:wake-word:changed',
  wakeWordDetected: 'forger:wake-word:detected',
  audioRuntimeBrokerRequest: 'forger:audio-runtime-broker:request',
  audioRuntimeBrokerResponse: 'forger:audio-runtime-broker:response',
  textToSpeechGetState: 'forger:text-to-speech:get-state',
  textToSpeechInstall: 'forger:text-to-speech:install',
  textToSpeechStart: 'forger:text-to-speech:start',
  textToSpeechStop: 'forger:text-to-speech:stop',
  textToSpeechUpdateConfig: 'forger:text-to-speech:update-config',
  textToSpeechSynthesize: 'forger:text-to-speech:synthesize',
  updateCodexDefaults: 'forger:update-codex-defaults',
  updateAgentDefaults: 'forger:update-agent-defaults',
  updateWorkflowsEarlyAccess: 'forger:workflows:update-early-access',
  updateDeveloperMode: 'forger:update-developer-mode',
  updateAppDeveloperSettings: 'forger:update-app-developer-settings',
  getDeveloperPathState: 'forger:get-developer-path-state',
  getDesktopUpdateState: 'forger:desktop-update:get-state',
  checkDesktopUpdates: 'forger:desktop-update:check',
  downloadDesktopUpdate: 'forger:desktop-update:download',
  installDesktopUpdate: 'forger:desktop-update:install',
  desktopUpdateQuitForInstall: 'forger:desktop-update:quit-for-install',
  desktopUpdateProgress: 'forger:desktop-update:progress',
  getForgerAccount: 'forger:account:get',
  registerForgerAccount: 'forger:account:register',
  loginForgerAccount: 'forger:account:login',
  loginForgerAccountWithGoogle: 'forger:account:login-google',
  loginForgerAccountWithApple: 'forger:account:login-apple',
  updateForgerAccountProfile: 'forger:account:update-profile',
  logoutForgerAccount: 'forger:account:logout',
  forgerAccountUpdated: 'forger:account:updated',
  getCloudStorageUsage: 'forger:cloud-storage:get',
  getCloudDevices: 'forger:cloud-devices:get',
  registerCloudDevice: 'forger:cloud-devices:register',
  updateCloudDeviceName: 'forger:cloud-devices:update-name',
  unlinkMobileDeviceFromDesktop: 'forger:cloud-devices:unlink-mobile',
  generateDevicePairingCode: 'forger:cloud-devices:pairing-code',
  acceptMobilePairingRequest: 'forger:cloud-devices:pairing-accept',
  rejectMobilePairingRequest: 'forger:cloud-devices:pairing-reject',
  deleteMobilePairingRequest: 'forger:cloud-devices:pairing-delete',
  listFriends: 'forger:friends:list',
  listMySocialApps: 'forger:social:apps:list-mine',
  uploadSocialApp: 'forger:social:apps:upload',
  updateSocialApp: 'forger:social:apps:update',
  updateSocialAppVisibility: 'forger:social:apps:update-visibility',
  deleteSocialApp: 'forger:social:apps:delete',
  createSocialAppShare: 'forger:social:apps:create-share',
  resolveSocialCode: 'forger:social:code:resolve',
  resolveSocialApp: 'forger:social:app:resolve',
  getSocialProfile: 'forger:social:profile:get',
  getSocialProfileUrl: 'forger:social:profile:url',
  prepareSocialAppReview: 'forger:social:apps:prepare-review',
  finishSocialAppInstall: 'forger:social:apps:finish-install',
  deleteQuarantinedSocialApp: 'forger:social:apps:delete-quarantine',
  installSocialApp: 'forger:social:apps:install',
  searchFriends: 'forger:friends:search',
  sendFriendRequest: 'forger:friends:request',
  acceptFriendRequest: 'forger:friends:accept',
  declineFriendRequest: 'forger:friends:decline',
  cancelFriendRequest: 'forger:friends:cancel',
  markFriendChatRead: 'forger:friends:mark-chat-read',
  listCloudMessages: 'forger:cloud-messages:list',
  sendCloudMessage: 'forger:cloud-messages:send',
  sendCloudAppShareMessage: 'forger:cloud-messages:app-share',
  decideAppMessagePermission: 'forger:cloud-messages:permission',
  getForumParticipation: 'forger:forum:participation:get',
  updateForumParticipation: 'forger:forum:participation:update',
  listForumPosts: 'forger:forum:posts:list',
  getForumPost: 'forger:forum:posts:get',
  createForumPost: 'forger:forum:posts:create',
  createForumComment: 'forger:forum:comments:create',
  replyForumComment: 'forger:forum:comments:reply',
  deleteForumPost: 'forger:forum:posts:delete',
  deleteForumComment: 'forger:forum:comments:delete',
  moderateForumPost: 'forger:forum:posts:moderate',
  moderateForumComment: 'forger:forum:comments:moderate',
  openFriendChatWindow: 'forger:friends:open-chat-window',
  cloudFriendshipEvent: 'forger:cloud-friendship:event',
  getCloudIdentity: 'forger:cloud-identity:get',
  revealCloudSecretKey: 'forger:cloud-identity:reveal',
  regenerateCloudSecretKey: 'forger:cloud-identity:regenerate',
  submitAppRating: 'forger:catalog:rating:submit',
  submitProductFeedback: 'forger:feedback:submit',
  submitUsageEvent: 'forger:usage-events:submit',
  openExternalUrl: 'forger:open-external-url',
  getAgentProviderUsage: 'forger:agent-provider-usage:get',
  listLlmProviderProfiles: 'forger:llm-provider-profiles:list',
  setActiveLlmProviderProfile: 'forger:llm-provider-profiles:set-active',
  updateLlmProviderProfileDefaults: 'forger:llm-provider-profiles:update-defaults',
  getCodexAuthStatus: 'forger:get-codex-auth-status',
  openCodexUsageDashboard: 'forger:open-codex-usage-dashboard',
  connectCodexAuth: 'forger:connect-codex-auth',
  disconnectCodexAuth: 'forger:disconnect-codex-auth',
  reinstallCodex: 'forger:reinstall-codex',
  getClaudeAuthStatus: 'forger:get-claude-auth-status',
  confirmClaudeAuthConnection: 'forger:confirm-claude-auth-connection',
  connectClaudeAuth: 'forger:connect-claude-auth',
  disconnectClaudeAuth: 'forger:disconnect-claude-auth',
  signOutClaudeAuth: 'forger:sign-out-claude-auth',
  reinstallClaude: 'forger:reinstall-claude',
  getAntigravityAuthStatus: 'forger:get-antigravity-auth-status',
  connectAntigravityAuth: 'forger:connect-antigravity-auth',
  startAntigravityAuthSession: 'forger:start-antigravity-auth-session',
  writeAntigravityAuthSession: 'forger:write-antigravity-auth-session',
  cancelAntigravityAuthSession: 'forger:cancel-antigravity-auth-session',
  antigravityAuthSessionEvent: 'forger:antigravity-auth-session:event',
  disconnectAntigravityAuth: 'forger:disconnect-antigravity-auth',
  reinstallAntigravity: 'forger:reinstall-antigravity',
  prepareDesktopErrorReport: 'forger:error-report:prepare',
  submitDesktopErrorReport: 'forger:error-report:submit',
  prepareConversationDiagnosticReport: 'forger:conversation-diagnostic:prepare',
  submitConversationDiagnosticReport: 'forger:conversation-diagnostic:submit',
  desktopErrorReportRequested: 'forger:error-report:requested',
  desktopLog: 'forger:desktop-log',
  listAgentTools: 'forger:agent-tools:list',
  getAgentToolSettings: 'forger:agent-tools:get-settings',
  updateAgentToolApproval: 'forger:agent-tools:update-approval',
  listOfficialTools: 'forger:official-tools:list',
  refreshOfficialTools: 'forger:official-tools:refresh',
  activateOfficialTool: 'forger:official-tools:activate',
  configureOfficialTool: 'forger:official-tools:configure',
  callOfficialTool: 'forger:official-tools:call',
  deactivateOfficialTool: 'forger:official-tools:deactivate',
  officialToolEvent: 'forger:official-tools:event',
  connectionsList: 'forger:connections:list',
  connectionsConfigure: 'forger:connections:configure',
  connectionsDisconnect: 'forger:connections:disconnect',
  connectionsCall: 'forger:connections:call',
  connectionsSetDefault: 'forger:connections:set-default',
  getAppToolsInstallGate: 'forger:app-tools:install-gate',
  setAppToolGrant: 'forger:app-tools:set-grant',
  setAppConnectionGrant: 'forger:app-connections:set-grant',
  memoryList: 'forger:memory:list',
  memoryCreate: 'forger:memory:create',
  memoryUpdate: 'forger:memory:update',
  memoryDelete: 'forger:memory:delete',
  llmRunsSnapshotGet: 'forger:llm-runs:snapshot:get',
  llmRunsSnapshotChanged: 'forger:llm-runs:snapshot:changed',
  personalAgentsList: 'forger:personal-agents:list',
  personalAgentsCreate: 'forger:personal-agents:create',
  personalAgentGroupsList: 'forger:personal-agents:groups:list',
  personalAgentGroupsCreate: 'forger:personal-agents:groups:create',
  personalAgentGroupsUpdate: 'forger:personal-agents:groups:update',
  personalAgentGroupsDelete: 'forger:personal-agents:groups:delete',
  personalAgentUpdateGroup: 'forger:personal-agents:group:update',
  personalAgentGrantOptionsList: 'forger:personal-agents:grant-options:list',
  personalAgentUpdatePermissions: 'forger:personal-agents:permissions:update',
  personalAgentsDelete: 'forger:personal-agents:delete',
  personalAgentConversationsList: 'forger:personal-agents:conversations:list',
  personalAgentWorkspaceList: 'forger:personal-agents:workspace:list',
  personalAgentWorkspaceFileRead: 'forger:personal-agents:workspace:file:read',
  personalAgentWorkspaceFileWrite: 'forger:personal-agents:workspace:file:write',
  personalAgentStartConversation: 'forger:personal-agents:conversation:start',
  personalAgentSendMessage: 'forger:personal-agents:conversation:send',
  personalAgentGetConversation: 'forger:personal-agents:conversation:get',
  personalAgentConversationDraftUpdate: 'forger:personal-agents:conversation:draft:update',
  personalAgentWakeupCancel: 'forger:personal-agents:wakeup:cancel',
  personalAgentRoutinesList: 'forger:personal-agents:routines:list',
  personalAgentRoutinesCreate: 'forger:personal-agents:routines:create',
  personalAgentRoutinesUpdate: 'forger:personal-agents:routines:update',
  personalAgentRoutinesSetEnabled: 'forger:personal-agents:routines:set-enabled',
  personalAgentRoutinesDelete: 'forger:personal-agents:routines:delete',
  personalAgentRoutinesRunNow: 'forger:personal-agents:routines:run-now',
  personalAgentPeerThreadsList: 'forger:personal-agents:peer-threads:list',
  personalAgentPeerThreadGet: 'forger:personal-agents:peer-thread:get',
  personalAgentConversationEvent: 'forger:personal-agents:conversation:event',
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
  workflowsList: 'forger:workflows:list',
  workflowsUpsert: 'forger:workflows:upsert',
  workflowsDelete: 'forger:workflows:delete',
  workflowsSetEnabled: 'forger:workflows:set-enabled',
  workflowsRunNow: 'forger:workflows:run-now',
  workflowsRunNode: 'forger:workflows:run-node',
  workflowsCancelRun: 'forger:workflows:cancel-run',
  workflowsApproveNode: 'forger:workflows:approve-node',
  workflowsListRuns: 'forger:workflows:list-runs',
  workflowsGetRun: 'forger:workflows:get-run',
  workflowUpdated: 'forger:workflows:updated',
  backgroundTasksList: 'forger:background-tasks:list',
  backgroundTaskGet: 'forger:background-tasks:get',
  backgroundTasksUpsert: 'forger:background-tasks:upsert',
  backgroundTaskUpdated: 'forger:background-tasks:updated',
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
  createLocalApp: (input, locale) => ipcRenderer.invoke(IPC_CHANNELS.createLocalApp, input, locale),
  updateApp: (appId, locale) => ipcRenderer.invoke(IPC_CHANNELS.updateApp, appId, locale),
  listBackups: (appId) => ipcRenderer.invoke(IPC_CHANNELS.listBackups, appId),
  createBackup: (input) => ipcRenderer.invoke(IPC_CHANNELS.createBackup, input),
  deleteBackup: (input) => ipcRenderer.invoke(IPC_CHANNELS.deleteBackup, input),
  deleteBackups: (input) => ipcRenderer.invoke(IPC_CHANNELS.deleteBackups, input),
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
  renameInstalledApp: (input) => ipcRenderer.invoke(IPC_CHANNELS.renameInstalledApp, input),
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
  getRemoteActivity: () => ipcRenderer.invoke(IPC_CHANNELS.getRemoteActivity),
  onRemoteActivityChanged: (listener) => {
    const wrapped = (_event: unknown, payload: Parameters<typeof listener>[0]) => {
      listener(payload);
    };
    ipcRenderer.on(IPC_CHANNELS.remoteActivityChanged, wrapped);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.remoteActivityChanged, wrapped);
    };
  },
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
  speechToTextGetState: () => ipcRenderer.invoke(IPC_CHANNELS.speechToTextGetState),
  speechToTextInstall: () => ipcRenderer.invoke(IPC_CHANNELS.speechToTextInstall),
  speechToTextStart: () => ipcRenderer.invoke(IPC_CHANNELS.speechToTextStart),
  speechToTextStop: () => ipcRenderer.invoke(IPC_CHANNELS.speechToTextStop),
  speechToTextUpdateConfig: (input) => ipcRenderer.invoke(IPC_CHANNELS.speechToTextUpdateConfig, input),
  speechToTextPickAudio: () => ipcRenderer.invoke(IPC_CHANNELS.speechToTextPickAudio),
  speechToTextProcess: (input) => ipcRenderer.invoke(IPC_CHANNELS.speechToTextProcess, input),
  speechToTextProcessUpload: (input) => ipcRenderer.invoke(IPC_CHANNELS.speechToTextProcessUpload, input),
  speechToTextCreateRealtimeSession: () => ipcRenderer.invoke(IPC_CHANNELS.speechToTextCreateRealtimeSession),
  sidekicksGetState: () => ipcRenderer.invoke(IPC_CHANNELS.sidekicksGetState),
  sidekicksScanUsb: () => ipcRenderer.invoke(IPC_CHANNELS.sidekicksScanUsb),
  sidekicksConfigureUsb: (input) => ipcRenderer.invoke(IPC_CHANNELS.sidekicksConfigureUsb, input),
  sidekicksSendDisplay: (input) => ipcRenderer.invoke(IPC_CHANNELS.sidekicksSendDisplay, input),
  sidekicksSendScreen: (input) => ipcRenderer.invoke(IPC_CHANNELS.sidekicksSendScreen, input),
  sidekicksSetPersonalAgent: (input) => ipcRenderer.invoke(IPC_CHANNELS.sidekicksSetPersonalAgent, input),
  sidekicksSetVoiceConfig: (input) => ipcRenderer.invoke(IPC_CHANNELS.sidekicksSetVoiceConfig, input),
  sidekicksSpeak: (input) => ipcRenderer.invoke(IPC_CHANNELS.sidekicksSpeak, input),
  sidekicksStartMicrophoneRecording: (input) => ipcRenderer.invoke(IPC_CHANNELS.sidekicksStartMicrophoneRecording, input),
  sidekicksStopMicrophoneRecording: (input) => ipcRenderer.invoke(IPC_CHANNELS.sidekicksStopMicrophoneRecording, input),
  sidekicksReadMicrophoneRecording: (input) => ipcRenderer.invoke(IPC_CHANNELS.sidekicksReadMicrophoneRecording, input),
  sidekicksSetIdleConfig: (input) => ipcRenderer.invoke(IPC_CHANNELS.sidekicksSetIdleConfig, input),
  sidekicksSetIdleImage: (input) => ipcRenderer.invoke(IPC_CHANNELS.sidekicksSetIdleImage, input),
  sidekicksForget: (sidekickId) => ipcRenderer.invoke(IPC_CHANNELS.sidekicksForget, sidekickId),
  onSidekicksChanged: (listener) => {
    const wrapped = (_event: unknown, payload: Parameters<typeof listener>[0]) => {
      listener(payload);
    };
    ipcRenderer.on(IPC_CHANNELS.sidekicksChanged, wrapped);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.sidekicksChanged, wrapped);
    };
  },
  microphonePermissionStatus: () => ipcRenderer.invoke(IPC_CHANNELS.microphonePermissionStatus),
  microphonePermissionRequest: () => ipcRenderer.invoke(IPC_CHANNELS.microphonePermissionRequest),
  liveVoiceInputGetState: () => ipcRenderer.invoke(IPC_CHANNELS.liveVoiceInputGetState),
  liveVoiceInputUpdateConfig: (input) => ipcRenderer.invoke(IPC_CHANNELS.liveVoiceInputUpdateConfig, input),
  liveVoiceInputUpdateDevices: (input) => ipcRenderer.invoke(IPC_CHANNELS.liveVoiceInputUpdateDevices, input),
  liveVoiceInputCreateSession: (input) => ipcRenderer.invoke(IPC_CHANNELS.liveVoiceInputCreateSession, input),
  liveVoiceInputStop: (input) => ipcRenderer.invoke(IPC_CHANNELS.liveVoiceInputStop, input ?? {}),
  liveVoiceInputWakeDetected: (input) => ipcRenderer.invoke(IPC_CHANNELS.liveVoiceInputWakeDetected, input),
  liveVoiceInputWakeReady: (input) => ipcRenderer.invoke(IPC_CHANNELS.liveVoiceInputWakeReady, input),
  liveVoiceInputWakeUnavailable: (input) => ipcRenderer.invoke(IPC_CHANNELS.liveVoiceInputWakeUnavailable, input),
  onLiveVoiceInputChanged: (listener) => {
    const wrapped = (_event: unknown, payload: Parameters<typeof listener>[0]) => {
      listener(payload);
    };
    ipcRenderer.on(IPC_CHANNELS.liveVoiceInputChanged, wrapped);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.liveVoiceInputChanged, wrapped);
    };
  },
  onLiveVoiceInputForgerWake: (listener) => {
    const wrapped = (_event: unknown, payload: Parameters<typeof listener>[0]) => {
      listener(payload);
    };
    ipcRenderer.on(IPC_CHANNELS.liveVoiceInputForgerWake, wrapped);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.liveVoiceInputForgerWake, wrapped);
    };
  },
  wakeWordGetState: () => ipcRenderer.invoke(IPC_CHANNELS.wakeWordGetState),
  wakeWordInstall: () => ipcRenderer.invoke(IPC_CHANNELS.wakeWordInstall),
  wakeWordStart: () => ipcRenderer.invoke(IPC_CHANNELS.wakeWordStart),
  wakeWordStop: () => ipcRenderer.invoke(IPC_CHANNELS.wakeWordStop),
  wakeWordUpdateConfig: (input) => ipcRenderer.invoke(IPC_CHANNELS.wakeWordUpdateConfig, input),
  wakeWordCreateSession: () => ipcRenderer.invoke(IPC_CHANNELS.wakeWordCreateSession),
  wakeWordRecordReady: (input) => ipcRenderer.invoke(IPC_CHANNELS.wakeWordRecordReady, input),
  wakeWordRecordUnavailable: (input) => ipcRenderer.invoke(IPC_CHANNELS.wakeWordRecordUnavailable, input),
  wakeWordRecordDetected: (input) => ipcRenderer.invoke(IPC_CHANNELS.wakeWordRecordDetected, input),
  wakeWordRecordDiagnostic: (input) => ipcRenderer.invoke(IPC_CHANNELS.wakeWordRecordDiagnostic, input),
  onWakeWordChanged: (listener) => {
    const wrapped = (_event: unknown, payload: Parameters<typeof listener>[0]) => {
      listener(payload);
    };
    ipcRenderer.on(IPC_CHANNELS.wakeWordChanged, wrapped);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.wakeWordChanged, wrapped);
    };
  },
  onWakeWordDetected: (listener) => {
    const wrapped = (_event: unknown, payload: Parameters<typeof listener>[0]) => {
      listener(payload);
    };
    ipcRenderer.on(IPC_CHANNELS.wakeWordDetected, wrapped);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.wakeWordDetected, wrapped);
    };
  },
  onAudioRuntimeBrokerRequest: (listener) => {
    const wrapped = (_event: unknown, payload: Parameters<typeof listener>[0]) => {
      listener(payload);
    };
    ipcRenderer.on(IPC_CHANNELS.audioRuntimeBrokerRequest, wrapped);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.audioRuntimeBrokerRequest, wrapped);
    };
  },
  audioRuntimeBrokerRespond: (response) => ipcRenderer.invoke(IPC_CHANNELS.audioRuntimeBrokerResponse, response),
  textToSpeechGetState: () => ipcRenderer.invoke(IPC_CHANNELS.textToSpeechGetState),
  textToSpeechInstall: () => ipcRenderer.invoke(IPC_CHANNELS.textToSpeechInstall),
  textToSpeechStart: () => ipcRenderer.invoke(IPC_CHANNELS.textToSpeechStart),
  textToSpeechStop: () => ipcRenderer.invoke(IPC_CHANNELS.textToSpeechStop),
  textToSpeechUpdateConfig: (input) => ipcRenderer.invoke(IPC_CHANNELS.textToSpeechUpdateConfig, input),
  textToSpeechSynthesize: (input) => ipcRenderer.invoke(IPC_CHANNELS.textToSpeechSynthesize, input),
  updateCodexDefaults: (input) => ipcRenderer.invoke(IPC_CHANNELS.updateCodexDefaults, input),
  updateAgentDefaults: (input) => ipcRenderer.invoke(IPC_CHANNELS.updateAgentDefaults, input),
  updateWorkflowsEarlyAccess: (enabled) => ipcRenderer.invoke(IPC_CHANNELS.updateWorkflowsEarlyAccess, enabled),
  updateDeveloperMode: (input) => ipcRenderer.invoke(IPC_CHANNELS.updateDeveloperMode, input),
  updateAppDeveloperSettings: (input) => ipcRenderer.invoke(IPC_CHANNELS.updateAppDeveloperSettings, input),
  getDeveloperPathState: (appId) => ipcRenderer.invoke(IPC_CHANNELS.getDeveloperPathState, appId),
  getDesktopUpdateState: () => ipcRenderer.invoke(IPC_CHANNELS.getDesktopUpdateState),
  checkDesktopUpdates: () => ipcRenderer.invoke(IPC_CHANNELS.checkDesktopUpdates),
  downloadDesktopUpdate: () => ipcRenderer.invoke(IPC_CHANNELS.downloadDesktopUpdate),
  installDesktopUpdate: () => ipcRenderer.invoke(IPC_CHANNELS.installDesktopUpdate),
  desktopUpdateQuitForInstall: () => ipcRenderer.invoke(IPC_CHANNELS.desktopUpdateQuitForInstall),
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
  loginForgerAccountWithApple: () => ipcRenderer.invoke(IPC_CHANNELS.loginForgerAccountWithApple),
  updateForgerAccountProfile: (input) => ipcRenderer.invoke(IPC_CHANNELS.updateForgerAccountProfile, input),
  logoutForgerAccount: () => ipcRenderer.invoke(IPC_CHANNELS.logoutForgerAccount),
  getCloudStorageUsage: () => ipcRenderer.invoke(IPC_CHANNELS.getCloudStorageUsage),
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
  registerCloudDevice: (input) => ipcRenderer.invoke(IPC_CHANNELS.registerCloudDevice, input),
  updateCloudDeviceName: (input) => ipcRenderer.invoke(IPC_CHANNELS.updateCloudDeviceName, input),
  unlinkMobileDeviceFromDesktop: (authorizationId) => ipcRenderer.invoke(IPC_CHANNELS.unlinkMobileDeviceFromDesktop, authorizationId),
  generateDevicePairingCode: () => ipcRenderer.invoke(IPC_CHANNELS.generateDevicePairingCode),
  acceptMobilePairingRequest: (requestId) => ipcRenderer.invoke(IPC_CHANNELS.acceptMobilePairingRequest, requestId),
  rejectMobilePairingRequest: (requestId) => ipcRenderer.invoke(IPC_CHANNELS.rejectMobilePairingRequest, requestId),
  deleteMobilePairingRequest: (requestId) => ipcRenderer.invoke(IPC_CHANNELS.deleteMobilePairingRequest, requestId),
  listFriends: () => ipcRenderer.invoke(IPC_CHANNELS.listFriends),
  listMySocialApps: () => ipcRenderer.invoke(IPC_CHANNELS.listMySocialApps),
  uploadSocialApp: (input) => ipcRenderer.invoke(IPC_CHANNELS.uploadSocialApp, input),
  updateSocialApp: (input) => ipcRenderer.invoke(IPC_CHANNELS.updateSocialApp, input),
  updateSocialAppVisibility: (userAppId, visibility) => ipcRenderer.invoke(IPC_CHANNELS.updateSocialAppVisibility, userAppId, visibility),
  deleteSocialApp: (userAppId) => ipcRenderer.invoke(IPC_CHANNELS.deleteSocialApp, userAppId),
  createSocialAppShare: (userAppId) => ipcRenderer.invoke(IPC_CHANNELS.createSocialAppShare, userAppId),
  resolveSocialCode: (code) => ipcRenderer.invoke(IPC_CHANNELS.resolveSocialCode, code),
  resolveSocialApp: (id) => ipcRenderer.invoke(IPC_CHANNELS.resolveSocialApp, id),
  getSocialProfile: (username) => ipcRenderer.invoke(IPC_CHANNELS.getSocialProfile, username),
  getSocialProfileUrl: (username) => ipcRenderer.invoke(IPC_CHANNELS.getSocialProfileUrl, username),
  prepareSocialAppReview: (input, locale) => ipcRenderer.invoke(IPC_CHANNELS.prepareSocialAppReview, input, locale),
  finishSocialAppInstall: (input, locale) => ipcRenderer.invoke(IPC_CHANNELS.finishSocialAppInstall, input, locale),
  deleteQuarantinedSocialApp: (input, locale) => ipcRenderer.invoke(IPC_CHANNELS.deleteQuarantinedSocialApp, input, locale),
  installSocialApp: (input, locale) => ipcRenderer.invoke(IPC_CHANNELS.installSocialApp, input, locale),
  searchFriends: (username) => ipcRenderer.invoke(IPC_CHANNELS.searchFriends, username),
  sendFriendRequest: (username) => ipcRenderer.invoke(IPC_CHANNELS.sendFriendRequest, username),
  acceptFriendRequest: (id) => ipcRenderer.invoke(IPC_CHANNELS.acceptFriendRequest, id),
  declineFriendRequest: (id) => ipcRenderer.invoke(IPC_CHANNELS.declineFriendRequest, id),
  cancelFriendRequest: (id) => ipcRenderer.invoke(IPC_CHANNELS.cancelFriendRequest, id),
  markFriendChatRead: (friendUserId) => ipcRenderer.invoke(IPC_CHANNELS.markFriendChatRead, friendUserId),
  openFriendChatWindow: (friendship) => ipcRenderer.invoke(IPC_CHANNELS.openFriendChatWindow, friendship),
  listCloudMessages: (friendUserId) => ipcRenderer.invoke(IPC_CHANNELS.listCloudMessages, friendUserId),
  sendCloudMessage: (input) => ipcRenderer.invoke(IPC_CHANNELS.sendCloudMessage, input),
  sendCloudAppShareMessage: (input) => ipcRenderer.invoke(IPC_CHANNELS.sendCloudAppShareMessage, input),
  decideAppMessagePermission: (cloudMessageId, decision) =>
    ipcRenderer.invoke(IPC_CHANNELS.decideAppMessagePermission, cloudMessageId, decision),
  getForumParticipation: () => ipcRenderer.invoke(IPC_CHANNELS.getForumParticipation),
  updateForumParticipation: (action) => ipcRenderer.invoke(IPC_CHANNELS.updateForumParticipation, action),
  listForumPosts: (limit) => ipcRenderer.invoke(IPC_CHANNELS.listForumPosts, limit),
  getForumPost: (id) => ipcRenderer.invoke(IPC_CHANNELS.getForumPost, id),
  createForumPost: (body) => ipcRenderer.invoke(IPC_CHANNELS.createForumPost, body),
  createForumComment: (postId, body) => ipcRenderer.invoke(IPC_CHANNELS.createForumComment, postId, body),
  replyForumComment: (commentId, body) => ipcRenderer.invoke(IPC_CHANNELS.replyForumComment, commentId, body),
  deleteForumPost: (id) => ipcRenderer.invoke(IPC_CHANNELS.deleteForumPost, id),
  deleteForumComment: (id) => ipcRenderer.invoke(IPC_CHANNELS.deleteForumComment, id),
  moderateForumPost: (id, action, reason) => ipcRenderer.invoke(IPC_CHANNELS.moderateForumPost, id, action, reason),
  moderateForumComment: (id, action, reason) => ipcRenderer.invoke(IPC_CHANNELS.moderateForumComment, id, action, reason),
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
  getAgentProviderUsage: () => ipcRenderer.invoke(IPC_CHANNELS.getAgentProviderUsage),
  listLlmProviderProfiles: () => ipcRenderer.invoke(IPC_CHANNELS.listLlmProviderProfiles),
  setActiveLlmProviderProfile: (input) => ipcRenderer.invoke(IPC_CHANNELS.setActiveLlmProviderProfile, input),
  updateLlmProviderProfileDefaults: (input) => ipcRenderer.invoke(IPC_CHANNELS.updateLlmProviderProfileDefaults, input),
  getCodexAuthStatus: () => ipcRenderer.invoke(IPC_CHANNELS.getCodexAuthStatus),
  openCodexUsageDashboard: () => ipcRenderer.invoke(IPC_CHANNELS.openCodexUsageDashboard),
  connectCodexAuth: () => ipcRenderer.invoke(IPC_CHANNELS.connectCodexAuth),
  disconnectCodexAuth: () => ipcRenderer.invoke(IPC_CHANNELS.disconnectCodexAuth),
  reinstallCodex: () => ipcRenderer.invoke(IPC_CHANNELS.reinstallCodex),
  getClaudeAuthStatus: () => ipcRenderer.invoke(IPC_CHANNELS.getClaudeAuthStatus),
  confirmClaudeAuthConnection: () => ipcRenderer.invoke(IPC_CHANNELS.confirmClaudeAuthConnection),
  connectClaudeAuth: () => ipcRenderer.invoke(IPC_CHANNELS.connectClaudeAuth),
  disconnectClaudeAuth: () => ipcRenderer.invoke(IPC_CHANNELS.disconnectClaudeAuth),
  signOutClaudeAuth: () => ipcRenderer.invoke(IPC_CHANNELS.signOutClaudeAuth),
  reinstallClaude: () => ipcRenderer.invoke(IPC_CHANNELS.reinstallClaude),
  getAntigravityAuthStatus: () => ipcRenderer.invoke(IPC_CHANNELS.getAntigravityAuthStatus),
  connectAntigravityAuth: () => ipcRenderer.invoke(IPC_CHANNELS.connectAntigravityAuth),
  startAntigravityAuthSession: () => ipcRenderer.invoke(IPC_CHANNELS.startAntigravityAuthSession),
  writeAntigravityAuthSession: (input) => ipcRenderer.invoke(IPC_CHANNELS.writeAntigravityAuthSession, input),
  cancelAntigravityAuthSession: (sessionId) => ipcRenderer.invoke(IPC_CHANNELS.cancelAntigravityAuthSession, sessionId),
  onAntigravityAuthSessionEvent: (listener) => {
    const wrapped = (_event: unknown, payload: Parameters<typeof listener>[0]) => {
      listener(payload);
    };
    ipcRenderer.on(IPC_CHANNELS.antigravityAuthSessionEvent, wrapped);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.antigravityAuthSessionEvent, wrapped);
    };
  },
  disconnectAntigravityAuth: () => ipcRenderer.invoke(IPC_CHANNELS.disconnectAntigravityAuth),
  reinstallAntigravity: () => ipcRenderer.invoke(IPC_CHANNELS.reinstallAntigravity),
  prepareDesktopErrorReport: (input) => ipcRenderer.invoke(IPC_CHANNELS.prepareDesktopErrorReport, input),
  submitDesktopErrorReport: (input) => ipcRenderer.invoke(IPC_CHANNELS.submitDesktopErrorReport, input),
  prepareConversationDiagnosticReport: (input) => ipcRenderer.invoke(IPC_CHANNELS.prepareConversationDiagnosticReport, input),
  submitConversationDiagnosticReport: (input) => ipcRenderer.invoke(IPC_CHANNELS.submitConversationDiagnosticReport, input),
  desktopLog: (input) => ipcRenderer.invoke(IPC_CHANNELS.desktopLog, input),
  onDesktopErrorReportRequested: (listener) => {
    const wrapped = (_event: unknown, payload: Parameters<typeof listener>[0]) => {
      listener(payload);
    };
    ipcRenderer.on(IPC_CHANNELS.desktopErrorReportRequested, wrapped);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.desktopErrorReportRequested, wrapped);
    };
  },
  listAgentTools: (locale?: string) => ipcRenderer.invoke(IPC_CHANNELS.listAgentTools, locale),
  getAgentToolSettings: () => ipcRenderer.invoke(IPC_CHANNELS.getAgentToolSettings),
  updateAgentToolApproval: (input) => ipcRenderer.invoke(IPC_CHANNELS.updateAgentToolApproval, input),
  listOfficialTools: (locale) => ipcRenderer.invoke(IPC_CHANNELS.listOfficialTools, locale),
  refreshOfficialTools: (locale) => ipcRenderer.invoke(IPC_CHANNELS.refreshOfficialTools, locale),
  activateOfficialTool: (toolId, locale) => ipcRenderer.invoke(IPC_CHANNELS.activateOfficialTool, toolId, locale),
  configureOfficialTool: (input) => ipcRenderer.invoke(IPC_CHANNELS.configureOfficialTool, input),
  callOfficialTool: (input) => ipcRenderer.invoke(IPC_CHANNELS.callOfficialTool, input),
  deactivateOfficialTool: (toolId, locale) => ipcRenderer.invoke(IPC_CHANNELS.deactivateOfficialTool, toolId, locale),
  connectionsList: (locale?: string) => ipcRenderer.invoke(IPC_CHANNELS.connectionsList, locale),
  connectionsConfigure: (input) => ipcRenderer.invoke(IPC_CHANNELS.connectionsConfigure, input),
  connectionsDisconnect: (input) => ipcRenderer.invoke(IPC_CHANNELS.connectionsDisconnect, input),
  connectionsCall: (input) => ipcRenderer.invoke(IPC_CHANNELS.connectionsCall, input),
  connectionsSetDefault: (input) => ipcRenderer.invoke(IPC_CHANNELS.connectionsSetDefault, input),
  onOfficialToolEvent: (listener) => {
    const wrapped = (_event: unknown, payload: Parameters<typeof listener>[0]) => {
      listener(payload);
    };
    ipcRenderer.on(IPC_CHANNELS.officialToolEvent, wrapped);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.officialToolEvent, wrapped);
    };
  },
  getAppToolsInstallGate: (appId, locale, options) => ipcRenderer.invoke(IPC_CHANNELS.getAppToolsInstallGate, appId, locale, options),
  setAppToolGrant: (input, locale) => ipcRenderer.invoke(IPC_CHANNELS.setAppToolGrant, input, locale),
  setAppConnectionGrant: (input, locale) => ipcRenderer.invoke(IPC_CHANNELS.setAppConnectionGrant, input, locale),
  memoryList: (input) => ipcRenderer.invoke(IPC_CHANNELS.memoryList, input ?? {}),
  memoryCreate: (input) => ipcRenderer.invoke(IPC_CHANNELS.memoryCreate, input),
  memoryUpdate: (input) => ipcRenderer.invoke(IPC_CHANNELS.memoryUpdate, input),
  memoryDelete: (id) => ipcRenderer.invoke(IPC_CHANNELS.memoryDelete, id),
  getLlmRunsSnapshot: () => ipcRenderer.invoke(IPC_CHANNELS.llmRunsSnapshotGet),
  onLlmRunsSnapshotChanged: (listener) => {
    const wrapped = (_event: IpcRendererEvent, payload: Parameters<typeof listener>[0]) => listener(payload);
    ipcRenderer.on(IPC_CHANNELS.llmRunsSnapshotChanged, wrapped);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.llmRunsSnapshotChanged, wrapped);
    };
  },
  personalAgentsList: () => ipcRenderer.invoke(IPC_CHANNELS.personalAgentsList),
  personalAgentsCreate: (input) => ipcRenderer.invoke(IPC_CHANNELS.personalAgentsCreate, input),
  personalAgentGroupsList: () => ipcRenderer.invoke(IPC_CHANNELS.personalAgentGroupsList),
  personalAgentGroupsCreate: (input) => ipcRenderer.invoke(IPC_CHANNELS.personalAgentGroupsCreate, input),
  personalAgentGroupsUpdate: (input) => ipcRenderer.invoke(IPC_CHANNELS.personalAgentGroupsUpdate, input),
  personalAgentGroupsDelete: (input) => ipcRenderer.invoke(IPC_CHANNELS.personalAgentGroupsDelete, input),
  personalAgentUpdateGroup: (input) => ipcRenderer.invoke(IPC_CHANNELS.personalAgentUpdateGroup, input),
  personalAgentGrantOptionsList: () => ipcRenderer.invoke(IPC_CHANNELS.personalAgentGrantOptionsList),
  personalAgentUpdatePermissions: (input) => ipcRenderer.invoke(IPC_CHANNELS.personalAgentUpdatePermissions, input),
  personalAgentsDelete: (input) => ipcRenderer.invoke(IPC_CHANNELS.personalAgentsDelete, input),
  personalAgentConversationsList: (input) => ipcRenderer.invoke(IPC_CHANNELS.personalAgentConversationsList, input),
  personalAgentWorkspaceList: (input) => ipcRenderer.invoke(IPC_CHANNELS.personalAgentWorkspaceList, input),
  personalAgentWorkspaceFileRead: (input) => ipcRenderer.invoke(IPC_CHANNELS.personalAgentWorkspaceFileRead, input),
  personalAgentWorkspaceFileWrite: (input) => ipcRenderer.invoke(IPC_CHANNELS.personalAgentWorkspaceFileWrite, input),
  personalAgentStartConversation: (input) => ipcRenderer.invoke(IPC_CHANNELS.personalAgentStartConversation, input),
  personalAgentSendMessage: (input) => ipcRenderer.invoke(IPC_CHANNELS.personalAgentSendMessage, input),
  personalAgentGetConversation: (input) => ipcRenderer.invoke(IPC_CHANNELS.personalAgentGetConversation, input),
  personalAgentConversationDraftUpdate: (input) => ipcRenderer.invoke(IPC_CHANNELS.personalAgentConversationDraftUpdate, input),
  personalAgentWakeupCancel: (input) => ipcRenderer.invoke(IPC_CHANNELS.personalAgentWakeupCancel, input),
  personalAgentRoutinesList: (input) => ipcRenderer.invoke(IPC_CHANNELS.personalAgentRoutinesList, input),
  personalAgentRoutinesCreate: (input) => ipcRenderer.invoke(IPC_CHANNELS.personalAgentRoutinesCreate, input),
  personalAgentRoutinesUpdate: (input) => ipcRenderer.invoke(IPC_CHANNELS.personalAgentRoutinesUpdate, input),
  personalAgentRoutinesSetEnabled: (input) => ipcRenderer.invoke(IPC_CHANNELS.personalAgentRoutinesSetEnabled, input),
  personalAgentRoutinesDelete: (input) => ipcRenderer.invoke(IPC_CHANNELS.personalAgentRoutinesDelete, input),
  personalAgentRoutinesRunNow: (input) => ipcRenderer.invoke(IPC_CHANNELS.personalAgentRoutinesRunNow, input),
  personalAgentPeerThreadsList: (input) => ipcRenderer.invoke(IPC_CHANNELS.personalAgentPeerThreadsList, input),
  personalAgentPeerThreadGet: (input) => ipcRenderer.invoke(IPC_CHANNELS.personalAgentPeerThreadGet, input),
  onPersonalAgentConversationEvent: (listener) => {
    const wrapped = (_event: IpcRendererEvent, payload: PersonalAgentConversationEvent) => listener(payload);
    ipcRenderer.on(IPC_CHANNELS.personalAgentConversationEvent, wrapped);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.personalAgentConversationEvent, wrapped);
    };
  },
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
  workflowsList: () => ipcRenderer.invoke(IPC_CHANNELS.workflowsList),
  workflowsUpsert: (input) => ipcRenderer.invoke(IPC_CHANNELS.workflowsUpsert, input),
  workflowsDelete: (id) => ipcRenderer.invoke(IPC_CHANNELS.workflowsDelete, id),
  workflowsSetEnabled: (id, enabled) => ipcRenderer.invoke(IPC_CHANNELS.workflowsSetEnabled, id, enabled),
  workflowsRunNow: (id) => ipcRenderer.invoke(IPC_CHANNELS.workflowsRunNow, id),
  workflowsRunNode: (workflowId, nodeId) => ipcRenderer.invoke(IPC_CHANNELS.workflowsRunNode, workflowId, nodeId),
  workflowsCancelRun: (runId) => ipcRenderer.invoke(IPC_CHANNELS.workflowsCancelRun, runId),
  workflowsApproveNode: (input) => ipcRenderer.invoke(IPC_CHANNELS.workflowsApproveNode, input),
  workflowsListRuns: (workflowId) => ipcRenderer.invoke(IPC_CHANNELS.workflowsListRuns, workflowId),
  workflowsGetRun: (runId) => ipcRenderer.invoke(IPC_CHANNELS.workflowsGetRun, runId),
  onWorkflowUpdated: (listener) => {
    const wrapped = (_event: unknown, payload: Parameters<typeof listener>[0]) => {
      listener(payload);
    };
    ipcRenderer.on(IPC_CHANNELS.workflowUpdated, wrapped);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.workflowUpdated, wrapped);
    };
  },
  backgroundTasksList: () => ipcRenderer.invoke(IPC_CHANNELS.backgroundTasksList),
  backgroundTaskGet: (id) => ipcRenderer.invoke(IPC_CHANNELS.backgroundTaskGet, id),
  backgroundTasksUpsert: (input) => ipcRenderer.invoke(IPC_CHANNELS.backgroundTasksUpsert, input),
  onBackgroundTaskUpdated: (listener) => {
    const wrapped = (_event: unknown, payload: Parameters<typeof listener>[0]) => {
      listener(payload);
    };
    ipcRenderer.on(IPC_CHANNELS.backgroundTaskUpdated, wrapped);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.backgroundTaskUpdated, wrapped);
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
