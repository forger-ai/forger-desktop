import { Box, Button, Chip, CssBaseline, Dialog, DialogActions, DialogContent, DialogTitle, FormControlLabel, LinearProgress, Link, Stack, Switch, ThemeProvider, Tooltip, Typography } from '@mui/material';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { AgentEffort, AntigravityEffort, AudioRuntimeBrokerRequest, BackgroundTask, CatalogApp, ClaudeEffort, CodexReasoningEffort, DesktopUpdateReleaseSummary, WakeWordState } from '@shared/types';
import { AppShell } from '@renderer/components/AppShell';
import { AppCard } from '@renderer/components/AppCard';
import { AppsGrid } from '@renderer/components/AppsGrid';
import { isOpenableError, isRetryableInstallError, isUpdateError } from '@renderer/app-error-actions';
import { AppView } from '@renderer/views/AppView';
import { AgentsView } from '@renderer/views/AgentsView';
import { AutomationsView } from '@renderer/views/AutomationsView';
import { WorkflowsModule } from '@renderer/views/workflows/WorkflowsModule';
import { BackupsView } from '@renderer/views/BackupsView';
import { BackgroundTaskDetailView, BackgroundTasksListView, viewLabel } from '@renderer/views/BackgroundTasksView';
import { CatalogView } from '@renderer/views/CatalogView';
import { ChatView } from '@renderer/views/ChatView';
import { ConnectionsView } from '@renderer/views/ConnectionsView';
import { DataView } from '@renderer/views/DataView';
import { DevicesView } from '@renderer/views/DevicesView';
import { DocsView } from '@renderer/views/DocsView';
import { FeedbackView } from '@renderer/views/FeedbackView';
import { FilesView } from '@renderer/views/FilesView';
import { FriendChatWindowView } from '@renderer/views/FriendChatWindowView';
import { MoreView } from '@renderer/views/MoreView';
import type { PinnableView } from '@renderer/components/Sidebar';
import { SocialView } from '@renderer/views/SocialView';
import { SettingsView } from '@renderer/views/SettingsView';
import { SecretsView } from '@renderer/views/SecretsView';
import { SidekicksView } from '@renderer/views/SidekicksView';
import { ToolsView } from '@renderer/views/ToolsView';
import { AGENT_PROVIDER_OPTIONS, ANTIGRAVITY_EFFORT_OPTIONS, ANTIGRAVITY_MODEL_OPTIONS, CHAT_BOT_PICTURE_OPTIONS, CLAUDE_EFFORT_OPTIONS, CLAUDE_MODEL_OPTIONS, CODEX_MODEL_OPTIONS, CODEX_REASONING_OPTIONS } from '@renderer/preferences';
import { buildChatProviderOptions, getRuntimeSupportedEfforts, normalizeRuntimeEffortForModel } from '@shared/agent-runtime-registry';
import { TourOverlay } from '@renderer/tour/TourOverlay';
import { useForgerTour } from '@renderer/tour/useForgerTour';
import { appExecutionTooltip } from '@renderer/app-execution-labels';
import { RendererAppDialogs } from './RendererAppDialogs';
import { DesktopUpdateSummaryMarkdown } from './DesktopUpdateSummaryMarkdown';
import { enumerateAudioRuntimeDevices, playRuntimeAudio } from './audio-runtime-browser';
import { LocalNetworkShareDialog } from '@renderer/components/LocalNetworkShareDialog';
import { WakeWordClientRunner } from '@renderer/services/WakeWordClientRunner';
import type { RuntimeProviderControls } from '@renderer/runtime-provider-controls';

interface RendererAppViewProps {
  controller: Record<string, any>;
}

export function RendererAppView({ controller }: RendererAppViewProps) {
  const audioRuntimePlaybacksRef = useRef<Map<string, HTMLAudioElement>>(new Map());
  const desktopUpdateQuitRequestedRef = useRef(false);
  const [settingsInitialSubview, setSettingsInitialSubview] = useState<'main' | 'llmProvider' | 'storage' | 'wakeWord' | null>(null);
  const [desktopUpdateModalOpen, setDesktopUpdateModalOpen] = useState(false);
  const [desktopUpdateModalDismissedVersion, setDesktopUpdateModalDismissedVersion] = useState<string | null>(null);
  const [desktopUpdateQuitCountdownSeconds, setDesktopUpdateQuitCountdownSeconds] = useState<number | null>(null);
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
    selectedWorkflowId,
    openWorkflowDetail,
    openWorkflowEditor,
    backToWorkflowList,
    selectedConnectionId, openConnectionDetail, backToConnectionsList,
    setBannerSeverity,
    setBannerMessage,
    handleForgerLogout,
    desktopUpdateState,
    pinnedViews,
    togglePinnedView,
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
    handleUploadSocial,
    handleRenameApp,
    installProgressByApp,
    catalogApps,
    refreshApps,
    catalogFilter,
    setCatalogFilter,
    catalogStatusFilter,
    setCatalogStatusFilter,
    handleInstall,
    selectedAppDetails,
    selectedAppDetailsId,
    selectedAppToolGate,
    selectedAppToolGrantBusyId,
    handleAppDetailsToolGrant,
    handleAppDetailsConnectionGrant,
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
    selectedAntigravityModel,
    setSelectedAntigravityModel,
    selectedAntigravityEffort,
    setSelectedAntigravityEffort,
    selectedChatPermissionMode,
    setSelectedChatPermissionMode,
    selectedChatNetworkAccess,
    setSelectedChatNetworkAccess,
    chatBotPictureSrc,
    activeConversationRunActive,
    activeConversationRunId,
    activeConversationProgressLines,
    activeConversationActivity,
    codexAuthStatus,
    claudeAuthStatus,
    antigravityAuthStatus,
    handleStopChatRun,
    handleRespondPermission,
    handleRespondQuestion,
    handleFinishSocialReviewInstall,
    handleDeleteSocialReview,
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
    handleDeleteSelectedBackups,
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
    activeLocale,
    codexAuthBusy,
    claudeAuthBusy,
    antigravityAuthBusy,
    themePreference,
    setThemePreference,
    languagePreference,
    systemLocale,
    setLanguagePreference,
    chatBotPicture,
    setChatBotPicture,
    handleAgentDefaultsChange,
    handleActiveProviderProfileChange,
    handleDeveloperModeChange,
    setCodexConfigOpen,
    handleReinstallCodex,
    setClaudeConfigOpen,
    handleReinstallClaude,
    handleDisconnectClaudeAuth,
    setAntigravityConfigOpen,
    handleReinstallAntigravity,
    handleDisconnectAntigravityAuth,
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
    pendingInstallGate,
    cloudModalOpen,
    handleForgerUsernameUpdate,
    handleForgerProfileUpdate,
    uploadSocialApp,
    socialInstallReviewDialog,
    closeSocialInstallReviewDialog,
    handleSocialInstallReviewDecision,
    handleSocialOptionalGrantDraftChange,
    socialDownloadAccountRequiredOpen,
    setSocialDownloadAccountRequiredOpen,
    renderInstallTool,
    renderInstallConnection,
    renderInstallItem,
    renderInstallCapability,
    capabilityRows,
    codexConfigOpen,
    claudeConfigOpen,
    agentProviderConfigOpen,
  } = controller;

  const selectedCodexRuntimeModel = activeConversation?.runtime?.provider === 'codex' ? activeConversation.runtime.model : selectedCodexModel;
  const selectedCodexRuntimeEffort = activeConversation?.runtime?.provider === 'codex' ? activeConversation.runtime.effort as AgentEffort : selectedCodexReasoningEffort;
  const codexEffortOptionsForModel = (model: string) => {
    const supportedEfforts = getRuntimeSupportedEfforts('codex', model);
    return CODEX_REASONING_OPTIONS.filter((option) => supportedEfforts.includes(option.value));
  };
  const selectedClaudeRuntimeModel = activeConversation?.runtime?.provider === 'claude' ? activeConversation.runtime.model : selectedClaudeModel;
  const selectedClaudeRuntimeEffort = activeConversation?.runtime?.provider === 'claude' ? activeConversation.runtime.effort as AgentEffort : selectedClaudeEffort;
  const claudeEffortOptionsForModel = (model: string) => {
    const supportedEfforts = getRuntimeSupportedEfforts('claude', model);
    return CLAUDE_EFFORT_OPTIONS.filter((option) => supportedEfforts.includes(option.value));
  };
  const selectedAntigravityRuntimeModel = activeConversation?.runtime?.provider === 'antigravity' ? activeConversation.runtime.model : selectedAntigravityModel;
  const selectedAntigravityRuntimeEffort = activeConversation?.runtime?.provider === 'antigravity' ? activeConversation.runtime.effort as AgentEffort : selectedAntigravityEffort;
  const antigravityEffortOptionsForModel = (model: string) => {
    const supportedEfforts = getRuntimeSupportedEfforts('antigravity', model);
    return ANTIGRAVITY_EFFORT_OPTIONS.filter((option) => supportedEfforts.includes(option.value));
  };
  const visibleProviderOptions = AGENT_PROVIDER_OPTIONS;
  const chatProviderOptions = buildChatProviderOptions({
    codexAuthenticated: codexAuthStatus.authenticated,
    claudeAuthenticated: claudeAuthStatus.authenticated,
    antigravityAuthenticated: antigravityAuthStatus.authenticated,
    lockedProvider: activeConversation?.runtime?.provider ?? null,
  });
  const selectedChatProvider = chatProviderOptions.some((option) => option.value === (activeConversation?.runtime?.provider ?? selectedAgentProvider))
    ? activeConversation?.runtime?.provider ?? selectedAgentProvider
    : chatProviderOptions[0]?.value ?? 'auto';
  const desktopUpdateModalSummaries: DesktopUpdateReleaseSummary[] = desktopUpdateState.pendingReleaseSummaries?.length
    ? desktopUpdateState.pendingReleaseSummaries
    : desktopUpdateState.availableVersion && desktopUpdateState.publishedAt && desktopUpdateState.releaseNotes?.summary
      ? [{
          version: desktopUpdateState.availableVersion,
          publishedAt: desktopUpdateState.publishedAt,
          summary: desktopUpdateState.releaseNotes.summary,
        }]
      : [];
  const canDownloadDesktopUpdate = desktopUpdateState.status === 'available' && Boolean(desktopUpdateState.asset);
  const canInstallDesktopUpdate = desktopUpdateState.status === 'ready' && Boolean(desktopUpdateState.downloadedPath);
  const isDesktopUpdateDownloading = desktopUpdateState.status === 'downloading';
  const isDesktopUpdateInstallerOpened = desktopUpdateState.status === 'installer_opened';
  const desktopUpdateInstallerRequiresQuit = isDesktopUpdateInstallerOpened && desktopUpdateState.installerRequiresQuit === true;
  const desktopUpdateProgressPercent = typeof desktopUpdateState.progress === 'number'
    ? Math.max(0, Math.min(100, Math.round(desktopUpdateState.progress * 100)))
    : null;

  const runtimeProviderControls: RuntimeProviderControls = {
    codex: {
      modelOptions: CODEX_MODEL_OPTIONS.map((option) => ({ ...option, defaultEffort: option.defaultReasoningEffort })),
      selectedModel: selectedCodexRuntimeModel,
      onSelectModel: (model) => {
        setSelectedCodexModel(model);
        setSelectedCodexReasoningEffort(normalizeRuntimeEffortForModel('codex', model, selectedCodexRuntimeEffort) as CodexReasoningEffort);
      },
      effortOptions: codexEffortOptionsForModel(selectedCodexRuntimeModel),
      selectedEffort: normalizeRuntimeEffortForModel('codex', selectedCodexRuntimeModel, selectedCodexRuntimeEffort),
      onSelectEffort: (effort) => setSelectedCodexReasoningEffort(effort as CodexReasoningEffort),
      effortOptionsForModel: codexEffortOptionsForModel,
      normalizeEffortForModel: (model, effort) => normalizeRuntimeEffortForModel('codex', model, effort),
    },
    claude: {
      modelOptions: CLAUDE_MODEL_OPTIONS,
      selectedModel: selectedClaudeRuntimeModel,
      onSelectModel: (model) => {
        setSelectedClaudeModel(model);
        setSelectedClaudeEffort(normalizeRuntimeEffortForModel('claude', model, selectedClaudeRuntimeEffort) as ClaudeEffort);
      },
      effortOptions: claudeEffortOptionsForModel(selectedClaudeRuntimeModel),
      selectedEffort: normalizeRuntimeEffortForModel('claude', selectedClaudeRuntimeModel, selectedClaudeRuntimeEffort),
      onSelectEffort: (effort) => setSelectedClaudeEffort(effort as ClaudeEffort),
      effortOptionsForModel: claudeEffortOptionsForModel,
      normalizeEffortForModel: (model, effort) => normalizeRuntimeEffortForModel('claude', model, effort),
    },
    antigravity: {
      modelOptions: ANTIGRAVITY_MODEL_OPTIONS,
      selectedModel: selectedAntigravityRuntimeModel,
      onSelectModel: (model) => {
        setSelectedAntigravityModel(model);
        setSelectedAntigravityEffort(normalizeRuntimeEffortForModel('antigravity', model, selectedAntigravityRuntimeEffort) as AntigravityEffort);
      },
      effortOptions: antigravityEffortOptionsForModel(selectedAntigravityRuntimeModel),
      selectedEffort: normalizeRuntimeEffortForModel('antigravity', selectedAntigravityRuntimeModel, selectedAntigravityRuntimeEffort),
      onSelectEffort: setSelectedAntigravityEffort,
      effortOptionsForModel: antigravityEffortOptionsForModel,
      normalizeEffortForModel: (model, effort) => normalizeRuntimeEffortForModel('antigravity', model, effort),
    },
  };

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

  useEffect(() => {
    if (
      (
        desktopUpdateState.status === 'available' ||
        desktopUpdateState.status === 'downloading' ||
        desktopUpdateState.status === 'ready' ||
        desktopUpdateInstallerRequiresQuit
      ) &&
      desktopUpdateState.availableVersion &&
      desktopUpdateModalDismissedVersion !== desktopUpdateState.availableVersion
    ) {
      setDesktopUpdateModalOpen(true);
    }
  }, [
    desktopUpdateInstallerRequiresQuit,
    desktopUpdateModalDismissedVersion,
    desktopUpdateState.availableVersion,
    desktopUpdateState.status,
  ]);

  useEffect(() => {
    if (
      desktopUpdateState.status === 'installer_opened' &&
      desktopUpdateState.installerRequiresQuit === false &&
      desktopUpdateState.availableVersion
    ) {
      setDesktopUpdateModalDismissedVersion(desktopUpdateState.availableVersion);
      setDesktopUpdateModalOpen(false);
    }
  }, [
    desktopUpdateState.availableVersion,
    desktopUpdateState.installerRequiresQuit,
    desktopUpdateState.status,
  ]);

  useEffect(() => {
    if (!desktopUpdateModalOpen || !desktopUpdateInstallerRequiresQuit) {
      setDesktopUpdateQuitCountdownSeconds(null);
      desktopUpdateQuitRequestedRef.current = false;
      return () => undefined;
    }

    const delaySeconds = desktopUpdateState.installerQuitDelaySeconds ?? 5;
    setDesktopUpdateQuitCountdownSeconds(delaySeconds);
    const timer = window.setInterval(() => {
      setDesktopUpdateQuitCountdownSeconds((current) => {
        const next = Math.max(0, (current ?? delaySeconds) - 1);
        if (next === 0 && !desktopUpdateQuitRequestedRef.current) {
          desktopUpdateQuitRequestedRef.current = true;
          window.clearInterval(timer);
          void getDesktopApi().desktopUpdateQuitForInstall();
        }
        return next;
      });
    }, 1000);

    return () => {
      window.clearInterval(timer);
      desktopUpdateQuitRequestedRef.current = false;
    };
  }, [
    desktopUpdateInstallerRequiresQuit,
    desktopUpdateModalOpen,
    desktopUpdateState.installerQuitDelaySeconds,
    getDesktopApi,
  ]);

  const closeDesktopUpdateModal = () => {
    if (isDesktopUpdateDownloading) {
      return;
    }
    if (desktopUpdateState.availableVersion) {
      setDesktopUpdateModalDismissedVersion(desktopUpdateState.availableVersion);
    }
    setDesktopUpdateModalOpen(false);
  };

  const quitDesktopUpdateForInstall = () => {
    desktopUpdateQuitRequestedRef.current = true;
    void getDesktopApi().desktopUpdateQuitForInstall();
  };
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
    codexAuthStatus,
    claudeAuthStatus,
    antigravityAuthStatus,
    blocked: Boolean(codexConfigOpen || claudeConfigOpen || agentProviderConfigOpen || cloudModalOpen || pendingInstallGate),
  });
  const intelligenceProviderConfigured = codexAuthStatus.authenticated || claudeAuthStatus.authenticated || antigravityAuthStatus.authenticated;

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

  const renderAdvancedView = (view: PinnableView, content: ReactNode) => (
    <Stack spacing={2} data-onboarding-target={`advanced-${view}`}>
      {!pinnedViews.includes(view) ? (
        <Button variant="text" onClick={() => setCurrentView('more')} sx={{ alignSelf: 'flex-start' }}>
          {t.more.back}
        </Button>
      ) : null}
      {content}
    </Stack>
  );

  const startNewAppConversation = () => {
    handleStartNewConversation();
    setCurrentView('chat');
  };

  const renderInstalledAppsView = () => (
    <Stack spacing={2.5}>
      <Stack direction="row" spacing={1.5} alignItems="flex-start" justifyContent="space-between">
        <Stack spacing={0.5}>
          <Typography variant="h4">{t.sections.apps.title}</Typography>
          <Typography color="text.secondary">{t.sections.apps.subtitle}</Typography>
        </Stack>
        <Button variant="contained" onClick={startNewAppConversation} sx={{ flexShrink: 0 }}>
          {t.sections.apps.newApp}
        </Button>
      </Stack>
      {installedViewApps.length === 0 ? (
        <Stack spacing={1.5} alignItems="flex-start">
          <Typography color="text.secondary">{t.sections.apps.empty}</Typography>
          <Stack direction="row" spacing={1}>
            <Button variant="contained" onClick={startNewAppConversation}>
              {t.sections.apps.newApp}
            </Button>
            <Button variant="outlined" onClick={() => setCurrentView('catalog')}>
              {t.sections.apps.openCatalog}
            </Button>
          </Stack>
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
            const canRenameApp = canUploadSocial;
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
                betaLabel={isPrivateLocal ? t.beta.privateLocalBadge : isEarlyAccess ? t.beta.earlyAccessBadge : t.beta.appBadge}
                statusIndicatorLabel={appExecutionTooltip(app, t, { startingInForger: isOpening })}
                primaryAction={primaryAction}
                primaryActionLabel={primaryActionLabel}
                primaryDisabled={isInstalling}
                primaryLoading={isOpening}
                primaryMenuActions={[
                  ...(canRenameApp ? [{ label: t.social.renameAppAction, onClick: () => void handleRenameApp(app.id) }] : []),
                  ...(canShareLocalNetwork ? [{ label: t.localNetwork.menuAction, onClick: () => handleStartLocalNetworkShare(app.id) }] : []),
                  ...(canShareRemoteNetwork ? [{ label: t.remoteNetwork.menuAction, onClick: () => handleStartRemoteNetworkShare(app.id) }] : []),
                  ...(canStopRemoteNetwork ? [{ label: t.remoteNetwork.stop, onClick: () => handleStopRemoteNetworkShare(app.id) }] : []),
                  ...(canUploadSocial ? [{ label: t.social.uploadTitle, onClick: () => void handleUploadSocial(app.id) }] : []),
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
      <Dialog
        open={desktopUpdateModalOpen}
        onClose={closeDesktopUpdateModal}
        fullWidth
        maxWidth="sm"
      >
        <DialogTitle>{t.settings.desktopUpdateModalTitle}</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ pt: 0.5 }}>
            <Typography color="text.secondary">
              {t.settings.desktopUpdateModalDescription(
                desktopUpdateState.currentVersion || '-',
                desktopUpdateState.availableVersion ?? '-',
              )}
            </Typography>
            {isDesktopUpdateDownloading ? (
              <Stack spacing={1}>
                <Typography variant="body2" color="text.secondary">
                  {desktopUpdateProgressPercent === null
                    ? t.settings.desktopDownloading
                    : t.settings.desktopDownloadProgress(desktopUpdateProgressPercent)}
                </Typography>
                <LinearProgress
                  variant={desktopUpdateProgressPercent === null ? 'indeterminate' : 'determinate'}
                  value={desktopUpdateProgressPercent ?? undefined}
                />
              </Stack>
            ) : null}
            {isDesktopUpdateInstallerOpened ? (
              <Stack spacing={1}>
                <Typography variant="body2" color="text.secondary">
                  {t.settings.desktopUpdateInstallerOpened}
                </Typography>
                {desktopUpdateInstallerRequiresQuit ? (
                  <Typography variant="body2" color="text.secondary">
                    {t.settings.desktopUpdateInstallerQuitCountdown(
                      desktopUpdateQuitCountdownSeconds ?? desktopUpdateState.installerQuitDelaySeconds ?? 5,
                    )}
                  </Typography>
                ) : null}
              </Stack>
            ) : null}
            <Stack spacing={1.25}>
              <Typography variant="overline" color="text.secondary">
                {t.settings.desktopUpdateModalChangesHeading}
              </Typography>
              {desktopUpdateModalSummaries.length > 0 ? (
                <Stack spacing={1.5}>
                  {desktopUpdateModalSummaries.map((release) => (
                    <Stack spacing={0.5} key={release.version}>
                      <Typography variant="h6">{`v${release.version}`}</Typography>
                      <DesktopUpdateSummaryMarkdown
                        content={release.summary}
                        onOpenExternalUrl={(url) => void getDesktopApi().openExternalUrl(url)}
                      />
                    </Stack>
                  ))}
                </Stack>
              ) : (
                <Typography variant="body2" color="text.secondary">
                  {t.appView.updateNoChangelog}
                </Typography>
              )}
            </Stack>
          </Stack>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2.5 }}>
          {desktopUpdateInstallerRequiresQuit ? (
            <>
              <Button onClick={closeDesktopUpdateModal}>
                {t.settings.desktopUpdateInstallerCloseLater}
              </Button>
              <Button variant="contained" onClick={quitDesktopUpdateForInstall}>
                {t.settings.desktopUpdateInstallerCloseNow}
              </Button>
            </>
          ) : isDesktopUpdateInstallerOpened ? (
            <Button onClick={closeDesktopUpdateModal}>
              {t.settings.desktopUpdateModalLater}
            </Button>
          ) : (
            <>
              <Button disabled={isDesktopUpdateDownloading} onClick={closeDesktopUpdateModal}>
                {t.settings.desktopUpdateModalLater}
              </Button>
              <Button
                variant={canInstallDesktopUpdate ? 'outlined' : 'contained'}
                disabled={desktopUpdateBusy || !canDownloadDesktopUpdate}
                onClick={() => void runDesktopUpdateAction(() => getDesktopApi().downloadDesktopUpdate())}
              >
                {t.settings.desktopDownloadUpdate}
              </Button>
              <Button
                variant="contained"
                disabled={desktopUpdateBusy || !canInstallDesktopUpdate}
                onClick={() => void runDesktopUpdateAction(() => getDesktopApi().installDesktopUpdate())}
              >
                {t.settings.desktopInstallUpdate}
              </Button>
            </>
          )}
        </DialogActions>
      </Dialog>
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
          pinnedViews={pinnedViews}
          showForumNav
        >
        {currentView === 'apps' ? renderInstalledAppsView() : null}

        {currentView === 'agents' ? (
          <AgentsView
            t={t}
            intelligenceProviderConfigured={intelligenceProviderConfigured}
            providerOptions={visibleProviderOptions}
            installedApps={installedApps}
            onNotifyForger={(input) => void prepareConversationDiagnosticReport(input)}
          />
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
            onOpenCloudModal={() => setCloudModalOpen(true)}
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
            getAppMeta={getAppMeta}
            getCategoryLabel={getCategoryLabel}
            installProgressByApp={installProgressByApp}
            account={forgerAccount}
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
            providerOptions={visibleProviderOptions}
            runtimeProviderControls={runtimeProviderControls}
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
            onRenameApp={(appId) => void handleRenameApp(appId)}
            onConnectSecret={handleConnectSecret}
            onDisconnectSecret={handleDisconnectSecret}
            onDelete={(appId) => void handleDeleteApp(appId)}
            onOpenAccount={() => setCloudModalOpen(true)}
            onSetAppToolGrant={(toolId, granted) => void handleAppDetailsToolGrant(toolId, granted)}
            onSetAppConnectionGrant={(type, granted) => void handleAppDetailsConnectionGrant(type, granted)}
            onOpenTools={() => setCurrentView('tools')}
            onOpenConnections={() => setCurrentView('connections')}
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
            providerOptions={chatProviderOptions}
            selectedProvider={selectedChatProvider}
            resolvedProviderForAuto={resolvedChatProvider}
            onSelectProvider={setSelectedAgentProvider}
            providerLocked={Boolean(activeConversation?.runtime || activeConversation?.threadId || activeConversation?.messages.length)}
            runtimeProviderControls={runtimeProviderControls}
            selectedPermissionMode={selectedChatPermissionMode}
            onSelectPermissionMode={setSelectedChatPermissionMode}
            selectedNetworkAccess={selectedChatNetworkAccess}
            onSelectNetworkAccess={setSelectedChatNetworkAccess}
            assistantAvatarSrc={chatBotPictureSrc}
            isSending={activeConversationRunActive}
            isResponding={activeConversationRunActive}
            canStopRun={Boolean(activeConversationRunId)}
            progressLines={activeConversationProgressLines}
            activity={activeConversationActivity}
            intelligenceProviderConfigured={intelligenceProviderConfigured}
            onConfigureIntelligenceProvider={openLlmProviderSettings}
            openingAppIds={openingAppIds}
            onOpenApp={(appId) => void handleOpen(appId)}
            onStopRun={handleStopChatRun}
            onRespondPermission={handleRespondPermission}
            onRespondQuestion={handleRespondQuestion}
            onInstallReviewedSocialApp={() => void handleFinishSocialReviewInstall()}
            onDeleteReviewedSocialApp={() => void handleDeleteSocialReview()}
          />
        ) : null}

        {currentView === 'friends' ? (
          <SocialView
            account={forgerAccount}
            t={t}
            accountBusy={forgerAccountBusy}
            installedApps={installedApps}
            initialProfileUsername={socialProfileUsername}
            onInitialProfileUsernameConsumed={() => setSocialProfileUsername(null)}
            onOpenFriendChat={(friendship) => handleOpenFriendChat(friendship)}
            onOpenCloudModal={() => setCloudModalOpen(true)}
            onOpenSocialApp={handleOpenSocialApp}
            onUploadSocial={(appId, visibility, category) => {
              if (visibility) {
                void uploadSocialApp(appId, visibility, { category });
              } else {
                void handleUploadSocial(appId);
              }
            }}
            onNotify={(message, severity = 'info') => {
              setBannerSeverity(severity);
              setBannerMessage(message);
            }}
            onUpdateUsername={handleForgerUsernameUpdate}
            onUpdateProfile={handleForgerProfileUpdate}
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

        {currentView === 'more' ? (
          <MoreView
            t={t}
            pinnedViews={pinnedViews}
            onTogglePin={togglePinnedView}
            onOpen={setCurrentView}
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
            providerOptions={chatProviderOptions.length > 0 ? chatProviderOptions : [{ label: t.sections.automations.autoProvider, value: 'auto' }]}
            runtimeProviderControls={runtimeProviderControls}
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

        {currentView === 'workflows' || currentView === 'workflowEditor' || currentView === 'workflowDetail' ? (
          <WorkflowsModule
            t={t}
            view={currentView}
            selectedWorkflowId={selectedWorkflowId}
            isPinned={pinnedViews.includes('workflows')}
            onBackToMore={() => setCurrentView('more')}
            onOpenList={backToWorkflowList}
            onOpenDetail={openWorkflowDetail}
            onOpenEditor={openWorkflowEditor}
          />
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
            onDeleteSelectedBackups={handleDeleteSelectedBackups}
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

        {currentView === 'sidekicks' ? (
          renderAdvancedView('sidekicks', <SidekicksView t={t} />)
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

        {currentView === 'connections' ? renderAdvancedView('connections', <ConnectionsView t={t} view="list" selectedConnectionId={null} settings={agentToolSettings} busyToolId={agentToolBusyId} onOpenConnection={openConnectionDetail} onNotice={({ severity, message }) => { setBannerSeverity(severity); setBannerMessage(message); }} onApprovalChange={(toolId, requiresApproval) => void handleAgentToolApprovalChange(toolId, requiresApproval)} />) : null}

        {currentView === 'connectionDetail' ? renderAdvancedView('connections', <ConnectionsView t={t} view="detail" selectedConnectionId={selectedConnectionId} settings={agentToolSettings} busyToolId={agentToolBusyId} onOpenConnection={openConnectionDetail} onBack={backToConnectionsList} onNotice={({ severity, message }) => { setBannerSeverity(severity); setBannerMessage(message); }} onApprovalChange={(toolId, requiresApproval) => void handleAgentToolApprovalChange(toolId, requiresApproval)} />) : null}

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
            onApprovalChange={(toolId, requiresApproval) => void handleAgentToolApprovalChange(toolId, requiresApproval)}
            onActivateOfficialTool={(toolId) =>
              void runOfficialToolAction(toolId, () => getDesktopApi().activateOfficialTool(toolId, activeLocale))
            }
            onConfigureOfficialTool={(toolId, secrets) =>
              void runOfficialToolAction(toolId, () => getDesktopApi().configureOfficialTool({ toolId, locale: activeLocale, ...(secrets ? { secrets } : {}) }), 'configure')
            }
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
            antigravityAuthBusy={antigravityAuthBusy}
            codexAuthStatus={codexAuthStatus}
            claudeAuthStatus={claudeAuthStatus}
            antigravityAuthStatus={antigravityAuthStatus}
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
            providerOptions={visibleProviderOptions}
            claudeModelOptions={CLAUDE_MODEL_OPTIONS}
            claudeEffortOptions={CLAUDE_EFFORT_OPTIONS}
            antigravityModelOptions={ANTIGRAVITY_MODEL_OPTIONS}
            antigravityEffortOptions={ANTIGRAVITY_EFFORT_OPTIONS}
            defaultAgentProvider={settings.defaultAgentProvider}
            defaultChatPermissionMode={settings.defaultChatPermissionMode}
            defaultChatNetworkAccess={settings.defaultChatNetworkAccess}
            agentDefaults={settings.agentDefaults}
            providerConnections={settings.providerConnections}
            llmProviderProfiles={settings.llmProviderProfiles}
            activeProviderProfiles={settings.activeProviderProfiles}
            onAgentDefaultsChange={(input) => void handleAgentDefaultsChange(input)}
            onActiveProviderProfileChange={(input) => void handleActiveProviderProfileChange(input)}
            onProviderProfileDefaultsChange={(input) => void controller.handleProviderProfileDefaultsChange(input)}
            developerMode={settings.developerMode}
            onDeveloperModeChange={handleDeveloperModeChange}
            onOpenCodexConfig={() => setCodexConfigOpen(true)}
            onDisconnectCodex={() => void controller.handleDisconnectCodexAuth()}
            onReinstallCodex={() => void handleReinstallCodex()}
            onOpenClaudeConfig={() => setClaudeConfigOpen(true)}
            onDisconnectClaude={() => void handleDisconnectClaudeAuth()}
            onReinstallClaude={() => void handleReinstallClaude()}
            onOpenAntigravityConfig={() => setAntigravityConfigOpen(true)}
            onDisconnectAntigravity={() => void handleDisconnectAntigravityAuth()}
            onReinstallAntigravity={() => void handleReinstallAntigravity()}
            antigravityAuthConsoleOpen={controller.antigravityAuthConsoleOpen}
            onCancelAntigravityAuthSession={() => void controller.handleCancelAntigravityAuthSession()}
            onCloseAntigravityAuthConsole={() => void controller.handleCancelAntigravityAuthSession()}
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
            usageAnalyticsEnabled={usageAnalyticsEnabled}
            forumParticipation={forumParticipation}
            forumParticipationBusy={forumParticipationBusy}
            onEnterForum={handleEnterForum}
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
      <Dialog open={Boolean(socialDownloadAccountRequiredOpen)} onClose={() => setSocialDownloadAccountRequiredOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle>{t.sections.catalog.signInDownloadTitle}</DialogTitle>
        <DialogContent>
          <Typography color="text.secondary">{t.sections.catalog.signInDownloadBody}</Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setSocialDownloadAccountRequiredOpen(false)}>
            {t.actions.cancel}
          </Button>
          <Button
            variant="contained"
            onClick={() => {
              setSocialDownloadAccountRequiredOpen(false);
              setCloudModalOpen(true);
            }}
          >
            {t.sections.catalog.signInDownloadAction}
          </Button>
        </DialogActions>
      </Dialog>
      <Dialog open={Boolean(socialInstallReviewDialog?.open)} onClose={socialInstallReviewDialog?.busy ? undefined : closeSocialInstallReviewDialog} maxWidth="sm" fullWidth>
        <DialogTitle>{t.social.reviewInstallTitle}</DialogTitle>
        <DialogContent>
          <Stack spacing={2.25} sx={{ pt: 1 }}>
            <Typography fontWeight={700}>{socialInstallReviewDialog?.appName}</Typography>
            <Typography color="text.secondary">{t.social.reviewInstallBody}</Typography>
            <Typography variant="body2" color="warning.main">{t.sections.catalog.disclaimer}</Typography>
            {socialInstallReviewDialog?.gate ? (
              <>
                <Stack spacing={1}>
                  <Typography variant="subtitle2">{t.installGate.capabilitiesTitle}</Typography>
                  {capabilityRows(socialInstallReviewDialog.gate).length > 0 ? (
                    <Stack spacing={1}>{capabilityRows(socialInstallReviewDialog.gate).map(renderInstallCapability)}</Stack>
                  ) : (
                    <Typography variant="body2" color="text.secondary">{t.installGate.noCapabilities}</Typography>
                  )}
                </Stack>
                <Stack spacing={1}>
                  <Typography variant="subtitle2">{t.installGate.toolsTitle}</Typography>
                  {socialInstallReviewDialog.gate.required.length > 0 || socialInstallReviewDialog.gate.optional.length > 0 ? (
                    <Stack spacing={1}>
                      {socialInstallReviewDialog.gate.required.map((item: any) => renderInstallTool(item, true, socialInstallReviewDialog.grantDrafts ?? {}, handleSocialOptionalGrantDraftChange))}
                      {socialInstallReviewDialog.gate.optional.map((item: any) => renderInstallTool(item, false, socialInstallReviewDialog.grantDrafts ?? {}, handleSocialOptionalGrantDraftChange))}
                    </Stack>
                  ) : (
                    <Typography variant="body2" color="text.secondary">{t.installGate.noTools}</Typography>
                  )}
                </Stack>
                <Stack spacing={1}>
                  <Typography variant="subtitle2">{t.installGate.connectionsTitle}</Typography>
                  {(socialInstallReviewDialog.gate.connectionRequired?.length ?? 0) > 0 || (socialInstallReviewDialog.gate.connectionOptional?.length ?? 0) > 0 ? (
                    <Stack spacing={1}>
                      {(socialInstallReviewDialog.gate.connectionRequired ?? []).map((item: any) => renderInstallConnection(item, true, socialInstallReviewDialog.grantDrafts ?? {}, handleSocialOptionalGrantDraftChange))}
                      {(socialInstallReviewDialog.gate.connectionOptional ?? []).map((item: any) => renderInstallConnection(item, false, socialInstallReviewDialog.grantDrafts ?? {}, handleSocialOptionalGrantDraftChange))}
                    </Stack>
                  ) : (
                    <Typography variant="body2" color="text.secondary">{t.installGate.noConnections}</Typography>
                  )}
                </Stack>
                <Stack spacing={1}>
                  <Typography variant="subtitle2">{t.installGate.agentsTitle}</Typography>
                  {socialInstallReviewDialog.gate.agents.length ? (
                    <Stack spacing={1}>{socialInstallReviewDialog.gate.agents.map(renderInstallItem)}</Stack>
                  ) : (
                    <Typography variant="body2" color="text.secondary">{t.installGate.noAgents}</Typography>
                  )}
                </Stack>
                <Stack spacing={1}>
                  <Typography variant="subtitle2">{t.installGate.aiTasksTitle}</Typography>
                  {socialInstallReviewDialog.gate.promptTemplates.length ? (
                    <Stack spacing={1}>{socialInstallReviewDialog.gate.promptTemplates.map(renderInstallItem)}</Stack>
                  ) : (
                    <Typography variant="body2" color="text.secondary">{t.installGate.noAiTasks}</Typography>
                  )}
                </Stack>
              </>
            ) : null}
            {socialInstallReviewDialog?.busy ? (
              <Stack spacing={1}>
                <LinearProgress />
                <Typography variant="body2" color="text.secondary">
                  {t.social.reviewPrepareProgress}
                </Typography>
              </Stack>
            ) : null}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={closeSocialInstallReviewDialog} disabled={Boolean(socialInstallReviewDialog?.busy)}>{t.actions.cancel}</Button>
          <Button onClick={() => void handleSocialInstallReviewDecision('skipped_review')} disabled={Boolean(socialInstallReviewDialog?.busy)}>{t.social.installWithoutReviewAction}</Button>
          <Button variant="contained" onClick={() => void handleSocialInstallReviewDecision('reviewed')} disabled={Boolean(socialInstallReviewDialog?.busy)}>{t.social.reviewWithAiAction}</Button>
        </DialogActions>
      </Dialog>
      <Dialog open={forumPromptOpen} onClose={() => void handleDismissForumPrompt()} maxWidth="xs" fullWidth>
        <DialogTitle>{t.settings.forumPromptTitle}</DialogTitle>
        <DialogContent>
          <Stack spacing={1}>
            <Typography color="text.secondary">{t.settings.forumPromptBody}</Typography>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => void handleDismissForumPrompt()} disabled={forumParticipationBusy}>{t.settings.forumPromptLater}</Button>
          <Button variant="contained" onClick={() => void handleEnterForum()} disabled={forumParticipationBusy}>{t.settings.forumPromptEnter}</Button>
        </DialogActions>
      </Dialog>
      <LocalNetworkShareDialog appName={localNetworkShareStatus ? getAppMeta(localNetworkShareStatus.appId).name : ''} open={localNetworkShareDialogOpen} status={localNetworkShareStatus} t={t} onClose={() => setLocalNetworkShareDialogOpen(false)} onStop={() => void handleStopLocalNetworkShare()} onCopied={() => {
          setBannerSeverity('success');
          setBannerMessage(t.localNetwork.copied);
        }} />
    </ThemeProvider>
  );
}
