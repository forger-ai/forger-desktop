import AddRounded from '@mui/icons-material/AddRounded';
import ChatRounded from '@mui/icons-material/ChatRounded';
import DeleteOutlineRounded from '@mui/icons-material/DeleteOutlineRounded';
import EditRounded from '@mui/icons-material/EditRounded';
import EventRepeatRounded from '@mui/icons-material/EventRepeatRounded';
import PauseRounded from '@mui/icons-material/PauseRounded';
import PlayArrowRounded from '@mui/icons-material/PlayArrowRounded';
import SaveRounded from '@mui/icons-material/SaveRounded';
import {
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  MenuItem,
  Paper,
  Stack,
  TextField,
  Tooltip,
  Typography,
  useTheme,
} from '@mui/material';
import type { AutomationFrequency, AutomationMissedRunPolicy, PersonalAgentRoutine } from '@shared/types';
import { DEFAULT_INTERVAL_MINUTES, MAX_INTERVAL_MINUTES, MIN_INTERVAL_MINUTES } from '@shared/types';
import type { AppDictionary } from '@renderer/i18n';

type RoutineFrequencyType = AutomationFrequency['type'];

interface AgentRoutinesPanelProps {
  t: AppDictionary;
  routines: PersonalAgentRoutine[];
  busy: boolean;
  onCreate: () => void;
  onOpenThread: (routine: PersonalAgentRoutine) => void;
  onToggle: (routine: PersonalAgentRoutine) => void;
  onEdit: (routine: PersonalAgentRoutine) => void;
  onDelete: (routine: PersonalAgentRoutine) => void;
}

interface AgentRoutineDialogProps {
  t: AppDictionary;
  open: boolean;
  editingRoutine: PersonalAgentRoutine | null;
  busy: boolean;
  name: string;
  prompt: string;
  frequencyType: RoutineFrequencyType;
  timeOfDay: string;
  weeklyDay: number;
  intervalMinutes: string;
  missedRunPolicy: AutomationMissedRunPolicy;
  missedRunWindowMinutes: string;
  enabled: boolean;
  authorizationText: string;
  onClose: () => void;
  onSave: () => void;
  onNameChange: (value: string) => void;
  onPromptChange: (value: string) => void;
  onFrequencyTypeChange: (value: RoutineFrequencyType) => void;
  onTimeOfDayChange: (value: string) => void;
  onWeeklyDayChange: (value: number) => void;
  onIntervalMinutesChange: (value: string) => void;
  onMissedRunPolicyChange: (value: AutomationMissedRunPolicy) => void;
  onMissedRunWindowMinutesChange: (value: string) => void;
  onEnabledChange: (value: boolean) => void;
  onAuthorizationTextChange: (value: string) => void;
}

export function AgentRoutinesPanel({
  t,
  routines,
  busy,
  onCreate,
  onOpenThread,
  onToggle,
  onEdit,
  onDelete,
}: AgentRoutinesPanelProps) {
  const theme = useTheme();
  const r = t.agents.routines;

  return (
    <Paper variant="outlined" sx={{ height: '100%', minHeight: 0, overflow: 'auto', p: 2, borderRadius: 1 }}>
      <Stack spacing={1.5}>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems={{ xs: 'stretch', sm: 'center' }}>
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Typography variant="subtitle1" fontWeight={700}>
              {r.title}
            </Typography>
          </Box>
          <Button startIcon={<AddRounded />} variant="contained" onClick={onCreate} disabled={busy}>
            {r.create}
          </Button>
        </Stack>

        {routines.length === 0 ? (
          <Box sx={{ border: `1px dashed ${theme.palette.divider}`, borderRadius: 1, p: 3, textAlign: 'center' }}>
            <Typography color="text.secondary">
              {r.empty}
            </Typography>
          </Box>
        ) : (
          <Stack spacing={1}>
            {routines.map((routine) => (
              <Paper key={routine.id} variant="outlined" sx={{ borderRadius: 1, p: 1.25 }}>
                <Stack spacing={1}>
                  <Stack direction={{ xs: 'column', md: 'row' }} spacing={1} alignItems={{ xs: 'stretch', md: 'center' }}>
                    <Box sx={{ flex: 1, minWidth: 0 }}>
                      <Stack direction="row" spacing={0.75} alignItems="center" sx={{ minWidth: 0 }}>
                        <EventRepeatRounded color="action" fontSize="small" />
                        <Typography variant="subtitle2" noWrap>{routine.name}</Typography>
                        <Chip size="small" color={routine.enabled ? 'success' : 'default'} label={routine.enabled ? r.active : r.paused} />
                        {routine.running ? <Chip size="small" color="primary" label={r.running} /> : null}
                      </Stack>
                      <Typography variant="body2" color="text.secondary" noWrap>
                        {formatRoutineFrequency(routine.frequency, t)} - {routine.nextRunAt ? `${r.nextLabel}: ${formatDateTime(routine.nextRunAt)}` : r.noNextRun}
                      </Typography>
                    </Box>
                    <Stack direction="row" spacing={0.5} justifyContent={{ xs: 'flex-start', md: 'flex-end' }}>
                      <Tooltip title={r.openThread}>
                        <IconButton size="small" onClick={() => onOpenThread(routine)}>
                          <ChatRounded fontSize="small" />
                        </IconButton>
                      </Tooltip>
                      <Tooltip title={routine.enabled ? r.pause : r.resume}>
                        <IconButton size="small" disabled={busy} onClick={() => onToggle(routine)}>
                          {routine.enabled ? <PauseRounded fontSize="small" /> : <PlayArrowRounded fontSize="small" />}
                        </IconButton>
                      </Tooltip>
                      <Tooltip title={r.edit}>
                        <IconButton size="small" disabled={busy} onClick={() => onEdit(routine)}>
                          <EditRounded fontSize="small" />
                        </IconButton>
                      </Tooltip>
                      <Tooltip title={r.delete}>
                        <IconButton size="small" disabled={busy} onClick={() => onDelete(routine)}>
                          <DeleteOutlineRounded fontSize="small" />
                        </IconButton>
                      </Tooltip>
                    </Stack>
                  </Stack>
                  <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                    {routine.prompt}
                  </Typography>
                  {routine.lastRun ? (
                    <Typography variant="caption" color="text.secondary">
                      {r.lastRun}: {routine.lastRun.status}{routine.lastRun.error ? ` - ${routine.lastRun.error}` : ''}
                    </Typography>
                  ) : null}
                </Stack>
              </Paper>
            ))}
          </Stack>
        )}
      </Stack>
    </Paper>
  );
}

export function AgentRoutineDialog({
  t,
  open,
  editingRoutine,
  busy,
  name,
  prompt,
  frequencyType,
  timeOfDay,
  weeklyDay,
  intervalMinutes,
  missedRunPolicy,
  missedRunWindowMinutes,
  enabled,
  authorizationText,
  onClose,
  onSave,
  onNameChange,
  onPromptChange,
  onFrequencyTypeChange,
  onTimeOfDayChange,
  onWeeklyDayChange,
  onIntervalMinutesChange,
  onMissedRunPolicyChange,
  onMissedRunWindowMinutesChange,
  onEnabledChange,
  onAuthorizationTextChange,
}: AgentRoutineDialogProps) {
  const r = t.agents.routines;
  const automations = t.sections.automations;
  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>
        {editingRoutine ? r.editTitle : r.createTitle}
      </DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 0.5 }}>
          <TextField size="small" label={r.name} value={name} onChange={(event) => onNameChange(event.target.value)} />
          <TextField
            size="small"
            select
            label={r.periodicity}
            value={frequencyType}
            onChange={(event) => onFrequencyTypeChange(event.target.value as RoutineFrequencyType)}
          >
            <MenuItem value="interval">{automations.frequencyLabels.interval}</MenuItem>
            <MenuItem value="hourly">{automations.frequencyLabels.hourly}</MenuItem>
            <MenuItem value="daily">{automations.frequencyLabels.daily}</MenuItem>
            <MenuItem value="weekly">{automations.frequencyLabels.weekly}</MenuItem>
          </TextField>
          {frequencyType === 'interval' ? (
            <TextField
              size="small"
              type="number"
              label={r.intervalMinutes}
              helperText={r.intervalMinutesHelper}
              value={intervalMinutes}
              onChange={(event) => onIntervalMinutesChange(event.target.value)}
              inputProps={{ min: MIN_INTERVAL_MINUTES, max: MAX_INTERVAL_MINUTES, step: 1 }}
            />
          ) : null}
          {frequencyType !== 'hourly' && frequencyType !== 'interval' ? (
            <TextField
              size="small"
              label={r.time}
              value={timeOfDay}
              onChange={(event) => onTimeOfDayChange(event.target.value)}
              placeholder="09:00"
            />
          ) : null}
          {frequencyType === 'weekly' ? (
            <TextField
              size="small"
              select
              label={r.day}
              value={weeklyDay}
              onChange={(event) => onWeeklyDayChange(Number(event.target.value))}
            >
              {automations.weekdays.map((label, index) => (
                <MenuItem key={label} value={index}>{label}</MenuItem>
              ))}
            </TextField>
          ) : null}
          {frequencyType !== 'interval' ? (
            <TextField
              size="small"
              select
              label={r.missedRunPolicy}
              value={missedRunPolicy}
              onChange={(event) => onMissedRunPolicyChange(event.target.value as AutomationMissedRunPolicy)}
            >
              <MenuItem value="within_window">{automations.missedRunPolicies.within_window}</MenuItem>
              <MenuItem value="skip">{automations.missedRunPolicies.skip}</MenuItem>
              <MenuItem value="always">{automations.missedRunPolicies.always}</MenuItem>
            </TextField>
          ) : null}
          {frequencyType !== 'interval' && missedRunPolicy === 'within_window' ? (
            <TextField
              size="small"
              type="number"
              label={r.retryWindow}
              value={missedRunWindowMinutes}
              onChange={(event) => onMissedRunWindowMinutesChange(event.target.value)}
            />
          ) : null}
          <TextField
            size="small"
            select
            label={r.status}
            value={enabled ? 'enabled' : 'paused'}
            onChange={(event) => onEnabledChange(event.target.value === 'enabled')}
          >
            <MenuItem value="enabled">{r.active}</MenuItem>
            <MenuItem value="paused">{r.paused}</MenuItem>
          </TextField>
          <TextField size="small" multiline minRows={4} label="Prompt" value={prompt} onChange={(event) => onPromptChange(event.target.value)} />
          <TextField
            size="small"
            label={r.authorization}
            value={authorizationText}
            onChange={(event) => onAuthorizationTextChange(event.target.value)}
          />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{t.actions.close}</Button>
        <Button
          startIcon={<SaveRounded />}
          variant="contained"
          disabled={busy || !name.trim() || !prompt.trim() || !authorizationText.trim()}
          onClick={onSave}
        >
          {t.actions.save}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export const normalizeTimeOfDay = (value: string): string => {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return '09:00';
  const hour = Math.min(23, Math.max(0, Number(match[1])));
  const minute = Math.min(59, Math.max(0, Number(match[2])));
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
};

export const clampRoutineIntervalMinutes = (value: string): number => {
  const numeric = Math.round(Number(value));
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return DEFAULT_INTERVAL_MINUTES;
  }
  return Math.min(MAX_INTERVAL_MINUTES, Math.max(MIN_INTERVAL_MINUTES, numeric));
};

export const defaultRoutineMissedRunWindowMinutes = (type: AutomationFrequency['type']): number => {
  if (type === 'interval') return DEFAULT_INTERVAL_MINUTES;
  if (type === 'hourly') return 30;
  if (type === 'daily') return 6 * 60;
  return 24 * 60;
};

const formatDateTime = (value: string): string => {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(date);
};

const formatRoutineFrequency = (frequency: AutomationFrequency, t: AppDictionary): string => {
  const automations = t.sections.automations;
  if (frequency.type === 'interval') {
    return automations.frequencySummaries.interval(frequency.intervalMinutes ?? DEFAULT_INTERVAL_MINUTES);
  }
  if (frequency.type === 'hourly') {
    return automations.frequencyLabels.hourly;
  }
  if (frequency.type === 'daily') {
    return automations.frequencySummaries.daily(frequency.timeOfDay ?? '09:00');
  }
  const weeklyDay = frequency.weeklyDay ?? 1;
  const day = automations.weekdays[weeklyDay] ?? automations.weekdays[1];
  return automations.frequencySummaries.weekly(day, frequency.timeOfDay ?? '09:00');
};
