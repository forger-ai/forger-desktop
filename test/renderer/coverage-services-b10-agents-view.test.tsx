import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  PersonalAgent,
  PersonalAgentConversation,
  PersonalAgentConversationEvent,
  PersonalAgentGroup,
  PersonalAgentMessage,
  PersonalAgentPeerThread,
  PersonalAgentRoutine,
  PersonalAgentRun,
  PersonalAgentWorkspaceEntry,
  PersonalAgentWorkspaceFile,
  PickedChatFile,
  SidekickState,
  WindowControlState,
} from '@shared/types';
import { getDictionary } from '@renderer/i18n';

const moduleState = vi.hoisted(() => ({ macOs: false }));
const analytics = vi.hoisted(() => ({ personalAgentCreated: vi.fn(), personalAgentMessageSent: vi.fn() }));

vi.mock('@renderer/usage-analytics', () => ({ usageAnalytics: analytics }));

vi.mock('@renderer/views/chat/history-drawer-helpers', async (importOriginal) => ({
  ...await importOriginal<typeof import('@renderer/views/chat/history-drawer-helpers')>(),
  isMacOsPlatform: () => moduleState.macOs,
}));

vi.mock('@renderer/views/AgentsView.helpers', async (importOriginal) => ({
  ...await importOriginal<typeof import('@renderer/views/AgentsView.helpers')>(),
  WorkspaceTree: ({ entries, emptyLabel, onOpenFile }: {
    entries: PersonalAgentWorkspaceEntry[];
    emptyLabel: string;
    onOpenFile: (entry: PersonalAgentWorkspaceEntry) => void;
  }) => entries.length === 0 ? <span>{emptyLabel}</span> : (
    <div aria-label="Mock workspace tree">
      {entries.map((entry) => <button type="button" key={entry.relativePath} onClick={() => onOpenFile(entry)}>{entry.name}</button>)}
    </div>
  ),
}));

vi.mock('@renderer/views/AgentAccessControls', () => ({
  AgentAccessControls: ({ setDraft }: { setDraft: (updater: (current: Record<string, unknown>) => Record<string, unknown>) => void }) => (
    <button type="button" onClick={() => setDraft((current) => ({
      ...current,
      permissionMode: 'unsafe',
      networkAccess: true,
      canSpawnAgents: true,
      groupId: 'group-2',
      runtime: { provider: 'claude', model: 'claude-sonnet', reasoningEffort: 'high' },
      appIds: ['app-1'],
      toolIds: ['forger.memory'],
      connectionGrants: [{ type: 'gmail', actions: ['read'], multiple: false }],
      peerAgentGrants: [{ agentId: 'peer', criteria: 'Review work' }],
    }))}>Mock set access</button>
  ),
}));

vi.mock('@renderer/views/AgentGroupsUi', () => ({
  AgentCreateDialog: ({ accessControls, description, name, onClose, onCreate, onDescriptionChange, onNameChange, onPurposeChange, open, purpose }: any) => open ? (
    <div role="dialog" aria-label="Mock create agent">
      <input aria-label="Create name" value={name} onChange={(event) => onNameChange(event.target.value)} />
      <input aria-label="Create description" value={description} onChange={(event) => onDescriptionChange(event.target.value)} />
      <input aria-label="Create purpose" value={purpose} onChange={(event) => onPurposeChange(event.target.value)} />
      {accessControls}
      <button type="button" onClick={onCreate}>Mock create</button>
      <button type="button" onClick={onClose}>Mock close create</button>
    </div>
  ) : null,
  AgentGroupSelect: ({ setDraft }: any) => <button type="button" onClick={() => setDraft((current: any) => ({ ...current, groupId: 'group-2' }))}>Mock select group</button>,
  AgentGroupsDialog: ({ editingGroupId, error, groupName, groups, onClose, onDelete, onEdit, onGroupNameChange, onSave, open }: any) => open ? (
    <div role="dialog" aria-label="Mock groups">
      {error ? <span>{error}</span> : null}
      <input aria-label="Group name" value={groupName} onChange={(event) => onGroupNameChange(event.target.value)} />
      <span>{editingGroupId ?? 'new-group'}</span>
      <button type="button" onClick={onSave}>Mock save group</button>
      <button type="button" onClick={onClose}>Mock close groups</button>
      {groups.map((group: PersonalAgentGroup) => (
        <div key={group.id}>
          <button type="button" onClick={() => onEdit(group)}>Mock edit {group.name}</button>
          <button type="button" onClick={() => onDelete(group)}>Mock delete {group.name}</button>
        </div>
      ))}
    </div>
  ) : null,
  AgentIdentityChips: ({ agent }: { agent: PersonalAgent }) => <span>Identity {agent.name}</span>,
  AgentsOverview: ({ agents, createdByLabel, error, onCreate, onDelete, onManageGroups, onOpen, renderAccessChips, sections }: any) => (
    <section aria-label="Mock agents overview">
      {error ? <span role="alert">{error}</span> : null}
      <button type="button" onClick={onCreate}>Mock open create</button>
      <button type="button" onClick={onManageGroups}>Mock manage groups</button>
      <output data-testid="section-count">{sections.length}</output>
      {agents.length === 0 ? <span>Mock empty agents</span> : agents.map((agent: PersonalAgent) => (
        <div key={agent.id}>
          <button type="button" onClick={() => onOpen(agent)}>Mock open {agent.name}</button>
          <button type="button" onClick={() => onDelete(agent)}>Mock delete {agent.name}</button>
          <span>{createdByLabel(agent) ?? 'No creator'}</span>
          {renderAccessChips(agent)}
        </div>
      ))}
    </section>
  ),
}));

vi.mock('@renderer/views/AgentRoutinesPanel', async (importOriginal) => ({
  ...await importOriginal<typeof import('@renderer/views/AgentRoutinesPanel')>(),
  AgentRoutinesPanel: ({ onCreate, onDelete, onEdit, onOpenThread, onToggle, routines }: any) => (
    <section aria-label="Mock routines panel">
      <button type="button" onClick={onCreate}>Mock new routine</button>
      {routines.map((routine: PersonalAgentRoutine) => (
        <div key={routine.id}>
          <span>{routine.name}</span>
          <button type="button" onClick={() => onOpenThread(routine)}>Mock open routine {routine.id}</button>
          <button type="button" onClick={() => onToggle(routine)}>Mock toggle routine {routine.id}</button>
          <button type="button" onClick={() => onEdit(routine)}>Mock edit routine {routine.id}</button>
          <button type="button" onClick={() => onDelete(routine)}>Mock delete routine {routine.id}</button>
        </div>
      ))}
    </section>
  ),
  AgentRoutineDialog: ({
    authorizationText, editingRoutine, enabled, frequencyType, intervalMinutes, name, onAuthorizationTextChange,
    missedRunWindowMinutes, onClose, onEnabledChange, onFrequencyTypeChange, onIntervalMinutesChange, onMissedRunPolicyChange,
    onMissedRunWindowMinutesChange, onNameChange, onPromptChange, onSave, onTimeOfDayChange,
    onWeeklyDayChange, open, prompt, timeOfDay, weeklyDay,
  }: any) => open ? (
    <div role="dialog" aria-label="Mock routine dialog">
      <span>{editingRoutine ? `Editing ${editingRoutine.id}` : 'Creating routine'}</span>
      <input aria-label="Routine name" value={name} onChange={(event) => onNameChange(event.target.value)} />
      <input aria-label="Routine prompt" value={prompt} onChange={(event) => onPromptChange(event.target.value)} />
      <input aria-label="Routine interval" value={intervalMinutes} onChange={(event) => onIntervalMinutesChange(event.target.value)} />
      <input aria-label="Routine time" value={timeOfDay} onChange={(event) => onTimeOfDayChange(event.target.value)} />
      <input aria-label="Routine weekday" value={weeklyDay} onChange={(event) => onWeeklyDayChange(Number(event.target.value))} />
      <input aria-label="Routine missed window" value={missedRunWindowMinutes} onChange={(event) => onMissedRunWindowMinutesChange(event.target.value)} />
      <input aria-label="Routine authorization" value={authorizationText} onChange={(event) => onAuthorizationTextChange(event.target.value)} />
      <button type="button" onClick={() => onFrequencyTypeChange('hourly')}>Mock hourly</button>
      <button type="button" onClick={() => onFrequencyTypeChange('interval')}>Mock interval</button>
      <button type="button" onClick={() => onFrequencyTypeChange('daily')}>Mock daily</button>
      <button type="button" onClick={() => onFrequencyTypeChange('weekly')}>Mock weekly</button>
      <button type="button" onClick={() => onMissedRunPolicyChange('skip')}>Mock skip missed</button>
      <button type="button" onClick={() => onMissedRunWindowMinutesChange('45')}>Mock missed window</button>
      <button type="button" onClick={() => onEnabledChange(!enabled)}>Mock toggle enabled</button>
      <button type="button" onClick={onSave}>Mock save routine</button>
      <button type="button" onClick={onClose}>Mock close routine</button>
      <output>{frequencyType}</output>
    </div>
  ) : null,
}));

vi.mock('@renderer/views/AgentConversationHistoryDrawer', () => ({
  AgentConversationHistoryDrawer: ({ collapsedGroups, groupLimits, groups, onClose, onSelectConversation, onShowMore, onToggleGroup, open, reserveTrafficLightSpace }: any) => open ? (
    <div role="dialog" aria-label="Mock history">
      <span>{reserveTrafficLightSpace ? 'Reserved mac space' : 'No mac space'}</span>
      <output data-testid="history-group-count">{groups.length}</output>
      {groups.map((group: any) => <div key={group.id}>
        <button type="button" onClick={() => onToggleGroup(group.id)}>Mock toggle {group.id} {String(collapsedGroups[group.id] ?? false)}</button>
        <button type="button" onClick={() => onShowMore(group.id, 9)}>Mock more {group.id} {groupLimits[group.id] ?? 0}</button>
        {group.items[0] ? <button type="button" onClick={() => onSelectConversation(group.items[0])}>Mock select {group.id}</button> : null}
      </div>)}
      <button type="button" onClick={onClose}>Mock close history</button>
    </div>
  ) : null,
}));

vi.mock('@renderer/views/chat/MarkdownMessage', () => ({ MarkdownMessage: ({ content }: { content: string }) => <span>Markdown {content}</span> }));
vi.mock('@renderer/components/AgentRunActivityReceipt', () => ({ AgentRunActivityReceipt: ({ mode, progressMessages }: any) => <span>Receipt {mode} {progressMessages.length}</span> }));

import { AgentsView } from '@renderer/views/AgentsView';

const t = getDictionary('en');

const agent = (id = 'agent-1', overrides: Partial<PersonalAgent> = {}): PersonalAgent => ({
  id, name: `Agent ${id}`, description: '', purpose: '', instructions: '', permissionMode: 'safe', networkAccess: false,
  canSpawnAgents: false, appIds: [], toolIds: [], connectionGrants: [], peerAgentGrants: [],
  createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-10T00:00:00.000Z', ...overrides,
});

const group = (id = 'group-1', name = `Group ${id}`): PersonalAgentGroup => ({
  id, name, createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-10T00:00:00.000Z',
});

const message = (id: string, overrides: Partial<PersonalAgentMessage> = {}): PersonalAgentMessage => ({
  id, agentId: 'agent-1', conversationId: 'conversation-1', role: 'assistant', kind: 'message', authorType: 'agent',
  source: 'human', content: `Message ${id}`, createdAt: '2026-08-10T10:00:00.000Z', ...overrides,
});

const run = (status: PersonalAgentRun['status'], overrides: Partial<PersonalAgentRun> = {}): PersonalAgentRun => ({
  id: `run-${status}`, agentId: 'agent-1', conversationId: 'conversation-1', status, progress: [],
  createdAt: '2026-08-10T09:00:00.000Z', updatedAt: '2026-08-10T10:00:00.000Z', ...overrides,
});

const conversation = (id = 'conversation-1', overrides: Partial<PersonalAgentConversation> = {}): PersonalAgentConversation => ({
  id, agentId: 'agent-1', title: `Conversation ${id}`, status: 'active', origin: 'user', readOnly: false,
  createdAt: '2026-08-10T09:00:00.000Z', updatedAt: '2026-08-10T10:00:00.000Z', messages: [], ...overrides,
});

const routine = (id = 'routine-1', overrides: Partial<PersonalAgentRoutine> = {}): PersonalAgentRoutine => ({
  id, agentId: 'agent-1', conversationId: 'conversation-1', name: `Routine ${id}`, prompt: 'Do work',
  frequency: { type: 'hourly' }, missedRunPolicy: 'within_window', missedRunWindowMinutes: 30, enabled: true,
  running: false, nextRunAt: null, authorizationText: 'Authorized', createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-10T10:00:00.000Z', ...overrides,
});

const workspaceFile: PersonalAgentWorkspaceFile = {
  agentId: 'agent-1', relativePath: 'AGENTS.md', content: 'Original', updatedAt: '2026-08-10T10:00:00.000Z',
};

const peerThread = (id = 'peer-1', overrides: Partial<PersonalAgentPeerThread> = {}): PersonalAgentPeerThread => ({
  id, callerAgentId: 'agent-1', targetAgentId: 'peer', sourceConversationId: 'conversation-1',
  targetConversationId: 'peer-conversation', title: `Peer ${id}`, status: 'active', createdAt: '2026-08-10T09:00:00.000Z',
  updatedAt: '2026-08-10T10:00:00.000Z', ...overrides,
});

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
};

const sidekickState = (names: Array<[string, string]> = []): SidekickState => ({
  desktopId: 'desktop', servicePort: 4567, detectedUsb: [], sidekicks: names.map(([sidekickId, name]) => ({
    sidekickId, name, status: 'online', lastSeenAt: '2026-08-10T10:00:00.000Z', capabilities: [],
    voicePhase: 'idle', speakerPlayback: { status: 'idle' }, microphoneRecording: { status: 'idle' }, microphoneRecordings: [],
    idleConfig: { screens: ['clock'], rotateSeconds: 15 },
  })),
});

const createBridge = () => {
  const conversationListeners: Array<(event: PersonalAgentConversationEvent) => void> = [];
  const windowListeners: Array<(state: WindowControlState) => void> = [];
  return {
    conversationListeners, windowListeners,
    personalAgentsList: vi.fn(async () => [] as PersonalAgent[]),
    personalAgentGroupsList: vi.fn(async () => [] as PersonalAgentGroup[]),
    personalAgentGrantOptionsList: vi.fn(async () => ({ apps: [], tools: [], connections: [], peerAgents: [] })),
    sidekicksGetState: vi.fn(async () => sidekickState()),
    personalAgentConversationsList: vi.fn(async () => [] as PersonalAgentConversation[]),
    personalAgentWorkspaceList: vi.fn(async () => [] as PersonalAgentWorkspaceEntry[]),
    personalAgentRoutinesList: vi.fn(async () => [] as PersonalAgentRoutine[]),
    onPersonalAgentConversationEvent: vi.fn((listener: (event: PersonalAgentConversationEvent) => void) => {
      conversationListeners.push(listener); return vi.fn();
    }),
    getWindowState: vi.fn(async () => ({ isFullScreen: false }) as WindowControlState),
    onWindowStateChanged: vi.fn((listener: (state: WindowControlState) => void) => { windowListeners.push(listener); return vi.fn(); }),
    personalAgentsCreate: vi.fn(async () => agent('created')),
    personalAgentUpdatePermissions: vi.fn(async () => agent()),
    personalAgentUpdateGroup: vi.fn(async () => agent()),
    personalAgentGroupsCreate: vi.fn(async () => group('created')),
    personalAgentGroupsUpdate: vi.fn(async () => group()),
    personalAgentGroupsDelete: vi.fn(async () => undefined),
    personalAgentsDelete: vi.fn(async () => undefined),
    personalAgentWorkspaceFileRead: vi.fn(async () => workspaceFile),
    personalAgentWorkspaceFileWrite: vi.fn(async () => ({ ...workspaceFile, content: 'Saved' })),
    personalAgentStartConversation: vi.fn(async () => conversation()),
    filesPickForChat: vi.fn(async () => [] as PickedChatFile[]),
    filesReleaseSelections: vi.fn(async () => undefined),
    personalAgentConversationDraftUpdate: vi.fn(async () => undefined),
    personalAgentWakeupCancel: vi.fn(async () => undefined),
    personalAgentRoutinesCreate: vi.fn(async () => routine('created')),
    personalAgentRoutinesUpdate: vi.fn(async () => routine()),
    personalAgentRoutinesSetEnabled: vi.fn(async () => routine()),
    personalAgentRoutinesDelete: vi.fn(async () => undefined),
    personalAgentGetConversation: vi.fn(async () => conversation()),
    personalAgentPeerThreadsList: vi.fn(async () => [] as PersonalAgentPeerThread[]),
    personalAgentPeerThreadGet: vi.fn(async () => peerThread()),
    filesImport: vi.fn(async () => []),
    personalAgentSendMessage: vi.fn(async () => conversation()),
  };
};

const openAgent = async (name = 'Agent agent-1') => userEvent.click(await screen.findByRole('button', { name: `Mock open ${name}` }));
const openTab = async (name: string) => userEvent.click(screen.getByRole('tab', { name }));

describe('AgentsView orchestration', () => {
  let bridge: ReturnType<typeof createBridge>;

  beforeEach(() => {
    moduleState.macOs = false;
    bridge = createBridge();
    Object.defineProperty(window, 'forger', { configurable: true, value: bridge });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    vi.spyOn(window, 'prompt').mockReturnValue('Authorized action');
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => { callback(0); return 1; });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows empty and fatal-load states, tolerates optional bootstrap services, and disposes subscriptions', async () => {
    bridge.personalAgentGrantOptionsList.mockRejectedValueOnce(new Error('grants unavailable'));
    bridge.sidekicksGetState.mockRejectedValueOnce(new Error('sidekicks unavailable'));
    const view = render(<AgentsView t={t} intelligenceProviderConfigured />);
    expect(await screen.findByText('Mock empty agents')).toBeVisible();
    expect(bridge.onPersonalAgentConversationEvent).toHaveBeenCalledOnce();
    view.unmount();
    expect(bridge.onPersonalAgentConversationEvent.mock.results[0]?.value).toHaveBeenCalledOnce();

    bridge.personalAgentsList.mockRejectedValueOnce('fatal load');
    const fallback = render(<AgentsView t={t} intelligenceProviderConfigured />);
    expect(await screen.findByRole('alert')).toHaveTextContent(t.agents.loadError);
    fallback.unmount();

    bridge = createBridge();
    Object.defineProperty(window, 'forger', { configurable: true, value: bridge });
    bridge.personalAgentsList.mockRejectedValueOnce(new Error('fatal error'));
    render(<AgentsView t={t} intelligenceProviderConfigured />);
    expect(await screen.findByRole('alert')).toHaveTextContent('fatal error');
  });

  it('ignores bootstrap completions after unmount and reloads when installed-app grant metadata changes', async () => {
    const pendingAgents = deferred<PersonalAgent[]>();
    bridge.personalAgentsList.mockReturnValueOnce(pendingAgents.promise);
    const view = render(<AgentsView
      t={t}
      intelligenceProviderConfigured
      installedApps={[
        { id: 'full', name: 'Full', description: 'Description', shortDescription: 'Short', status: 'installed' },
        { id: 'missing' },
      ] as never}
    />);
    view.unmount();
    await act(async () => pendingAgents.resolve([]));

    bridge = createBridge();
    Object.defineProperty(window, 'forger', { configurable: true, value: bridge });
    const rejectedAgents = deferred<PersonalAgent[]>();
    bridge.personalAgentsList.mockReturnValueOnce(rejectedAgents.promise);
    const rejectedView = render(<AgentsView t={t} intelligenceProviderConfigured />);
    rejectedView.unmount();
    await act(async () => rejectedAgents.reject(new Error('late bootstrap failure')));

    bridge = createBridge();
    Object.defineProperty(window, 'forger', { configurable: true, value: bridge });
    const mounted = render(<AgentsView t={t} intelligenceProviderConfigured installedApps={[{ id: 'one', status: 'installed' }] as never} />);
    expect(await screen.findByText('Mock empty agents')).toBeVisible();
    mounted.rerender(<AgentsView t={t} intelligenceProviderConfigured installedApps={[{ id: 'two', name: 'Two', status: 'running' }] as never} />);
    await waitFor(() => expect(bridge.personalAgentsList).toHaveBeenCalledTimes(2));
  });

  it('handles macOS window-state rejection and removes the native listener', async () => {
    moduleState.macOs = true;
    bridge.getWindowState.mockRejectedValueOnce(new Error('window state unavailable'));
    const view = render(<AgentsView t={t} intelligenceProviderConfigured />);
    await screen.findByText('Mock empty agents');
    expect(bridge.onWindowStateChanged).toHaveBeenCalledOnce();
    const removeWindowListener = bridge.onWindowStateChanged.mock.results[0]?.value;
    view.unmount();
    expect(removeWindowListener).toHaveBeenCalledOnce();

    bridge = createBridge();
    Object.defineProperty(window, 'forger', { configurable: true, value: bridge });
    const pendingWindowState = deferred<WindowControlState>();
    bridge.getWindowState.mockReturnValueOnce(pendingWindowState.promise);
    const pendingView = render(<AgentsView t={t} intelligenceProviderConfigured />);
    pendingView.unmount();
    await act(async () => pendingWindowState.resolve({ isFullScreen: true }));
  });

  it('renders grouped agents and access variants, creates an agent, and handles create errors', async () => {
    const agents = [
      agent('creator'),
      agent('worker', {
        createdByAgentId: 'creator', groupId: 'group-1', permissionMode: 'unsafe', networkAccess: true,
        runtime: { provider: 'claude', model: 'claude-sonnet', reasoningEffort: 'high' }, appIds: ['a'],
        toolIds: ['forger.memory'], connectionGrants: [{ type: 'gmail', actions: ['read'], multiple: false }],
      }),
      agent('orphan', { createdByAgentId: 'missing' }),
    ];
    bridge.personalAgentsList.mockResolvedValue(agents);
    bridge.personalAgentGroupsList.mockResolvedValue([group()]);
    render(<AgentsView t={t} intelligenceProviderConfigured providerOptions={[{ label: 'Claude Label', value: 'claude' }]} />);
    expect(await screen.findByText(t.agents.createdBy('Agent creator'))).toBeVisible();
    expect(screen.getByText(t.agents.createdBy('missing'))).toBeVisible();
    expect(screen.getByText('Claude Label · claude-sonnet')).toBeVisible();
    expect(screen.getByText(t.agents.expandedPermission)).toBeVisible();
    expect(screen.getByText(t.agents.appsCount(1))).toBeVisible();

    await userEvent.click(screen.getByRole('button', { name: 'Mock open create' }));
    const dialog = screen.getByRole('dialog', { name: 'Mock create agent' });
    await userEvent.type(within(dialog).getByLabelText('Create name'), 'New Agent');
    await userEvent.type(within(dialog).getByLabelText('Create description'), 'Description');
    await userEvent.type(within(dialog).getByLabelText('Create purpose'), 'Purpose');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Mock set access' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Mock create' }));
    await waitFor(() => expect(bridge.personalAgentsCreate).toHaveBeenCalledWith(expect.objectContaining({
      name: 'New Agent', permissionMode: 'unsafe', groupId: 'group-2', appIds: ['app-1'],
    })));
    expect(analytics.personalAgentCreated).toHaveBeenCalledWith({ surface: 'agents', locale: 'en' });

    await userEvent.click(screen.getByRole('button', { name: 'Mock open create' }));
    bridge.personalAgentsCreate.mockRejectedValueOnce(new Error('create rejected'));
    await userEvent.type(screen.getByLabelText('Create name'), 'Rejected');
    await userEvent.click(screen.getByRole('button', { name: 'Mock create' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('create rejected');
    await userEvent.click(screen.getByRole('button', { name: 'Mock close create' }));
  });

  it('creates, renames, and deletes groups and reports their failures', async () => {
    bridge.personalAgentGroupsList.mockResolvedValue([group()]);
    render(<AgentsView t={t} intelligenceProviderConfigured />);
    await screen.findByText('Mock empty agents');
    await userEvent.click(screen.getByRole('button', { name: 'Mock manage groups' }));
    const nameInput = screen.getByLabelText('Group name');
    await userEvent.click(screen.getByRole('button', { name: 'Mock save group' }));
    expect(bridge.personalAgentGroupsCreate).not.toHaveBeenCalled();
    await userEvent.type(nameInput, '  Research  ');
    bridge.sidekicksGetState
      .mockRejectedValueOnce(new Error('sidekick refresh failed'))
      .mockResolvedValueOnce(sidekickState([['sidekick-1', 'Kitchen']]));
    await userEvent.click(screen.getByRole('button', { name: 'Mock save group' }));
    await waitFor(() => expect(bridge.personalAgentGroupsCreate).toHaveBeenCalledWith({ name: 'Research' }));

    await userEvent.click(screen.getByRole('button', { name: 'Mock edit Group group-1' }));
    await userEvent.clear(nameInput);
    await userEvent.type(nameInput, 'Renamed');
    await userEvent.click(screen.getByRole('button', { name: 'Mock save group' }));
    expect(bridge.personalAgentGroupsUpdate).toHaveBeenCalledWith({ groupId: 'group-1', name: 'Renamed' });

    vi.mocked(window.confirm).mockReturnValueOnce(false).mockReturnValueOnce(true).mockReturnValueOnce(true);
    await userEvent.click(screen.getByRole('button', { name: 'Mock delete Group group-1' }));
    expect(bridge.personalAgentGroupsDelete).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Mock delete Group group-1' }));
    expect(bridge.personalAgentGroupsDelete).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole('button', { name: 'Mock edit Group group-1' }));
    await userEvent.click(screen.getByRole('button', { name: 'Mock delete Group group-1' }));
    expect(bridge.personalAgentGroupsDelete).toHaveBeenCalledWith({ groupId: 'group-1' });

    bridge.personalAgentGroupsCreate.mockRejectedValueOnce(new Error('group create failure'));
    await userEvent.type(nameInput, 'Broken');
    await userEvent.click(screen.getByRole('button', { name: 'Mock save group' }));
    expect(await screen.findByText(t.agents.groupSaveError)).toBeVisible();
    bridge.personalAgentGroupsDelete.mockRejectedValueOnce(new Error('group delete failure'));
    await userEvent.click(screen.getByRole('button', { name: 'Mock delete Group group-1' }));
    expect(await screen.findByText(t.agents.groupDeleteError)).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Mock close groups' }));
  });

  it('saves permissions and group changes, then handles deletion confirmation, success, and failure', async () => {
    const primary = agent('agent-1', { groupId: undefined });
    bridge.personalAgentsList.mockResolvedValue([primary, agent('agent-2')]);
    bridge.personalAgentGroupsList.mockResolvedValue([group(), group('group-2')]);
    bridge.personalAgentUpdatePermissions.mockResolvedValue(agent('agent-1', { groupId: undefined, updatedAt: '2026-08-10T11:00:00.000Z' }));
    bridge.personalAgentUpdateGroup.mockResolvedValue(agent('agent-1', { groupId: 'group-2', updatedAt: '2026-08-10T12:00:00.000Z' }));
    render(<AgentsView t={t} intelligenceProviderConfigured />);
    await openAgent();
    await openTab(t.agents.settingsTab);
    await userEvent.click(screen.getByRole('button', { name: 'Mock set access' }));
    const save = screen.getByRole('button', { name: t.agents.saveAccess });
    await waitFor(() => expect(save).toBeEnabled());
    await userEvent.click(save);
    expect(bridge.personalAgentUpdatePermissions).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'agent-1', permissionMode: 'unsafe', canSpawnAgents: true,
    }));
    expect(bridge.personalAgentUpdateGroup).toHaveBeenCalledWith({ agentId: 'agent-1', groupId: 'group-2' });
    await userEvent.click(save);
    expect(bridge.personalAgentUpdateGroup).toHaveBeenCalledTimes(1);

    bridge.personalAgentUpdatePermissions.mockRejectedValueOnce(new Error('access rejected'));
    await userEvent.click(save);
    expect(await screen.findByRole('alert')).toHaveTextContent('access rejected');
    await userEvent.click(screen.getByRole('button', { name: t.actions.back }));

    vi.mocked(window.confirm).mockReturnValueOnce(false).mockReturnValueOnce(true).mockReturnValueOnce(true);
    await userEvent.click(screen.getByRole('button', { name: 'Mock delete Agent agent-2' }));
    expect(bridge.personalAgentsDelete).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Mock delete Agent agent-2' }));
    expect(bridge.personalAgentsDelete).toHaveBeenCalledWith({ agentId: 'agent-2' });
    bridge.personalAgentsDelete.mockRejectedValueOnce('delete rejected');
    await userEvent.click(screen.getByRole('button', { name: 'Mock delete Agent agent-2' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(t.agents.deleteError);
    bridge.personalAgentsDelete.mockRejectedValueOnce(new Error('delete exploded'));
    await userEvent.click(screen.getByRole('button', { name: 'Mock delete Agent agent-2' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('delete exploded');
  });

  it('groups conversation history, reacts to live events, and reports generic run failures once', async () => {
    moduleState.macOs = true;
    const notify = vi.fn();
    const base = conversation('user', { messages: [message('base')] });
    const histories = [
      base,
      conversation('routine', { origin: 'routine' }),
      conversation('agent', { origin: 'agent', readOnly: true }),
      conversation('sidekick-known', { origin: 'sidekick', readOnly: true, sidekickId: 'desk' }),
      conversation('sidekick-unknown', { origin: 'sidekick', readOnly: true }),
    ];
    bridge.personalAgentsList.mockResolvedValue([agent()]);
    bridge.personalAgentConversationsList.mockResolvedValue(histories);
    bridge.personalAgentRoutinesList.mockResolvedValue([routine('another')]);
    bridge.sidekicksGetState.mockResolvedValue(sidekickState([['desk', 'Desk Sidekick']]));
    bridge.getWindowState.mockResolvedValue({ isMaximized: false, isFullScreen: false, usesCustomFrame: true });
    render(<AgentsView t={t} intelligenceProviderConfigured onNotifyForger={notify} />);
    act(() => bridge.conversationListeners.at(-1)?.({ type: 'conversation.updated', conversation: conversation('ignored', { agentId: 'other' }) }));
    await openAgent();
    await waitFor(() => expect(bridge.personalAgentConversationsList).toHaveBeenCalled());

    await userEvent.click(screen.getAllByRole('button', { name: t.agents.historyTab })[0]);
    const history = await screen.findByRole('dialog', { name: 'Mock history' });
    expect(within(history).getByText('Reserved mac space')).toBeVisible();
    expect(within(history).getByTestId('history-group-count')).toHaveTextContent('5');
    await userEvent.click(within(history).getByRole('button', { name: /Mock toggle user-started/ }));
    await userEvent.click(within(history).getByRole('button', { name: /Mock more user-started/ }));
    act(() => bridge.windowListeners.at(-1)?.({ isMaximized: false, isFullScreen: true, usesCustomFrame: true }));
    expect(within(history).getByText('No mac space')).toBeVisible();
    await userEvent.click(within(history).getByRole('button', { name: 'Mock select routine-started' }));
    expect(screen.queryByRole('dialog', { name: 'Mock history' })).not.toBeInTheDocument();
    act(() => bridge.conversationListeners.at(-1)?.({ type: 'conversation.updated', conversation: conversation('different-current') }));
    expect(screen.getByText('Conversation routine')).toBeVisible();
    await userEvent.click(screen.getAllByRole('button', { name: t.agents.historyTab })[1]);
    await userEvent.click(screen.getByRole('button', { name: 'Mock close history' }));
    expect(screen.queryByRole('dialog', { name: 'Mock history' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: t.agents.editAccess }));
    await openTab(t.agents.chatTitle);

    const failed = conversation('routine', { origin: 'routine', activeRun: run('failed', { id: 'failed-generic', error: 'unknown_failure' }) });
    act(() => bridge.conversationListeners.at(-1)?.({ type: 'run.failed', conversation: failed }));
    await waitFor(() => expect(notify).toHaveBeenCalledWith(expect.objectContaining({ auto: true, run: failed.activeRun })));
    act(() => bridge.conversationListeners.at(-1)?.({ type: 'run.failed', conversation: { ...failed, activeRun: { ...failed.activeRun! } } }));
    expect(notify).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole('button', { name: t.sections.chat.notifyForger }));
    expect(notify).toHaveBeenCalledTimes(2);

    const createdRoutine = routine('event-created');
    act(() => bridge.conversationListeners.at(-1)?.({ type: 'routine.updated', conversation: failed, routine: createdRoutine }));
    act(() => bridge.conversationListeners.at(-1)?.({
      type: 'routine.updated', conversation: failed, routine: { ...createdRoutine, name: 'Updated by event', updatedAt: '2026-08-10T13:00:00.000Z' },
    }));
    await openTab(t.agents.routines.tab);
    expect(screen.getByText('Updated by event')).toBeVisible();
  });

  it('falls back when all detail services fail and reports synchronous detail failures', async () => {
    bridge.personalAgentsList.mockResolvedValue([agent()]);
    bridge.personalAgentConversationsList.mockRejectedValueOnce(new Error('conversations unavailable'));
    bridge.personalAgentWorkspaceList.mockRejectedValueOnce(new Error('workspace unavailable'));
    bridge.personalAgentRoutinesList.mockRejectedValueOnce(new Error('routines unavailable'));
    const view = render(<AgentsView t={t} intelligenceProviderConfigured />);
    await openAgent();
    expect(await screen.findByText(t.agents.blankTitle)).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: t.actions.back }));

    bridge.personalAgentConversationsList.mockImplementationOnce(() => { throw new Error('detail exploded'); });
    await openAgent();
    expect(await screen.findByRole('alert')).toHaveTextContent('detail exploded');
    await userEvent.click(screen.getByRole('button', { name: t.actions.back }));
    bridge.personalAgentConversationsList.mockImplementationOnce(() => { throw 'detail string'; });
    await openAgent();
    expect(await screen.findByRole('alert')).toHaveTextContent(t.agents.loadError);
    await userEvent.click(screen.getByRole('button', { name: t.actions.back }));
    bridge.personalAgentConversationsList.mockImplementationOnce(() => { throw new Error('late detail failure'); });
    fireEvent.click(screen.getByRole('button', { name: 'Mock open Agent agent-1' }));
    view.unmount();
    await act(async () => undefined);
  });

  it('opens, edits, saves, closes, and reports workspace file failures', async () => {
    const entries: PersonalAgentWorkspaceEntry[] = [
      { name: 'notes', relativePath: 'notes', kind: 'directory' },
      { name: 'AGENTS.md', relativePath: 'AGENTS.md', kind: 'file' },
    ];
    bridge.personalAgentsList.mockResolvedValue([agent()]);
    bridge.personalAgentConversationsList
      .mockResolvedValueOnce([conversation()])
      .mockResolvedValueOnce([]);
    bridge.personalAgentWorkspaceList.mockResolvedValue(entries);
    render(<AgentsView t={t} intelligenceProviderConfigured />);
    await openAgent();
    await openTab(t.agents.workspaceTab);
    await userEvent.click(await screen.findByRole('button', { name: 'notes' }));
    expect(bridge.personalAgentWorkspaceFileRead).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'AGENTS.md' }));
    expect(await screen.findByDisplayValue('Original')).toBeVisible();
    const editor = screen.getByDisplayValue('Original');
    await userEvent.clear(editor);
    await userEvent.type(editor, 'Changed');
    expect(screen.getByText(t.agents.fileUnsaved)).toBeVisible();
    await userEvent.click(screen.getByTestId('SaveRoundedIcon').closest('button')!);
    expect(bridge.personalAgentWorkspaceFileWrite).toHaveBeenCalledWith({
      agentId: 'agent-1', relativePath: 'AGENTS.md', content: 'Changed',
    });
    expect((await screen.findAllByText(t.agents.fileSaved))[0]).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: t.agents.closeFile }));
    expect(screen.queryByDisplayValue('Saved')).not.toBeInTheDocument();

    bridge.personalAgentWorkspaceFileRead.mockRejectedValueOnce('read failed');
    await userEvent.click(screen.getByRole('button', { name: 'AGENTS.md' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(t.agents.fileOpenError);
    bridge.personalAgentWorkspaceFileRead.mockRejectedValueOnce(new Error('read failed'));
    await userEvent.click(screen.getByRole('button', { name: 'AGENTS.md' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('read failed');
    bridge.personalAgentWorkspaceFileRead.mockResolvedValueOnce(workspaceFile);
    await userEvent.click(screen.getByRole('button', { name: 'AGENTS.md' }));
    const reopened = await screen.findByDisplayValue('Original');
    fireEvent.change(reopened, { target: { value: 'Will fail' } });
    bridge.personalAgentWorkspaceFileWrite.mockRejectedValueOnce('write failed');
    await userEvent.click(screen.getByTestId('SaveRoundedIcon').closest('button')!);
    expect(await screen.findByRole('alert')).toHaveTextContent(t.agents.fileSaveError);
    bridge.personalAgentWorkspaceFileWrite.mockRejectedValueOnce(new Error('write exploded'));
    await userEvent.click(screen.getByTestId('SaveRoundedIcon').closest('button')!);
    expect(await screen.findByRole('alert')).toHaveTextContent('write exploded');
  });

  it('shows the blank-agent provider gate and wakes or starts conversations with success and errors', async () => {
    bridge.personalAgentsList.mockResolvedValue([agent()]);
    const disabled = render(<AgentsView t={t} intelligenceProviderConfigured={false} />);
    await openAgent();
    expect(await screen.findByText(t.agents.blankTitle)).toBeVisible();
    expect(screen.getByText(t.agents.llmRequired)).toBeVisible();
    disabled.unmount();

    bridge = createBridge();
    Object.defineProperty(window, 'forger', { configurable: true, value: bridge });
    bridge.personalAgentsList.mockResolvedValue([agent()]);
    bridge.personalAgentConversationsList.mockResolvedValue([conversation()]);
    const disabledExisting = render(<AgentsView t={t} intelligenceProviderConfigured={false} />);
    await openAgent();
    expect(await screen.findByRole('button', { name: t.agents.newConversation })).toBeDisabled();
    disabledExisting.unmount();

    bridge = createBridge();
    Object.defineProperty(window, 'forger', { configurable: true, value: bridge });
    bridge.personalAgentsList.mockResolvedValue([agent()]);
    bridge.personalAgentStartConversation
      .mockResolvedValueOnce(conversation('woken'))
      .mockRejectedValueOnce(new Error('start rejected'))
      .mockResolvedValueOnce(conversation('new'));
    render(<AgentsView t={t} intelligenceProviderConfigured />);
    await openAgent();
    await userEvent.click(await screen.findByRole('button', { name: t.agents.wakeAgent }));
    expect(bridge.personalAgentStartConversation).toHaveBeenCalledWith({
      agentId: 'agent-1', title: 'Agent agent-1', initialMessage: t.agents.wakeAgentMessage,
    });
    const newConversation = await screen.findByRole('button', { name: t.agents.newConversation });
    await userEvent.click(newConversation);
    expect(await screen.findByRole('alert')).toHaveTextContent('start rejected');
    await userEvent.click(newConversation);
    expect(bridge.personalAgentStartConversation).toHaveBeenLastCalledWith({ agentId: 'agent-1', title: 'Agent agent-1' });
    bridge.personalAgentStartConversation.mockRejectedValueOnce('start string');
    await userEvent.click(newConversation);
    expect(await screen.findByRole('alert')).toHaveTextContent(t.agents.startError);
  });

  it('reports a non-Error wake failure while keeping the blank agent available', async () => {
    bridge.personalAgentsList.mockResolvedValue([agent()]);
    bridge.personalAgentStartConversation
      .mockRejectedValueOnce(new Error('wake exploded'))
      .mockRejectedValueOnce('wake string');
    render(<AgentsView t={t} intelligenceProviderConfigured />);
    await openAgent();
    await userEvent.click(await screen.findByRole('button', { name: t.agents.wakeAgent }));
    expect(await screen.findByRole('alert')).toHaveTextContent('wake exploded');
    await userEvent.click(screen.getByRole('button', { name: t.agents.wakeAgent }));
    expect(await screen.findByRole('alert')).toHaveTextContent(t.agents.startError);
    expect(screen.getByRole('button', { name: t.agents.wakeAgent })).toBeEnabled();
  });

  it('renders message authors, scheduled sources, files, completed activity, and filtered system content', async () => {
    const activeRun = run('completed', {
      id: 'active-run',
      progress: [{ id: 'progress', agentId: 'agent-1', conversationId: 'conversation-1', runId: 'active-run', message: 'Progress', createdAt: '2026-08-10T09:30:00.000Z' }],
      activity: { items: [] },
    });
    const messages = [
      message('human', { role: 'user', authorType: 'human', content: 'Human text', files: [{
        id: 'file-1', messageId: 'human', agentId: 'agent-1', conversationId: 'conversation-1', name: 'very-long-attached-file-name.txt',
        path: 'shared/file.txt', relativePath: 'shared/file.txt', createdAt: '2026-08-10T10:00:00.000Z',
      }] }),
      message('routine-user', { role: 'user', authorType: 'system', source: 'routine', content: 'Routine text' }),
      message('wakeup-user', { role: 'user', authorType: 'system', source: 'scheduled_wakeup', content: 'Wake text' }),
      message('sidekick-user', { role: 'user', authorType: 'system', source: 'sidekick', content: 'Sidekick text' }),
      message('active-answer', { runId: 'active-run', authorAgentName: 'Named author', content: 'Active answer' }),
      message('empty-active-answer', { runId: 'active-run', content: '' }),
      message('old-progress', { runId: 'old-run', kind: 'intermediate', content: 'Old progress' }),
      message('old-answer', { runId: 'old-run', authorAgentId: 'author-id', content: 'Old answer' }),
      message('plain-answer', { authorType: 'system', content: 'Plain answer' }),
      message('assistant-file', { files: [{
        id: 'file-2', messageId: 'assistant-file', agentId: 'agent-1', conversationId: 'conversation-1', name: 'assistant.txt',
        path: 'assistant.txt', relativePath: 'assistant.txt', createdAt: '2026-08-10T10:00:00.000Z',
      }] }),
      message('system-hidden', { role: 'system', content: 'Secret system text' }),
    ];
    bridge.personalAgentsList.mockResolvedValue([agent()]);
    bridge.personalAgentConversationsList.mockResolvedValue([conversation('conversation-1', { messages, activeRun })]);
    render(<AgentsView t={t} intelligenceProviderConfigured />);
    await openAgent();
    expect(await screen.findByText('Human text')).toBeVisible();
    expect(screen.getByText(t.agents.messageBadge.routine)).toBeVisible();
    expect(screen.getByText(t.agents.messageBadge.wakeup)).toBeVisible();
    expect(screen.getByText(t.agents.messageBadge.sidekick)).toBeVisible();
    expect(screen.getByText('Named author')).toBeVisible();
    expect(screen.getByText('author-id')).toBeVisible();
    expect(screen.getAllByText('Receipt completed 1')).toHaveLength(3);
    expect(screen.queryByText('Secret system text')).not.toBeInTheDocument();
    expect(screen.queryByText('Old progress')).not.toBeInTheDocument();

    const messageRow = screen.getByText('Human text').closest('.MuiStack-root');
    const messagesContainer = messageRow?.parentElement?.parentElement as HTMLElement;
    Object.defineProperties(messagesContainer, {
      scrollHeight: { configurable: true, value: 500 },
      clientHeight: { configurable: true, value: 100 },
      scrollTop: { configurable: true, value: 0, writable: true },
    });
    fireEvent.scroll(messagesContainer);
    messagesContainer.scrollTop = 450;
    fireEvent.scroll(messagesContainer);
  });

  it('picks, deduplicates, removes, imports, and sends attachments and text', async () => {
    const picked = (grantId: string, name: string): PickedChatFile => ({
      grantId, name, sizeBytes: 12, modifiedAt: '2026-08-10T10:00:00.000Z', type: 'text/plain',
    });
    bridge.personalAgentsList.mockResolvedValue([agent()]);
    bridge.personalAgentConversationsList.mockResolvedValue([conversation()]);
    bridge.filesPickForChat
      .mockResolvedValueOnce([picked('grant-a', 'a.txt'), picked('grant-b', 'b.txt')])
      .mockResolvedValueOnce([picked('grant-a', 'a.txt'), picked('grant-c', 'c.txt')])
      .mockResolvedValueOnce([picked('grant-d', 'd.txt')]);
    bridge.filesImport.mockResolvedValue([{ id: 'shared-a', name: 'a.txt', relativePath: 'shared/a.txt', sizeBytes: 12, modifiedAt: '2026-08-10T10:00:00.000Z' }]);
    bridge.personalAgentSendMessage.mockResolvedValue(conversation('conversation-1', { messages: [message('sent')] }));
    render(<AgentsView t={t} intelligenceProviderConfigured />);
    await openAgent();
    const attach = () => screen.getByTestId('AttachFileRoundedIcon').closest('button')!;
    await userEvent.click(attach());
    await userEvent.click(attach());
    expect(screen.getByText('a.txt')).toBeVisible();
    expect(screen.getByText('b.txt')).toBeVisible();
    expect(screen.getByText('c.txt')).toBeVisible();
    const bChip = screen.getByText('b.txt').closest('.MuiChip-root')!;
    await userEvent.click(within(bChip as HTMLElement).getByTestId('CancelIcon'));
    expect(bridge.filesReleaseSelections).toHaveBeenCalledWith({ grantIds: ['grant-b'] });

    const composer = screen.getByPlaceholderText(t.agents.messagePlaceholder);
    await userEvent.type(composer, '  Please review  ');
    await userEvent.click(screen.getByTestId('SendRoundedIcon').closest('button')!);
    expect(bridge.filesImport).toHaveBeenCalledWith({ grantIds: ['grant-a', 'grant-c'] });
    expect(bridge.personalAgentSendMessage).toHaveBeenCalledWith({
      conversationId: 'conversation-1', content: 'Please review', sharedFiles: [expect.objectContaining({ id: 'shared-a', source: 'attached' })],
    });
    expect(analytics.personalAgentMessageSent).toHaveBeenCalledWith({ surface: 'agents', locale: 'en' });

    await userEvent.click(attach());
    await userEvent.click(screen.getByTestId('SendRoundedIcon').closest('button')!);
    expect(bridge.personalAgentSendMessage).toHaveBeenLastCalledWith(expect.objectContaining({ content: t.agents.defaultSharedFilesMessage }));

    await userEvent.type(composer, 'Enter message');
    fireEvent.keyDown(composer, { key: 'Enter', shiftKey: true });
    const callsBeforeEnter = bridge.personalAgentSendMessage.mock.calls.length;
    fireEvent.keyDown(composer, { key: 'Enter', shiftKey: false });
    await waitFor(() => expect(bridge.personalAgentSendMessage.mock.calls.length).toBeGreaterThan(callsBeforeEnter));
  });

  it('persists wakeup drafts and handles cancellation failures and success', async () => {
    const now = Date.parse('2026-08-10T10:00:00.000Z');
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const intervalTicks: Array<() => void> = [];
    vi.spyOn(window, 'setInterval').mockImplementation((callback) => {
      intervalTicks.push(callback as () => void);
      return 7;
    });
    const scheduled = conversation('conversation-1', {
      draftMessage: 'Existing draft',
      scheduledWakeup: {
        id: 'wakeup', agentId: 'agent-1', conversationId: 'conversation-1', prompt: 'Continue later',
        dueAt: new Date(Date.now() + 61_000).toISOString(), status: 'scheduled',
        createdAt: '2026-08-10T10:00:00.000Z', updatedAt: '2026-08-10T10:00:00.000Z',
      },
    });
    bridge.personalAgentsList.mockResolvedValue([agent()]);
    bridge.personalAgentConversationsList.mockResolvedValue([scheduled]);
    bridge.personalAgentConversationDraftUpdate.mockRejectedValueOnce(new Error('draft persistence failed'));
    bridge.personalAgentWakeupCancel
      .mockRejectedValueOnce(new Error('cancel rejected'))
      .mockRejectedValueOnce('cancel string')
      .mockResolvedValueOnce(undefined);
    render(<AgentsView t={t} intelligenceProviderConfigured />);
    await openAgent();
    expect(await screen.findByText(t.agents.wakeupWaiting('1m 1s'))).toBeVisible();
    act(() => intervalTicks.forEach((tick) => tick()));
    const composer = await screen.findByPlaceholderText(t.agents.messagePlaceholder);
    expect(composer).toHaveValue('Existing draft');
    fireEvent.keyDown(composer, { key: 'Enter', shiftKey: false });
    expect(bridge.personalAgentSendMessage).not.toHaveBeenCalled();
    await userEvent.type(composer, '!');
    expect(bridge.personalAgentConversationDraftUpdate).toHaveBeenCalledWith({ conversationId: 'conversation-1', draftMessage: 'Existing draft!' });
    const cancel = screen.getByRole('button', { name: t.actions.cancel });
    await userEvent.click(cancel);
    expect(await screen.findByRole('alert')).toHaveTextContent('cancel rejected');
    await userEvent.click(cancel);
    expect(await screen.findByRole('alert')).toHaveTextContent(t.agents.wakeupCancelError);
    await userEvent.click(cancel);
    expect(bridge.personalAgentWakeupCancel).toHaveBeenCalledTimes(3);
    const nearWakeup = {
      ...scheduled,
      scheduledWakeup: {
        ...scheduled.scheduledWakeup!,
        id: 'near-wakeup',
        dueAt: new Date(now + 30_000).toISOString(),
      },
    };
    act(() => bridge.conversationListeners.at(-1)?.({ type: 'conversation.updated', conversation: nearWakeup }));
    expect(await screen.findByText(t.agents.wakeupWaiting('30s'))).toBeVisible();
    act(() => bridge.conversationListeners.at(-1)?.({
      type: 'wakeup.canceled', conversation: { ...scheduled, scheduledWakeup: { ...scheduled.scheduledWakeup!, status: 'canceled' } },
    }));
    expect(screen.queryByRole('button', { name: t.actions.cancel })).not.toBeInTheDocument();
  });

  it('creates and edits every routine frequency and handles routine actions and threads', async () => {
    const routines = [
      routine('local'),
      routine('interval', { conversationId: 'remote-interval', frequency: { type: 'interval', intervalMinutes: 20 }, missedRunWindowMinutes: undefined }),
      routine('daily', { conversationId: 'remote-daily', frequency: { type: 'daily', timeOfDay: undefined }, missedRunWindowMinutes: undefined }),
      routine('weekly', { conversationId: 'remote-weekly', frequency: { type: 'weekly', timeOfDay: undefined, weeklyDay: undefined } }),
    ];
    bridge.personalAgentsList.mockResolvedValue([agent()]);
    bridge.personalAgentConversationsList.mockResolvedValue([conversation('conversation-1')]);
    bridge.personalAgentRoutinesList.mockResolvedValue(routines);
    bridge.personalAgentRoutinesCreate
      .mockResolvedValueOnce(routine('created-interval'))
      .mockResolvedValueOnce(routine('created-daily'))
      .mockResolvedValueOnce(routine('created-weekly'))
      .mockResolvedValueOnce(routine('created-hourly'));
    bridge.personalAgentRoutinesSetEnabled.mockResolvedValue(routine('local', { enabled: false }));
    render(<AgentsView t={t} intelligenceProviderConfigured />);
    await openAgent();
    await openTab(t.agents.routines.tab);

    const createRoutine = async (
      frequency: 'interval' | 'daily' | 'weekly' | 'hourly',
      index: number,
      configure?: () => Promise<void>,
    ) => {
      await userEvent.click(screen.getByRole('button', { name: 'Mock new routine' }));
      await userEvent.click(screen.getByRole('button', { name: 'Mock save routine' }));
      expect(bridge.personalAgentRoutinesCreate).toHaveBeenCalledTimes(index);
      await userEvent.type(screen.getByLabelText('Routine name'), `Created ${frequency}`);
      await userEvent.type(screen.getByLabelText('Routine prompt'), `Prompt ${frequency}`);
      await userEvent.type(screen.getByLabelText('Routine authorization'), `Authorization ${frequency}`);
      await userEvent.click(screen.getByRole('button', { name: `Mock ${frequency}` }));
      if (configure) await configure();
      await userEvent.click(screen.getByRole('button', { name: 'Mock save routine' }));
      await waitFor(() => expect(bridge.personalAgentRoutinesCreate).toHaveBeenCalledTimes(index + 1));
    };

    await createRoutine('interval', 0, async () => {
      const interval = screen.getByLabelText('Routine interval');
      await userEvent.clear(interval);
      await userEvent.type(interval, '20');
    });
    expect(bridge.personalAgentRoutinesCreate.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
      frequency: { type: 'interval', intervalMinutes: 20 }, missedRunPolicy: 'within_window', missedRunWindowMinutes: undefined,
    }));

    await createRoutine('daily', 1, async () => {
      await userEvent.click(screen.getByRole('button', { name: 'Mock skip missed' }));
      await userEvent.clear(screen.getByLabelText('Routine missed window'));
      await userEvent.clear(screen.getByLabelText('Routine time'));
      await userEvent.type(screen.getByLabelText('Routine time'), '25:99');
    });
    expect(bridge.personalAgentRoutinesCreate.mock.calls[1]?.[0]).toEqual(expect.objectContaining({
      frequency: { type: 'daily', timeOfDay: '23:59' }, missedRunPolicy: 'skip', missedRunWindowMinutes: undefined,
    }));

    await createRoutine('weekly', 2, async () => {
      await userEvent.clear(screen.getByLabelText('Routine weekday'));
      await userEvent.type(screen.getByLabelText('Routine weekday'), '9');
      await userEvent.click(screen.getByRole('button', { name: 'Mock missed window' }));
      await userEvent.click(screen.getByRole('button', { name: 'Mock toggle enabled' }));
    });
    expect(bridge.personalAgentRoutinesCreate.mock.calls[2]?.[0]).toEqual(expect.objectContaining({
      frequency: { type: 'weekly', timeOfDay: '09:00', weeklyDay: 6 }, missedRunWindowMinutes: 45, enabled: false,
    }));
    await createRoutine('hourly', 3);

    await userEvent.click(screen.getByRole('button', { name: 'Mock new routine' }));
    await userEvent.type(screen.getByLabelText('Routine name'), 'Failure');
    await userEvent.type(screen.getByLabelText('Routine prompt'), 'Failure prompt');
    await userEvent.type(screen.getByLabelText('Routine authorization'), 'Failure auth');
    bridge.personalAgentRoutinesCreate.mockRejectedValueOnce(new Error('routine exploded'));
    await userEvent.click(screen.getByRole('button', { name: 'Mock save routine' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('routine exploded');
    bridge.personalAgentRoutinesCreate.mockRejectedValueOnce('routine string');
    await userEvent.click(screen.getByRole('button', { name: 'Mock save routine' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(t.agents.routines.saveError);
    await userEvent.click(screen.getByRole('button', { name: 'Mock close routine' }));

    await userEvent.click(screen.getByRole('button', { name: 'Mock edit routine interval' }));
    expect(screen.getByDisplayValue('20')).toBeVisible();
    await userEvent.type(screen.getByLabelText('Routine authorization'), 'Update auth');
    await userEvent.click(screen.getByRole('button', { name: 'Mock save routine' }));
    expect(bridge.personalAgentRoutinesUpdate).toHaveBeenCalledWith(expect.objectContaining({ routineId: 'interval' }));
    for (const id of ['daily', 'weekly'] as const) {
      await userEvent.click(screen.getByRole('button', { name: `Mock edit routine ${id}` }));
      expect(screen.getByDisplayValue('09:00')).toBeVisible();
      await userEvent.click(screen.getByRole('button', { name: 'Mock close routine' }));
    }

    vi.mocked(window.prompt).mockReturnValueOnce(null).mockReturnValueOnce('   ').mockReturnValueOnce('Toggle auth');
    await userEvent.click(screen.getByRole('button', { name: 'Mock toggle routine local' }));
    await userEvent.click(screen.getByRole('button', { name: 'Mock toggle routine local' }));
    expect(bridge.personalAgentRoutinesSetEnabled).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Mock toggle routine local' }));
    expect(bridge.personalAgentRoutinesSetEnabled).toHaveBeenCalledWith({ routineId: 'local', enabled: false, authorizationText: 'Toggle auth' });
    bridge.personalAgentRoutinesSetEnabled.mockRejectedValueOnce(new Error('toggle failed'));
    vi.mocked(window.prompt).mockReturnValueOnce('Toggle failure');
    await userEvent.click(screen.getByRole('button', { name: 'Mock toggle routine local' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('toggle failed');
    bridge.personalAgentRoutinesSetEnabled.mockRejectedValueOnce('toggle string');
    vi.mocked(window.prompt).mockReturnValueOnce('Toggle string failure');
    await userEvent.click(screen.getByRole('button', { name: 'Mock toggle routine local' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(t.agents.routines.updateError);

    vi.mocked(window.confirm).mockReturnValueOnce(false).mockReturnValue(true);
    await userEvent.click(screen.getByRole('button', { name: 'Mock delete routine local' }));
    vi.mocked(window.prompt).mockReturnValueOnce(null).mockReturnValueOnce('Delete auth');
    await userEvent.click(screen.getByRole('button', { name: 'Mock delete routine local' }));
    expect(bridge.personalAgentRoutinesDelete).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Mock delete routine local' }));
    expect(bridge.personalAgentRoutinesDelete).toHaveBeenCalledWith({ routineId: 'local', authorizationText: 'Delete auth' });
    bridge.personalAgentRoutinesDelete.mockRejectedValueOnce('delete routine failed');
    vi.mocked(window.prompt).mockReturnValueOnce('Delete failure');
    await userEvent.click(screen.getByRole('button', { name: 'Mock delete routine local' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(t.agents.routines.deleteError);
    bridge.personalAgentRoutinesDelete.mockRejectedValueOnce(new Error('delete routine exploded'));
    vi.mocked(window.prompt).mockReturnValueOnce('Delete error');
    await userEvent.click(screen.getByRole('button', { name: 'Mock delete routine local' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('delete routine exploded');

    await userEvent.click(screen.getByRole('button', { name: 'Mock open routine local' }));
    expect(screen.getByRole('tab', { name: t.agents.chatTitle })).toHaveAttribute('aria-selected', 'true');
    await openTab(t.agents.routines.tab);
    bridge.personalAgentGetConversation.mockResolvedValueOnce(conversation('remote-interval'));
    await userEvent.click(screen.getByRole('button', { name: 'Mock open routine interval' }));
    expect(await screen.findByText('Conversation remote-interval')).toBeVisible();
    await openTab(t.agents.routines.tab);
    bridge.personalAgentGetConversation.mockRejectedValueOnce(new Error('thread failed'));
    await userEvent.click(screen.getByRole('button', { name: 'Mock open routine daily' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('thread failed');
    bridge.personalAgentGetConversation.mockResolvedValueOnce(null);
    await userEvent.click(screen.getByRole('button', { name: 'Mock open routine weekly' }));
    expect(screen.getByRole('tab', { name: t.agents.routines.tab })).toHaveAttribute('aria-selected', 'true');
    bridge.personalAgentGetConversation.mockRejectedValueOnce('thread string');
    await userEvent.click(screen.getByRole('button', { name: 'Mock open routine weekly' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(t.agents.routines.openThreadError);
  }, 15_000);

  it('renders read-only origins and active, failed, and canceled run states', async () => {
    const sidekick = conversation('sidekick', { origin: 'sidekick', readOnly: true });
    bridge.personalAgentsList.mockResolvedValue([agent()]);
    bridge.personalAgentConversationsList.mockResolvedValue([sidekick]);
    render(<AgentsView t={t} intelligenceProviderConfigured />);
    await openAgent();
    expect(await screen.findByText(t.agents.sidekickReadOnlyThread)).toBeVisible();

    const fromAgent = conversation('sidekick', { origin: 'agent', readOnly: false });
    act(() => bridge.conversationListeners.at(-1)?.({ type: 'conversation.updated', conversation: fromAgent }));
    expect(await screen.findByText(t.agents.readOnlyThread)).toBeVisible();
    const explicitReadOnly = conversation('sidekick', { origin: 'user', readOnly: true });
    act(() => bridge.conversationListeners.at(-1)?.({ type: 'conversation.updated', conversation: explicitReadOnly }));
    expect(await screen.findByText(t.agents.readOnlyThread)).toBeVisible();

    const running = conversation('sidekick', { readOnly: false, activeRun: run('running', {
      progress: [{ id: 'live', agentId: 'agent-1', conversationId: 'sidekick', runId: 'run-running', message: 'Live', createdAt: '2026-08-10T10:00:00.000Z' }],
    }) });
    act(() => bridge.conversationListeners.at(-1)?.({ type: 'run.started', conversation: running }));
    expect(await screen.findByText('Receipt live 1')).toBeVisible();
    expect(screen.getByPlaceholderText(t.agents.messagePlaceholder)).toBeDisabled();

    const runningWithMessage = { ...running, messages: [message('visible-running', { conversationId: 'sidekick' })] };
    act(() => bridge.conversationListeners.at(-1)?.({ type: 'run.progress', conversation: runningWithMessage }));
    expect(await screen.findByText('Markdown Message visible-running')).toBeVisible();

    const failedKnown = conversation('sidekick', {
      title: 'Failed known',
      updatedAt: '2026-08-10T12:00:00.000Z',
      messages: [message('failed-visible', { conversationId: 'sidekick' })],
      activeRun: run('failed', { error: 'codex_auth_missing' }),
    });
    act(() => bridge.conversationListeners.at(-1)?.({ type: 'run.failed', conversation: failedKnown }));
    expect(await screen.findByText('Failed known')).toBeVisible();
    expect(await screen.findByText('Markdown Message failed-visible')).toBeVisible();
    await waitFor(() => expect(document.body.textContent).toContain(t.agents.runErrorLlmAuth));
    const failedEmpty = conversation('sidekick', {
      title: 'Failed empty', updatedAt: '2026-08-10T13:00:00.000Z', activeRun: run('failed', { error: 'codex_auth_missing' }),
    });
    act(() => bridge.conversationListeners.at(-1)?.({ type: 'run.failed', conversation: failedEmpty }));
    expect(await screen.findByText('Failed empty')).toBeVisible();
    await waitFor(() => expect(document.body.textContent).toContain(t.agents.runErrorLlmAuth));
    const canceled = conversation('sidekick', { activeRun: run('canceled') });
    act(() => bridge.conversationListeners.at(-1)?.({ type: 'run.canceled', conversation: canceled }));
    expect(await screen.findByText(t.agents.noMessages)).toBeVisible();
  });

  it('loads nested peer threads, opens them by pointer and keyboard, and reports failures', async () => {
    const child = peerThread('child', { callerAgentName: 'Child caller', targetAgentName: 'Child target' });
    const root = peerThread('root', { children: [child] });
    bridge.personalAgentsList.mockResolvedValue([agent()]);
    bridge.personalAgentConversationsList.mockResolvedValue([conversation('conversation-1', { peerThreads: [root] })]);
    bridge.personalAgentPeerThreadsList.mockRejectedValueOnce(new Error('peer list unavailable'));
    bridge.personalAgentPeerThreadGet
      .mockResolvedValueOnce(peerThread('root', { messages: [] }))
      .mockResolvedValueOnce(peerThread('child', {
        callerAgentName: 'Child caller', targetAgentName: 'Child target',
        messages: [message('peer-intermediate', { kind: 'intermediate', content: 'Peer progress only' })],
      }))
      .mockRejectedValueOnce(new Error('peer open failed'));
    render(<AgentsView t={t} intelligenceProviderConfigured />);
    await openAgent();
    expect(await screen.findByText('Peer root')).toBeVisible();
    expect(screen.getByText('Peer child')).toBeVisible();

    const rootRow = screen.getByText('Peer root').closest('[role="button"]')!;
    await userEvent.click(rootRow);
    let dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(t.agents.peerThreadEmpty)).toBeVisible();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    const childRow = screen.getByText('Peer child').closest('[role="button"]')!;
    fireEvent.keyDown(childRow, { key: 'Enter' });
    dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Peer progress only')).toBeVisible();
    expect(within(dialog).getByText('Child caller -> Child target')).toBeVisible();
    await userEvent.click(within(dialog).getByRole('button', { name: t.actions.close }));

    fireEvent.keyDown(rootRow, { key: ' ' });
    expect(await screen.findByRole('alert')).toHaveTextContent('peer open failed');
    bridge.personalAgentPeerThreadGet.mockRejectedValueOnce('peer open string');
    fireEvent.keyDown(rootRow, { key: 'Enter' });
    expect(await screen.findByRole('alert')).toHaveTextContent(t.agents.openThreadError);
    fireEvent.keyDown(rootRow, { key: 'Escape' });
    expect(bridge.personalAgentPeerThreadGet).toHaveBeenCalledTimes(4);
  });

  it('ignores late peer-list completions and falls back to an empty snapshot after list failure', async () => {
    bridge.personalAgentsList.mockResolvedValue([agent()]);
    bridge.personalAgentConversationsList.mockResolvedValue([conversation()]);
    bridge.personalAgentPeerThreadsList.mockRejectedValueOnce(new Error('no peer snapshot'));
    const empty = render(<AgentsView t={t} intelligenceProviderConfigured />);
    await openAgent();
    await waitFor(() => expect(bridge.personalAgentPeerThreadsList).toHaveBeenCalledOnce());
    expect(bridge.personalAgentPeerThreadGet).not.toHaveBeenCalled();
    empty.unmount();

    bridge = createBridge();
    Object.defineProperty(window, 'forger', { configurable: true, value: bridge });
    bridge.personalAgentsList.mockResolvedValue([agent()]);
    bridge.personalAgentConversationsList.mockResolvedValue([conversation()]);
    const pendingSuccess = deferred<PersonalAgentPeerThread[]>();
    bridge.personalAgentPeerThreadsList.mockReturnValueOnce(pendingSuccess.promise);
    const success = render(<AgentsView t={t} intelligenceProviderConfigured />);
    await openAgent();
    await waitFor(() => expect(bridge.personalAgentPeerThreadsList).toHaveBeenCalledOnce());
    success.unmount();
    await act(async () => pendingSuccess.resolve([peerThread()]));

    bridge = createBridge();
    Object.defineProperty(window, 'forger', { configurable: true, value: bridge });
    bridge.personalAgentsList.mockResolvedValue([agent()]);
    bridge.personalAgentConversationsList.mockResolvedValue([conversation()]);
    const pendingFailure = deferred<PersonalAgentPeerThread[]>();
    bridge.personalAgentPeerThreadsList.mockReturnValueOnce(pendingFailure.promise);
    const failure = render(<AgentsView t={t} intelligenceProviderConfigured />);
    await openAgent();
    await waitFor(() => expect(bridge.personalAgentPeerThreadsList).toHaveBeenCalledOnce());
    failure.unmount();
    await act(async () => pendingFailure.reject(new Error('late peer failure')));
  });

  it('reports import and send failures while preserving pending content', async () => {
    const picked: PickedChatFile = { grantId: 'grant', name: 'failure.txt', sizeBytes: 12, modifiedAt: '2026-08-10T10:00:00.000Z', type: 'text/plain' };
    bridge.personalAgentsList.mockResolvedValue([agent()]);
    bridge.personalAgentConversationsList.mockResolvedValue([conversation()]);
    bridge.filesPickForChat.mockResolvedValue([picked]);
    bridge.filesImport.mockRejectedValueOnce(new Error('import failed')).mockResolvedValueOnce([]);
    bridge.personalAgentSendMessage.mockRejectedValueOnce('send failed');
    const view = render(<AgentsView t={t} intelligenceProviderConfigured />);
    await openAgent();
    await userEvent.click(screen.getByTestId('AttachFileRoundedIcon').closest('button')!);
    await userEvent.click(screen.getByTestId('SendRoundedIcon').closest('button')!);
    expect(await screen.findByRole('alert')).toHaveTextContent('import failed');
    await userEvent.click(screen.getByTestId('SendRoundedIcon').closest('button')!);
    expect(await screen.findByRole('alert')).toHaveTextContent(t.agents.sendError);
    bridge.filesReleaseSelections.mockRejectedValueOnce(new Error('release failed'));
    view.unmount();
    await waitFor(() => expect(bridge.filesReleaseSelections).toHaveBeenCalledWith({ grantIds: ['grant'] }));
  });
});
