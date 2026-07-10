import BatteryChargingFullRounded from '@mui/icons-material/BatteryChargingFullRounded';
import BatteryUnknownRounded from '@mui/icons-material/BatteryUnknownRounded';
import DeleteOutlineRounded from '@mui/icons-material/DeleteOutlineRounded';
import MicRounded from '@mui/icons-material/MicRounded';
import PlayArrowRounded from '@mui/icons-material/PlayArrowRounded';
import RefreshRounded from '@mui/icons-material/RefreshRounded';
import SendRounded from '@mui/icons-material/SendRounded';
import StopRounded from '@mui/icons-material/StopRounded';
import UsbRounded from '@mui/icons-material/UsbRounded';
import {
  Alert,
  Box,
  Button,
  Chip,
  Divider,
  MenuItem,
  Paper,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { useEffect, useMemo, useState } from 'react';

import type { SidekickMicrophoneRecordingSummary, SidekickState, SidekickStatus, SidekickSummary, SidekickUsbDevice } from '@shared/types';
import type { AppDictionary } from '@renderer/i18n';

interface SidekicksViewProps {
  t: AppDictionary;
}

const emptyState: SidekickState = {
  desktopId: '',
  sidekicks: [],
  detectedUsb: [],
};

const statusColor = (status: SidekickStatus): 'default' | 'primary' | 'success' | 'warning' | 'error' =>
  status === 'online'
    ? 'success'
    : status === 'pairing' || status === 'wifi_pending'
      ? 'warning'
      : status === 'error'
        ? 'error'
        : status === 'usb_detected'
          ? 'primary'
          : 'default';

const usbLabel = (device: SidekickUsbDevice): string => {
  const details = [device.manufacturer, device.vendorId && device.productId ? `${device.vendorId}:${device.productId}` : undefined]
    .filter(Boolean)
    .join(' · ');
  return details ? `${device.path} · ${details}` : device.path;
};

const formatDate = (value?: string): string => {
  if (!value) {
    return '—';
  }
  return new Date(value).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
};

const formatDuration = (durationMs: number): string => {
  const seconds = Math.max(0, Math.round(durationMs / 1000));
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return minutes > 0 ? `${minutes}:${remainder.toString().padStart(2, '0')}` : `0:${remainder.toString().padStart(2, '0')}`;
};

const formatBytes = (bytes: number): string => {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

function SidekickDisplayControls({
  sidekick,
  copy,
  busy,
  onSend,
}: {
  sidekick: SidekickSummary;
  copy: AppDictionary['sections']['sidekicks'];
  busy: boolean;
  onSend: (sidekickId: string, mode: 'append' | 'set' | 'clear', text?: string) => Promise<void>;
}) {
  const [text, setText] = useState<string>(copy.defaultDisplayText);
  const connected = sidekick.status === 'online';
  return (
    <Stack spacing={1.25}>
      <TextField
        label={copy.displayTextLabel}
        value={text}
        onChange={(event) => setText(event.target.value)}
        multiline
        minRows={3}
        disabled={!connected || busy}
        fullWidth
      />
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
        <Button
          variant="contained"
          startIcon={<SendRounded />}
          disabled={!connected || busy}
          onClick={() => void onSend(sidekick.sidekickId, 'set', text)}
        >
          {copy.displaySet}
        </Button>
        <Button
          variant="outlined"
          startIcon={<SendRounded />}
          disabled={!connected || busy}
          onClick={() => void onSend(sidekick.sidekickId, 'append', text)}
        >
          {copy.displayAppend}
        </Button>
        <Button
          variant="outlined"
          disabled={!connected || busy}
          onClick={() => void onSend(sidekick.sidekickId, 'clear')}
        >
          {copy.displayClear}
        </Button>
      </Stack>
    </Stack>
  );
}

function SidekickBatteryChip({
  sidekick,
  copy,
}: {
  sidekick: SidekickSummary;
  copy: AppDictionary['sections']['sidekicks'];
}) {
  const battery = sidekick.battery;
  if (!battery) {
    return (
      <Chip
        size="small"
        variant="outlined"
        icon={<BatteryUnknownRounded />}
        label={copy.batteryUnknown}
        sx={{ color: 'text.disabled', borderColor: 'divider' }}
      />
    );
  }
  const low = battery.levelPercent <= 20 && !battery.charging;
  return (
    <Chip
      size="small"
      color={low ? 'warning' : 'default'}
      variant={low ? 'filled' : 'outlined'}
      icon={battery.charging ? <BatteryChargingFullRounded /> : undefined}
      label={`${battery.levelPercent}%${battery.charging ? ` · ${copy.batteryCharging}` : ''}`}
    />
  );
}

function SidekickRecordingItem({
  sidekickId,
  recording,
  copy,
}: {
  sidekickId: string;
  recording: SidekickMicrophoneRecordingSummary;
  copy: AppDictionary['sections']['sidekicks'];
}) {
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => () => {
    if (audioUrl) {
      URL.revokeObjectURL(audioUrl);
    }
  }, [audioUrl]);

  const loadAudio = async () => {
    if (audioUrl || loading) {
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await window.forger.sidekicksReadMicrophoneRecording({
        sidekickId,
        recordingId: recording.recordingId,
      });
      if (!result.success || !result.bytes || !result.mimeType) {
        setError(result.userMessage ?? copy.playbackError);
        return;
      }
      const audioBuffer = new ArrayBuffer(result.bytes.byteLength);
      new Uint8Array(audioBuffer).set(result.bytes);
      const blob = new Blob([audioBuffer], { type: result.mimeType });
      setAudioUrl(URL.createObjectURL(blob));
    } catch {
      setError(copy.playbackError);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Stack spacing={0.75} sx={{ py: 1 }}>
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} justifyContent="space-between">
        <Typography variant="body2" fontWeight={600}>{formatDate(recording.createdAt)}</Typography>
        <Typography variant="body2" color="text.secondary">
          {copy.recordingMeta(formatDuration(recording.durationMs), formatBytes(recording.sizeBytes))}
        </Typography>
      </Stack>
      {audioUrl ? (
        <Box component="audio" controls src={audioUrl} sx={{ width: '100%' }} />
      ) : (
        <Button
          size="small"
          variant="outlined"
          startIcon={<PlayArrowRounded />}
          onClick={() => void loadAudio()}
          disabled={loading}
          sx={{ alignSelf: 'flex-start' }}
        >
          {loading ? copy.playbackLoading : copy.playbackLoad}
        </Button>
      )}
      {error ? <Typography variant="body2" color="error">{error}</Typography> : null}
    </Stack>
  );
}

function SidekickMicrophoneControls({
  sidekick,
  copy,
  busy,
  actionError,
  onStart,
  onStop,
}: {
  sidekick: SidekickSummary;
  copy: AppDictionary['sections']['sidekicks'];
  busy: boolean;
  actionError?: string;
  onStart: (sidekickId: string) => Promise<void>;
  onStop: (sidekickId: string) => Promise<void>;
}) {
  const connected = sidekick.status === 'online';
  const capable = sidekick.capabilities.includes('microphone.record');
  const recordingState = sidekick.microphoneRecording;
  const active = recordingState.status === 'recording' || recordingState.status === 'stopping';
  const pending = recordingState.status === 'starting' || recordingState.status === 'stopping';
  const disabled = busy || pending || !connected || !capable;
  const disabledReason = !connected
    ? copy.microphoneOffline
    : !capable
      ? copy.microphoneUnsupported
      : undefined;
  const currentError = actionError ?? recordingState.errorMessage;

  return (
    <Stack spacing={1.25}>
      <Stack direction={{ xs: 'column', sm: 'row' }} alignItems={{ xs: 'stretch', sm: 'center' }} justifyContent="space-between" spacing={1}>
        <Box>
          <Typography variant="subtitle2">{copy.microphoneTitle}</Typography>
          <Typography variant="body2" color={currentError ? 'error' : 'text.secondary'}>
            {currentError ?? disabledReason ?? copy.microphoneStates[recordingState.status]}
          </Typography>
        </Box>
        <Button
          variant={active ? 'outlined' : 'contained'}
          color={active ? 'error' : 'primary'}
          startIcon={active ? <StopRounded /> : <MicRounded />}
          disabled={disabled}
          onClick={() => void (active ? onStop(sidekick.sidekickId) : onStart(sidekick.sidekickId))}
        >
          {active ? copy.microphoneStop : copy.microphoneStart}
        </Button>
      </Stack>
      {sidekick.microphoneRecordings.length === 0 ? (
        <Typography variant="body2" color="text.secondary">{copy.noRecordings}</Typography>
      ) : (
        <Stack divider={<Divider flexItem />}>
          {sidekick.microphoneRecordings.map((recording) => (
            <SidekickRecordingItem
              key={recording.recordingId}
              sidekickId={sidekick.sidekickId}
              recording={recording}
              copy={copy}
            />
          ))}
        </Stack>
      )}
    </Stack>
  );
}

export function SidekicksView({ t }: SidekicksViewProps) {
  const copy = t.sections.sidekicks;
  const [state, setState] = useState<SidekickState>(emptyState);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState<string>(copy.defaultName);
  const [portPath, setPortPath] = useState('');
  const [ssid, setSsid] = useState('');
  const [password, setPassword] = useState('');
  const [notice, setNotice] = useState<{ severity: 'success' | 'error' | 'info'; message: string } | null>(null);
  const [microphoneBusy, setMicrophoneBusy] = useState<Record<string, boolean>>({});
  const [microphoneErrors, setMicrophoneErrors] = useState<Record<string, string | undefined>>({});

  const trimmedName = name.trim();
  const nameError = !trimmedName
    ? copy.nameRequired
    : trimmedName.length > 40
      ? copy.nameTooLong
      : undefined;

  const detectedUsb = state.detectedUsb;
  const selectedPortPath = useMemo(() => {
    if (portPath && detectedUsb.some((device) => device.path === portPath)) {
      return portPath;
    }
    return detectedUsb.find((device) => device.likelySidekick)?.path ?? detectedUsb[0]?.path ?? '';
  }, [detectedUsb, portPath]);

  const refresh = async () => {
    setBusy(true);
    setNotice(null);
    try {
      setState(await window.forger.sidekicksGetState());
    } catch {
      setNotice({ severity: 'error', message: copy.loadError });
    } finally {
      setBusy(false);
    }
  };

  const scanUsb = async () => {
    setBusy(true);
    setNotice(null);
    try {
      setState(await window.forger.sidekicksScanUsb());
    } catch {
      setNotice({ severity: 'error', message: copy.scanError });
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    const dispose = window.forger.onSidekicksChanged(setState);
    void refresh();
    return dispose;
  }, []);

  useEffect(() => {
    if (!portPath && selectedPortPath) {
      setPortPath(selectedPortPath);
    }
  }, [portPath, selectedPortPath]);

  const configure = async () => {
    setBusy(true);
    setNotice(null);
    try {
      const result = await window.forger.sidekicksConfigureUsb({
        portPath: selectedPortPath || undefined,
        name,
        ssid,
        password,
      });
      setState(result);
      if (result.success) {
        setPassword('');
        setNotice({ severity: 'info', message: copy.configureSuccess });
      } else {
        setNotice({ severity: 'error', message: result.userMessage ?? copy.configureError });
      }
    } catch {
      setNotice({ severity: 'error', message: copy.configureError });
    } finally {
      setBusy(false);
    }
  };

  const sendDisplay = async (sidekickId: string, mode: 'append' | 'set' | 'clear', text?: string) => {
    setBusy(true);
    setNotice(null);
    try {
      const result = await window.forger.sidekicksSendDisplay({ sidekickId, mode, text });
      setState(result);
      setNotice({
        severity: result.success ? 'success' : 'error',
        message: result.success ? copy.displaySuccess : result.userMessage ?? copy.displayError,
      });
    } catch {
      setNotice({ severity: 'error', message: copy.displayError });
    } finally {
      setBusy(false);
    }
  };

  const forget = async (sidekickId: string) => {
    setBusy(true);
    setNotice(null);
    try {
      const result = await window.forger.sidekicksForget(sidekickId);
      setState(result);
    } finally {
      setBusy(false);
    }
  };

  const setMicrophoneBusyFor = (sidekickId: string, value: boolean) => {
    setMicrophoneBusy((current) => ({ ...current, [sidekickId]: value }));
  };

  const setMicrophoneErrorFor = (sidekickId: string, value?: string) => {
    setMicrophoneErrors((current) => ({ ...current, [sidekickId]: value }));
  };

  const startMicrophoneRecording = async (sidekickId: string) => {
    setMicrophoneBusyFor(sidekickId, true);
    setMicrophoneErrorFor(sidekickId, undefined);
    try {
      const result = await window.forger.sidekicksStartMicrophoneRecording({ sidekickId });
      setState(result);
      if (!result.success) {
        setMicrophoneErrorFor(sidekickId, result.userMessage ?? copy.microphoneStartError);
      }
    } catch {
      setMicrophoneErrorFor(sidekickId, copy.microphoneStartError);
    } finally {
      setMicrophoneBusyFor(sidekickId, false);
    }
  };

  const stopMicrophoneRecording = async (sidekickId: string) => {
    setMicrophoneBusyFor(sidekickId, true);
    setMicrophoneErrorFor(sidekickId, undefined);
    try {
      const result = await window.forger.sidekicksStopMicrophoneRecording({ sidekickId });
      setState(result);
      if (!result.success) {
        setMicrophoneErrorFor(sidekickId, result.userMessage ?? copy.microphoneStopError);
      }
    } catch {
      setMicrophoneErrorFor(sidekickId, copy.microphoneStopError);
    } finally {
      setMicrophoneBusyFor(sidekickId, false);
    }
  };

  return (
    <Stack spacing={3}>
      <Stack direction={{ xs: 'column', sm: 'row' }} alignItems={{ xs: 'stretch', sm: 'flex-start' }} justifyContent="space-between" gap={2}>
        <Box>
          <Typography variant="h4">{copy.title}</Typography>
          <Typography color="text.secondary">{copy.subtitle}</Typography>
        </Box>
        <Stack direction="row" spacing={1}>
          <Button startIcon={<UsbRounded />} variant="outlined" onClick={() => void scanUsb()} disabled={busy}>
            {copy.scanUsb}
          </Button>
          <Button startIcon={<RefreshRounded />} onClick={() => void refresh()} disabled={busy}>
            {copy.refresh}
          </Button>
        </Stack>
      </Stack>

      {notice
        ? <Alert severity={notice.severity}>{notice.message}</Alert>
        : state.userMessage
          ? <Alert severity={state.technicalCode ? 'error' : 'success'}>{state.userMessage}</Alert>
          : null}

      <Paper variant="outlined" sx={{ p: 2, borderRadius: 2 }}>
        <Stack spacing={2}>
          <Stack spacing={0.5}>
            <Typography variant="h6">{copy.setupTitle}</Typography>
            <Typography color="text.secondary">{copy.setupSubtitle}</Typography>
          </Stack>
          <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.5}>
            <TextField
              select
              label={copy.usbPortLabel}
              value={selectedPortPath}
              onChange={(event) => setPortPath(event.target.value)}
              disabled={busy || detectedUsb.length === 0}
              fullWidth
            >
              {detectedUsb.length === 0 ? (
                <MenuItem value="">{copy.noUsbDevices}</MenuItem>
              ) : detectedUsb.map((device) => (
                <MenuItem key={device.path} value={device.path}>
                  {usbLabel(device)}
                </MenuItem>
              ))}
            </TextField>
            <TextField
              label={copy.nameLabel}
              value={name}
              onChange={(event) => setName(event.target.value)}
              disabled={busy}
              error={Boolean(nameError)}
              helperText={nameError ?? copy.nameHelper}
              slotProps={{ htmlInput: { maxLength: 40 } }}
              fullWidth
            />
          </Stack>
          <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.5}>
            <TextField label={copy.ssidLabel} value={ssid} onChange={(event) => setSsid(event.target.value)} disabled={busy} fullWidth />
            <TextField
              label={copy.passwordLabel}
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              disabled={busy}
              fullWidth
            />
          </Stack>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems={{ xs: 'stretch', sm: 'center' }} justifyContent="space-between">
            <Typography variant="body2" color="text.secondary">
              {copy.desktopIdentity}: {state.desktopId ? state.desktopId.slice(0, 16) : copy.identityPending}
            </Typography>
            <Button
              variant="contained"
              startIcon={<UsbRounded />}
              disabled={busy || !selectedPortPath || Boolean(nameError) || !ssid || !password}
              onClick={() => void configure()}
            >
              {copy.configure}
            </Button>
          </Stack>
        </Stack>
      </Paper>

      <Stack spacing={1.5}>
        <Typography variant="h6">{copy.pairedTitle}</Typography>
        {state.sidekicks.length === 0 ? (
          <Alert severity="info">{copy.empty}</Alert>
        ) : state.sidekicks.map((sidekick) => (
          <Paper key={sidekick.sidekickId} variant="outlined" sx={{ p: 2, borderRadius: 2 }}>
            <Stack spacing={2}>
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} justifyContent="space-between" alignItems={{ xs: 'stretch', sm: 'flex-start' }}>
                <Box>
                  <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
                    <Typography variant="subtitle1" fontWeight={700}>{sidekick.name}</Typography>
                    <Chip size="small" color={statusColor(sidekick.status)} label={copy.statuses[sidekick.status]} />
                    <SidekickBatteryChip sidekick={sidekick} copy={copy} />
                  </Stack>
                  <Typography variant="body2" color="text.secondary">
                    {copy.lastSeen}: {formatDate(sidekick.lastSeenAt)} · {copy.firmware}: {sidekick.firmwareVersion ?? '—'}
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    {copy.network}: {sidekick.ipAddress ?? sidekick.usbPath ?? copy.networkPending}
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    {copy.localAddress}: {sidekick.hostname ? `${sidekick.hostname}.local` : copy.networkPending}
                  </Typography>
                </Box>
                <Button
                  size="small"
                  color="error"
                  startIcon={<DeleteOutlineRounded />}
                  disabled={busy}
                  onClick={() => void forget(sidekick.sidekickId)}
                >
                  {copy.forget}
                </Button>
              </Stack>
              {sidekick.capabilities.length > 0 ? (
                <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap>
                  {sidekick.capabilities.map((capability) => (
                    <Chip key={capability} size="small" variant="outlined" label={capability} />
                  ))}
                </Stack>
              ) : null}
              <Divider />
              <SidekickDisplayControls sidekick={sidekick} copy={copy} busy={busy} onSend={sendDisplay} />
              <Divider />
              <SidekickMicrophoneControls
                sidekick={sidekick}
                copy={copy}
                busy={Boolean(microphoneBusy[sidekick.sidekickId])}
                actionError={microphoneErrors[sidekick.sidekickId]}
                onStart={startMicrophoneRecording}
                onStop={stopMicrophoneRecording}
              />
            </Stack>
          </Paper>
        ))}
      </Stack>
    </Stack>
  );
}
