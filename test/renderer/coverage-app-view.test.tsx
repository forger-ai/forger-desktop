import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDetails, AppToolsInstallGate, ForgerAccountSession } from '@shared/types';
import { en } from '@renderer/i18n/en';
import type { AppDictionary } from '@renderer/i18n';
import type { RuntimeProviderControl, RuntimeProviderControls } from '@renderer/runtime-provider-controls';

const childSpies = vi.hoisted(() => ({ actions: vi.fn(), secrets: vi.fn(), preview: vi.fn() }));

vi.mock('@renderer/views/app-view/AppViewActions', () => ({
  AppViewActions: (props: Record<string, unknown>) => {
    childSpies.actions(props);
    return <div data-testid="app-actions">Actions for {String(props.appId)}</div>;
  },
}));

vi.mock('@renderer/components/AppSecretsDialog', () => ({
  AppSecretsPanel: (props: Record<string, any>) => {
    childSpies.secrets(props);
    return (
      <div data-testid="secrets-panel">
        <button onClick={() => props.onConnectSecret('API_KEY', 'secret-1')}>Connect mocked secret</button>
        <button onClick={() => props.onDisconnectSecret('API_KEY')}>Disconnect mocked secret</button>
      </div>
    );
  },
}));

vi.mock('@renderer/views/app-view/PromptPreviewDialog', () => ({
  PromptPreviewDialog: (props: Record<string, any>) => {
    childSpies.preview(props);
    return props.preview ? (
      <div role="dialog" aria-label="Prompt preview">
        <span>{props.preview.title}</span>
        <span>{props.preview.description}</span>
        <span>{props.preview.prompt}</span>
        <button onClick={props.onClose}>Close preview</button>
      </div>
    ) : null;
  },
}));

const t = en as unknown as AppDictionary;

const control = (prefix: string, overrides: Partial<RuntimeProviderControl> = {}): RuntimeProviderControl => ({
  modelOptions: [
    { displayModelName: `${prefix} One`, realModelName: `${prefix}-one`, defaultEffort: 'medium' },
    { displayModelName: `${prefix} Two`, realModelName: `${prefix}-two`, defaultEffort: 'high' },
  ],
  selectedModel: `${prefix}-one`,
  onSelectModel: vi.fn(),
  effortOptions: [{ label: 'Medium', value: 'medium' }, { label: 'High', value: 'high' }],
  selectedEffort: 'medium',
  onSelectEffort: vi.fn(),
  effortOptionsForModel: vi.fn(() => [{ label: 'Medium', value: 'medium' }, { label: 'High', value: 'high' }]),
  normalizeEffortForModel: vi.fn((_model, effort) => effort),
  ...overrides,
});

const runtimeProviderControls = (): RuntimeProviderControls => ({
  codex: control('codex'),
  claude: control('claude'),
  antigravity: control('antigravity'),
});

const account = (authenticated = true, confirmed = true): ForgerAccountSession => authenticated ? ({
  authenticated: true,
  user: {
    id: 1,
    email: 'ana@example.com',
    username: 'ana',
    firstName: 'Ana',
    confirmed,
    subscriptionTier: 'pro',
  },
}) : { authenticated: false };

const promptReview = (kind: 'agentPrompt' | 'agent' | 'promptTemplate', id: string, overrides: Record<string, unknown> = {}) => ({
  appId: 'planner',
  kind,
  id,
  title: `${kind} ${id}`,
  description: `Description ${id}`,
  originalPrompt: `Original ${id}`,
  prompt: `Prompt ${id}`,
  model: 'codex-one',
  reasoningEffort: 'medium',
  runtime: { provider: 'codex', model: 'codex-one', effort: 'medium', permissionMode: 'safe' },
  originalRuntime: { provider: 'codex', model: 'codex-one', effort: 'medium', permissionMode: 'safe' },
  modelSource: 'manifest',
  reasoningEffortSource: 'manifest',
  runtimeSource: 'manifest',
  edited: false,
  overrideInvalid: false,
  validation: { valid: true, errors: [], missingVariables: [], extraVariables: [] },
  ...overrides,
});

const richDetails = (overrides: Partial<AppDetails> = {}, appOverrides: Record<string, unknown> = {}): AppDetails => ({
  app: {
    id: 'planner',
    category: 'productivity',
    status: 'installed',
    name: 'Planning Studio',
    description: 'Plan the day',
    longDescription: 'Plan projects and daily work.',
    iconUrl: 'https://example.com/planner.png',
    averageRating: 4.5,
    ratingsCount: 2,
    currentUserRating: { id: 3, score: 4, comment: 'My prior review' },
    recentRatings: [
      { id: 1, score: 5, comment: 'Excellent', forgerResponse: 'Thank you', user: { firstName: 'Bea', username: 'bea' } },
      { id: 2, score: 3, user: {} },
    ],
    socialUserAppId: 42,
    ...appOverrides,
  },
  installed: true,
  status: 'installed',
  version: '1.0.0',
  latestVersion: '1.1.0',
  updateAvailable: true,
  installedAt: '2026-08-10T10:00:00.000Z',
  changelog: { version: '1.1.0', summary: 'A better release', changes: ['Faster', 'Safer'] },
  operations: [
    { operationId: 'op-1', title: 'Customized', summary: 'Changed colors', createdAt: '2026-08-09T10:00:00.000Z' },
    { operationId: 'op-2', title: 'Old edit', summary: 'Restored', createdAt: '2026-08-08T10:00:00.000Z', revertedAt: '2026-08-09T10:00:00.000Z' },
  ],
  localChanges: [
    { id: 'local-1', title: 'Local change', createdAt: '2026-08-10T09:00:00.000Z' },
    { id: 'local-2', title: 'Undated local change' },
  ],
  promptTemplates: [
    { id: 'daily', title: 'Daily plan', description: 'Prepare today', prompt: 'Plan today' },
    { id: 'weekly', title: 'Weekly plan', prompt: 'Plan week' },
  ],
  agents: [
    { id: 'coach', title: 'Planning coach', description: 'Helps planning', initialPrompt: 'Coach me' },
    { id: 'reviewer', title: 'Plan reviewer', initialPrompt: 'Review this' },
  ],
  promptReviews: [
    promptReview('agentPrompt', 'system', {
      promptKind: 'system',
      sourcePath: 'agents/coach.md',
      declaredVariables: ['name', 'date'],
      edited: true,
      overrideInvalid: true,
      overridePrompt: 'Custom system',
      overrideRuntime: { provider: 'codex', model: 'codex-two', effort: 'high', permissionMode: 'unsafe' },
      runtimeSource: 'override',
      validation: { valid: false, errors: ['Missing date'], missingVariables: ['date'], extraVariables: [] },
    }),
    promptReview('agent', 'coach', { runtimeSource: 'global', description: undefined }),
    promptReview('promptTemplate', 'daily'),
  ] as any,
  ...overrides,
});

const toolGate = (): AppToolsInstallGate => ({
  appId: 'planner',
  appName: 'Planning Studio',
  platformCapabilities: {
    network: { required: true, reason: 'Sync calendars' },
    microphone: { required: false },
  } as any,
  required: [
    {
      declaration: { toolId: 'mail', actions: ['*'], reason: 'Read mail' },
      required: true,
      resolvedActions: [],
      allActions: true,
      granted: true,
      hasStoredGrant: true,
      available: true,
      configured: true,
      tool: { id: 'mail', name: 'Mail', actions: [] },
    } as any,
    {
      declaration: { toolId: 'missing', actions: ['read'], reason: 'Missing required tool' },
      required: true,
      resolvedActions: [{ id: 'read', name: 'Read' }],
      allActions: false,
      granted: true,
      hasStoredGrant: true,
      available: false,
      configured: false,
    } as any,
  ],
  optional: [
    {
      declaration: { toolId: 'calendar', actions: ['events'], reason: 'Optional calendar' },
      required: false,
      resolvedActions: [{ id: 'events', name: 'Events' }],
      allActions: false,
      granted: true,
      hasStoredGrant: true,
      available: true,
      configured: false,
      tool: { id: 'calendar', name: 'Calendar', actions: [] },
    } as any,
    {
      declaration: { toolId: 'notes', actions: [], reason: 'Optional notes' },
      required: false,
      resolvedActions: [],
      allActions: false,
      granted: false,
      hasStoredGrant: false,
      available: true,
      configured: true,
      tool: { id: 'notes', name: 'Notes', actions: [] },
    } as any,
  ],
  connectionRequired: [
    {
      declaration: { type: 'gmail', actions: ['*'], reason: 'Required inbox' }, required: true,
      definition: { type: 'gmail', displayName: 'Gmail' }, resolvedActions: [], allActions: true,
      granted: true, hasStoredGrant: true, configured: false, instances: [],
    } as any,
  ],
  connectionOptional: [
    {
      declaration: { type: 'slack', actions: ['send'], reason: 'Optional Slack' }, required: false,
      definition: { type: 'slack', displayName: 'Slack' }, resolvedActions: [{ id: 'send', name: 'Send' }], allActions: false,
      granted: true, hasStoredGrant: true, configured: true, instances: [{}],
    } as any,
    {
      declaration: { type: 'removed', actions: [], reason: 'Unavailable service' }, required: false,
      resolvedActions: [], allActions: false, granted: false, hasStoredGrant: false, configured: false, instances: [],
    } as any,
    {
      declaration: { type: 'calendar', actions: [], reason: 'Granted calendar' }, required: false,
      definition: { type: 'calendar', displayName: 'Calendar connection' }, resolvedActions: [], allActions: false,
      granted: true, hasStoredGrant: true, configured: false, instances: [],
    } as any,
  ],
  agents: [],
  promptTemplates: [],
  canInstall: false,
});

const handlers = () => ({
  onBack: vi.fn(), onInstall: vi.fn(), onUpdate: vi.fn(), onOpen: vi.fn(), onStop: vi.fn(),
  onRestoreUserVersion: vi.fn(), onResolveConflict: vi.fn(), onStartLocalNetworkShare: vi.fn(),
  onStartRemoteNetworkShare: vi.fn(), onStopRemoteNetworkShare: vi.fn(), onUploadSocial: vi.fn(),
  onRenameApp: vi.fn(), onConnectSecret: vi.fn().mockResolvedValue(undefined),
  onDisconnectSecret: vi.fn().mockResolvedValue(undefined), onDelete: vi.fn(), onOpenAccount: vi.fn(),
  onSetAppToolGrant: vi.fn(), onSetAppConnectionGrant: vi.fn(), onOpenTools: vi.fn(),
  onOpenConnections: vi.fn(), onOpenProfile: vi.fn(), onSubmitRating: vi.fn().mockResolvedValue({ success: true }),
  onUpdatePrompt: vi.fn().mockResolvedValue({ success: true }), onRestorePrompt: vi.fn().mockResolvedValue({ success: true }),
});

type RenderOptions = {
  details?: AppDetails | null;
  gate?: AppToolsInstallGate | null;
  session?: ForgerAccountSession;
  developer?: boolean;
  busyGrant?: string | null;
  installProgress?: any;
  includeProfile?: boolean;
  controls?: RuntimeProviderControls;
  opening?: Set<string>;
};

const renderApp = async ({
  details = richDetails(), gate = toolGate(), session = account(), developer = true,
  busyGrant = null, installProgress, includeProfile = true, controls = runtimeProviderControls(), opening = new Set<string>(),
}: RenderOptions = {}) => {
  const callbacks = handlers();
  const props = {
    details,
    openingAppIds: opening,
    installProgress,
    appToolsInstallGate: gate,
    appToolGrantBusyId: busyGrant,
    t,
    categoryLabel: 'Productivity',
    appSecretsState: { requirements: [], userSecrets: [] } as any,
    secretsBusy: false,
    account: session,
    providerOptions: [
      { label: 'Automatic', value: 'auto' as const },
      { label: 'Codex', value: 'codex' as const },
      { label: 'Claude', value: 'claude' as const },
    ],
    runtimeProviderControls: controls,
    codexDefaults: { model: 'codex-one', reasoningEffort: 'medium' as const },
    developerMode: { enabled: developer, pathEntries: [] },
    ...callbacks,
    ...(includeProfile ? {} : { onOpenProfile: undefined }),
  };
  const { AppView } = await import('@renderer/views/AppView');
  const view = render(<AppView {...props} />);
  return { ...view, ...callbacks, props };
};

const chooseTab = async (name: string) => {
  await userEvent.click(screen.getByRole('tab', { name }));
};

beforeEach(() => {
  childSpies.actions.mockClear();
  childSpies.secrets.mockClear();
  childSpies.preview.mockClear();
  Object.defineProperty(window, 'forger', {
    configurable: true,
    value: {
      validateAppPrompt: vi.fn().mockResolvedValue({ valid: true, errors: [], missingVariables: [], extraVariables: [] }),
      getDeveloperPathState: vi.fn().mockResolvedValue({
        enabled: true,
        globalPathEntries: ['/global/bin'], appPathEntries: ['/app/bin'], runtimePathEntries: ['/runtime/bin'],
        systemPathEntries: ['/usr/bin'], effectivePathEntries: ['/runtime/bin', '/app/bin', '/usr/bin'],
      }),
      updateAppDeveloperSettings: vi.fn().mockResolvedValue({
        enabled: true,
        globalPathEntries: [], appPathEntries: ['/saved/bin'], runtimePathEntries: [], systemPathEntries: [], effectivePathEntries: ['/saved/bin'],
      }),
    },
  });
});

describe('AppView overview and grants', () => {
  it('shows the missing state and returns to the catalog', async () => {
    const view = await renderApp({ details: null, gate: null, developer: false });
    expect(screen.getByText(t.appView.notFound)).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: t.actions.back }));
    expect(view.onBack).toHaveBeenCalledOnce();
  });

  it('renders installed metadata, capabilities, tools and connections and changes optional grants', async () => {
    const view = await renderApp({ busyGrant: 'calendar' });
    expect(screen.getByRole('heading', { name: 'Planning Studio' })).toBeVisible();
    expect(screen.getByTestId('app-actions')).toHaveTextContent('planner');
    expect(screen.getByText('Sync calendars')).toBeVisible();
    expect(screen.getByText('Mail')).toBeVisible();
    expect(screen.getByText('missing')).toBeVisible();
    expect(screen.getByText('Gmail')).toBeVisible();
    expect(screen.getByText('Unavailable service')).toBeVisible();
    const switches = screen.getAllByRole('switch', { name: t.appView.toolGrantOptional });
    expect(switches[0]).toBeDisabled();
    await userEvent.click(switches[1]!);
    await userEvent.click(switches[2]!);
    await userEvent.click(switches[3]!);
    await userEvent.click(switches[4]!);
    expect(view.onSetAppToolGrant).toHaveBeenCalledWith('notes', true);
    expect(view.onSetAppConnectionGrant).toHaveBeenCalledWith('slack', false);
    expect(view.onSetAppConnectionGrant).toHaveBeenCalledWith('removed', true);
    expect(view.onSetAppConnectionGrant).toHaveBeenCalledWith('calendar', false);
    await userEvent.click(screen.getByRole('button', { name: t.appView.openTools }));
    await userEvent.click(screen.getByRole('button', { name: t.appView.openConnections }));
    expect(view.onOpenTools).toHaveBeenCalledOnce();
    expect(view.onOpenConnections).toHaveBeenCalledOnce();
  });

  it('represents every app status, catalog fallback and bounded install progress', async () => {
    const variants: Array<[AppDetails, string]> = [
      [richDetails({ status: 'running' }, { status: 'running', updateAvailable: false }), t.actions.running],
      [richDetails({ status: 'conflict' }, { status: 'conflict', updateAvailable: false }), t.actions.conflict],
      [richDetails({ status: 'error' }, { status: 'error', updateAvailable: false }), t.actions.error],
      [richDetails({ updateAvailable: false }, { updateAvailable: false }), t.actions.installed],
      [richDetails({ version: undefined, updateAvailable: false }, { updateAvailable: false }), t.actions.installed],
      [{ app: { id: 'plain', category: 'utilities', status: 'not_installed' }, installed: false, status: 'not_installed', operations: [] }, t.actions.available],
    ];
    for (const [details, label] of variants) {
      const view = await renderApp({ details, gate: null, developer: false });
      expect(screen.getAllByText(label).length).toBeGreaterThan(0);
      view.unmount();
    }

    const emptyName = await renderApp({
      details: richDetails({ status: 'installing', installed: false, version: undefined, latestVersion: undefined, installedAt: undefined }, {
        status: 'installing', name: '', iconUrl: undefined, longDescription: undefined, averageRating: undefined,
        ratingsCount: undefined, recentRatings: undefined, updateAvailable: false,
      }),
      gate: null,
      developer: false,
      installProgress: { progress: 150, userMessage: 'Almost installed' },
      opening: new Set(['planner']),
    });
    expect(screen.getByText('Almost installed')).toBeVisible();
    emptyName.unmount();

    const indeterminate = await renderApp({
      details: richDetails({ status: 'installed' }), gate: null, developer: false,
      installProgress: { userMessage: 'Preparing' },
    });
    expect(screen.getByText('Preparing')).toBeVisible();
    indeterminate.unmount();

    const lowProgress = await renderApp({
      details: richDetails({ status: 'installing' }), gate: null, developer: false,
      installProgress: { progress: -25, userMessage: 'Starting' },
    });
    expect(screen.getByText('Starting')).toBeVisible();
    lowProgress.unmount();

    const missingOptionalConnections = await renderApp({
      details: richDetails(),
      gate: {
        ...toolGate(),
        connectionOptional: undefined,
      } as any,
      developer: false,
    });
    missingOptionalConnections.unmount();
    await renderApp({
      details: richDetails(),
      gate: {
        ...toolGate(),
        connectionRequired: undefined,
      } as any,
      developer: false,
    });
  });

  it('opens prompt and agent previews with pointer and keyboard and closes them', async () => {
    await renderApp();
    await userEvent.click(screen.getByRole('button', { name: /Daily plan/ }));
    expect(screen.getByRole('dialog', { name: 'Prompt preview' })).toHaveTextContent('Plan today');
    await userEvent.click(screen.getByRole('button', { name: 'Close preview' }));
    fireEvent.keyDown(screen.getByRole('button', { name: /Weekly plan/ }), { key: 'Enter' });
    expect(screen.getByRole('dialog', { name: 'Prompt preview' })).toHaveTextContent('Plan week');
    await userEvent.click(screen.getByRole('button', { name: 'Close preview' }));
    fireEvent.keyDown(screen.getByRole('button', { name: /Weekly plan/ }), { key: 'Escape' });
    fireEvent.keyDown(screen.getByRole('button', { name: /Planning coach/ }), { key: ' ' });
    expect(screen.getByRole('dialog', { name: 'Prompt preview' })).toHaveTextContent('Coach me');
    await userEvent.click(screen.getByRole('button', { name: 'Close preview' }));
    await userEvent.click(screen.getByRole('button', { name: /Plan reviewer/ }));
    expect(screen.getByRole('dialog', { name: 'Prompt preview' })).toHaveTextContent('Review this');
    await userEvent.click(screen.getByRole('button', { name: 'Close preview' }));
    fireEvent.keyDown(screen.getByRole('button', { name: /Plan reviewer/ }), { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Prompt preview' })).not.toBeInTheDocument();
  });
});

describe('AppView prompts', () => {
  it('selects prompt kinds by pointer and keyboard, validates changes, saves runtime overrides and restores', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const view = await renderApp();
    await chooseTab(t.appView.tabs.prompts);
    expect(screen.getByText('Missing date')).toBeVisible();
    await act(async () => { vi.advanceTimersByTime(250); });
    const promptInput = screen.getByLabelText(t.appView.promptEditorLabel);
    fireEvent.change(promptInput, { target: { value: 'Updated prompt' } });
    await act(async () => { vi.advanceTimersByTime(250); });
    expect(window.forger.validateAppPrompt).toHaveBeenLastCalledWith(expect.objectContaining({ prompt: 'Updated prompt' }));

    fireEvent.mouseDown(screen.getByLabelText(t.appView.promptProviderLabel));
    await userEvent.click(screen.getByRole('option', { name: 'Claude' }));
    fireEvent.mouseDown(screen.getByLabelText(t.appView.promptModelLabel));
    await userEvent.click(screen.getByRole('option', { name: 'claude Two' }));
    fireEvent.mouseDown(screen.getByLabelText(t.appView.promptThinkingLabel));
    await userEvent.click(screen.getByRole('option', { name: 'Medium' }));
    await userEvent.click(screen.getByRole('switch', { name: t.appView.promptPermissionLabel }));
    await userEvent.click(screen.getByRole('switch', { name: t.appView.promptPermissionLabel }));
    await userEvent.click(screen.getByRole('switch', { name: t.appView.promptPermissionLabel }));
    await userEvent.click(screen.getByRole('button', { name: t.appView.promptSave }));
    expect(view.onUpdatePrompt).toHaveBeenCalledWith(expect.objectContaining({
      appId: 'planner', kind: 'agentPrompt', id: 'system', prompt: 'Updated prompt',
      runtime: expect.objectContaining({ provider: 'claude', model: 'claude-two', effort: 'medium', permissionMode: 'safe' }),
    }));
    await waitFor(() => expect(screen.getByRole('button', { name: t.appView.promptSave })).toBeEnabled());
    await userEvent.click(screen.getByRole('button', { name: t.appView.promptRestore }));
    expect(view.onRestorePrompt).toHaveBeenCalledWith({ appId: 'planner', kind: 'agentPrompt', id: 'system' });

    fireEvent.keyDown(screen.getByRole('button', { name: /agent coach/i }), { key: 'Enter' });
    expect(screen.getByLabelText(t.appView.promptEditorLabel)).toHaveValue('Prompt coach');
    fireEvent.keyDown(screen.getByRole('button', { name: /agent coach/i }), { key: 'Escape' });
    fireEvent.keyDown(screen.getByRole('button', { name: /promptTemplate daily/i }), { key: ' ' });
    expect(screen.getByLabelText(t.appView.promptEditorLabel)).toHaveValue('Prompt daily');
    await userEvent.click(screen.getByRole('button', { name: /agent coach/i }));
    expect(screen.getByLabelText(t.appView.promptEditorLabel)).toHaveValue('Prompt coach');
    await userEvent.click(screen.getByRole('button', { name: t.appView.promptSave }));
    expect(view.onUpdatePrompt).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'agent', id: 'coach', runtime: null }));
    vi.useRealTimers();
  });

  it('shows empty prompts and converts validation rejection into a safe visible error', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    (window.forger.validateAppPrompt as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('private detail'));
    const sparse = richDetails({ promptReviews: [promptReview('agentPrompt', 'minimal', {
      description: undefined, originalRuntime: undefined, originalModel: undefined, originalReasoningEffort: undefined,
      sourcePath: undefined, declaredVariables: undefined,
    })] as any }, { name: undefined, longDescription: undefined, iconUrl: undefined });
    const view = await renderApp({ details: sparse, gate: null, developer: false });
    await chooseTab(t.appView.tabs.prompts);
    await act(async () => { vi.advanceTimersByTime(250); });
    expect(await screen.findByText(t.appView.promptErrorFallback)).toBeVisible();
    view.unmount();

    await renderApp({ details: richDetails({ promptReviews: [] }), gate: null, developer: false });
    await chooseTab(t.appView.tabs.prompts);
    expect(screen.getByText(t.appView.promptEmpty)).toBeVisible();
    vi.useRealTimers();
  });

  it('uses safe runtime fallbacks when a provider exposes no models and a saved model is unknown', async () => {
    const controls = runtimeProviderControls();
    controls.claude = control('claude', {
      modelOptions: [],
      effortOptionsForModel: vi.fn(() => [{ label: 'Only', value: 'medium' }]),
    });
    const details = richDetails({ promptReviews: [promptReview('agent', 'legacy', {
      originalRuntime: undefined,
      originalModel: 'legacy-model',
      originalReasoningEffort: 'high',
      runtime: { provider: 'codex', model: 'missing-model', effort: 'high' },
    })] as any });
    await renderApp({ details, controls, developer: false });
    await chooseTab(t.appView.tabs.prompts);
    fireEvent.mouseDown(screen.getByLabelText(t.appView.promptProviderLabel));
    await userEvent.click(screen.getByRole('option', { name: 'Claude' }));
    expect(screen.getByLabelText(t.appView.promptModelLabel)).toHaveTextContent('missing-model');
  });
});

describe('AppView reviews, history, updates, secrets and developer paths', () => {
  it('submits a review, opens a profile, and handles an unsuccessful submission without closing', async () => {
    const view = await renderApp();
    await chooseTab(t.appView.tabs.reviews);
    await userEvent.click(screen.getByRole('button', { name: t.appView.editReview }));
    const comment = screen.getByLabelText(t.appView.reviewCommentLabel);
    await userEvent.clear(comment);
    await userEvent.type(comment, 'Updated review');
    await userEvent.click(screen.getByRole('button', { name: t.appView.saveReview }));
    expect(view.onSubmitRating).toHaveBeenCalledWith({ appId: 'planner', socialUserAppId: 42, score: 4, comment: 'Updated review' });
    await waitFor(() => expect(screen.queryByLabelText(t.appView.reviewCommentLabel)).not.toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: 'Ver perfil' }));
    expect(view.onOpenProfile).toHaveBeenCalledWith('bea');

    view.onSubmitRating.mockResolvedValueOnce({ success: false });
    await userEvent.click(screen.getByRole('button', { name: t.appView.editReview }));
    const stars = within(screen.getByText('4/5').parentElement!).getAllByRole('radio');
    fireEvent.click(stars[1]!, { target: { value: '2' } });
    await userEvent.click(screen.getByRole('button', { name: t.appView.saveReview }));
    await waitFor(() => expect(screen.getByLabelText(t.appView.reviewCommentLabel)).toBeVisible());
    await userEvent.click(screen.getByRole('button', { name: t.actions.close }));
  });

  it('offers account access to guests and renders empty review, history, update and secret states', async () => {
    const empty = richDetails({ operations: [], localChanges: [], changelog: { version: '2.0.0', changes: [] } }, {
      averageRating: undefined, ratingsCount: undefined, recentRatings: [], currentUserRating: undefined,
      socialUserAppId: undefined, socialSource: { userAppId: 99 },
    });
    const view = await renderApp({ details: empty, gate: { ...toolGate(), required: [], optional: [], connectionRequired: [], connectionOptional: [], platformCapabilities: {} as any }, session: account(false), includeProfile: false });
    await chooseTab(t.appView.tabs.reviews);
    expect(screen.getByText(t.appView.signInToReview)).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: t.cloud.login }));
    expect(view.onOpenAccount).toHaveBeenCalledOnce();
    await chooseTab(t.appView.tabs.history);
    expect(screen.getByText(t.appView.noHistory)).toBeVisible();
    await chooseTab(t.appView.tabs.updates);
    expect(screen.getByText(t.appView.updateNoChangelog)).toBeVisible();
    await chooseTab(t.appView.tabs.secrets);
    await userEvent.click(screen.getByRole('button', { name: 'Connect mocked secret' }));
    await userEvent.click(screen.getByRole('button', { name: 'Disconnect mocked secret' }));
    expect(view.onConnectSecret).toHaveBeenCalledWith('API_KEY', 'secret-1');
    expect(view.onDisconnectSecret).toHaveBeenCalledWith('API_KEY');
  });

  it('creates a first review without social metadata and shows conflicts, history and install-only secrets', async () => {
    const noPrior = richDetails({ status: 'conflict', changelog: undefined }, {
      status: 'conflict', currentUserRating: undefined, socialUserAppId: undefined, socialSource: undefined,
    });
    const view = await renderApp({ details: noPrior, includeProfile: false });
    await chooseTab(t.appView.tabs.reviews);
    await userEvent.click(screen.getByRole('button', { name: t.appView.createReview }));
    const ratingRoot = screen.getByText('5/5').parentElement!;
    const selectedStar = within(ratingRoot).getAllByRole('radio')[4]!;
    await userEvent.click(selectedStar);
    fireEvent.click(within(screen.getByText('5/5').parentElement!).getAllByRole('radio')[4]!, { clientX: 1, clientY: 1 });
    await userEvent.click(screen.getByRole('button', { name: t.appView.saveReview }));
    expect(view.onSubmitRating).toHaveBeenCalledWith({ appId: 'planner', score: 5, comment: '' });
    await chooseTab(t.appView.tabs.history);
    expect(screen.getByText('Customized')).toBeVisible();
    expect(screen.getByText(t.appView.reverted, { exact: false })).toBeVisible();
    expect(screen.getByText('Undated local change')).toBeVisible();
    await chooseTab(t.appView.tabs.updates);
    expect(screen.getByText(t.appView.conflictBody)).toBeVisible();

    view.unmount();
    await renderApp({
      details: { app: { id: 'plain', category: 'utilities', status: 'not_installed' }, installed: false, status: 'not_installed', operations: [] },
      gate: null, developer: false,
    });
    await chooseTab(t.appView.tabs.secrets);
    expect(screen.getByText(t.appView.secretsInstallRequired)).toBeVisible();
  });

  it('loads, edits and saves developer paths and shows both Error and non-Error failures', async () => {
    const view = await renderApp();
    await chooseTab(t.settings.developerModeTitle);
    await waitFor(() => expect(screen.getByLabelText(t.settings.developerAppPathTitle)).toHaveValue('/app/bin'));
    expect(screen.getByText('/runtime/bin')).toBeVisible();
    fireEvent.change(screen.getByLabelText(t.settings.developerAppPathTitle), { target: { value: '/new/bin\n/other/bin' } });
    await userEvent.click(screen.getByRole('button', { name: t.settings.developerPathSave }));
    expect(window.forger.updateAppDeveloperSettings).toHaveBeenCalledWith({ appId: 'planner', pathEntries: ['/new/bin', '/other/bin'] });
    await waitFor(() => expect(screen.getByLabelText(t.settings.developerAppPathTitle)).toHaveValue('/saved/bin'));
    expect(view.props.developerMode.enabled).toBe(true);

    (window.forger.updateAppDeveloperSettings as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('Cannot save'));
    await userEvent.click(screen.getByRole('button', { name: t.settings.developerPathSave }));
    expect(await screen.findByText('Cannot save')).toBeVisible();
    (window.forger.updateAppDeveloperSettings as ReturnType<typeof vi.fn>).mockRejectedValueOnce('unknown');
    await userEvent.click(screen.getByRole('button', { name: t.settings.developerPathSave }));
    expect(await screen.findByText(t.settings.developerPathSaveError)).toBeVisible();
  });

  it('ignores a developer-path response after unmount and tolerates a load failure', async () => {
    let resolveState!: (value: any) => void;
    (window.forger.getDeveloperPathState as ReturnType<typeof vi.fn>).mockReturnValueOnce(new Promise((resolve) => { resolveState = resolve; }));
    const pending = await renderApp();
    pending.unmount();
    await act(async () => resolveState({
      enabled: true, globalPathEntries: [], appPathEntries: ['/late'], runtimePathEntries: [], systemPathEntries: [], effectivePathEntries: [],
    }));

    (window.forger.getDeveloperPathState as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('unavailable'));
    await renderApp();
    await waitFor(() => expect(window.forger.getDeveloperPathState).toHaveBeenLastCalledWith('planner'));
  });
});
