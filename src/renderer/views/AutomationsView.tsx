import { useEffect, useMemo, useState } from 'react';
import DeleteRounded from '@mui/icons-material/DeleteRounded';
import EditRounded from '@mui/icons-material/EditRounded';
import PauseRounded from '@mui/icons-material/PauseRounded';
import PlayArrowRounded from '@mui/icons-material/PlayArrowRounded';
import PlaylistAddCheckRounded from '@mui/icons-material/PlaylistAddCheckRounded';
import ScienceRounded from '@mui/icons-material/ScienceRounded';
import {
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
  InputLabel,
  MenuItem,
  Select,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import type {
  AppSummary,
  Automation,
  AutomationFrequency,
  AutomationRun,
  AutomationRunSummary,
  AutomationUpsertInput,
} from '@shared/types';
import type { AppDictionary } from '@renderer/i18n';

interface AutomationFormState {
  id?: string;
  name: string;
  prompt: string;
  frequencyType: AutomationFrequency['type'];
  timeOfDay: string;
  weeklyDay: number;
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
  transcript: string;
  busy: boolean;
  getAppMeta: (appId: string) => { name: string; description: string };
  onSave: (input: AutomationUpsertInput & { id?: string }) => void;
  onDelete: (id: string) => void;
  onPause: (id: string) => void;
  onResume: (id: string) => void;
  onRunNow: (id: string) => void;
  onSelectAutomation: (id: string) => void;
  onSelectRun: (runId: string) => void;
}

const emptyForm = (): AutomationFormState => ({
  name: '',
  prompt: '',
  frequencyType: 'hourly',
  timeOfDay: '09:00',
  weeklyDay: 1,
  selectedAppIds: [],
  enabled: false,
});

const formFromAutomation = (automation: Automation): AutomationFormState => ({
  id: automation.id,
  name: automation.name,
  prompt: automation.prompt,
  frequencyType: automation.frequency.type,
  timeOfDay: automation.frequency.timeOfDay ?? '09:00',
  weeklyDay: automation.frequency.weeklyDay ?? 1,
  selectedAppIds: automation.selectedAppIds,
  enabled: automation.enabled,
});

const buildInput = (form: AutomationFormState): AutomationUpsertInput & { id?: string } => {
  const frequency: AutomationFrequency =
    form.frequencyType === 'hourly'
      ? { type: 'hourly' }
      : form.frequencyType === 'daily'
        ? { type: 'daily', timeOfDay: form.timeOfDay }
        : { type: 'weekly', timeOfDay: form.timeOfDay, weeklyDay: form.weeklyDay };
  return {
    id: form.id,
    name: form.name,
    prompt: form.prompt,
    frequency,
    selectedAppIds: form.selectedAppIds,
    enabled: form.enabled,
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

export function AutomationsView({
  t,
  apps,
  automations,
  selectedAutomationId,
  runs,
  selectedRun,
  transcript,
  busy,
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
  const [form, setForm] = useState<AutomationFormState>(emptyForm);
  const selectedAutomation = useMemo(
    () => automations.find((automation) => automation.id === selectedAutomationId) ?? null,
    [automations, selectedAutomationId],
  );
  const allAppIds = apps.map((appEntry) => appEntry.id);
  const allSelected = allAppIds.length > 0 && allAppIds.every((appId) => form.selectedAppIds.includes(appId));

  useEffect(() => {
    if (!selectedAutomationId && automations[0]) {
      onSelectAutomation(automations[0].id);
    }
  }, [automations, selectedAutomationId, onSelectAutomation]);

  const openCreate = () => {
    setForm(emptyForm());
    setDialogOpen(true);
  };

  const openEdit = (automation: Automation) => {
    setForm(formFromAutomation(automation));
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

  const submit = () => {
    onSave(buildInput(form));
    setDialogOpen(false);
  };

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
                        <Chip size="small" variant="outlined" label={t.sections.automations.frequencyLabels[automation.frequency.type]} />
                      </Stack>
                    </Stack>
                    <Stack direction="row" spacing={0.25}>
                      <Tooltip title={t.sections.automations.testRun}>
                        <span>
                          <IconButton size="small" disabled={busy || automation.running} onClick={(event) => { event.stopPropagation(); onRunNow(automation.id); }}>
                            <ScienceRounded fontSize="small" />
                          </IconButton>
                        </span>
                      </Tooltip>
                      <Tooltip title={automation.enabled ? t.sections.automations.pause : t.sections.automations.resume}>
                        <span>
                          <IconButton size="small" disabled={busy} onClick={(event) => { event.stopPropagation(); automation.enabled ? onPause(automation.id) : onResume(automation.id); }}>
                            {automation.enabled ? <PauseRounded fontSize="small" /> : <PlayArrowRounded fontSize="small" />}
                          </IconButton>
                        </span>
                      </Tooltip>
                      <Tooltip title={t.sections.automations.edit}>
                        <IconButton size="small" onClick={(event) => { event.stopPropagation(); openEdit(automation); }}>
                          <EditRounded fontSize="small" />
                        </IconButton>
                      </Tooltip>
                      <Tooltip title={t.sections.automations.delete}>
                        <IconButton size="small" color="error" onClick={(event) => { event.stopPropagation(); onDelete(automation.id); }}>
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
                        variant={selectedRun?.id === run.id ? 'contained' : 'outlined'}
                        color="inherit"
                        onClick={() => onSelectRun(run.id)}
                        sx={{ justifyContent: 'space-between', minHeight: 42 }}
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
                <Typography variant="h6">{t.sections.automations.transcriptTitle}</Typography>
                <Divider />
                <Box
                  component="pre"
                  sx={{
                    m: 0,
                    minHeight: 280,
                    maxHeight: '48vh',
                    overflow: 'auto',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                    fontSize: 12,
                    bgcolor: 'action.hover',
                    borderRadius: 1,
                    p: 1.5,
                  }}
                >
                  {transcript || t.sections.automations.noTranscript}
                </Box>
              </Stack>
            </CardContent>
          </Card>
        </Stack>
      </Box>

      <Dialog open={dialogOpen} onClose={() => setDialogOpen(false)} maxWidth="md" fullWidth>
        <DialogTitle>{form.id ? t.sections.automations.edit : t.sections.automations.newAutomation}</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ pt: 1 }}>
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
            <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.5}>
              <FormControl fullWidth>
                <InputLabel>{t.sections.automations.frequency}</InputLabel>
                <Select
                  label={t.sections.automations.frequency}
                  value={form.frequencyType}
                  onChange={(event) => setForm((current) => ({ ...current, frequencyType: event.target.value as AutomationFrequency['type'] }))}
                >
                  <MenuItem value="hourly">{t.sections.automations.frequencyLabels.hourly}</MenuItem>
                  <MenuItem value="daily">{t.sections.automations.frequencyLabels.daily}</MenuItem>
                  <MenuItem value="weekly">{t.sections.automations.frequencyLabels.weekly}</MenuItem>
                </Select>
              </FormControl>
              {form.frequencyType !== 'hourly' ? (
                <TextField
                  label={t.sections.automations.timeOfDay}
                  type="time"
                  value={form.timeOfDay}
                  onChange={(event) => setForm((current) => ({ ...current, timeOfDay: event.target.value }))}
                  fullWidth
                  InputLabelProps={{ shrink: true }}
                />
              ) : null}
              {form.frequencyType === 'weekly' ? (
                <FormControl fullWidth>
                  <InputLabel>{t.sections.automations.weeklyDay}</InputLabel>
                  <Select
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
              <FormGroup sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' }, gap: 0.5 }}>
                {apps.map((appEntry) => (
                  <FormControlLabel
                    key={appEntry.id}
                    control={<Checkbox checked={form.selectedAppIds.includes(appEntry.id)} onChange={() => toggleApp(appEntry.id)} />}
                    label={getAppMeta(appEntry.id).name}
                  />
                ))}
              </FormGroup>
              {apps.length === 0 ? (
                <Typography variant="body2" color="text.secondary">{t.sections.automations.noInstalledApps}</Typography>
              ) : null}
            </Stack>
            <FormControlLabel
              control={<Checkbox checked={form.enabled} onChange={(event) => setForm((current) => ({ ...current, enabled: event.target.checked }))} />}
              label={t.sections.automations.activateOnSave}
            />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDialogOpen(false)}>{t.actions.close}</Button>
          <Button variant="contained" disabled={!form.name.trim() || !form.prompt.trim()} onClick={submit}>
            {t.sections.automations.save}
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}
