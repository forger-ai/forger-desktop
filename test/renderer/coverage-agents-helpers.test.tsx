import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type {
  ConnectionInstance,
  PersonalAgent,
  PersonalAgentConversation,
  PersonalAgentGrantOptionConnection,
  PersonalAgentGroup,
  PersonalAgentMessage,
  PersonalAgentWorkspaceEntry,
} from '@shared/types';
import type { AppDictionary } from '@renderer/i18n';
import {
  WorkspaceTree,
  accessDraftFromAgent,
  compactFileLabel,
  connectionInstanceLabel,
  defaultAccessDraft,
  defaultPersonalAgentRuntime,
  defaultRuntimeForProvider,
  groupAgentsForDisplay,
  isTerminalRunStatus,
  personalAgentRunErrorMessage,
  personalAgentSaveErrorMessage,
  progressMessagesForMessageRun,
  toggleId,
  upsertConversation,
  visiblePeerThreadMessages,
} from '@renderer/views/AgentsView.helpers';

const dictionary = {
  agents: {
    runErrorLlmAuth: 'Connect the provider',
    runErrorCodexCli: 'Install Codex',
    runErrorClaudeCli: 'Install Claude',
    runErrorWorkspaceMissing: 'Workspace missing',
    runErrorRuntimeUnavailable: 'Runtime unavailable',
    runErrorProviderChanged: 'Start a new conversation',
    runErrorGeneric: 'Agent failed',
    runtimeProviderNotConnected: 'Provider not connected',
  },
} as AppDictionary;

const group = (id: string, name: string): PersonalAgentGroup => ({
  id,
  name,
  createdAt: '2026-08-10T00:00:00.000Z',
  updatedAt: '2026-08-10T00:00:00.000Z',
});

const agent = (id: string, name: string, groupId?: string): PersonalAgent => ({
  id,
  name,
  description: '',
  purpose: '',
  instructions: '',
  permissionMode: 'safe',
  networkAccess: false,
  canSpawnAgents: false,
  groupId,
  appIds: [],
  toolIds: [],
  connectionGrants: [],
  peerAgentGrants: [],
  createdAt: '2026-08-10T00:00:00.000Z',
  updatedAt: '2026-08-10T00:00:00.000Z',
});

const conversation = (id: string, updatedAt: string): PersonalAgentConversation => ({
  id,
  agentId: 'agent-1',
  title: id,
  status: 'active',
  origin: 'user',
  readOnly: false,
  createdAt: updatedAt,
  updatedAt,
  messages: [],
});

const message = (
  id: string,
  values: Partial<PersonalAgentMessage> = {},
): PersonalAgentMessage => ({
  id,
  agentId: 'agent-1',
  conversationId: 'conversation-1',
  role: 'assistant',
  kind: 'message',
  authorType: 'agent',
  source: 'human',
  content: id,
  createdAt: '2026-08-10T00:00:00.000Z',
  ...values,
});

const connectionInstance = (
  id: string,
  values: Partial<ConnectionInstance> = {},
): PersonalAgentGrantOptionConnection['instances'][number] => ({
  id,
  type: 'gmail',
  label: '',
  status: 'connected',
  isDefault: false,
  createdAt: '2026-08-10T00:00:00.000Z',
  updatedAt: '2026-08-10T00:00:00.000Z',
  ...values,
});

describe('personal agent grouping and workspace helpers', () => {
  it('sorts populated groups and places unknown or missing groups last', () => {
    const groups = [group('z', 'Zulu'), group('a', 'Alpha'), group('empty', 'Empty')];
    const agents = [
      agent('3', 'Zulu agent', 'a'),
      agent('1', 'Alpha agent', 'a'),
      agent('2', 'Beta agent', 'z'),
      agent('5', 'Missing group agent', 'gone'),
      agent('4', 'No group agent'),
    ];
    expect(groupAgentsForDisplay(agents, groups)).toEqual([
      { groupId: 'a', name: 'Alpha', agents: [agents[1], agents[0]] },
      { groupId: 'z', name: 'Zulu', agents: [agents[2]] },
      { groupId: null, agents: [agents[3], agents[4]] },
    ]);
    expect(groupAgentsForDisplay([agents[1]], groups)).toEqual([
      { groupId: 'a', name: 'Alpha', agents: [agents[1]] },
    ]);
  });

  it('uses the safest available identity label in priority order', () => {
    expect(connectionInstanceLabel(connectionInstance('1', {
      label: 'Label', accountIdentity: { email: 'person@example.com', username: 'person', workspace: 'team', phoneNumber: '+1' },
    }))).toBe('person@example.com');
    expect(connectionInstanceLabel(connectionInstance('2', {
      label: 'Label', accountIdentity: { username: 'person', workspace: 'team', phoneNumber: '+1' },
    }))).toBe('person');
    expect(connectionInstanceLabel(connectionInstance('3', {
      label: 'Label', accountIdentity: { workspace: 'team', phoneNumber: '+1' },
    }))).toBe('team');
    expect(connectionInstanceLabel(connectionInstance('4', {
      label: 'Label', accountIdentity: { phoneNumber: '+1' },
    }))).toBe('+1');
    expect(connectionInstanceLabel(connectionInstance('5', { label: 'Label' }))).toBe('Label');
    expect(connectionInstanceLabel(connectionInstance('fallback', { label: undefined } as Partial<ConnectionInstance>))).toBe('fallback');
  });

  it('renders empty, nested directory, and keyboard-accessible file workspace states', async () => {
    const onOpenFile = vi.fn();
    const { rerender } = render(
      <WorkspaceTree entries={[]} emptyLabel="No files" onOpenFile={onOpenFile} />,
    );
    expect(screen.getByText('No files')).toBeVisible();

    const file: PersonalAgentWorkspaceEntry = { name: 'AGENTS.md', relativePath: 'docs/AGENTS.md', kind: 'file' };
    const entries: PersonalAgentWorkspaceEntry[] = [{
      name: 'docs',
      relativePath: 'docs',
      kind: 'directory',
      children: [file],
    }];
    rerender(
      <WorkspaceTree entries={entries} emptyLabel="No files" selectedPath="docs/AGENTS.md" onOpenFile={onOpenFile} />,
    );
    expect(screen.getByText('docs')).not.toHaveAttribute('role', 'button');
    const fileButton = screen.getByRole('button', { name: 'AGENTS.md' });
    await userEvent.click(fileButton);
    expect(onOpenFile).toHaveBeenLastCalledWith(file);
    fireEvent.keyDown(fileButton, { key: 'Escape' });
    expect(onOpenFile).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(fileButton, { key: 'Enter' });
    fireEvent.keyDown(fileButton, { key: ' ' });
    expect(onOpenFile).toHaveBeenCalledTimes(3);
    fireEvent.click(screen.getByText('docs'));
    expect(onOpenFile).toHaveBeenCalledTimes(3);
  });

  it.each([
    ['completed', true],
    ['failed', true],
    ['canceled', true],
    ['queued', false],
    ['running', false],
    [undefined, false],
  ] as const)('classifies run status %s as terminal=%s', (status, expected) => {
    expect(isTerminalRunStatus(status)).toBe(expected);
  });

  it('upserts a conversation, removes stale duplicates, and sorts newest first', () => {
    const old = conversation('same', '2026-08-10T01:00:00.000Z');
    const other = conversation('other', '2026-08-10T02:00:00.000Z');
    const replacement = conversation('same', '2026-08-10T03:00:00.000Z');
    expect(upsertConversation([old, other], replacement)).toEqual([replacement, other]);
    const newConversation = conversation('new', '2026-08-10T00:00:00.000Z');
    expect(upsertConversation([other], newConversation)).toEqual([other, newConversation]);
  });
});

describe('personal agent access and runtime helpers', () => {
  it('creates safe defaults and clones every mutable grant from an agent', () => {
    expect(defaultAccessDraft()).toEqual({
      permissionMode: 'safe',
      networkAccess: false,
      canSpawnAgents: false,
      groupId: null,
      runtime: defaultPersonalAgentRuntime(),
      appIds: [],
      toolIds: [],
      connectionGrants: [],
      peerAgentGrants: [],
    });

    const source = agent('1', 'Agent');
    source.permissionMode = 'full';
    source.networkAccess = true;
    source.canSpawnAgents = true;
    source.groupId = 'group-1';
    source.runtime = { provider: 'claude', model: 'claude-sonnet-5', effort: 'high', authProfileId: 'profile-1' };
    source.appIds = ['app-1'];
    source.toolIds = ['forger_app_list'];
    source.connectionGrants = [
      { type: 'gmail', actions: ['search'], multiple: true, connectionIds: ['gmail-1'] },
      { type: 'slack', actions: ['post'], multiple: false },
    ];
    source.peerAgentGrants = [{ agentId: 'peer-1', name: 'Peer', criteria: 'Delegate research' }];
    const draft = accessDraftFromAgent(source);
    expect(draft).toEqual({
      permissionMode: 'full',
      networkAccess: true,
      canSpawnAgents: true,
      groupId: 'group-1',
      runtime: source.runtime,
      appIds: ['app-1'],
      toolIds: ['forger_app_list'],
      connectionGrants: source.connectionGrants,
      peerAgentGrants: source.peerAgentGrants,
    });
    expect(draft.runtime).not.toBe(source.runtime);
    expect(draft.appIds).not.toBe(source.appIds);
    expect(draft.connectionGrants[0]).not.toBe(source.connectionGrants[0]);
    expect(draft.connectionGrants[0].actions).not.toBe(source.connectionGrants[0].actions);
    expect(draft.connectionGrants[0].connectionIds).not.toBe(source.connectionGrants[0].connectionIds);
    expect(draft.peerAgentGrants[0]).not.toBe(source.peerAgentGrants[0]);

    const withoutRuntimeOrGroup = accessDraftFromAgent(agent('2', 'Default'));
    expect(withoutRuntimeOrGroup.groupId).toBeNull();
    expect(withoutRuntimeOrGroup.runtime).toEqual(defaultPersonalAgentRuntime());
  });

  it('toggles unique ids and compacts only long file labels', () => {
    expect(toggleId(['a'], 'a', true)).toEqual(['a']);
    expect(toggleId(['a'], 'b', true)).toEqual(['a', 'b']);
    expect(toggleId(['a', 'b'], 'a', false)).toEqual(['b']);
    expect(compactFileLabel('short-name.md')).toBe('short-name.md');
    expect(compactFileLabel('12345678901234567890123456789.md')).toBe('123456789012...123456789.md');
  });

  it('returns provider-specific default runtimes', () => {
    expect(defaultRuntimeForProvider('codex')).toEqual(defaultPersonalAgentRuntime());
    expect(defaultRuntimeForProvider('claude')).toMatchObject({ provider: 'claude' });
    expect(defaultRuntimeForProvider('antigravity')).toMatchObject({ provider: 'antigravity' });
  });
});

describe('personal agent message and error helpers', () => {
  it('prefers visible messages and retains intermediate fallback only when necessary', () => {
    const visible = message('visible', { role: 'assistant', kind: 'message' });
    const intermediate = message('progress', { role: 'assistant', kind: 'intermediate' });
    const system = message('system', { role: 'system', kind: 'message', authorType: 'system' });
    expect(visiblePeerThreadMessages([system, intermediate, visible])).toEqual([visible]);
    expect(visiblePeerThreadMessages([system, intermediate])).toEqual([intermediate]);
    expect(visiblePeerThreadMessages([system])).toEqual([]);
  });

  it('extracts only matching non-duplicate progress from a final assistant message', () => {
    const final = message('final', { runId: 'run-1', content: 'Final useful answer' });
    expect(progressMessagesForMessageRun(message('no-run'), [final])).toEqual([]);
    expect(progressMessagesForMessageRun(message('user', { runId: 'run-1', role: 'user' }), [final])).toEqual([]);
    expect(progressMessagesForMessageRun(message('spoken', { runId: 'run-1', kind: 'spoken' }), [final])).toEqual([]);
    expect(progressMessagesForMessageRun(final, undefined)).toEqual([]);

    const longPrefix = 'Detailed progress '.repeat(6);
    const keep = message('keep', { runId: 'run-1', kind: 'intermediate', content: 'Checking permissions' });
    const exact = message('exact', { runId: 'run-1', kind: 'intermediate', content: 'Final useful answer' });
    const markdownDuplicate = message('markdown', { runId: 'run-1', kind: 'intermediate', content: '**Final** useful [answer](https://example.com)' });
    const longDuplicate = message('long', { runId: 'run-1', kind: 'intermediate', content: `${longPrefix}...` });
    const shortPrefix = message('short', { runId: 'run-1', kind: 'intermediate', content: 'Final...' });
    const empty = message('empty', { runId: 'run-1', kind: 'intermediate', content: '***' });
    const otherRun = message('other-run', { runId: 'run-2', kind: 'intermediate' });
    const wrongRole = message('wrong-role', { runId: 'run-1', role: 'user', kind: 'intermediate' });
    const wrongKind = message('wrong-kind', { runId: 'run-1', kind: 'message' });
    expect(progressMessagesForMessageRun(final, [exact, markdownDuplicate])).toEqual([]);
    expect(progressMessagesForMessageRun({ ...final, content: '***' }, [keep])).toHaveLength(1);
    const result = progressMessagesForMessageRun(
      { ...final, content: `${longPrefix}and the final answer` },
      [keep, exact, markdownDuplicate, longDuplicate, shortPrefix, empty, otherRun, wrongRole, wrongKind],
    );
    expect(result).toEqual([
      { id: 'keep', message: 'Checking permissions', createdAt: keep.createdAt },
      { id: 'exact', message: 'Final useful answer', createdAt: exact.createdAt },
      { id: 'markdown', message: '**Final** useful [answer](https://example.com)', createdAt: markdownDuplicate.createdAt },
      { id: 'short', message: 'Final...', createdAt: shortPrefix.createdAt },
      { id: 'empty', message: '***', createdAt: empty.createdAt },
    ]);
  });

  it.each([
    [undefined, null],
    ['codex_auth_missing', 'Connect the provider'],
    ['claude_auth_missing', 'Connect the provider'],
    ['codex_cli_missing', 'Install Codex'],
    ['claude_cli_missing', 'Install Claude'],
    ['personal_agent_workspace_missing', 'Workspace missing'],
    ['personal_agent_runtime_unavailable', 'Runtime unavailable'],
    ['personal_agent_provider_changed_new_conversation_required', 'Start a new conversation'],
    [' unknown ', 'Agent failed'],
  ] as const)('maps run error %s to user copy', (error, expected) => {
    expect(personalAgentRunErrorMessage(error, dictionary)).toBe(expected);
  });

  it('maps save failures while preserving safe error messages', () => {
    expect(personalAgentSaveErrorMessage(
      new Error('personal_agent_runtime_provider_not_connected'),
      'Fallback',
      dictionary,
    )).toBe('Provider not connected');
    expect(personalAgentSaveErrorMessage(new Error('Useful failure'), 'Fallback', dictionary)).toBe('Useful failure');
    expect(personalAgentSaveErrorMessage('unsafe detail', 'Fallback', dictionary)).toBe('Fallback');
    expect(personalAgentSaveErrorMessage(null, 'Fallback', dictionary)).toBe('Fallback');
  });
});
