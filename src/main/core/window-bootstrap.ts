// @ts-nocheck

type WindowBootstrapDeps = Record<string, any>;

export const createWindowBootstrapController = (deps: WindowBootstrapDeps) => {
  const { state, path, app, BrowserWindow, isDev, useCustomWindowFrame, registerWindowStateEvents, desktopErrorReporter, loadDesktopWindow, getMainProcessIpcDeps, registerMainIpcHandlers, registerAgentIpcHandlers, registerWindowIpcHandlers, ipcMain, getWindowState, focusDeepLinkWindow, IPC_CHANNELS } = deps;
const createWindow = async (): Promise<void> => {
  const preloadPath = path.join(__dirname, '..', '..', 'preload', 'index.js');

  state.mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1180,
    minHeight: 760,
    backgroundColor: '#F6F3EE',
    title: isDev ? 'Forger Dev' : 'Forger',
    frame: !useCustomWindowFrame,
    titleBarStyle: process.platform === 'darwin' ? 'hidden' : undefined,
    trafficLightPosition: process.platform === 'darwin' ? { x: 14, y: 16 } : undefined,
    autoHideMenuBar: true,
    webPreferences: {
      preload: preloadPath,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  registerWindowStateEvents(state.mainWindow);
  state.mainWindow.webContents.on('render-process-gone', (_event, details) => {
    desktopErrorReporter?.reportRendererProcessGone(details);
  });

  await loadDesktopWindow(state.mainWindow);
};

const getMainProcessIpcDeps = () => ({
  state: {
    get agentToolSettings() {
      return agentToolSettings;
    },
    set agentToolSettings(value) {
      agentToolSettings = value;
    },
    get catalogApps() {
      return catalogApps;
    },
    set catalogApps(value) {
      catalogApps = value;
    },
    get cloudSyncSettings() {
      return cloudSyncSettings;
    },
    set cloudSyncSettings(value) {
      cloudSyncSettings = value;
    },
    get forgerAccount() {
      return forgerAccount;
    },
    set forgerAccount(value) {
      forgerAccount = value;
    },
    get settings() {
      return settings;
    },
    set settings(value) {
      settings = value;
    },
  },
  AGENT_TOOL_PACKAGES,
  APP_CLAUDE_MODEL_OPTIONS,
  APP_CODEX_MODEL_OPTIONS,
  BetterSqlite3,
  BrowserWindow,
  BUILT_IN_CLAUDE_EFFORT,
  BUILT_IN_CODEX_REASONING,
  CODEX_USAGE_DASHBOARD_URL,
  IPC_CHANNELS,
  agentToolSettings,
  app,
  appAgentConversationManager,
  appAgentTaskManager,
  appFolderGrantSecret,
  appendInstallLog,
  automationManager,
  buildAppSecretsState,
  buildCodexPromptWithAppContext,
  buildForgerToolsContextForApp,
  canUseCloudDataSync,
  catalogApps,
  chatOrchestrator,
  cloudDeviceManager,
  cloudSyncSettings,
  connectClaudeAuth,
  connectCodexAuth,
  createRemoteAppBackup,
  decryptCloudMessage,
  decryptCloudMessages,
  desktopErrorReporter,
  dialog,
  disconnectCodexAuth,
  ensureCatalogStatuses,
  failureDiagnostic,
  forgerAccount,
  forgerBackendClient,
  fs,
  getAppDetails,
  getAppRuntimeStatus: getRuntimeStatus,
  getBackupsManager,
  getClaudeAuthStatus,
  getCloudIdentityStore,
  getCodexAuthStatus,
  getDesktopUpdater,
  getFileLibrary,
  getMemoryStore,
  getOfficialToolsService,
  getPrivateDataRoot,
  getRuntimeStatus,
  getSecretsStore,
  getWindowState,
  installAppRuntime,
  installWelcome,
  ipcMain,
  listAppPrompts,
  listCatalogFromBackend,
  mainWindow: state.mainWindow,
  normalizeAgentProvider,
  normalizeClaudeEffort,
  normalizeCodexReasoningEffort,
  normalizeManifestAgentDefaults,
  openInstalledApp,
  openOrFocusFriendChatWindow,
  path,
  publicForgerAccount,
  registry,
  reinstallClaude,
  reinstallCodex,
  renderManifestAgentPrompt,
  resolveAppDbPath,
  resolveAppIdForWebContents,
  resolveInstalledAgents,
  resolveInstalledAppSecrets,
  resolveInstalledManifest,
  resolveSelectedAppDisplayName,
  restoreAppPrompt,
  restoreAppUserVersionRuntime,
  restoreRemoteAppBackup,
  sanitizeRendererChatTrace,
  sendEncryptedCloudMessage,
  serializeErrorForInstallLog,
  setAppAutoSyncSetting,
  settings,
  shell,
  signAppFolderGrant,
  stopInstalledApp,
  switchForgerAccountSession,
  toAppSummary,
  uninstallAppRuntime,
  updateAgentDefaults,
  updateAgentToolApproval,
  updateAppPrompt,
  updateAppRuntime,
  updateCodexDefaults,
  validateAppPrompt,
});

const registerIpcHandlers = (): void => {
  const deps = getMainProcessIpcDeps();
  registerMainIpcHandlers(deps);
  registerAgentIpcHandlers(deps);

  registerWindowIpcHandlers({
    ipcMain,
    getMainWindow: () => state.mainWindow,
    readWindowState: getWindowState,
    quitApp: () => app.quit(),
  });
};
// ── Deep-link routing ────────────────────────────────────────────────
// Handles `forger://` URLs from any source (OS protocol activation,
// `open-url` on macOS, or `second-instance` re-entry on Win/Linux).
// Defers delivery to the renderer when the main window is not ready
// yet via `state.pendingDeepLink` + `flushPendingDeepLink`.

const dispatchDeepLink = (link: ForgerDeepLink): void => {
  if (!state.mainWindow || state.mainWindow.webContents.isLoading()) {
    state.pendingDeepLink = link;
    if (state.mainWindow) {
      // Window exists but content still loading — flush once the load
      // completes. Reusing `did-finish-load` over `dom-ready` because
      // the renderer needs its IPC subscriptions registered, which
      // happens during script execution.
      state.mainWindow.webContents.once('did-finish-load', flushPendingDeepLink);
    }
    return;
  }
  focusDeepLinkWindow(state.mainWindow);
  state.mainWindow.webContents.send(IPC_CHANNELS.deepLink, link);
};

const flushPendingDeepLink = (): void => {
  if (!state.pendingDeepLink || !state.mainWindow) return;
  const link = state.pendingDeepLink;
  state.pendingDeepLink = null;
  focusDeepLinkWindow(state.mainWindow);
  state.mainWindow.webContents.send(IPC_CHANNELS.deepLink, link);
};

const handleIncomingUrl = (rawUrl: string): void => {
  const link = parseForgerUrl(rawUrl);
  if (!link) return;
  dispatchDeepLink(link);
};

registerForgerProtocol();

// Single-instance lock: when the OS opens a `forger://` URL while a
// Desktop instance is already running, Electron spawns a second
// instance. `requestSingleInstanceLock` makes that second instance
// quit immediately and pipe its argv into the running one via
// `second-instance`, so we always have exactly one Desktop process
// handling deep-links.
const gotSingleInstance = app.requestSingleInstanceLock();
if (!gotSingleInstance) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    const link = extractDeepLinkFromArgv(argv);
    if (link) dispatchDeepLink(link);
    else focusDeepLinkWindow(state.mainWindow);
  });
}

// macOS path: the OS does not pass URLs in argv; it fires `open-url`
// (and re-fires it after activation if the URL arrived before ready).
app.on('open-url', (event, url) => {
  event.preventDefault();
  handleIncomingUrl(url);
});

// Cold-start argv: on Windows/Linux a `forger://` URL is passed as the
// last argv entry. On macOS this is empty (URLs arrive via open-url).
const coldStartLink = extractDeepLinkFromArgv(process.argv);
if (coldStartLink) {
  state.pendingDeepLink = coldStartLink;
}

  return { createWindow, registerIpcHandlers, dispatchDeepLink, flushPendingDeepLink, handleIncomingUrl };
};
