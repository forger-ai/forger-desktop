import { useMemo, useState } from 'react';
import {
  Button,
  Card,
  CardContent,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  FormControl,
  IconButton,
  InputLabel,
  MenuItem,
  Avatar,
  LinearProgress,
  Select,
  Stack,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from '@mui/material';
import AddRounded from '@mui/icons-material/AddRounded';
import DeleteOutlineRounded from '@mui/icons-material/DeleteOutlineRounded';
import EditRounded from '@mui/icons-material/EditRounded';
import MemoryRounded from '@mui/icons-material/MemoryRounded';
import SystemUpdateAltRounded from '@mui/icons-material/SystemUpdateAltRounded';
import DownloadRounded from '@mui/icons-material/DownloadRounded';
import LaunchRounded from '@mui/icons-material/LaunchRounded';
import RestartAltRounded from '@mui/icons-material/RestartAltRounded';
import type {
  AppSummary,
  CodexAuthStatus,
  DesktopUpdateState,
  MemoryCreateInput,
  MemoryEntry,
  MemoryKind,
  MemoryScope,
  MemoryUpdateInput,
  CodexModelOption,
  CodexReasoningEffort,
  Settings,
} from '@shared/types';
import type { AppDictionary, Locale } from '@renderer/i18n';
import type { ThemePreference } from '@renderer/theme/appTheme';
import type { ChatBotPicture, LanguagePreference } from '@renderer/preferences';

interface SettingsViewProps {
  codexAuthBusy: boolean;
  codexAuthStatus: CodexAuthStatus;
  t: AppDictionary;
  themePreference: ThemePreference;
  onThemeChange: (theme: ThemePreference) => void;
  languagePreference: LanguagePreference;
  activeLocale: Locale;
  systemLocale: Locale;
  onLanguageChange: (language: LanguagePreference) => void;
  chatBotPicture: ChatBotPicture;
  chatBotPictureOptions: Array<{ value: ChatBotPicture; label: string; src: string }>;
  onChatBotPictureChange: (picture: ChatBotPicture) => void;
  modelOptions: CodexModelOption[];
  reasoningOptions: { label: string; value: CodexReasoningEffort }[];
  codexDefaults: Settings['codexDefaults'];
  onCodexDefaultsChange: (defaults: Settings['codexDefaults']) => void;
  onOpenCodexConfig: () => void;
  onReinstallCodex: () => void;
  desktopUpdateState: DesktopUpdateState;
  desktopUpdateBusy: boolean;
  onCheckDesktopUpdates: () => void;
  onDownloadDesktopUpdate: () => void;
  onInstallDesktopUpdate: () => void;
  installedApps: AppSummary[];
  memories: MemoryEntry[];
  onCreateMemory: (input: MemoryCreateInput) => void;
  onUpdateMemory: (input: MemoryUpdateInput) => void;
  onDeleteMemory: (id: string) => void;
}

interface MemoryFormState {
  id?: string;
  scope: MemoryScope;
  appId: string;
  kind: MemoryKind;
  text: string;
}

const EMPTY_MEMORY_FORM: MemoryFormState = {
  scope: 'global',
  appId: '',
  kind: 'preference',
  text: '',
};

const MEMORY_KINDS: MemoryKind[] = ['preference', 'profile', 'workflow', 'constraint', 'fact'];

export function SettingsView({
  codexAuthBusy,
  codexAuthStatus,
  t,
  themePreference,
  onThemeChange,
  languagePreference,
  activeLocale,
  systemLocale,
  onLanguageChange,
  chatBotPicture,
  chatBotPictureOptions,
  onChatBotPictureChange,
  modelOptions,
  reasoningOptions,
  codexDefaults,
  onCodexDefaultsChange,
  onOpenCodexConfig,
  onReinstallCodex,
  desktopUpdateState,
  desktopUpdateBusy,
  onCheckDesktopUpdates,
  onDownloadDesktopUpdate,
  onInstallDesktopUpdate,
  installedApps,
  memories,
  onCreateMemory,
  onUpdateMemory,
  onDeleteMemory,
}: SettingsViewProps) {
  const [memoryDialogOpen, setMemoryDialogOpen] = useState(false);
  const [memoryForm, setMemoryForm] = useState<MemoryFormState>(EMPTY_MEMORY_FORM);
  const canDownload = desktopUpdateState.status === 'available' && Boolean(desktopUpdateState.asset);
  const canInstall = desktopUpdateState.status === 'ready' && Boolean(desktopUpdateState.downloadedPath);
  const progressPercent =
    typeof desktopUpdateState.progress === 'number'
      ? Math.round(desktopUpdateState.progress * 100)
      : undefined;
  const statusLabel = t.settings.desktopUpdateStatuses[desktopUpdateState.status];
  const appNames = useMemo(
    () => new Map(installedApps.map((appEntry) => [appEntry.id, appEntry.name])),
    [installedApps],
  );
  const globalMemories = memories.filter((entry) => entry.scope === 'global');
  const appMemoryGroups = useMemo(() => {
    const groups = new Map<string, MemoryEntry[]>();
    for (const entry of memories) {
      if (entry.scope !== 'app' || !entry.appId) continue;
      groups.set(entry.appId, [...(groups.get(entry.appId) ?? []), entry]);
    }
    return [...groups.entries()];
  }, [memories]);
  const memoryFormAppRequired = memoryForm.scope === 'app' && !memoryForm.appId;
  const memoryFormInvalid = !memoryForm.text.trim() || memoryFormAppRequired;

  const resetMemoryForm = () => setMemoryForm(EMPTY_MEMORY_FORM);
  const submitMemoryForm = () => {
    if (memoryFormInvalid) return;
    const payload = {
      scope: memoryForm.scope,
      appId: memoryForm.scope === 'app' ? memoryForm.appId : undefined,
      kind: memoryForm.kind,
      text: memoryForm.text,
    };
    if (memoryForm.id) {
      onUpdateMemory({ id: memoryForm.id, ...payload });
    } else {
      onCreateMemory(payload);
    }
    resetMemoryForm();
  };
  const editMemory = (entry: MemoryEntry) => {
    setMemoryForm({
      id: entry.id,
      scope: entry.scope,
      appId: entry.appId ?? '',
      kind: entry.kind,
      text: entry.text,
    });
    setMemoryDialogOpen(true);
  };

  return (
    <Stack spacing={2}>
      <Stack spacing={0.5}>
        <Typography variant="h4">{t.sections.settings.title}</Typography>
        <Typography color="text.secondary">{t.sections.settings.subtitle}</Typography>
      </Stack>
      <Card>
        <CardContent>
          <Stack spacing={1.5}>
            <Stack direction="row" justifyContent="space-between" alignItems="flex-start">
              <Stack spacing={0.5}>
                <Typography variant="h6">{t.settings.codexTitle}</Typography>
                <Typography variant="body2" color="text.secondary">{t.settings.codexDescription}</Typography>
              </Stack>
              <Stack direction="row" spacing={0.5} alignItems="center">
                <Chip
                  size="small"
                  color={codexAuthStatus.installed && codexAuthStatus.authenticated ? 'success' : 'default'}
                  label={codexAuthStatus.authenticated ? t.settings.codexConnected : t.settings.codexDisconnected}
                />
              </Stack>
            </Stack>
            <Stack direction="row" spacing={1}>
              <Button
                variant={codexAuthStatus.authenticated ? 'outlined' : 'contained'}
                size="small"
                disabled={codexAuthBusy}
                onClick={onOpenCodexConfig}
              >
                {codexAuthStatus.authenticated ? t.settings.codexConfiguredAction : t.settings.codexConnectAction}
              </Button>
              <Button
                variant="outlined"
                color="warning"
                size="small"
                startIcon={<RestartAltRounded />}
                disabled={codexAuthBusy}
                onClick={onReinstallCodex}
              >
                {t.settings.codexReinstallAction}
              </Button>
            </Stack>
            <Typography variant="caption" color="text.secondary">
              {t.settings.codexReinstallHint}
            </Typography>
            <Divider />
            <Stack spacing={1}>
              <Stack spacing={0.25}>
                <Typography variant="subtitle2">{t.settings.codexDefaultsTitle}</Typography>
                <Typography variant="body2" color="text.secondary">{t.settings.codexDefaultsDescription}</Typography>
              </Stack>
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
                <FormControl size="small" fullWidth>
                  <InputLabel>{t.settings.codexDefaultModel}</InputLabel>
                  <Select
                    label={t.settings.codexDefaultModel}
                    value={codexDefaults.model}
                    onChange={(event) =>
                      onCodexDefaultsChange({
                        ...codexDefaults,
                        model: event.target.value,
                      })
                    }
                  >
                    {modelOptions.map((option) => (
                      <MenuItem value={option.realModelName} key={option.realModelName}>
                        {option.displayModelName}
                      </MenuItem>
                    ))}
                  </Select>
                </FormControl>
                <FormControl size="small" fullWidth>
                  <InputLabel>{t.settings.codexDefaultThinking}</InputLabel>
                  <Select
                    label={t.settings.codexDefaultThinking}
                    value={codexDefaults.reasoningEffort}
                    onChange={(event) =>
                      onCodexDefaultsChange({
                        ...codexDefaults,
                        reasoningEffort: event.target.value as CodexReasoningEffort,
                      })
                    }
                  >
                    {reasoningOptions.map((option) => (
                      <MenuItem value={option.value} key={option.value}>
                        {option.label}
                      </MenuItem>
                    ))}
                  </Select>
                </FormControl>
              </Stack>
            </Stack>
            <Stack spacing={0.35} sx={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>
              <Typography variant="caption" color="text.secondary">
                {t.settings.codexCliPathLabel}: {codexAuthStatus.codexCliPath ?? '-'}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                {t.settings.codexHomeLabel}: {codexAuthStatus.codexHome || '-'}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                {t.settings.codexAuthFileLabel}: {codexAuthStatus.authFilePath || '-'}
              </Typography>
            </Stack>
          </Stack>
        </CardContent>
      </Card>

      <Card>
        <CardContent>
          <Stack spacing={1.5}>
            <Stack direction={{ xs: 'column', sm: 'row' }} justifyContent="space-between" spacing={1.5}>
              <Stack spacing={0.5}>
                <Typography variant="h6">{t.settings.memoryTitle}</Typography>
                <Typography variant="body2" color="text.secondary">{t.settings.memoryDescription}</Typography>
              </Stack>
              <Chip size="small" icon={<MemoryRounded />} label={t.settings.memoryCount(memories.length)} />
            </Stack>
            <Stack direction="row">
              <Button
                variant="outlined"
                size="small"
                startIcon={<MemoryRounded />}
                onClick={() => setMemoryDialogOpen(true)}
              >
                {t.settings.memoryViewAction}
              </Button>
            </Stack>
          </Stack>
        </CardContent>
      </Card>

      <Card>
        <CardContent>
          <Stack spacing={1.5}>
            <Stack direction={{ xs: 'column', sm: 'row' }} justifyContent="space-between" spacing={1.5}>
              <Stack spacing={0.5}>
                <Typography variant="h6">{t.settings.desktopUpdatesTitle}</Typography>
                <Typography variant="body2" color="text.secondary">{t.settings.desktopUpdatesDescription}</Typography>
              </Stack>
              <Chip
                size="small"
                color={
                  desktopUpdateState.status === 'available' || desktopUpdateState.status === 'ready'
                    ? 'warning'
                    : desktopUpdateState.status === 'error' || desktopUpdateState.status === 'unsupported'
                      ? 'error'
                      : desktopUpdateState.status === 'up_to_date'
                        ? 'success'
                        : 'default'
                }
                label={statusLabel}
              />
            </Stack>
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
              <Typography variant="body2">
                {t.settings.desktopCurrentVersion}: <strong>{desktopUpdateState.currentVersion}</strong>
              </Typography>
              <Typography variant="body2">
                {t.settings.desktopAvailableVersion}: <strong>{desktopUpdateState.availableVersion ?? '-'}</strong>
              </Typography>
            </Stack>
            {desktopUpdateState.releaseNotes ? (
              <Stack spacing={0.75}>
                <Typography variant="subtitle2">
                  {desktopUpdateState.releaseNotes.summary ?? t.settings.desktopReleaseNotes}
                </Typography>
                {desktopUpdateState.releaseNotes.changes.length > 0 ? (
                  <Stack component="ul" sx={{ m: 0, pl: 2 }}>
                    {desktopUpdateState.releaseNotes.changes.map((change) => (
                      <Typography component="li" variant="body2" color="text.secondary" key={change}>
                        {change}
                      </Typography>
                    ))}
                  </Stack>
                ) : (
                  <Typography variant="body2" color="text.secondary">{t.appView.updateNoChangelog}</Typography>
                )}
              </Stack>
            ) : null}
            {desktopUpdateState.status === 'downloading' ? (
              <Stack spacing={0.5}>
                <LinearProgress variant={progressPercent === undefined ? 'indeterminate' : 'determinate'} value={progressPercent} />
                <Typography variant="caption" color="text.secondary">
                  {progressPercent === undefined ? t.settings.desktopDownloading : t.settings.desktopDownloadProgress(progressPercent)}
                </Typography>
              </Stack>
            ) : null}
            {desktopUpdateState.userMessage ? (
              <Typography
                variant="body2"
                color={desktopUpdateState.status === 'error' || desktopUpdateState.status === 'unsupported' ? 'error.main' : 'text.secondary'}
              >
                {desktopUpdateState.userMessage}
              </Typography>
            ) : null}
            <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap">
              <Button
                variant="outlined"
                size="small"
                startIcon={<SystemUpdateAltRounded />}
                disabled={desktopUpdateBusy}
                onClick={onCheckDesktopUpdates}
              >
                {t.settings.desktopCheckUpdates}
              </Button>
              <Button
                variant="contained"
                size="small"
                startIcon={<DownloadRounded />}
                disabled={desktopUpdateBusy || !canDownload}
                onClick={onDownloadDesktopUpdate}
              >
                {t.settings.desktopDownloadUpdate}
              </Button>
              <Button
                variant="contained"
                color="warning"
                size="small"
                startIcon={<LaunchRounded />}
                disabled={desktopUpdateBusy || !canInstall}
                onClick={onInstallDesktopUpdate}
              >
                {t.settings.desktopInstallUpdate}
              </Button>
            </Stack>
          </Stack>
        </CardContent>
      </Card>

      <Card>
        <CardContent>
          <Stack spacing={1.5}>
            <Typography variant="h6">{t.settings.appearance}</Typography>
            <Typography color="text.secondary">{t.settings.appearanceDescription}</Typography>
            <Stack spacing={1}>
              <Typography variant="subtitle2">{t.settings.language}</Typography>
              <ToggleButtonGroup
                exclusive
                value={languagePreference}
                onChange={(_event, nextValue: LanguagePreference | null) => {
                  if (nextValue) {
                    onLanguageChange(nextValue);
                  }
                }}
              >
                <ToggleButton value="system">{t.settings.languageSystem(t.settings.languageNames[systemLocale])}</ToggleButton>
                <ToggleButton value="es">{t.settings.languageNames.es}</ToggleButton>
                <ToggleButton value="en">{t.settings.languageNames.en}</ToggleButton>
              </ToggleButtonGroup>
              <Typography variant="caption" color="text.secondary">
                {t.settings.activeLanguage(t.settings.languageNames[activeLocale])}
              </Typography>
            </Stack>
            <ToggleButtonGroup
              exclusive
              value={themePreference}
              onChange={(_event, nextValue: ThemePreference | null) => {
                if (nextValue) {
                  onThemeChange(nextValue);
                }
              }}
            >
              <ToggleButton value="light">{t.settings.themeLight}</ToggleButton>
              <ToggleButton value="dark">{t.settings.themeDark}</ToggleButton>
              <ToggleButton value="system">{t.settings.themeSystem}</ToggleButton>
            </ToggleButtonGroup>
            <Stack spacing={1}>
              <Typography variant="subtitle2">{t.settings.chatBotPicture}</Typography>
              <ToggleButtonGroup
                exclusive
                value={chatBotPicture}
                onChange={(_event, nextValue: ChatBotPicture | null) => {
                  if (nextValue) {
                    onChatBotPictureChange(nextValue);
                  }
                }}
              >
                {chatBotPictureOptions.map((option) => (
                  <ToggleButton key={option.value} value={option.value} sx={{ gap: 1, px: 1.25 }}>
                    <Avatar
                      src={option.src}
                      alt={option.label}
                      sx={{
                        width: 30,
                        height: 30,
                        bgcolor: '#fff',
                        p: 0.05,
                        pb: 0,
                        border: '1px solid',
                        borderColor: 'divider',
                        '& img': { objectFit: 'contain' },
                      }}
                    />
                    {option.label}
                  </ToggleButton>
                ))}
              </ToggleButtonGroup>
            </Stack>
          </Stack>
        </CardContent>
      </Card>

      <Dialog open={memoryDialogOpen} onClose={() => setMemoryDialogOpen(false)} maxWidth="md" fullWidth>
        <DialogTitle>{t.settings.memoryDialogTitle}</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ pt: 1 }}>
            <Card variant="outlined">
              <CardContent>
                <Stack spacing={1.5}>
                  <Typography variant="subtitle1">
                    {memoryForm.id ? t.settings.memoryEdit : t.settings.memoryNew}
                  </Typography>
                  <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
                    <FormControl fullWidth size="small">
                      <InputLabel>{t.settings.memoryScope}</InputLabel>
                      <Select
                        label={t.settings.memoryScope}
                        value={memoryForm.scope}
                        onChange={(event) => setMemoryForm((current) => ({
                          ...current,
                          scope: event.target.value as MemoryScope,
                          appId: event.target.value === 'global' ? '' : current.appId,
                        }))}
                      >
                        <MenuItem value="global">{t.settings.memoryScopeGlobal}</MenuItem>
                        <MenuItem value="app">{t.settings.memoryScopeApp}</MenuItem>
                      </Select>
                    </FormControl>
                    <FormControl fullWidth size="small" disabled={memoryForm.scope !== 'app'}>
                      <InputLabel>{t.settings.memoryApp}</InputLabel>
                      <Select
                        label={t.settings.memoryApp}
                        value={memoryForm.appId}
                        onChange={(event) => setMemoryForm((current) => ({
                          ...current,
                          appId: event.target.value,
                        }))}
                      >
                        {installedApps.map((appEntry) => (
                          <MenuItem value={appEntry.id} key={appEntry.id}>{appEntry.name}</MenuItem>
                        ))}
                      </Select>
                    </FormControl>
                    <FormControl fullWidth size="small">
                      <InputLabel>{t.settings.memoryKind}</InputLabel>
                      <Select
                        label={t.settings.memoryKind}
                        value={memoryForm.kind}
                        onChange={(event) => setMemoryForm((current) => ({
                          ...current,
                          kind: event.target.value as MemoryKind,
                        }))}
                      >
                        {MEMORY_KINDS.map((kind) => (
                          <MenuItem value={kind} key={kind}>{t.settings.memoryKinds[kind]}</MenuItem>
                        ))}
                      </Select>
                    </FormControl>
                  </Stack>
                  <TextField
                    label={t.settings.memoryText}
                    value={memoryForm.text}
                    onChange={(event) => setMemoryForm((current) => ({ ...current, text: event.target.value }))}
                    multiline
                    minRows={3}
                    fullWidth
                  />
                  <Stack direction="row" spacing={1} justifyContent="flex-end">
                    <Button size="small" onClick={resetMemoryForm}>{t.settings.memoryCancel}</Button>
                    <Button
                      size="small"
                      variant="contained"
                      startIcon={<AddRounded />}
                      disabled={memoryFormInvalid}
                      onClick={submitMemoryForm}
                    >
                      {t.settings.memorySave}
                    </Button>
                  </Stack>
                </Stack>
              </CardContent>
            </Card>

            <MemoryGroup
              title={t.settings.memoryGlobalGroup}
              memories={globalMemories}
              t={t}
              onEdit={editMemory}
              onDelete={onDeleteMemory}
            />
            {appMemoryGroups.map(([appId, entries]) => (
              <MemoryGroup
                key={appId}
                title={t.settings.memoryAppGroup(appNames.get(appId) ?? appId)}
                memories={entries}
                t={t}
                onEdit={editMemory}
                onDelete={onDeleteMemory}
              />
            ))}
            {memories.length === 0 ? (
              <Typography variant="body2" color="text.secondary">{t.settings.memoryEmpty}</Typography>
            ) : null}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setMemoryDialogOpen(false)}>{t.settings.memoryClose}</Button>
        </DialogActions>
      </Dialog>

    </Stack>
  );
}

function MemoryGroup({
  title,
  memories,
  t,
  onEdit,
  onDelete,
}: {
  title: string;
  memories: MemoryEntry[];
  t: AppDictionary;
  onEdit: (entry: MemoryEntry) => void;
  onDelete: (id: string) => void;
}) {
  if (memories.length === 0) {
    return null;
  }
  return (
    <Stack spacing={1}>
      <Typography variant="subtitle2">{title}</Typography>
      <Stack divider={<Divider flexItem />} sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 2 }}>
        {memories.map((entry) => (
          <Stack
            key={entry.id}
            direction="row"
            spacing={1.5}
            alignItems="flex-start"
            justifyContent="space-between"
            sx={{ p: 1.25 }}
          >
            <Stack spacing={0.5}>
              <Stack direction="row" spacing={1} alignItems="center">
                <Chip size="small" label={t.settings.memoryKinds[entry.kind]} />
                <Typography variant="caption" color="text.secondary">
                  {new Date(entry.updatedAt).toLocaleString()}
                </Typography>
              </Stack>
              <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap' }}>{entry.text}</Typography>
            </Stack>
            <Stack direction="row" spacing={0.5}>
              <Tooltip title={t.settings.memoryEdit}>
                <IconButton size="small" onClick={() => onEdit(entry)}>
                  <EditRounded fontSize="small" />
                </IconButton>
              </Tooltip>
              <Tooltip title={t.settings.memoryDelete}>
                <IconButton size="small" color="error" onClick={() => onDelete(entry.id)}>
                  <DeleteOutlineRounded fontSize="small" />
                </IconButton>
              </Tooltip>
            </Stack>
          </Stack>
        ))}
      </Stack>
    </Stack>
  );
}
