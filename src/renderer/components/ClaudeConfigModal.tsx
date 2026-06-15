import TerminalRounded from '@mui/icons-material/TerminalRounded';
import RefreshRounded from '@mui/icons-material/RefreshRounded';
import CheckCircleRounded from '@mui/icons-material/CheckCircleRounded';
import RestartAltRounded from '@mui/icons-material/RestartAltRounded';
import {
  Alert,
  Button,
  Chip,
  CircularProgress,
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

interface ClaudeConfigModalProps {
  open: boolean;
  status: ClaudeAuthStatus;
  busy: boolean;
  t: AppDictionary;
  onClose: () => void;
  onConnect: () => Promise<void>;
  onRefresh: () => Promise<void>;
  onReinstall: () => Promise<void>;
}

export function ClaudeConfigModal({
  open,
  status,
  busy,
  t,
  onClose,
  onConnect,
  onRefresh,
  onReinstall,
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

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>{t.settings.claudeConfigTitle}</DialogTitle>
      <DialogContent>
        <Stack spacing={2}>
          <Stack direction="row" spacing={1} alignItems="center">
            <Chip color={status.authenticated ? 'success' : 'default'} label={status.authenticated ? 'Conectado' : 'No conectado'} />
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
        <Button variant="outlined" startIcon={<RefreshRounded />} disabled={busy} onClick={() => void onRefresh()}>
          {t.agentProvider.refresh}
        </Button>
        <Button variant="outlined" color="warning" startIcon={<RestartAltRounded />} disabled={busy} onClick={() => void onReinstall()}>
          {t.settings.claudeReinstallAction}
        </Button>
        {!status.authenticated ? (
          <Button
            variant="contained"
            startIcon={busy ? <CircularProgress color="inherit" size={16} /> : <TerminalRounded />}
            disabled={busy}
            onClick={() => void onConnect()}
          >
            {t.settings.claudeConnectAction}
          </Button>
        ) : null}
      </DialogActions>
    </Dialog>
  );
}
