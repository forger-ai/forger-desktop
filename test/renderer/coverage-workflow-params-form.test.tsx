import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { getDictionary } from '@renderer/i18n';
import { WorkflowParamsForm } from '@renderer/views/workflows/WorkflowParamsForm';
import { emptyDraft, type WorkflowDraft } from '@renderer/views/workflows/workflow-draft';

const t = getDictionary('en');
const copy = t.sections.workflows;
const automations = t.sections.automations;

const choose = async (user: ReturnType<typeof userEvent.setup>, label: string, option: string) => {
  await user.click(screen.getByRole('combobox', { name: label }));
  await user.click(screen.getByRole('option', { name: option }));
};

const Harness = ({ initial }: { initial: WorkflowDraft }) => {
  const [draft, setDraft] = useState(initial);
  return (
    <>
      <WorkflowParamsForm draft={draft} onChange={(updater) => setDraft(updater)} t={t} />
      <output data-testid="draft">{JSON.stringify(draft)}</output>
    </>
  );
};

const currentDraft = (): WorkflowDraft => JSON.parse(screen.getByTestId('draft').textContent ?? '{}') as WorkflowDraft;

describe('WorkflowParamsForm', () => {
  it('edits identity and moves between manual and scheduled defaults', async () => {
    const user = userEvent.setup();
    render(<Harness initial={emptyDraft()} />);

    await user.type(screen.getByRole('textbox', { name: copy.name }), 'Daily brief');
    await user.type(screen.getByRole('textbox', { name: copy.description }), 'Summarize activity');
    expect(currentDraft()).toMatchObject({ name: 'Daily brief', description: 'Summarize activity', trigger: { type: 'manual' } });

    await choose(user, copy.triggerSection, copy.triggerScheduled);
    expect(currentDraft().trigger).toEqual({
      type: 'scheduled',
      frequency: { type: 'daily', timeOfDay: '09:00' },
      missedRunPolicy: 'within_window',
      missedRunWindowMinutes: 360,
    });
    expect(screen.getByLabelText(automations.timeOfDay)).toHaveValue('09:00');
    expect(screen.getByRole('combobox', { name: automations.missedRunWindow })).toBeVisible();

    await choose(user, automations.missedRunPolicy, automations.missedRunPolicies.always);
    expect(currentDraft().trigger).toMatchObject({ missedRunPolicy: 'always' });
    expect(screen.queryByRole('combobox', { name: automations.missedRunWindow })).not.toBeInTheDocument();
    expect(screen.getByText(automations.missedRunHelper.always)).toBeVisible();

    await choose(user, copy.triggerSection, copy.triggerManual);
    expect(currentDraft().trigger).toEqual({ type: 'manual' });
    expect(screen.queryByRole('combobox', { name: automations.frequency })).not.toBeInTheDocument();
  });

  it('changes hourly, daily, and weekly schedules with safe defaults and window choices', async () => {
    const user = userEvent.setup();
    render(
      <Harness
        initial={{
          ...emptyDraft(),
          trigger: { type: 'scheduled', frequency: { type: 'daily', timeOfDay: undefined }, missedRunPolicy: 'within_window' },
        }}
      />,
    );

    expect(screen.getByLabelText(automations.timeOfDay)).toHaveValue('09:00');
    expect(screen.getByRole('combobox', { name: automations.missedRunWindow })).toHaveTextContent(automations.missedRunWindowLabels.hours(6));

    await choose(user, automations.frequency, automations.frequencyLabels.hourly);
    expect(currentDraft().trigger).toMatchObject({
      frequency: { type: 'hourly' },
      missedRunWindowMinutes: 30,
    });
    expect(screen.queryByLabelText(automations.timeOfDay)).not.toBeInTheDocument();
    await choose(user, automations.missedRunWindow, automations.missedRunWindowLabels.hours(1));
    expect(currentDraft().trigger).toMatchObject({ missedRunWindowMinutes: 60 });

    await choose(user, automations.frequency, automations.frequencyLabels.daily);
    expect(currentDraft().trigger).toMatchObject({
      frequency: { type: 'daily', timeOfDay: '09:00' },
      missedRunWindowMinutes: 360,
    });
    await user.clear(screen.getByLabelText(automations.timeOfDay));
    await user.type(screen.getByLabelText(automations.timeOfDay), '18:30');
    expect(currentDraft().trigger).toMatchObject({ frequency: { type: 'daily', timeOfDay: '18:30' } });

    await choose(user, automations.frequency, automations.frequencyLabels.weekly);
    expect(currentDraft().trigger).toMatchObject({
      frequency: { type: 'weekly', timeOfDay: '18:30', weeklyDay: 1 },
      missedRunWindowMinutes: 1440,
    });
    await choose(user, automations.weeklyDay, automations.weekdays[5]);
    expect(currentDraft().trigger).toMatchObject({ frequency: { weeklyDay: 5 } });
    expect(screen.getByRole('combobox', { name: automations.missedRunWindow })).toHaveTextContent(automations.missedRunWindowLabels.days(1));
  });

  it('renders interval-compatible windows and each non-window missed-run policy', async () => {
    const user = userEvent.setup();
    const initial: WorkflowDraft = {
      ...emptyDraft(),
      trigger: {
        type: 'scheduled',
        frequency: { type: 'interval', intervalMinutes: 15 },
        missedRunPolicy: 'skip',
        missedRunWindowMinutes: 15,
      },
    };
    render(<Harness initial={initial} />);
    expect(screen.getByText(automations.missedRunHelper.skip)).toBeVisible();
    expect(screen.queryByRole('combobox', { name: automations.missedRunWindow })).not.toBeInTheDocument();

    await choose(user, automations.missedRunPolicy, automations.missedRunPolicies.always);
    expect(screen.getByText(automations.missedRunHelper.always)).toBeVisible();

    await choose(user, automations.missedRunPolicy, automations.missedRunPolicies.within_window);
    expect(screen.getByRole('combobox', { name: automations.missedRunWindow })).toBeVisible();
  });

  it('preserves existing weekly timing metadata when changing frequency', async () => {
    const user = userEvent.setup();
    const view = render(
      <Harness
        initial={{
          ...emptyDraft(),
          trigger: {
            type: 'scheduled',
            frequency: { type: 'daily', timeOfDay: '12:00', weeklyDay: 3 },
            missedRunPolicy: 'within_window',
          },
        }}
      />,
    );
    await choose(user, automations.frequency, automations.frequencyLabels.weekly);
    expect(currentDraft()).toMatchObject({ trigger: { frequency: { type: 'weekly', timeOfDay: '12:00', weeklyDay: 3 } } });

    view.unmount();
    render(
      <Harness
        initial={{
          ...emptyDraft(),
          trigger: {
            type: 'scheduled',
            frequency: { type: 'hourly' },
            missedRunPolicy: 'within_window',
          },
        }}
      />,
    );
    await choose(user, automations.frequency, automations.frequencyLabels.weekly);
    expect(currentDraft()).toMatchObject({ trigger: { frequency: { type: 'weekly', timeOfDay: '09:00', weeklyDay: 1 } } });
  });

  it('keeps stale scheduled-field updates safe after an external switch to manual', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const scheduled: WorkflowDraft = {
      ...emptyDraft(),
      trigger: {
        type: 'scheduled',
        frequency: { type: 'weekly', timeOfDay: '09:00', weeklyDay: undefined },
        missedRunPolicy: 'within_window',
        missedRunWindowMinutes: 1440,
      },
    };
    render(<WorkflowParamsForm draft={scheduled} onChange={onChange} t={t} />);
    const manual = emptyDraft();

    await choose(user, automations.frequency, automations.frequencyLabels.daily);
    expect(onChange.mock.lastCall?.[0](manual)).toBe(manual);
    await user.clear(screen.getByLabelText(automations.timeOfDay));
    await user.type(screen.getByLabelText(automations.timeOfDay), '10:00');
    expect(onChange.mock.lastCall?.[0](manual)).toBe(manual);
    await choose(user, automations.weeklyDay, automations.weekdays[2]);
    expect(onChange.mock.lastCall?.[0](manual)).toBe(manual);
    await choose(user, automations.missedRunPolicy, automations.missedRunPolicies.skip);
    expect(onChange.mock.lastCall?.[0](manual)).toBe(manual);
    await choose(user, automations.missedRunWindow, automations.missedRunWindowLabels.hours(6));
    expect(onChange.mock.lastCall?.[0](manual)).toBe(manual);
  });
});
