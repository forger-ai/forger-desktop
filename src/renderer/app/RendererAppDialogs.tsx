import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
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

interface RendererAppDialogsProps {
  controller: Record<string, any>;
}

export function RendererAppDialogs({ controller }: RendererAppDialogsProps) {
  const {
    t,
    pendingInstallGate,
    pendingInstallBusy,
    setPendingInstallGate,
    renderInstallTool,
    renderInstallItem,
    handleConfirmInstallWithTools,
    cloudModalOpen,
    setCloudModalOpen,
    forgerAccount,
    forgerAccountBusy,
    forgerAccountMessage,
    handleForgerLogin,
    handleForgerGoogleLogin,
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
    openRemoteTunnelPortal,
    socialUploadDialog,
    closeSocialUploadDialog,
    setSocialUploadVisibility,
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
            disabled={pendingInstallBusy || !pendingInstallGate?.canInstall}
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
      />

      <Dialog open={socialUploadDialog.open} onClose={closeSocialUploadDialog} maxWidth="xs" fullWidth>
        <DialogTitle>
          {t.locale === 'es' ? 'Subir a Social' : 'Upload to Social'}
        </DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ pt: 1 }}>
            <Typography color="text.secondary">
              {t.locale === 'es'
                ? 'Elige quien puede ver esta app compartida.'
                : 'Choose who can see this shared app.'}
            </Typography>
            <Select
              fullWidth
              value={socialUploadDialog.visibility}
              onChange={(event) => setSocialUploadVisibility(event.target.value)}
            >
              <MenuItem value="private">
                {t.locale === 'es' ? 'Privada: solo con link' : 'Private: link only'}
              </MenuItem>
              <MenuItem value="friends">
                {t.locale === 'es' ? 'Amigos' : 'Friends'}
              </MenuItem>
              <MenuItem value="public">
                {t.locale === 'es' ? 'Publica' : 'Public'}
              </MenuItem>
            </Select>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={closeSocialUploadDialog}>{t.actions.close}</Button>
          <Button variant="contained" onClick={() => void submitSocialUploadDialog()}>
            {t.locale === 'es' ? 'Subir' : 'Upload'}
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={agentProviderConfigOpen} onClose={() => setAgentProviderConfigOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>Conectar agente</DialogTitle>
        <DialogContent>
          <Stack spacing={2}>
            <Typography color="text.secondary">
              Para conversar con tus apps o pedir cambios, conecta una cuenta de ChatGPT/Codex o Claude Code.
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
            Conectar Claude
          </Button>
          <Button
            variant="contained"
            onClick={() => {
              setAgentProviderConfigOpen(false);
              setCodexConfigOpen(true);
            }}
          >
            Conectar ChatGPT
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
