import { Box, MenuItem, Stack, TextField, Typography } from '@mui/material';
import type { AutomationFrequency, AutomationMissedRunPolicy } from '@shared/types';
import type { AppDictionary } from '@renderer/i18n';
import type { WorkflowDraft } from './workflow-draft';

const DEFAULT_MISSED_WINDOWS: Record<AutomationFrequency['type'], number> = {
  hourly: 30,
  daily: 360,
  weekly: 1440,
};

const missedWindowOptions = (
  frequencyType: AutomationFrequency['type'],
): Array<{ labelKey: 'minutes' | 'hours' | 'days'; value: number; amount: number }> => {
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

type DraftUpdater = (updater: (current: WorkflowDraft) => WorkflowDraft) => void;

/**
 * Name, description, schedule and missed-run policy for a workflow. Rendered
 * inline above the graph while creating, and inside a modal from the detail view.
 */
export function WorkflowParamsForm({ draft, onChange, t }: {
  draft: WorkflowDraft;
  onChange: DraftUpdater;
  t: AppDictionary;
}) {
  const copy = t.sections.workflows;
  const automations = t.sections.automations;
  const scheduled = draft.trigger.type === 'scheduled' ? draft.trigger : null;
  const frequencyType = scheduled?.frequency.type ?? 'daily';
  const missedRunPolicy: AutomationMissedRunPolicy = scheduled?.missedRunPolicy ?? 'within_window';

  return (
    <Stack spacing={1.5}>
      <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.5}>
        <TextField
          size="small"
          fullWidth
          label={copy.name}
          value={draft.name}
          onChange={(event) => onChange((current) => ({ ...current, name: event.target.value }))}
        />
        <TextField
          size="small"
          fullWidth
          label={copy.description}
          value={draft.description}
          onChange={(event) => onChange((current) => ({ ...current, description: event.target.value }))}
        />
      </Stack>
      <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.5} alignItems={{ md: 'center' }} flexWrap="wrap" useFlexGap>
        <TextField
          select
          size="small"
          sx={{ minWidth: 180 }}
          label={copy.triggerSection}
          value={draft.trigger.type}
          onChange={(event) => onChange((current) => (
            event.target.value === 'scheduled'
              ? { ...current, trigger: { type: 'scheduled', frequency: { type: 'daily', timeOfDay: '09:00' }, missedRunPolicy: 'within_window', missedRunWindowMinutes: DEFAULT_MISSED_WINDOWS.daily } }
              : { ...current, trigger: { type: 'manual' } }
          ))}
        >
          <MenuItem value="manual">{copy.triggerManual}</MenuItem>
          <MenuItem value="scheduled">{copy.triggerScheduled}</MenuItem>
        </TextField>
        {scheduled ? (
          <>
            <TextField
              select
              size="small"
              sx={{ minWidth: 160 }}
              label={automations.frequency}
              value={frequencyType}
              onChange={(event) => onChange((current) => {
                if (current.trigger.type !== 'scheduled') {
                  return current;
                }
                const type = event.target.value as AutomationFrequency['type'];
                const frequency: AutomationFrequency = type === 'hourly'
                  ? { type: 'hourly' }
                  : type === 'daily'
                    ? { type: 'daily', timeOfDay: current.trigger.frequency.timeOfDay ?? '09:00' }
                    : { type: 'weekly', timeOfDay: current.trigger.frequency.timeOfDay ?? '09:00', weeklyDay: current.trigger.frequency.weeklyDay ?? 1 };
                return {
                  ...current,
                  trigger: {
                    ...current.trigger,
                    frequency,
                    missedRunWindowMinutes: DEFAULT_MISSED_WINDOWS[type],
                  },
                };
              })}
            >
              {(['hourly', 'daily', 'weekly'] as const).map((type) => (
                <MenuItem key={type} value={type}>{automations.frequencyLabels[type]}</MenuItem>
              ))}
            </TextField>
            {scheduled.frequency.type !== 'hourly' ? (
              <TextField
                size="small"
                type="time"
                sx={{ minWidth: 130 }}
                label={automations.timeOfDay}
                value={scheduled.frequency.timeOfDay ?? '09:00'}
                onChange={(event) => onChange((current) => current.trigger.type === 'scheduled'
                  ? { ...current, trigger: { ...current.trigger, frequency: { ...current.trigger.frequency, timeOfDay: event.target.value } } }
                  : current)}
              />
            ) : null}
            {scheduled.frequency.type === 'weekly' ? (
              <TextField
                select
                size="small"
                sx={{ minWidth: 150 }}
                label={automations.weeklyDay}
                value={scheduled.frequency.weeklyDay ?? 1}
                onChange={(event) => onChange((current) => current.trigger.type === 'scheduled'
                  ? { ...current, trigger: { ...current.trigger, frequency: { ...current.trigger.frequency, weeklyDay: Number(event.target.value) } } }
                  : current)}
              >
                {automations.weekdays.map((day, index) => (
                  <MenuItem key={day} value={index}>{day}</MenuItem>
                ))}
              </TextField>
            ) : null}
          </>
        ) : null}
      </Stack>
      {scheduled ? (
        <Stack spacing={0.5}>
          <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.5}>
            <TextField
              select
              size="small"
              fullWidth
              label={automations.missedRunPolicy}
              value={missedRunPolicy}
              onChange={(event) => onChange((current) => current.trigger.type === 'scheduled'
                ? { ...current, trigger: { ...current.trigger, missedRunPolicy: event.target.value as AutomationMissedRunPolicy } }
                : current)}
            >
              <MenuItem value="skip">{automations.missedRunPolicies.skip}</MenuItem>
              <MenuItem value="always">{automations.missedRunPolicies.always}</MenuItem>
              <MenuItem value="within_window">{automations.missedRunPolicies.within_window}</MenuItem>
            </TextField>
            {missedRunPolicy === 'within_window' ? (
              <TextField
                select
                size="small"
                fullWidth
                label={automations.missedRunWindow}
                value={scheduled.missedRunWindowMinutes ?? DEFAULT_MISSED_WINDOWS[frequencyType]}
                onChange={(event) => onChange((current) => current.trigger.type === 'scheduled'
                  ? { ...current, trigger: { ...current.trigger, missedRunWindowMinutes: Number(event.target.value) } }
                  : current)}
              >
                {missedWindowOptions(frequencyType).map((option) => (
                  <MenuItem key={option.value} value={option.value}>
                    {automations.missedRunWindowLabels[option.labelKey](option.amount)}
                  </MenuItem>
                ))}
              </TextField>
            ) : (
              <Box sx={{ flex: 1 }} />
            )}
          </Stack>
          <Typography variant="caption" color="text.secondary">{automations.missedRunHelper[missedRunPolicy]}</Typography>
        </Stack>
      ) : null}
    </Stack>
  );
}
