import { useEffect, useMemo, useState } from 'react';
import AccessTimeRounded from '@mui/icons-material/AccessTimeRounded';
import DeleteRounded from '@mui/icons-material/DeleteRounded';
import EditRounded from '@mui/icons-material/EditRounded';
import PauseRounded from '@mui/icons-material/PauseRounded';
import PlayArrowRounded from '@mui/icons-material/PlayArrowRounded';
import PlaylistAddCheckRounded from '@mui/icons-material/PlaylistAddCheckRounded';
import ScienceRounded from '@mui/icons-material/ScienceRounded';
import VisibilityRounded from '@mui/icons-material/VisibilityRounded';
import {
  alpha,
  Box,
  Button,
  Card,
  CardContent,
  Checkbox,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  FormControl,
  FormControlLabel,
  FormGroup,
  IconButton,
  InputAdornment,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  TextField,
  Tooltip,
  Typography,
  useTheme,
} from '@mui/material';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ExternalMarkdownLink } from '@renderer/components/ExternalMarkdownLink';
import type {
  AppSummary,
  Automation,
  AutomationFrequency,
  AutomationMissedRunPolicy,
  AutomationRun,
  AutomationRunSummary,
  AutomationUpsertInput,
  AgentEffort,
  AgentPermissionMode,
  AgentProvider,
} from '@shared/types';
import { DEFAULT_INTERVAL_MINUTES, MAX_INTERVAL_MINUTES, MIN_INTERVAL_MINUTES } from '@shared/types';
import type { AppDictionary } from '@renderer/i18n';
import type { RuntimeProviderControls } from '@renderer/runtime-provider-controls';

interface AutomationFormState {
  id?: string;
  name: string;
  prompt: string;
  frequencyType: AutomationFrequency['type'];
  timeOfDay: string;
  weeklyDay: number;
  intervalMinutes: string;
  runtimeProvider: AgentProvider | 'auto';
  runtimeModel: string;
  runtimeEffort: AgentEffort;
  permissionMode: AgentPermissionMode;
  missedRunPolicy: AutomationMissedRunPolicy;
  missedRunWindowMinutes: number;
  selectedAppIds: string[];
  enabled: boolean;
}

interface AutomationsViewProps {
  t: AppDictionary;
  apps: AppSummary[];
  automations: Automation[];
  selectedAutomationId: string | null;
  runs: AutomationRunSummary[];
  selectedRun: AutomationRun | null;
  busy: boolean;
  providerOptions: Array<{ label: string; value: AgentProvider | 'auto' }>;
  runtimeProviderControls: RuntimeProviderControls;
  getAppMeta: (appId: string) => { name: string; description: string };
  onSave: (input: AutomationUpsertInput & { id?: string }) => void;
  onDelete: (id: string) => void;
  onPause: (id: string) => void;
  onResume: (id: string) => void;
  onRunNow: (id: string) => void;
  onSelectAutomation: (id: string) => void;
  onSelectRun: (runId: string) => void;
}

const DEFAULT_MISSED_WINDOWS: Record<AutomationFrequency['type'], number> = {
  interval: DEFAULT_INTERVAL_MINUTES,
  hourly: 30,
  daily: 360,
  weekly: 1440,
};

const missedWindowOptions = (frequencyType: AutomationFrequency['type']): Array<{ labelKey: 'minutes' | 'hours' | 'days'; value: number; amount: number }> => {
  if (frequencyType === 'hourly') {
    return [
      { labelKey: 'minutes', value: 5, amount: 5 },
      { labelKey: 'minutes', value: 15, amount: 15 },
      { labelKey: 'minutes', value: 30, amount: 30 },
      { labelKey: 'hours', value: 60, amount: 1 },
    ];
  }
  if (frequencyType === 'daily') {
    return [
      { labelKey: 'hours', value: 60, amount: 1 },
      { labelKey: 'hours', value: 180, amount: 3 },
      { labelKey: 'hours', value: 360, amount: 6 },
      { labelKey: 'hours', value: 720, amount: 12 },
    ];
  }
  return [
    { labelKey: 'hours', value: 360, amount: 6 },
    { labelKey: 'hours', value: 720, amount: 12 },
    { labelKey: 'days', value: 1440, amount: 1 },
    { labelKey: 'days', value: 2880, amount: 2 },
  ];
};

const emptyForm = (runtimeProviderControls: RuntimeProviderControls): AutomationFormState => {
  const codex = runtimeProviderControls.codex;
  const runtimeModel = codex.selectedModel || codex.modelOptions[0]?.realModelName || '';
  return {
  name: '',
  prompt: '',
  frequencyType: 'hourly',
  timeOfDay: '09:00',
  weeklyDay: 1,
  intervalMinutes: String(DEFAULT_INTERVAL_MINUTES),
  runtimeProvider: 'auto',
  runtimeModel,
  runtimeEffort: codex.normalizeEffortForModel(runtimeModel, codex.selectedEffort || codex.effortOptionsForModel(runtimeModel)[0]?.value || 'low'),
  permissionMode: 'safe',
  missedRunPolicy: 'within_window',
  missedRunWindowMinutes: DEFAULT_MISSED_WINDOWS.hourly,
  selectedAppIds: [],
  enabled: false,
  };
};

const formFromAutomation = (automation: Automation, runtimeProviderControls: RuntimeProviderControls): AutomationFormState => {
  const fallback = emptyForm(runtimeProviderControls);
  const runtimeProvider = automation.runtime?.provider ?? 'auto';
  const runtimeControl = runtimeProviderControls[runtimeProvider === 'auto' ? 'codex' : runtimeProvider];
  const runtimeModel = automation.runtime?.model ?? fallback.runtimeModel;
  return {
  id: automation.id,
  name: automation.name,
  prompt: automation.prompt,
  frequencyType: automation.frequency.type,
  timeOfDay: automation.frequency.timeOfDay ?? '09:00',
  weeklyDay: automation.frequency.weeklyDay ?? 1,
  intervalMinutes: String(automation.frequency.intervalMinutes ?? DEFAULT_INTERVAL_MINUTES),
  runtimeProvider,
  runtimeModel,
  runtimeEffort: runtimeControl.normalizeEffortForModel(runtimeModel, automation.runtime?.effort ?? fallback.runtimeEffort),
  permissionMode: automation.runtime?.permissionMode ?? 'safe',
  missedRunPolicy: automation.missedRunPolicy ?? 'within_window',
  missedRunWindowMinutes: automation.missedRunWindowMinutes ?? DEFAULT_MISSED_WINDOWS[automation.frequency.type],
  selectedAppIds: automation.selectedAppIds,
  enabled: automation.enabled,
  };
};

const buildInput = (form: AutomationFormState, enabled = form.enabled): AutomationUpsertInput & { id?: string } => {
  const frequency: AutomationFrequency =
    form.frequencyType === 'interval'
      ? { type: 'interval', intervalMinutes: clampIntervalMinutes(form.intervalMinutes) }
      : form.frequencyType === 'hourly'
        ? { type: 'hourly' }
        : form.frequencyType === 'daily'
          ? { type: 'daily', timeOfDay: form.timeOfDay }
          : { type: 'weekly', timeOfDay: form.timeOfDay, weeklyDay: form.weeklyDay };
  const runtime = form.runtimeProvider === 'auto'
    ? undefined
    : {
        provider: form.runtimeProvider,
        model: form.runtimeModel,
        effort: form.runtimeEffort,
        permissionMode: form.permissionMode,
      };
  const isInterval = frequency.type === 'interval';
  return {
    id: form.id,
    name: form.name,
    prompt: form.prompt,
    frequency,
    runtime,
    missedRunPolicy: isInterval ? 'within_window' : form.missedRunPolicy,
    missedRunWindowMinutes: isInterval ? undefined : form.missedRunWindowMinutes,
    selectedAppIds: form.selectedAppIds,
    enabled,
  };
};

const formatDateTime = (value?: string | null): string => {
  if (!value) {
    return '-';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '-';
  }
  return date.toLocaleString();
};

const statusColor = (status: AutomationRunSummary['status']): 'default' | 'success' | 'error' | 'warning' | 'info' => {
  if (status === 'succeeded') return 'success';
  if (status === 'failed') return 'error';
  if (status === 'skipped') return 'warning';
  if (status === 'running') return 'info';
  return 'default';
};

const clampIntervalMinutes = (value: string): number => {
  const numeric = Math.round(Number(value));
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return DEFAULT_INTERVAL_MINUTES;
  }
  return Math.min(MAX_INTERVAL_MINUTES, Math.max(MIN_INTERVAL_MINUTES, numeric));
};

const formatFrequencyLabel = (automation: Automation, t: AppDictionary): string => {
  if (automation.frequency.type === 'interval') {
    return t.sections.automations.frequencySummaries.interval(automation.frequency.intervalMinutes ?? DEFAULT_INTERVAL_MINUTES);
  }
  if (automation.frequency.type === 'daily') {
    return t.sections.automations.frequencySummaries.daily(automation.frequency.timeOfDay ?? '09:00');
  }
  if (automation.frequency.type === 'weekly') {
    const day = t.sections.automations.weekdays[automation.frequency.weeklyDay ?? 1] ?? t.sections.automations.weekdays[1];
    return t.sections.automations.frequencySummaries.weekly(day, automation.frequency.timeOfDay ?? '09:00');
  }
  return t.sections.automations.frequencyLabels.hourly;
};

function MarkdownRunOutput({ content }: { content: string }) {
  const theme = useTheme();
  const codeBackground = theme.palette.mode === 'dark'
    ? alpha(theme.palette.common.white, 0.08)
    : theme.palette.action.hover;
  const preBackground = theme.palette.mode === 'dark'
    ? alpha(theme.palette.common.white, 0.06)
    : theme.palette.background.default;

  return (
    <Box
      sx={{
        color: content ? 'text.primary' : 'text.secondary',
        fontSize: theme.typography.body2.fontSize,
        lineHeight: 1.6,
        '& p': { my: 0.85, lineHeight: 1.6 },
        '& ul, & ol': { my: 0.85, pl: 2.7 },
        '& li': { mb: 0.45 },
        '& strong': { fontWeight: 700 },
        '& code': {
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
          bgcolor: codeBackground,
          color: 'text.primary',
          px: 0.5,
          py: 0.15,
          borderRadius: 0.75,
          fontSize: '0.9em',
        },
        '& pre': {
          bgcolor: preBackground,
          border: `1px solid ${theme.palette.divider}`,
          borderRadius: 1,
          p: 1.25,
          maxWidth: '100%',
          overflowX: 'auto',
          overflowY: 'hidden',
          my: 1,
        },
        '& pre code': {
          bgcolor: 'transparent',
          p: 0,
          borderRadius: 0,
          whiteSpace: 'pre',
        },
      }}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => (
            <ExternalMarkdownLink href={href}>{children}</ExternalMarkdownLink>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </Box>
  );
}

export function AutomationsView({
  t,
  apps,
  automations,
  selectedAutomationId,
  runs,
  selectedRun,
  busy,
  providerOptions,
  runtimeProviderControls,
  getAppMeta,
  onSave,
  onDelete,
  onPause,
  onResume,
  onRunNow,
  onSelectAutomation,
  onSelectRun,
}: AutomationsViewProps) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [runLogOpen, setRunLogOpen] = useState(false);
  const [form, setForm] = useState<AutomationFormState>(() => emptyForm(runtimeProviderControls));
  const selectedAutomation = useMemo(
    () => automations.find((automation) => automation.id === selectedAutomationId) ?? null,
    [automations, selectedAutomationId],
  );
  const allAppIds = apps.map((appEntry) => appEntry.id);
  const allSelected = allAppIds.length > 0 && allAppIds.every((appId) => form.selectedAppIds.includes(appId));
  const effectiveProviderOptions = form.runtimeProvider !== 'auto' && !providerOptions.some((option) => option.value === form.runtimeProvider)
    ? [...providerOptions, { label: form.runtimeProvider, value: form.runtimeProvider }]
    : providerOptions;

  useEffect(() => {
    if (!selectedAutomationId && automations[0]) {
      onSelectAutomation(automations[0].id);
    }
  }, [automations, selectedAutomationId, onSelectAutomation]);

  const openCreate = () => {
    setForm(emptyForm(runtimeProviderControls));
    setDialogOpen(true);
  };

  const openEdit = (automation: Automation) => {
    setForm(formFromAutomation(automation, runtimeProviderControls));
    setDialogOpen(true);
  };

  const toggleApp = (appId: string) => {
    setForm((current) => ({
      ...current,
      selectedAppIds: current.selectedAppIds.includes(appId)
        ? current.selectedAppIds.filter((id) => id !== appId)
        : [...current.selectedAppIds, appId],
    }));
  };

  const submit = (enabled = form.enabled) => {
    onSave(buildInput({ ...form, runtimeEffort: runtimeEffortValue }, enabled));
    setDialogOpen(false);
  };
  const selectedRuntimeControl = runtimeProviderControls[form.runtimeProvider === 'auto' ? 'codex' : form.runtimeProvider];
  const runtimeModelOptions = selectedRuntimeControl.modelOptions;
  const runtimeEffortOptions = selectedRuntimeControl.effortOptionsForModel(form.runtimeModel);
  const runtimeEffortValue = selectedRuntimeControl.normalizeEffortForModel(form.runtimeModel, form.runtimeEffort);
  const effectiveRuntimeModelOptions = form.runtimeModel && !runtimeModelOptions.some((option) => option.realModelName === form.runtimeModel)
    ? [...runtimeModelOptions, { displayModelName: form.runtimeModel, realModelName: form.runtimeModel, defaultEffort: runtimeEffortValue }]
    : runtimeModelOptions;
  const effectiveRuntimeEffortOptions = !runtimeEffortOptions.some((option) => option.value === runtimeEffortValue)
    ? [...runtimeEffortOptions, { label: runtimeEffortValue, value: runtimeEffortValue }]
    : runtimeEffortOptions;
  const selectedMissedWindowOptions = missedWindowOptions(form.frequencyType);

  const runOutput = selectedRun?.userMessage?.trim()
    || (selectedRun?.status === 'failed' ? selectedRun.error : '')
    || '';
  const runMessages = selectedRun?.userMessages?.length
    ? selectedRun.userMessages
    : runOutput
      ? [runOutput]
      : [];

  return (
    <Stack spacing={2}>
      <Stack direction="row" justifyContent="space-between" alignItems="flex-start" spacing={2}>
        <Stack spacing={0.5}>
          <Typography variant="h4">{t.sections.automations.title}</Typography>
          <Typography color="text.secondary">{t.sections.automations.subtitle}</Typography>
        </Stack>
        <Button variant="contained" startIcon={<PlaylistAddCheckRounded />} onClick={openCreate}>
          {t.sections.automations.newAutomation}
        </Button>
      </Stack>

      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: { xs: '1fr', lg: 'minmax(360px, 0.95fr) minmax(420px, 1.05fr)' },
          gap: 2,
          alignItems: 'start',
        }}
      >
        <Stack spacing={1.5}>
          {automations.length === 0 ? (
            <Card>
              <CardContent>
                <Typography color="text.secondary">{t.sections.automations.empty}</Typography>
              </CardContent>
            </Card>
          ) : null}
          {automations.map((automation) => (
            <Card
              key={automation.id}
              variant={selectedAutomationId === automation.id ? 'elevation' : 'outlined'}
              onClick={() => onSelectAutomation(automation.id)}
              sx={{ cursor: 'pointer' }}
            >
              <CardContent>
                <Stack spacing={1.25}>
                  <Stack direction="row" justifyContent="space-between" spacing={1.5} alignItems="flex-start">
                    <Stack spacing={0.5} sx={{ minWidth: 0 }}>
                      <Typography variant="h6" sx={{ wordBreak: 'break-word' }}>{automation.name}</Typography>
                      <Stack direction="row" spacing={0.75} useFlexGap flexWrap="wrap">
                        <Chip size="small" label={automation.running ? t.sections.automations.running : automation.enabled ? t.sections.automations.active : t.sections.automations.paused} color={automation.running ? 'info' : automation.enabled ? 'success' : 'default'} />
                        <Chip size="small" variant="outlined" label={formatFrequencyLabel(automation, t)} />
                        <Chip size="small" variant="outlined" label={automation.runtime?.provider ? providerOptions.find((option) => option.value === automation.runtime?.provider)?.label ?? automation.runtime.provider : t.sections.automations.autoProvider} />
                        <Chip size="small" variant="outlined" label={automation.runtime?.permissionMode === 'unsafe' ? t.sections.automations.permissionUnsafe : t.sections.automations.permissionSafe} />
                      </Stack>
                    </Stack>
                    <Stack direction="row" spacing={0.25}>
                      <Tooltip title={t.sections.automations.testRun}>
                        <span>
                          <IconButton aria-label={t.sections.automations.testRun} size="small" disabled={busy || automation.running} onClick={(event) => { event.stopPropagation(); onRunNow(automation.id); }}>
                            <ScienceRounded fontSize="small" />
                          </IconButton>
                        </span>
                      </Tooltip>
                      <Tooltip title={automation.enabled ? t.sections.automations.pause : t.sections.automations.resume}>
                        <span>
                          <IconButton
                            aria-label={automation.enabled ? t.sections.automations.pause : t.sections.automations.resume}
                            size="small"
                            disabled={busy}
                            onClick={(event) => {
                              event.stopPropagation();
                              if (automation.enabled) {
                                onPause(automation.id);
                              } else {
                                onResume(automation.id);
                              }
                            }}
                          >
                            {automation.enabled ? <PauseRounded fontSize="small" /> : <PlayArrowRounded fontSize="small" />}
                          </IconButton>
                        </span>
                      </Tooltip>
                      <Tooltip title={t.sections.automations.edit}>
                        <IconButton aria-label={t.sections.automations.edit} size="small" onClick={(event) => { event.stopPropagation(); openEdit(automation); }}>
                          <EditRounded fontSize="small" />
                        </IconButton>
                      </Tooltip>
                      <Tooltip title={t.sections.automations.delete}>
                        <IconButton aria-label={t.sections.automations.delete} size="small" color="error" onClick={(event) => { event.stopPropagation(); onDelete(automation.id); }}>
                          <DeleteRounded fontSize="small" />
                        </IconButton>
                      </Tooltip>
                    </Stack>
                  </Stack>
                  <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
                    <Typography variant="body2" color="text.secondary">
                      {t.sections.automations.lastRun}: {formatDateTime(automation.lastRun?.finishedAt ?? automation.lastRun?.startedAt)}
                    </Typography>
                    <Typography variant="body2" color="text.secondary">
                      {t.sections.automations.nextRun}: {formatDateTime(automation.nextRunAt)}
                    </Typography>
                  </Stack>
                  <Typography variant="body2" color="text.secondary" sx={{ wordBreak: 'break-word' }}>
                    {automation.selectedAppIds.length === 0
                      ? t.sections.automations.noAppsSelected
                      : automation.selectedAppIds.map((appId) => getAppMeta(appId).name).join(', ')}
                  </Typography>
                </Stack>
              </CardContent>
            </Card>
          ))}
        </Stack>

        <Stack spacing={1.5}>
          <Card>
            <CardContent>
              <Stack spacing={1.25}>
                <Typography variant="h6">{t.sections.automations.runsTitle}</Typography>
                {!selectedAutomation ? (
                  <Typography color="text.secondary">{t.sections.automations.selectAutomation}</Typography>
                ) : runs.length === 0 ? (
                  <Typography color="text.secondary">{t.sections.automations.noRuns}</Typography>
                ) : (
                  <Stack spacing={0.75}>
                    {runs.map((run) => (
                      <Button
                        key={run.id}
                        variant="outlined"
                        color="inherit"
                        onClick={() => onSelectRun(run.id)}
                        sx={(theme) => {
                          const selected = selectedRun?.id === run.id;
                          return {
                            justifyContent: 'space-between',
                            minHeight: 42,
                            bgcolor: selected ? 'action.selected' : 'transparent',
                            borderColor: selected ? theme.palette.divider : 'divider',
                            boxShadow: selected ? `inset 0 0 0 1px ${theme.palette.action.focus}` : 'none',
                            '&:hover': {
                              bgcolor: selected ? 'action.selected' : 'action.hover',
                              borderColor: theme.palette.divider,
                            },
                          };
                        }}
                      >
                        <Stack direction="row" spacing={1} alignItems="center" sx={{ minWidth: 0 }}>
                          <Chip size="small" color={statusColor(run.status)} label={t.sections.automations.runStatuses[run.status]} />
                          <Typography variant="body2" sx={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                            {run.trigger === 'manual' ? t.sections.automations.manual : t.sections.automations.scheduled}
                          </Typography>
                        </Stack>
                        <Typography variant="caption" color="text.secondary">
                          {formatDateTime(run.finishedAt ?? run.startedAt)}
                        </Typography>
                      </Button>
                    ))}
                  </Stack>
                )}
              </Stack>
            </CardContent>
          </Card>

          <Card>
            <CardContent>
              <Stack spacing={1}>
                <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={1}>
                  <Typography variant="h6">{t.sections.automations.outputTitle}</Typography>
                  <Tooltip title={t.sections.automations.viewFullLog}>
                    <span>
                      <IconButton aria-label={t.sections.automations.viewFullLog} size="small" disabled={runMessages.length === 0} onClick={() => setRunLogOpen(true)}>
                        <VisibilityRounded fontSize="small" />
                      </IconButton>
                    </span>
                  </Tooltip>
                </Stack>
                <Divider />
                <Box
                  sx={{
                    minHeight: 280,
                    maxHeight: '48vh',
                    overflow: 'auto',
                    wordBreak: 'break-word',
                    bgcolor: 'action.hover',
                    borderRadius: 1,
                    px: 2,
                    py: 1.75,
                  }}
                >
                  <MarkdownRunOutput content={runOutput || t.sections.automations.noOutput} />
                </Box>
              </Stack>
            </CardContent>
          </Card>
        </Stack>
      </Box>

      <Dialog open={runLogOpen} onClose={() => setRunLogOpen(false)} maxWidth="md" fullWidth>
        <DialogTitle>{t.sections.automations.fullLogTitle}</DialogTitle>
        <DialogContent>
          {runMessages.length === 0 ? (
            <Typography color="text.secondary">{t.sections.automations.noLogMessages}</Typography>
          ) : (
            <Stack spacing={1.5} sx={{ pt: 1 }}>
              {runMessages.map((message, index) => (
                <Box
                  key={`${selectedRun?.id ?? 'run'}-${index}`}
                  sx={{
                    border: 1,
                    borderColor: 'divider',
                    borderRadius: 1,
                    bgcolor: 'action.hover',
                    px: 2,
                    py: 1.5,
                  }}
                >
                  <MarkdownRunOutput content={message} />
                </Box>
              ))}
            </Stack>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setRunLogOpen(false)}>{t.actions.close}</Button>
        </DialogActions>
      </Dialog>

      <Dialog open={dialogOpen} onClose={() => setDialogOpen(false)} maxWidth="md" fullWidth>
        <DialogTitle>{form.id ? t.sections.automations.edit : t.sections.automations.newAutomation}</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ pt: 1 }}>
            <Stack spacing={1}>
              <Typography variant="subtitle2">{t.sections.automations.whatSection}</Typography>
            <TextField
              label={t.sections.automations.name}
              value={form.name}
              onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
              fullWidth
            />
            <TextField
              label={t.sections.automations.instruction}
              value={form.prompt}
              onChange={(event) => setForm((current) => ({ ...current, prompt: event.target.value }))}
              fullWidth
              multiline
              minRows={4}
            />
            </Stack>
            <Divider />
            <Stack spacing={1}>
              <Typography variant="subtitle2">{t.sections.automations.whenSection}</Typography>
            <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.5}>
              <FormControl fullWidth>
                <InputLabel>{t.sections.automations.frequency}</InputLabel>
                <Select
                  inputProps={{ 'aria-label': t.sections.automations.frequency }}
                  label={t.sections.automations.frequency}
                  value={form.frequencyType}
                  onChange={(event) => {
                    const frequencyType = event.target.value as AutomationFrequency['type'];
                    setForm((current) => ({
                      ...current,
                      frequencyType,
                      missedRunWindowMinutes: DEFAULT_MISSED_WINDOWS[frequencyType],
                    }));
                  }}
                >
                  <MenuItem value="interval">{t.sections.automations.frequencyLabels.interval}</MenuItem>
                  <MenuItem value="hourly">{t.sections.automations.frequencyLabels.hourly}</MenuItem>
                  <MenuItem value="daily">{t.sections.automations.frequencyLabels.daily}</MenuItem>
                  <MenuItem value="weekly">{t.sections.automations.frequencyLabels.weekly}</MenuItem>
                </Select>
              </FormControl>
              {form.frequencyType === 'interval' ? (
                <TextField
                  label={t.sections.automations.intervalMinutes}
                  helperText={t.sections.automations.intervalMinutesHelper}
                  type="number"
                  value={form.intervalMinutes}
                  onChange={(event) => setForm((current) => ({ ...current, intervalMinutes: event.target.value }))}
                  onBlur={() => setForm((current) => ({ ...current, intervalMinutes: String(clampIntervalMinutes(current.intervalMinutes)) }))}
                  fullWidth
                  inputProps={{ min: MIN_INTERVAL_MINUTES, max: MAX_INTERVAL_MINUTES, step: 1 }}
                />
              ) : null}
              {form.frequencyType !== 'hourly' && form.frequencyType !== 'interval' ? (
                <TextField
                  label={t.sections.automations.timeOfDay}
                  helperText={t.sections.automations.localTimeHelper}
                  type="time"
                  value={form.timeOfDay}
                  onChange={(event) => setForm((current) => ({ ...current, timeOfDay: event.target.value }))}
                  fullWidth
                  InputLabelProps={{ shrink: true }}
                  slotProps={{
                    input: {
                      endAdornment: (
                        <InputAdornment position="end" sx={{ pointerEvents: 'none' }}>
                          <AccessTimeRounded fontSize="small" color="action" />
                        </InputAdornment>
                      ),
                    },
                  }}
                  sx={(theme) => ({
                    '& input[type="time"]': {
                      colorScheme: theme.palette.mode,
                    },
                    '& input[type="time"]::-webkit-calendar-picker-indicator': {
                      cursor: 'pointer',
                      opacity: 0,
                      position: 'absolute',
                      right: 0,
                      width: 48,
                      height: '100%',
                    },
                  })}
                />
              ) : null}
              {form.frequencyType === 'weekly' ? (
                <FormControl fullWidth>
                  <InputLabel>{t.sections.automations.weeklyDay}</InputLabel>
                  <Select
                    inputProps={{ 'aria-label': t.sections.automations.weeklyDay }}
                    label={t.sections.automations.weeklyDay}
                    value={form.weeklyDay}
                    onChange={(event) => setForm((current) => ({ ...current, weeklyDay: Number(event.target.value) }))}
                  >
                    {t.sections.automations.weekdays.map((label, index) => (
                      <MenuItem key={label} value={index}>{label}</MenuItem>
                    ))}
                  </Select>
                </FormControl>
              ) : null}
            </Stack>
            {form.frequencyType !== 'interval' ? (
              <>
            <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.5}>
              <FormControl fullWidth>
                <InputLabel>{t.sections.automations.missedRunPolicy}</InputLabel>
                <Select
                  inputProps={{ 'aria-label': t.sections.automations.missedRunPolicy }}
                  label={t.sections.automations.missedRunPolicy}
                  value={form.missedRunPolicy}
                  onChange={(event) => setForm((current) => ({ ...current, missedRunPolicy: event.target.value as AutomationMissedRunPolicy }))}
                >
                  <MenuItem value="skip">{t.sections.automations.missedRunPolicies.skip}</MenuItem>
                  <MenuItem value="always">{t.sections.automations.missedRunPolicies.always}</MenuItem>
                  <MenuItem value="within_window">{t.sections.automations.missedRunPolicies.within_window}</MenuItem>
                </Select>
              </FormControl>
              {form.missedRunPolicy === 'within_window' ? (
                <FormControl fullWidth>
                  <InputLabel>{t.sections.automations.missedRunWindow}</InputLabel>
                  <Select
                    inputProps={{ 'aria-label': t.sections.automations.missedRunWindow }}
                    label={t.sections.automations.missedRunWindow}
                    value={form.missedRunWindowMinutes}
                    onChange={(event) => setForm((current) => ({ ...current, missedRunWindowMinutes: Number(event.target.value) }))}
                  >
                    {selectedMissedWindowOptions.map((option) => (
                      <MenuItem key={option.value} value={option.value}>{t.sections.automations.missedRunWindowLabels[option.labelKey](option.amount)}</MenuItem>
                    ))}
                  </Select>
                </FormControl>
              ) : null}
            </Stack>
            <Typography variant="caption" color="text.secondary">{t.sections.automations.missedRunHelper[form.missedRunPolicy]}</Typography>
              </>
            ) : null}
            </Stack>
            <Divider />
            <Stack spacing={1}>
              <Typography variant="subtitle2">{t.sections.automations.agentSection}</Typography>
              <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.5}>
                <FormControl fullWidth>
                  <InputLabel>{t.sections.automations.provider}</InputLabel>
                  <Select
                    inputProps={{ 'aria-label': t.sections.automations.provider }}
                    label={t.sections.automations.provider}
                    value={form.runtimeProvider}
                    onChange={(event) => {
                      const provider = event.target.value as AgentProvider | 'auto';
                      const control = runtimeProviderControls[provider === 'auto' ? 'codex' : provider];
                      const model = control.modelOptions[0]?.realModelName ?? form.runtimeModel;
                      setForm((current) => ({
                        ...current,
                        runtimeProvider: provider,
                        runtimeModel: model,
                        runtimeEffort: control.normalizeEffortForModel(model, control.modelOptions[0]?.defaultEffort ?? current.runtimeEffort),
                      }));
                    }}
                  >
                    {effectiveProviderOptions.map((option) => (
                      <MenuItem key={option.value} value={option.value}>{option.value === 'auto' ? t.sections.automations.autoProvider : option.label}</MenuItem>
                    ))}
                  </Select>
                </FormControl>
                <FormControl fullWidth disabled={form.runtimeProvider === 'auto'}>
                  <InputLabel>{t.sections.automations.model}</InputLabel>
                  <Select
                    inputProps={{ 'aria-label': t.sections.automations.model }}
                    label={t.sections.automations.model}
                    value={form.runtimeModel}
                    onChange={(event) => {
                      const model = event.target.value;
                      const option = effectiveRuntimeModelOptions.find((entry) => entry.realModelName === model)!;
                      setForm((current) => ({ ...current, runtimeModel: model, runtimeEffort: selectedRuntimeControl.normalizeEffortForModel(model, option.defaultEffort) }));
                    }}
                  >
                    {effectiveRuntimeModelOptions.map((option) => (
                      <MenuItem key={option.realModelName} value={option.realModelName}>{option.displayModelName}</MenuItem>
                    ))}
                  </Select>
                </FormControl>
                <FormControl fullWidth disabled={form.runtimeProvider === 'auto'}>
                  <InputLabel>{t.sections.automations.effort}</InputLabel>
                    <Select
                      inputProps={{ 'aria-label': t.sections.automations.effort }}
                      label={t.sections.automations.effort}
                    value={runtimeEffortValue}
                    onChange={(event) => setForm((current) => ({ ...current, runtimeEffort: event.target.value as AgentEffort }))}
                  >
                    {effectiveRuntimeEffortOptions.map((option) => (
                      <MenuItem key={option.value} value={option.value}>{option.label}</MenuItem>
                    ))}
                  </Select>
                </FormControl>
              </Stack>
              <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.5}>
                <FormControl fullWidth>
                  <InputLabel>{t.sections.automations.permissionMode}</InputLabel>
                  <Select
                    inputProps={{ 'aria-label': t.sections.automations.permissionMode }}
                    label={t.sections.automations.permissionMode}
                    value={form.permissionMode}
                    onChange={(event) => setForm((current) => ({ ...current, permissionMode: event.target.value as AgentPermissionMode }))}
                  >
                    <MenuItem value="safe">{t.sections.automations.permissionSafe}</MenuItem>
                    <MenuItem value="unsafe">{t.sections.automations.permissionUnsafe}</MenuItem>
                  </Select>
                </FormControl>
                <Box sx={{ flex: 1, display: 'flex', alignItems: 'center' }}>
                  <Typography variant="caption" color="text.secondary">
                    {form.permissionMode === 'unsafe' ? t.sections.automations.permissionUnsafeHelper : t.sections.automations.permissionSafeHelper}
                  </Typography>
                </Box>
              </Stack>
              <Typography variant="caption" color="text.secondary">{t.sections.automations.runtimeHelper}</Typography>
            </Stack>
            <Divider />
            <Stack spacing={1}>
              <Stack direction="row" justifyContent="space-between" alignItems="center">
                <Typography variant="subtitle2">{t.sections.automations.includedApps}</Typography>
                <Button
                  size="small"
                  onClick={() => setForm((current) => ({
                    ...current,
                    selectedAppIds: allSelected ? [] : allAppIds,
                  }))}
                >
                  {allSelected ? t.sections.automations.clearApps : t.sections.automations.selectAllApps}
                </Button>
              </Stack>
              <FormGroup sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' }, columnGap: 2, rowGap: 1 }}>
                {apps.map((appEntry) => (
                  <FormControlLabel
                    key={appEntry.id}
                    sx={{
                      m: 0,
                      alignItems: 'center',
                      '& .MuiCheckbox-root': { p: 0.5, mr: 1 },
                      '& .MuiFormControlLabel-label': { lineHeight: 1.35 },
                    }}
                    control={<Checkbox checked={form.selectedAppIds.includes(appEntry.id)} onChange={() => toggleApp(appEntry.id)} />}
                    label={getAppMeta(appEntry.id).name}
                  />
                ))}
              </FormGroup>
              {apps.length === 0 ? (
                <Typography variant="body2" color="text.secondary">{t.sections.automations.noInstalledApps}</Typography>
              ) : null}
            </Stack>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDialogOpen(false)}>{t.actions.close}</Button>
          <Button disabled={!form.name.trim() || !form.prompt.trim()} onClick={() => form.id ? submit() : submit(false)}>
            {form.id ? t.sections.automations.save : t.sections.automations.create}
          </Button>
          <Button variant="contained" disabled={!form.name.trim() || !form.prompt.trim()} onClick={() => submit(true)}>
            {form.id ? t.sections.automations.saveAndActivate : t.sections.automations.createAndActivate}
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}
