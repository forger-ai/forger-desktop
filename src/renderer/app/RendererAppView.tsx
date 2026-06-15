import {
  Box,
  Button,
  Chip,
  CssBaseline,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  Link,
  Stack,
  Switch,
  ThemeProvider,
  Tooltip,
  Typography,
} from '@mui/material';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { AudioRuntimeBrokerRequest, AudioRuntimeDevices, BackgroundTask, CatalogApp, ClaudeEffort, CodexReasoningEffort, WakeWordState } from '@shared/types';
import { AppShell } from '@renderer/components/AppShell';
import { AppCard } from '@renderer/components/AppCard';
import { AppsGrid } from '@renderer/components/AppsGrid';
import { isOpenableError, isRetryableInstallError, isUpdateError } from '@renderer/app-error-actions';
import { AppView } from '@renderer/views/AppView';
import { AgentsView } from '@renderer/views/AgentsView';
import { AutomationsView } from '@renderer/views/AutomationsView';
import { BackupsView } from '@renderer/views/BackupsView';
import { BackgroundTaskDetailView, BackgroundTasksListView, viewLabel } from '@renderer/views/BackgroundTasksView';
import { CatalogView } from '@renderer/views/CatalogView';
import { ChatView } from '@renderer/views/ChatView';
import { CreateView } from '@renderer/views/CreateView';
import { DataView } from '@renderer/views/DataView';
import { DevicesView } from '@renderer/views/DevicesView';
import { DocsView } from '@renderer/views/DocsView';
import { FeedbackView } from '@renderer/views/FeedbackView';
import { FilesView } from '@renderer/views/FilesView';
import { FriendChatWindowView } from '@renderer/views/FriendChatWindowView';
import { SocialView } from '@renderer/views/SocialView';
import { SettingsView } from '@renderer/views/SettingsView';
import { SecretsView } from '@renderer/views/SecretsView';
import { ToolsView } from '@renderer/views/ToolsView';
import {
  AGENT_PROVIDER_OPTIONS,
  CHAT_BOT_PICTURE_OPTIONS,
  CLAUDE_EFFORT_OPTIONS,
  CLAUDE_MODEL_OPTIONS,
  CODEX_MODEL_OPTIONS,
  CODEX_REASONING_OPTIONS,
} from '@renderer/preferences';
import { TourOverlay } from '@renderer/tour/TourOverlay';
import { useForgerTour } from '@renderer/tour/useForgerTour';
import { appExecutionTooltip } from '@renderer/app-execution-labels';
import { RendererAppDialogs } from './RendererAppDialogs';
import { LocalNetworkShareDialog } from '@renderer/components/LocalNetworkShareDialog';
import { WakeWordClientRunner } from '@renderer/services/WakeWordClientRunner';

interface RendererAppViewProps {
  controller: Record<string, any>;
}

const platformSupportsSystemAudioCapture = (): boolean =>
  typeof navigator !== 'undefined' && /Mac|Win|Linux/.test(navigator.platform);

const enumerateAudioRuntimeDevices = async (): Promise<AudioRuntimeDevices> => {
  if (!navigator.mediaDevices?.enumerateDevices) {
    return { inputDevices: [], outputDevices: [] };
  }
  let devices = await navigator.mediaDevices.enumerateDevices();
  if (devices.some((device) => (device.kind === 'audioinput' || device.kind === 'audiooutput') && !device.label)) {
    const probe = await navigator.mediaDevices.getUserMedia({ audio: true }).catch(() => null);
    probe?.getTracks().forEach((track) => track.stop());
    devices = await navigator.mediaDevices.enumerateDevices();
  }
  const inputDevices = devices
    .filter((device) => device.kind === 'audioinput')
    .map((device, index) => ({
      id: device.deviceId || `audioinput-${index}`,
      label: device.label || (index === 0 ? 'Default microphone' : `Microphone ${index + 1}`),
      kind: 'microphone' as const,
      ...(device.groupId ? { groupId: device.groupId } : {}),
      default: index === 0 || device.deviceId === 'default',
      supported: true,
    }));
  const systemAudioDevices = platformSupportsSystemAudioCapture()
    ? [{
      id: 'system-audio:default',
      label: 'System audio',
      kind: 'system_audio' as const,
      default: inputDevices.length === 0,
      supported: true,
      requiresDisplayCapture: true,
    }]
    : [];
  const outputDevices = devices
    .filter((device) => device.kind === 'audiooutput')
    .map((device, index) => ({
      id: device.deviceId || `audiooutput-${index}`,
      label: device.label || (index === 0 ? 'Default speaker' : `Speaker ${index + 1}`),
      kind: 'speaker' as const,
      ...(device.groupId ? { groupId: device.groupId } : {}),
      default: index === 0 || device.deviceId === 'default',
      supported: true,
    }));
  return {
    inputDevices: [...inputDevices, ...systemAudioDevices],
    outputDevices: outputDevices.length > 0 ? outputDevices : [{
      id: 'default',
      label: 'Default speaker',
      kind: 'speaker',
      default: true,
      supported: true,
    }],
  };
};

const decodeAudioDataUrl = (audioDataBase64: string, mimeType: string): string => {
  const raw = atob(audioDataBase64);
  const bytes = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index += 1) {
    bytes[index] = raw.charCodeAt(index);
  }
  return URL.createObjectURL(new Blob([bytes], { type: mimeType || 'audio/wav' }));
};

const playRuntimeAudio = async (
  activePlaybacks: Map<string, HTMLAudioElement>,
  input: Extract<AudioRuntimeBrokerRequest, { type: 'play_audio' }>,
): Promise<{ success: boolean; durationSeconds?: number; error?: string }> => {
  const objectUrl = decodeAudioDataUrl(input.audioDataBase64, input.mimeType);
  const audio = new Audio(objectUrl);
  activePlaybacks.set(input.playbackId, audio);
  try {
    if (input.outputDeviceId && input.outputDeviceId !== 'default' && 'setSinkId' in audio) {
      await (audio as HTMLAudioElement & { setSinkId: (sinkId: string) => Promise<void> }).setSinkId(input.outputDeviceId).catch(() => undefined);
    }
    await new Promise<void>((resolve, reject) => {
      audio.onended = () => resolve();
      audio.onerror = () => reject(new Error('audio_playback_failed'));
      void audio.play().catch(reject);
    });
    return {
      success: true,
      ...(Number.isFinite(audio.duration) ? { durationSeconds: audio.duration } : {}),
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'audio_playback_failed',
    };
  } finally {
    activePlaybacks.delete(input.playbackId);
    URL.revokeObjectURL(objectUrl);
  }
};

export function RendererAppView({ controller }: RendererAppViewProps) {
  const audioRuntimePlaybacksRef = useRef<Map<string, HTMLAudioElement>>(new Map());
  const [settingsInitialSubview, setSettingsInitialSubview] = useState<'main' | 'llmProvider' | 'storage' | 'wakeWord' | null>(null);
  const {
    getDesktopApi,
    resetOnboarding,
    theme,
    socialChatWindowRoute,
    socialProfileUsername,
    setSocialProfileUsername,
    forgerAccount,
    currentView,
    setCurrentView,
    t,
    installedApps,
    selectedDataAppId,
    setSelectedDataAppId,
    getAppMeta,
    chatModeLabel,
    setCloudModalOpen,
    forgerAccountBusy,
    handleOpenFriendChat,
    handleOpenSocialApp,
    backgroundTasks,
    backgroundTasksDrawerOpen,
    activeBackgroundTaskCount,
    openBackgroundTaskHistory,
    openBackgroundTaskDetail,
    backFromBackgroundTaskHistory,
    backFromBackgroundTaskDetail,
    setBackgroundTasksDrawerOpen,
    backgroundTasksBackView,
    selectedBackgroundTaskId,
    setBannerSeverity,
    setBannerMessage,
    handleForgerLogout,
    desktopUpdateState,
    advancedMode,
    openingAppIds,
    getCategoryLabel,
    handleOpen,
    handleStartLocalNetworkShare,
    handleStartRemoteNetworkShare,
    handleStopLocalNetworkShare,
    handleStopRemoteNetworkShare,
    localNetworkShareDialogOpen,
    setLocalNetworkShareDialogOpen,
    localNetworkShareStatus,
    handleStop,
    handleRetry,
    handleUpdate,
    handleRestoreUserVersion,
    handleResolveConflict,
    openAppDetails,
    handleDeleteApp,
    handleCreateLocalApp,
    handleUploadSocial,
    createLocalAppBusy,
    installProgressByApp,
    catalogApps,
    refreshApps,
    catalogFilter,
    setCatalogFilter,
    catalogStatusFilter,
    setCatalogStatusFilter,
    handleInstall,
    earlyAccessEnabled,
    selectedAppDetails,
    selectedAppDetailsId,
    selectedAppToolGate,
    selectedAppToolGrantBusyId,
    handleAppDetailsToolGrant,
    appSecretsState,
    secretsBusy,
    settings,
    appDetailsBackView,
    handleConnectSecret,
    handleDisconnectSecret,
    handleSubmitRating,
    handleSubmitFeedback,
    usageAnalyticsEnabled,
    handleUsageAnalyticsChange,
    forumParticipation,
    forumPromptOpen,
    forumParticipationBusy,
    handleDismissForumPrompt,
    handleEnterForum,
    handleUpdateAppPrompt,
    handleRestoreAppPrompt,
    chatMessages,
    activeConversationId,
    chatHistoryItems,
    handleOpenConversation,
    handleDeleteConversation,
    handleStartNewConversation,
    handleOpenFreeChatFromWake,
    chatInput,
    setChatInput,
    handleSendMessage,
    pendingChatFiles,
    mentionedChatFiles,
    forgerFiles,
    fileCategories,
    uploadCategoryPath,
    setUploadCategoryPath,
    handlePickChatFiles,
    handleStagePastedChatFile,
    openCreateCategoryDialog,
    handleRemovePendingChatFile,
    handleMentionFile,
    setMentionedChatFileIds,
    activeConversation,
    selectedAgentProvider,
    resolvedChatProvider,
    setSelectedAgentProvider,
    selectedCodexModel,
    setSelectedCodexModel,
    selectedCodexReasoningEffort,
    setSelectedCodexReasoningEffort,
    selectedClaudeModel,
    setSelectedClaudeModel,
    selectedClaudeEffort,
    setSelectedClaudeEffort,
    selectedChatPermissionMode,
    setSelectedChatPermissionMode,
    selectedChatNetworkAccess,
    setSelectedChatNetworkAccess,
    chatBotPictureSrc,
    activeConversationRunActive,
    activeConversationRunId,
    activeConversationProgressLines,
    codexAuthStatus,
    claudeAuthStatus,
    handleStopChatRun,
    handleRespondPermission,
    handleRespondQuestion,
    prepareConversationDiagnosticReport,
    automations,
    selectedAutomationId,
    automationRuns,
    selectedAutomationRun,
    automationBusy,
    handleSaveAutomation,
    handleDeleteAutomation,
    handlePauseAutomation,
    handleResumeAutomation,
    handleRunAutomationNow,
    handleSelectAutomation,
    handleSelectAutomationRun,
    fileFilters,
    setFileFilters,
    openRenameCategoryDialog,
    handleDeleteCategory,
    openRenameFileDialog,
    openMoveFileDialog,
    handleDeleteFile,
    backups,
    remoteBackups,
    remoteBackupsUsage,
    cloudSyncSettings,
    backupsBusy,
    handleCreateBackup,
    handleSyncNow,
    handleDeleteBackup,
    handleDeleteRemoteBackup,
    handleRestoreBackup,
    handleRestoreRemoteBackup,
    handleSetAutoSync,
    openCloudUpsell,
    userSecrets,
    handleCreateSecret,
    handleUpdateSecret,
    handleDeleteSecret,
    agentToolPackages,
    agentToolSettings,
    officialTools,
    selectedToolsTool,
    agentToolBusyId,
    officialToolBusyId,
    agentToolError,
    agentToolErrorCode,
    setSelectedToolsTool,
    handleAgentToolApprovalChange,
    runOfficialToolAction,
    refreshOfficialTools,
    activeLocale,
    codexAuthBusy,
    claudeAuthBusy,
    themePreference,
    setThemePreference,
    languagePreference,
    systemLocale,
    setLanguagePreference,
    chatBotPicture,
    setChatBotPicture,
    handleAgentDefaultsChange,
    handleDeveloperModeChange,
    setCodexConfigOpen,
    handleReinstallCodex,
    setClaudeConfigOpen,
    handleReinstallClaude,
    cloudStorageUsage,
    cloudStorageBusy,
    refreshCloudStorageUsage,
    desktopUpdateBusy,
    runDesktopUpdateAction,
    memories,
    handleCreateMemory,
    handleUpdateMemory,
    handleDeleteMemory,
    cloudIdentity,
    setCloudIdentity,
    setEarlyAccessEnabled,
    setAdvancedMode,
    pendingInstallGate,
    cloudModalOpen,
    handleForgerUsernameUpdate,
    codexConfigOpen,
    claudeConfigOpen,
    agentProviderConfigOpen,
  } = controller;

  useEffect(() => {
    const api = getDesktopApi();
    return api.onAudioRuntimeBrokerRequest((request: AudioRuntimeBrokerRequest) => {
      void (async () => {
        try {
          if (request.type === 'list_devices') {
            await api.audioRuntimeBrokerRespond({ requestId: request.requestId, success: true, result: await enumerateAudioRuntimeDevices() });
            return;
          }
          if (request.type === 'play_audio') {
            await api.audioRuntimeBrokerRespond({
              requestId: request.requestId,
              success: true,
              result: await playRuntimeAudio(audioRuntimePlaybacksRef.current, request),
            });
            return;
          }
          if (request.type === 'cancel_playback') {
            const audio = audioRuntimePlaybacksRef.current.get(request.playbackId);
            if (audio) {
              audio.pause();
              audioRuntimePlaybacksRef.current.delete(request.playbackId);
            }
            await api.audioRuntimeBrokerRespond({ requestId: request.requestId, success: true, result: { success: true } });
          }
        } catch (error) {
          await api.audioRuntimeBrokerRespond({
            requestId: request.requestId,
            success: false,
            error: error instanceof Error ? error.message : 'audio_runtime_broker_failed',
          }).catch(() => undefined);
        }
      })();
    });
  }, [getDesktopApi]);
  const installedViewApps = useMemo<CatalogApp[]>(
    () =>
      installedApps.filter((app: CatalogApp) =>
        app.status === 'installed' ||
        app.status === 'running' ||
        app.status === 'error' ||
        app.status === 'conflict' ||
        app.status === 'installing'
      ),
    [installedApps],
  );

  const tour = useForgerTour({
    currentView,
    setCurrentView,
    t,
    socialChatWindowRoute,
    selectedToolsTool,
    setSelectedToolsTool,
    officialTools,
    codexAuthStatus,
    claudeAuthStatus,
    blocked: Boolean(codexConfigOpen || claudeConfigOpen || agentProviderConfigOpen || cloudModalOpen || pendingInstallGate),
  });
  const intelligenceProviderConfigured = codexAuthStatus.authenticated || claudeAuthStatus.authenticated;
  const codexProviderConfigured = codexAuthStatus.authenticated;

  useEffect(() => {
    const unsubscribe = getDesktopApi().onWakeWordDetected(() => {
      setCurrentView('chat');
      handleOpenFreeChatFromWake();
      setBannerSeverity('info');
      setBannerMessage(t.settings.wakeWordActivated);
    });
    return unsubscribe;
  }, [getDesktopApi, handleOpenFreeChatFromWake, setBannerMessage, setBannerSeverity, setCurrentView, t.settings.wakeWordActivated]);

  useEffect(() => {
    const api = getDesktopApi();
    const runner = new WakeWordClientRunner(api);
    const refresh = () => void api.wakeWordGetState()
      .then((state: WakeWordState) => runner.ensure(state))
      .catch((error: unknown) => {
        void api.wakeWordGetState()
          .then((state: WakeWordState) => {
            if (!state.config.enabled) return;
            const technicalCode = error instanceof Error && error.message ? error.message : 'wake_stream_failed';
            return api.wakeWordRecordUnavailable({
              modelId: state.config.modelId,
              technicalCode,
            });
          })
          .catch(() => undefined);
        runner.stop('refresh_failed');
      });
    refresh();
    const unsubscribe = api.onWakeWordChanged(() => refresh());
    const timer = window.setInterval(refresh, 2000);
    return () => {
      unsubscribe();
      window.clearInterval(timer);
      runner.dispose();
    };
  }, [getDesktopApi]);

  const openCodexSetup = () => {
    controller.setAgentProviderConfigOpen(false);
    setCodexConfigOpen(true);
  };
  const openClaudeSetup = () => {
    controller.setAgentProviderConfigOpen(false);
    setClaudeConfigOpen(true);
  };
  const openLlmProviderSettings = () => {
    setSettingsInitialSubview('llmProvider');
    setCurrentView('settings');
  };

  const renderAgentProviderCards = () => (
    <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} data-onboarding-target="agent-provider-actions">
      <Box
        component="button"
        type="button"
        onClick={openCodexSetup}
        sx={{
          flex: 1,
          appearance: 'none',
          textAlign: 'left',
          border: '1px solid',
          borderColor: codexAuthStatus.authenticated ? 'success.main' : 'divider',
          bgcolor: 'background.paper',
          borderRadius: 2,
          p: 2,
          cursor: 'pointer',
          color: 'text.primary',
          '&:hover': { borderColor: 'primary.main', bgcolor: 'action.hover' },
        }}
      >
        <Stack spacing={1}>
          <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={1}>
            <Typography fontWeight={700}>{t.agentProvider.codexTitle}</Typography>
            <Chip
              size="small"
              color={codexAuthStatus.authenticated ? 'success' : 'default'}
              label={codexAuthStatus.authenticated ? t.agentProvider.connected : t.agentProvider.notConnected}
            />
          </Stack>
          <Typography variant="body2" color="text.secondary">{t.agentProvider.codexBody}</Typography>
          <Typography variant="button" color="primary.main">{t.agentProvider.codexAction}</Typography>
        </Stack>
      </Box>
      <Box
        component="button"
        type="button"
        onClick={openClaudeSetup}
        sx={{
          flex: 1,
          appearance: 'none',
          textAlign: 'left',
          border: '1px solid',
          borderColor: claudeAuthStatus.authenticated ? 'success.main' : 'divider',
          bgcolor: 'background.paper',
          borderRadius: 2,
          p: 2,
          cursor: 'pointer',
          color: 'text.primary',
          '&:hover': { borderColor: 'primary.main', bgcolor: 'action.hover' },
        }}
      >
        <Stack spacing={1}>
          <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={1}>
            <Typography fontWeight={700}>{t.agentProvider.claudeTitle}</Typography>
            <Chip
              size="small"
              color={claudeAuthStatus.authenticated ? 'success' : 'default'}
              label={claudeAuthStatus.authenticated ? t.agentProvider.connected : t.agentProvider.notConnected}
            />
          </Stack>
          <Typography variant="body2" color="text.secondary">{t.agentProvider.claudeBody}</Typography>
          <Typography variant="caption" color="warning.main">{t.agentProvider.claudeDisclaimer}</Typography>
          <Typography variant="button" color="primary.main">{t.agentProvider.claudeAction}</Typography>
        </Stack>
      </Box>
    </Stack>
  );

  const renderWelcomeContent = () => (
    <Stack spacing={2}>
      <Typography color="text.secondary" textAlign="center">
        {t.onboarding.steps.welcome.localDataBody}
      </Typography>
      <Typography variant="body2" color="text.secondary" textAlign="center">
        {t.onboarding.steps.welcome.legalPrefix}{' '}
        <Link
          href={activeLocale === 'es' ? 'https://forger.cloud/es/terms' : 'https://forger.cloud/terms'}
          onClick={(event) => {
            event.preventDefault();
            void getDesktopApi().openExternalUrl(event.currentTarget.href);
          }}
        >
          {t.onboarding.steps.welcome.termsLink}
        </Link>{' '}
        {t.onboarding.steps.welcome.legalJoiner}{' '}
        <Link
          href={activeLocale === 'es' ? 'https://forger.cloud/es/privacy' : 'https://forger.cloud/privacy'}
          onClick={(event) => {
            event.preventDefault();
            void getDesktopApi().openExternalUrl(event.currentTarget.href);
          }}
        >
          {t.onboarding.steps.welcome.privacyLink}
        </Link>
        .
      </Typography>
      <Box sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 1, p: 1.5 }}>
        <Stack spacing={0.75}>
          <Tooltip title={t.onboarding.steps.welcome.analyticsTooltip} placement="top">
            <FormControlLabel
              control={
                <Switch
                  checked={tour.welcomeUsageAnalyticsEnabled}
                  onChange={(event) => tour.setWelcomeUsageAnalyticsEnabled(event.target.checked)}
                />
              }
              label={t.onboarding.steps.welcome.analyticsLabel}
            />
          </Tooltip>
          <Typography variant="caption" color="text.secondary">
            {t.onboarding.steps.welcome.analyticsSettingsNote}
          </Typography>
        </Stack>
      </Box>
    </Stack>
  );

  const renderAdvancedView = (view: string, content: ReactNode) => (
    <Stack spacing={2} data-onboarding-target={`advanced-${view}`}>
      {!advancedMode ? (
        <Button variant="text" onClick={() => setCurrentView('settings')} sx={{ alignSelf: 'flex-start' }}>
          {t.settings.backToSettings}
        </Button>
      ) : null}
      {content}
    </Stack>
  );

  const renderInstalledAppsView = () => (
    <Stack spacing={2.5}>
      <Stack spacing={0.5}>
        <Typography variant="h4">{t.sections.apps.title}</Typography>
        <Typography color="text.secondary">{t.sections.apps.subtitle}</Typography>
      </Stack>
      {installedViewApps.length === 0 ? (
        <Stack spacing={1.5} alignItems="flex-start">
          <Typography color="text.secondary">{t.sections.apps.empty}</Typography>
          <Button variant="outlined" onClick={() => setCurrentView('catalog')}>
            {t.sections.apps.openCatalog}
          </Button>
        </Stack>
      ) : (
        <AppsGrid>
          {installedViewApps.map((app: CatalogApp) => {
            const meta = getAppMeta(app.id);
            const installProgress = installProgressByApp[app.id];
            const isInstalling = app.status === 'installing';
            const isConflict = app.status === 'conflict';
            const hasError = app.status === 'error';
            const isPrivateLocal = app.privateLocal === true;
            const isSocialInstalled = Boolean(app.socialSource);
            const canOpenError = isOpenableError(app);
            const canRetryInstallError = isRetryableInstallError(app);
            const canRecoverUpdateError = isUpdateError(app);
            const isEarlyAccess = app.catalogStatus === 'coming';
            const isBeta = app.catalogStatus === 'beta' || Boolean(app.beta);
            const isOpening = app.status !== 'running' && openingAppIds.has(app.id);
            const primaryAction = isConflict ? 'update' : canRecoverUpdateError ? 'update' : canRetryInstallError ? 'retry' : app.status === 'running' ? 'stop' : 'open';
            const canUseAppActionMenu = !isInstalling && !isConflict && (!hasError || canOpenError);
            const canShareLocalNetwork = canUseAppActionMenu && app.localNetworkShareSupported === true;
            const canShareRemoteNetwork = canUseAppActionMenu && app.remoteTunnelSupported === true;
            const canStopRemoteNetwork = canUseAppActionMenu
              && Boolean(app.remoteNetworkShare?.active)
              && app.remoteNetworkShare?.state !== 'closed'
              && app.remoteNetworkShare?.state !== 'inactive';
            const canUploadSocial = canUseAppActionMenu && (isPrivateLocal || isSocialInstalled);
            const primaryActionLabel = isConflict
              ? t.actions.resolveWithForger
              : canRetryInstallError
                ? t.actions.retry
                : canRecoverUpdateError
                  ? t.actions.update
                : app.status === 'running'
                  ? t.actions.stop
                  : isInstalling
                    ? t.actions.installing
                    : isOpening
                      ? t.actions.opening
                      : t.actions.open;

            return (
              <AppCard
                key={app.id}
                appName={meta.name}
                iconUrl={app.iconUrl}
                categoryLabel={getCategoryLabel(app.category)}
                description={meta.description}
                beta={isPrivateLocal || isBeta || isEarlyAccess}
                betaLabel={isPrivateLocal ? t.beta.privateLocalBadge : isEarlyAccess ? t.beta.earlyAccessBadge : 'Beta'}
                statusIndicatorLabel={appExecutionTooltip(app, t, { startingInForger: isOpening })}
                primaryAction={primaryAction}
                primaryActionLabel={primaryActionLabel}
                primaryDisabled={isInstalling}
                primaryLoading={isOpening}
                primaryMenuActions={[
                  ...(canShareLocalNetwork ? [{ label: t.localNetwork.menuAction, onClick: () => handleStartLocalNetworkShare(app.id) }] : []),
                  ...(canShareRemoteNetwork ? [{ label: t.remoteNetwork.menuAction, onClick: () => handleStartRemoteNetworkShare(app.id) }] : []),
                  ...(canStopRemoteNetwork ? [{ label: t.remoteNetwork.stop, onClick: () => handleStopRemoteNetworkShare(app.id) }] : []),
                  ...(canUploadSocial ? [{ label: t.locale === 'es' ? 'Subir a Social' : 'Upload to Social', onClick: () => void handleUploadSocial(app.id) }] : []),
                ]}
                installProgress={installProgress}
                secondaryActionLabel={isConflict ? t.actions.restoreUserVersion : app.updateAvailable ? t.actions.update : undefined}
                onSecondaryAction={
                  isConflict
                    ? () => void handleRestoreUserVersion(app.id)
                    : app.updateAvailable
                      ? () => void handleUpdate(app.id)
                      : undefined
                }
                tertiaryActionLabel={!isInstalling ? t.actions.uninstall : undefined}
                onTertiaryAction={!isInstalling ? () => void handleDeleteApp(app.id) : undefined}
                onCardClick={() => void openAppDetails(app.id, 'apps')}
                onPrimaryAction={() => {
                  if (isInstalling) {
                    return;
                  }
                  if (isConflict) {
                    void handleResolveConflict(app.id);
                    return;
                  }
                  if (canRecoverUpdateError) {
                    void handleUpdate(app.id);
                    return;
                  }
                  if (canRetryInstallError) {
                    handleRetry(app.id);
                    return;
                  }
                  if (app.status === 'running') {
                    handleStop(app.id);
                    return;
                  }
                  void handleOpen(app.id);
                }}
              />
            );
          })}
        </AppsGrid>
      )}
    </Stack>
  );

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      {socialChatWindowRoute ? (
        <FriendChatWindowView
          account={forgerAccount}
          friendUserId={socialChatWindowRoute.friendUserId}
          friendUsername={socialChatWindowRoute.friendUsername}
          friendDisplayName={socialChatWindowRoute.friendDisplayName}
        />
      ) : (
          <AppShell
          currentView={currentView}
          onNavigate={(view) => {
            setCurrentView(view);
            if (view === 'catalog') {
              void refreshApps().catch(() => {
                setBannerSeverity('error');
                setBannerMessage(t.settings.authErrorFallback);
              });
            }
          }}
          t={t}
          chatModeLabel={chatModeLabel}
          dataApps={installedApps.filter((a: any) => a.status === 'installed' || a.status === 'running')}
          selectedDataAppId={selectedDataAppId}
          getAppMeta={getAppMeta}
          onSelectDataApp={setSelectedDataAppId}
          onOpenCloudModal={() => setCloudModalOpen(true)}
          account={forgerAccount}
          accountBusy={forgerAccountBusy}
          cloudStorageUsage={cloudStorageUsage}
          cloudStorageBusy={cloudStorageBusy}
          onOpenStorageSettings={() => {
            setSettingsInitialSubview('storage');
            setCurrentView('settings');
          }}
          onLogout={() => void handleForgerLogout()}
          backgroundTasks={backgroundTasks}
          backgroundTasksOpen={backgroundTasksDrawerOpen}
          activeBackgroundTaskCount={activeBackgroundTaskCount}
          onOpenBackgroundTasks={() => setBackgroundTasksDrawerOpen(true)}
          onCloseBackgroundTasks={() => setBackgroundTasksDrawerOpen(false)}
          onOpenBackgroundTaskHistory={openBackgroundTaskHistory}
          onOpenBackgroundTask={openBackgroundTaskDetail}
          desktopUpdateState={desktopUpdateState}
          advancedMode={advancedMode}
          showForumNav
        >
        {currentView === 'apps' ? renderInstalledAppsView() : null}

        {currentView === 'agents' ? (
          <AgentsView t={t} intelligenceProviderConfigured={intelligenceProviderConfigured} />
        ) : null}

        {currentView === 'catalog' ? (
          <CatalogView
            apps={catalogApps}
            openingAppIds={openingAppIds}
            filter={catalogFilter}
            onFilterChange={setCatalogFilter}
            statusFilter={catalogStatusFilter}
            onStatusFilterChange={setCatalogStatusFilter}
            onInstall={handleInstall}
            onUpdate={(appId) => void handleUpdate(appId)}
            onOpen={handleOpen}
            onStartLocalNetworkShare={handleStartLocalNetworkShare}
            onStartRemoteNetworkShare={handleStartRemoteNetworkShare}
            onStopRemoteNetworkShare={handleStopRemoteNetworkShare}
            onUploadSocial={(appId) => void handleUploadSocial(appId)}
            onRefresh={() => {
              void refreshApps().catch(() => {
                setBannerSeverity('error');
                setBannerMessage(t.settings.authErrorFallback);
              });
            }}
            onStop={handleStop}
            onRetry={handleRetry}
            onRestoreUserVersion={(appId) => void handleRestoreUserVersion(appId)}
            onResolveConflict={(appId) => void handleResolveConflict(appId)}
            onDetails={(appId) => void openAppDetails(appId, 'catalog')}
            onDelete={(appId) => void handleDeleteApp(appId)}
            t={t}
            earlyAccessEnabled={earlyAccessEnabled}
            getAppMeta={getAppMeta}
            getCategoryLabel={getCategoryLabel}
            installProgressByApp={installProgressByApp}
          />
        ) : null}

        {currentView === 'app' ? (
          <AppView
            details={selectedAppDetails}
            openingAppIds={openingAppIds}
            installProgress={selectedAppDetailsId ? installProgressByApp[selectedAppDetailsId] : undefined}
            appToolsInstallGate={selectedAppToolGate}
            appToolGrantBusyId={selectedAppToolGrantBusyId}
            t={t}
            categoryLabel={selectedAppDetails ? getCategoryLabel(selectedAppDetails.app.category) : ''}
            appSecretsState={appSecretsState}
            secretsBusy={secretsBusy}
            account={forgerAccount}
            providerOptions={AGENT_PROVIDER_OPTIONS}
            modelOptions={CODEX_MODEL_OPTIONS}
            reasoningOptions={CODEX_REASONING_OPTIONS}
            claudeModelOptions={CLAUDE_MODEL_OPTIONS}
            claudeEffortOptions={CLAUDE_EFFORT_OPTIONS}
            codexDefaults={settings.codexDefaults}
            developerMode={settings.developerMode}
            onBack={() => setCurrentView(appDetailsBackView)}
            onInstall={(appId) => void handleInstall(appId)}
            onUpdate={(appId) => void handleUpdate(appId)}
            onOpen={(appId) => void handleOpen(appId)}
            onStop={(appId) => void handleStop(appId)}
            onRestoreUserVersion={(appId) => void handleRestoreUserVersion(appId)}
            onResolveConflict={(appId) => void handleResolveConflict(appId)}
            onStartLocalNetworkShare={handleStartLocalNetworkShare}
            onStartRemoteNetworkShare={handleStartRemoteNetworkShare}
            onStopRemoteNetworkShare={handleStopRemoteNetworkShare}
            onUploadSocial={(appId) => void handleUploadSocial(appId)}
            onConnectSecret={handleConnectSecret}
            onDisconnectSecret={handleDisconnectSecret}
            onDelete={(appId) => void handleDeleteApp(appId)}
            onOpenAccount={() => setCloudModalOpen(true)}
            onSetAppToolGrant={(toolId, granted) => void handleAppDetailsToolGrant(toolId, granted)}
            onOpenTools={() => setCurrentView('tools')}
            onOpenProfile={(username) => {
              const normalized = username.trim().replace(/^@/, '');
              if (!normalized) return;
              window.sessionStorage.setItem('forger.social.last-tab', 'profile');
              setSocialProfileUsername(normalized);
              setCurrentView('friends');
            }}
            onSubmitRating={handleSubmitRating}
            onUpdatePrompt={handleUpdateAppPrompt}
            onRestorePrompt={handleRestoreAppPrompt}
          />
        ) : null}

        {currentView === 'chat' ? (
          <ChatView
            t={t}
            messages={chatMessages}
            conversationTitle={t.sections.chat.introTitle}
            activeConversationId={activeConversationId}
            chatMode={activeConversation?.mode}
            targetAppId={activeConversation?.targetAppId}
            installedApps={installedViewApps}
            getAppMeta={getAppMeta}
            historyItems={chatHistoryItems}
            onOpenConversation={handleOpenConversation}
            onDeleteConversation={handleDeleteConversation}
            onStartNewConversation={handleStartNewConversation}
            onNotifyForger={() => void prepareConversationDiagnosticReport()}
            inputValue={chatInput}
            onInputChange={setChatInput}
            onSend={(modeOverride) => void handleSendMessage(undefined, modeOverride)}
            pendingFiles={pendingChatFiles}
            mentionedFiles={mentionedChatFiles}
            availableFiles={forgerFiles}
            fileCategories={fileCategories}
            uploadCategoryPath={uploadCategoryPath}
            onUploadCategoryChange={setUploadCategoryPath}
            onPickFiles={() => void handlePickChatFiles()}
            onStagePastedFile={handleStagePastedChatFile}
            onCreateUploadCategory={() => openCreateCategoryDialog(undefined, true)}
            onRemovePendingFile={handleRemovePendingChatFile}
            onMentionFile={handleMentionFile}
            onRemoveMentionedFile={(fileId) => setMentionedChatFileIds((current: any[]) => current.filter((id: any) => id !== fileId))}
            providerOptions={AGENT_PROVIDER_OPTIONS}
            selectedProvider={activeConversation?.runtime?.provider ?? selectedAgentProvider}
            resolvedProviderForAuto={resolvedChatProvider}
            onSelectProvider={setSelectedAgentProvider}
            providerLocked={Boolean(activeConversation?.runtime || activeConversation?.threadId || activeConversation?.messages.length)}
            modelOptions={CODEX_MODEL_OPTIONS}
            selectedModel={activeConversation?.runtime?.provider === 'codex' ? activeConversation.runtime.model : selectedCodexModel}
            onSelectModel={setSelectedCodexModel}
            reasoningOptions={CODEX_REASONING_OPTIONS}
            selectedReasoningEffort={activeConversation?.runtime?.provider === 'codex' ? activeConversation.runtime.effort as CodexReasoningEffort : selectedCodexReasoningEffort}
            onSelectReasoningEffort={setSelectedCodexReasoningEffort}
            claudeModelOptions={CLAUDE_MODEL_OPTIONS}
            selectedClaudeModel={activeConversation?.runtime?.provider === 'claude' ? activeConversation.runtime.model : selectedClaudeModel}
            onSelectClaudeModel={setSelectedClaudeModel}
            claudeEffortOptions={CLAUDE_EFFORT_OPTIONS}
            selectedClaudeEffort={activeConversation?.runtime?.provider === 'claude' ? activeConversation.runtime.effort as ClaudeEffort : selectedClaudeEffort}
            onSelectClaudeEffort={setSelectedClaudeEffort}
            selectedPermissionMode={selectedChatPermissionMode}
            onSelectPermissionMode={setSelectedChatPermissionMode}
            selectedNetworkAccess={selectedChatNetworkAccess}
            onSelectNetworkAccess={setSelectedChatNetworkAccess}
            onOpenCodexUsageDashboard={() => void getDesktopApi().openCodexUsageDashboard()}
            assistantAvatarSrc={chatBotPictureSrc}
            isSending={activeConversationRunActive}
            isResponding={activeConversationRunActive}
            canStopRun={Boolean(activeConversationRunId)}
            progressLines={activeConversationProgressLines}
            intelligenceProviderConfigured={intelligenceProviderConfigured}
            codexProviderConfigured={codexProviderConfigured}
            onConfigureIntelligenceProvider={openLlmProviderSettings}
            openingAppIds={openingAppIds}
            onOpenApp={(appId) => void handleOpen(appId)}
            onStopRun={handleStopChatRun}
            onRespondPermission={handleRespondPermission}
            onRespondQuestion={handleRespondQuestion}
          />
        ) : null}

        {currentView === 'friends' ? (
          <SocialView
            account={forgerAccount}
            accountBusy={forgerAccountBusy}
            initialProfileUsername={socialProfileUsername}
            onInitialProfileUsernameConsumed={() => setSocialProfileUsername(null)}
            onOpenFriendChat={(friendship) => handleOpenFriendChat(friendship)}
            onOpenCloudModal={() => setCloudModalOpen(true)}
            onOpenSocialApp={handleOpenSocialApp}
            onNotify={(message, severity = 'info') => {
              setBannerSeverity(severity);
              setBannerMessage(message);
            }}
            onUpdateUsername={handleForgerUsernameUpdate}
          />
        ) : null}

        {currentView === 'create' ? (
          <CreateView
            t={t}
            busy={createLocalAppBusy}
            onCreate={handleCreateLocalApp}
          />
        ) : null}

        {currentView === 'feedback' ? (
          <FeedbackView
            apps={catalogApps}
            t={t}
            desktopVersion={desktopUpdateState.currentVersion}
            onSubmitFeedback={handleSubmitFeedback}
          />
        ) : null}

        {currentView === 'docs' ? (
          <DocsView
            locale={activeLocale}
            onOpenExternalUrl={(url) => void getDesktopApi().openExternalUrl(url)}
          />
        ) : null}

        {currentView === 'automations' ? (
          renderAdvancedView('automations', <AutomationsView
            t={t}
            apps={installedApps.filter((a: any) => a.status === 'installed' || a.status === 'running')}
            automations={automations}
            selectedAutomationId={selectedAutomationId}
            runs={automationRuns}
            selectedRun={selectedAutomationRun}
            busy={automationBusy}
            getAppMeta={getAppMeta}
            onSave={(input) => void handleSaveAutomation(input)}
            onDelete={(id) => void handleDeleteAutomation(id)}
            onPause={(id) => void handlePauseAutomation(id)}
            onResume={(id) => void handleResumeAutomation(id)}
            onRunNow={(id) => void handleRunAutomationNow(id)}
            onSelectAutomation={handleSelectAutomation}
            onSelectRun={(runId) => void handleSelectAutomationRun(runId)}
          />)
        ) : null}

        {currentView === 'backgroundTasks' ? (
          <BackgroundTasksListView
            t={t}
            tasks={backgroundTasks}
            backLabel={viewLabel(t, backgroundTasksBackView)}
            onBack={backFromBackgroundTaskHistory}
            onOpenTask={openBackgroundTaskDetail}
          />
        ) : null}

        {currentView === 'backgroundTaskDetail' ? (
          <BackgroundTaskDetailView
            t={t}
            task={backgroundTasks.find((task: BackgroundTask) => task.id === selectedBackgroundTaskId) ?? null}
            onBack={backFromBackgroundTaskDetail}
          />
        ) : null}

        {currentView === 'files' ? (
          renderAdvancedView('files', <FilesView
            t={t}
            files={forgerFiles}
            categories={fileCategories}
            filters={fileFilters}
            onFiltersChange={setFileFilters}
            onCreateCategory={() => openCreateCategoryDialog()}
            onRenameCategory={openRenameCategoryDialog}
            onDeleteCategory={(categoryPath) => void handleDeleteCategory(categoryPath)}
            onRenameFile={openRenameFileDialog}
            onMoveFile={openMoveFileDialog}
            onDeleteFile={(file) => void handleDeleteFile(file)}
          />)
        ) : null}

        {currentView === 'backups' ? (
          renderAdvancedView('backups', <BackupsView
            backups={backups}
            remoteBackups={remoteBackups}
            remoteBackupsUsage={remoteBackupsUsage}
            apps={installedApps}
            account={forgerAccount}
            cloudSyncSettings={cloudSyncSettings}
            busy={backupsBusy}
            t={t}
            onCreateBackup={(appId) => void handleCreateBackup(appId)}
            onSyncNow={(appId) => void handleSyncNow(appId)}
            onDeleteBackup={(backup) => void handleDeleteBackup(backup)}
            onDeleteRemoteBackup={(backup) => void handleDeleteRemoteBackup(backup)}
            onRestoreBackup={(backup) => void handleRestoreBackup(backup)}
            onRestoreRemoteBackup={(backup) => void handleRestoreRemoteBackup(backup)}
            onSetAutoSync={(appId, autoSync) => void handleSetAutoSync(appId, autoSync)}
            onRequireCloud={openCloudUpsell}
          />)
        ) : null}

        {currentView === 'devices' ? (
          renderAdvancedView('devices', <DevicesView account={forgerAccount} t={t} />)
        ) : null}

        {currentView === 'datos' ? (
          renderAdvancedView('datos', <DataView
            t={t}
            selectedAppId={selectedDataAppId}
            onDbListTables={(appId) => getDesktopApi().dbListTables(appId)}
            onDbQueryTable={(appId, tableName, limit) => getDesktopApi().dbQueryTable(appId, tableName, limit)}
          />)
        ) : null}

        {currentView === 'secrets' ? (
          renderAdvancedView('secrets', <SecretsView
            secrets={userSecrets}
            busy={secretsBusy}
            t={t}
            onCreateSecret={handleCreateSecret}
            onUpdateSecret={handleUpdateSecret}
            onDeleteSecret={handleDeleteSecret}
          />)
        ) : null}

        {currentView === 'tools' ? (
          renderAdvancedView('tools', <ToolsView
            packages={agentToolPackages}
            settings={agentToolSettings}
            officialTools={officialTools}
            selectedTool={selectedToolsTool}
            busyToolId={agentToolBusyId}
            busyOfficialToolId={officialToolBusyId}
            errorMessage={agentToolError}
            errorTechnicalCode={agentToolErrorCode}
            t={t}
            onSelectedToolChange={setSelectedToolsTool}
            onApprovalChange={(toolId, requiresApproval) =>
              void handleAgentToolApprovalChange(toolId, requiresApproval)
            }
            onActivateOfficialTool={(toolId) =>
              void runOfficialToolAction(toolId, () => getDesktopApi().activateOfficialTool(toolId, activeLocale))
            }
            onConfigureOfficialTool={(toolId) =>
              void runOfficialToolAction(toolId, () => getDesktopApi().configureOfficialTool({ toolId, locale: activeLocale }))
            }
            onStartWhatsAppPairing={async (method, phoneNumber) => {
              await getDesktopApi().configureOfficialTool({ toolId: 'whatsapp', locale: activeLocale });
              const result = await getDesktopApi().callOfficialTool({
                toolId: 'whatsapp',
                actionId: 'whatsapp.start_pairing',
                input: {
                  method,
                  ...(phoneNumber ? { phoneNumber } : {}),
                },
              });
              await refreshOfficialTools();
              return result;
            }}
            onGetWhatsAppStatus={async () => getDesktopApi().callOfficialTool({
              toolId: 'whatsapp',
              actionId: 'whatsapp.connection.status',
              input: {},
            })}
            onOfficialToolEvent={(listener) => getDesktopApi().onOfficialToolEvent(listener)}
            onDeactivateOfficialTool={(toolId) =>
              void runOfficialToolAction(toolId, () => getDesktopApi().deactivateOfficialTool(toolId, activeLocale))
            }
          />)
        ) : null}

        {currentView === 'settings' ? (
          <SettingsView
            initialSubview={settingsInitialSubview ?? undefined}
            onInitialSubviewConsumed={() => setSettingsInitialSubview(null)}
            codexAuthBusy={codexAuthBusy}
            claudeAuthBusy={claudeAuthBusy}
            codexAuthStatus={codexAuthStatus}
            claudeAuthStatus={claudeAuthStatus}
            t={t}
            themePreference={themePreference}
            onThemeChange={setThemePreference}
            languagePreference={languagePreference}
            activeLocale={activeLocale}
            systemLocale={systemLocale}
            onLanguageChange={setLanguagePreference}
            chatBotPicture={chatBotPicture}
            chatBotPictureOptions={CHAT_BOT_PICTURE_OPTIONS}
            onChatBotPictureChange={setChatBotPicture}
            modelOptions={CODEX_MODEL_OPTIONS}
            reasoningOptions={CODEX_REASONING_OPTIONS}
            providerOptions={AGENT_PROVIDER_OPTIONS}
            claudeModelOptions={CLAUDE_MODEL_OPTIONS}
            claudeEffortOptions={CLAUDE_EFFORT_OPTIONS}
            defaultAgentProvider={settings.defaultAgentProvider}
            defaultChatPermissionMode={settings.defaultChatPermissionMode}
            defaultChatNetworkAccess={settings.defaultChatNetworkAccess}
            agentDefaults={settings.agentDefaults}
            onAgentDefaultsChange={(input) => void handleAgentDefaultsChange(input)}
            developerMode={settings.developerMode}
            onDeveloperModeChange={handleDeveloperModeChange}
            onOpenCodexConfig={() => setCodexConfigOpen(true)}
            onReinstallCodex={() => void handleReinstallCodex()}
            onOpenClaudeConfig={() => setClaudeConfigOpen(true)}
            onReinstallClaude={() => void handleReinstallClaude()}
            desktopUpdateState={desktopUpdateState}
            desktopUpdateBusy={desktopUpdateBusy}
            cloudStorageUsage={cloudStorageUsage}
            cloudStorageBusy={cloudStorageBusy}
            onRefreshCloudStorage={() => void refreshCloudStorageUsage()}
            onCheckDesktopUpdates={() => void runDesktopUpdateAction(() => getDesktopApi().checkDesktopUpdates())}
            onDownloadDesktopUpdate={() => void runDesktopUpdateAction(() => getDesktopApi().downloadDesktopUpdate())}
            onInstallDesktopUpdate={() => void runDesktopUpdateAction(() => getDesktopApi().installDesktopUpdate())}
            installedApps={installedApps}
            memories={memories}
            onCreateMemory={(input) => void handleCreateMemory(input)}
            onUpdateMemory={(input) => void handleUpdateMemory(input)}
            onDeleteMemory={(id) => void handleDeleteMemory(id)}
            cloudIdentity={cloudIdentity}
            onRevealCloudSecretKey={() => getDesktopApi().revealCloudSecretKey()}
            onRegenerateCloudSecretKey={() => {
              void getDesktopApi().regenerateCloudSecretKey().then(setCloudIdentity);
            }}
            earlyAccessEnabled={earlyAccessEnabled}
            advancedMode={advancedMode}
            usageAnalyticsEnabled={usageAnalyticsEnabled}
            forumParticipation={forumParticipation}
            forumParticipationBusy={forumParticipationBusy}
            onEnterForum={handleEnterForum}
            onEarlyAccessChange={setEarlyAccessEnabled}
            onAdvancedModeChange={setAdvancedMode}
            onUsageAnalyticsChange={handleUsageAnalyticsChange}
            onNavigate={setCurrentView}
            onResetOnboarding={resetOnboarding}
          />
        ) : null}
        </AppShell>
      )}

      <TourOverlay
        step={tour.activeStep}
        highlightRect={tour.highlightRect}
        modalWidth={tour.modalWidth}
        primaryLabel={tour.primaryLabel}
        primaryVariant={tour.primaryVariant}
        primaryColor={tour.primaryColor}
        t={t}
        extraContent={tour.isWelcomeStep ? renderWelcomeContent() : tour.isAgentStep ? renderAgentProviderCards() : undefined}
        onSkip={tour.skipTour}
        onContinue={tour.continueTour}
      />

      <RendererAppDialogs controller={controller} />
      <Dialog open={forumPromptOpen} onClose={() => void handleDismissForumPrompt()} maxWidth="xs" fullWidth>
        <DialogTitle>{t.settings.forumPromptTitle}</DialogTitle>
        <DialogContent>
          <Stack spacing={1}>
            <Typography color="text.secondary">{t.settings.forumPromptBody}</Typography>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => void handleDismissForumPrompt()} disabled={forumParticipationBusy}>
            {t.settings.forumPromptLater}
          </Button>
          <Button variant="contained" onClick={() => void handleEnterForum()} disabled={forumParticipationBusy}>
            {t.settings.forumPromptEnter}
          </Button>
        </DialogActions>
      </Dialog>
      <LocalNetworkShareDialog
        appName={localNetworkShareStatus ? getAppMeta(localNetworkShareStatus.appId).name : ''}
        open={localNetworkShareDialogOpen}
        status={localNetworkShareStatus}
        t={t}
        onClose={() => setLocalNetworkShareDialogOpen(false)}
        onStop={() => void handleStopLocalNetworkShare()}
        onCopied={() => {
          setBannerSeverity('success');
          setBannerMessage(t.localNetwork.copied);
        }}
      />
    </ThemeProvider>
  );
}
