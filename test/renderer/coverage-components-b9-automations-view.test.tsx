import { createTheme, ThemeProvider } from '@mui/material/styles';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { AutomationsView } from '@renderer/views/AutomationsView';
import { en } from '@renderer/i18n/en';
import type { AppDictionary } from '@renderer/i18n';
import type { RuntimeProviderControl, RuntimeProviderControls } from '@renderer/runtime-provider-controls';
import type { AgentEffort, AppSummary, Automation, AutomationRun, AutomationRunSummary } from '@shared/types';

vi.mock('@renderer/components/ExternalMarkdownLink', () => ({
  ExternalMarkdownLink: ({ href, children }: { href?: string; children: React.ReactNode }) => (
    <a href={href} data-testid="external-markdown-link">{children}</a>
  ),
}));

const t = en as unknown as AppDictionary;

const control = (
  prefix: string,
  overrides: Partial<RuntimeProviderControl> = {},
): RuntimeProviderControl => ({
  modelOptions: [
    { displayModelName: `${prefix} One`, realModelName: `${prefix}-one`, defaultEffort: 'high' },
    { displayModelName: `${prefix} Two`, realModelName: `${prefix}-two`, defaultEffort: 'low' },
  ],
  selectedModel: `${prefix}-one`,
  onSelectModel: vi.fn(),
  effortOptions: [{ label: 'Low', value: 'low' }, { label: 'High', value: 'high' }],
  selectedEffort: 'high',
  onSelectEffort: vi.fn(),
  effortOptionsForModel: vi.fn(() => [{ label: 'Low', value: 'low' }, { label: 'High', value: 'high' }]),
  normalizeEffortForModel: vi.fn((_model: string, effort: AgentEffort) => effort === 'high' ? 'high' : 'low'),
  ...overrides,
});

const runtimeProviderControls = (overrides: Partial<RuntimeProviderControls> = {}): RuntimeProviderControls => ({
  codex: control('codex'),
  claude: control('claude'),
  antigravity: control('antigravity'),
  ...overrides,
});

const apps: AppSummary[] = [
  { id: 'planner', category: 'productivity', status: 'installed', name: 'Planner' },
  { id: 'notes', category: 'productivity', status: 'running', name: 'Notes' },
];

const runSummary = (
  id: string,
  status: AutomationRunSummary['status'],
  overrides: Partial<AutomationRunSummary> = {},
): AutomationRunSummary => ({
  id,
  automationId: 'hourly',
  trigger: 'scheduled',
  status,
  startedAt: '2026-08-10T09:00:00.000Z',
  finishedAt: '2026-08-10T09:05:00.000Z',
  ...overrides,
});

const automation = (
  id: string,
  overrides: Partial<Automation> = {},
): Automation => ({
  id,
  name: `Automation ${id}`,
  prompt: `Do ${id}`,
  frequency: { type: 'hourly' },
  missedRunPolicy: 'within_window',
  missedRunWindowMinutes: 30,
  selectedAppIds: [],
  enabled: true,
  running: false,
  nextRunAt: '2026-08-10T10:00:00.000Z',
  createdAt: '2026-08-10T08:00:00.000Z',
  updatedAt: '2026-08-10T08:00:00.000Z',
  ...overrides,
});

const providerOptions = [
  { label: 'Automatic', value: 'auto' as const },
  { label: 'Codex account', value: 'codex' as const },
  { label: 'Claude account', value: 'claude' as const },
];

const renderAutomations = ({
  automations = [] as Automation[],
  selectedAutomationId = null as string | null,
  runs = [] as AutomationRunSummary[],
  selectedRun = null as AutomationRun | null,
  busy = false,
  installedApps = apps,
  providers = providerOptions,
  controls = runtimeProviderControls(),
  mode = 'light' as 'light' | 'dark',
} = {}) => {
  const handlers = {
    onSave: vi.fn(),
    onDelete: vi.fn(),
    onPause: vi.fn(),
    onResume: vi.fn(),
    onRunNow: vi.fn(),
    onSelectAutomation: vi.fn(),
    onSelectRun: vi.fn(),
  };
  let current = { automations, selectedAutomationId, runs, selectedRun, busy };
  const node = () => (
    <ThemeProvider theme={createTheme({ palette: { mode } })}>
      <AutomationsView
        t={t}
        apps={installedApps}
        automations={current.automations}
        selectedAutomationId={current.selectedAutomationId}
        runs={current.runs}
        selectedRun={current.selectedRun}
        busy={current.busy}
        providerOptions={providers}
        runtimeProviderControls={controls}
        getAppMeta={(id) => ({ name: installedApps.find((app) => app.id === id)?.name ?? `Unknown ${id}`, description: '' })}
        {...handlers}
      />
    </ThemeProvider>
  );
  const view = render(node());
  return {
    ...view,
    ...handlers,
    update: (next: Partial<typeof current>) => {
      current = { ...current, ...next };
      view.rerender(node());
    },
  };
};

const choose = async (user: ReturnType<typeof userEvent.setup>, label: string, option: string) => {
  await user.click(screen.getByRole('combobox', { name: label }));
  await user.click(screen.getByRole('option', { name: option }));
};

const cardFor = (name: string) => screen.getByText(name).closest('.MuiCard-root') as HTMLElement;

describe('AutomationsView list and run history', () => {
  it('renders the empty and unselected states, opens a blank editor without apps, and closes it by action and Escape', async () => {
    const user = userEvent.setup();
    const view = renderAutomations({ installedApps: [] });

    expect(screen.getByText(t.sections.automations.empty)).toBeInTheDocument();
    expect(screen.getByText(t.sections.automations.selectAutomation)).toBeInTheDocument();
    expect(screen.getByText(t.sections.automations.noOutput)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: t.sections.automations.viewFullLog })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: t.sections.automations.newAutomation }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(t.sections.automations.noInstalledApps)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: t.sections.automations.create })).toBeDisabled();
    await user.click(within(dialog).getByRole('button', { name: t.actions.close }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: t.sections.automations.newAutomation }));
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(view.onSave).not.toHaveBeenCalled();
  });

  it('auto-selects the first automation and exposes frequency, provider, permission, date, app, and action variants', async () => {
    const user = userEvent.setup();
    const entries = [
      automation('interval', {
        frequency: { type: 'interval' },
        running: true,
        runtime: { provider: 'codex', model: 'codex-one', effort: 'high', permissionMode: 'unsafe' },
        lastRun: runSummary('last-running', 'running', { finishedAt: undefined }),
        selectedAppIds: ['planner', 'missing'],
      }),
      automation('daily', {
        frequency: { type: 'daily' },
        runtime: { provider: 'antigravity', model: 'agy-one', effort: 'low', permissionMode: 'safe' },
        lastRun: runSummary('last-daily', 'succeeded'),
        nextRunAt: 'invalid',
      }),
      automation('weekly', { frequency: { type: 'weekly', weeklyDay: 99 }, enabled: false, nextRunAt: null }),
      automation('hourly', { enabled: true }),
    ];
    const view = renderAutomations({ automations: entries, providers: providerOptions });
    await waitFor(() => expect(view.onSelectAutomation).toHaveBeenCalledWith('interval'));

    expect(screen.getByText(t.sections.automations.frequencySummaries.interval(15))).toBeInTheDocument();
    expect(screen.getByText(t.sections.automations.frequencySummaries.daily('09:00'))).toBeInTheDocument();
    expect(screen.getByText(t.sections.automations.frequencySummaries.weekly(t.sections.automations.weekdays[1], '09:00'))).toBeInTheDocument();
    expect(screen.getByText(t.sections.automations.frequencyLabels.hourly)).toBeInTheDocument();
    expect(screen.getByText('Codex account')).toBeInTheDocument();
    expect(screen.getByText('antigravity')).toBeInTheDocument();
    expect(screen.getAllByText(t.sections.automations.autoProvider)).toHaveLength(2);
    expect(screen.getByText('Planner, Unknown missing')).toBeInTheDocument();
    expect(screen.getAllByText(t.sections.automations.noAppsSelected)).toHaveLength(3);
    expect(screen.getAllByText(`${t.sections.automations.nextRun}: -`)).toHaveLength(2);

    await user.click(screen.getByText('Automation daily'));
    expect(view.onSelectAutomation).toHaveBeenCalledWith('daily');
    const daily = within(cardFor('Automation daily'));
    await user.click(daily.getByRole('button', { name: t.sections.automations.testRun }));
    await user.click(daily.getByRole('button', { name: t.sections.automations.pause }));
    await user.click(daily.getByRole('button', { name: t.sections.automations.delete }));
    expect(view.onRunNow).toHaveBeenCalledWith('daily');
    expect(view.onPause).toHaveBeenCalledWith('daily');
    expect(view.onDelete).toHaveBeenCalledWith('daily');
    const weekly = within(cardFor('Automation weekly'));
    await user.click(weekly.getByRole('button', { name: t.sections.automations.resume }));
    expect(view.onResume).toHaveBeenCalledWith('weekly');
    expect(within(cardFor('Automation interval')).getByRole('button', { name: t.sections.automations.testRun })).toBeDisabled();
  });

  it('disables run and pause while busy but leaves inspectable edit state', () => {
    const entry = automation('busy');
    renderAutomations({ automations: [entry], selectedAutomationId: entry.id, busy: true });
    const card = within(cardFor('Automation busy'));
    expect(card.getByRole('button', { name: t.sections.automations.testRun })).toBeDisabled();
    expect(card.getByRole('button', { name: t.sections.automations.pause })).toBeDisabled();
    expect(card.getByRole('button', { name: t.sections.automations.edit })).toBeEnabled();
  });

  it('renders every run status and trigger, selects history, and shows Markdown summaries and full records', async () => {
    const user = userEvent.setup();
    const entry = automation('hourly');
    const runs = [
      runSummary('queued', 'queued', { trigger: 'manual', finishedAt: undefined }),
      runSummary('running', 'running'),
      runSummary('ok', 'succeeded'),
      runSummary('failed', 'failed'),
      runSummary('skipped', 'skipped'),
    ];
    const selectedRun: AutomationRun = {
      ...runs[2],
      userMessage: '  **Done** [details](https://example.test)  ',
      userMessages: ['First message', 'Second `code` message'],
      transcript: 'raw',
    };
    const view = renderAutomations({
      automations: [entry],
      selectedAutomationId: entry.id,
      runs,
      selectedRun,
      mode: 'dark',
    });

    for (const status of ['queued', 'running', 'succeeded', 'failed', 'skipped'] as const) {
      expect(screen.getByText(t.sections.automations.runStatuses[status])).toBeInTheDocument();
    }
    expect(screen.getByText(t.sections.automations.manual)).toBeInTheDocument();
    expect(screen.getAllByText(t.sections.automations.scheduled)).toHaveLength(4);
    await user.click(screen.getByRole('button', { name: /Queued/ }));
    expect(view.onSelectRun).toHaveBeenCalledWith('queued');
    expect(screen.getByText('Done')).toBeInTheDocument();
    expect(screen.getByTestId('external-markdown-link')).toHaveAttribute('href', 'https://example.test');

    await user.click(screen.getByRole('button', { name: t.sections.automations.viewFullLog }));
    expect(screen.getByRole('dialog')).toHaveTextContent('First message');
    expect(screen.getByRole('dialog')).toHaveTextContent('Second code message');
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: t.actions.close }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: t.sections.automations.viewFullLog }));
    view.update({ selectedRun: null });
    expect(screen.getByText(t.sections.automations.noLogMessages)).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('uses failed output, run-output fallback messages, and empty Markdown log entries', async () => {
    const user = userEvent.setup();
    const entry = automation('errors');
    const failed: AutomationRun = {
      ...runSummary('failed-run', 'failed', { error: 'Agent failed', userMessage: '   ', userMessages: [] }),
      transcript: '',
    };
    const view = renderAutomations({ automations: [entry], selectedAutomationId: entry.id, runs: [failed], selectedRun: failed });
    expect(screen.getByText('Agent failed')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: t.sections.automations.viewFullLog }));
    expect(screen.getByRole('dialog')).toHaveTextContent('Agent failed');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    const emptyMessage: AutomationRun = { ...failed, id: 'empty-message', status: 'succeeded', error: undefined, userMessages: [''] };
    view.update({ runs: [emptyMessage], selectedRun: emptyMessage });
    await user.click(screen.getByRole('button', { name: t.sections.automations.viewFullLog }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    view.update({ selectedRun: { ...emptyMessage, id: undefined as unknown as string, userMessages: ['Orphan log'] } });
    expect(screen.getByRole('dialog')).toHaveTextContent('Orphan log');
  });
});

describe('AutomationsView editor', () => {
  it('creates an inactive interval automation, clamps invalid/high/low values, and selects and clears all apps', async () => {
    const user = userEvent.setup();
    const view = renderAutomations();
    await user.click(screen.getByRole('button', { name: t.sections.automations.newAutomation }));
    const dialog = screen.getByRole('dialog');
    await user.type(within(dialog).getByRole('textbox', { name: t.sections.automations.name }), 'Interval task');
    await user.type(within(dialog).getByRole('textbox', { name: t.sections.automations.instruction }), 'Run often');

    await choose(user, t.sections.automations.frequency, t.sections.automations.frequencyLabels.interval);
    const interval = screen.getByRole('spinbutton', { name: t.sections.automations.intervalMinutes });
    fireEvent.change(interval, { target: { value: '2000' } });
    fireEvent.blur(interval);
    expect(interval).toHaveValue(1440);
    fireEvent.change(interval, { target: { value: '1e309' } });
    fireEvent.blur(interval);
    expect(interval).toHaveValue(15);
    fireEvent.change(interval, { target: { value: '0.6' } });
    fireEvent.blur(interval);
    expect(interval).toHaveValue(1);

    await user.click(screen.getByRole('button', { name: t.sections.automations.selectAllApps }));
    expect(screen.getByRole('checkbox', { name: 'Planner' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Notes' })).toBeChecked();
    await user.click(screen.getByRole('button', { name: t.sections.automations.clearApps }));
    await user.click(screen.getByRole('checkbox', { name: 'Planner' }));
    await user.click(screen.getByRole('checkbox', { name: 'Planner' }));

    await user.click(screen.getByRole('button', { name: t.sections.automations.create }));
    expect(view.onSave).toHaveBeenCalledWith(expect.objectContaining({
      name: 'Interval task',
      prompt: 'Run often',
      frequency: { type: 'interval', intervalMinutes: 1 },
      runtime: undefined,
      missedRunPolicy: 'within_window',
      missedRunWindowMinutes: undefined,
      selectedAppIds: [],
      enabled: false,
    }));
  });

  it('creates and activates daily and weekly schedules with every missed-run policy and runtime field', async () => {
    const user = userEvent.setup();
    const controls = runtimeProviderControls({
      antigravity: control('antigravity', { modelOptions: [] }),
    });
    const view = renderAutomations({
      controls,
      providers: [...providerOptions, { label: 'Antigravity account', value: 'antigravity' }],
    });
    await user.click(screen.getByRole('button', { name: t.sections.automations.newAutomation }));
    await user.type(screen.getByRole('textbox', { name: t.sections.automations.name }), 'Scheduled task');
    await user.type(screen.getByRole('textbox', { name: t.sections.automations.instruction }), 'Run daily');

    await choose(user, t.sections.automations.frequency, t.sections.automations.frequencyLabels.daily);
    fireEvent.change(screen.getByLabelText(t.sections.automations.timeOfDay), { target: { value: '14:30' } });
    await choose(user, t.sections.automations.missedRunPolicy, t.sections.automations.missedRunPolicies.skip);
    expect(screen.getByText(t.sections.automations.missedRunHelper.skip)).toBeInTheDocument();
    await choose(user, t.sections.automations.missedRunPolicy, t.sections.automations.missedRunPolicies.always);
    expect(screen.getByText(t.sections.automations.missedRunHelper.always)).toBeInTheDocument();
    await choose(user, t.sections.automations.missedRunPolicy, t.sections.automations.missedRunPolicies.within_window);
    await choose(user, t.sections.automations.missedRunWindow, t.sections.automations.missedRunWindowLabels.hours(12));

    await choose(user, t.sections.automations.frequency, t.sections.automations.frequencyLabels.weekly);
    await choose(user, t.sections.automations.weeklyDay, t.sections.automations.weekdays[5]);
    await choose(user, t.sections.automations.missedRunWindow, t.sections.automations.missedRunWindowLabels.days(2));
    await choose(user, t.sections.automations.provider, 'Antigravity account');
    await choose(user, t.sections.automations.provider, 'Claude account');
    await choose(user, t.sections.automations.model, 'claude Two');
    await choose(user, t.sections.automations.effort, 'High');
    await choose(user, t.sections.automations.permissionMode, t.sections.automations.permissionUnsafe);
    expect(screen.getByText(t.sections.automations.permissionUnsafeHelper)).toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: 'Notes' }));

    await user.click(screen.getByRole('button', { name: t.sections.automations.createAndActivate }));
    expect(view.onSave).toHaveBeenCalledWith(expect.objectContaining({
      frequency: { type: 'weekly', timeOfDay: '14:30', weeklyDay: 5 },
      runtime: { provider: 'claude', model: 'claude-two', effort: 'high', permissionMode: 'unsafe' },
      missedRunPolicy: 'within_window',
      missedRunWindowMinutes: 2880,
      selectedAppIds: ['notes'],
      enabled: true,
    }));
  });

  it('builds hourly and daily inputs through the default create action', async () => {
    const user = userEvent.setup();
    const view = renderAutomations();
    await user.click(screen.getByRole('button', { name: t.sections.automations.newAutomation }));
    await user.type(screen.getByRole('textbox', { name: t.sections.automations.name }), 'Hourly task');
    await user.type(screen.getByRole('textbox', { name: t.sections.automations.instruction }), 'Run hourly');
    await user.click(screen.getByRole('button', { name: t.sections.automations.create }));
    expect(view.onSave).toHaveBeenLastCalledWith(expect.objectContaining({ frequency: { type: 'hourly' } }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: t.sections.automations.newAutomation }));
    await user.type(screen.getByRole('textbox', { name: t.sections.automations.name }), 'Daily task');
    await user.type(screen.getByRole('textbox', { name: t.sections.automations.instruction }), 'Run daily');
    await choose(user, t.sections.automations.frequency, t.sections.automations.frequencyLabels.daily);
    await user.click(screen.getByRole('button', { name: t.sections.automations.create }));
    expect(view.onSave).toHaveBeenLastCalledWith(expect.objectContaining({ frequency: { type: 'daily', timeOfDay: '09:00' } }));
  });

  it('edits legacy and defaulted automations, preserves or activates state, and adds an unavailable provider option', async () => {
    const user = userEvent.setup();
    const legacy = automation('legacy', {
      name: 'Legacy task',
      prompt: 'Legacy prompt',
      frequency: { type: 'weekly' },
      runtime: { provider: 'antigravity', model: 'legacy-model', effort: 'medium' },
      missedRunPolicy: undefined as unknown as Automation['missedRunPolicy'],
      missedRunWindowMinutes: undefined,
      selectedAppIds: ['planner'],
      enabled: false,
    });
    const view = renderAutomations({ automations: [legacy], selectedAutomationId: legacy.id, providers: providerOptions });
    await user.click(within(cardFor('Legacy task')).getByRole('button', { name: t.sections.automations.edit }));
    expect(screen.getByRole('dialog')).toHaveTextContent(t.sections.automations.edit);
    expect(screen.getByRole('combobox', { name: t.sections.automations.provider })).toHaveTextContent('antigravity');
    expect(screen.getByRole('checkbox', { name: 'Planner' })).toBeChecked();
    expect(screen.getByText(t.sections.automations.permissionSafeHelper)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: t.sections.automations.save }));
    expect(view.onSave).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'legacy', enabled: false }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    await user.click(within(cardFor('Legacy task')).getByRole('button', { name: t.sections.automations.edit }));
    await user.click(screen.getByRole('button', { name: t.sections.automations.saveAndActivate }));
    expect(view.onSave).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'legacy', enabled: true }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    const defaulted = automation('defaulted', {
      frequency: { type: 'daily' },
      runtime: undefined,
      missedRunWindowMinutes: undefined,
    });
    view.update({ automations: [defaulted], selectedAutomationId: defaulted.id });
    await user.click(within(cardFor('Automation defaulted')).getByRole('button', { name: t.sections.automations.edit }));
    expect(screen.getByRole('combobox', { name: t.sections.automations.provider })).toHaveTextContent(t.sections.automations.autoProvider);
  });

  it('uses model and effort fallbacks when provider configuration is sparse', async () => {
    const user = userEvent.setup();
    const sparseCodex = control('codex', {
      modelOptions: [],
      selectedModel: '',
      selectedEffort: '' as AgentEffort,
      effortOptionsForModel: vi.fn(() => []),
      normalizeEffortForModel: vi.fn((_model, effort) => effort),
    });
    renderAutomations({ controls: runtimeProviderControls({ codex: sparseCodex }) });
    await user.click(screen.getByRole('button', { name: t.sections.automations.newAutomation }));
    expect(screen.getByRole('combobox', { name: t.sections.automations.provider })).toHaveTextContent(t.sections.automations.autoProvider);
    await choose(user, t.sections.automations.provider, 'Codex account');
    await choose(user, t.sections.automations.provider, 'Automatic');
  });
});
