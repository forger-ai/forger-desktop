import { useEffect, useMemo, useState } from 'react';
import AddRounded from '@mui/icons-material/AddRounded';
import CheckCircleRounded from '@mui/icons-material/CheckCircleRounded';
import DeleteRounded from '@mui/icons-material/DeleteRounded';
import LinkOffRounded from '@mui/icons-material/LinkOffRounded';
import SaveRounded from '@mui/icons-material/SaveRounded';
import {
  Alert,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  IconButton,
  MenuItem,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import type { AppSecretsState, UserSecretSummary } from '@shared/types';
import type { AppDictionary } from '@renderer/i18n';

interface AppSecretsDialogProps {
  open: boolean;
  state: AppSecretsState | null;
  busy: boolean;
  t: AppDictionary;
  onClose: () => void;
  onCreateSecret: (input: { name: string; value: string }) => Promise<void>;
  onUpdateSecret: (input: { id: string; name: string; value?: string }) => Promise<void>;
  onDeleteSecret: (id: string) => Promise<void>;
  onConnectSecret: (appSecretName: string, userSecretId: string) => Promise<void>;
  onDisconnectSecret: (appSecretName: string) => Promise<void>;
}

const displaySecretLabel = (name: string) =>
  name
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());

export function AppSecretsDialog({
  open,
  state,
  busy,
  t,
  onClose,
  onCreateSecret,
  onUpdateSecret,
  onDeleteSecret,
  onConnectSecret,
  onDisconnectSecret,
}: AppSecretsDialogProps) {
  const [newSecretName, setNewSecretName] = useState('');
  const [newSecretValue, setNewSecretValue] = useState('');
  const [editingSecret, setEditingSecret] = useState<UserSecretSummary | null>(null);
  const [editSecretName, setEditSecretName] = useState('');
  const [editSecretValue, setEditSecretValue] = useState('');
  const [selectedSecretByAppSecret, setSelectedSecretByAppSecret] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!open) {
      setNewSecretName('');
      setNewSecretValue('');
      setEditingSecret(null);
      setEditSecretName('');
      setEditSecretValue('');
      setSelectedSecretByAppSecret({});
    }
  }, [open]);

  useEffect(() => {
    if (!state) {
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

  const handleCreate = async () => {
    await onCreateSecret({ name: newSecretName, value: newSecretValue });
    setNewSecretName('');
    setNewSecretValue('');
  };

  const handleUpdate = async () => {
    if (!editingSecret) {
      return;
    }
    await onUpdateSecret({
      id: editingSecret.id,
      name: editSecretName,
      ...(editSecretValue ? { value: editSecretValue } : {}),
    });
    setEditingSecret(null);
    setEditSecretName('');
    setEditSecretValue('');
  };

  const startEditing = (secret: UserSecretSummary) => {
    setEditingSecret(secret);
    setEditSecretName(secret.name);
    setEditSecretValue('');
  };

  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} fullWidth maxWidth="md">
      <DialogTitle>{state ? t.secrets.dialogTitle(state.appName) : t.secrets.title}</DialogTitle>
      <DialogContent dividers>
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
                      <Typography variant="caption" color="text.secondary">
                        {t.secrets.envLabel}: {connection.envName}
                      </Typography>
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

          <Divider />

          <Stack spacing={1.5}>
            <Typography variant="h6">{t.secrets.libraryTitle}</Typography>
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
              <TextField
                size="small"
                label={t.secrets.secretName}
                value={newSecretName}
                onChange={(event) => setNewSecretName(event.target.value)}
                disabled={busy}
                sx={{ flex: 1 }}
              />
              <TextField
                size="small"
                type="password"
                label={t.secrets.secretValue}
                value={newSecretValue}
                onChange={(event) => setNewSecretValue(event.target.value)}
                disabled={busy}
                sx={{ flex: 1 }}
              />
              <Button
                variant="contained"
                startIcon={<AddRounded />}
                disabled={busy || !newSecretName.trim() || !newSecretValue}
                onClick={() => void handleCreate()}
              >
                {t.secrets.save}
              </Button>
            </Stack>

            {editingSecret ? (
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
                <TextField
                  size="small"
                  label={t.secrets.secretName}
                  value={editSecretName}
                  onChange={(event) => setEditSecretName(event.target.value)}
                  disabled={busy}
                  sx={{ flex: 1 }}
                />
                <TextField
                  size="small"
                  type="password"
                  label={t.secrets.newSecretValue}
                  value={editSecretValue}
                  onChange={(event) => setEditSecretValue(event.target.value)}
                  disabled={busy}
                  sx={{ flex: 1 }}
                />
                <Button
                  variant="contained"
                  startIcon={<SaveRounded />}
                  disabled={busy || !editSecretName.trim()}
                  onClick={() => void handleUpdate()}
                >
                  {t.secrets.update}
                </Button>
                <Button variant="outlined" disabled={busy} onClick={() => setEditingSecret(null)}>
                  {t.secrets.cancel}
                </Button>
              </Stack>
            ) : null}

            <Stack spacing={0.75}>
              {state && state.userSecrets.length === 0 ? (
                <Typography variant="body2" color="text.secondary">
                  {t.secrets.emptyLibrary}
                </Typography>
              ) : null}
              {state?.userSecrets.map((secret) => (
                <Stack
                  key={secret.id}
                  direction="row"
                  alignItems="center"
                  justifyContent="space-between"
                  sx={{ borderBottom: '1px solid', borderColor: 'divider', py: 0.75 }}
                >
                  <Stack spacing={0.25}>
                    <Typography variant="body2">{secret.name}</Typography>
                    <Typography variant="caption" color="text.secondary">
                      {t.secrets.updatedAt(new Date(secret.updatedAt).toLocaleString())}
                    </Typography>
                  </Stack>
                  <Stack direction="row" spacing={0.5}>
                    <Button size="small" disabled={busy} onClick={() => startEditing(secret)}>
                      {t.secrets.edit}
                    </Button>
                    <Tooltip title={t.secrets.delete}>
                      <span>
                        <IconButton
                          size="small"
                          color="error"
                          disabled={busy}
                          onClick={() => {
                            if (window.confirm(t.secrets.deleteConfirm(secret.name))) {
                              void onDeleteSecret(secret.id);
                            }
                          }}
                        >
                          <DeleteRounded fontSize="small" />
                        </IconButton>
                      </span>
                    </Tooltip>
                  </Stack>
                </Stack>
              ))}
            </Stack>
          </Stack>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>
          {t.secrets.close}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
