// @ts-nocheck
export const registerMainLifecycle = (deps) => {
  const {
    AGENT_TOOL_DEFINITIONS,
    AppAgentConversationManager,
    AppAgentTaskManager,
    AppMcpManager,
    AutomationManager,
    BrowserWindow,
    ChatOrchestrator,
    CloudDeviceManager,
    CloudIdentityStore,
    DEFAULT_NODE_VERSION,
    DesktopRuntimeBridge,
    DevCatalogService,
    FORGER_AGENT_CONTRACT_VERSION,
    FileLibrary,
    ForgerAccountStore,
    ForgerBackendClient,
    ForgerMcpServer,
    IPC_CHANNELS,
    MemoryStore,
    SecretsStore,
    anyAppAllowsAgentNetworkAccess,
    app,
    appAllowsAgentNetworkAccess,
    appWindows,
    appendInstallLog,
    backendBaseUrl,
    buildForgerToolsContextForApp,
    buildMemoryContextForApp,
    buildMemoryContextForApps,
    chooseAgentRuntime,
    clearForgerAccountSession,
    closeServer,
    createWindow,
    emitAutomationUpdated,
    emitChatRunUpdated,
    ensureBackendPythonEnvironment,
    ensureCatalogStatuses,
    ensureGlobalAgentsContext,
    ensurePathInside,
    ensureRuntimeInstalled,
    ensureSqliteDatabaseParent,
    flushPendingDeepLink,
    fs,
    getAppLocalToolPathEntries,
    getBackupsRoot,
    getClaudeAuthStatus,
    getCloudDeviceAccountStorageKey,
    getCloudDevicePath,
    getCloudIdentityPath,
    getCloudIdentityStore,
    getCodexAuthStatus,
    getCodexHome,
    getCodexRoot,
    getCodexToolEnvironment,
    getForgerAccountPath,
    getForgerHomeRoot,
    getForgerMetadataRoot,
    getFreePort,
    getLegacyForgerMetadataRoot,
    getMemoryStore,
    getOfficialToolsService,
    getPrivateAppsRoot,
    getPrivateDataRoot,
    getRuntimesRoot,
    getRuntimePathEntries,
    getTempRoot,
    getVenvExecutables,
    handleCloudRelayRequest,
    handleCloudSocialEvent,
    hasInstalledCodexConversation,
    ipcMain,
    listAppPrompts,
    listCatalogFromBackend,
    loadAgentToolSettings,
    loadCloudSyncSettings,
    loadRegistry,
    loadSettings,
    mapBackendCategory,
    normalizeNodeRuntimeVersion,
    openInstalledApp,
    openOrFocusAppWindow,
    registerForgerCloudOAuth,
    registerIpcHandlers,
    resolveClaudeCli,
    resolveCodexCliPath,
    resolveInstalledAgents,
    resolveInstalledManifest,
    resolveInstalledPromptTemplates,
    restoreAppPrompt,
    restartInstalledApp,
    runningApps,
    serializeErrorForInstallLog,
    shell,
    splitManifestCommand,
    startDevCatalogService,
    state,
    stopInstalledApp,
    switchForgerAccountSession,
    terminateProcess,
    toAppSummary,
    toCatalogStatus,
    translateManifestEnvironment,
    truncateForInstallLog,
    updateAppPrompt,
    updateAppRuntime,
    upsertInstalledRecord,
    waitForHttpOk,
  } = deps;

  app.whenReady().then(async () => {
  await fs.mkdir(getTempRoot(), { recursive: true });
  await fs.mkdir(getRuntimesRoot(), { recursive: true });
  await fs.mkdir(getForgerHomeRoot(), { recursive: true });
  await fs.mkdir(getForgerMetadataRoot(), { recursive: true });
  await fs.mkdir(getPrivateAppsRoot(), { recursive: true });
  await fs.mkdir(getPrivateDataRoot(), { recursive: true });
  await fs.mkdir(getBackupsRoot(), { recursive: true });
  await ensureGlobalAgentsContext(getForgerHomeRoot());
  await fs.mkdir(getCodexRoot(), { recursive: true });
  await fs.mkdir(getCodexHome(), { recursive: true });
  await loadSettings();
  state.secretsStore = new SecretsStore(app.getPath('userData'));
  state.officialToolsService = getOfficialToolsService();
  await state.officialToolsService.load();
  await loadAgentToolSettings();
  state.forgerAccountStore = new ForgerAccountStore(getForgerAccountPath());
  state.forgerAccount = await state.forgerAccountStore.load();
  state.cloudIdentityStore = new CloudIdentityStore(getCloudIdentityPath());
  await state.cloudIdentityStore.getSummary().catch(() => undefined);
  await loadCloudSyncSettings();
  state.memoryStore = new MemoryStore(getForgerMetadataRoot());
  await loadRegistry();
  await startDevCatalogService();
  state.forgerBackendClient = new ForgerBackendClient({
    backendBaseUrl,
    localCatalogJsonUrl: () => state.localCatalogJsonUrl,
    token: () => state.forgerAccount.token,
    mapBackendCategory,
    toCatalogStatus,
    getUserMessage: (slug) => state.registry.apps[slug]?.userMessage,
  });
  registerForgerCloudOAuth({
    ipcMain,
    channel: IPC_CHANNELS.loginForgerAccountWithGoogle,
    backendClient: () => state.forgerBackendClient,
    saveAccount: switchForgerAccountSession,
    openExternalUrl: async (url) => {
      await shell.openExternal(url);
    },
    appendLog: appendInstallLog,
    refreshCatalog: async () => {
      state.catalogApps = await listCatalogFromBackend();
      ensureCatalogStatuses();
    },
  });
  state.cloudDeviceManager = new CloudDeviceManager({
    filePath: getCloudDevicePath(),
    accountStorageKey: getCloudDeviceAccountStorageKey,
    backendBaseUrl,
    backendClient: () => state.forgerBackendClient,
    token: () => state.forgerAccount.token,
    getCloudIdentity: () => getCloudIdentityStore().getPublicRegistration(),
    getInstalledApps: () => Object.values(state.registry.apps).map(toAppSummary),
    handleRelayRequest: handleCloudRelayRequest,
    handleFriendshipEvent: handleCloudSocialEvent,
    onAuthenticationInvalid: clearForgerAccountSession,
  });
  await state.cloudDeviceManager.start();
  state.forgerMcpServer = new ForgerMcpServer({
    getAppVersion: () => app.getVersion(),
    getToolDefinitions: () => AGENT_TOOL_DEFINITIONS,
    getToolSettings: () => state.agentToolSettings,
    appendInstallLog,
    requestPermission: async (runId, request) => {
      const taskDecision = await (state.appAgentTaskManager?.requestPermission(runId, request) ?? Promise.resolve(null));
      if (taskDecision !== null) {
        return taskDecision;
      }
      const conversationDecision = await (state.appAgentConversationManager?.requestPermission(runId, request) ?? Promise.resolve(null));
      if (conversationDecision !== null) {
        return conversationDecision;
      }
      return state.chatOrchestrator?.requestExternalPermission(runId, request) ?? null;
    },
    listCatalog: async () => {
      state.catalogApps = await listCatalogFromBackend();
      ensureCatalogStatuses();
      return state.catalogApps;
    },
    listInstalledApps: () => Object.values(state.registry.apps).map(toAppSummary),
    checkUpdates: async () => {
      state.catalogApps = await listCatalogFromBackend();
      ensureCatalogStatuses();
      return Object.values(state.registry.apps)
        .map((record) => toAppSummary(record))
        .filter((summary) => summary.updateAvailable);
    },
    getRuntimeStatus,
    openApp: openInstalledApp,
    stopApp: stopInstalledApp,
    restartApp: restartInstalledApp,
    refreshAppView: async (appId) => {
      const appWindow = appWindows.get(appId);
      const running = runningApps.get(appId);
      if (appWindow && !appWindow.isDestroyed()) {
        appWindow.webContents.reloadIgnoringCache();
        return { success: true, userMessage: 'Vista reiniciada correctamente.' };
      }
      if (running) {
        const record = state.registry.apps[appId];
        await openOrFocusAppWindow(appId, record?.name ?? appId, running.frontendUrl);
        return { success: true, userMessage: 'Vista abierta correctamente.' };
      }
      return { success: false, userMessage: 'La app no esta abierta.', technicalCode: 'app_not_running' };
    },
    updateApp: updateAppRuntime,
    listAppPrompts,
    updateAppPrompt,
    restoreAppPrompt,
    memoryList: async (input, access) => await getMemoryStore().list(input, access),
    memoryCreate: async (input, access) => await getMemoryStore().create(input, access),
    memoryUpdate: async (input, access) => await getMemoryStore().update(input, access),
    memoryDelete: async (id, access) => await getMemoryStore().delete(id, access),
    listOfficialToolActionIdsForApp: async (appId) => await getOfficialToolsService().listAgentActionIdsForApp(appId),
    validateOfficialTool: async (input, access) => await getOfficialToolsService().validateAgentCall(input, {
      appId: access.appId,
      requireAppGrant: access.caller === 'app-agent',
    }),
    callOfficialTool: async (input, access) => await getOfficialToolsService().callFromAgent(input, {
      appId: access.appId,
      requireAppGrant: access.caller === 'app-agent',
    }),
    onToolProgress: (input) => state.chatOrchestrator?.appendExternalProgress(input.runId, input.message),
    onToolFailure: (input) => desktopErrorReporter?.reportForgerMcpToolFailure(input),
    onHttpFailure: (input) => desktopErrorReporter?.reportForgerMcpHttpFailure(input),
  });
  await state.forgerMcpServer.start();
  state.appMcpManager = new AppMcpManager({
    getInstalledApp: (appId) => state.registry.apps[appId],
    resolveInstalledManifest,
    ensureRuntimeInstalled,
    ensureBackendPythonEnvironment,
    getVenvExecutables,
    getFreePort,
    splitManifestCommand,
    ensurePathInside,
    translateManifestEnvironment,
    ensureSqliteDatabaseParent,
    getDesktopRuntimeEnvironment: (appId) => state.desktopRuntimeBridge?.environmentForApp(appId) ?? {},
    getRuntimePathEntries,
    waitForHttpOk,
    terminateProcess,
    appendInstallLog,
    truncateForInstallLog,
    serializeErrorForInstallLog,
    onMcpStartFailed: (input) => desktopErrorReporter?.reportAppMcpStartFailure(input),
  });
  state.fileLibrary = new FileLibrary(getPrivateDataRoot(), getForgerMetadataRoot());
  await state.fileLibrary.cleanupStagedFilesForChat().catch((error) => {
    void appendInstallLog('files:chat_staging_cleanup_failed', {
      error: serializeErrorForInstallLog(error),
    });
  });
  state.chatOrchestrator = new ChatOrchestrator({
    forgerHomeRoot: getForgerHomeRoot(),
    privateAppsRoot: getPrivateAppsRoot(),
    metadataRoot: getForgerMetadataRoot(),
    legacyMetadataRoot: getLegacyForgerMetadataRoot(),
    codexHome: getCodexHome(),
    getAgentRuntime: chooseAgentRuntime,
    agentContractVersion: FORGER_AGENT_CONTRACT_VERSION,
    getCodexCliPath: async () => await resolveCodexCliPath(getCodexRoot()),
    getClaudeCliPath: async () => (await resolveClaudeCli())?.path ?? null,
    getCodexPathEntries: async (appId?: string) => {
      const pathEntries = new Set<string>();
      const record = appId ? state.registry.apps[appId] : undefined;
      if (record) {
        for (const entry of await getAppLocalToolPathEntries(record)) {
          pathEntries.add(entry);
        }
      }

      const codexNodeRuntime = await ensureRuntimeInstalled('node', DEFAULT_NODE_VERSION);
      for (const entry of getRuntimePathEntries(codexNodeRuntime)) {
        pathEntries.add(entry);
      }

      if (record) {
        const appNodeRuntime = await ensureRuntimeInstalled('node', normalizeNodeRuntimeVersion(record.requiredNodeVersion));
        const appPythonRuntime = await ensureRuntimeInstalled('python', record.requiredPythonVersion);
        for (const entry of getRuntimePathEntries(appNodeRuntime)) {
          pathEntries.add(entry);
        }
        for (const entry of getRuntimePathEntries(appPythonRuntime)) {
          pathEntries.add(entry);
        }
      }

      return [...pathEntries];
    },
    getCodexEnvironment: async (appId?: string) => {
      const record = appId ? state.registry.apps[appId] : undefined;
      const appPythonRuntime = record
        ? await ensureRuntimeInstalled('python', record.requiredPythonVersion)
        : undefined;
      return await getCodexToolEnvironment(appId, appPythonRuntime);
    },
    getAgentNetworkAccess: appAllowsAgentNetworkAccess,
    getCodexAuthenticated: async () => {
      const status = await getCodexAuthStatus();
      return status.authenticated;
    },
    getClaudeAuthenticated: async () => {
      const status = await getClaudeAuthStatus();
      return status.authenticated;
    },
    createForgerMcpSession: (runId, appId, locale) =>
      state.forgerMcpServer?.createSession(runId, appId, {
        caller: appId === 'forger' ? 'free-chat' : 'desktop-chat',
        appIds: appId === 'forger' ? Object.keys(state.registry.apps) : [appId],
        locale,
      }) ?? null,
    releaseForgerMcpSession: (token) => state.forgerMcpServer?.releaseSession(token),
    buildMemoryContext: buildMemoryContextForApps,
    listenAppMcps: async (appIds: string[], runId: string) =>
      await (state.appMcpManager?.listenMcps(appIds.length > 0 ? appIds : Object.keys(state.registry.apps), runId) ?? Promise.resolve([])),
    releaseAppMcps: (runId: string) => {
      state.appMcpManager?.releaseMcps(runId);
    },
    trace: appendInstallLog,
    onUpdateConflictResolved: async (appId: string) => {
      const current = state.registry.apps[appId];
      if (!current?.pendingUpdate) {
        return;
      }
      await upsertInstalledRecord({
        ...current,
        version: current.pendingUpdate.targetVersion,
        status: 'installed',
        userMessage: 'Actualizacion combinada y lista para abrir.',
        pendingUpdate: undefined,
      });
      ensureCatalogStatuses();
    },
    onRunUpdated: (event) => {
      if (event.run.status === 'failed') {
        desktopErrorReporter?.reportChatRunFailure({
          appId: event.run.appId,
          runId: event.run.runId,
          errorCode: event.run.errorCode,
          message: event.run.userMessage,
        });
      }
      emitChatRunUpdated(event);
    },
  });
  state.appAgentTaskManager = new AppAgentTaskManager({
    privateAppsRoot: getPrivateAppsRoot(),
    metadataRoot: getForgerMetadataRoot(),
    codexHome: getCodexHome(),
    getAgentRuntime: chooseAgentRuntime,
    getCodexCliPath: async () => await resolveCodexCliPath(getCodexRoot()),
    getClaudeCliPath: async () => (await resolveClaudeCli())?.path ?? null,
    getCodexPathEntries: async (appId?: string) => {
      const pathEntries = new Set<string>();
      const record = appId ? state.registry.apps[appId] : undefined;
      if (record) {
        for (const entry of await getAppLocalToolPathEntries(record)) {
          pathEntries.add(entry);
        }
      }

      const codexNodeRuntime = await ensureRuntimeInstalled('node', DEFAULT_NODE_VERSION);
      for (const entry of getRuntimePathEntries(codexNodeRuntime)) {
        pathEntries.add(entry);
      }

      if (record) {
        const appNodeRuntime = await ensureRuntimeInstalled('node', normalizeNodeRuntimeVersion(record.requiredNodeVersion));
        const appPythonRuntime = await ensureRuntimeInstalled('python', record.requiredPythonVersion);
        for (const entry of getRuntimePathEntries(appNodeRuntime)) {
          pathEntries.add(entry);
        }
        for (const entry of getRuntimePathEntries(appPythonRuntime)) {
          pathEntries.add(entry);
        }
      }

      return [...pathEntries];
    },
    getCodexEnvironment: async (appId?: string) => {
      const record = appId ? state.registry.apps[appId] : undefined;
      const appPythonRuntime = record
        ? await ensureRuntimeInstalled('python', record.requiredPythonVersion)
        : undefined;
      return await getCodexToolEnvironment(appId, appPythonRuntime);
    },
    getAgentNetworkAccess: appAllowsAgentNetworkAccess,
    getCodexAuthenticated: async () => {
      const status = await getCodexAuthStatus();
      return status.authenticated;
    },
    getClaudeAuthenticated: async () => {
      const status = await getClaudeAuthStatus();
      return status.authenticated;
    },
    resolvePromptTemplates: resolveInstalledPromptTemplates,
    createForgerMcpSession: (runId, appId) =>
      state.forgerMcpServer?.createSession(runId, appId, { caller: 'app-agent', appIds: [appId] }) ?? null,
    releaseForgerMcpSession: (token) => state.forgerMcpServer?.releaseSession(token),
    buildMemoryContext: buildMemoryContextForApp,
    buildForgerToolsContext: buildForgerToolsContextForApp,
    listenAppMcps: async (appIds: string[], runId: string) =>
      await (state.appMcpManager?.listenMcps(appIds, runId) ?? Promise.resolve([])),
    releaseAppMcps: (runId: string) => {
      state.appMcpManager?.releaseMcps(runId);
    },
    canRequestPermission: (appId: string) => {
      const target = appWindows.get(appId);
      return Boolean(target && !target.isDestroyed());
    },
    onTaskUpdated: (event) => {
      desktopErrorReporter?.reportAppCodexTaskEvent(event);
      const target = appWindows.get(event.task.appId);
      if (target && !target.isDestroyed()) {
        target.webContents.send(IPC_CHANNELS.appAgentTaskUpdated, event);
        target.webContents.send(IPC_CHANNELS.appCodexTaskUpdated, event);
      }
    },
  });
  state.appAgentConversationManager = new AppAgentConversationManager({
    privateAppsRoot: getPrivateAppsRoot(),
    metadataRoot: getForgerMetadataRoot(),
    codexHome: getCodexHome(),
    getAgentRuntime: chooseAgentRuntime,
    getCodexCliPath: async () => await resolveCodexCliPath(getCodexRoot()),
    getClaudeCliPath: async () => (await resolveClaudeCli())?.path ?? null,
    getCodexPathEntries: async (appId?: string) => {
      const pathEntries = new Set<string>();
      const record = appId ? state.registry.apps[appId] : undefined;
      if (record) {
        for (const entry of await getAppLocalToolPathEntries(record)) {
          pathEntries.add(entry);
        }
      }

      const codexNodeRuntime = await ensureRuntimeInstalled('node', DEFAULT_NODE_VERSION);
      for (const entry of getRuntimePathEntries(codexNodeRuntime)) {
        pathEntries.add(entry);
      }

      if (record) {
        const appNodeRuntime = await ensureRuntimeInstalled('node', normalizeNodeRuntimeVersion(record.requiredNodeVersion));
        const appPythonRuntime = await ensureRuntimeInstalled('python', record.requiredPythonVersion);
        for (const entry of getRuntimePathEntries(appNodeRuntime)) {
          pathEntries.add(entry);
        }
        for (const entry of getRuntimePathEntries(appPythonRuntime)) {
          pathEntries.add(entry);
        }
      }

      return [...pathEntries];
    },
    getCodexEnvironment: async (appId?: string) => {
      const record = appId ? state.registry.apps[appId] : undefined;
      const appPythonRuntime = record
        ? await ensureRuntimeInstalled('python', record.requiredPythonVersion)
        : undefined;
      return await getCodexToolEnvironment(appId, appPythonRuntime);
    },
    getAgentNetworkAccess: appAllowsAgentNetworkAccess,
    getCodexAuthenticated: async () => {
      const status = await getCodexAuthStatus();
      return status.authenticated;
    },
    getClaudeAuthenticated: async () => {
      const status = await getClaudeAuthStatus();
      return status.authenticated;
    },
    hasCodexConversation: hasInstalledCodexConversation,
    resolveAgents: resolveInstalledAgents,
    createForgerMcpSession: (runId, appId, locale) =>
      state.forgerMcpServer?.createSession(runId, appId, { caller: 'app-agent', appIds: [appId], locale }) ?? null,
    releaseForgerMcpSession: (token) => state.forgerMcpServer?.releaseSession(token),
    buildMemoryContext: buildMemoryContextForApp,
    buildForgerToolsContext: buildForgerToolsContextForApp,
    listenAppMcps: async (appIds: string[], runId: string) =>
      await (state.appMcpManager?.listenMcps(appIds, runId) ?? Promise.resolve([])),
    releaseAppMcps: (runId: string) => {
      state.appMcpManager?.releaseMcps(runId);
    },
    canRequestPermission: (appId: string) => {
      const target = appWindows.get(appId);
      return Boolean(target && !target.isDestroyed());
    },
    onConversationEvent: (event) => {
      desktopErrorReporter?.reportAppCodexConversationEvent(event);
      state.desktopRuntimeBridge?.publishAgentEvent(event);
      const target = appWindows.get(event.conversation.appId);
      if (target && !target.isDestroyed()) {
        target.webContents.send(IPC_CHANNELS.appAgentConversationEvent, event);
        target.webContents.send(IPC_CHANNELS.appCodexConversationEvent, event);
        if (event.type === 'run.message.completed') {
          return;
        }
        const desktopThreadId = event.conversation.conversationId;
        const normalizedType = event.type === 'conversation.created'
          ? 'thread.created'
          : event.type === 'message.created'
            ? 'run.message'
            : event.type;
        target.webContents.send(IPC_CHANNELS.appAgentThreadEvent, {
          type: normalizedType,
          desktop_thread_id: desktopThreadId,
          ...(event.run ? { desktop_run_id: event.run.runId } : {}),
          thread: {
            desktop_thread_id: desktopThreadId,
            title: event.conversation.title,
            status: event.run?.status ?? event.conversation.activeRun?.status ?? 'idle',
          },
          ...(event.run
            ? {
                run: {
                  desktop_thread_id: desktopThreadId,
                  desktop_run_id: event.run.runId,
                  status: event.run.status,
                  ...(event.run.error ? { error: event.run.error } : {}),
                  ...(event.run.progressLog ? { progressLog: event.run.progressLog } : {}),
                },
              }
            : {}),
          ...(event.progress ? { progress: event.progress } : {}),
        });
      }
    },
  });
  state.desktopRuntimeBridge = new DesktopRuntimeBridge({
    getInstalledApp: (appId) => state.registry.apps[appId],
    getConversationManager: () => state.appAgentConversationManager,
    getTaskManager: () => state.appAgentTaskManager,
    getTaskStatus: async () => {
      const [codexStatus, claudeStatus] = await Promise.all([
        getCodexAuthStatus().catch(() => ({ authenticated: false })),
        getClaudeAuthStatus().catch(() => ({ authenticated: false })),
      ]);
      const codex = Boolean(codexStatus.authenticated);
      const claude = Boolean(claudeStatus.authenticated);
      return {
        connected: codex || claude,
        codex,
        claude,
      };
    },
    appendInstallLog,
    serializeErrorForInstallLog,
  });
  await state.desktopRuntimeBridge.start();
  state.automationManager = new AutomationManager({
    forgerHomeRoot: getForgerHomeRoot(),
    metadataRoot: getForgerMetadataRoot(),
    codexHome: getCodexHome(),
    getAgentRuntime: chooseAgentRuntime,
    getInstalledApps: () => Object.values(state.registry.apps).map(toAppSummary),
    getCodexCliPath: async () => await resolveCodexCliPath(getCodexRoot()),
    getClaudeCliPath: async () => (await resolveClaudeCli())?.path ?? null,
    getCodexPathEntries: async () => {
      const nodeRuntime = await ensureRuntimeInstalled('node', DEFAULT_NODE_VERSION);
      return getRuntimePathEntries(nodeRuntime);
    },
    getAgentNetworkAccess: anyAppAllowsAgentNetworkAccess,
    getCodexAuthenticated: async () => {
      const status = await getCodexAuthStatus();
      return status.authenticated;
    },
    getClaudeAuthenticated: async () => {
      const status = await getClaudeAuthStatus();
      return status.authenticated;
    },
    createForgerMcpSession: (runId, appId, appIds) =>
      state.forgerMcpServer?.createSession(runId, appId, { caller: 'automation', appIds }) ?? null,
    releaseForgerMcpSession: (token) => state.forgerMcpServer?.releaseSession(token),
    buildMemoryContext: buildMemoryContextForApps,
    listenAppMcps: async (appIds: string[], runId: string) =>
      await (state.appMcpManager?.listenMcps(appIds, runId) ?? Promise.resolve([])),
    releaseAppMcps: (runId: string) => {
      state.appMcpManager?.releaseMcps(runId);
    },
    onAutomationUpdated: (event) => {
      if (event.run?.status === 'failed') {
        desktopErrorReporter?.reportAutomationRunFailure({
          automationId: event.automation.id,
          runId: event.run.id,
          selectedAppIds: event.automation.selectedAppIds,
          error: event.run.error ?? event.run.userMessage ?? 'automation_run_failed',
        });
      }
      emitAutomationUpdated(event as { automation: unknown; run?: unknown });
    },
  });
  await state.automationManager.initialize();

  registerIpcHandlers();
  ensureCatalogStatuses();
  await createWindow();

  // Deliver any deep-link captured before the renderer existed (cold
  // boot from `process.argv` or an `open-url` fired during startup).
  if (state.mainWindow && state.pendingDeepLink) {
    state.mainWindow.webContents.once('did-finish-load', flushPendingDeepLink);
  }

  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createWindow();
    }
  });
});

app.on('before-quit', () => {
  state.automationManager?.dispose();
  state.appMcpManager?.dispose();
  void state.desktopRuntimeBridge?.stop();
  state.desktopRuntimeBridge = null;
  state.cloudDeviceManager?.stop();
  (state.devCatalogService as DevCatalogService | null)?.stop();
  state.forgerMcpServer?.stop();
  state.forgerMcpServer = null;
  for (const running of runningApps.values()) {
    void terminateProcess(running.backend);
    void terminateProcess(running.frontend);
    void closeServer(running.proxyServer);
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
};
