import { useEffect, useMemo, useState } from 'react';
import CheckCircleRounded from '@mui/icons-material/CheckCircleRounded';
import LinkOffRounded from '@mui/icons-material/LinkOffRounded';
import {
  Alert,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  MenuItem,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import type { AppSecretsState } from '@shared/types';
import type { AppDictionary } from '@renderer/i18n';

interface AppSecretsPanelProps {
  state: AppSecretsState | null;
  busy: boolean;
  t: AppDictionary;
  onConnectSecret: (appSecretName: string, userSecretId: string) => Promise<void>;
  onDisconnectSecret: (appSecretName: string) => Promise<void>;
}

interface AppSecretsDialogProps extends AppSecretsPanelProps {
  open: boolean;
  onClose: () => void;
}

const displaySecretLabel = (name: string) =>
  name
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());

export function AppSecretsPanel({
  state,
  busy,
  t,
  onConnectSecret,
  onDisconnectSecret,
}: AppSecretsPanelProps) {
  const [selectedSecretByAppSecret, setSelectedSecretByAppSecret] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!state) {
      setSelectedSecretByAppSecret({});
      return;
    }
    const next: Record<string, string> = {};
    for (const connection of state.appSecrets) {
      next[connection.appSecret.name] = connection.userSecretId ?? '';
    }
    setSelectedSecretByAppSecret(next);
  }, [state]);

  const requiredCount = useMemo(
    () => state?.appSecrets.filter((connection) => connection.appSecret.required).length ?? 0,
    [state],
  );
  const missingRequired = useMemo(
    () => state?.appSecrets.filter((connection) => connection.appSecret.required && !connection.connected).length ?? 0,
    [state],
  );

  return (
    <Stack spacing={3}>
      {state ? (
        <Alert severity={missingRequired > 0 ? 'warning' : 'success'}>
          {state.appSecrets.length === 0
            ? t.secrets.noAppSecrets
            : missingRequired > 0
              ? t.secrets.missingRequired(missingRequired)
              : t.secrets.ready}
        </Alert>
      ) : null}

      {state && state.appSecrets.length > 0 ? (
        <Stack spacing={1.25}>
          <Stack direction="row" justifyContent="space-between" alignItems="center">
            <Typography variant="h6">{t.secrets.appRequirements}</Typography>
            <Chip
              size="small"
              color={missingRequired > 0 ? 'warning' : 'success'}
              label={t.secrets.requiredSummary(requiredCount, missingRequired)}
            />
          </Stack>

          {state.appSecrets.map((connection) => {
            const declaration = connection.appSecret;
            const selectedSecretId =
              selectedSecretByAppSecret[declaration.name] ?? connection.userSecretId ?? '';
            return (
              <Box
                key={declaration.name}
                sx={{
                  border: '1px solid',
                  borderColor: 'divider',
                  borderRadius: 1,
                  p: 1.5,
                }}
              >
                <Stack spacing={1.25}>
                  <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
                    <Typography variant="subtitle1">
                      {declaration.label ?? displaySecretLabel(declaration.name)}
                    </Typography>
                    <Chip
                      size="small"
                      color={declaration.required ? 'warning' : 'default'}
                      label={declaration.required ? t.secrets.required : t.secrets.optional}
                    />
                    <Chip
                      size="small"
                      color={connection.connected ? 'success' : 'default'}
                      icon={connection.connected ? <CheckCircleRounded /> : undefined}
                      label={connection.connected ? t.secrets.connected : t.secrets.disconnected}
                    />
                  </Stack>
                  <Typography variant="body2" color="text.secondary">
                    {declaration.usage}
                  </Typography>
                  {state.userSecrets.length === 0 ? (
                    <Alert severity="info">{t.secrets.emptyLibrary}</Alert>
                  ) : null}
                  <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems={{ sm: 'center' }}>
                    <TextField
                      select
                      size="small"
                      label={t.secrets.chooseSecret}
                      value={selectedSecretId}
                      onChange={(event) =>
                        setSelectedSecretByAppSecret((current) => ({
                          ...current,
                          [declaration.name]: event.target.value,
                        }))
                      }
                      sx={{ minWidth: 260, flex: 1 }}
                      disabled={busy || state.userSecrets.length === 0}
                    >
                      <MenuItem value="">{t.secrets.noneSelected}</MenuItem>
                      {state.userSecrets.map((secret) => (
                        <MenuItem key={secret.id} value={secret.id}>
                          {secret.name}
                        </MenuItem>
                      ))}
                    </TextField>
                    <Button
                      variant="contained"
                      size="small"
                      disabled={busy || !selectedSecretId}
                      onClick={() => onConnectSecret(declaration.name, selectedSecretId)}
                    >
                      {t.secrets.connect}
                    </Button>
                    <Button
                      variant="outlined"
                      size="small"
                      startIcon={<LinkOffRounded />}
                      disabled={busy || !connection.connected}
                      onClick={() => onDisconnectSecret(declaration.name)}
                    >
                      {t.secrets.disconnect}
                    </Button>
                  </Stack>
                </Stack>
              </Box>
            );
          })}
        </Stack>
      ) : null}
    </Stack>
  );
}

export function AppSecretsDialog({
  open,
  state,
  busy,
  t,
  onClose,
  onConnectSecret,
  onDisconnectSecret,
}: AppSecretsDialogProps) {
  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} fullWidth maxWidth="md">
      <DialogTitle>{state ? t.secrets.dialogTitle(state.appName) : t.secrets.title}</DialogTitle>
      <DialogContent dividers>
        <AppSecretsPanel
          state={state}
          busy={busy}
          t={t}
          onConnectSecret={onConnectSecret}
          onDisconnectSecret={onDisconnectSecret}
        />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>
          {t.secrets.close}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
