import { useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Paper,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import CheckRounded from '@mui/icons-material/CheckRounded';
import CloseRounded from '@mui/icons-material/CloseRounded';
import DeleteOutlineRounded from '@mui/icons-material/DeleteOutlineRounded';
import EditRounded from '@mui/icons-material/EditRounded';
import LinkOffRounded from '@mui/icons-material/LinkOffRounded';
import RefreshRounded from '@mui/icons-material/RefreshRounded';
import { alpha, useTheme } from '@mui/material/styles';
import type { CloudDevicesState, ForgerAccountSession } from '@shared/types';
import type { AppDictionary } from '@renderer/i18n';

interface DevicesViewProps {
  account: ForgerAccountSession;
  t: AppDictionary;
}

const emptyState: CloudDevicesState = {
  devices: [],
  connected: false,
};

export function DevicesView({ account, t }: DevicesViewProps) {
  const theme = useTheme();
  const [state, setState] = useState<CloudDevicesState>(emptyState);
  const [busy, setBusy] = useState(false);
  const [editNameOpen, setEditNameOpen] = useState(false);
  const [unlinkAuthorizationId, setUnlinkAuthorizationId] = useState<number | null>(null);
  const [deviceNameDraft, setDeviceNameDraft] = useState('');

  const refresh = async () => {
    setBusy(true);
    try {
      setState(await window.forger.getCloudDevices());
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const openEditName = () => {
    setDeviceNameDraft(currentDevice!.name);
    setEditNameOpen(true);
  };

  const updateDeviceName = async () => {
    setBusy(true);
    try {
      setState(await window.forger.updateCloudDeviceName({ name: deviceNameDraft }));
      setEditNameOpen(false);
    } finally {
      setBusy(false);
    }
  };

  const acceptPairing = async (requestId: number) => {
    setBusy(true);
    try {
      setState(await window.forger.acceptMobilePairingRequest(requestId));
    } finally {
      setBusy(false);
    }
  };

  const rejectPairing = async (requestId: number) => {
    setBusy(true);
    try {
      setState(await window.forger.rejectMobilePairingRequest(requestId));
    } finally {
      setBusy(false);
    }
  };

  const deletePairingRequest = async (requestId: number) => {
    setBusy(true);
    try {
      setState(await window.forger.deleteMobilePairingRequest(requestId));
    } finally {
      setBusy(false);
    }
  };

  const unlinkMobileDevice = async () => {
    const authorizationId = unlinkAuthorizationId!;
    setBusy(true);
    try {
      setState(await window.forger.unlinkMobileDeviceFromDesktop(authorizationId));
      setUnlinkAuthorizationId(null);
    } finally {
      setBusy(false);
    }
  };

  const currentDevice = state.currentDevice;
  const currentCloudDevice = currentDevice
    ? state.devices.find((device) => device.id === currentDevice.id)
    : undefined;
  const currentDeviceOnline = state.connected || Boolean(currentCloudDevice?.online);
  const pairingRequests = state.pairingRequests ?? [];
  const mobileAuthorizations = state.mobileDesktopAuthorizations ?? [];
  const connectedMobileDeviceIds = new Set(mobileAuthorizations.map((authorization) => authorization.mobileDeviceId));
  const pairedDevices = currentDevice
    ? state.devices.filter((device) => device.id !== currentDevice.id && !connectedMobileDeviceIds.has(device.id))
    : state.devices.filter((device) => !connectedMobileDeviceIds.has(device.id));
  const unlinkAuthorization = mobileAuthorizations.find((authorization) => authorization.id === unlinkAuthorizationId);

  if (!account.authenticated) {
    return (
      <Stack spacing={2}>
        <Typography variant="h4">{t.sections.devices.title}</Typography>
        <Alert severity="info">{t.sections.devices.signInRequired}</Alert>
      </Stack>
    );
  }

  return (
    <Stack spacing={3}>
      <Stack direction="row" alignItems="center" justifyContent="space-between" gap={2}>
        <Box>
          <Typography variant="h4">{t.sections.devices.title}</Typography>
          <Typography color="text.secondary">{t.sections.devices.subtitle}</Typography>
        </Box>
        <Button startIcon={<RefreshRounded />} onClick={() => void refresh()} disabled={busy}>
          {t.sections.devices.refresh}
        </Button>
      </Stack>

      {state.userMessage ? (
        <Alert severity={state.technicalCode ? 'error' : 'success'}>{state.userMessage}</Alert>
      ) : null}

      <Paper variant="outlined" sx={{ p: 2, borderRadius: 2 }}>
        <Stack spacing={2}>
          <Stack direction="row" alignItems="center" justifyContent="space-between" gap={2}>
            <Box>
              <Typography variant="h6">{t.sections.devices.thisDesktop}</Typography>
              <Typography color="text.secondary">
                {currentDevice?.name ?? t.sections.devices.fallbackDesktopName} · {currentDeviceOnline ? t.sections.devices.connected : t.sections.devices.notConnected}
              </Typography>
            </Box>
            <Stack direction="row" alignItems="center" gap={1}>
              {currentDevice ? (
                <Button size="small" startIcon={<EditRounded />} onClick={openEditName} disabled={busy}>
                  {t.sections.devices.editDesktopName}
                </Button>
              ) : null}
              <Chip color={currentDeviceOnline ? 'success' : 'default'} label={currentDeviceOnline ? t.sections.devices.online : t.sections.devices.offline} />
            </Stack>
          </Stack>
        </Stack>
      </Paper>

      {currentDevice ? (
        <Stack spacing={1.5}>
          <Typography variant="h6">{t.sections.devices.mobileAccessRequests}</Typography>
          {pairingRequests.map((request) => {
            const canDeleteRequest = request.status === 'confirmed' || request.status === 'rejected' || request.status === 'expired';
            return (
              <Paper key={request.id} variant="outlined" sx={{ p: 2, borderRadius: 2 }}>
                <Stack spacing={2}>
                  <Stack direction="row" justifyContent="space-between" gap={2}>
                    <Box>
                      <Typography fontWeight={700}>{request.mobileDevice.name}</Typography>
                      <Typography color="text.secondary">{request.mobileDevice.platform ?? 'Mobile'} · {request.status}</Typography>
                    </Box>
                    <Chip size="small" color={request.status === 'pending' ? 'warning' : request.status === 'accepted' ? 'success' : 'default'} label={request.status} />
                  </Stack>
                  {request.code ? (
                    <Box
                      sx={{
                        display: 'inline-flex',
                        alignSelf: 'flex-start',
                        px: 2,
                        py: 1.2,
                        borderRadius: 1.5,
                        bgcolor: alpha(theme.palette.primary.main, theme.palette.mode === 'dark' ? 0.16 : 0.08),
                        border: `1px solid ${alpha(theme.palette.primary.main, theme.palette.mode === 'dark' ? 0.34 : 0.2)}`,
                        color: theme.palette.mode === 'dark' ? theme.palette.primary.light : theme.palette.primary.dark,
                        letterSpacing: '0.16em',
                        fontSize: 28,
                        fontWeight: 800,
                      }}
                    >
                      {request.code}
                    </Box>
                  ) : null}
                  {request.status === 'pending' ? (
                    <Stack direction="row" gap={1}>
                      <Button variant="contained" startIcon={<CheckRounded />} disabled={busy} onClick={() => void acceptPairing(request.id)}>Authorize</Button>
                      <Button variant="outlined" startIcon={<CloseRounded />} disabled={busy} onClick={() => void rejectPairing(request.id)}>Reject</Button>
                    </Stack>
                  ) : null}
                  {canDeleteRequest ? (
                    <Stack direction="row" gap={1}>
                      <Button variant="outlined" color="inherit" startIcon={<DeleteOutlineRounded />} disabled={busy} onClick={() => void deletePairingRequest(request.id)}>
                        {t.sections.devices.deleteRequest}
                      </Button>
                    </Stack>
                  ) : null}
                </Stack>
              </Paper>
            );
          })}
          {pairingRequests.length === 0 ? <Typography color="text.secondary">{t.sections.devices.noMobileAccessRequests}</Typography> : null}
        </Stack>
      ) : null}

      {currentDevice ? (
        <Stack spacing={1.5}>
          <Box>
            <Typography variant="h6">{t.sections.devices.connectedMobileDevices}</Typography>
            <Typography color="text.secondary">{t.sections.devices.connectedMobileDevicesBody}</Typography>
          </Box>
          {mobileAuthorizations.map((authorization) => (
            <Paper key={authorization.id} variant="outlined" sx={{ p: 2, borderRadius: 2 }}>
              <Stack direction={{ xs: 'column', sm: 'row' }} alignItems={{ sm: 'center' }} justifyContent="space-between" gap={2}>
                <Box>
                  <Typography fontWeight={700}>{authorization.mobileDevice.name}</Typography>
                  <Typography color="text.secondary">
                    {authorization.mobileDevice.platform ?? 'Mobile'} · {authorization.mobileDevice.online ? t.sections.devices.online : t.sections.devices.offline}
                  </Typography>
                </Box>
                <Button
                  color="error"
                  disabled={busy}
                  startIcon={<LinkOffRounded />}
                  variant="outlined"
                  onClick={() => setUnlinkAuthorizationId(authorization.id)}
                >
                  {t.sections.devices.unlinkMobile}
                </Button>
              </Stack>
            </Paper>
          ))}
          {mobileAuthorizations.length === 0 ? <Typography color="text.secondary">{t.sections.devices.noConnectedMobileDevices}</Typography> : null}
        </Stack>
      ) : null}

      <Stack spacing={1.5}>
        <Typography variant="h6">{t.sections.devices.pairedDevices}</Typography>
        {pairedDevices.map((device) => (
          <Paper key={device.id} variant="outlined" sx={{ p: 2, borderRadius: 2 }}>
            <Stack direction="row" justifyContent="space-between" gap={2}>
              <Box>
                <Typography fontWeight={700}>{device.name}</Typography>
                <Typography color="text.secondary">{device.platform ?? t.sections.devices.desktopPlatform} · {t.sections.devices.appsCount(device.installedApps.length)}</Typography>
              </Box>
              <Chip size="small" color={device.online ? 'success' : 'default'} label={device.online ? t.sections.devices.online : t.sections.devices.offline} />
            </Stack>
          </Paper>
        ))}
        {pairedDevices.length === 0 ? <Typography color="text.secondary">{t.sections.devices.noPairedDevices}</Typography> : null}
      </Stack>

      <Dialog open={editNameOpen} onClose={() => setEditNameOpen(false)} fullWidth maxWidth="xs">
        <DialogTitle>{t.sections.devices.editDesktopNameTitle}</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            fullWidth
            label={t.sections.devices.desktopNameLabel}
            margin="dense"
            placeholder={t.sections.devices.fallbackDesktopName}
            value={deviceNameDraft}
            onChange={(event) => setDeviceNameDraft(event.target.value)}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setEditNameOpen(false)} disabled={busy}>{t.sections.devices.desktopNameCancel}</Button>
          <Button variant="contained" onClick={() => void updateDeviceName()} disabled={busy}>
            {t.sections.devices.desktopNameSave}
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={Boolean(unlinkAuthorization)} onClose={() => setUnlinkAuthorizationId(null)} fullWidth maxWidth="xs">
        <DialogTitle>{t.sections.devices.unlinkMobileTitle}</DialogTitle>
        <DialogContent>
          <Typography color="text.secondary">
            {t.sections.devices.unlinkMobileBody(unlinkAuthorization?.mobileDevice.name ?? 'Mobile')}
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setUnlinkAuthorizationId(null)} disabled={busy}>{t.sections.devices.unlinkMobileCancel}</Button>
          <Button color="error" variant="contained" onClick={() => void unlinkMobileDevice()} disabled={busy}>
            {t.sections.devices.unlinkMobileConfirm}
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}
