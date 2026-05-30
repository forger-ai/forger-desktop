import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import {
  Box,
  Button,
  Card,
  CardActionArea,
  CardContent,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
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
import BackupRounded from '@mui/icons-material/BackupRounded';
import ConstructionRounded from '@mui/icons-material/ConstructionRounded';
import ContentCopyRounded from '@mui/icons-material/ContentCopyRounded';
import DeleteOutlineRounded from '@mui/icons-material/DeleteOutlineRounded';
import DevicesRounded from '@mui/icons-material/DevicesRounded';
import EditRounded from '@mui/icons-material/EditRounded';
import EventRepeatRounded from '@mui/icons-material/EventRepeatRounded';
import InsertDriveFileRounded from '@mui/icons-material/InsertDriveFileRounded';
import MemoryRounded from '@mui/icons-material/MemoryRounded';
import SystemUpdateAltRounded from '@mui/icons-material/SystemUpdateAltRounded';
import DownloadRounded from '@mui/icons-material/DownloadRounded';
import LaunchRounded from '@mui/icons-material/LaunchRounded';
import RestartAltRounded from '@mui/icons-material/RestartAltRounded';
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
  const [memoryDialogOpen, setMemoryDialogOpen] = useState(false);
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
    setMemoryDialogOpen(true);
  };

  return (
    <Stack spacing={2}>
      <Stack spacing={0.5}>
        <Typography variant="h4">{t.sections.settings.title}</Typography>
        <Typography color="text.secondary">{t.sections.settings.subtitle}</Typography>
      </Stack>
      <Card
        variant="outlined"
        sx={{
          order: 0,
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
      <Card sx={{ order: 5 }}>
        <CardContent>
          <Stack spacing={1.5}>
            <Stack spacing={0.5}>
              <Typography variant="h6">{t.settings.betaTitle}</Typography>
              <Typography variant="body2" color="text.secondary">{t.settings.betaDescription}</Typography>
            </Stack>
            <Stack spacing={1}>
              <FormControlLabel
                control={
                  <Switch
                    checked={earlyAccessEnabled}
                    onChange={(event) => onEarlyAccessChange(event.target.checked)}
                  />
                }
                label={t.settings.earlyAccessToggle}
              />
              <FormControlLabel
                control={
                  <Switch
                    checked={advancedMode}
                    onChange={(event) => onAdvancedModeChange(event.target.checked)}
                  />
                }
                label={t.settings.advancedModeToggle}
              />
            </Stack>
            <Stack spacing={1}>
              <Typography variant="subtitle2">{t.settings.advancedSurfacesTitle}</Typography>
              <Stack spacing={1}>
                {advancedLinks.map((item) => (
                  <Card key={item.view} variant="outlined" sx={{ borderRadius: 1 }}>
                    <CardActionArea onClick={() => onNavigate(item.view)}>
                      <CardContent sx={{ py: 1.25, '&:last-child': { pb: 1.25 } }}>
                        <Stack direction="row" spacing={1.5} alignItems="center">
                          <Box sx={{ color: 'primary.main', display: 'grid', placeItems: 'center' }}>{item.icon}</Box>
                          <Box sx={{ minWidth: 0 }}>
                            <Typography variant="subtitle2">{item.label}</Typography>
                            <Typography variant="body2" color="text.secondary">{item.description}</Typography>
                          </Box>
                        </Stack>
                      </CardContent>
                    </CardActionArea>
                  </Card>
                ))}
              </Stack>
            </Stack>
            <Button size="small" variant="outlined" onClick={onResetOnboarding} sx={{ alignSelf: 'flex-start' }}>
              {t.settings.resetOnboarding}
            </Button>
          </Stack>
        </CardContent>
      </Card>
      <Card sx={{ order: 5 }}>
        <CardContent>
          <Stack spacing={1.5}>
            <Stack spacing={0.5}>
              <Typography variant="h6">{t.settings.developerModeTitle}</Typography>
              <Typography variant="body2" color="text.secondary">{t.settings.developerModeDescription}</Typography>
            </Stack>
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
      <Card sx={{ order: 4 }}>
        <CardContent>
          <Stack spacing={1.25}>
            <Stack spacing={0.5}>
              <Typography variant="h6">{t.settings.privacy}</Typography>
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
        </CardContent>
      </Card>
      <Card sx={{ order: 2 }}>
        <CardContent>
          <Stack spacing={1.5}>
            <Stack direction="row" justifyContent="space-between" alignItems="flex-start" sx={{ order: 20 }}>
              <Stack spacing={0.5} sx={{ flex: 1 }}>
                <Typography variant="h6">Llave secreta / Secret key</Typography>
                <Typography variant="body2" color="text.secondary">
                  Protege mensajes cifrados y puede firmar respaldos cloud.
                </Typography>
              </Stack>
            </Stack>
            <Stack direction={{ xs: 'column', md: 'row' }} spacing={1} alignItems="center" sx={{ order: 21 }}>
              <TextField
                size="small"
                type={revealedSecretKey ? 'text' : 'password'}
                value={revealedSecretKey || cloudIdentity?.secretKeyPreview || ''}
                label="Secret key"
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
                Reveal
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
                Copy
              </Button>
              <Button
                variant="outlined"
                color="warning"
                size="small"
                onClick={() => {
                  if (window.confirm('Regenerar esta llave puede invalidar respaldos cloud cifrados o mensajes antiguos.')) {
                    setRevealedSecretKey('');
                    onRegenerateCloudSecretKey();
                  }
                }}
              >
                Regenerate
              </Button>
            </Stack>
            <Divider sx={{ order: 22 }} />
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
            <Stack direction="row" justifyContent="space-between" alignItems="flex-start">
              <Stack spacing={0.5}>
                <Typography variant="h6">Claude Code</Typography>
                <Typography variant="body2" color="text.secondary">
                  {t.settings.claudeDescription}
                </Typography>
              </Stack>
              <Chip
                size="small"
                color={claudeAuthStatus.installed && claudeAuthStatus.authenticated ? 'success' : 'default'}
                label={claudeAuthStatus.authenticated ? t.settings.codexConnected : t.settings.codexDisconnected}
              />
            </Stack>
            <Stack direction="row" spacing={1}>
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
              Claude Code puede usar una sesion local del sistema, especialmente en macOS Keychain.
            </Typography>
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
              <Chip
                size="small"
                label={
                  claudeAuthStatus.source === 'managed'
                    ? 'Instalacion administrada por Forger'
                    : claudeAuthStatus.source === 'system'
                      ? 'Instalacion existente en este equipo'
                      : 'Claude Code no instalado'
                }
              />
              {claudeAuthStatus.version ? <Chip size="small" label={`Version ${claudeAuthStatus.version}`} /> : null}
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
                  <InputLabel>Modelo Codex</InputLabel>
                  <Select
                    label="Modelo Codex"
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
                  <InputLabel>Razonamiento Codex</InputLabel>
                  <Select
                    label="Razonamiento Codex"
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
                  <InputLabel>Modelo Claude</InputLabel>
                  <Select
                    label="Modelo Claude"
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
                  <InputLabel>Esfuerzo Claude</InputLabel>
                  <Select
                    label="Esfuerzo Claude"
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

      <Card sx={{ order: 6 }}>
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

      <Card sx={{ order: 1 }}>
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

      <Card sx={{ order: 3 }}>
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
