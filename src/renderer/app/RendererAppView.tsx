import {
  Box,
  Button,
  Chip,
  CssBaseline,
  FormControlLabel,
  Link,
  Stack,
  Switch,
  ThemeProvider,
  Tooltip,
  Typography,
} from '@mui/material';
import type { ReactNode } from 'react';
import type { ClaudeEffort, CodexReasoningEffort } from '@shared/types';
import { AppShell } from '@renderer/components/AppShell';
import { AppView } from '@renderer/views/AppView';
import { AutomationsView } from '@renderer/views/AutomationsView';
import { BackupsView } from '@renderer/views/BackupsView';
import { CatalogView } from '@renderer/views/CatalogView';
import { ChatView } from '@renderer/views/ChatView';
import { DataView } from '@renderer/views/DataView';
import { DevicesView } from '@renderer/views/DevicesView';
import { FeedbackView } from '@renderer/views/FeedbackView';
import { FilesView } from '@renderer/views/FilesView';
import { FriendChatWindowView } from '@renderer/views/FriendChatWindowView';
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
import { RendererAppDialogs } from './RendererAppDialogs';
import { LocalNetworkShareDialog } from '@renderer/components/LocalNetworkShareDialog';

interface RendererAppViewProps {
  controller: Record<string, any>;
}

export function RendererAppView({ controller }: RendererAppViewProps) {
  const {
    getDesktopApi,
    resetOnboarding,
    theme,
    socialChatWindowRoute,
    forgerAccount,
    currentView,
    setCurrentView,
    t,
    installedApps,
    selectedAppId,
    selectedDataAppId,
    setSelectedDataAppId,
    getAppMeta,
    handleSelectChatApp,
    setCloudModalOpen,
    forgerAccountBusy,
    handleOpenFriendChat,
    setBannerSeverity,
    setBannerMessage,
    handleForgerLogout,
    desktopUpdateState,
    advancedMode,
    openingAppIds,
    getCategoryLabel,
    handleOpen,
    handleStartLocalNetworkShare,
    handleStopLocalNetworkShare,
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
    handleUpdateAppPrompt,
    handleRestoreAppPrompt,
    chatMessages,
    activeConversationId,
    chatHistoryItems,
    handleOpenConversation,
    handleDeleteConversation,
    handleStartNewConversation,
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
    chatBotPictureSrc,
    chatRunActive,
    activeConversationRunActive,
    activeConversationRunId,
    activeConversationProgressLines,
    codexAuthStatus,
    claudeAuthStatus,
    setAgentProviderConfigOpen,
    handleStopChatRun,
    handleRespondPermission,
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
    setCodexConfigOpen,
    handleReinstallCodex,
    setClaudeConfigOpen,
    handleReinstallClaude,
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

  const openCodexSetup = () => {
    controller.setAgentProviderConfigOpen(false);
    setCodexConfigOpen(true);
  };
  const openClaudeSetup = () => {
    controller.setAgentProviderConfigOpen(false);
    setClaudeConfigOpen(true);
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
          chatApps={installedApps}
          selectedChatAppId={selectedAppId}
          dataApps={installedApps.filter((a: any) => a.status === 'installed' || a.status === 'running')}
          selectedDataAppId={selectedDataAppId}
          getAppMeta={getAppMeta}
          onSelectChatApp={handleSelectChatApp}
          onSelectDataApp={setSelectedDataAppId}
          onOpenCloudModal={() => setCloudModalOpen(true)}
          account={forgerAccount}
          accountBusy={forgerAccountBusy}
          onOpenFriendChat={(friendship) => handleOpenFriendChat(friendship)}
          onSocialNotify={(message, severity = 'info') => {
            setBannerSeverity(severity);
            setBannerMessage(message);
          }}
          onUpdateUsername={handleForgerUsernameUpdate}
          onLogout={() => void handleForgerLogout()}
          desktopUpdateState={desktopUpdateState}
          advancedMode={advancedMode}
        >
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
            onBack={() => setCurrentView(appDetailsBackView)}
            onInstall={(appId) => void handleInstall(appId)}
            onUpdate={(appId) => void handleUpdate(appId)}
            onOpen={(appId) => void handleOpen(appId)}
            onStop={(appId) => void handleStop(appId)}
            onRestoreUserVersion={(appId) => void handleRestoreUserVersion(appId)}
            onResolveConflict={(appId) => void handleResolveConflict(appId)}
            onConnectSecret={handleConnectSecret}
            onDisconnectSecret={handleDisconnectSecret}
            onDelete={(appId) => void handleDeleteApp(appId)}
            onOpenAccount={() => setCloudModalOpen(true)}
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
            historyItems={chatHistoryItems}
            onOpenConversation={handleOpenConversation}
            onDeleteConversation={handleDeleteConversation}
            onStartNewConversation={handleStartNewConversation}
            inputValue={chatInput}
            onInputChange={setChatInput}
            onSend={() => void handleSendMessage()}
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
            onOpenCodexUsageDashboard={() => void getDesktopApi().openCodexUsageDashboard()}
            assistantAvatarSrc={chatBotPictureSrc}
            isSending={chatRunActive}
            isResponding={activeConversationRunActive}
            canStopRun={Boolean(activeConversationRunId)}
            progressLines={activeConversationProgressLines}
            codexConfigured={codexAuthStatus.authenticated || claudeAuthStatus.authenticated}
            onConfigureCodex={() => setAgentProviderConfigOpen(true)}
            openingAppIds={openingAppIds}
            onOpenApp={(appId) => void handleOpen(appId)}
            onStopRun={handleStopChatRun}
            onRespondPermission={handleRespondPermission}
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
            onDeactivateOfficialTool={(toolId) =>
              void runOfficialToolAction(toolId, () => getDesktopApi().deactivateOfficialTool(toolId, activeLocale))
            }
          />)
        ) : null}

        {currentView === 'settings' ? (
          <SettingsView
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
            agentDefaults={settings.agentDefaults}
            onAgentDefaultsChange={(input) => void handleAgentDefaultsChange(input)}
            onOpenCodexConfig={() => setCodexConfigOpen(true)}
            onReinstallCodex={() => void handleReinstallCodex()}
            onOpenClaudeConfig={() => setClaudeConfigOpen(true)}
            onReinstallClaude={() => void handleReinstallClaude()}
            desktopUpdateState={desktopUpdateState}
            desktopUpdateBusy={desktopUpdateBusy}
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
