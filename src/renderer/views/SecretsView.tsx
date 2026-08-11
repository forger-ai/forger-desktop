import { useState } from 'react';
import AddRounded from '@mui/icons-material/AddRounded';
import DeleteRounded from '@mui/icons-material/DeleteRounded';
import SaveRounded from '@mui/icons-material/SaveRounded';
import VisibilityOffRounded from '@mui/icons-material/VisibilityOffRounded';
import VisibilityRounded from '@mui/icons-material/VisibilityRounded';
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  InputAdornment,
  Paper,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import type { UserSecretSummary } from '@shared/types';
import type { AppDictionary } from '@renderer/i18n';

interface SecretsViewProps {
  secrets: UserSecretSummary[];
  busy: boolean;
  t: AppDictionary;
  onCreateSecret: (input: { name: string; value: string }) => Promise<void>;
  onUpdateSecret: (input: { id: string; name: string; value?: string }) => Promise<void>;
  onDeleteSecret: (id: string) => Promise<void>;
}

export function SecretsView({
  secrets,
  busy,
  t,
  onCreateSecret,
  onUpdateSecret,
  onDeleteSecret,
}: SecretsViewProps) {
  const [newSecretName, setNewSecretName] = useState('');
  const [newSecretValue, setNewSecretValue] = useState('');
  const [showNewSecretValue, setShowNewSecretValue] = useState(false);
  const [editingSecret, setEditingSecret] = useState<UserSecretSummary | null>(null);
  const [editSecretName, setEditSecretName] = useState('');
  const [editSecretValue, setEditSecretValue] = useState('');
  const [showEditSecretValue, setShowEditSecretValue] = useState(false);

  const handleCreate = async () => {
    await onCreateSecret({ name: newSecretName, value: newSecretValue });
    setNewSecretName('');
    setNewSecretValue('');
    setShowNewSecretValue(false);
  };

  const handleUpdate = async () => {
    const secret = editingSecret!;
    await onUpdateSecret({
      id: secret.id,
      name: editSecretName,
      ...(editSecretValue ? { value: editSecretValue } : {}),
    });
    setEditingSecret(null);
    setEditSecretName('');
    setEditSecretValue('');
    setShowEditSecretValue(false);
  };

  const closeEditDialog = () => {
    setEditingSecret(null);
    setEditSecretName('');
    setEditSecretValue('');
    setShowEditSecretValue(false);
  };

  const startEditing = (secret: UserSecretSummary) => {
    setEditingSecret(secret);
    setEditSecretName(secret.name);
    setEditSecretValue('');
    setShowEditSecretValue(false);
  };

  return (
    <Stack spacing={2}>
      <Stack spacing={0.5}>
        <Typography variant="h4">{t.sections.secrets.title}</Typography>
        <Typography color="text.secondary">{t.sections.secrets.subtitle}</Typography>
      </Stack>

      <Card>
        <CardContent>
          <Stack spacing={1.5}>
            <Typography variant="h6">{t.secrets.libraryTitle}</Typography>
            <Stack direction={{ xs: 'column', md: 'row' }} spacing={1}>
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
                type={showNewSecretValue ? 'text' : 'password'}
                label={t.secrets.secretValue}
                value={newSecretValue}
                onChange={(event) => setNewSecretValue(event.target.value)}
                disabled={busy}
                sx={{ flex: 1 }}
                slotProps={{
                  input: {
                    endAdornment: (
                      <InputAdornment position="end">
                        <IconButton
                          edge="end"
                          size="small"
                          aria-label={showNewSecretValue ? 'Hide secret value' : 'Show secret value'}
                          onClick={() => setShowNewSecretValue((current) => !current)}
                        >
                          {showNewSecretValue ? <VisibilityOffRounded fontSize="small" /> : <VisibilityRounded fontSize="small" />}
                        </IconButton>
                      </InputAdornment>
                    ),
                  },
                }}
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

          </Stack>
        </CardContent>
      </Card>

      <Stack spacing={1.25}>
        <Typography variant="h6">{t.sections.secrets.savedTitle}</Typography>
        {secrets.length === 0 ? (
          <Alert severity="info">{t.sections.secrets.empty}</Alert>
        ) : null}
        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: { xs: '1fr', md: 'repeat(2, minmax(0, 1fr))' },
            gap: 1.25,
          }}
        >
          {secrets.map((secret) => (
            <Paper
              key={secret.id}
              variant="outlined"
              sx={{
                p: 1.5,
                borderRadius: 1,
                minHeight: 76,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 2,
              }}
            >
              <Stack spacing={0.25} sx={{ minWidth: 0 }}>
                <Typography variant="body2" fontWeight={650} noWrap>
                  {secret.name}
                </Typography>
              </Stack>
              <Stack direction="row" spacing={0.5} alignItems="center" sx={{ flexShrink: 0 }}>
                <Button size="small" disabled={busy} onClick={() => startEditing(secret)}>
                  {t.secrets.edit}
                </Button>
                <Tooltip title={t.secrets.delete}>
                  <span>
                    <IconButton
                      size="small"
                      color="error"
                      disabled={busy}
                      aria-label={t.secrets.delete}
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
            </Paper>
          ))}
        </Box>
      </Stack>

      <Dialog open={Boolean(editingSecret)} onClose={busy ? undefined : closeEditDialog} fullWidth maxWidth="sm">
        <DialogTitle>{t.secrets.editDialogTitle}</DialogTitle>
        <DialogContent>
          <Stack spacing={1.5} sx={{ pt: 1 }}>
            <TextField
              autoFocus
              label={t.secrets.secretName}
              value={editSecretName}
              onChange={(event) => setEditSecretName(event.target.value)}
              disabled={busy}
              fullWidth
            />
            <TextField
              type={showEditSecretValue ? 'text' : 'password'}
              label={t.secrets.newSecretValue}
              value={editSecretValue}
              onChange={(event) => setEditSecretValue(event.target.value)}
              disabled={busy}
              fullWidth
              slotProps={{
                input: {
                  endAdornment: (
                    <InputAdornment position="end">
                      <IconButton
                        edge="end"
                        size="small"
                        aria-label={showEditSecretValue ? 'Hide secret value' : 'Show secret value'}
                        onClick={() => setShowEditSecretValue((current) => !current)}
                      >
                        {showEditSecretValue ? <VisibilityOffRounded fontSize="small" /> : <VisibilityRounded fontSize="small" />}
                      </IconButton>
                    </InputAdornment>
                  ),
                },
              }}
            />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button variant="outlined" disabled={busy} onClick={closeEditDialog}>
            {t.secrets.cancel}
          </Button>
          <Button
            variant="contained"
            startIcon={<SaveRounded />}
            disabled={busy || !editSecretName.trim()}
            onClick={() => void handleUpdate()}
          >
            {t.secrets.update}
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}
