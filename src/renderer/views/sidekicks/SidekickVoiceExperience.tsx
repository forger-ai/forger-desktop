import ChatRounded from '@mui/icons-material/ChatRounded';
import ExpandMoreRounded from '@mui/icons-material/ExpandMoreRounded';
import LockRounded from '@mui/icons-material/LockRounded';
import SaveRounded from '@mui/icons-material/SaveRounded';
import VolumeUpRounded from '@mui/icons-material/VolumeUpRounded';
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  MenuItem,
  Paper,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { useEffect, useState } from 'react';

import type { AppDictionary } from '@renderer/i18n';
import { MarkdownMessage } from '@renderer/views/chat/MarkdownMessage';
import type {
  PersonalAgentConversation,
  SidekickSummary,
  SidekickVoiceConfig,
  TextToSpeechState,
} from '@shared/types';

type SidekickCopy = AppDictionary['sections']['sidekicks'];

const TTL_OPTIONS = [15, 30, 60, 180, 360, 720, 1440] as const;

const FIXED_STT_LANGUAGES = ['es', 'en', 'fr', 'it', 'pt', 'ja', 'zh', 'hi'] as const;

const sttLanguageDisplayName = (code: string): string => {
  try {
    return new Intl.DisplayNames(undefined, { type: 'language' }).of(code) ?? code;
  } catch {
    return code;
  }
};

const encodeSttSelection = (config: Pick<SidekickVoiceConfig, 'sttLanguageMode' | 'sttLanguages'>): string => {
  if (config.sttLanguageMode === 'auto') return 'auto';
  if (config.sttLanguageMode === 'fixed' && config.sttLanguages?.[0]) return `fixed:${config.sttLanguages[0]}`;
  if (config.sttLanguageMode === 'voice') return 'voice';
  return 'subset';
};

const decodeSttSelection = (
  selection: string,
): Pick<SidekickVoiceConfig, 'sttLanguageMode' | 'sttLanguages'> => {
  if (selection === 'auto') return { sttLanguageMode: 'auto' };
  if (selection === 'subset') return { sttLanguageMode: 'subset', sttLanguages: ['es', 'en'] };
  if (selection.startsWith('fixed:')) return { sttLanguageMode: 'fixed', sttLanguages: [selection.slice('fixed:'.length)] };
  return { sttLanguageMode: 'voice' };
};

const formatDate = (value: string): string =>
  new Date(value).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });

export function SidekickVoiceSettings({
  sidekick,
  copy,
  ttsState,
  busy,
  onSave,
}: {
  sidekick: SidekickSummary;
  copy: SidekickCopy;
  ttsState: TextToSpeechState | null;
  busy: boolean;
  onSave: (sidekickId: string, config: SidekickVoiceConfig) => Promise<void>;
}) {
  const remote = sidekick.voiceConfig;
  const [model, setModel] = useState(remote.model ?? '');
  const [voice, setVoice] = useState(remote.voice ?? '');
  const [conversationTtlMinutes, setConversationTtlMinutes] = useState(remote.conversationTtlMinutes);
  const [sttSelection, setSttSelection] = useState(encodeSttSelection(remote));
  const models = ttsState?.models.filter((entry) => entry.installed) ?? [];
  const defaultModel = models.find((entry) => entry.id === ttsState?.config.defaultModel)?.id
    ?? models[0]?.id
    ?? '';
  const selectedModel = models.some((entry) => entry.id === model)
    ? model
    : defaultModel;
  const voices = (ttsState?.voices ?? []).filter((entry) => entry.installed && entry.enabled && entry.model === selectedModel);
  const selectedVoice = voices.some((entry) => entry.id === voice)
    ? voice
    : voices.find((entry) => entry.id === ttsState?.config.defaultVoice)?.id ?? voices[0]?.id ?? '';
  const selectedVoiceDetails = voices.find((entry) => entry.id === selectedVoice);
  const selectedLocale = selectedVoiceDetails?.locale ?? '';

  // A missing persisted profile means "use the runtime default", not "use
  // whatever the user has selected in this render". Keeping those baselines
  // separate is what lets the first non-default selection become dirty and
  // enables Save.
  const effectiveRemoteModel = models.some((entry) => entry.id === remote.model)
    ? remote.model ?? defaultModel
    : defaultModel;
  const effectiveRemoteVoices = (ttsState?.voices ?? []).filter(
    (entry) => entry.installed && entry.enabled && entry.model === effectiveRemoteModel,
  );
  const effectiveRemoteVoice = effectiveRemoteVoices.some((entry) => entry.id === remote.voice)
    ? remote.voice ?? ''
    : effectiveRemoteVoices.find((entry) => entry.id === ttsState?.config.defaultVoice)?.id
      ?? effectiveRemoteVoices[0]?.id
      ?? '';
  const effectiveRemoteLocale = remote.locale
    ?? effectiveRemoteVoices.find((entry) => entry.id === effectiveRemoteVoice)?.locale
    ?? '';

  const remoteSttSelection = encodeSttSelection(remote);
  const remoteKey = `${remote.model ?? ''}|${remote.voice ?? ''}|${remote.locale ?? ''}|${remote.conversationTtlMinutes}|${remoteSttSelection}`;
  useEffect(() => {
    setModel(remote.model ?? '');
    setVoice(remote.voice ?? '');
    setConversationTtlMinutes(remote.conversationTtlMinutes);
    setSttSelection(remoteSttSelection);
  }, [remoteKey, sidekick.sidekickId]);

  const currentKey = `${selectedModel}|${selectedVoice}|${selectedLocale}|${conversationTtlMinutes}|${sttSelection}`;
  const normalizedRemoteKey = `${effectiveRemoteModel}|${effectiveRemoteVoice}|${effectiveRemoteLocale}|${remote.conversationTtlMinutes}|${remoteSttSelection}`;
  const dirty = currentKey !== normalizedRemoteKey;

  return (
    <Stack spacing={1.5}>
      <Box>
        <Typography variant="subtitle1" fontWeight={700}>{copy.voiceSettingsTitle}</Typography>
        <Typography variant="body2" color="text.secondary">{copy.voiceSettingsSubtitle}</Typography>
      </Box>
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
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
        <TextField
          fullWidth
          size="small"
          label={copy.voiceLocaleLabel}
          value={selectedVoiceDetails ? `${selectedVoiceDetails.language}${selectedLocale ? ` · ${selectedLocale}` : ''}` : copy.voiceLocaleAutomatic}
          helperText={copy.voiceLocaleDerived}
          slotProps={{ input: { readOnly: true } }}
        />
        <TextField
          select
          fullWidth
          size="small"
          label={copy.voiceTtlLabel}
          value={conversationTtlMinutes}
          onChange={(event) => setConversationTtlMinutes(Number(event.target.value))}
          disabled={busy}
        >
          {TTL_OPTIONS.map((minutes) => (
            <MenuItem key={minutes} value={minutes}>{copy.voiceTtlOption(minutes)}</MenuItem>
          ))}
        </TextField>
      </Stack>
      <TextField
        select
        fullWidth
        size="small"
        label={copy.sttLanguageLabel}
        helperText={copy.sttLanguageHelper}
        value={sttSelection}
        onChange={(event) => setSttSelection(event.target.value)}
        disabled={busy}
      >
        <MenuItem value="voice">{copy.sttLanguageVoice}</MenuItem>
        <MenuItem value="subset">{copy.sttLanguageSpanglish}</MenuItem>
        <MenuItem value="auto">{copy.sttLanguageAuto}</MenuItem>
        {FIXED_STT_LANGUAGES.map((code) => (
          <MenuItem key={code} value={`fixed:${code}`}>{sttLanguageDisplayName(code)}</MenuItem>
        ))}
      </TextField>
      {!ttsState?.installed ? <Alert severity="info">{copy.voiceUnavailable}</Alert> : null}
      <Button
        variant="contained"
        startIcon={<SaveRounded />}
        sx={{ alignSelf: { xs: 'stretch', sm: 'flex-start' } }}
        disabled={busy || !dirty || !selectedModel || !selectedVoice}
        onClick={() => void onSave(sidekick.sidekickId, {
          model: selectedModel,
          voice: selectedVoice,
          locale: selectedLocale || undefined,
          ...decodeSttSelection(sttSelection),
          conversationTtlMinutes,
        })}
      >
        {copy.voiceSettingsSave}
      </Button>
    </Stack>
  );
}

export function SidekickConversationList({
  copy,
  conversations,
  loading,
  onOpen,
}: {
  copy: SidekickCopy;
  conversations: PersonalAgentConversation[];
  loading: boolean;
  onOpen: (conversation: PersonalAgentConversation) => void;
}) {
  return (
    <Stack spacing={1.25}>
      <Stack direction="row" spacing={1} alignItems="center">
        <ChatRounded color="action" />
        <Box>
          <Typography variant="subtitle1" fontWeight={700}>{copy.conversationsTitle}</Typography>
          <Typography variant="body2" color="text.secondary">{copy.conversationsSubtitle}</Typography>
        </Box>
      </Stack>
      {loading ? <Typography variant="body2" color="text.secondary">{copy.conversationsLoading}</Typography> : null}
      {!loading && conversations.length === 0 ? (
        <Typography variant="body2" color="text.secondary">{copy.conversationsEmpty}</Typography>
      ) : null}
      {conversations.map((conversation) => (
        <Paper key={conversation.id} variant="outlined" sx={{ p: 1.5, borderRadius: 2 }}>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} justifyContent="space-between" alignItems={{ xs: 'stretch', sm: 'center' }}>
            <Box sx={{ minWidth: 0 }}>
              <Typography variant="body2" fontWeight={700} noWrap>{conversation.title}</Typography>
              <Typography variant="caption" color="text.secondary">{formatDate(conversation.updatedAt)}</Typography>
            </Box>
            <Stack direction="row" spacing={0.75} alignItems="center">
              <Chip size="small" icon={<LockRounded />} label={copy.conversationExclusive} />
              <Button size="small" onClick={() => onOpen(conversation)}>{copy.conversationOpen}</Button>
            </Stack>
          </Stack>
        </Paper>
      ))}
    </Stack>
  );
}

export function SidekickConversationDialog({
  copy,
  conversation,
  onClose,
}: {
  copy: SidekickCopy;
  conversation: PersonalAgentConversation | null;
  onClose: () => void;
}) {
  const visibleMessages = conversation?.messages.filter((message) => message.role !== 'system' && message.kind !== 'intermediate') ?? [];
  return (
    <Dialog open={Boolean(conversation)} onClose={onClose} fullWidth maxWidth="md" scroll="paper">
      {conversation ? (
        <>
          <DialogTitle>
            <Stack spacing={0.75}>
              <Typography variant="h6">{conversation.title}</Typography>
              <Stack direction="row" spacing={0.75} useFlexGap flexWrap="wrap">
                <Chip size="small" icon={<LockRounded />} label={copy.conversationExclusive} />
                <Chip size="small" variant="outlined" label={copy.conversationReadOnly} />
              </Stack>
            </Stack>
          </DialogTitle>
          <DialogContent dividers>
            <Stack spacing={1.5}>
              {visibleMessages.length === 0 ? (
                <Typography variant="body2" color="text.secondary">{copy.conversationNoMessages}</Typography>
              ) : visibleMessages.map((message, index) => (
                <Stack key={message.id} spacing={0.5}>
                  {index > 0 ? <Divider /> : null}
                  {message.kind === 'spoken' ? (
                    <Paper
                      variant="outlined"
                      sx={{ p: 1.25, borderRadius: 2, borderStyle: 'dashed', bgcolor: 'action.hover' }}
                    >
                      <Stack direction="row" spacing={0.75} alignItems="center">
                        <VolumeUpRounded fontSize="small" color="action" />
                        <Typography variant="caption" color="text.secondary" fontWeight={700}>
                          {copy.conversationSpoken} · {formatDate(message.createdAt)}
                        </Typography>
                      </Stack>
                      <Typography variant="body2" sx={{ fontStyle: 'italic', mt: 0.5 }}>{message.content}</Typography>
                    </Paper>
                  ) : (
                    <>
                      <Typography variant="caption" color="text.secondary">
                        {message.role === 'user' ? copy.conversationPerson : copy.conversationAgent} · {formatDate(message.createdAt)}
                      </Typography>
                      {message.reasoning ? (
                        <Accordion
                          disableGutters
                          elevation={0}
                          sx={{ '&:before': { display: 'none' }, bgcolor: 'transparent' }}
                        >
                          <AccordionSummary expandIcon={<ExpandMoreRounded fontSize="small" />} sx={{ minHeight: 0, px: 0.5, '& .MuiAccordionSummary-content': { my: 0.25 } }}>
                            <Typography variant="caption" color="text.secondary">{copy.conversationReasoning}</Typography>
                          </AccordionSummary>
                          <AccordionDetails sx={{ px: 0.5, py: 0.5 }}>
                            <MarkdownMessage content={message.reasoning} />
                          </AccordionDetails>
                        </Accordion>
                      ) : null}
                      <MarkdownMessage content={message.content} />
                    </>
                  )}
                </Stack>
              ))}
            </Stack>
          </DialogContent>
          <DialogActions><Button onClick={onClose}>{copy.configClose}</Button></DialogActions>
        </>
      ) : null}
    </Dialog>
  );
}
