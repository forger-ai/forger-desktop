import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectionsView } from '@renderer/views/ConnectionsView';
import { en } from '@renderer/i18n/en';
import type { AppDictionary } from '@renderer/i18n';
import type {
  AgentToolDefinition,
  AgentToolSettings,
  AppSummary,
  CallConnectionActionResult,
  ConnectionInstance,
  ConnectionsState,
  ConnectionTypeDefinition,
  PersonalAgent,
  Workflow,
} from '@shared/types';

interface GuideFixtureProps {
  guide: { title: string } | null;
  locale: string;
  open: boolean;
  onClose: () => void;
  onCopy: (value: string) => void;
  onOpenExternalUrl: (url: string) => void;
}

vi.mock('@renderer/views/connections/SetupGuideDialog', () => ({
  SetupGuideDialog: ({ guide, locale, open, onClose, onCopy, onOpenExternalUrl }: GuideFixtureProps) => open ? (
    <section aria-label="setup guide fixture" data-locale={locale}>
      <span>{guide?.title}</span>
      <button type="button" onClick={() => onCopy('guide-copy')}>Copy guide value</button>
      <button type="button" onClick={() => onOpenExternalUrl('https://guide.example')}>Open guide portal</button>
      <button type="button" onClick={() => onOpenExternalUrl('')}>Ignore blank portal</button>
      <button type="button" onClick={onClose}>Close guide</button>
    </section>
  ) : null,
}));

const t = en as unknown as AppDictionary;
const copy = t.sections.connections;
const now = '2026-08-10T12:00:00.000Z';

const definition = (
  type: string,
  overrides: Partial<ConnectionTypeDefinition> = {},
): ConnectionTypeDefinition => ({
  type,
  displayName: type[0]?.toUpperCase() + type.slice(1),
  description: `${type} connection`,
  setupKind: 'local_device',
  supportsMultiple: true,
  actions: [],
  secretsSchema: [],
  statusActionId: `${type}.status`,
  ...overrides,
});

const guide = {
  title: 'Provider setup guide',
  summary: 'Prepare the provider application.',
  steps: ['Create an application.'],
};

const gmail = definition('gmail', {
  displayName: 'Gmail',
  setupKind: 'oauth',
  oauth: {
    callbackPath: '/oauth/gmail/callback',
    callbackUrl: 'http://127.0.0.1:4545/oauth/gmail/callback',
    previousCallbackUrl: 'http://127.0.0.1:3333/oauth/gmail/callback',
    callbackPortChanged: true,
    scopes: ['mail.read'],
  },
  setupGuide: guide,
  actions: [
    { id: 'gmail.read', name: 'Read mail', description: 'Read messages', risk: 'low' },
    { id: 'gmail.send', name: 'Send mail', description: 'Send messages', risk: 'medium' },
    { id: 'gmail.delete', name: 'Delete mail', description: 'Delete messages', risk: 'high' },
  ],
});

const slack = definition('slack', {
  displayName: 'Slack',
  setupKind: 'oauth',
  oauth: {
    callbackPath: '/oauth/slack/callback',
    callbackUrl: 'http://127.0.0.1:4545/oauth/slack/callback',
    callbackPortChanged: true,
    scopes: ['chat.write'],
  },
  setupGuide: guide,
  secretsSchema: [
    { name: 'client_id', label: 'Slack client ID', required: true, usage: 'Provider client identifier' },
    { name: 'client_secret', label: 'Slack client secret', required: true, usage: 'Provider secret' },
    { name: 'optional_note', label: 'Slack note', required: false, usage: 'Optional note' },
  ],
});

const trello = definition('trello', {
  displayName: 'Trello',
  setupKind: 'manual_secret',
  secretsSchema: [
    { name: 'api_token', label: 'Trello API token', required: true, usage: 'Token from Trello', manual: true },
    { name: 'account_name', label: 'Trello account', required: false, usage: 'Optional account', manual: true },
  ],
});

const whatsapp = definition('whatsapp', {
  displayName: 'WhatsApp',
  setupKind: 'qr_pairing',
});

const calendar = definition('calendar', { displayName: 'Calendar' });
const custom = definition('custom_mail', { displayName: 'Acme Mail' });
const customZulu = definition('custom_zulu', { displayName: 'Zulu Integration' });

const instance = (
  id: string,
  type: string,
  overrides: Partial<ConnectionInstance> = {},
): ConnectionInstance => ({
  id,
  type,
  label: `${type} ${id}`,
  status: 'connected',
  isDefault: false,
  createdAt: now,
  updatedAt: now,
  ...overrides,
});

const gmailInstance = instance('gmail-main', 'gmail', {
  label: 'Primary inbox',
  accountIdentity: { email: 'owner@example.com' },
  isDefault: true,
  lastCheckedAt: now,
});

const allDefinitions = [customZulu, custom, trello, slack, whatsapp, calendar, gmail];

const allInstances: ConnectionInstance[] = [
  instance('orphan', 'orphan', { label: undefined as unknown as string, status: 'disabled' }),
  instance('z-orphan', 'z_orphan', { label: 'Unknown provider', status: 'disabled' }),
  instance('custom', 'custom_mail', { label: 'Custom account', status: 'available' }),
  instance('custom-weird', 'custom_mail', {
    label: 'Unmapped status',
    status: 'provider_paused' as ConnectionInstance['status'],
  }),
  instance('trello', 'trello', { label: 'Boards', accountIdentity: { username: 'trello-user' }, status: 'syncing' }),
  instance('slack', 'slack', { label: 'Team Slack', accountIdentity: { workspace: 'Acme workspace' }, status: 'connecting' }),
  instance('wa-setup', 'whatsapp', { label: 'WhatsApp setup', accountIdentity: { phoneNumber: '+15550001' }, status: 'needs_setup' }),
  instance('wa-error', 'whatsapp', { label: 'WhatsApp error', status: 'error' }),
  instance('calendar', 'calendar', { label: 'Work calendar', status: 'needs_reconnect' }),
  gmailInstance,
  instance('gmail-z', 'gmail', { label: 'Zulu inbox', accountIdentity: { email: 'z@example.com' } }),
];

const state = (overrides: Partial<ConnectionsState> = {}): ConnectionsState => ({
  types: allDefinitions,
  instances: allInstances,
  ...overrides,
});

const personalAgent = (name: string, connectionGrants: PersonalAgent['connectionGrants']): PersonalAgent => ({
  id: name.toLowerCase().replaceAll(' ', '-'),
  name,
  description: '',
  purpose: '',
  instructions: '',
  permissionMode: 'safe',
  networkAccess: false,
  canSpawnAgents: false,
  appIds: [],
  toolIds: [],
  connectionGrants,
  peerAgentGrants: [],
  createdAt: now,
  updatedAt: now,
});

const workflow = (name: string, nodes: Workflow['nodes']): Workflow => ({
  id: name.toLowerCase().replaceAll(' ', '-'),
  name,
  trigger: { type: 'manual' },
  nodes,
  edges: [],
  enabled: true,
  running: false,
  nextRunAt: null,
  createdAt: now,
  updatedAt: now,
});

const connectionNode = (
  id: string,
  connectionType: string,
  connectionId?: string,
): Workflow['nodes'][number] => ({
  id,
  name: id,
  type: 'connection',
  connectionType,
  connectionId,
  actionId: `${connectionType}.read`,
  input: {},
});

const llmNode = (
  id: string,
  connectionGrants: Extract<Workflow['nodes'][number], { type: 'llm_agent' }>['connectionGrants'],
): Workflow['nodes'][number] => ({
  id,
  name: id,
  type: 'llm_agent',
  prompt: 'Use connections',
  toolIds: [],
  appIds: [],
  connectionGrants,
});

type Bridge = Pick<Window['forger'],
  | 'connectionsList'
  | 'personalAgentsList'
  | 'workflowsList'
  | 'listInstalledApps'
  | 'connectionsConfigure'
  | 'connectionsCall'
  | 'connectionsSetDefault'
  | 'connectionsDisconnect'
  | 'openExternalUrl'
>;

const makeBridge = (initialState: ConnectionsState = state()) => ({
  connectionsList: vi.fn().mockResolvedValue(initialState),
  personalAgentsList: vi.fn().mockResolvedValue([]),
  workflowsList: vi.fn().mockResolvedValue([]),
  listInstalledApps: vi.fn().mockResolvedValue([]),
  connectionsConfigure: vi.fn().mockResolvedValue({
    success: true,
    userMessage: 'Connection configured',
    instance: gmailInstance,
  }),
  connectionsCall: vi.fn().mockResolvedValue({ success: true, userMessage: 'Status checked', data: {} }),
  connectionsSetDefault: vi.fn().mockResolvedValue({ success: true, userMessage: 'Default updated' }),
  connectionsDisconnect: vi.fn().mockResolvedValue({ success: true, userMessage: 'Disconnected' }),
  openExternalUrl: vi.fn().mockResolvedValue(undefined),
}) satisfies Record<keyof Bridge, ReturnType<typeof vi.fn>>;

const renderConnections = ({
  initialState = state(),
  bridge = makeBridge(initialState),
  view = 'list' as const,
  selectedConnectionId = null as string | null,
  settings = { approvals: {} } as AgentToolSettings,
  busyToolId = null as AgentToolDefinition['id'] | null,
  includeOptionalHandlers = true,
} = {}) => {
  Object.defineProperty(window, 'forger', { configurable: true, value: bridge });
  const handlers = {
    onOpenConnection: vi.fn(),
    onBack: vi.fn(),
    onNotice: vi.fn(),
    onApprovalChange: vi.fn(),
  };
  const viewResult = render(
    <ConnectionsView
      t={t}
      view={view}
      selectedConnectionId={selectedConnectionId}
      settings={settings}
      busyToolId={busyToolId}
      onOpenConnection={handlers.onOpenConnection}
      onBack={includeOptionalHandlers ? handlers.onBack : undefined}
      onNotice={includeOptionalHandlers ? handlers.onNotice : undefined}
      onApprovalChange={handlers.onApprovalChange}
    />,
  );
  return { ...viewResult, ...handlers, bridge };
};

const openAddDialog = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByRole('button', { name: copy.addConnection }));
  return screen.getByRole('dialog');
};

const chooseService = async (user: ReturnType<typeof userEvent.setup>, name: string) => {
  const service = screen.getByRole('combobox', { name: copy.service });
  await user.click(service);
  await user.clear(service);
  await user.type(service, name);
  await user.click(await screen.findByRole('option', { name: new RegExp(name, 'i') }));
};

beforeEach(() => {
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
});

describe('ConnectionsView list and loading behavior', () => {
  it('loads dependencies independently, sorts providers and identities, filters, and exposes both navigation paths', async () => {
    const user = userEvent.setup();
    const bridge = makeBridge();
    bridge.personalAgentsList.mockRejectedValue(new Error('agents unavailable'));
    bridge.workflowsList.mockRejectedValue(new Error('workflows unavailable'));
    bridge.listInstalledApps.mockRejectedValue(new Error('apps unavailable'));
    const handlers = renderConnections({ bridge });

    const table = await screen.findByRole('table', { name: copy.savedConnectionsTitle });
    expect(bridge.connectionsList).toHaveBeenCalledWith(t.locale);
    expect(screen.getByText('owner@example.com')).toBeInTheDocument();
    expect(screen.getByText('Primary inbox')).toBeInTheDocument();
    expect(screen.getAllByText(copy.neverChecked).length).toBeGreaterThan(0);
    expect(screen.getAllByText(copy.defaultAccount).length).toBeGreaterThan(0);
    for (const status of ['connected', 'needs_reconnect', 'needs_setup', 'error', 'connecting', 'syncing', 'available', 'disabled'] as const) {
      expect(screen.getAllByText(copy.statusLabels[status]).length).toBeGreaterThan(0);
    }

    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows[0]).toHaveTextContent('Acme Mail');
    const gmailRows = rows.filter((row) => row.textContent?.includes('Gmail'));
    expect(gmailRows[0]).toHaveTextContent('owner@example.com');
    expect(gmailRows[1]).toHaveTextContent('z@example.com');
    expect(rows.some((row) => row.textContent?.includes('orphan'))).toBe(true);
    expect(screen.getByText('provider_paused')).toBeInTheDocument();

    await user.click(screen.getByText('owner@example.com'));
    expect(handlers.onOpenConnection).toHaveBeenCalledWith('gmail-main');
    handlers.onOpenConnection.mockClear();
    await user.click(within(gmailRows[0] as HTMLElement).getByRole('button', { name: copy.viewDetails }));
    expect(handlers.onOpenConnection).toHaveBeenCalledTimes(1);
    expect(handlers.onOpenConnection).toHaveBeenCalledWith('gmail-main');

    const search = screen.getByPlaceholderText(copy.searchPlaceholder);
    await user.type(search, 'acme workspace');
    expect(screen.getByText('Acme workspace')).toBeInTheDocument();
    expect(screen.queryByText('owner@example.com')).not.toBeInTheDocument();
    await user.clear(search);
    await user.type(search, 'NO MATCH');
    expect(screen.getByText(copy.emptySearch)).toBeInTheDocument();
    await user.clear(search);
    expect(screen.getByRole('table', { name: copy.savedConnectionsTitle })).toBeInTheDocument();
  });

  it('shows empty and recoverable load-error states for Error and unknown rejections', async () => {
    const user = userEvent.setup();
    const emptyBridge = makeBridge(state({ instances: [] }));
    const empty = renderConnections({ initialState: state({ instances: [] }), bridge: emptyBridge });
    expect(await screen.findByText(copy.emptyConnections)).toBeInTheDocument();
    empty.unmount();

    const errorBridge = makeBridge();
    errorBridge.connectionsList.mockRejectedValue(new Error('Connection daemon stopped'));
    const errored = renderConnections({ bridge: errorBridge });
    expect(await screen.findByText('Connection daemon stopped')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /close/i }));
    expect(screen.queryByText('Connection daemon stopped')).not.toBeInTheDocument();
    errored.unmount();

    const unknownBridge = makeBridge();
    unknownBridge.connectionsList.mockRejectedValue('offline');
    renderConnections({ bridge: unknownBridge });
    expect(await screen.findByText(copy.loadError)).toBeInTheDocument();
  });
});

describe('ConnectionsView detail behavior', () => {
  it('shows referenced agents, workflows, and apps while delegating approval and navigation actions', async () => {
    const user = userEvent.setup();
    const bridge = makeBridge();
    bridge.personalAgentsList.mockResolvedValue([
      personalAgent('All Gmail agent', [{ type: 'gmail', actions: ['gmail.read'], multiple: true }]),
      personalAgent('Selected Gmail agent', [{ type: 'gmail', actions: ['gmail.read'], multiple: true, connectionIds: ['other', 'gmail-main'] }]),
      personalAgent('Excluded Gmail agent', [{ type: 'gmail', actions: [], multiple: true, connectionIds: ['other'] }]),
      personalAgent('Wrong provider agent', [{ type: 'slack', actions: [], multiple: true }]),
    ]);
    bridge.workflowsList.mockResolvedValue([
      workflow('Any Gmail workflow', [connectionNode('any', 'gmail')]),
      workflow('Selected Gmail workflow', [connectionNode('selected', 'gmail', 'gmail-main')]),
      workflow('Excluded connection workflow', [connectionNode('excluded', 'gmail', 'other')]),
      workflow('Wrong connection workflow', [connectionNode('wrong', 'slack')]),
      workflow('Granted Gmail workflow', [llmNode('llm-match', [{ type: 'gmail', actions: ['gmail.read'], multiple: true, connectionIds: ['gmail-main'] }])]),
      workflow('All Gmail LLM workflow', [llmNode('llm-all', [{ type: 'gmail', actions: [], multiple: true, connectionIds: [] }])]),
      workflow('Excluded LLM workflow', [llmNode('llm-excluded', [
        { type: 'slack', actions: [], multiple: true },
        { type: 'gmail', actions: [], multiple: true, connectionIds: ['other'] },
      ])]),
      workflow('Other node workflow', [{ id: 'condition', name: 'condition', type: 'condition', expression: { left: 'x', operator: 'is_empty' } }]),
    ]);
    bridge.listInstalledApps.mockResolvedValue([
      { id: 'required-app', name: 'Required app', category: 'productivity', status: 'installed', connections: { required: [{ type: 'gmail', actions: ['gmail.read'], reason: 'mail', multiple: false }] } },
      { id: 'optional-app', category: 'productivity', status: 'installed', connections: { optional: [{ type: 'gmail', actions: [], reason: 'mail', multiple: false }] } },
      { id: 'none-app', category: 'productivity', status: 'installed' },
      { id: 'wrong-app', category: 'productivity', status: 'installed', connections: { required: [{ type: 'slack', actions: [], reason: 'chat', multiple: false }] } },
    ] satisfies AppSummary[]);
    const handlers = renderConnections({
      bridge,
      view: 'detail',
      selectedConnectionId: 'gmail-main',
      settings: { approvals: { 'gmail.read': true, 'gmail.send': false } },
      busyToolId: 'gmail.delete' as AgentToolDefinition['id'],
    });

    expect(await screen.findByRole('heading', { name: 'owner@example.com' })).toBeInTheDocument();
    expect(screen.getByText('All Gmail agent')).toBeInTheDocument();
    expect(screen.getByText('Selected Gmail agent')).toBeInTheDocument();
    expect(screen.queryByText('Excluded Gmail agent')).not.toBeInTheDocument();
    expect(screen.getByText('Any Gmail workflow')).toBeInTheDocument();
    expect(screen.getByText('Selected Gmail workflow')).toBeInTheDocument();
    expect(screen.getByText('Granted Gmail workflow')).toBeInTheDocument();
    expect(screen.getByText('All Gmail LLM workflow')).toBeInTheDocument();
    expect(screen.queryByText('Excluded connection workflow')).not.toBeInTheDocument();
    expect(screen.getByText('Required app')).toBeInTheDocument();
    expect(screen.getByText('optional-app')).toBeInTheDocument();
    expect(screen.getAllByText(copy.approvalOn)).toHaveLength(2);
    expect(screen.getByText(copy.approvalOff)).toBeInTheDocument();
    expect(screen.getByText(`${copy.riskLabel}: ${copy.risk.low}`)).toBeInTheDocument();
    expect(screen.getByText(`${copy.riskLabel}: ${copy.risk.medium}`)).toBeInTheDocument();
    expect(screen.getByText(`${copy.riskLabel}: ${copy.risk.high}`)).toBeInTheDocument();

    const toggles = screen.getAllByRole('checkbox', { name: copy.approvalToggleLabel });
    await user.click(toggles[0] as HTMLElement);
    await user.click(toggles[1] as HTMLElement);
    expect(handlers.onApprovalChange).toHaveBeenNthCalledWith(1, 'gmail.read', false);
    expect(handlers.onApprovalChange).toHaveBeenNthCalledWith(2, 'gmail.send', true);
    expect(toggles[2]).toBeDisabled();
    await user.click(screen.getByRole('button', { name: copy.backToConnections }));
    expect(handlers.onBack).toHaveBeenCalledOnce();
  });

  it('shows empty detail variants and empty usage without requiring optional callbacks', async () => {
    const user = userEvent.setup();
    const noConnectionState = state({ types: [], instances: [] });
    const noInstances = renderConnections({
      initialState: noConnectionState,
      bridge: makeBridge(noConnectionState),
      view: 'detail',
      selectedConnectionId: null,
    });
    expect(await screen.findByText(copy.emptyConnections)).toBeInTheDocument();
    await user.click(screen.getAllByRole('button', { name: copy.addConnection })[1] as HTMLElement);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    noInstances.unmount();

    const missing = renderConnections({ view: 'detail', selectedConnectionId: 'missing' });
    expect(await screen.findByText(copy.noConnectionSelectedBody)).toBeInTheDocument();
    missing.unmount();

    const orphanOnly = state({ types: [], instances: [instance('orphan-detail', 'orphan')] });
    const missingDefinition = renderConnections({
      initialState: orphanOnly,
      bridge: makeBridge(orphanOnly),
      view: 'detail',
      selectedConnectionId: 'orphan-detail',
    });
    expect(await screen.findByText(copy.noConnectionSelectedBody)).toBeInTheDocument();
    missingDefinition.unmount();

    const noUsage = renderConnections({
      view: 'detail',
      selectedConnectionId: 'gmail-z',
      includeOptionalHandlers: false,
    });
    expect(await screen.findByText(copy.usedByEmpty)).toBeInTheDocument();
    expect(screen.getByText(copy.neverChecked)).toBeInTheDocument();
    noUsage.unmount();

    const unmapped = instance('unmapped', 'custom_mail', {
      label: 'Unmapped status detail',
      status: 'provider_paused' as ConnectionInstance['status'],
    });
    renderConnections({
      initialState: state({ types: [custom], instances: [unmapped] }),
      bridge: makeBridge(state({ types: [custom], instances: [unmapped] })),
      view: 'detail',
      selectedConnectionId: 'unmapped',
    });
    expect(await screen.findByText('provider_paused')).toBeInTheDocument();
  });

  it('sets a default, checks status variants, and contains handled mutation errors', async () => {
    const user = userEvent.setup();
    const selected = instance('custom', 'custom_mail', { label: 'Custom account', status: 'available' });
    const customState = state({ types: [custom], instances: [selected] });
    const bridge = makeBridge(customState);
    bridge.connectionsSetDefault
      .mockResolvedValueOnce({ success: true, userMessage: 'Made default' })
      .mockResolvedValueOnce({ success: false, userMessage: 'Default refused' })
      .mockRejectedValueOnce(new Error('boom'));
    bridge.connectionsCall
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValueOnce({ success: false })
      .mockRejectedValueOnce(new Error('offline'));
    const handlers = renderConnections({ bridge, initialState: customState, view: 'detail', selectedConnectionId: 'custom' });
    expect(await screen.findByRole('heading', { name: 'Custom account' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: copy.setDefault }));
    expect(await screen.findByText('Made default')).toBeInTheDocument();
    expect(bridge.connectionsSetDefault).toHaveBeenCalledWith({ type: 'custom_mail', connectionId: 'custom' });
    await user.click(screen.getByRole('button', { name: copy.setDefault }));
    expect(await screen.findByText('Default refused')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: copy.setDefault }));
    expect(await screen.findByText(copy.mutationFailed)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: copy.checkStatus }));
    expect(await screen.findByText(copy.statusChecked)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: copy.checkStatus }));
    expect(await screen.findByText(copy.statusCheckFailed)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: copy.checkStatus }));
    await waitFor(() => expect(screen.getByText(copy.statusCheckFailed)).toBeInTheDocument());
    expect(handlers.onOpenConnection).not.toHaveBeenCalled();
  });

  it('respects disconnect cancellation and only navigates after a successful detail disconnect', async () => {
    const user = userEvent.setup();
    const selected = instance('custom', 'custom_mail', { label: 'Custom account' });
    const customState = state({ types: [custom], instances: [selected] });
    const bridge = makeBridge(customState);
    const handlers = renderConnections({ bridge, initialState: customState, view: 'detail', selectedConnectionId: 'custom' });
    expect(await screen.findByRole('heading', { name: 'Custom account' })).toBeInTheDocument();

    vi.mocked(window.confirm).mockReturnValueOnce(false);
    await user.click(screen.getByRole('button', { name: copy.disconnect }));
    expect(bridge.connectionsDisconnect).not.toHaveBeenCalled();

    bridge.connectionsDisconnect.mockResolvedValueOnce({ success: false, userMessage: 'Disconnect refused' });
    await user.click(screen.getByRole('button', { name: copy.disconnect }));
    expect(await screen.findByText('Disconnect refused')).toBeInTheDocument();
    expect(handlers.onBack).not.toHaveBeenCalled();

    bridge.connectionsDisconnect.mockResolvedValueOnce({ success: true, userMessage: 'Disconnected now' });
    await user.click(screen.getByRole('button', { name: copy.disconnect }));
    await waitFor(() => expect(handlers.onNotice).toHaveBeenCalledWith({ severity: 'success', message: 'Disconnected now' }));
    expect(handlers.onBack).toHaveBeenCalledOnce();
    expect(bridge.connectionsDisconnect).toHaveBeenLastCalledWith({ type: 'custom_mail', connectionId: 'custom' });
  });
});

describe('ConnectionsView connection setup', () => {
  it('configures Forger OAuth Gmail and trims its optional label', async () => {
    const user = userEvent.setup();
    const gmailState = state({ types: [gmail], instances: [] });
    const configured = instance('new-gmail', 'gmail', { label: 'Personal' });
    const bridge = makeBridge(gmailState);
    bridge.connectionsConfigure.mockResolvedValue({ success: true, userMessage: 'Gmail ready', instance: configured });
    const handlers = renderConnections({ bridge, initialState: gmailState });
    const dialog = await openAddDialog(user);
    expect(within(dialog).getByText(copy.noManualSecrets)).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: /guide/i })).not.toBeInTheDocument();
    await user.type(within(dialog).getByRole('textbox', { name: copy.accountLabel }), '  Personal  ');
    await user.click(within(dialog).getByRole('button', { name: copy.connect }));
    await waitFor(() => expect(bridge.connectionsConfigure).toHaveBeenCalledWith({ type: 'gmail', label: 'Personal' }));
    expect(handlers.onOpenConnection).toHaveBeenCalledWith('new-gmail');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('requires both self OAuth credentials, copies callback data, and operates the setup guide', async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
    const gmailState = state({ types: [gmail], instances: [] });
    const bridge = makeBridge(gmailState);
    bridge.openExternalUrl.mockRejectedValue(new Error('browser unavailable'));
    renderConnections({ bridge, initialState: gmailState });
    const dialog = await openAddDialog(user);
    await user.click(within(dialog).getByRole('radio', { name: copy.gmailSelfOAuth }));
    expect(within(dialog).getByText(copy.gmailSelfOAuthHelp)).toBeInTheDocument();
    expect(within(dialog).getByText(copy.oauthCallbackRotated)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: copy.connect })).toBeDisabled();
    await user.click(within(dialog).getByRole('radio', { name: copy.gmailForgerOAuth }));
    expect(within(dialog).getByText(copy.noManualSecrets)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('radio', { name: copy.gmailSelfOAuth }));
    await user.type(within(dialog).getByRole('textbox', { name: copy.oauthClientId }), 'client-123');
    expect(within(dialog).getByRole('button', { name: copy.connect })).toBeDisabled();
    await user.type(within(dialog).getByLabelText(copy.oauthClientSecret), 'secret-456');
    expect(within(dialog).getByRole('button', { name: copy.connect })).toBeEnabled();

    await user.click(within(dialog).getByRole('button', { name: copy.copyCallbackUrl }));
    expect(writeText).toHaveBeenCalledWith(gmail.oauth?.callbackUrl);
    writeText.mockRejectedValueOnce(new Error('clipboard unavailable'));
    await user.click(within(dialog).getByRole('button', { name: copy.copyCallbackUrl }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(2));
    await user.click(within(dialog).getByRole('button', { name: /setup guide/i }));
    const guideFixture = document.querySelector('[aria-label="setup guide fixture"]') as HTMLElement;
    expect(guideFixture).toHaveAttribute('data-locale', t.locale);
    expect(within(guideFixture).getByText(guide.title)).toBeInTheDocument();
    await user.click(within(guideFixture).getByText('Copy guide value'));
    expect(writeText).toHaveBeenCalledWith('guide-copy');
    await user.click(within(guideFixture).getByText('Open guide portal'));
    await user.click(within(guideFixture).getByText('Ignore blank portal'));
    expect(bridge.openExternalUrl).toHaveBeenCalledOnce();
    expect(bridge.openExternalUrl).toHaveBeenCalledWith('https://guide.example');
    await user.click(within(guideFixture).getByText('Close guide'));
    expect(document.querySelector('[aria-label="setup guide fixture"]')).not.toBeInTheDocument();

    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
    fireEvent.click(within(dialog).getByRole('button', { name: copy.copyCallbackUrl }));

    await user.click(within(dialog).getByRole('button', { name: copy.connect }));
    await waitFor(() => expect(bridge.connectionsConfigure).toHaveBeenCalledWith({
      type: 'gmail',
      secrets: { self_oauth_client_id: 'client-123', self_oauth_client_secret: 'secret-456' },
    }));
  });

  it('validates and configures generic OAuth secrets, including optional text fields', async () => {
    const user = userEvent.setup();
    const consoleError = vi.spyOn(console, 'error');
    const oauthState = state({ types: [gmail, slack], instances: [] });
    const bridge = makeBridge(oauthState);
    bridge.connectionsConfigure.mockResolvedValue({
      success: true,
      userMessage: 'Slack ready',
      instance: instance('slack-new', 'slack'),
    });
    renderConnections({ bridge, initialState: oauthState });
    const dialog = await openAddDialog(user);
    await chooseService(user, 'Slack');
    expect(consoleError.mock.calls.flat().join(' ')).not.toContain('key prop is being spread into JSX');
    expect(within(dialog).getByText(copy.selfOAuthHelp)).toBeInTheDocument();
    expect(within(dialog).getByText(copy.oauthCallbackRotated)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: copy.connect })).toBeDisabled();
    await user.type(within(dialog).getByRole('textbox', { name: 'Slack client ID' }), 'slack-id');
    await user.type(within(dialog).getByLabelText(/Slack client secret/), 'slack-secret');
    await user.type(within(dialog).getByRole('textbox', { name: 'Slack note' }), 'optional');
    await user.click(within(dialog).getByRole('button', { name: /setup guide/i }));
    expect(document.querySelector('[aria-label="setup guide fixture"]')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: copy.copyCallbackUrl }));
    await user.click(within(dialog).getByRole('button', { name: copy.connect }));
    await waitFor(() => expect(bridge.connectionsConfigure).toHaveBeenCalledWith({
      type: 'slack',
      secrets: { client_id: 'slack-id', client_secret: 'slack-secret', optional_note: 'optional' },
    }));
  });

  it('handles OAuth providers with absent callbacks and unchanged callback ports', async () => {
    const user = userEvent.setup();
    const gmailWithoutCallback = definition('gmail', {
      displayName: 'Gmail',
      setupKind: 'oauth',
      oauth: { callbackPath: '/gmail', scopes: [] },
      setupGuide: guide,
    });
    const bareGmailState = state({ types: [gmailWithoutCallback], instances: [] });
    const bareGmail = renderConnections({ initialState: bareGmailState, bridge: makeBridge(bareGmailState) });
    let dialog = await openAddDialog(user);
    await user.click(within(dialog).getByRole('radio', { name: copy.gmailSelfOAuth }));
    expect(within(dialog).queryByRole('button', { name: copy.copyCallbackUrl })).not.toBeInTheDocument();
    bareGmail.unmount();

    const gmailStable = definition('gmail', {
      displayName: 'Gmail',
      setupKind: 'oauth',
      oauth: { callbackPath: '/gmail', callbackUrl: 'http://127.0.0.1/gmail', callbackPortChanged: false, scopes: [] },
    });
    const stableGmailState = state({ types: [gmailStable], instances: [] });
    const stableGmail = renderConnections({ initialState: stableGmailState, bridge: makeBridge(stableGmailState) });
    dialog = await openAddDialog(user);
    await user.click(within(dialog).getByRole('radio', { name: copy.gmailSelfOAuth }));
    expect(within(dialog).getByRole('button', { name: copy.copyCallbackUrl })).toBeInTheDocument();
    expect(within(dialog).queryByText(copy.oauthCallbackRotated)).not.toBeInTheDocument();
    stableGmail.unmount();

    const slackWithoutCallback = definition('slack', {
      displayName: 'Slack',
      setupKind: 'oauth',
      oauth: { callbackPath: '/slack', scopes: [] },
    });
    const bareSlackState = state({ types: [slackWithoutCallback], instances: [] });
    const bareSlack = renderConnections({ initialState: bareSlackState, bridge: makeBridge(bareSlackState) });
    dialog = await openAddDialog(user);
    expect(within(dialog).queryByRole('button', { name: copy.copyCallbackUrl })).not.toBeInTheDocument();
    bareSlack.unmount();

    const slackStable = definition('slack', {
      displayName: 'Slack',
      setupKind: 'oauth',
      oauth: { callbackPath: '/slack', callbackUrl: 'http://127.0.0.1/slack', callbackPortChanged: false, scopes: [] },
    });
    const stableSlackState = state({ types: [slackStable], instances: [] });
    renderConnections({ initialState: stableSlackState, bridge: makeBridge(stableSlackState) });
    dialog = await openAddDialog(user);
    expect(within(dialog).getByRole('button', { name: copy.copyCallbackUrl })).toBeInTheDocument();
    expect(within(dialog).queryByText(copy.oauthCallbackRotated)).not.toBeInTheDocument();
  });

  it('switches services cleanly, validates manual secrets, and leaves a failed form open', async () => {
    const user = userEvent.setup();
    const setupState = state({ types: [gmail, trello], instances: [] });
    const bridge = makeBridge(setupState);
    bridge.connectionsConfigure.mockResolvedValue({ success: false, userMessage: 'Token rejected' });
    renderConnections({ bridge, initialState: setupState });
    const dialog = await openAddDialog(user);
    await user.type(within(dialog).getByRole('textbox', { name: copy.accountLabel }), 'discard me');
    await chooseService(user, 'Trello');
    expect(within(dialog).getByRole('textbox', { name: copy.accountLabel })).toHaveValue('');
    expect(within(dialog).getByRole('button', { name: copy.connect })).toBeDisabled();
    expect(within(dialog).getByLabelText(/Trello API token/)).toHaveAttribute('type', 'password');
    expect(within(dialog).getByRole('textbox', { name: 'Trello account' })).toHaveAttribute('type', 'text');
    await user.type(within(dialog).getByLabelText(/Trello API token/), 'token');
    await user.type(within(dialog).getByRole('textbox', { name: 'Trello account' }), 'board owner');
    await user.click(within(dialog).getByRole('button', { name: copy.connect }));
    expect(await screen.findByText('Token rejected')).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(bridge.connectionsConfigure).toHaveBeenCalledWith({
      type: 'trello',
      secrets: { api_token: 'token', account_name: 'board owner' },
    });
  });

  it('reconnects setup and error accounts with a locked service and existing connection id', async () => {
    const user = userEvent.setup();
    for (const status of ['needs_reconnect', 'error'] as const) {
      const selected = instance(`calendar-${status}`, 'calendar', { label: 'Work calendar', status });
      const reconnectState = state({ types: [calendar], instances: [selected] });
      const bridge = makeBridge(reconnectState);
      bridge.connectionsConfigure.mockResolvedValue({ success: true, userMessage: 'Reconnected', instance: selected });
      const handlers = renderConnections({ bridge, initialState: reconnectState, view: 'detail', selectedConnectionId: selected.id });
      expect(await screen.findByRole('heading', { name: 'Work calendar' })).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: copy.reconnect }));
      const dialog = screen.getByRole('dialog');
      expect(within(dialog).getByText(copy.reconnectTitle)).toBeInTheDocument();
      expect(within(dialog).getByRole('combobox', { name: copy.service })).toBeDisabled();
      expect(within(dialog).getByRole('textbox', { name: copy.accountLabel })).toHaveValue('Work calendar');
      await user.click(within(dialog).getByRole('button', { name: copy.reconnect }));
      await waitFor(() => expect(bridge.connectionsConfigure).toHaveBeenCalledWith({
        type: 'calendar', connectionId: selected.id, label: 'Work calendar',
      }));
      expect(handlers.onOpenConnection).toHaveBeenCalledWith(selected.id);
      handlers.unmount();
    }
  });

  it('uses Connect rather than Reconnect for an account that still needs initial setup', async () => {
    const user = userEvent.setup();
    const selected = instance('calendar-setup', 'calendar', { label: 'New calendar', status: 'needs_setup' });
    const setupState = state({ types: [calendar], instances: [selected] });
    const bridge = makeBridge(setupState);
    renderConnections({ bridge, initialState: setupState, view: 'detail', selectedConnectionId: selected.id });
    expect(await screen.findByRole('heading', { name: 'New calendar' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: copy.connect }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(copy.setupTitle)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: t.actions.cancel }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });
});

describe('ConnectionsView WhatsApp pairing', () => {
  const openWhatsApp = async (user: ReturnType<typeof userEvent.setup>) => {
    const dialog = await openAddDialog(user);
    expect(within(dialog).getByText(copy.whatsappModalBody)).toBeInTheDocument();
    return dialog;
  };

  it('shows QR pairing and closes with the pairing-aware action', async () => {
    const user = userEvent.setup();
    const whatsappState = state({ types: [whatsapp], instances: [] });
    const bridge = makeBridge(whatsappState);
    bridge.connectionsConfigure.mockResolvedValue({
      success: true,
      userMessage: 'WhatsApp saved',
      instance: instance('wa-new', 'whatsapp'),
    });
    bridge.connectionsCall.mockResolvedValue({ success: true, data: { qrDataUrl: 'data:image/png;base64,qr' } });
    renderConnections({ bridge, initialState: whatsappState });
    const dialog = await openWhatsApp(user);
    await user.click(within(dialog).getByRole('button', { name: copy.connect }));
    expect(await within(dialog).findByRole('img', { name: copy.pairingResult })).toHaveAttribute('src', 'data:image/png;base64,qr');
    expect(within(dialog).getByText(copy.pairingWaiting)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: t.actions.close })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: copy.connect })).toBeDisabled();
    expect(bridge.connectionsCall).toHaveBeenCalledWith({
      type: 'whatsapp', actionId: 'whatsapp.start_pairing', connectionId: 'wa-new', input: { method: 'qr' },
    });
    await user.click(within(dialog).getByRole('button', { name: t.actions.close }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('renders pairing codes, waiting state, provider errors, and thrown pairing failures', async () => {
    const user = userEvent.setup();
    const cases: Array<{ result?: CallConnectionActionResult; reject?: boolean; expected: string }> = [
      { result: { success: true, data: { pairingCode: 'ABCD-1234' } }, expected: 'ABCD-1234' },
      { result: { success: true, data: { status: 'starting' } }, expected: copy.pairingWaiting },
      { result: { success: false, userMessage: '' }, expected: 'whatsapp_pairing_failed' },
      { reject: true, expected: copy.statusCheckFailed },
    ];
    for (const pairingCase of cases) {
      const whatsappState = state({ types: [whatsapp], instances: [] });
      const bridge = makeBridge(whatsappState);
      bridge.connectionsConfigure.mockResolvedValue({
        success: true,
        userMessage: 'WhatsApp saved',
        instance: instance('wa-new', 'whatsapp'),
      });
      if (pairingCase.reject) bridge.connectionsCall.mockRejectedValue(new Error('pairing failed'));
      else bridge.connectionsCall.mockResolvedValue(pairingCase.result);
      const mounted = renderConnections({ bridge, initialState: whatsappState });
      const dialog = await openWhatsApp(user);
      await user.click(within(dialog).getByRole('button', { name: copy.connect }));
      expect(await within(dialog).findByText(pairingCase.expected, { exact: false })).toBeInTheDocument();
      expect(within(dialog).getByRole('button', {
        name: pairingCase.result?.success ? t.actions.close : t.actions.cancel,
      })).toBeInTheDocument();
      mounted.unmount();
    }
  });

  it('polls a real connected status, refreshes the matching account, navigates, and clears the interval', async () => {
    const user = userEvent.setup();
    const whatsappState = state({ types: [whatsapp], instances: [] });
    const connectedState = state({ types: [whatsapp], instances: [instance('wa-new', 'whatsapp')] });
    const bridge = makeBridge(whatsappState);
    bridge.connectionsList
      .mockResolvedValueOnce(whatsappState)
      .mockResolvedValueOnce(whatsappState)
      .mockResolvedValueOnce(connectedState);
    bridge.connectionsConfigure.mockResolvedValue({
      success: true,
      userMessage: 'WhatsApp saved',
      instance: instance('wa-new', 'whatsapp'),
    });
    bridge.connectionsCall
      .mockResolvedValueOnce({ success: true, data: { qrDataUrl: 'data:image/png;base64,qr' } })
      .mockResolvedValueOnce({ success: true, userMessage: 'WhatsApp connected', data: { status: 'connected' } });
    let poll: (() => void) | undefined;
    const interval = vi.spyOn(window, 'setInterval').mockImplementation(((callback: TimerHandler, delay?: number) => {
      if (delay === 3000) poll = callback as () => void;
      return 47;
    }) as typeof window.setInterval);
    const clear = vi.spyOn(window, 'clearInterval');
    const handlers = renderConnections({ bridge, initialState: whatsappState });
    const dialog = await openWhatsApp(user);
    await user.click(within(dialog).getByRole('button', { name: copy.connect }));
    await waitFor(() => expect(interval).toHaveBeenCalledWith(expect.any(Function), 3000));
    await act(async () => poll?.());
    await waitFor(() => expect(handlers.onOpenConnection).toHaveBeenCalledWith('wa-new'));
    expect(await screen.findByText('WhatsApp connected')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(clear).toHaveBeenCalledWith(47);
  });

  it('keeps polling through pending, malformed, and rejected checks, then uses fallback navigation and copy', async () => {
    const user = userEvent.setup();
    const whatsappState = state({ types: [whatsapp], instances: [] });
    const bridge = makeBridge(whatsappState);
    bridge.connectionsConfigure.mockResolvedValue({
      success: true,
      userMessage: 'WhatsApp saved',
      instance: instance('wa-fallback', 'whatsapp'),
    });
    bridge.connectionsCall
      .mockResolvedValueOnce({ success: true, data: {} })
      .mockResolvedValueOnce({ success: false, data: { status: 'connected' } })
      .mockResolvedValueOnce({ success: true, data: 'connected' })
      .mockRejectedValueOnce(new Error('temporary poll error'))
      .mockResolvedValueOnce({ success: true, data: { status: 'connected' } });
    let poll: (() => void) | undefined;
    vi.spyOn(window, 'setInterval').mockImplementation(((callback: TimerHandler, delay?: number) => {
      if (delay === 3000) poll = callback as () => void;
      return 89;
    }) as typeof window.setInterval);
    const handlers = renderConnections({ bridge, initialState: whatsappState });
    const dialog = await openWhatsApp(user);
    await user.click(within(dialog).getByRole('button', { name: copy.connect }));
    await waitFor(() => expect(poll).toBeTypeOf('function'));
    await act(async () => poll?.());
    await act(async () => poll?.());
    await act(async () => poll?.());
    await act(async () => poll?.());
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await act(async () => poll?.());
    await waitFor(() => expect(handlers.onOpenConnection).toHaveBeenCalledWith('wa-fallback'));
    expect(await screen.findByText(copy.statusChecked)).toBeInTheDocument();
  });
});

describe('ConnectionsView transient busy and accessibility behavior', () => {
  it('disables mutation actions while a default update is pending', async () => {
    const user = userEvent.setup();
    const selected = instance('custom', 'custom_mail', { label: 'Custom account' });
    const customState = state({ types: [custom], instances: [selected] });
    let resolveMutation: ((value: { success: boolean; userMessage: string }) => void) | undefined;
    const bridge = makeBridge(customState);
    bridge.connectionsSetDefault.mockReturnValue(new Promise((resolve) => { resolveMutation = resolve; }));
    renderConnections({ bridge, initialState: customState, view: 'detail', selectedConnectionId: 'custom' });
    expect(await screen.findByRole('heading', { name: 'Custom account' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: copy.setDefault }));
    expect(screen.getByRole('button', { name: copy.setDefault })).toBeDisabled();
    expect(screen.getByRole('button', { name: copy.checkStatus })).toBeDisabled();
    expect(screen.getByRole('button', { name: copy.disconnect })).toBeDisabled();
    await act(async () => resolveMutation?.({ success: true, userMessage: 'Done' }));
    await waitFor(() => expect(screen.getByRole('button', { name: copy.setDefault })).toBeEnabled());
  });

  it('clears the selected service and closes setup and guide together with Escape', async () => {
    const user = userEvent.setup();
    const setupState = state({ types: [slack], instances: [] });
    renderConnections({ bridge: makeBridge(setupState), initialState: setupState });
    const dialog = await openAddDialog(user);
    const service = within(dialog).getByRole('combobox', { name: copy.service });
    await user.click(service);
    await user.keyboard('{Control>}a{/Control}{Backspace}');
    await user.tab();
    expect(within(dialog).getByRole('button', { name: copy.connect })).toBeDisabled();
    await chooseService(user, 'Slack');
    await user.click(within(dialog).getByRole('button', { name: /setup guide/i }));
    expect(document.querySelector('[aria-label="setup guide fixture"]')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(document.querySelector('[aria-label="setup guide fixture"]')).not.toBeInTheDocument();
  });
});
