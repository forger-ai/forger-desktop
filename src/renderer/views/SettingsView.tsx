/* eslint-disable max-lines */
import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import {
  Box,
  Button,
  Card,
  CardActionArea,
  CardContent,
  Chip,
  Divider,
  FormControl,
  FormControlLabel,
  IconButton,
  InputLabel,
  MenuItem,
  Avatar,
  LinearProgress,
  Select,
  Stack,
  Switch,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from '@mui/material';
import AddRounded from '@mui/icons-material/AddRounded';
import ArrowBackRounded from '@mui/icons-material/ArrowBackRounded';
import BackupRounded from '@mui/icons-material/BackupRounded';
import ConstructionRounded from '@mui/icons-material/ConstructionRounded';
import ContentCopyRounded from '@mui/icons-material/ContentCopyRounded';
import DeleteOutlineRounded from '@mui/icons-material/DeleteOutlineRounded';
import DevicesRounded from '@mui/icons-material/DevicesRounded';
import EditRounded from '@mui/icons-material/EditRounded';
import EventRepeatRounded from '@mui/icons-material/EventRepeatRounded';
import InsertDriveFileRounded from '@mui/icons-material/InsertDriveFileRounded';
import KeyboardArrowRightRounded from '@mui/icons-material/KeyboardArrowRightRounded';
import MemoryRounded from '@mui/icons-material/MemoryRounded';
import MenuBookRounded from '@mui/icons-material/MenuBookRounded';
import PaletteRounded from '@mui/icons-material/PaletteRounded';
import PrivacyTipRounded from '@mui/icons-material/PrivacyTipRounded';
import PsychologyRounded from '@mui/icons-material/PsychologyRounded';
import SystemUpdateAltRounded from '@mui/icons-material/SystemUpdateAltRounded';
import DownloadRounded from '@mui/icons-material/DownloadRounded';
import LaunchRounded from '@mui/icons-material/LaunchRounded';
import RestartAltRounded from '@mui/icons-material/RestartAltRounded';
import RefreshRounded from '@mui/icons-material/RefreshRounded';
import StorageRounded from '@mui/icons-material/StorageRounded';
import TableChartRounded from '@mui/icons-material/TableChartRounded';
import VpnKeyRounded from '@mui/icons-material/VpnKeyRounded';
import type {
  AppSummary,
  ClaudeAuthStatus,
  ClaudeEffort,
  CodexAuthStatus,
  DesktopUpdateState,
  MemoryCreateInput,
  MemoryEntry,
  MemoryKind,
  MemoryScope,
  MemoryStatus,
  MemoryUpdateInput,
  CodexModelOption,
  CodexReasoningEffort,
  AgentProvider,
  CloudIdentityState,
  CloudStorageUsage,
  ForumParticipationState,
  Settings,
  DeveloperPathState,
  UpdateAgentDefaultsInput,
  UpdateDeveloperModeInput,
} from '@shared/types';
import type { AppDictionary, Locale } from '@renderer/i18n';
import type { ThemePreference } from '@renderer/theme/appTheme';
import type { ChatBotPicture, LanguagePreference } from '@renderer/preferences';
import type { View } from '@renderer/components/Sidebar';

interface SettingsViewProps {
  codexAuthBusy: boolean;
  claudeAuthBusy: boolean;
  codexAuthStatus: CodexAuthStatus;
  claudeAuthStatus: ClaudeAuthStatus;
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
  providerOptions: Array<{ label: string; value: AgentProvider | 'auto' }>;
  claudeModelOptions: Array<{ displayModelName: string; realModelName: string }>;
  claudeEffortOptions: { label: string; value: ClaudeEffort }[];
  defaultAgentProvider: Settings['defaultAgentProvider'];
  defaultChatPermissionMode: Settings['defaultChatPermissionMode'];
  defaultChatNetworkAccess: Settings['defaultChatNetworkAccess'];
  agentDefaults: Settings['agentDefaults'];
  onAgentDefaultsChange: (input: UpdateAgentDefaultsInput) => void;
  developerMode: Settings['developerMode'];
  onDeveloperModeChange: (input: UpdateDeveloperModeInput) => Promise<void>;
  onOpenCodexConfig: () => void;
  onReinstallCodex: () => void;
  onOpenClaudeConfig: () => void;
  onReinstallClaude: () => void;
  desktopUpdateState: DesktopUpdateState;
  desktopUpdateBusy: boolean;
  cloudStorageUsage: CloudStorageUsage | null;
  cloudStorageBusy: boolean;
  onRefreshCloudStorage: () => void;
  onCheckDesktopUpdates: () => void;
  onDownloadDesktopUpdate: () => void;
  onInstallDesktopUpdate: () => void;
  installedApps: AppSummary[];
  memories: MemoryEntry[];
  onCreateMemory: (input: MemoryCreateInput) => void;
  onUpdateMemory: (input: MemoryUpdateInput) => void;
  onDeleteMemory: (id: string) => void;
  cloudIdentity: CloudIdentityState | null;
  onRevealCloudSecretKey: () => Promise<string>;
  onRegenerateCloudSecretKey: () => void;
  earlyAccessEnabled: boolean;
  advancedMode: boolean;
  usageAnalyticsEnabled: boolean;
  forumParticipation: ForumParticipationState;
  forumParticipationBusy: boolean;
  onEnterForum: () => void;
  onEarlyAccessChange: (enabled: boolean) => void;
  onAdvancedModeChange: (enabled: boolean) => void;
  onUsageAnalyticsChange: (enabled: boolean) => void;
  onNavigate: (view: View) => void;
  onResetOnboarding: () => void;
}

interface MemoryFormState {
  id?: string;
  scope: MemoryScope;
  appId: string;
  kind: MemoryKind;
  title: string;
  body: string;
  readWhen: string;
  status: MemoryStatus;
}

const EMPTY_MEMORY_FORM: MemoryFormState = {
  scope: 'global',
  appId: '',
  kind: 'preference',
  title: '',
  body: '',
  readWhen: '',
  status: 'active',
};

const MEMORY_KINDS: MemoryKind[] = ['preference', 'profile', 'workflow', 'constraint', 'fact'];
const MEMORY_STATUSES: MemoryStatus[] = ['active', 'candidate', 'archived'];
const COMMON_DEVELOPER_PATHS = ['/opt/homebrew/bin', '/usr/local/bin'];
type SettingsSubview = 'main' | 'llmProvider' | 'privacySecurity' | 'appearance' | 'storage' | 'developerMode' | 'memory';

const formatStorageBytes = (bytes: number, locale: string) => {
  const units = [
    { value: 1024 ** 3, label: 'GB' },
    { value: 1024 ** 2, label: 'MB' },
    { value: 1024, label: 'KB' },
  ];
  const unit = units.find((entry) => bytes >= entry.value) ?? units[1];
  const value = bytes / unit.value;
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: value >= 10 ? 0 : 1 }).format(value)} ${unit.label}`;
};

interface SettingsRowItem {
  key: string;
  label: string;
  description: string;
  icon: ReactNode;
  onClick: () => void;
}

const PathPreview = ({ title, entries }: { title: string; entries: string[] }) => (
  <Stack spacing={0.5}>
    <Typography variant="caption" color="text.secondary">{title}</Typography>
    <Box
      component="pre"
      sx={{
        m: 0,
        p: 1,
        border: '1px solid',
        borderColor: 'divider',
        bgcolor: 'background.default',
        maxHeight: 120,
        overflow: 'auto',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        fontFamily: 'monospace',
        fontSize: 12,
      }}
    >
      {entries.length > 0 ? entries.join('\n') : '-'}
    </Box>
  </Stack>
);

const SettingsList = ({ children }: { children: ReactNode }) => (
  <Stack spacing={0} sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 1, overflow: 'hidden' }} divider={<Divider />}>
    {children}
  </Stack>
);

const SettingsRow = ({ item }: { item: SettingsRowItem }) => (
  <CardActionArea onClick={item.onClick}>
    <Stack direction="row" spacing={1.5} alignItems="center" sx={{ px: 1.5, py: 1.25, minHeight: 72 }}>
      <Box sx={{ color: 'primary.main', display: 'grid', placeItems: 'center' }}>{item.icon}</Box>
      <Box sx={{ minWidth: 0, flex: 1 }}>
        <Typography variant="subtitle2">{item.label}</Typography>
        <Typography variant="body2" color="text.secondary">{item.description}</Typography>
      </Box>
      <KeyboardArrowRightRounded color="action" />
    </Stack>
  </CardActionArea>
);

const SettingsSubviewHeader = ({
  title,
  description,
  backLabel,
  onBack,
}: {
  title: string;
  description?: string;
  backLabel: string;
  onBack: () => void;
}) => (
  <Stack spacing={1.5}>
    <Button startIcon={<ArrowBackRounded />} variant="text" onClick={onBack} sx={{ alignSelf: 'flex-start' }}>
      {backLabel}
    </Button>
    <Stack spacing={0.5}>
      <Typography variant="h4">{title}</Typography>
      {description ? <Typography color="text.secondary">{description}</Typography> : null}
    </Stack>
  </Stack>
);

export function SettingsView({
  codexAuthBusy,
  claudeAuthBusy,
  codexAuthStatus,
  claudeAuthStatus,
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
  providerOptions,
  claudeModelOptions,
  claudeEffortOptions,
  defaultAgentProvider,
  defaultChatPermissionMode,
  defaultChatNetworkAccess,
  agentDefaults,
  onAgentDefaultsChange,
  developerMode,
  onDeveloperModeChange,
  onOpenCodexConfig,
  onReinstallCodex,
  onOpenClaudeConfig,
  onReinstallClaude,
  desktopUpdateState,
  desktopUpdateBusy,
  cloudStorageUsage,
  cloudStorageBusy,
  onRefreshCloudStorage,
  onCheckDesktopUpdates,
  onDownloadDesktopUpdate,
  onInstallDesktopUpdate,
  installedApps,
  memories,
  onCreateMemory,
  onUpdateMemory,
  onDeleteMemory,
  cloudIdentity,
  onRevealCloudSecretKey,
  onRegenerateCloudSecretKey,
  earlyAccessEnabled,
  advancedMode,
  usageAnalyticsEnabled,
  onEarlyAccessChange,
  onAdvancedModeChange,
  onUsageAnalyticsChange,
  onNavigate,
  onResetOnboarding,
}: SettingsViewProps) {
  const [settingsSubview, setSettingsSubview] = useState<SettingsSubview>('main');
  const [revealedSecretKey, setRevealedSecretKey] = useState('');
  const [memoryForm, setMemoryForm] = useState<MemoryFormState>(EMPTY_MEMORY_FORM);
  const [developerPathDraft, setDeveloperPathDraft] = useState(developerMode.pathEntries.join('\n'));
  const [developerPathState, setDeveloperPathState] = useState<DeveloperPathState | null>(null);
  const [developerBusy, setDeveloperBusy] = useState(false);
  const [developerError, setDeveloperError] = useState('');
  const canDownload = desktopUpdateState.status === 'available' && Boolean(desktopUpdateState.asset);
  const canInstall = desktopUpdateState.status === 'ready' && Boolean(desktopUpdateState.downloadedPath);
  const progressPercent =
    typeof desktopUpdateState.progress === 'number'
      ? Math.round(desktopUpdateState.progress * 100)
      : undefined;
  const statusLabel = t.settings.desktopUpdateStatuses[desktopUpdateState.status];
  useEffect(() => {
    setDeveloperPathDraft(developerMode.pathEntries.join('\n'));
  }, [developerMode.pathEntries]);
  useEffect(() => {
    let cancelled = false;
    void window.forger.getDeveloperPathState().then((state) => {
      if (!cancelled) {
        setDeveloperPathState(state);
      }
    }).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [developerMode]);
  const saveDeveloperMode = async (input: UpdateDeveloperModeInput) => {
    setDeveloperBusy(true);
    setDeveloperError('');
    try {
      await onDeveloperModeChange(input);
      setDeveloperPathState(await window.forger.getDeveloperPathState());
    } catch (error) {
      setDeveloperError(error instanceof Error ? error.message : t.settings.developerPathSaveError);
    } finally {
      setDeveloperBusy(false);
    }
  };
  const addDeveloperPathDraft = (entry: string) => {
    const current = developerPathDraft.split('\n').map((value) => value.trim()).filter(Boolean);
    if (!current.includes(entry)) {
      setDeveloperPathDraft([...current, entry].join('\n'));
    }
  };
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
  const memoryFormInvalid = !memoryForm.body.trim() || memoryFormAppRequired;
  const advancedLinks: Array<{ view: View; label: string; description: string; icon: ReactNode }> = [
    { view: 'tools', label: t.nav.tools, description: t.settings.advancedSurfaces.tools, icon: <ConstructionRounded /> },
    { view: 'files', label: t.nav.files, description: t.settings.advancedSurfaces.files, icon: <InsertDriveFileRounded /> },
    { view: 'backups', label: t.nav.backups, description: t.settings.advancedSurfaces.backups, icon: <BackupRounded /> },
    { view: 'devices', label: t.nav.devices, description: t.settings.advancedSurfaces.devices, icon: <DevicesRounded /> },
    { view: 'datos', label: t.nav.datos, description: t.settings.advancedSurfaces.datos, icon: <TableChartRounded /> },
    { view: 'secrets', label: t.nav.secrets, description: t.settings.advancedSurfaces.secrets, icon: <VpnKeyRounded /> },
    { view: 'automations', label: t.nav.automations, description: t.settings.advancedSurfaces.automations, icon: <EventRepeatRounded /> },
    { view: 'docs', label: t.nav.docs, description: t.settings.advancedSurfaces.docs, icon: <MenuBookRounded /> },
  ];

  const resetMemoryForm = () => setMemoryForm(EMPTY_MEMORY_FORM);
  const submitMemoryForm = () => {
    if (memoryFormInvalid) return;
    const payload = {
      scope: memoryForm.scope,
      appId: memoryForm.scope === 'app' ? memoryForm.appId : undefined,
      kind: memoryForm.kind,
      title: memoryForm.title,
      body: memoryForm.body,
      readWhen: memoryForm.readWhen,
      status: memoryForm.status,
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
      title: entry.title,
      body: entry.body,
      readWhen: entry.readWhen,
      status: entry.status,
    });
  };

  const renderBetaDisclaimer = () => (
    <Card
      variant="outlined"
      sx={{
        borderColor: 'warning.main',
        bgcolor: 'warning.main',
        color: 'warning.contrastText',
        '& .MuiChip-root': {
          bgcolor: 'rgba(0, 0, 0, 0.18)',
          color: 'inherit',
        },
      }}
    >
      <CardContent>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} justifyContent="space-between" alignItems={{ xs: 'flex-start', sm: 'center' }}>
          <Stack spacing={0.5}>
            <Typography variant="h6">{t.settings.openBetaTitle}</Typography>
            <Typography variant="body2" sx={{ opacity: 0.9 }}>{t.settings.openBetaDescription}</Typography>
          </Stack>
          <Chip label="Open Beta" size="small" />
        </Stack>
      </CardContent>
    </Card>
  );

  const renderDesktopUpdates = () => (
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
  );

  const renderBetaControls = () => (
    <Card>
      <CardContent>
        <Stack spacing={1.5}>
          <Stack spacing={0.5}>
            <Typography variant="h6">{t.settings.betaTitle}</Typography>
            <Typography variant="body2" color="text.secondary">{t.settings.betaDescription}</Typography>
          </Stack>
          <Stack spacing={0.5}>
            <FormControlLabel
              control={<Switch checked={advancedMode} onChange={(event) => onAdvancedModeChange(event.target.checked)} />}
              label={t.settings.advancedModeToggle}
            />
            <FormControlLabel
              control={<Switch checked={earlyAccessEnabled} onChange={(event) => onEarlyAccessChange(event.target.checked)} />}
              label={t.settings.earlyAccessToggle}
            />
          </Stack>
          <Button size="small" variant="outlined" onClick={onResetOnboarding} sx={{ alignSelf: 'flex-start' }}>
            {t.settings.resetOnboarding}
          </Button>
        </Stack>
      </CardContent>
    </Card>
  );

  const renderStorage = () => {
    const storagePercent = cloudStorageUsage && cloudStorageUsage.limitBytes > 0
      ? Math.min(100, Math.round((cloudStorageUsage.usedBytes / cloudStorageUsage.limitBytes) * 100))
      : 0;
    const storageColor = storagePercent >= 95 ? 'error' : storagePercent >= 80 ? 'warning' : 'primary';
    const uploadedAppsBytes = cloudStorageUsage
      ? cloudStorageUsage.breakdown.uploadedAppsBytes + cloudStorageUsage.breakdown.pendingUserAppUploadsBytes
      : 0;
    const rows = cloudStorageUsage ? [
      {
        key: 'backups',
        label: t.settings.storageBreakdownBackups,
        description: t.settings.storageBreakdownBackupsDescription,
        bytes: cloudStorageUsage.breakdown.backupsBytes,
      },
      {
        key: 'uploadedApps',
        label: t.settings.storageBreakdownUploadedApps,
        description: t.settings.storageBreakdownUploadedAppsDescription,
        bytes: uploadedAppsBytes,
      },
      {
        key: 'other',
        label: t.settings.storageBreakdownOther,
        description: t.settings.storageBreakdownOtherDescription,
        bytes: cloudStorageUsage.breakdown.otherBytes,
      },
    ] : [];

    return (
      <Stack spacing={2}>
        <Card>
          <CardContent>
            <Stack spacing={1.5}>
              <Stack direction={{ xs: 'column', sm: 'row' }} justifyContent="space-between" spacing={1.5}>
                <Stack spacing={0.5}>
                  <Typography variant="h6">{t.settings.storageCloudTitle}</Typography>
                  <Typography variant="body2" color="text.secondary">{t.settings.storageDescription}</Typography>
                </Stack>
                {cloudStorageUsage ? <Chip size="small" label={t.settings.storagePlanLabel(cloudStorageUsage.plan)} /> : null}
              </Stack>
              {cloudStorageUsage ? (
                <>
                  <Typography variant="h5">
                    {t.settings.storageUsedOfLimit(
                      formatStorageBytes(cloudStorageUsage.usedBytes, t.locale),
                      formatStorageBytes(cloudStorageUsage.limitBytes, t.locale),
                    )}
                  </Typography>
                  <LinearProgress variant="determinate" value={storagePercent} color={storageColor} sx={{ height: 8, borderRadius: 1 }} />
                  <Typography variant="body2" color="text.secondary">
                    {t.settings.storageRemaining(formatStorageBytes(cloudStorageUsage.remainingBytes, t.locale))}
                  </Typography>
                  {storagePercent >= 100 ? (
                    <Typography variant="body2" color="error.main">{t.settings.storageLimitReached}</Typography>
                  ) : null}
                </>
              ) : (
                <Typography variant="body2" color="text.secondary">
                  {cloudStorageBusy ? t.settings.storageLoading : t.settings.storageUnavailable}
                </Typography>
              )}
              <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap">
                <Button size="small" variant="outlined" startIcon={<RefreshRounded />} disabled={cloudStorageBusy} onClick={onRefreshCloudStorage}>
                  {t.settings.storageRefresh}
                </Button>
                <Button size="small" variant="outlined" startIcon={<BackupRounded />} onClick={() => onNavigate('backups')}>
                  {t.settings.storageManageBackups}
                </Button>
                <Button size="small" variant="outlined" onClick={() => onNavigate('friends')}>
                  {t.settings.storageManageUploadedApps}
                </Button>
              </Stack>
            </Stack>
          </CardContent>
        </Card>
        <Card>
          <CardContent>
            <Stack spacing={1.5}>
              <Typography variant="h6">{t.settings.storageBreakdownTitle}</Typography>
              {cloudStorageUsage ? rows.map((row) => (
                <Stack key={row.key} direction={{ xs: 'column', sm: 'row' }} spacing={1.5} justifyContent="space-between" alignItems={{ xs: 'flex-start', sm: 'center' }}>
                  <Stack spacing={0.25}>
                    <Typography variant="subtitle2">{row.label}</Typography>
                    <Typography variant="body2" color="text.secondary">{row.description}</Typography>
                  </Stack>
                  <Typography variant="subtitle2">{formatStorageBytes(row.bytes, t.locale)}</Typography>
                </Stack>
              )) : (
                <Typography variant="body2" color="text.secondary">{t.settings.storageUnavailable}</Typography>
              )}
            </Stack>
          </CardContent>
        </Card>
        <Card variant="outlined">
          <CardContent>
            <Typography variant="body2" color="text.secondary">{t.settings.storageDiagnosticsExcluded}</Typography>
          </CardContent>
        </Card>
      </Stack>
    );
  };

  const renderLlmProvider = () => (
    <Card>
      <CardContent>
        <Stack spacing={1.5}>
          <Stack direction="row" justifyContent="space-between" alignItems="flex-start">
            <Stack spacing={0.5}>
              <Typography variant="h6">{t.settings.codexTitle}</Typography>
              <Typography variant="body2" color="text.secondary">{t.settings.codexDescription}</Typography>
            </Stack>
            <Chip
              size="small"
              color={codexAuthStatus.installed && codexAuthStatus.authenticated ? 'success' : 'default'}
              label={codexAuthStatus.authenticated ? t.settings.codexConnected : t.settings.codexDisconnected}
            />
          </Stack>
          <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap">
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
          <Stack direction="row" justifyContent="space-between" alignItems="flex-start">
            <Stack spacing={0.5}>
              <Typography variant="h6">{t.settings.claudeCodeTitle}</Typography>
              <Typography variant="body2" color="text.secondary">{t.settings.claudeDescription}</Typography>
            </Stack>
            <Chip
              size="small"
              color={claudeAuthStatus.installed && claudeAuthStatus.authenticated ? 'success' : 'default'}
              label={claudeAuthStatus.authenticated ? t.settings.codexConnected : t.settings.codexDisconnected}
            />
          </Stack>
          <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap">
            <Button
              variant={claudeAuthStatus.authenticated ? 'outlined' : 'contained'}
              size="small"
              disabled={claudeAuthBusy}
              onClick={onOpenClaudeConfig}
            >
              {claudeAuthStatus.authenticated ? t.settings.claudeConfiguredAction : t.settings.claudeConnectAction}
            </Button>
            <Button
              variant="outlined"
              color="warning"
              size="small"
              startIcon={<RestartAltRounded />}
              disabled={claudeAuthBusy}
              onClick={onReinstallClaude}
            >
              {t.settings.claudeReinstallAction}
            </Button>
          </Stack>
          <Typography variant="caption" color="text.secondary">
            {t.settings.claudeLocalSessionHint}
          </Typography>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
            <Chip
              size="small"
              label={
                claudeAuthStatus.source === 'managed'
                  ? t.settings.claudeSourceManaged
                  : claudeAuthStatus.source === 'system'
                    ? t.settings.claudeSourceSystem
                    : t.settings.claudeSourceMissing
              }
            />
            {claudeAuthStatus.version ? <Chip size="small" label={t.settings.versionLabel(claudeAuthStatus.version)} /> : null}
          </Stack>
          <Divider />
          <Stack spacing={1}>
            <Stack spacing={0.25}>
              <Typography variant="subtitle2">{t.settings.agentDefaultsTitle}</Typography>
              <Typography variant="body2" color="text.secondary">
                {t.settings.agentDefaultsDescription}
              </Typography>
            </Stack>
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
              <FormControl size="small" fullWidth>
                <InputLabel>{t.settings.agentDefaultProvider}</InputLabel>
                <Select
                  label={t.settings.agentDefaultProvider}
                  value={defaultAgentProvider}
                  onChange={(event) =>
                    onAgentDefaultsChange({
                      defaultProvider: event.target.value as AgentProvider | 'auto',
                    })
                  }
                >
                  {providerOptions.map((option) => (
                    <MenuItem value={option.value} key={option.value}>
                      {option.label}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
              <FormControl size="small" fullWidth>
                <InputLabel>{t.settings.agentDefaultChatPermissions}</InputLabel>
                <Select
                  label={t.settings.agentDefaultChatPermissions}
                  value={defaultChatPermissionMode}
                  onChange={(event) =>
                    onAgentDefaultsChange({
                      defaultProvider: defaultAgentProvider,
                      defaultChatPermissionMode: event.target.value as Settings['defaultChatPermissionMode'],
                    })
                  }
                >
                  <MenuItem value="safe">{t.sections.chat.permissionNormalLabel}</MenuItem>
                  <MenuItem value="unsafe">{t.sections.chat.permissionElevatedLabel}</MenuItem>
                </Select>
              </FormControl>
              <FormControl size="small" fullWidth>
                <InputLabel>{t.settings.agentDefaultChatNetwork}</InputLabel>
                <Select
                  label={t.settings.agentDefaultChatNetwork}
                  value={defaultChatNetworkAccess ? 'enabled' : 'disabled'}
                  onChange={(event) =>
                    onAgentDefaultsChange({
                      defaultProvider: defaultAgentProvider,
                      defaultChatNetworkAccess: event.target.value === 'enabled',
                    })
                  }
                >
                  <MenuItem value="enabled">{t.sections.chat.networkEnabledLabel}</MenuItem>
                  <MenuItem value="disabled">{t.sections.chat.networkDisabledLabel}</MenuItem>
                </Select>
              </FormControl>
              <FormControl size="small" fullWidth>
                <InputLabel>{t.settings.codexModelLabel}</InputLabel>
                <Select
                  label={t.settings.codexModelLabel}
                  value={agentDefaults.codex.model}
                  onChange={(event) =>
                    onAgentDefaultsChange({
                      defaultProvider: defaultAgentProvider,
                      provider: 'codex',
                      model: event.target.value,
                      effort: agentDefaults.codex.reasoningEffort,
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
                <InputLabel>{t.settings.codexReasoningLabel}</InputLabel>
                <Select
                  label={t.settings.codexReasoningLabel}
                  value={agentDefaults.codex.reasoningEffort}
                  onChange={(event) =>
                    onAgentDefaultsChange({
                      defaultProvider: defaultAgentProvider,
                      provider: 'codex',
                      model: agentDefaults.codex.model,
                      effort: event.target.value as CodexReasoningEffort,
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
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
              <FormControl size="small" fullWidth>
                <InputLabel>{t.settings.claudeModelLabel}</InputLabel>
                <Select
                  label={t.settings.claudeModelLabel}
                  value={agentDefaults.claude.model}
                  onChange={(event) =>
                    onAgentDefaultsChange({
                      defaultProvider: defaultAgentProvider,
                      provider: 'claude',
                      model: event.target.value,
                      effort: agentDefaults.claude.effort,
                    })
                  }
                >
                  {claudeModelOptions.map((option) => (
                    <MenuItem value={option.realModelName} key={option.realModelName}>
                      {option.displayModelName}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
              <FormControl size="small" fullWidth>
                <InputLabel>{t.settings.claudeEffortLabel}</InputLabel>
                <Select
                  label={t.settings.claudeEffortLabel}
                  value={agentDefaults.claude.effort}
                  onChange={(event) =>
                    onAgentDefaultsChange({
                      defaultProvider: defaultAgentProvider,
                      provider: 'claude',
                      model: agentDefaults.claude.model,
                      effort: event.target.value as ClaudeEffort,
                    })
                  }
                >
                  {claudeEffortOptions.map((option) => (
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
  );

  const renderPrivacySecurity = () => (
    <Card>
      <CardContent>
        <Stack spacing={1.5}>
          <Stack spacing={0.5}>
            <Typography variant="h6">{t.settings.secretKeyTitle}</Typography>
            <Typography variant="body2" color="text.secondary">{t.settings.secretKeyDescription}</Typography>
          </Stack>
          <Stack direction={{ xs: 'column', md: 'row' }} spacing={1} alignItems="center">
            <TextField
              size="small"
              type={revealedSecretKey ? 'text' : 'password'}
              value={revealedSecretKey || cloudIdentity?.secretKeyPreview || ''}
              label={t.settings.secretKeyLabel}
              fullWidth
              InputProps={{ readOnly: true }}
            />
            <Button
              variant="outlined"
              size="small"
              onClick={() => {
                void onRevealCloudSecretKey().then((value) => setRevealedSecretKey(value));
              }}
            >
              {t.settings.secretKeyReveal}
            </Button>
            <Button
              variant="outlined"
              size="small"
              startIcon={<ContentCopyRounded />}
              onClick={() => {
                const value = revealedSecretKey || cloudIdentity?.secretKeyPreview || '';
                void navigator.clipboard.writeText(value);
              }}
            >
              {t.settings.secretKeyCopy}
            </Button>
            <Button
              variant="outlined"
              color="warning"
              size="small"
              onClick={() => {
                if (window.confirm(t.settings.secretKeyRegenerateConfirm)) {
                  setRevealedSecretKey('');
                  onRegenerateCloudSecretKey();
                }
              }}
            >
              {t.settings.secretKeyRegenerate}
            </Button>
          </Stack>
          <Divider />
          <Stack spacing={1.25}>
            <Stack spacing={0.5}>
              <Typography variant="h6">{t.settings.usageAnalyticsTitle}</Typography>
              <Typography variant="body2" color="text.secondary">{t.settings.usageAnalyticsDescription}</Typography>
            </Stack>
            <Tooltip title={t.settings.usageAnalyticsHelp} placement="top">
              <FormControlLabel
                control={
                  <Switch
                    checked={usageAnalyticsEnabled}
                    onChange={(event) => onUsageAnalyticsChange(event.target.checked)}
                  />
                }
                label={t.settings.usageAnalyticsToggle}
              />
            </Tooltip>
          </Stack>
        </Stack>
      </CardContent>
    </Card>
  );

  const renderAppearance = () => (
    <Card>
      <CardContent>
        <Stack spacing={1.5}>
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
  );

  const renderDeveloperMode = () => (
    <Card>
      <CardContent>
        <Stack spacing={1.5}>
          <FormControlLabel
            control={
              <Switch
                checked={developerMode.enabled}
                onChange={(event) => void saveDeveloperMode({ enabled: event.target.checked })}
                disabled={developerBusy}
              />
            }
            label={t.settings.developerModeToggle}
          />
          {developerMode.enabled ? (
            <>
              <TextField
                label={t.settings.developerPathEntriesLabel}
                value={developerPathDraft}
                onChange={(event) => setDeveloperPathDraft(event.target.value)}
                fullWidth
                multiline
                minRows={4}
                helperText={t.settings.developerPathEntriesHelp}
                inputProps={{ spellCheck: false }}
                sx={{ '& textarea': { fontFamily: 'monospace', fontSize: 13 } }}
              />
              <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap">
                {COMMON_DEVELOPER_PATHS.map((entry) => (
                  <Button
                    key={entry}
                    size="small"
                    variant="outlined"
                    onClick={() => addDeveloperPathDraft(entry)}
                    disabled={developerBusy || developerPathDraft.split('\n').map((value) => value.trim()).includes(entry)}
                  >
                    {t.settings.developerQuickAddPath(entry)}
                  </Button>
                ))}
              </Stack>
              {developerError ? <Typography color="error.main" variant="body2">{developerError}</Typography> : null}
              <Button
                variant="outlined"
                disabled={developerBusy}
                onClick={() => void saveDeveloperMode({ pathEntries: developerPathDraft.split('\n') })}
                sx={{ alignSelf: 'flex-start' }}
              >
                {t.settings.developerPathSave}
              </Button>
              {developerPathState ? (
                <Stack spacing={1}>
                  <Typography variant="subtitle2">{t.settings.developerEffectivePathTitle}</Typography>
                  <PathPreview title={t.settings.developerRuntimePathTitle} entries={developerPathState.runtimePathEntries} />
                  <PathPreview title={t.settings.developerGlobalPathTitle} entries={developerPathState.globalPathEntries} />
                  <PathPreview title={t.settings.developerSystemPathTitle} entries={developerPathState.systemPathEntries} />
                  <PathPreview title={t.settings.developerEffectivePathTitle} entries={developerPathState.effectivePathEntries} />
                </Stack>
              ) : null}
            </>
          ) : null}
        </Stack>
      </CardContent>
    </Card>
  );

  const renderMemory = () => (
    <Stack spacing={2}>
      <Card>
        <CardContent>
          <Stack spacing={1.5}>
            <Stack direction={{ xs: 'column', sm: 'row' }} justifyContent="space-between" spacing={1.5}>
              <Typography variant="subtitle1">
                {memoryForm.id ? t.settings.memoryEdit : t.settings.memoryNew}
              </Typography>
              <Chip size="small" icon={<MemoryRounded />} label={t.settings.memoryCount(memories.length)} />
            </Stack>
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
              <FormControl fullWidth size="small">
                <InputLabel>{t.settings.memoryStatus}</InputLabel>
                <Select
                  label={t.settings.memoryStatus}
                  value={memoryForm.status}
                  onChange={(event) => setMemoryForm((current) => ({
                    ...current,
                    status: event.target.value as MemoryStatus,
                  }))}
                >
                  {MEMORY_STATUSES.map((status) => (
                    <MenuItem value={status} key={status}>{t.settings.memoryStatuses[status]}</MenuItem>
                  ))}
                </Select>
              </FormControl>
            </Stack>
            <TextField
              label={t.settings.memoryTitleLabel}
              value={memoryForm.title}
              onChange={(event) => setMemoryForm((current) => ({ ...current, title: event.target.value }))}
              fullWidth
              size="small"
            />
            <TextField
              label={t.settings.memoryReadWhen}
              helperText={t.settings.memoryReadWhenHelp}
              value={memoryForm.readWhen}
              onChange={(event) => setMemoryForm((current) => ({ ...current, readWhen: event.target.value }))}
              multiline
              minRows={2}
              fullWidth
            />
            <TextField
              label={t.settings.memoryBody}
              value={memoryForm.body}
              onChange={(event) => setMemoryForm((current) => ({ ...current, body: event.target.value }))}
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
      <MemoryGroup title={t.settings.memoryGlobalGroup} memories={globalMemories} t={t} onEdit={editMemory} onDelete={onDeleteMemory} />
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
  );

  const localRows: SettingsRowItem[] = [
    {
      key: 'llmProvider',
      label: t.settings.llmProviderTitle,
      description: t.settings.settingsRows.llmProvider,
      icon: <PsychologyRounded />,
      onClick: () => setSettingsSubview('llmProvider'),
    },
    {
      key: 'privacySecurity',
      label: t.settings.privacy,
      description: t.settings.settingsRows.privacySecurity,
      icon: <PrivacyTipRounded />,
      onClick: () => setSettingsSubview('privacySecurity'),
    },
    {
      key: 'appearance',
      label: t.settings.appearance,
      description: t.settings.settingsRows.appearance,
      icon: <PaletteRounded />,
      onClick: () => setSettingsSubview('appearance'),
    },
    {
      key: 'storage',
      label: t.settings.storageTitle,
      description: t.settings.settingsRows.storage,
      icon: <StorageRounded />,
      onClick: () => setSettingsSubview('storage'),
    },
  ];
  const systemRows: SettingsRowItem[] = [
    {
      key: 'developerMode',
      label: t.settings.developerModeTitle,
      description: t.settings.settingsRows.developerMode,
      icon: <ConstructionRounded />,
      onClick: () => setSettingsSubview('developerMode'),
    },
    {
      key: 'memory',
      label: t.settings.memoryTitle,
      description: t.settings.settingsRows.memory,
      icon: <MemoryRounded />,
      onClick: () => setSettingsSubview('memory'),
    },
  ];

  const subviewContent: Record<Exclude<SettingsSubview, 'main'>, { title: string; description?: string; content: ReactNode }> = {
    llmProvider: {
      title: t.settings.llmProviderTitle,
      description: t.settings.llmProviderDescription,
      content: renderLlmProvider(),
    },
    privacySecurity: {
      title: t.settings.privacy,
      description: t.settings.privacyDescription,
      content: renderPrivacySecurity(),
    },
    appearance: {
      title: t.settings.appearance,
      description: t.settings.appearanceDescription,
      content: renderAppearance(),
    },
    storage: {
      title: t.settings.storageTitle,
      description: t.settings.storageDescription,
      content: renderStorage(),
    },
    developerMode: {
      title: t.settings.developerModeTitle,
      description: t.settings.developerModeDescription,
      content: renderDeveloperMode(),
    },
    memory: {
      title: t.settings.memoryTitle,
      description: t.settings.memoryDescription,
      content: renderMemory(),
    },
  };

  if (settingsSubview !== 'main') {
    const subview = subviewContent[settingsSubview];
    return (
      <Stack spacing={2}>
        <SettingsSubviewHeader
          title={subview.title}
          description={subview.description}
          backLabel={t.settings.backToSettings}
          onBack={() => setSettingsSubview('main')}
        />
        {subview.content}
      </Stack>
    );
  }

  return (
    <Stack spacing={2}>
      <Stack spacing={0.5}>
        <Typography variant="h4">{t.sections.settings.title}</Typography>
        <Typography color="text.secondary">{t.sections.settings.subtitle}</Typography>
      </Stack>
      {renderBetaDisclaimer()}
      {renderDesktopUpdates()}
      {renderBetaControls()}
      <Card>
        <SettingsList>
          {localRows.map((item) => <SettingsRow item={item} key={item.key} />)}
        </SettingsList>
      </Card>
      <Card>
        <SettingsList>
          {advancedLinks.map((item) => <SettingsRow item={{ ...item, key: item.view, onClick: () => onNavigate(item.view) }} key={item.view} />)}
        </SettingsList>
      </Card>
      <Card>
        <SettingsList>
          {systemRows.map((item) => <SettingsRow item={item} key={item.key} />)}
        </SettingsList>
      </Card>
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
              <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
                <Chip size="small" label={t.settings.memoryKinds[entry.kind]} />
                <Chip size="small" variant="outlined" label={t.settings.memoryStatuses[entry.status]} />
                {!entry.readWhen.trim() ? <Chip size="small" color="primary" variant="outlined" label={t.settings.memoryAlwaysInjected} /> : null}
                <Typography variant="caption" color="text.secondary">
                  {new Date(entry.updatedAt).toLocaleString()}
                </Typography>
              </Stack>
              <Typography variant="subtitle2">{entry.title}</Typography>
              <Typography variant="caption" color="text.secondary" sx={{ whiteSpace: 'pre-wrap' }}>
                {entry.readWhen.trim() ? t.settings.memoryReadWhenValue(entry.readWhen) : t.settings.memoryReadWhenAlways}
              </Typography>
              <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap' }}>{entry.body}</Typography>
              {entry.usage?.[0] ? (
                <Typography variant="caption" color="text.secondary">
                  {t.settings.memoryLastUsed(new Date(entry.usage[0].createdAt).toLocaleString())}
                </Typography>
              ) : null}
              {entry.evidence?.[0] ? (
                <Typography variant="caption" color="text.secondary" sx={{ whiteSpace: 'pre-wrap' }}>
                  {t.settings.memoryEvidence(entry.evidence[0].excerpt)}
                </Typography>
              ) : null}
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
