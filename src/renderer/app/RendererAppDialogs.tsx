import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  Snackbar,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { CodexConfigModal } from '@renderer/components/CodexConfigModal';
import { ClaudeConfigModal } from '@renderer/components/ClaudeConfigModal';
import { ForgerCloudModal } from '@renderer/components/ForgerCloudModal';
import { LlmProviderConnectModal } from '@renderer/components/LlmProviderConnectModal';

interface RendererAppDialogsProps {
  controller: Record<string, any>;
}

export function RendererAppDialogs({ controller }: RendererAppDialogsProps) {
  const {
    getDesktopApi,
    t,
    pendingInstallGate,
    pendingInstallBusy,
    setPendingInstallGate,
    renderInstallTool,
    renderInstallCapability,
    renderInstallItem,
    capabilityRows,
    handleConfirmInstallWithTools,
    cloudModalOpen,
    setCloudModalOpen,
    forgerAccount,
    forgerAccountBusy,
    forgerAccountMessage,
    handleForgerLogin,
    handleForgerGoogleLogin,
    handleForgerAppleLogin,
    handleForgerRegister,
    handleForgerUsernameUpdate,
    handleForgerLogout,
    codexConfigOpen,
    codexAuthStatus,
    codexAuthBusy,
    closeCodexConfig,
    handleConnectCodexAuth,
    refreshCodexAuthStatus,
    claudeConfigOpen,
    claudeAuthStatus,
    claudeAuthBusy,
    closeClaudeConfig,
    handleConnectClaudeAuth,
    refreshClaudeAuthStatus,
    handleReinstallClaude,
    antigravityConfigOpen,
    antigravityAuthStatus,
    antigravityAuthBusy,
    closeAntigravityConfig,
    handleConnectAntigravityAuth,
    refreshAntigravityAuthStatus,
    handleReinstallAntigravity,
    agentProviderConfigOpen,
    setAgentProviderConfigOpen,
    setCodexConfigOpen,
    setClaudeConfigOpen,
    categoryDialogOpen,
    setCategoryDialogOpen,
    categoryDialogName,
    setCategoryDialogName,
    handleCreateCategorySubmit,
    renameCategoryDialog,
    setRenameCategoryDialog,
    handleRenameCategorySubmit,
    renameFileDialog,
    setRenameFileDialog,
    handleRenameFileSubmit,
    moveFileDialog,
    setMoveFileDialog,
    handleMoveFileSubmit,
    fileCategories,
    remoteTunnelReadyDialog,
    closeRemoteTunnelReadyDialog,
    stopReadyRemoteTunnel,
    openRemoteTunnelPortal,
    appCategoryOptions,
    socialUploadDialog,
    closeSocialUploadDialog,
    setSocialUploadVisibility,
    setSocialUploadCategory,
    setSocialUploadName,
    submitSocialUploadDialog,
    errorReportDialog,
    closeErrorReportDialog,
    copyErrorReportDetails,
    submitErrorReport,
    conversationDiagnosticDialog,
    setConversationDiagnosticDescription,
    closeConversationDiagnosticDialog,
    copyConversationDiagnosticReport,
    submitConversationDiagnosticReport,
    bannerMessage,
    setBannerMessage,
    bannerSeverity,
  } = controller;
  const errorReportPreview = errorReportDialog.report
    ? { ...errorReportDialog.report, diagnosticAttachmentToken: undefined }
    : null;
  const conversationReportPreview = conversationDiagnosticDialog.report
    ? { ...conversationDiagnosticDialog.report, diagnosticAttachmentToken: undefined }
    : null;
  const fileLabel = (file: { filename: string; sanitizedByteSize: number }) =>
    t.settings.reportFileItem(file.filename, file.sanitizedByteSize);

  return (
    <>
      <Dialog
        open={Boolean(pendingInstallGate)}
        onClose={() => {
          if (!pendingInstallBusy) setPendingInstallGate(null);
        }}
        fullWidth
        maxWidth="sm"
      >
        <DialogTitle>
          {t.installGate.title(pendingInstallGate?.appName ?? t.installGate.fallbackAppName)}
        </DialogTitle>
        <DialogContent>
          <Stack spacing={2.25} sx={{ pt: 1 }}>
            <Typography color="text.secondary">
              {t.installGate.body}
            </Typography>

            <Stack spacing={1}>
              <Typography variant="subtitle2">{t.installGate.capabilitiesTitle}</Typography>
              {pendingInstallGate && capabilityRows(pendingInstallGate).length > 0 ? (
                <Stack spacing={1}>
                  {capabilityRows(pendingInstallGate).map(renderInstallCapability)}
                </Stack>
              ) : (
                <Typography variant="body2" color="text.secondary">
                  {t.installGate.noCapabilities}
                </Typography>
              )}
            </Stack>

            <Stack spacing={1}>
              <Typography variant="subtitle2">{t.installGate.toolsTitle}</Typography>
              {pendingInstallGate && (pendingInstallGate.required.length > 0 || pendingInstallGate.optional.length > 0) ? (
                <Stack spacing={1}>
                  {pendingInstallGate.required.map((item: any) => renderInstallTool(item, true))}
                  {pendingInstallGate.optional.map((item: any) => renderInstallTool(item, false))}
                </Stack>
              ) : (
                <Typography variant="body2" color="text.secondary">
                  {t.installGate.noTools}
                </Typography>
              )}
            </Stack>

            <Stack spacing={1}>
              <Typography variant="subtitle2">{t.installGate.agentsTitle}</Typography>
              {pendingInstallGate?.agents.length ? (
                <Stack spacing={1}>{pendingInstallGate.agents.map(renderInstallItem)}</Stack>
              ) : (
                <Typography variant="body2" color="text.secondary">
                  {t.installGate.noAgents}
                </Typography>
              )}
            </Stack>

            <Stack spacing={1}>
              <Typography variant="subtitle2">{t.installGate.aiTasksTitle}</Typography>
              {pendingInstallGate?.promptTemplates.length ? (
                <Stack spacing={1}>{pendingInstallGate.promptTemplates.map(renderInstallItem)}</Stack>
              ) : (
                <Typography variant="body2" color="text.secondary">
                  {t.installGate.noAiTasks}
                </Typography>
              )}
            </Stack>
          </Stack>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2.5 }}>
          <Button disabled={pendingInstallBusy} onClick={() => setPendingInstallGate(null)}>{t.installGate.cancel}</Button>
          <Button
            variant="contained"
            disabled={pendingInstallBusy}
            onClick={() => void handleConfirmInstallWithTools()}
          >
            {t.installGate.confirm}
          </Button>
        </DialogActions>
      </Dialog>

      <ForgerCloudModal
        open={cloudModalOpen}
        t={t}
        account={forgerAccount}
        busy={forgerAccountBusy}
        message={forgerAccountMessage}
        onClose={() => setCloudModalOpen(false)}
        onLogin={handleForgerLogin}
        onGoogleLogin={handleForgerGoogleLogin}
        onAppleLogin={handleForgerAppleLogin}
        onRegister={handleForgerRegister}
        onUpdateUsername={handleForgerUsernameUpdate}
        onLogout={handleForgerLogout}
      />

      <CodexConfigModal
        open={codexConfigOpen}
        status={codexAuthStatus}
        busy={codexAuthBusy}
        t={t}
        onClose={closeCodexConfig}
        onConnect={handleConnectCodexAuth}
        onRefresh={refreshCodexAuthStatus}
        onOpenExternalUrl={(url) => void getDesktopApi().openExternalUrl(url)}
      />

      <ClaudeConfigModal
        open={claudeConfigOpen}
        status={claudeAuthStatus}
        busy={claudeAuthBusy}
        t={t}
        onClose={closeClaudeConfig}
        onConnect={handleConnectClaudeAuth}
        onRefresh={refreshClaudeAuthStatus}
        onReinstall={handleReinstallClaude}
        onOpenExternalUrl={(url) => void getDesktopApi().openExternalUrl(url)}
      />

      <LlmProviderConnectModal
        open={antigravityConfigOpen}
        provider="antigravity"
        providerName={t.llmProviderConnect.providers.antigravity.name}
        providerOwner={t.llmProviderConnect.providers.antigravity.owner}
        authenticated={antigravityAuthStatus.authenticated}
        installed={antigravityAuthStatus.installed}
        busy={antigravityAuthBusy}
        title={t.llmProviderConnect.providers.antigravity.title}
        body={t.llmProviderConnect.providers.antigravity.body}
        steps={t.llmProviderConnect.providers.antigravity.steps}
        termsUrl="https://antigravity.google/terms"
        privacyUrl="https://transparency.google/intl/en/our-policies/privacy-policy-terms-of-service"
        connectLabel={t.settings.antigravityConnectAction}
        t={t}
        onClose={closeAntigravityConfig}
        onConnect={handleConnectAntigravityAuth}
        onRefresh={refreshAntigravityAuthStatus}
        onReinstall={handleReinstallAntigravity}
        onOpenExternalUrl={(url) => void getDesktopApi().openExternalUrl(url)}
      />

      <Dialog open={socialUploadDialog.open} onClose={closeSocialUploadDialog} maxWidth="xs" fullWidth>
        <DialogTitle>
          {t.social.uploadTitle}
        </DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ pt: 1 }}>
            <Typography color="text.secondary">
              {socialUploadDialog.isRemix ? t.social.uploadRemixBody : t.social.uploadBody}
            </Typography>
            {socialUploadDialog.isRemix ? (
              <TextField
                label={t.social.uploadNameLabel}
                value={socialUploadDialog.name}
                onChange={(event) => setSocialUploadName(event.target.value)}
                fullWidth
              />
            ) : null}
            <FormControl fullWidth size="small">
              <InputLabel id="social-upload-category-label">{t.social.uploadCategoryLabel}</InputLabel>
              <Select
                labelId="social-upload-category-label"
                label={t.social.uploadCategoryLabel}
                value={socialUploadDialog.category}
                onChange={(event) => setSocialUploadCategory(event.target.value)}
              >
                {appCategoryOptions.map((category: string) => (
                  <MenuItem key={category} value={category}>{(t.appCategories as Record<string, string>)[category]}</MenuItem>
                ))}
              </Select>
            </FormControl>
            <Typography variant="caption" color="text.secondary">{t.social.uploadCategoryHelp}</Typography>
            <FormControl fullWidth size="small">
              <InputLabel id="social-upload-visibility-label">{t.social.uploadVisibilityLabel}</InputLabel>
              <Select
                labelId="social-upload-visibility-label"
                label={t.social.uploadVisibilityLabel}
                value={socialUploadDialog.visibility}
                onChange={(event) => setSocialUploadVisibility(event.target.value)}
              >
                <MenuItem value="private">{t.social.uploadVisibility.private}</MenuItem>
                <MenuItem value="friends">{t.social.uploadVisibility.friends}</MenuItem>
                <MenuItem value="public">{t.social.uploadVisibility.public}</MenuItem>
              </Select>
            </FormControl>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={closeSocialUploadDialog}>{t.actions.close}</Button>
          <Button variant="contained" onClick={() => void submitSocialUploadDialog()}>
            {t.social.uploadAction}
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={agentProviderConfigOpen} onClose={() => setAgentProviderConfigOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>{t.agentProvider.title}</DialogTitle>
        <DialogContent>
          <Stack spacing={2}>
            <Typography color="text.secondary">
              {t.agentProvider.body}
            </Typography>
            <Alert severity="warning">
              {t.agentProvider.quotaDisclaimer}
            </Alert>
            <Alert severity="warning">
              {t.agentProvider.claudeDisclaimer}
            </Alert>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setAgentProviderConfigOpen(false)}>{t.actions.close}</Button>
          <Button
            variant="outlined"
            onClick={() => {
              setAgentProviderConfigOpen(false);
              setClaudeConfigOpen(true);
            }}
          >
            {t.agentProvider.claudeAction}
          </Button>
          <Button
            variant="outlined"
            onClick={() => {
              setAgentProviderConfigOpen(false);
              controller.setAntigravityConfigOpen(true);
            }}
          >
            {t.settings.antigravityConnectAction}
          </Button>
          <Button
            variant="contained"
            onClick={() => {
              setAgentProviderConfigOpen(false);
              setCodexConfigOpen(true);
            }}
          >
            {t.agentProvider.codexAction}
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={categoryDialogOpen} onClose={() => setCategoryDialogOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle>{t.sections.files.createCategory}</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            fullWidth
            margin="dense"
            label={t.sections.files.categoryNamePrompt}
            value={categoryDialogName}
            onChange={(event) => setCategoryDialogName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                void handleCreateCategorySubmit();
              }
            }}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setCategoryDialogOpen(false)}>{t.actions.close}</Button>
          <Button variant="contained" onClick={() => void handleCreateCategorySubmit()} disabled={!categoryDialogName.trim()}>
            {t.sections.files.createCategory}
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog
        open={renameCategoryDialog.open}
        onClose={() => setRenameCategoryDialog({ open: false, categoryPath: '', name: '' })}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle>{t.sections.files.renameCategory}</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            fullWidth
            margin="dense"
            label={t.sections.files.categoryNamePrompt}
            value={renameCategoryDialog.name}
            onChange={(event) => setRenameCategoryDialog((current: any) => ({ ...current, name: event.target.value }))}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                void handleRenameCategorySubmit();
              }
            }}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setRenameCategoryDialog({ open: false, categoryPath: '', name: '' })}>{t.actions.close}</Button>
          <Button variant="contained" onClick={() => void handleRenameCategorySubmit()} disabled={!renameCategoryDialog.name.trim()}>
            {t.sections.files.rename}
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog
        open={renameFileDialog.open}
        onClose={() => setRenameFileDialog({ open: false, file: null, name: '' })}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle>{t.sections.files.renameFile}</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            fullWidth
            margin="dense"
            label={t.sections.files.namePrompt}
            value={renameFileDialog.name}
            onChange={(event) => setRenameFileDialog((current: any) => ({ ...current, name: event.target.value }))}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                void handleRenameFileSubmit();
              }
            }}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setRenameFileDialog({ open: false, file: null, name: '' })}>{t.actions.close}</Button>
          <Button variant="contained" onClick={() => void handleRenameFileSubmit()} disabled={!renameFileDialog.name.trim()}>
            {t.sections.files.rename}
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog
        open={moveFileDialog.open}
        onClose={() => setMoveFileDialog({ open: false, file: null, categoryPath: '' })}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle>{t.sections.files.moveFile}</DialogTitle>
        <DialogContent>
          <Select
            fullWidth
            size="small"
            value={moveFileDialog.categoryPath}
            onChange={(event) => setMoveFileDialog((current: any) => ({ ...current, categoryPath: event.target.value }))}
            sx={{ mt: 1 }}
          >
            <MenuItem value="">{t.sections.files.root}</MenuItem>
            {fileCategories.map((category: any) => (
              <MenuItem key={category.path} value={category.path}>{category.name}</MenuItem>
            ))}
          </Select>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setMoveFileDialog({ open: false, file: null, categoryPath: '' })}>{t.actions.close}</Button>
          <Button variant="contained" onClick={() => void handleMoveFileSubmit()}>
            {t.sections.files.move}
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog
        open={remoteTunnelReadyDialog.open}
        onClose={closeRemoteTunnelReadyDialog}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle>{t.remoteNetwork.readyTitle}</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ pt: 0.5 }}>
            <Typography color="text.secondary">
              {t.remoteNetwork.readyBody}
            </Typography>
            <Alert severity="info">
              {t.remoteNetwork.readySecurityBody}
            </Alert>
          </Stack>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2.5 }}>
          <Button onClick={closeRemoteTunnelReadyDialog}>{t.actions.close}</Button>
          <Button color="warning" onClick={() => void stopReadyRemoteTunnel()}>
            {t.remoteNetwork.stop}
          </Button>
          <Button variant="contained" onClick={() => void openRemoteTunnelPortal()}>
            {t.remoteNetwork.openPortal}
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog
        open={errorReportDialog.open}
        onClose={closeErrorReportDialog}
        maxWidth="md"
        fullWidth
      >
        <DialogTitle>{t.settings.errorReportTitle}</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ pt: 0.5 }}>
            <Typography color="text.secondary">{t.settings.errorReportBody}</Typography>
            <Alert severity="info">{t.settings.errorReportRetention}</Alert>
            {errorReportDialog.report?.diagnosticFiles?.length ? (
              <Stack spacing={0.75}>
                <Typography variant="subtitle2">{t.settings.reportFilesLabel}</Typography>
                {errorReportDialog.report.diagnosticFiles.map((file: any) => (
                  <Typography key={`${file.kind}:${file.filename}`} variant="body2" color="text.secondary">
                    {fileLabel(file)}
                  </Typography>
                ))}
              </Stack>
            ) : null}
            {errorReportPreview ? (
              <TextField
                fullWidth
                multiline
                minRows={8}
                maxRows={14}
                label={t.settings.errorReportDetailsLabel}
                value={JSON.stringify(errorReportPreview, null, 2)}
                InputProps={{ readOnly: true }}
              />
            ) : null}
            {errorReportDialog.userMessage ? (
              <Alert severity="info">{errorReportDialog.userMessage}</Alert>
            ) : null}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={closeErrorReportDialog} disabled={errorReportDialog.busy}>
            {t.settings.errorReportNoSend}
          </Button>
          <Button onClick={() => void copyErrorReportDetails()} disabled={errorReportDialog.busy || !errorReportDialog.report}>
            {t.settings.errorReportCopy}
          </Button>
          <Button
            variant="contained"
            onClick={() => void submitErrorReport()}
            disabled={errorReportDialog.busy || !errorReportDialog.report}
          >
            {t.settings.errorReportSend}
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog
        open={conversationDiagnosticDialog.open}
        onClose={closeConversationDiagnosticDialog}
        maxWidth="md"
        fullWidth
      >
        <DialogTitle>{t.settings.conversationReportTitle}</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ pt: 0.5 }}>
            <Typography color="text.secondary">{t.settings.conversationReportBody}</Typography>
            <Alert severity="info">{t.settings.conversationReportRetention}</Alert>
            <TextField
              fullWidth
              multiline
              minRows={3}
              label={t.settings.conversationReportDescriptionLabel}
              placeholder={t.settings.conversationReportDescriptionPlaceholder}
              value={conversationDiagnosticDialog.description}
              onChange={(event) => setConversationDiagnosticDescription(event.target.value)}
              disabled={conversationDiagnosticDialog.busy}
            />
            {conversationDiagnosticDialog.report?.diagnosticFiles?.length ? (
              <Stack spacing={0.75}>
                <Typography variant="subtitle2">{t.settings.reportFilesLabel}</Typography>
                {conversationDiagnosticDialog.report.diagnosticFiles.map((file: any) => (
                  <Typography key={`${file.kind}:${file.filename}`} variant="body2" color="text.secondary">
                    {fileLabel(file)}
                  </Typography>
                ))}
              </Stack>
            ) : null}
            {conversationReportPreview ? (
              <TextField
                fullWidth
                multiline
                minRows={10}
                maxRows={16}
                label={t.settings.conversationReportDetailsLabel}
                value={JSON.stringify({
                  ...conversationReportPreview,
                  description: conversationDiagnosticDialog.description.trim() || undefined,
                }, null, 2)}
                InputProps={{ readOnly: true }}
              />
            ) : null}
            {conversationDiagnosticDialog.userMessage ? (
              <Alert severity="info">{conversationDiagnosticDialog.userMessage}</Alert>
            ) : null}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={closeConversationDiagnosticDialog} disabled={conversationDiagnosticDialog.busy}>
            {t.settings.errorReportNoSend}
          </Button>
          <Button onClick={() => void copyConversationDiagnosticReport()} disabled={conversationDiagnosticDialog.busy || !conversationDiagnosticDialog.report}>
            {t.settings.errorReportCopy}
          </Button>
          <Button
            variant="contained"
            onClick={() => void submitConversationDiagnosticReport()}
            disabled={conversationDiagnosticDialog.busy || !conversationDiagnosticDialog.report}
          >
            {conversationDiagnosticDialog.busy ? t.settings.conversationReportSending : t.settings.conversationReportSend}
          </Button>
        </DialogActions>
      </Dialog>

      <Snackbar
        open={Boolean(bannerMessage)}
        autoHideDuration={3200}
        onClose={() => setBannerMessage(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert severity={bannerSeverity} variant="filled" onClose={() => setBannerMessage(null)}>
          {bannerMessage}
        </Alert>
      </Snackbar>
    </>
  );
}
