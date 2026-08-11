import RefreshRounded from '@mui/icons-material/RefreshRounded';
import CheckCircleRounded from '@mui/icons-material/CheckCircleRounded';
import LinkOffRounded from '@mui/icons-material/LinkOffRounded';
import LogoutRounded from '@mui/icons-material/LogoutRounded';
import RestartAltRounded from '@mui/icons-material/RestartAltRounded';
import {
  Alert,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  LinearProgress,
  Stack,
  Typography,
} from '@mui/material';
import type { AppDictionary } from '@renderer/i18n';
import type { ClaudeAuthStatus } from '@shared/types';
import { LlmProviderConnectModal } from './LlmProviderConnectModal';

interface ClaudeConfigModalProps {
  open: boolean;
  status: ClaudeAuthStatus;
  forgerConnected: boolean;
  busy: boolean;
  t: AppDictionary;
  onClose: () => void;
  onConnect: () => Promise<void>;
  onRefresh: () => Promise<void>;
  onDisconnect: () => Promise<void>;
  onSignOut: () => Promise<void>;
  onReinstall: () => Promise<void>;
  onOpenExternalUrl: (url: string) => void;
}

export function ClaudeConfigModal({
  open,
  status,
  forgerConnected,
  busy,
  t,
  onClose,
  onConnect,
  onRefresh,
  onDisconnect,
  onSignOut,
  onReinstall,
  onOpenExternalUrl,
}: ClaudeConfigModalProps) {
  const sourceLabel = status.source === 'managed'
    ? t.settings.claudeSourceManaged
    : status.source === 'system'
      ? t.settings.claudeSourceSystem
      : t.settings.claudeSourceMissing;
  const connectionDetail = status.authenticated
    ? t.settings.claudeConnectionActive
    : status.installed
      ? t.settings.claudeConnectionMissingSession
      : t.settings.claudeConnectionInstallAvailable;

  if (!forgerConnected) {
    return (
      <LlmProviderConnectModal
        open={open}
        provider="claude"
        providerName={t.llmProviderConnect.providers.claude.name}
        providerOwner={t.llmProviderConnect.providers.claude.owner}
        authenticated={false}
        installed={status.installed}
        busy={busy}
        title={t.llmProviderConnect.providers.claude.title}
        body={t.llmProviderConnect.providers.claude.body}
        steps={t.llmProviderConnect.providers.claude.steps}
        termsUrl="https://support.claude.com/en/collections/4078534-privacy-and-legal"
        privacyUrl="https://privacy.claude.com/en/"
        connectLabel={t.settings.claudeConnectAction}
        t={t}
        onClose={onClose}
        onConnect={onConnect}
        onOpenExternalUrl={onOpenExternalUrl}
      />
    );
  }

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>{t.settings.claudeConfigTitle}</DialogTitle>
      <DialogContent>
        <Stack spacing={2}>
          <Stack direction="row" spacing={1} alignItems="center">
            <Chip color="success" label={t.llmProviderConnect.connected} />
            <Chip variant="outlined" label={sourceLabel} />
          </Stack>
          {status.authenticated ? (
            <Alert severity="success" icon={<CheckCircleRounded />}>
              {t.settings.claudeReady}
            </Alert>
          ) : busy ? (
            <Alert severity="info">
              <Stack spacing={1}>
                <Typography variant="body2">{t.agentProvider.claudeConnecting}</Typography>
                <LinearProgress />
              </Stack>
            </Alert>
          ) : null}
          <Typography color="text.secondary">
            {t.settings.claudeInstallDescription}
          </Typography>
          <Alert severity="warning">
            <Typography variant="body2">{t.agentProvider.claudeQuotaDisclaimer}</Typography>
          </Alert>
          <Stack spacing={0.75}>
            <Typography variant="body2">
              {connectionDetail}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {t.settings.claudeDetectedVersion(status.version?.replace(/\s*\(Claude Code\)\s*/i, '') || t.settings.claudeVersionMissing)}
            </Typography>
          </Stack>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{t.actions.close}</Button>
        <Button variant="outlined" startIcon={<LinkOffRounded />} disabled={busy} onClick={() => void onDisconnect()}>
          {t.settings.claudeDisconnectForgerAction}
        </Button>
        <Button
          variant="outlined"
          color="error"
          startIcon={<LogoutRounded />}
          disabled={busy}
          onClick={() => {
            if (window.confirm(t.settings.claudeSignOutConfirm)) {
              void onSignOut();
            }
          }}
        >
          {t.settings.claudeSignOutAction}
        </Button>
        <Button variant="outlined" startIcon={<RefreshRounded />} disabled={busy} onClick={() => void onRefresh()}>
          {t.agentProvider.refresh}
        </Button>
        <Button variant="outlined" color="warning" startIcon={<RestartAltRounded />} disabled={busy} onClick={() => void onReinstall()}>
          {t.settings.claudeReinstallAction}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
