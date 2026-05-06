import { useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Divider,
  Paper,
  Stack,
  Typography,
} from '@mui/material';
import QrCode2Rounded from '@mui/icons-material/QrCode2Rounded';
import RefreshRounded from '@mui/icons-material/RefreshRounded';
import { alpha, useTheme } from '@mui/material/styles';
import type { CloudDevicesState, ForgerAccountSession } from '@shared/types';

interface DevicesViewProps {
  account: ForgerAccountSession;
}

const emptyState: CloudDevicesState = {
  devices: [],
  connected: false,
};

export function DevicesView({ account }: DevicesViewProps) {
  const theme = useTheme();
  const [state, setState] = useState<CloudDevicesState>(emptyState);
  const [busy, setBusy] = useState(false);

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

  const generateCode = async () => {
    setBusy(true);
    try {
      setState(await window.forger.generateDevicePairingCode());
    } finally {
      setBusy(false);
    }
  };

  const currentDevice = state.currentDevice;
  const currentCloudDevice = currentDevice
    ? state.devices.find((device) => device.id === currentDevice.id)
    : undefined;
  const currentDeviceOnline = state.connected || Boolean(currentCloudDevice?.online);
  const pairedDevices = currentDevice
    ? state.devices.filter((device) => device.id !== currentDevice.id)
    : state.devices;

  if (!account.authenticated) {
    return (
      <Stack spacing={2}>
        <Typography variant="h4">Devices</Typography>
        <Alert severity="info">Sign in to Forger Cloud before pairing this desktop.</Alert>
      </Stack>
    );
  }

  return (
    <Stack spacing={3}>
      <Stack direction="row" alignItems="center" justifyContent="space-between" gap={2}>
        <Box>
          <Typography variant="h4">Devices</Typography>
          <Typography color="text.secondary">Pair this desktop and keep remote app access under your Forger Cloud account.</Typography>
        </Box>
        <Button startIcon={<RefreshRounded />} onClick={() => void refresh()} disabled={busy}>
          Refresh
        </Button>
      </Stack>

      {state.userMessage ? (
        <Alert severity={state.technicalCode ? 'error' : 'success'}>{state.userMessage}</Alert>
      ) : null}

      <Paper variant="outlined" sx={{ p: 2, borderRadius: 2 }}>
        <Stack spacing={2}>
          <Stack direction="row" alignItems="center" justifyContent="space-between" gap={2}>
            <Box>
              <Typography variant="h6">This desktop</Typography>
              <Typography color="text.secondary">
                {currentDevice?.name ?? 'Forger Desktop'} · {currentDeviceOnline ? 'Connected' : 'Not connected'}
              </Typography>
            </Box>
            <Chip color={currentDeviceOnline ? 'success' : 'default'} label={currentDeviceOnline ? 'Online' : 'Offline'} />
          </Stack>

          <Divider />

          <Stack direction={{ xs: 'column', sm: 'row' }} alignItems={{ sm: 'center' }} justifyContent="space-between" gap={2}>
            <Box>
              <Typography fontWeight={700}>Pairing code</Typography>
              <Typography color="text.secondary">Enter this code in the Forger Cloud portal while signed in with the same account.</Typography>
            </Box>
            <Button variant="contained" startIcon={busy ? <CircularProgress size={16} color="inherit" /> : <QrCode2Rounded />} onClick={() => void generateCode()} disabled={busy}>
              Generate code
            </Button>
          </Stack>

          {state.pairingCode ? (
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
              {state.pairingCode}
            </Box>
          ) : null}
        </Stack>
      </Paper>

      <Stack spacing={1.5}>
        <Typography variant="h6">Paired devices</Typography>
        {pairedDevices.map((device) => (
          <Paper key={device.id} variant="outlined" sx={{ p: 2, borderRadius: 2 }}>
            <Stack direction="row" justifyContent="space-between" gap={2}>
              <Box>
                <Typography fontWeight={700}>{device.name}</Typography>
                <Typography color="text.secondary">{device.platform ?? 'Desktop'} · {device.installedApps.length} apps</Typography>
              </Box>
              <Chip size="small" color={device.online ? 'success' : 'default'} label={device.online ? 'Online' : 'Offline'} />
            </Stack>
          </Paper>
        ))}
        {pairedDevices.length === 0 ? <Typography color="text.secondary">No other paired devices yet.</Typography> : null}
      </Stack>
    </Stack>
  );
}
