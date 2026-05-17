import TerminalRounded from '@mui/icons-material/TerminalRounded';
import RefreshRounded from '@mui/icons-material/RefreshRounded';
import CheckCircleRounded from '@mui/icons-material/CheckCircleRounded';
import RestartAltRounded from '@mui/icons-material/RestartAltRounded';
import {
  Alert,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
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
    ? 'Instalacion administrada por Forger'
    : status.source === 'system'
      ? 'Instalacion existente en este equipo'
      : 'Claude Code no instalado';
  const connectionDetail = status.authenticated
    ? 'Claude Code informa una sesion activa.'
    : status.installed
      ? 'Claude Code esta instalado, pero no informa una sesion activa.'
      : 'Forger puede instalar Claude Code localmente antes de conectar la cuenta.';

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Configurar Claude Code</DialogTitle>
      <DialogContent>
        <Stack spacing={2}>
          <Stack direction="row" spacing={1} alignItems="center">
            <Chip color={status.authenticated ? 'success' : 'default'} label={status.authenticated ? 'Conectado' : 'No conectado'} />
            <Chip variant="outlined" label={sourceLabel} />
          </Stack>
          {status.authenticated ? (
            <Alert severity="success" icon={<CheckCircleRounded />}>
              Claude Code esta listo para usarse desde Forger.
            </Alert>
          ) : null}
          <Typography color="text.secondary">
            Si Claude Code ya esta instalado en este equipo, Forger lo detecta y lo puede usar. Si no existe, Forger instala una copia local con su runtime de Node.
          </Typography>
          <Alert severity="warning">
            <Typography variant="body2">{t.agentProvider.claudeQuotaDisclaimer}</Typography>
          </Alert>
          <Stack spacing={0.75}>
            <Typography variant="body2">
              {connectionDetail}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Version detectada: {status.version?.replace(/\s*\(Claude Code\)\s*/i, '') || 'sin detectar'}
            </Typography>
          </Stack>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cerrar</Button>
        <Button variant="outlined" startIcon={<RefreshRounded />} disabled={busy} onClick={() => void onRefresh()}>
          Actualizar
        </Button>
        <Button variant="outlined" color="warning" startIcon={<RestartAltRounded />} disabled={busy} onClick={() => void onReinstall()}>
          Instalar/Reinstalar
        </Button>
        {!status.authenticated ? (
          <Button variant="contained" startIcon={<TerminalRounded />} disabled={busy} onClick={() => void onConnect()}>
            Conectar Claude
          </Button>
        ) : null}
      </DialogActions>
    </Dialog>
  );
}
