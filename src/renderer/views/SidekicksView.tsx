import AccessTimeRounded from '@mui/icons-material/AccessTimeRounded';
import BatteryChargingFullRounded from '@mui/icons-material/BatteryChargingFullRounded';
import BatteryUnknownRounded from '@mui/icons-material/BatteryUnknownRounded';
import CheckCircleRounded from '@mui/icons-material/CheckCircleRounded';
import DeleteOutlineRounded from '@mui/icons-material/DeleteOutlineRounded';
import ExpandMoreRounded from '@mui/icons-material/ExpandMoreRounded';
import MicRounded from '@mui/icons-material/MicRounded';
import PlayArrowRounded from '@mui/icons-material/PlayArrowRounded';
import RefreshRounded from '@mui/icons-material/RefreshRounded';
import SendRounded from '@mui/icons-material/SendRounded';
import StopRounded from '@mui/icons-material/StopRounded';
import UsbRounded from '@mui/icons-material/UsbRounded';
import VolumeUpRounded from '@mui/icons-material/VolumeUpRounded';
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  Box,
  Button,
  Chip,
  Divider,
  LinearProgress,
  MenuItem,
  Paper,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { useEffect, useMemo, useState } from 'react';

import type { AppDictionary } from '@renderer/i18n';
import type {
  PersonalAgent,
  SidekickMicrophoneRecordingSummary,
  SidekickScreenInput,
  SidekickState,
  SidekickStatus,
  SidekickSummary,
  SidekickUsbDevice,
  TextToSpeechState,
} from '@shared/types';

interface SidekicksViewProps {
  t: AppDictionary;
}

type SidekickCopy = AppDictionary['sections']['sidekicks'];
type ScreenPreset = 'idle' | 'listening' | 'thinking' | 'speaking' | 'card' | 'transcript';

const emptyState: SidekickState = { desktopId: '', sidekicks: [], detectedUsb: [] };

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

const usbLabel = (device: SidekickUsbDevice): string =>
  device.friendlyName || device.manufacturer || device.serialNumber || device.path;

const formatDate = (value?: string): string => {
  if (!value) return '—';
  return new Date(value).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
};

const formatDuration = (durationMs: number): string => {
  const seconds = Math.max(0, Math.round(durationMs / 1000));
  return `${Math.floor(seconds / 60)}:${(seconds % 60).toString().padStart(2, '0')}`;
};

const formatBytes = (bytes: number): string =>
  bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

const formatTime = (sidekick: SidekickSummary): string | null => {
  if (!sidekick.time?.epochMs) return null;
  try {
    return new Intl.DateTimeFormat(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      timeZone: sidekick.time.timeZone,
    }).format(new Date(sidekick.time.epochMs));
  } catch {
    return new Date(sidekick.time.epochMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
};

function SidekickBatteryChip({ sidekick, copy }: { sidekick: SidekickSummary; copy: SidekickCopy }) {
  const battery = sidekick.battery;
  if (!battery) {
    return <Chip size="small" variant="outlined" icon={<BatteryUnknownRounded />} label={copy.batteryUnknown} />;
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

function SidekickTimeCard({ sidekick, copy }: { sidekick: SidekickSummary; copy: SidekickCopy }) {
  const time = sidekick.time;
  const localTime = formatTime(sidekick);
  return (
    <Paper variant="outlined" sx={{ p: 1.5, borderRadius: 2, bgcolor: 'background.default' }}>
      <Stack direction="row" spacing={1.25} alignItems="center">
        <AccessTimeRounded color={time?.synced ? 'primary' : 'disabled'} />
        <Box sx={{ minWidth: 0 }}>
          <Typography variant="subtitle2">{copy.timeTitle}</Typography>
          <Typography variant="body2" color="text.secondary">
            {time?.timeZone ?? copy.timeZoneUnknown}{localTime ? ` · ${localTime}` : ''}
          </Typography>
          <Typography variant="caption" color={time?.synced ? 'success.main' : 'text.disabled'}>
            {time?.synced ? copy.timeSynced : copy.timePending}
            {time?.lastSyncedAt ? ` · ${copy.timeLastSync}: ${formatDate(time.lastSyncedAt)}` : ''}
          </Typography>
          {typeof time?.driftMs === 'number' && Math.abs(time.driftMs) >= 500 ? (
            <Typography display="block" variant="caption" color="text.secondary">{copy.timeDrift(time.driftMs)}</Typography>
          ) : null}
        </Box>
      </Stack>
    </Paper>
  );
}

function SidekickScreenControls({
  sidekick,
  copy,
  busy,
  onSend,
}: {
  sidekick: SidekickSummary;
  copy: SidekickCopy;
  busy: boolean;
  onSend: (input: SidekickScreenInput) => Promise<void>;
}) {
  const [preset, setPreset] = useState<ScreenPreset>('idle');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [text, setText] = useState<string>(copy.defaultDisplayText);
  const connected = sidekick.status === 'online';
  const capable = sidekick.capabilities.includes('display.screens');
  const presets: ScreenPreset[] = ['idle', 'listening', 'thinking', 'speaking', 'card', 'transcript'];

  const send = async () => {
    if (preset === 'idle') {
      await onSend({ sidekickId: sidekick.sidekickId, template: 'idle' });
      return;
    }
    if (preset === 'transcript') {
      await onSend({ sidekickId: sidekick.sidekickId, template: 'transcript', text });
      return;
    }
    if (preset === 'card') {
      await onSend({ sidekickId: sidekick.sidekickId, template: 'card', icon: 'info', title, body });
      return;
    }
    await onSend({ sidekickId: sidekick.sidekickId, template: 'state', icon: preset, title, body });
  };

  return (
    <Stack spacing={1.5}>
      <Box>
        <Typography variant="subtitle1" fontWeight={700}>{copy.screenTitle}</Typography>
        <Typography variant="body2" color="text.secondary">{copy.screenSubtitle}</Typography>
      </Box>
      <Stack direction="row" spacing={0.75} useFlexGap flexWrap="wrap">
        {presets.map((entry) => (
          <Button
            key={entry}
            size="small"
            variant={preset === entry ? 'contained' : 'outlined'}
            onClick={() => setPreset(entry)}
            disabled={!connected || !capable || busy}
          >
            {copy.screenPresets[entry]}
          </Button>
        ))}
      </Stack>
      {preset !== 'idle' && preset !== 'transcript' ? (
        <Stack direction={{ xs: 'column', md: 'row' }} spacing={1}>
          <TextField fullWidth size="small" label={copy.screenTitleLabel} value={title} onChange={(event) => setTitle(event.target.value)} disabled={busy} />
          <TextField fullWidth size="small" label={copy.screenBodyLabel} value={body} onChange={(event) => setBody(event.target.value)} disabled={busy} />
        </Stack>
      ) : null}
      {preset === 'transcript' ? (
        <TextField fullWidth multiline minRows={3} label={copy.screenTranscriptLabel} value={text} onChange={(event) => setText(event.target.value)} disabled={busy} />
      ) : null}
      <Button
        variant="contained"
        startIcon={<SendRounded />}
        sx={{ alignSelf: { xs: 'stretch', sm: 'flex-start' } }}
        disabled={!connected || !capable || busy || (preset === 'transcript' && !text.trim())}
        onClick={() => void send()}
      >
        {copy.screenSend}
      </Button>
    </Stack>
  );
}

function SidekickVoiceControls({
  sidekick,
  copy,
  ttsState,
  busy,
  onSpeak,
}: {
  sidekick: SidekickSummary;
  copy: SidekickCopy;
  ttsState: TextToSpeechState | null;
  busy: boolean;
  onSpeak: (sidekickId: string, text: string, model: string, voice: string) => Promise<void>;
}) {
  const [text, setText] = useState<string>(copy.voiceDefaultText);
  const [model, setModel] = useState('');
  const [voice, setVoice] = useState('');
  const models = ttsState?.models.filter((entry) => entry.installed) ?? [];
  const selectedModel = models.some((entry) => entry.id === model)
    ? model
    : models.find((entry) => entry.id === ttsState?.config.defaultModel)?.id ?? models[0]?.id ?? '';
  const voices = (ttsState?.voices ?? []).filter((entry) => entry.installed && entry.enabled && entry.model === selectedModel);
  const selectedVoice = voices.some((entry) => entry.id === voice)
    ? voice
    : voices.find((entry) => entry.id === ttsState?.config.defaultVoice)?.id ?? voices[0]?.id ?? '';
  const connected = sidekick.status === 'online';
  const capable = sidekick.capabilities.includes('speaker.playback');
  const playbackActive = sidekick.speakerPlayback.status !== 'idle' && sidekick.speakerPlayback.status !== 'error';
  const unavailableMessage = !connected
    ? copy.voiceOffline
    : !capable
      ? copy.voiceUnsupported
      : ttsState && (!ttsState.installed || !selectedModel || !selectedVoice)
        ? copy.voiceUnavailable
        : undefined;

  return (
    <Stack spacing={1.5}>
      <Box>
        <Typography variant="subtitle1" fontWeight={700}>{copy.voiceTitle}</Typography>
        <Typography variant="body2" color="text.secondary">{copy.voiceSubtitle}</Typography>
      </Box>
      {!ttsState ? <Typography variant="body2" color="text.secondary">{copy.voiceLoading}</Typography> : null}
      {unavailableMessage ? <Alert severity="info">{unavailableMessage}</Alert> : null}
      <TextField
        fullWidth
        multiline
        minRows={2}
        label={copy.voiceTextLabel}
        value={text}
        onChange={(event) => setText(event.target.value)}
        disabled={busy || !connected || !capable}
      />
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
        <TextField
          select
          fullWidth
          size="small"
          label={copy.voiceModelLabel}
          value={selectedModel}
          onChange={(event) => { setModel(event.target.value); setVoice(''); }}
          disabled={busy || models.length === 0}
        >
          {models.map((entry) => <MenuItem key={entry.id} value={entry.id}>{entry.label}</MenuItem>)}
        </TextField>
        <TextField
          select
          fullWidth
          size="small"
          label={copy.voiceVoiceLabel}
          value={selectedVoice}
          onChange={(event) => setVoice(event.target.value)}
          disabled={busy || voices.length === 0}
        >
          {voices.map((entry) => <MenuItem key={entry.id} value={entry.id}>{entry.label} · {entry.language}</MenuItem>)}
        </TextField>
      </Stack>
      {busy || playbackActive ? <LinearProgress aria-label={copy.voiceSpeaking} /> : null}
      <Button
        variant="contained"
        startIcon={<VolumeUpRounded />}
        sx={{ alignSelf: { xs: 'stretch', sm: 'flex-start' } }}
        disabled={busy || playbackActive || Boolean(unavailableMessage) || !text.trim() || !selectedModel || !selectedVoice}
        onClick={() => void onSpeak(sidekick.sidekickId, text, selectedModel, selectedVoice)}
      >
        {busy || playbackActive ? copy.voiceSpeaking : copy.voiceSpeak}
      </Button>
    </Stack>
  );
}

function SidekickAgentControls({
  sidekick,
  copy,
  agents,
  busy,
  onSelect,
}: {
  sidekick: SidekickSummary;
  copy: SidekickCopy;
  agents: PersonalAgent[];
  busy: boolean;
  onSelect: (sidekickId: string, personalAgentId: string) => Promise<void>;
}) {
  const automaticId = agents.length === 1 ? agents[0].id : '';
  const configuredId = agents.some((agent) => agent.id === sidekick.personalAgentId) ? sidekick.personalAgentId : '';
  const selectedId = configuredId || automaticId;
  return (
    <Stack spacing={1}>
      <Box>
        <Typography variant="subtitle1" fontWeight={700}>{copy.agentTitle}</Typography>
        <Typography variant="body2" color="text.secondary">{copy.agentSubtitle}</Typography>
      </Box>
      {agents.length === 0 ? <Alert severity="info">{copy.agentNone}</Alert> : (
        <TextField
          select
          size="small"
          label={copy.agentLabel}
          value={selectedId}
          disabled={busy}
          onChange={(event) => void onSelect(sidekick.sidekickId, event.target.value)}
          helperText={!sidekick.personalAgentId && agents.length === 1 ? copy.agentAutomatic : agents.length > 1 && !selectedId ? copy.agentRequired : undefined}
        >
          {agents.length > 1 ? <MenuItem value="" disabled>{copy.agentRequired}</MenuItem> : null}
          {agents.map((agent) => <MenuItem key={agent.id} value={agent.id}>{agent.name}</MenuItem>)}
        </TextField>
      )}
    </Stack>
  );
}

function SidekickRecordingItem({
  sidekickId,
  recording,
  copy,
}: {
  sidekickId: string;
  recording: SidekickMicrophoneRecordingSummary;
  copy: SidekickCopy;
}) {
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => () => {
    if (audioUrl) URL.revokeObjectURL(audioUrl);
  }, [audioUrl]);

  const loadAudio = async () => {
    if (audioUrl || loading) return;
    setLoading(true);
    setError(null);
    try {
      const result = await window.forger.sidekicksReadMicrophoneRecording({ sidekickId, recordingId: recording.recordingId });
      if (!result.success || !result.bytes || !result.mimeType) {
        setError(result.userMessage ?? copy.playbackError);
        return;
      }
      const bytes = new Uint8Array(result.bytes.byteLength);
      bytes.set(result.bytes);
      setAudioUrl(URL.createObjectURL(new Blob([bytes], { type: result.mimeType })));
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
        <Typography variant="body2" color="text.secondary">{copy.recordingMeta(formatDuration(recording.durationMs), formatBytes(recording.sizeBytes))}</Typography>
      </Stack>
      {audioUrl ? (
        <Box component="audio" controls src={audioUrl} sx={{ width: '100%' }} />
      ) : (
        <Button size="small" variant="outlined" startIcon={<PlayArrowRounded />} onClick={() => void loadAudio()} disabled={loading} sx={{ alignSelf: 'flex-start' }}>
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
  error,
  onStart,
  onStop,
}: {
  sidekick: SidekickSummary;
  copy: SidekickCopy;
  busy: boolean;
  error?: string;
  onStart: (sidekickId: string) => Promise<void>;
  onStop: (sidekickId: string) => Promise<void>;
}) {
  const recording = sidekick.microphoneRecording;
  const active = recording.status === 'recording' || recording.status === 'stopping';
  const connected = sidekick.status === 'online';
  const capable = sidekick.capabilities.includes('microphone.record');
  const disabled = busy || recording.status === 'starting' || recording.status === 'stopping' || !connected || !capable;
  const message = error ?? recording.errorMessage ?? (!connected ? copy.microphoneOffline : !capable ? copy.microphoneUnsupported : copy.microphoneStates[recording.status]);

  return (
    <Stack spacing={1.25}>
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} justifyContent="space-between" alignItems={{ xs: 'stretch', sm: 'center' }}>
        <Box>
          <Typography variant="subtitle1" fontWeight={700}>{copy.microphoneTitle}</Typography>
          <Typography variant="body2" color={error || recording.errorMessage ? 'error' : 'text.secondary'}>{message}</Typography>
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
          {sidekick.microphoneRecordings.map((entry) => (
            <SidekickRecordingItem key={entry.recordingId} sidekickId={sidekick.sidekickId} recording={entry} copy={copy} />
          ))}
        </Stack>
      )}
    </Stack>
  );
}

function TechnicalDetails({ sidekick, state, copy }: { sidekick: SidekickSummary; state: SidekickState; copy: SidekickCopy }) {
  return (
    <Accordion disableGutters elevation={0} sx={{ '&:before': { display: 'none' }, bgcolor: 'transparent' }}>
      <AccordionSummary expandIcon={<ExpandMoreRounded />} sx={{ px: 0 }}>
        <Typography variant="body2" color="text.secondary">{copy.technicalDetails}</Typography>
      </AccordionSummary>
      <AccordionDetails sx={{ px: 0, pt: 0 }}>
        <Stack spacing={0.5}>
          <Typography variant="body2"><b>{copy.sidekickId}:</b> {sidekick.sidekickId}</Typography>
          <Typography variant="body2"><b>{copy.firmware}:</b> {sidekick.firmwareVersion ?? '—'}</Typography>
          <Typography variant="body2"><b>{copy.network}:</b> {sidekick.ipAddress ?? '—'}</Typography>
          <Typography variant="body2"><b>{copy.localAddress}:</b> {sidekick.hostname ? `${sidekick.hostname}.local` : '—'}</Typography>
          <Typography variant="body2"><b>{copy.usbPortLabel}:</b> {sidekick.usbPath ?? '—'}</Typography>
          <Typography variant="body2"><b>{copy.desktopIdentity}:</b> {state.desktopId || '—'}</Typography>
          <Typography variant="body2"><b>{copy.servicePort}:</b> {state.servicePort ?? '—'}</Typography>
          <Typography variant="body2" sx={{ pt: 0.5 }}><b>{copy.capabilities}:</b></Typography>
          <Stack direction="row" spacing={0.75} useFlexGap flexWrap="wrap">
            {sidekick.capabilities.length ? sidekick.capabilities.map((capability) => (
              <Chip key={capability} size="small" variant="outlined" label={capability} />
            )) : <Typography variant="body2">—</Typography>}
          </Stack>
        </Stack>
      </AccordionDetails>
    </Accordion>
  );
}

export function SidekicksView({ t }: SidekicksViewProps) {
  const copy = t.sections.sidekicks;
  const [state, setState] = useState<SidekickState>(emptyState);
  const [ttsState, setTtsState] = useState<TextToSpeechState | null>(null);
  const [personalAgents, setPersonalAgents] = useState<PersonalAgent[]>([]);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState<string>(copy.defaultName);
  const [portPath, setPortPath] = useState('');
  const [ssid, setSsid] = useState('');
  const [password, setPassword] = useState('');
  const [notice, setNotice] = useState<{ severity: 'success' | 'error' | 'info'; message: string } | null>(null);
  const [microphoneBusy, setMicrophoneBusy] = useState<Record<string, boolean>>({});
  const [microphoneErrors, setMicrophoneErrors] = useState<Record<string, string | undefined>>({});
  const [screenBusy, setScreenBusy] = useState<Record<string, boolean>>({});
  const [voiceBusy, setVoiceBusy] = useState<Record<string, boolean>>({});
  const [agentBusy, setAgentBusy] = useState<Record<string, boolean>>({});

  const compatibleUsb = useMemo(() => state.detectedUsb.filter((device) => device.likelySidekick), [state.detectedUsb]);
  const otherUsb = useMemo(() => state.detectedUsb.filter((device) => !device.likelySidekick), [state.detectedUsb]);
  const selectedPortPath = compatibleUsb.some((device) => device.path === portPath) ? portPath : compatibleUsb[0]?.path ?? '';
  const trimmedName = name.trim();
  const nameError = !trimmedName ? copy.nameRequired : trimmedName.length > 40 ? copy.nameTooLong : undefined;

  const refresh = async () => {
    setBusy(true);
    setNotice(null);
    try {
      const [sidekicks, speech, agents] = await Promise.all([
        window.forger.sidekicksGetState(),
        window.forger.textToSpeechGetState().catch(() => null),
        window.forger.personalAgentsList().catch(() => []),
      ]);
      setState(sidekicks);
      setTtsState(speech);
      setPersonalAgents(agents);
    } catch {
      setNotice({ severity: 'error', message: copy.loadError });
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    const dispose = window.forger.onSidekicksChanged(setState);
    void refresh();
    return dispose;
  }, []);

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

  const configure = async () => {
    setBusy(true);
    setNotice(null);
    try {
      const result = await window.forger.sidekicksConfigureUsb({ portPath: selectedPortPath || undefined, name, ssid, password });
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

  const sendScreen = async (input: SidekickScreenInput) => {
    setScreenBusy((current) => ({ ...current, [input.sidekickId]: true }));
    setNotice(null);
    try {
      const result = await window.forger.sidekicksSendScreen(input);
      setState(result);
      setNotice({ severity: result.success ? 'success' : 'error', message: result.success ? copy.screenSuccess : result.userMessage ?? copy.screenError });
    } catch {
      setNotice({ severity: 'error', message: copy.screenError });
    } finally {
      setScreenBusy((current) => ({ ...current, [input.sidekickId]: false }));
    }
  };

  const speak = async (sidekickId: string, text: string, model: string, voice: string) => {
    setVoiceBusy((current) => ({ ...current, [sidekickId]: true }));
    setNotice(null);
    try {
      const result = await window.forger.sidekicksSpeak({ sidekickId, text, model, voice });
      setNotice({ severity: result.success ? 'success' : 'error', message: result.success ? copy.voiceSuccess : result.userMessage ?? copy.voiceError });
    } catch {
      setNotice({ severity: 'error', message: copy.voiceError });
    } finally {
      setVoiceBusy((current) => ({ ...current, [sidekickId]: false }));
      setState(await window.forger.sidekicksGetState().catch(() => state));
    }
  };

  const setPersonalAgent = async (sidekickId: string, personalAgentId: string) => {
    setAgentBusy((current) => ({ ...current, [sidekickId]: true }));
    setNotice(null);
    try {
      const result = await window.forger.sidekicksSetPersonalAgent({ sidekickId, personalAgentId });
      setState(result);
      setNotice({ severity: result.success ? 'success' : 'error', message: result.success ? copy.agentSaved : result.userMessage ?? copy.agentError });
    } catch {
      setNotice({ severity: 'error', message: copy.agentError });
    } finally {
      setAgentBusy((current) => ({ ...current, [sidekickId]: false }));
    }
  };

  const setMicrophoneBusyFor = (sidekickId: string, value: boolean) => setMicrophoneBusy((current) => ({ ...current, [sidekickId]: value }));
  const setMicrophoneErrorFor = (sidekickId: string, value?: string) => setMicrophoneErrors((current) => ({ ...current, [sidekickId]: value }));

  const startMicrophoneRecording = async (sidekickId: string) => {
    setMicrophoneBusyFor(sidekickId, true);
    setMicrophoneErrorFor(sidekickId);
    try {
      const result = await window.forger.sidekicksStartMicrophoneRecording({ sidekickId });
      setState(result);
      if (!result.success) setMicrophoneErrorFor(sidekickId, result.userMessage ?? copy.microphoneStartError);
    } catch {
      setMicrophoneErrorFor(sidekickId, copy.microphoneStartError);
    } finally {
      setMicrophoneBusyFor(sidekickId, false);
    }
  };

  const stopMicrophoneRecording = async (sidekickId: string) => {
    setMicrophoneBusyFor(sidekickId, true);
    setMicrophoneErrorFor(sidekickId);
    try {
      const result = await window.forger.sidekicksStopMicrophoneRecording({ sidekickId });
      setState(result);
      if (!result.success) setMicrophoneErrorFor(sidekickId, result.userMessage ?? copy.microphoneStopError);
    } catch {
      setMicrophoneErrorFor(sidekickId, copy.microphoneStopError);
    } finally {
      setMicrophoneBusyFor(sidekickId, false);
    }
  };

  const forget = async (sidekick: SidekickSummary) => {
    if (!window.confirm(copy.forgetConfirm(sidekick.name))) return;
    setBusy(true);
    try {
      setState(await window.forger.sidekicksForget(sidekick.sidekickId));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Stack spacing={3}>
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} justifyContent="space-between" alignItems={{ xs: 'stretch', sm: 'flex-start' }}>
        <Box>
          <Typography variant="h4">{copy.title}</Typography>
          <Typography color="text.secondary" sx={{ maxWidth: 720 }}>{copy.subtitle}</Typography>
        </Box>
        <Stack direction="row" spacing={1}>
          <Button startIcon={<UsbRounded />} variant="outlined" onClick={() => void scanUsb()} disabled={busy}>{copy.scanUsb}</Button>
          <Button startIcon={<RefreshRounded />} onClick={() => void refresh()} disabled={busy}>{copy.refresh}</Button>
        </Stack>
      </Stack>

      {notice ? <Alert severity={notice.severity}>{notice.message}</Alert> : state.userMessage ? <Alert severity={state.technicalCode ? 'error' : 'success'}>{state.userMessage}</Alert> : null}

      <Paper variant="outlined" sx={{ p: { xs: 2, md: 3 }, borderRadius: 3 }}>
        <Stack spacing={2.25}>
          <Box>
            <Typography variant="h6">{copy.journeyTitle}</Typography>
            <Typography color="text.secondary">{copy.setupSubtitle}</Typography>
          </Box>
          <Stack direction={{ xs: 'column', md: 'row' }} spacing={1}>
            {[copy.setupStepConnect, copy.setupStepNetwork, copy.setupStepReady].map((label, index) => (
              <Chip key={label} color={index === 0 && compatibleUsb.length ? 'primary' : 'default'} variant={index === 0 && compatibleUsb.length ? 'filled' : 'outlined'} icon={index === 0 && compatibleUsb.length ? <CheckCircleRounded /> : undefined} label={label} sx={{ justifyContent: 'flex-start' }} />
            ))}
          </Stack>
          <Typography variant="body2" color="text.secondary">{copy.compatibleUsbOnly}</Typography>
          <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.5}>
            <TextField
              select
              label={copy.usbPortLabel}
              value={selectedPortPath}
              onChange={(event) => setPortPath(event.target.value)}
              disabled={busy || compatibleUsb.length === 0}
              fullWidth
            >
              {compatibleUsb.length === 0 ? <MenuItem value="">{copy.noUsbDevices}</MenuItem> : compatibleUsb.map((device) => <MenuItem key={device.path} value={device.path}>{usbLabel(device)}</MenuItem>)}
            </TextField>
            <TextField fullWidth label={copy.nameLabel} value={name} onChange={(event) => setName(event.target.value)} disabled={busy} error={Boolean(nameError)} helperText={nameError ?? copy.nameHelper} slotProps={{ htmlInput: { maxLength: 40 } }} />
          </Stack>
          <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.5}>
            <TextField fullWidth label={copy.ssidLabel} value={ssid} onChange={(event) => setSsid(event.target.value)} disabled={busy} />
            <TextField fullWidth label={copy.passwordLabel} type="password" value={password} onChange={(event) => setPassword(event.target.value)} disabled={busy} />
          </Stack>
          <Button variant="contained" startIcon={<UsbRounded />} disabled={busy || !selectedPortPath || Boolean(nameError) || !ssid || !password} onClick={() => void configure()} sx={{ alignSelf: { xs: 'stretch', sm: 'flex-end' } }}>
            {copy.configure}
          </Button>
          <Accordion disableGutters elevation={0} sx={{ '&:before': { display: 'none' }, bgcolor: 'transparent' }}>
            <AccordionSummary expandIcon={<ExpandMoreRounded />} sx={{ px: 0 }}>
              <Typography variant="body2" color="text.secondary">{copy.otherUsbTitle}</Typography>
            </AccordionSummary>
            <AccordionDetails sx={{ px: 0, pt: 0 }}>
              {otherUsb.length ? otherUsb.map((device) => <Typography key={device.path} variant="body2">{usbLabel(device)} · {device.path}</Typography>) : <Typography variant="body2" color="text.secondary">{copy.otherUsbEmpty}</Typography>}
            </AccordionDetails>
          </Accordion>
        </Stack>
      </Paper>

      <Stack spacing={1.5}>
        <Typography variant="h6">{copy.pairedTitle}</Typography>
        {state.sidekicks.length === 0 ? <Alert severity="info">{copy.empty}</Alert> : state.sidekicks.map((sidekick) => (
          <Paper key={sidekick.sidekickId} variant="outlined" sx={{ p: { xs: 2, md: 2.5 }, borderRadius: 3 }}>
            <Stack spacing={2.25}>
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} justifyContent="space-between" alignItems={{ xs: 'stretch', sm: 'flex-start' }}>
                <Box>
                  <Stack direction="row" spacing={0.75} useFlexGap flexWrap="wrap" alignItems="center">
                    <Typography variant="h6">{sidekick.name}</Typography>
                    <Chip size="small" color={statusColor(sidekick.status)} label={copy.statuses[sidekick.status]} />
                    <SidekickBatteryChip sidekick={sidekick} copy={copy} />
                  </Stack>
                  <Typography variant="body2" color={sidekick.status === 'online' ? 'success.main' : sidekick.status === 'error' ? 'error' : 'text.secondary'}>
                    {sidekick.status === 'online' ? copy.deviceReady : sidekick.errorMessage ?? copy.deviceNeedsAttention}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">{copy.lastSeen}: {formatDate(sidekick.lastSeenAt)}</Typography>
                </Box>
                <Button size="small" color="error" startIcon={<DeleteOutlineRounded />} disabled={busy} onClick={() => void forget(sidekick)}>{copy.forget}</Button>
              </Stack>

              <SidekickTimeCard sidekick={sidekick} copy={copy} />
              <Divider />
              <SidekickScreenControls sidekick={sidekick} copy={copy} busy={Boolean(screenBusy[sidekick.sidekickId])} onSend={sendScreen} />
              <Divider />
              <SidekickAgentControls sidekick={sidekick} copy={copy} agents={personalAgents} busy={Boolean(agentBusy[sidekick.sidekickId])} onSelect={setPersonalAgent} />
              <Divider />
              <SidekickVoiceControls sidekick={sidekick} copy={copy} ttsState={ttsState} busy={Boolean(voiceBusy[sidekick.sidekickId])} onSpeak={speak} />
              <Divider />
              <SidekickMicrophoneControls
                sidekick={sidekick}
                copy={copy}
                busy={Boolean(microphoneBusy[sidekick.sidekickId])}
                error={microphoneErrors[sidekick.sidekickId]}
                onStart={startMicrophoneRecording}
                onStop={stopMicrophoneRecording}
              />
              <TechnicalDetails sidekick={sidekick} state={state} copy={copy} />
            </Stack>
          </Paper>
        ))}
      </Stack>
    </Stack>
  );
}
