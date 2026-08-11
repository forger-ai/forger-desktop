import { fireEvent, render, screen, waitForElementToBeRemoved, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { AutomationFrequency, PersonalAgentRoutine } from '@shared/types';
import { DEFAULT_INTERVAL_MINUTES, MAX_INTERVAL_MINUTES, MIN_INTERVAL_MINUTES } from '@shared/types';
import { getDictionary } from '@renderer/i18n';
import {
  AgentRoutineDialog,
  AgentRoutinesPanel,
  clampRoutineIntervalMinutes,
  defaultRoutineMissedRunWindowMinutes,
  normalizeTimeOfDay,
} from '@renderer/views/AgentRoutinesPanel';

const t = getDictionary('en');
const copy = t.agents.routines;

const routine = (id: string, frequency: AutomationFrequency, overrides: Partial<PersonalAgentRoutine> = {}): PersonalAgentRoutine => ({
  id,
  agentId: 'agent-1',
  conversationId: `conversation-${id}`,
  name: `Routine ${id}`,
  prompt: `Prompt for ${id}`,
  frequency,
  missedRunPolicy: 'skip',
  enabled: true,
  running: false,
  nextRunAt: null,
  authorizationText: 'Authorized by owner',
  createdAt: '2026-08-10T10:00:00.000Z',
  updatedAt: '2026-08-10T10:00:00.000Z',
  ...overrides,
});

const dialogCallbacks = () => ({
  onClose: vi.fn(), onSave: vi.fn(), onNameChange: vi.fn(), onPromptChange: vi.fn(),
  onFrequencyTypeChange: vi.fn(), onTimeOfDayChange: vi.fn(), onWeeklyDayChange: vi.fn(),
  onIntervalMinutesChange: vi.fn(), onMissedRunPolicyChange: vi.fn(),
  onMissedRunWindowMinutesChange: vi.fn(), onEnabledChange: vi.fn(), onAuthorizationTextChange: vi.fn(),
});

const dialogProps = (overrides: Partial<Parameters<typeof AgentRoutineDialog>[0]> = {}) => ({
  t,
  open: true,
  editingRoutine: null,
  busy: false,
  name: 'Morning brief',
  prompt: 'Summarize my priorities',
  frequencyType: 'interval' as const,
  timeOfDay: '09:00',
  weeklyDay: 1,
  intervalMinutes: '15',
  missedRunPolicy: 'skip' as const,
  missedRunWindowMinutes: '30',
  enabled: true,
  authorizationText: 'The owner approved this routine',
  ...dialogCallbacks(),
  ...overrides,
});

const choose = async (user: ReturnType<typeof userEvent.setup>, label: string, option: string) => {
  await user.click(screen.getByLabelText(label));
  await user.click(screen.getByRole('option', { name: option }));
};

describe('AgentRoutinesPanel helpers', () => {
  it('normalizes times and clamps interval values at every boundary', () => {
    expect(normalizeTimeOfDay('bad')).toBe('09:00');
    expect(normalizeTimeOfDay(' 9:05 ')).toBe('09:05');
    expect(normalizeTimeOfDay('99:99')).toBe('23:59');
    expect(normalizeTimeOfDay('-1:00')).toBe('09:00');

    expect(clampRoutineIntervalMinutes('not-a-number')).toBe(DEFAULT_INTERVAL_MINUTES);
    expect(clampRoutineIntervalMinutes('0')).toBe(DEFAULT_INTERVAL_MINUTES);
    expect(clampRoutineIntervalMinutes('0.6')).toBe(MIN_INTERVAL_MINUTES);
    expect(clampRoutineIntervalMinutes('4.6')).toBe(5);
    expect(clampRoutineIntervalMinutes('99999')).toBe(MAX_INTERVAL_MINUTES);

    expect(defaultRoutineMissedRunWindowMinutes('interval')).toBe(DEFAULT_INTERVAL_MINUTES);
    expect(defaultRoutineMissedRunWindowMinutes('hourly')).toBe(30);
    expect(defaultRoutineMissedRunWindowMinutes('daily')).toBe(360);
    expect(defaultRoutineMissedRunWindowMinutes('weekly')).toBe(1440);
  });
});

describe('AgentRoutinesPanel', () => {
  it('shows the empty and busy state', () => {
    const onCreate = vi.fn();
    render(
      <AgentRoutinesPanel
        t={t} routines={[]} busy onCreate={onCreate}
        onOpenThread={vi.fn()} onToggle={vi.fn()} onEdit={vi.fn()} onDelete={vi.fn()}
      />,
    );
    expect(screen.getByText(copy.empty)).toBeVisible();
    expect(screen.getByRole('button', { name: copy.create })).toBeDisabled();
  });

  it('renders every schedule and run state and invokes all row actions', async () => {
    const user = userEvent.setup();
    const callbacks = {
      onCreate: vi.fn(), onOpenThread: vi.fn(), onToggle: vi.fn(), onEdit: vi.fn(), onDelete: vi.fn(),
    };
    const routines = [
      routine('interval', { type: 'interval' }, {
        running: true,
        nextRunAt: 'invalid-date',
        lastRun: {
          id: 'run-1', routineId: 'interval', agentId: 'agent-1', conversationId: 'conversation-interval',
          trigger: 'scheduled', status: 'failed', startedAt: '2026-08-10T10:00:00.000Z', error: 'Network unavailable',
        },
      }),
      routine('hourly', { type: 'hourly' }, {
        enabled: false,
        nextRunAt: '2026-08-11T10:00:00.000Z',
        lastRun: {
          id: 'run-2', routineId: 'hourly', agentId: 'agent-1', conversationId: 'conversation-hourly',
          trigger: 'manual', status: 'completed', startedAt: '2026-08-10T10:00:00.000Z',
        },
      }),
      routine('daily', { type: 'daily' }),
      routine('weekly-default', { type: 'weekly' }),
      routine('weekly-invalid', { type: 'weekly', weeklyDay: 99, timeOfDay: '18:45' }),
    ];
    render(<AgentRoutinesPanel t={t} routines={routines} busy={false} {...callbacks} />);

    expect(screen.getByText(copy.running)).toBeVisible();
    expect(screen.getByText(copy.paused)).toBeVisible();
    expect(screen.getByText('invalid-date', { exact: false })).toBeVisible();
    expect(screen.getByText('Network unavailable', { exact: false })).toBeVisible();
    expect(screen.getAllByText(copy.noNextRun, { exact: false })).toHaveLength(3);
    expect(screen.getByText(t.sections.automations.frequencyLabels.hourly, { exact: false })).toBeVisible();
    expect(screen.getByText(t.sections.automations.frequencySummaries.interval(DEFAULT_INTERVAL_MINUTES), { exact: false })).toBeVisible();
    expect(screen.getByText(t.sections.automations.frequencySummaries.daily('09:00'), { exact: false })).toBeVisible();

    await user.click(screen.getByRole('button', { name: copy.create }));
    expect(callbacks.onCreate).toHaveBeenCalledOnce();
    const firstCard = screen.getByText('Routine interval').closest('.MuiPaper-outlined') as HTMLElement;
    await user.click(within(firstCard).getByRole('button', { name: copy.openThread }));
    await user.click(within(firstCard).getByRole('button', { name: copy.pause }));
    await user.click(within(firstCard).getByRole('button', { name: copy.edit }));
    await user.click(within(firstCard).getByRole('button', { name: copy.delete }));
    expect(callbacks.onOpenThread).toHaveBeenCalledWith(routines[0]);
    expect(callbacks.onToggle).toHaveBeenCalledWith(routines[0]);
    expect(callbacks.onEdit).toHaveBeenCalledWith(routines[0]);
    expect(callbacks.onDelete).toHaveBeenCalledWith(routines[0]);

    const hourlyCard = screen.getByText('Routine hourly').closest('.MuiPaper-outlined') as HTMLElement;
    await user.click(within(hourlyCard).getByRole('button', { name: copy.resume }));
    expect(callbacks.onToggle).toHaveBeenCalledWith(routines[1]);
  });
});

describe('AgentRoutineDialog', () => {
  it('edits interval fields, status, prompt, authorization, and saves or closes', async () => {
    const user = userEvent.setup();
    const callbacks = dialogCallbacks();
    render(<AgentRoutineDialog {...dialogProps(callbacks)} />);
    expect(screen.getByText(copy.createTitle)).toBeVisible();
    expect(screen.getByLabelText(copy.intervalMinutes)).toHaveAttribute('min', String(MIN_INTERVAL_MINUTES));
    expect(screen.queryByLabelText(copy.time)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(copy.missedRunPolicy)).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(copy.name), { target: { value: 'Evening brief' } });
    fireEvent.change(screen.getByLabelText(copy.intervalMinutes), { target: { value: '45' } });
    await choose(user, copy.status, copy.paused);
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'Prepare tomorrow' } });
    fireEvent.change(screen.getByLabelText(copy.authorization), { target: { value: 'Approved explicitly' } });
    expect(callbacks.onNameChange).toHaveBeenLastCalledWith('Evening brief');
    expect(callbacks.onIntervalMinutesChange).toHaveBeenLastCalledWith('45');
    expect(callbacks.onEnabledChange).toHaveBeenCalledWith(false);
    expect(callbacks.onPromptChange).toHaveBeenLastCalledWith('Prepare tomorrow');
    expect(callbacks.onAuthorizationTextChange).toHaveBeenLastCalledWith('Approved explicitly');

    await user.click(screen.getByRole('button', { name: t.actions.close }));
    await user.click(screen.getByRole('button', { name: t.actions.save }));
    expect(callbacks.onClose).toHaveBeenCalledOnce();
    expect(callbacks.onSave).toHaveBeenCalledOnce();
  });

  it('edits weekly scheduling and missed-run recovery', async () => {
    const user = userEvent.setup();
    const callbacks = dialogCallbacks();
    render(<AgentRoutineDialog {...dialogProps({
      ...callbacks,
      editingRoutine: routine('editing', { type: 'weekly' }),
      frequencyType: 'weekly',
      weeklyDay: 2,
      missedRunPolicy: 'within_window',
      enabled: false,
    })} />);
    expect(screen.getByText(copy.editTitle)).toBeVisible();
    fireEvent.change(screen.getByLabelText(copy.time), { target: { value: '18:30' } });
    await choose(user, copy.day, t.sections.automations.weekdays[4]);
    await choose(user, copy.missedRunPolicy, t.sections.automations.missedRunPolicies.always);
    fireEvent.change(screen.getByLabelText(copy.retryWindow), { target: { value: '90' } });
    await choose(user, copy.status, copy.active);
    await choose(user, copy.periodicity, t.sections.automations.frequencyLabels.daily);
    expect(callbacks.onTimeOfDayChange).toHaveBeenLastCalledWith('18:30');
    expect(callbacks.onWeeklyDayChange).toHaveBeenCalledWith(4);
    expect(callbacks.onMissedRunPolicyChange).toHaveBeenCalledWith('always');
    expect(callbacks.onMissedRunWindowMinutesChange).toHaveBeenLastCalledWith('90');
    expect(callbacks.onEnabledChange).toHaveBeenCalledWith(true);
    expect(callbacks.onFrequencyTypeChange).toHaveBeenCalledWith('daily');
  });

  it('shows hourly policy controls and disables invalid or busy saves', async () => {
    const { rerender } = render(<AgentRoutineDialog {...dialogProps({
      frequencyType: 'hourly', name: ' ', prompt: '', authorizationText: '',
    })} />);
    expect(screen.queryByLabelText(copy.time)).not.toBeInTheDocument();
    expect(screen.getByLabelText(copy.missedRunPolicy)).toBeVisible();
    expect(screen.getByRole('button', { name: t.actions.save })).toBeDisabled();
    rerender(<AgentRoutineDialog {...dialogProps({ busy: true })} />);
    expect(screen.getByRole('button', { name: t.actions.save })).toBeDisabled();
    const dialog = screen.getByRole('dialog');
    rerender(<AgentRoutineDialog {...dialogProps({ open: false })} />);
    await waitForElementToBeRemoved(dialog);
  });
});
