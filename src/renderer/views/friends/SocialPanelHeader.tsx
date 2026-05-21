import type { SyntheticEvent } from 'react';
import CloseRounded from '@mui/icons-material/CloseRounded';
import EditRounded from '@mui/icons-material/EditRounded';
import SaveRounded from '@mui/icons-material/SaveRounded';
import {
  Box,
  CircularProgress,
  IconButton,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import type { ForgerAccountSession } from '@shared/types';

interface SocialPanelHeaderProps {
  account: ForgerAccountSession;
  accountBusy: boolean;
  accountUsername?: string;
  editingUsername: boolean;
  launcherBusy: boolean;
  profileUsername: string;
  profileUsernameError: string | null;
  tabSubtitle: string;
  usernameAvailableDate: string | null;
  usernameChangeBlocked: boolean;
  canUpdateUsername: boolean;
  onCancelUsernameEdit: () => void;
  onEditingUsernameChange: (editing: boolean) => void;
  onProfileUsernameChange: (username: string) => void;
  onProfileUsernameErrorChange: (error: string | null) => void;
  onUsernameSubmit: (event?: SyntheticEvent) => void;
}

export function SocialPanelHeader({
  account,
  accountBusy,
  accountUsername,
  editingUsername,
  launcherBusy,
  profileUsername,
  profileUsernameError,
  tabSubtitle,
  usernameAvailableDate,
  usernameChangeBlocked,
  canUpdateUsername,
  onCancelUsernameEdit,
  onEditingUsernameChange,
  onProfileUsernameChange,
  onProfileUsernameErrorChange,
  onUsernameSubmit,
}: SocialPanelHeaderProps) {
  return (
    <Stack spacing={0.5} sx={{ px: 2, pt: 1.8, pb: 1.4 }}>
      <Stack direction="row" alignItems="center" spacing={1}>
        <Typography variant="subtitle1" sx={{ fontWeight: 700, flex: 1 }}>
          Social
        </Typography>
        {launcherBusy ? <CircularProgress size={16} /> : null}
      </Stack>
      <Stack spacing={0.25}>
        <Typography variant="body2" color="text.secondary">
          {tabSubtitle}
        </Typography>
        {editingUsername ? (
          <Box component="form" onSubmit={(event) => onUsernameSubmit(event)} sx={{ pt: 0.5 }}>
            <Stack direction="row" spacing={0.75} alignItems="flex-start">
              <TextField
                size="small"
                value={profileUsername}
                onChange={(event) => {
                  onProfileUsernameChange(event.target.value);
                  onProfileUsernameErrorChange(null);
                }}
                placeholder="@username"
                error={Boolean(profileUsernameError)}
                helperText={profileUsernameError ?? 'Letras, numeros o guion bajo.'}
                disabled={accountBusy}
                inputProps={{ 'aria-label': 'Nuevo username' }}
                sx={{ flex: 1 }}
              />
              <Tooltip title="Guardar username">
                <span>
                  <IconButton
                    type="submit"
                    size="small"
                    color="primary"
                    disabled={accountBusy || !profileUsername.trim()}
                    sx={{ mt: 0.35 }}
                  >
                    {accountBusy ? <CircularProgress size={16} /> : <SaveRounded fontSize="small" />}
                  </IconButton>
                </span>
              </Tooltip>
              <Tooltip title="Cancelar">
                <span>
                  <IconButton
                    size="small"
                    onClick={onCancelUsernameEdit}
                    disabled={accountBusy}
                    sx={{ mt: 0.35 }}
                  >
                    <CloseRounded fontSize="small" />
                  </IconButton>
                </span>
              </Tooltip>
            </Stack>
          </Box>
        ) : (
          <Stack direction="row" spacing={0.75} alignItems="center" sx={{ minWidth: 0 }}>
            <Typography variant="caption" color="text.secondary" noWrap sx={{ minWidth: 0 }}>
              {accountUsername ? `Tu username: @${accountUsername}` : 'Tu cuenta no tiene username visible'}
            </Typography>
            {account.authenticated && account.user?.confirmed && canUpdateUsername ? (
              <Tooltip
                title={
                  usernameChangeBlocked && usernameAvailableDate
                    ? `Disponible desde el ${usernameAvailableDate}`
                    : 'Cambiar username'
                }
              >
                <span>
                  <IconButton
                    size="small"
                    aria-label="Cambiar username"
                    onClick={() => onEditingUsernameChange(true)}
                    disabled={accountBusy || usernameChangeBlocked}
                    sx={{ width: 24, height: 24, flexShrink: 0 }}
                  >
                    <EditRounded sx={{ fontSize: 16 }} />
                  </IconButton>
                </span>
              </Tooltip>
            ) : null}
          </Stack>
        )}
        {usernameChangeBlocked && usernameAvailableDate && !editingUsername ? (
          <Typography variant="caption" color="text.secondary">
            Puedes cambiarlo desde el {usernameAvailableDate}.
          </Typography>
        ) : null}
      </Stack>
    </Stack>
  );
}
