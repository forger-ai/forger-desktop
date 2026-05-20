// @ts-nocheck
import { registerWindowIpcHandlers } from './window';

type MainProcessIpcDeps = Record<string, any>;

export const registerMainIpcHandlers = (deps: MainProcessIpcDeps): void => {
  const { state, APP_CLAUDE_MODEL_OPTIONS, APP_CODEX_MODEL_OPTIONS, AGENT_TOOL_PACKAGES, BetterSqlite3, BrowserWindow, CODEX_USAGE_DASHBOARD_URL, IPC_CHANNELS, app, appAgentConversationManager, appAgentTaskManager, appFolderGrantSecret, appendInstallLog, automationManager, buildAppSecretsState, buildCodexPromptWithAppContext, buildForgerToolsContextForApp, canUseCloudDataSync, chatOrchestrator, cloudDeviceManager, connectClaudeAuth, connectCodexAuth, createRemoteAppBackup, decryptCloudMessage, decryptCloudMessages, desktopErrorReporter, dialog, disconnectCodexAuth, ensureCatalogStatuses, failureDiagnostic, forgerBackendClient, fs, getAppDetails, getBackupsManager, getClaudeAuthStatus, getCloudIdentityStore, getCodexAuthStatus, getDesktopUpdater, getFileLibrary, getMemoryStore, getOfficialToolsService, getPrivateDataRoot, getRuntimeStatus, getSecretsStore, installAppRuntime, installWelcome, ipcMain, listAppPrompts, listCatalogFromBackend, normalizeManifestAgentDefaults, openInstalledApp, openOrFocusFriendChatWindow, path, publicForgerAccount, registry, reinstallClaude, reinstallCodex, resolveAppDbPath, resolveAppIdForWebContents, resolveInstalledAgents, resolveInstalledAppSecrets, resolveInstalledManifest, resolveSelectedAppDisplayName, restoreAppPrompt, restoreAppUserVersionRuntime, restoreRemoteAppBackup, sanitizeRendererChatTrace, sendEncryptedCloudMessage, serializeErrorForInstallLog, setAppAutoSyncSetting, shell, signAppFolderGrant, stopInstalledApp, switchForgerAccountSession, toAppSummary, uninstallAppRuntime, updateAgentDefaults, updateAgentToolApproval, updateAppPrompt, updateAppRuntime, updateCodexDefaults, validateAppPrompt } = deps;
  ipcMain.handle(IPC_CHANNELS.listInstalledApps, async () => {
    return Object.values(registry.apps).map(toAppSummary);
  });

  ipcMain.handle(IPC_CHANNELS.listCatalogApps, async () => {
    state.catalogApps = await listCatalogFromBackend();
    ensureCatalogStatuses();
    return state.catalogApps;
  });

  ipcMain.handle(IPC_CHANNELS.installApp, async (_event, appId: string, locale?: string) => {
    return await installAppRuntime(appId, locale);
  });

  ipcMain.handle(IPC_CHANNELS.updateApp, async (_event, appId: string, locale?: string) => {
    return await updateAppRuntime(appId, locale);
  });

  ipcMain.handle(IPC_CHANNELS.listBackups, async (_event, appId?: string) => {
    return await getBackupsManager().listBackups(appId);
  });

  ipcMain.handle(IPC_CHANNELS.createBackup, async (_event, input: { appId: string; reason?: 'manual' | 'update' | 'pre_restore' }) => {
    try {
      return await getBackupsManager().createBackup(input);
    } catch (error) {
      const diagnostic = failureDiagnostic(error, 'backup_create_failed');
      await appendInstallLog('backup:create_failed', {
        appId: input?.appId,
        detail: diagnostic.technicalCode,
        error: serializeErrorForInstallLog(error),
      });
      return {
        success: false,
        userMessage: 'No pudimos crear el respaldo.',
        ...diagnostic,
      };
    }
  });

  ipcMain.handle(IPC_CHANNELS.deleteBackup, async (_event, input: { appId: string; backupId: string }) => {
    try {
      return await getBackupsManager().deleteBackup(input);
    } catch (error) {
      const diagnostic = failureDiagnostic(error, 'backup_delete_failed');
      await appendInstallLog('backup:delete_failed', {
        appId: input?.appId,
        backupId: input?.backupId,
        detail: diagnostic.technicalCode,
        error: serializeErrorForInstallLog(error),
      });
      return {
        success: false,
        userMessage: 'No pudimos eliminar ese respaldo.',
        ...diagnostic,
      };
    }
  });

  ipcMain.handle(IPC_CHANNELS.restoreBackup, async (_event, input: { appId: string; backupId: string }) => {
    try {
      return await getBackupsManager().restoreBackup(input);
    } catch (error) {
      const diagnostic = failureDiagnostic(error, 'backup_restore_failed');
      await appendInstallLog('backup:restore_failed', {
        appId: input?.appId,
        backupId: input?.backupId,
        detail: diagnostic.technicalCode,
        error: serializeErrorForInstallLog(error),
      });
      return {
        success: false,
        userMessage: 'No pudimos restaurar ese respaldo.',
        ...diagnostic,
      };
    }
  });

  ipcMain.handle(IPC_CHANNELS.listRemoteBackups, async (_event, appId?: string) => {
    if (!forgerBackendClient || !canUseCloudDataSync()) {
      return { backups: [], usage: { usedBytes: 0, limitBytes: 0, backupCount: 0, backupCountLimit: 0 } };
    }
    return await forgerBackendClient.listRemoteBackups(appId);
  });

  ipcMain.handle(IPC_CHANNELS.createRemoteBackup, async (_event, input: CreateRemoteAppBackupInput) => {
    try {
      return await createRemoteAppBackup(input);
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'remote_backup_create_failed';
      await appendInstallLog('remote_backup:create_failed', {
        appId: input?.appId,
        detail,
        error: serializeErrorForInstallLog(error),
      });
      return {
        success: false,
        userMessage: 'No pudimos subir el respaldo a Forger Cloud.',
        technicalCode: detail,
      };
    }
  });

  ipcMain.handle(IPC_CHANNELS.deleteRemoteBackup, async (_event, remoteBackupId: number) => {
    return forgerBackendClient && canUseCloudDataSync()
      ? await forgerBackendClient.deleteRemoteBackup(remoteBackupId)
      : { success: false, userMessage: 'Forger Cloud Sync requiere una cuenta demo o pro.', technicalCode: 'subscription_required' };
  });

  ipcMain.handle(IPC_CHANNELS.restoreRemoteBackup, async (_event, input: { remoteBackupId: number }) => {
    try {
      return await restoreRemoteAppBackup(input.remoteBackupId);
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'remote_backup_restore_failed';
      await appendInstallLog('remote_backup:restore_failed', {
        remoteBackupId: input?.remoteBackupId,
        detail,
        error: serializeErrorForInstallLog(error),
      });
      return {
        success: false,
        userMessage: 'No pudimos restaurar el respaldo cloud.',
        technicalCode: detail,
      };
    }
  });

  ipcMain.handle(IPC_CHANNELS.getCloudSyncSettings, async () => state.cloudSyncSettings);
  ipcMain.handle(IPC_CHANNELS.setAppAutoSync, async (_event, appId: string, autoSync: boolean) => {
    return await setAppAutoSyncSetting(appId, autoSync);
  });

  ipcMain.handle(IPC_CHANNELS.restoreAppUserVersion, async (_event, appId: string) => {
    return await restoreAppUserVersionRuntime(appId);
  });

  ipcMain.handle(IPC_CHANNELS.resolveAppUpdateConflict, async (_event, appId: string) => {
    const record = registry.apps[appId];
    if (!record?.pendingUpdate || record.status !== 'conflict') {
      return {
        success: false,
        userMessage: 'No hay una actualizacion en conflicto para resolver.',
        technicalCode: 'no_pending_update_conflict',
      };
    }
    if (!chatOrchestrator) {
      return {
        success: false,
        userMessage: 'El agente no esta disponible para resolver el conflicto.',
        technicalCode: 'chat_orchestrator_unavailable',
      };
    }
    const prompt = buildCodexPromptWithAppContext({
      appId,
      displayName: resolveSelectedAppDisplayName(appId),
      userLanguage: 'not configured',
      officialToolsContext: await buildForgerToolsContextForApp(appId),
      userPrompt:
        'Resolve this app update conflict. Preserve as much as possible from both the new version and the user customizations. If something cannot be integrated maintainably, leave that part out and explain it in functional terms. Finish the merge and leave a saved version.',
      sharedFilesRootName: path.basename(getPrivateDataRoot()),
      sharedFiles: [],
    });
    return await chatOrchestrator.startRun({
      appId,
      prompt,
      dangerMode: true,
    });
  });

  ipcMain.handle(IPC_CHANNELS.uninstallApp, async (_event, appId: string) => {
    return await uninstallAppRuntime(appId);
  });

  ipcMain.handle(IPC_CHANNELS.getAppDetails, async (_event, appId: string) => {
    return await getAppDetails(appId);
  });

  ipcMain.handle(IPC_CHANNELS.listAppPrompts, async (_event, appId: string) => {
    return await listAppPrompts(appId);
  });

  ipcMain.handle(IPC_CHANNELS.validateAppPrompt, async (_event, input: AppPromptReviewInput) => {
    return await validateAppPrompt(input);
  });

  ipcMain.handle(IPC_CHANNELS.updateAppPrompt, async (_event, input: AppPromptReviewInput) => {
    return await updateAppPrompt(input);
  });

  ipcMain.handle(IPC_CHANNELS.restoreAppPrompt, async (_event, input: AppPromptRestoreInput) => {
    return await restoreAppPrompt(input);
  });

  ipcMain.handle(IPC_CHANNELS.installWelcome, async (_event, appId: string, userLanguage?: string) => {
    return await installWelcome(appId, userLanguage);
  });

  ipcMain.handle(IPC_CHANNELS.openApp, async (_event, appId: string, locale?: string) => {
    return await openInstalledApp(appId, locale);
  });

  ipcMain.handle(IPC_CHANNELS.stopApp, async (_event, appId: string) => {
    return await stopInstalledApp(appId);
  });

  ipcMain.handle(IPC_CHANNELS.getAppRuntimeStatus, async (_event, appId: string) => {
    return getRuntimeStatus(appId);
  });

  ipcMain.handle(IPC_CHANNELS.getAppSecrets, async (_event, appId: string) => {
    return await buildAppSecretsState(appId);
  });

  ipcMain.handle(IPC_CHANNELS.listUserSecrets, async () => {
    return await getSecretsStore().listUserSecrets();
  });

  ipcMain.handle(IPC_CHANNELS.createUserSecret, async (_event, input: CreateUserSecretInput) => {
    return await getSecretsStore().createUserSecret(input);
  });

  ipcMain.handle(IPC_CHANNELS.updateUserSecret, async (_event, input: UpdateUserSecretInput) => {
    return await getSecretsStore().updateUserSecret(input);
  });

  ipcMain.handle(IPC_CHANNELS.deleteUserSecret, async (_event, input: DeleteUserSecretInput) => {
    return await getSecretsStore().deleteUserSecret(input.id);
  });

  ipcMain.handle(IPC_CHANNELS.connectAppSecret, async (_event, input: ConnectAppSecretInput) => {
    const declarations = await resolveInstalledAppSecrets(input.appId);
    if (!declarations.some((secret) => secret.name === input.appSecretName)) {
      return {
        success: false,
        userMessage: 'La app no declara ese secreto.',
        technicalCode: 'app_secret_not_declared',
      };
    }
    return await getSecretsStore().connectAppSecret(input.appId, input.appSecretName, input.userSecretId);
  });

  ipcMain.handle(IPC_CHANNELS.disconnectAppSecret, async (_event, input: DisconnectAppSecretInput) => {
    return await getSecretsStore().disconnectAppSecret(input.appId, input.appSecretName);
  });

  ipcMain.handle(IPC_CHANNELS.getSettings, async () => state.settings);
  ipcMain.handle(IPC_CHANNELS.updateCodexDefaults, async (_event, input: UpdateCodexDefaultsInput) => {
    return await updateCodexDefaults(input);
  });
  ipcMain.handle(IPC_CHANNELS.updateAgentDefaults, async (_event, input: UpdateAgentDefaultsInput) => {
    return await updateAgentDefaults(input);
  });
  ipcMain.handle(IPC_CHANNELS.memoryList, async (_event, input: MemoryListInput = {}) => {
    return await getMemoryStore().list(input, { caller: 'state.settings' });
  });
  ipcMain.handle(IPC_CHANNELS.memoryCreate, async (_event, input: MemoryCreateInput) => {
    return await getMemoryStore().create({ ...input, source: 'state.settings' }, { caller: 'state.settings' });
  });
  ipcMain.handle(IPC_CHANNELS.memoryUpdate, async (_event, input: MemoryUpdateInput) => {
    return await getMemoryStore().update(input, { caller: 'state.settings' });
  });
  ipcMain.handle(IPC_CHANNELS.memoryDelete, async (_event, id: string) => {
    return await getMemoryStore().delete(id, { caller: 'state.settings' });
  });
  ipcMain.handle(IPC_CHANNELS.getDesktopUpdateState, async () => getDesktopUpdater().getState());
  ipcMain.handle(IPC_CHANNELS.checkDesktopUpdates, async () => await getDesktopUpdater().check());
  ipcMain.handle(IPC_CHANNELS.downloadDesktopUpdate, async () => await getDesktopUpdater().download());
  ipcMain.handle(IPC_CHANNELS.installDesktopUpdate, async () => await getDesktopUpdater().install());
  ipcMain.handle(IPC_CHANNELS.getForgerAccount, async () => publicForgerAccount(state.forgerAccount));
  ipcMain.handle(IPC_CHANNELS.registerForgerAccount, async (_event, input: ForgerAccountRegisterInput) => {
    return forgerBackendClient
      ? await forgerBackendClient.registerAccount(input)
      : { success: false, authenticated: false, userMessage: 'No pudimos crear la cuenta.', technicalCode: 'backend_client_missing' };
  });
  ipcMain.handle(IPC_CHANNELS.loginForgerAccount, async (_event, input: ForgerAccountLoginInput) => {
    const result = forgerBackendClient
      ? await forgerBackendClient.loginAccount(input)
      : { success: false, authenticated: false, userMessage: 'No pudimos iniciar sesion.', technicalCode: 'backend_client_missing' };
    if (result.success) {
      await switchForgerAccountSession(result, { userMessage: result.userMessage, technicalCode: result.technicalCode });
    }
    state.catalogApps = await listCatalogFromBackend();
    return { ...publicForgerAccount(state.forgerAccount), success: result.success, userMessage: result.userMessage, technicalCode: result.technicalCode };
  });
  ipcMain.handle(IPC_CHANNELS.updateForgerAccountProfile, async (_event, input: ForgerAccountProfileInput) => {
    const result = forgerBackendClient
      ? await forgerBackendClient.updateAccountProfile(input)
      : { success: false, authenticated: Boolean(state.forgerAccount.token), userMessage: 'No pudimos actualizar tu perfil.', technicalCode: 'backend_client_missing' };
    if (result.success) {
      await switchForgerAccountSession({ ...state.forgerAccount, ...result, token: state.forgerAccount.token }, {
        userMessage: result.userMessage,
        technicalCode: result.technicalCode,
      });
    }
    return { ...publicForgerAccount(state.forgerAccount), success: result.success, userMessage: result.userMessage, technicalCode: result.technicalCode };
  });
  ipcMain.handle(IPC_CHANNELS.logoutForgerAccount, async () => {
    await forgerBackendClient?.logoutAccount().catch(() => undefined);
    const account = await switchForgerAccountSession({ authenticated: false });
    state.catalogApps = await listCatalogFromBackend();
    return { ...account, success: true };
  });
  ipcMain.handle(IPC_CHANNELS.getCloudDevices, async () => {
    return cloudDeviceManager ? await cloudDeviceManager.getState() : { devices: [], connected: false };
  });
  ipcMain.handle(IPC_CHANNELS.generateDevicePairingCode, async () => {
    return cloudDeviceManager
      ? await cloudDeviceManager.generatePairingCode()
      : { devices: [], connected: false, success: false, userMessage: 'No pudimos preparar este equipo.', technicalCode: 'cloud_device_manager_missing' };
  });
  ipcMain.handle(IPC_CHANNELS.listFriends, async () => {
    return forgerBackendClient ? await forgerBackendClient.listFriends() : [];
  });
  ipcMain.handle(IPC_CHANNELS.searchFriends, async (_event, username: string) => {
    return forgerBackendClient ? await forgerBackendClient.searchFriends(username) : [];
  });
  ipcMain.handle(IPC_CHANNELS.sendFriendRequest, async (_event, username: string) => {
    if (!forgerBackendClient) throw new Error('backend_client_missing');
    return await forgerBackendClient.sendFriendRequest(username);
  });
  ipcMain.handle(IPC_CHANNELS.acceptFriendRequest, async (_event, id: number) => {
    if (!forgerBackendClient) throw new Error('backend_client_missing');
    return await forgerBackendClient.acceptFriendRequest(id);
  });
  ipcMain.handle(IPC_CHANNELS.declineFriendRequest, async (_event, id: number) => {
    if (!forgerBackendClient) throw new Error('backend_client_missing');
    return await forgerBackendClient.declineFriendRequest(id);
  });
  ipcMain.handle(IPC_CHANNELS.cancelFriendRequest, async (_event, id: number) => {
    if (!forgerBackendClient) throw new Error('backend_client_missing');
    return await forgerBackendClient.cancelFriendRequest(id);
  });
  ipcMain.handle(IPC_CHANNELS.markFriendChatRead, async (_event, friendUserId: number) => {
    if (!forgerBackendClient) throw new Error('backend_client_missing');
    const friendship = await forgerBackendClient.markFriendChatRead(friendUserId);
    forwardCloudSocialEvent({ type: 'friendship_changed', friendship });
    return friendship;
  });
  ipcMain.handle(IPC_CHANNELS.openFriendChatWindow, async (_event, friendship: CloudFriendship) => {
    return await openOrFocusFriendChatWindow(friendship);
  });
  ipcMain.handle(IPC_CHANNELS.listCloudMessages, async (_event, friendUserId: number) => {
    return forgerBackendClient ? await decryptCloudMessages(await forgerBackendClient.listCloudMessages(friendUserId)) : [];
  });
  ipcMain.handle(IPC_CHANNELS.sendCloudMessage, async (_event, input: CloudSendMessageInput) => {
    return await sendEncryptedCloudMessage(input);
  });
  ipcMain.handle(IPC_CHANNELS.decideAppMessagePermission, async (_event, cloudMessageId: number, decision: CloudAppMessagePermissionDecision) => {
    if (!forgerBackendClient) throw new Error('backend_client_missing');
    return await decryptCloudMessage(await forgerBackendClient.decideAppMessagePermission(cloudMessageId, decision));
  });
  ipcMain.handle(IPC_CHANNELS.getCloudIdentity, async () => await getCloudIdentityStore().getSummary());
  ipcMain.handle(IPC_CHANNELS.revealCloudSecretKey, async () => await getCloudIdentityStore().revealSecretKey());
  ipcMain.handle(IPC_CHANNELS.regenerateCloudSecretKey, async () => {
    const identity = await getCloudIdentityStore().regenerate();
    await cloudDeviceManager?.start();
    return identity;
  });
  ipcMain.handle(IPC_CHANNELS.submitAppRating, async (_event, input: SubmitAppRatingInput) => {
    const result = forgerBackendClient
      ? await forgerBackendClient.submitAppRating(input)
      : { success: false, userMessage: 'No pudimos guardar tu review.', technicalCode: 'backend_client_missing' };
    state.catalogApps = await listCatalogFromBackend();
    return result;
  });
  ipcMain.handle(IPC_CHANNELS.submitProductFeedback, async (_event, input: SubmitProductFeedbackInput) => {
    return forgerBackendClient
      ? await forgerBackendClient.submitProductFeedback(input)
      : { success: false, userMessage: 'No pudimos enviar el feedback.', technicalCode: 'backend_client_missing' };
  });
  ipcMain.handle(IPC_CHANNELS.submitUsageEvent, async (_event, input: SubmitUsageEventInput) => {
    const eventInput: SubmitUsageEventInput = {
      ...input,
      desktopVersion: input.desktopVersion || app.getVersion(),
      platform: input.platform || process.platform,
      occurredAt: input.occurredAt || new Date().toISOString(),
    };
    return forgerBackendClient
      ? await forgerBackendClient.submitUsageEvent(eventInput)
      : { success: false, userMessage: 'No pudimos enviar la métrica de uso.', technicalCode: 'backend_client_missing' };
  });
  ipcMain.handle(IPC_CHANNELS.submitDesktopErrorReport, async (_event, input: DesktopErrorReportPreview) => {
    const report: DesktopErrorReportPreview = {
      ...input,
      desktopVersion: input.desktopVersion || app.getVersion(),
      platform: process.platform,
      arch: process.arch,
      occurredAt: input.occurredAt || new Date().toISOString(),
    };
    return forgerBackendClient
      ? await forgerBackendClient.submitDesktopErrorReport(report)
      : { success: false, userMessage: 'No pudimos enviar el reporte.', technicalCode: 'backend_client_missing' };
  });
  ipcMain.handle(IPC_CHANNELS.openExternalUrl, async (_event, targetUrl: string) => {
    try {
      const parsed = new URL(targetUrl);
      if (parsed.protocol !== 'https:') {
        return { success: false, userMessage: 'No pudimos abrir ese enlace.', technicalCode: 'unsupported_url_protocol' };
      }

      await shell.openExternal(parsed.toString());
      return { success: true };
    } catch (error) {
      return { success: false, userMessage: 'No pudimos abrir ese enlace.', ...failureDiagnostic(error, 'open_external_url_failed') };
    }
  });
  ipcMain.handle(IPC_CHANNELS.getCodexAuthStatus, async () => await getCodexAuthStatus());
  ipcMain.handle(IPC_CHANNELS.openCodexUsageDashboard, async () => {
    try {
      await shell.openExternal(CODEX_USAGE_DASHBOARD_URL);
      return { success: true };
    } catch (error) {
      return { success: false, ...failureDiagnostic(error, 'open_codex_usage_failed'), userMessage: 'No pudimos abrir el panel de uso de Codex.' };
    }
  });
  ipcMain.handle(IPC_CHANNELS.connectCodexAuth, async () => await connectCodexAuth());
  ipcMain.handle(IPC_CHANNELS.disconnectCodexAuth, async () => await disconnectCodexAuth());
  ipcMain.handle(IPC_CHANNELS.reinstallCodex, async () => await reinstallCodex());
  ipcMain.handle(IPC_CHANNELS.getClaudeAuthStatus, async () => await getClaudeAuthStatus());
  ipcMain.handle(IPC_CHANNELS.connectClaudeAuth, async () => await connectClaudeAuth());
  ipcMain.handle(IPC_CHANNELS.reinstallClaude, async () => await reinstallClaude());
  ipcMain.handle(IPC_CHANNELS.listAgentTools, async () => AGENT_TOOL_PACKAGES);
  ipcMain.handle(IPC_CHANNELS.getAgentToolSettings, async () => state.agentToolSettings);
  ipcMain.handle(IPC_CHANNELS.updateAgentToolApproval, async (_event, input: UpdateAgentToolApprovalInput) => {
    return await updateAgentToolApproval(input);
  });
  ipcMain.handle(IPC_CHANNELS.listOfficialTools, async (_event, locale?: string) => await getOfficialToolsService().list(locale));
  ipcMain.handle(IPC_CHANNELS.refreshOfficialTools, async (_event, locale?: string) => await getOfficialToolsService().refresh(locale));
  ipcMain.handle(IPC_CHANNELS.activateOfficialTool, async (_event, toolId: string, locale?: string) => {
    return await getOfficialToolsService().activate(toolId, locale);
  });
  ipcMain.handle(IPC_CHANNELS.configureOfficialTool, async (_event, input: ConfigureOfficialToolInput) => {
    return await getOfficialToolsService().configure(input);
  });
  ipcMain.handle(IPC_CHANNELS.deactivateOfficialTool, async (_event, toolId: string, locale?: string) => {
    return await getOfficialToolsService().deactivate(toolId, { locale });
  });
  ipcMain.handle(IPC_CHANNELS.getAppToolsInstallGate, async (_event, appId: string, locale?: string): Promise<AppToolsInstallGate | null> => {
    return await getOfficialToolsService().getInstallGate(appId, locale);
  });
  ipcMain.handle(IPC_CHANNELS.setAppToolGrant, async (_event, input: SetAppToolGrantInput, locale?: string): Promise<AppToolsInstallGate | null> => {
    return await getOfficialToolsService().setAppToolGrant(input, locale);
  });
  ipcMain.handle(IPC_CHANNELS.chatStartRun, async (_event, input: ChatStartRunInput) => {
    if (!chatOrchestrator) {
      return { runId: '', status: 'failed' };
    }
    const dataRootReal = await fs.realpath(getPrivateDataRoot()).catch(async () => {
      await fs.mkdir(getPrivateDataRoot(), { recursive: true });
      return fs.realpath(getPrivateDataRoot());
    });
    const sharedFiles: SharedFileRef[] = [];
    for (const fileRef of input.sharedFiles ?? []) {
      const candidatePath = path.isAbsolute(fileRef.path) ? fileRef.path : path.join(getPrivateDataRoot(), fileRef.path);
      const realPath = await fs.realpath(candidatePath).catch(() => null);
      if (!realPath || !ensurePathInside(dataRootReal, realPath)) {
        continue;
      }
      sharedFiles.push({ ...fileRef, path: realPath });
    }
    const sharedPromptFiles = sharedFiles.map((fileRef) => ({
      name: fileRef.name ?? path.basename(fileRef.path),
      relativePath: toPosixRelativePath(fileRef.relativePath ?? path.relative(getPrivateDataRoot(), fileRef.path)),
      sizeBytes: fileRef.sizeBytes ?? 0,
      modifiedAt: fileRef.modifiedAt ?? '',
      source: fileRef.source ?? 'mentioned',
    }));
    const enrichedPrompt = input.appId
      ? buildCodexPromptWithAppContext({
          appId: input.appId,
          displayName: resolveSelectedAppDisplayName(input.appId),
          userPrompt: input.prompt,
          userLanguage: input.userLanguage,
          officialToolsContext: await buildForgerToolsContextForApp(input.appId),
          sharedFilesRootName: path.basename(getPrivateDataRoot()),
          sharedFiles: sharedPromptFiles,
        })
      : buildCodexPromptForFreeChat({
          userPrompt: input.prompt,
          userLanguage: input.userLanguage,
          officialToolsContext: await buildForgerToolsContextForFreeChat(),
          sharedFilesRootName: path.basename(getPrivateDataRoot()),
          sharedFiles: sharedPromptFiles,
        });
    return await chatOrchestrator.startRun({
      ...input,
      appId: input.appId ?? null,
      prompt: enrichedPrompt,
      sharedFiles,
    });
  });
  ipcMain.handle(IPC_CHANNELS.chatGetRun, async (_event, input: ChatGetRunInput) => {
    if (!chatOrchestrator) {
      return null;
    }
    return chatOrchestrator.getRun(input);
  });
  ipcMain.handle(IPC_CHANNELS.chatCancelRun, async (_event, input: ChatCancelRunInput) => {
    if (!chatOrchestrator) {
      return { success: false };
    }
    return chatOrchestrator.cancelRun(input);
  });
  ipcMain.handle(
    IPC_CHANNELS.chatApprovePermission,
    async (_event, input: ChatApprovePermissionInput) => {
      if (!chatOrchestrator) {
        return { success: false };
      }
      return chatOrchestrator.approvePermission(input);
    },
  );
  ipcMain.handle(IPC_CHANNELS.chatApplyRun, async (_event, input: ChatApplyRunInput) => {
    if (!chatOrchestrator) {
      return { success: false, technicalCode: 'chat_orchestrator_unavailable' };
    }
    return await chatOrchestrator.applyRun(input);
  });
  ipcMain.handle(IPC_CHANNELS.chatUndo, async (_event, input: ChatUndoInput) => {
    if (!chatOrchestrator) {
      return { success: false, technicalCode: 'chat_orchestrator_unavailable' };
    }
    return await chatOrchestrator.undo(input);
  });
  ipcMain.handle(IPC_CHANNELS.chatTrace, async (_event, input: RendererChatTraceEvent) => {
    if (!input || !RENDERER_CHAT_TRACE_EVENTS.has(input.event)) {
      return { success: false };
    }
    await appendInstallLog('chat_renderer_trace', sanitizeRendererChatTrace(input));
    return { success: true };
  });

  ipcMain.handle(IPC_CHANNELS.filesPickForChat, async () => {
    const options: Electron.OpenDialogOptions = {
      properties: ['openFile', 'multiSelections'],
    };
    const result = mainWindow && !mainWindow.isDestroyed()
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options);
    if (result.canceled) {
      return [];
    }
    return await getFileLibrary().pickFileInfo(result.filePaths);
  });
  ipcMain.handle(IPC_CHANNELS.filesStageForChat, async (_event, input: FilesStageForChatInput) => {
    return await getFileLibrary().stageFileForChat(input);
  });
  ipcMain.handle(IPC_CHANNELS.filesDiscardStagedForChat, async (_event, input: FilesDiscardStagedForChatInput) => {
    return await getFileLibrary().discardStagedFilesForChat(input);
  });
  ipcMain.handle(IPC_CHANNELS.filesList, async (_event, input?: FilesListInput) => {
    return await getFileLibrary().list(input ?? {});
  });
  ipcMain.handle(IPC_CHANNELS.filesListCategories, async () => {
    return await getFileLibrary().listCategories();
  });
  ipcMain.handle(IPC_CHANNELS.filesCreateCategory, async (_event, input: FilesCreateCategoryInput) => {
    return await getFileLibrary().createCategory(input);
  });
  ipcMain.handle(IPC_CHANNELS.filesRenameCategory, async (_event, input: FilesRenameCategoryInput) => {
    return await getFileLibrary().renameCategory(input);
  });
  ipcMain.handle(IPC_CHANNELS.filesDeleteCategory, async (_event, input: FilesDeleteCategoryInput) => {
    return await getFileLibrary().deleteCategory(input);
  });
  ipcMain.handle(IPC_CHANNELS.filesImport, async (_event, input: FilesImportInput) => {
    return await getFileLibrary().importFiles(input);
  });
  ipcMain.handle(IPC_CHANNELS.filesMove, async (_event, input: FilesMoveInput) => {
    return await getFileLibrary().moveFiles(input);
  });
  ipcMain.handle(IPC_CHANNELS.filesRename, async (_event, input: FilesRenameInput) => {
    return await getFileLibrary().renameFile(input);
  });
  ipcMain.handle(IPC_CHANNELS.filesDelete, async (_event, input: FilesDeleteInput) => {
    return await getFileLibrary().deleteFiles(input);
  });

  ipcMain.handle(IPC_CHANNELS.appSelectExternalFolder, async (event): Promise<AppExternalFolderSelection> => {
    const appId = resolveAppIdForWebContents(event.sender.id);
    if (!appId) {
      throw new Error('app_window_not_authorized');
    }

    const ownerWindow = BrowserWindow.fromWebContents(event.sender);
    const options: Electron.OpenDialogOptions = {
      properties: ['openDirectory'],
    };
    const result = ownerWindow && !ownerWindow.isDestroyed()
      ? await dialog.showOpenDialog(ownerWindow, options)
      : await dialog.showOpenDialog(options);
    if (result.canceled || result.filePaths.length === 0) {
      return { canceled: true };
    }

    const selectedPath = await fs.realpath(result.filePaths[0]);
    return signAppFolderGrant(appId, selectedPath);
  });

  ipcMain.handle(IPC_CHANNELS.appAiSubscriptionStatus, async (event) => {
    const appId = resolveAppIdForWebContents(event.sender.id);
    if (!appId) {
      throw new Error('app_window_not_authorized');
    }
    const status = await getCodexAuthStatus();
    return { connected: status.authenticated };
  });

  ipcMain.handle(IPC_CHANNELS.appGetContext, async (event) => {
    const appId = resolveAppIdForWebContents(event.sender.id);
    if (!appId) {
      return {};
    }
    const record = registry.apps[appId];
    const manifest = record?.installDir ? await resolveInstalledManifest(record.installDir) : null;
    return {
      agents: await resolveInstalledAgents(appId),
      agentDefaults: normalizeManifestAgentDefaults(manifest),
      agentModelOptions: {
        codex: APP_CODEX_MODEL_OPTIONS,
        claude: APP_CLAUDE_MODEL_OPTIONS,
      },
    };
  });

  ipcMain.handle(IPC_CHANNELS.appToolsListAvailable, async (event) => {
    const appId = resolveAppIdForWebContents(event.sender.id);
    if (!appId) {
      throw new Error('app_window_not_authorized');
    }
    return await getOfficialToolsService().listToolsForApp(appId);
  });

  ipcMain.handle(IPC_CHANNELS.appToolsGetStatus, async (event, toolId: string) => {
    const appId = resolveAppIdForWebContents(event.sender.id);
    if (!appId) {
      throw new Error('app_window_not_authorized');
    }
    const available = await getOfficialToolsService().listToolsForApp(appId);
    return available.find((tool) => tool.id === toolId) ?? null;
  });

  ipcMain.handle(IPC_CHANNELS.appToolsCall, async (event, input: CallOfficialToolInput) => {
    const appId = resolveAppIdForWebContents(event.sender.id);
    if (!appId) {
      throw new Error('app_window_not_authorized');
    }
    return await getOfficialToolsService().callFromApp(appId, input);
  });

  ipcMain.handle(IPC_CHANNELS.appMessagesSend, async (event, input: CloudSendMessageInput) => {
    const appId = resolveAppIdForWebContents(event.sender.id);
    if (!appId) {
      throw new Error('app_window_not_authorized');
    }
    const record = registry.apps[appId];
    const manifest = record?.installDir ? await resolveInstalledManifest(record.installDir) : null;
    if (manifest?.cloudMessaging?.enabled !== true) {
      throw new Error('app_cloud_messaging_not_declared');
    }
    return await sendEncryptedCloudMessage({
      ...input,
      delivery: input.delivery ?? manifest.cloudMessaging.defaultDelivery ?? 'persistent',
      source: 'app',
      sourceAppId: appId,
      sourceAppName: record?.name ?? appId,
    });
  });

  ipcMain.handle(IPC_CHANNELS.appMessagesList, async (event, friendUserId: number) => {
    const appId = resolveAppIdForWebContents(event.sender.id);
    if (!appId) {
      throw new Error('app_window_not_authorized');
    }
    const record = registry.apps[appId];
    const manifest = record?.installDir ? await resolveInstalledManifest(record.installDir) : null;
    if (manifest?.cloudMessaging?.enabled !== true) {
      throw new Error('app_cloud_messaging_not_declared');
    }
    return forgerBackendClient ? await decryptCloudMessages(await forgerBackendClient.listCloudMessages(friendUserId)) : [];
  });
};
