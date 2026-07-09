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

  return (
    <Paper variant="outlined" sx={{ height: '100%', minHeight: 0, overflow: 'auto', p: 2, borderRadius: 1 }}>
      <Stack spacing={1.5}>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems={{ xs: 'stretch', sm: 'center' }}>
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Typography variant="subtitle1" fontWeight={700}>
              {t.locale === 'es' ? 'Rutinas' : 'Routines'}
            </Typography>
          </Box>
          <Button startIcon={<AddRounded />} variant="contained" onClick={onCreate} disabled={busy}>
            {t.locale === 'es' ? 'Crear rutina' : 'Create routine'}
          </Button>
        </Stack>

        {routines.length === 0 ? (
          <Box sx={{ border: `1px dashed ${theme.palette.divider}`, borderRadius: 1, p: 3, textAlign: 'center' }}>
            <Typography color="text.secondary">
              {t.locale === 'es' ? 'Este agente aun no tiene rutinas.' : 'This agent has no routines yet.'}
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
                        <Chip size="small" color={routine.enabled ? 'success' : 'default'} label={routine.enabled ? (t.locale === 'es' ? 'Activa' : 'Active') : (t.locale === 'es' ? 'Pausada' : 'Paused')} />
                        {routine.running ? <Chip size="small" color="primary" label={t.locale === 'es' ? 'Ejecutando' : 'Running'} /> : null}
                      </Stack>
                      <Typography variant="body2" color="text.secondary" noWrap>
                        {formatRoutineFrequency(routine.frequency, t.locale)} - {routine.nextRunAt ? `${t.locale === 'es' ? 'Proxima' : 'Next'}: ${formatDateTime(routine.nextRunAt)}` : (t.locale === 'es' ? 'Sin proxima ejecucion' : 'No next run')}
                      </Typography>
                    </Box>
                    <Stack direction="row" spacing={0.5} justifyContent={{ xs: 'flex-start', md: 'flex-end' }}>
                      <Tooltip title={t.locale === 'es' ? 'Abrir thread' : 'Open thread'}>
                        <IconButton size="small" onClick={() => onOpenThread(routine)}>
                          <ChatRounded fontSize="small" />
                        </IconButton>
                      </Tooltip>
                      <Tooltip title={routine.enabled ? (t.locale === 'es' ? 'Pausar' : 'Pause') : (t.locale === 'es' ? 'Reanudar' : 'Resume')}>
                        <IconButton size="small" disabled={busy} onClick={() => onToggle(routine)}>
                          {routine.enabled ? <PauseRounded fontSize="small" /> : <PlayArrowRounded fontSize="small" />}
                        </IconButton>
                      </Tooltip>
                      <Tooltip title={t.locale === 'es' ? 'Editar' : 'Edit'}>
                        <IconButton size="small" disabled={busy} onClick={() => onEdit(routine)}>
                          <EditRounded fontSize="small" />
                        </IconButton>
                      </Tooltip>
                      <Tooltip title={t.locale === 'es' ? 'Eliminar' : 'Delete'}>
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
                      {t.locale === 'es' ? 'Ultima ejecucion' : 'Last run'}: {routine.lastRun.status}{routine.lastRun.error ? ` - ${routine.lastRun.error}` : ''}
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
  onMissedRunPolicyChange,
  onMissedRunWindowMinutesChange,
  onEnabledChange,
  onAuthorizationTextChange,
}: AgentRoutineDialogProps) {
  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>
        {editingRoutine ? (t.locale === 'es' ? 'Editar rutina' : 'Edit routine') : (t.locale === 'es' ? 'Crear rutina' : 'Create routine')}
      </DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 0.5 }}>
          <TextField size="small" label={t.locale === 'es' ? 'Nombre' : 'Name'} value={name} onChange={(event) => onNameChange(event.target.value)} />
          <TextField
            size="small"
            select
            label={t.locale === 'es' ? 'Periodicidad' : 'Periodicity'}
            value={frequencyType}
            onChange={(event) => onFrequencyTypeChange(event.target.value as RoutineFrequencyType)}
          >
            <MenuItem value="hourly">{t.locale === 'es' ? 'Cada hora' : 'Hourly'}</MenuItem>
            <MenuItem value="daily">{t.locale === 'es' ? 'Diaria' : 'Daily'}</MenuItem>
            <MenuItem value="weekly">{t.locale === 'es' ? 'Semanal' : 'Weekly'}</MenuItem>
          </TextField>
          {frequencyType !== 'hourly' ? (
            <TextField
              size="small"
              label={t.locale === 'es' ? 'Hora' : 'Time'}
              value={timeOfDay}
              onChange={(event) => onTimeOfDayChange(event.target.value)}
              placeholder="09:00"
            />
          ) : null}
          {frequencyType === 'weekly' ? (
            <TextField
              size="small"
              select
              label={t.locale === 'es' ? 'Dia' : 'Day'}
              value={weeklyDay}
              onChange={(event) => onWeeklyDayChange(Number(event.target.value))}
            >
              {weekdayLabels(t.locale).map((label, index) => (
                <MenuItem key={label} value={index}>{label}</MenuItem>
              ))}
            </TextField>
          ) : null}
          <TextField
            size="small"
            select
            label="missedRunPolicy"
            value={missedRunPolicy}
            onChange={(event) => onMissedRunPolicyChange(event.target.value as AutomationMissedRunPolicy)}
          >
            <MenuItem value="within_window">within_window</MenuItem>
            <MenuItem value="skip">skip</MenuItem>
            <MenuItem value="always">always</MenuItem>
          </TextField>
          {missedRunPolicy === 'within_window' ? (
            <TextField
              size="small"
              type="number"
              label={t.locale === 'es' ? 'Ventana perdida (min)' : 'Missed window (min)'}
              value={missedRunWindowMinutes}
              onChange={(event) => onMissedRunWindowMinutesChange(event.target.value)}
            />
          ) : null}
          <TextField
            size="small"
            select
            label={t.locale === 'es' ? 'Estado' : 'Status'}
            value={enabled ? 'enabled' : 'paused'}
            onChange={(event) => onEnabledChange(event.target.value === 'enabled')}
          >
            <MenuItem value="enabled">{t.locale === 'es' ? 'Activa' : 'Active'}</MenuItem>
            <MenuItem value="paused">{t.locale === 'es' ? 'Pausada' : 'Paused'}</MenuItem>
          </TextField>
          <TextField size="small" multiline minRows={4} label="Prompt" value={prompt} onChange={(event) => onPromptChange(event.target.value)} />
          <TextField
            size="small"
            label={t.locale === 'es' ? 'Autorizacion' : 'Authorization'}
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
          {t.locale === 'es' ? 'Guardar' : 'Save'}
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

export const defaultRoutineMissedRunWindowMinutes = (type: AutomationFrequency['type']): number => {
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

const formatRoutineFrequency = (frequency: AutomationFrequency, locale: string): string => {
  if (frequency.type === 'hourly') {
    return locale === 'es' ? 'Cada hora' : 'Hourly';
  }
  if (frequency.type === 'daily') {
    return locale === 'es' ? `Diaria ${frequency.timeOfDay}` : `Daily ${frequency.timeOfDay}`;
  }
  const weeklyDay = frequency.weeklyDay ?? 1;
  return `${locale === 'es' ? 'Semanal' : 'Weekly'} ${weekdayLabels(locale)[weeklyDay] ?? weeklyDay} ${frequency.timeOfDay ?? '09:00'}`;
};

const weekdayLabels = (locale: string): string[] =>
  locale === 'es'
    ? ['Domingo', 'Lunes', 'Martes', 'Miercoles', 'Jueves', 'Viernes', 'Sabado']
    : ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
