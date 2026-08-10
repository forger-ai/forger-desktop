import { describe, expect, it, vi } from 'vitest';
import type {
  AgentToolDefinition,
  AgentToolPackageDefinition,
  PersonalAgentConversation,
  PersonalAgentMessage,
  PersonalAgentRun,
  Workflow,
  WorkflowEdge,
  WorkflowNode,
} from '@shared/types';
import type { AppDictionary } from '@renderer/i18n';
import {
  isOpenableError,
  isRetryableInstallError,
  isUpdateError,
} from '@renderer/app-error-actions';
import { appExecutionTooltip } from '@renderer/app-execution-labels';
import {
  compactCategoryLabel,
  compactFileName,
  formatBytes,
} from '@renderer/views/chat-view-helpers';
import {
  formatRelativeHistoryTime,
  historyUpdatedAtTimestamp,
  isMacOsPlatform,
  sortItemsByRecentActivity,
} from '@renderer/views/chat/history-drawer-helpers';
import {
  mergeConversationSnapshots,
  newerConversation,
} from '@renderer/stores/personal-agent-conversation-snapshots';
import {
  localizedPackageCopy,
  localizedToolCopy,
  requiresApproval,
  riskColor,
} from '@renderer/views/tools/tool-helpers';
import {
  createDraftNode,
  draftFromWorkflow,
  draftToUpsertInput,
  edgeKey,
  emptyDraft,
  nextNodeId,
} from '@renderer/views/workflows/workflow-draft';

const dictionary = {
  actions: { error: 'Execution error' },
  appExecution: {
    startingForger: 'Starting in Forger',
    startingLocalNetwork: 'Starting on local network',
    startingRemoteTunnel: 'Starting remote tunnel',
    runningForger: 'Running in Forger',
    runningLocalNetwork: 'Running on local network',
    runningRemoteTunnel: 'Running remotely',
  },
  sections: {
    tools: {
      packages: {
        official: { name: 'Localized package', description: 'Localized package description' },
      },
      definitions: {
        known: { name: 'Localized tool', description: 'Localized tool description' },
      },
    },
  },
} as AppDictionary;

const messageAt = (createdAt: string, id = createdAt): PersonalAgentMessage => ({
  id,
  agentId: 'agent-1',
  conversationId: 'conversation-1',
  role: 'assistant',
  kind: 'text',
  authorType: 'agent',
  source: 'chat',
  content: id,
  createdAt,
});

const runAt = (status: PersonalAgentRun['status'], updatedAt: string): PersonalAgentRun => ({
  id: `run-${status}`,
  agentId: 'agent-1',
  conversationId: 'conversation-1',
  status,
  progress: [],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt,
});

const conversation = (
  id: string,
  updatedAt: string,
  options: { messages?: PersonalAgentMessage[]; activeRun?: PersonalAgentRun } = {},
): PersonalAgentConversation => ({
  id,
  agentId: 'agent-1',
  title: id,
  status: 'active',
  origin: 'user',
  readOnly: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt,
  messages: options.messages ?? [],
  activeRun: options.activeRun,
});

describe('renderer core utility behavior', () => {
  it('classifies the actionable app error states', () => {
    expect(isOpenableError({ status: 'error', lastErrorOperation: undefined, privateLocal: false })).toBe(true);
    expect(isOpenableError({ status: 'error', lastErrorOperation: 'open', privateLocal: false })).toBe(true);
    expect(isOpenableError({ status: 'error', lastErrorOperation: 'runtime', privateLocal: false })).toBe(true);
    expect(isOpenableError({ status: 'error', lastErrorOperation: 'install', privateLocal: false })).toBe(false);
    expect(isOpenableError({ status: 'ready', lastErrorOperation: 'open', privateLocal: false })).toBe(false);

    expect(isUpdateError({ status: 'error', lastErrorOperation: 'update', privateLocal: false })).toBe(true);
    expect(isUpdateError({ status: 'error', lastErrorOperation: 'install', privateLocal: false })).toBe(false);
    expect(isUpdateError({ status: 'ready', lastErrorOperation: 'update', privateLocal: false })).toBe(false);

    expect(isRetryableInstallError({ status: 'error', lastErrorOperation: 'install', privateLocal: false })).toBe(true);
    expect(isRetryableInstallError({ status: 'error', lastErrorOperation: 'update', privateLocal: false })).toBe(false);
    expect(isRetryableInstallError({ status: 'ready', lastErrorOperation: 'install', privateLocal: false })).toBe(false);
  });

  it('maps every observable app execution phase and mode to its label', () => {
    const base = { localNetworkShare: undefined, remoteNetworkShare: undefined };
    expect(appExecutionTooltip({ ...base, status: 'ready' }, dictionary)).toBeUndefined();
    expect(appExecutionTooltip({ ...base, status: 'error' }, dictionary)).toBe('Execution error');
    expect(appExecutionTooltip({ ...base, status: 'conflict' }, dictionary)).toBe('Execution error');
    expect(appExecutionTooltip({ ...base, status: 'installing' }, dictionary)).toBe('Starting in Forger');
    expect(appExecutionTooltip({ ...base, status: 'running' }, dictionary)).toBe('Running in Forger');
    expect(appExecutionTooltip({ ...base, status: 'ready' }, dictionary, { startingInForger: true })).toBe('Starting in Forger');
    expect(appExecutionTooltip({
      ...base,
      status: 'ready',
      localNetworkShare: { active: true },
    }, dictionary)).toBe('Running on local network');
    expect(appExecutionTooltip({
      ...base,
      status: 'ready',
      remoteNetworkShare: { active: false, state: 'preparing' },
    }, dictionary)).toBe('Starting remote tunnel');
    expect(appExecutionTooltip({
      ...base,
      status: 'ready',
      remoteNetworkShare: { active: true, state: 'waiting_for_session' },
    }, dictionary)).toBe('Running remotely');
    expect(appExecutionTooltip({
      ...base,
      status: 'ready',
      remoteNetworkShare: { active: true, state: 'connected' },
    }, dictionary)).toBe('Running remotely');
    expect(appExecutionTooltip({
      ...base,
      status: 'running',
      remoteNetworkShare: { active: false, state: 'error' },
    }, dictionary)).toBe('Execution error');
  });

  it('formats sizes, file names, and category labels across their boundaries', () => {
    expect(formatBytes(Number.NaN)).toBe('0 B');
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(-1)).toBe('0 B');
    expect(formatBytes(1)).toBe('1 B');
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(1024 ** 2 * 2.5)).toBe('2.5 MB');
    expect(formatBytes(1024 ** 4)).toBe('1024.0 GB');

    expect(compactFileName('short.txt')).toBe('short.txt');
    expect(compactFileName('1234567890123456789.txt')).toBe('123456789012345678....txt');
    expect(compactFileName('123456789012345678901234')).toBe('123456789012345678901234');
    expect(compactFileName('1234567890123456789012345')).toBe('123456789012345678901234...');
    expect(compactFileName('.hiddenfilename')).toBe('.hiddenfilename');

    const categories = [{ path: 'projects/current', name: 'Current', parentPath: 'projects' }];
    expect(compactCategoryLabel('', categories, 'All files')).toBe('All files');
    expect(compactCategoryLabel('projects/current', categories, 'All files')).toBe('Current');
    expect(compactCategoryLabel('projects/archive', categories, 'All files')).toBe('projects / archive');
  });

  it('sorts and formats conversation history timestamps deterministically', () => {
    const platform = vi.spyOn(window.navigator, 'platform', 'get');
    platform.mockReturnValue('MacIntel');
    expect(isMacOsPlatform()).toBe(true);
    platform.mockReturnValue('Win32');
    expect(isMacOsPlatform()).toBe(false);

    expect(historyUpdatedAtTimestamp('invalid')).toBe(0);
    expect(historyUpdatedAtTimestamp('2026-01-02T00:00:00.000Z')).toBe(Date.parse('2026-01-02T00:00:00.000Z'));
    expect(sortItemsByRecentActivity([
      { id: 'old', updatedAt: '2026-01-01T00:00:00.000Z' },
      { id: 'invalid', updatedAt: 'not-a-date' },
      { id: 'new', updatedAt: '2026-01-03T00:00:00.000Z' },
    ]).map((item) => item.id)).toEqual(['new', 'old', 'invalid']);

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-10T12:00:00.000Z'));
    expect(formatRelativeHistoryTime('invalid', 'now')).toBe('');
    expect(formatRelativeHistoryTime('2026-08-10T12:01:00.000Z', 'now')).toBe('now');
    expect(formatRelativeHistoryTime('2026-08-10T11:59:31.000Z', 'now')).toBe('now');
    expect(formatRelativeHistoryTime('2026-08-10T11:58:00.000Z', 'now')).toBe('2m');
    expect(formatRelativeHistoryTime('2026-08-10T10:00:00.000Z', 'now')).toBe('2h');
    expect(formatRelativeHistoryTime('2026-08-08T12:00:00.000Z', 'now')).toBe('2d');
    expect(formatRelativeHistoryTime('2026-07-27T12:00:00.000Z', 'now')).toBe('2w');
    expect(formatRelativeHistoryTime('2026-06-10T12:00:00.000Z', 'now')).toBe('2mo');
    expect(formatRelativeHistoryTime('2024-08-10T12:00:00.000Z', 'now')).toBe('2y');
    vi.useRealTimers();
  });

  it('chooses and merges the freshest complete conversation snapshots', () => {
    const baseTime = '2026-08-10T10:00:00.000Z';
    const earlier = conversation('same', '2026-08-10T09:00:00.000Z');
    const later = conversation('same', baseTime);
    expect(newerConversation(earlier, later)).toBe(later);
    expect(newerConversation(later, earlier)).toBe(later);

    const running = conversation('same', baseTime, { activeRun: runAt('running', baseTime) });
    const completed = conversation('same', baseTime, { activeRun: runAt('completed', baseTime) });
    const failed = conversation('same', baseTime, { activeRun: runAt('failed', baseTime) });
    const canceled = conversation('same', baseTime, { activeRun: runAt('canceled', baseTime) });
    expect(newerConversation(running, completed)).toBe(completed);
    expect(newerConversation(completed, running)).toBe(completed);
    expect(newerConversation(running, failed)).toBe(failed);
    expect(newerConversation(running, canceled)).toBe(canceled);

    const oneMessage = conversation('same', baseTime, { messages: [messageAt(baseTime, 'one')] });
    const twoMessages = conversation('same', baseTime, {
      messages: [messageAt(baseTime, 'one'), messageAt(baseTime, 'two')],
    });
    expect(newerConversation(oneMessage, twoMessages)).toBe(twoMessages);
    expect(newerConversation(twoMessages, oneMessage)).toBe(twoMessages);
    expect(newerConversation(oneMessage, { ...oneMessage })).not.toBe(oneMessage);

    const newestByMessage = conversation('message-new', '2026-08-10T08:00:00.000Z', {
      messages: [messageAt('2026-08-10T12:00:00.000Z')],
    });
    const newestByRun = conversation('run-new', '2026-08-10T08:00:00.000Z', {
      activeRun: runAt('running', '2026-08-10T11:00:00.000Z'),
    });
    const merged = mergeConversationSnapshots(
      [earlier, newestByRun],
      [later, newestByMessage],
    );
    expect(merged.map((item) => item.id)).toEqual(['message-new', 'run-new', 'same']);
    expect(merged.at(-1)).toBe(later);
  });

  it('resolves tool risk, approval, and localized copy with fallbacks', () => {
    const high = { id: 'known', risk: 'alto', defaultRequiresApproval: true, name: 'Known', description: 'Known description' } as AgentToolDefinition;
    const medium = { ...high, id: 'medium', risk: 'medio' } as AgentToolDefinition;
    const low = { ...high, id: 'low', risk: 'bajo' } as AgentToolDefinition;
    expect(riskColor(high.risk)).toBe('error');
    expect(riskColor(medium.risk)).toBe('warning');
    expect(riskColor(low.risk)).toBe('success');
    expect(requiresApproval({}, high)).toBe(true);
    expect(requiresApproval({ known: false }, high)).toBe(false);

    const localizedPackage = { id: 'official', name: 'Official', description: 'Official description' } as AgentToolPackageDefinition;
    const fallbackPackage = { id: 'custom', name: 'Custom', description: 'Custom description' } as AgentToolPackageDefinition;
    expect(localizedPackageCopy(dictionary, localizedPackage)).toEqual({
      name: 'Localized package',
      description: 'Localized package description',
    });
    expect(localizedPackageCopy(dictionary, fallbackPackage)).toEqual({
      name: 'Custom',
      description: 'Custom description',
    });
    expect(localizedToolCopy(dictionary, high)).toEqual({
      name: 'Localized tool',
      description: 'Localized tool description',
    });
    expect(localizedToolCopy(dictionary, low)).toEqual({
      name: 'Known',
      description: 'Known description',
    });
  });

  it('round-trips workflow drafts and creates every supported node kind', () => {
    expect(emptyDraft()).toEqual({
      name: '',
      description: '',
      trigger: { type: 'manual' },
      nodes: [],
      edges: [],
      enabled: true,
    });

    const nodes: WorkflowNode[] = [{
      id: 'paso2',
      name: 'Existing',
      type: 'condition',
      expression: { left: '', operator: 'is_not_empty' },
    }];
    const edges: WorkflowEdge[] = [{ from: 'root', to: 'paso2', condition: 'success' }];
    const workflow: Workflow = {
      id: 'workflow-1',
      name: 'Workflow',
      description: undefined,
      trigger: { type: 'manual' },
      nodes,
      edges,
      enabled: true,
      running: false,
      nextRunAt: null,
      createdAt: '2026-08-10T00:00:00.000Z',
      updatedAt: '2026-08-10T00:00:00.000Z',
    };
    const draft = draftFromWorkflow(workflow);
    expect(draft).toEqual({
      id: 'workflow-1',
      name: 'Workflow',
      description: '',
      trigger: { type: 'manual' },
      nodes,
      edges,
      enabled: true,
    });
    expect(draft.nodes).not.toBe(nodes);
    expect(draft.nodes[0]).not.toBe(nodes[0]);
    expect(draft.edges).not.toBe(edges);
    expect(draft.edges[0]).not.toBe(edges[0]);

    expect(draftToUpsertInput({ ...draft, description: '  Useful flow  ' })).toEqual({
      id: 'workflow-1',
      name: 'Workflow',
      description: 'Useful flow',
      trigger: { type: 'manual' },
      nodes: draft.nodes,
      edges: draft.edges,
      enabled: true,
    });
    const withoutOptionals = draftToUpsertInput({ ...emptyDraft(), description: '   ' });
    expect(withoutOptionals).not.toHaveProperty('id');
    expect(withoutOptionals).not.toHaveProperty('description');

    expect(nextNodeId([], 'paso')).toBe('paso1');
    expect(nextNodeId(nodes, 'paso')).toBe('paso3');
    expect(createDraftNode('llm_agent', [], 'Agent')).toMatchObject({
      id: 'paso1', name: 'Agent 1', type: 'llm_agent', prompt: '', toolIds: [], appIds: [], connectionGrants: [], position: { x: 80, y: 80 },
    });
    expect(createDraftNode('forger_agent', nodes, 'Forger')).toMatchObject({
      id: 'paso3', name: 'Forger 2', type: 'forger_agent', agentId: '', prompt: '', position: { x: 340, y: 80 },
    });
    expect(createDraftNode('forger_tool', [nodes[0], nodes[0]], 'Tool')).toMatchObject({
      id: 'paso3', name: 'Tool 3', type: 'forger_tool', toolId: '', input: {}, position: { x: 600, y: 80 },
    });
    expect(createDraftNode('connection', [nodes[0], nodes[0], nodes[0], nodes[0]], 'Connection')).toMatchObject({
      id: 'paso5', name: 'Connection 5', type: 'connection', connectionType: '', actionId: '', input: {}, position: { x: 80, y: 240 },
    });
    expect(createDraftNode('condition', [], 'Condition')).toMatchObject({
      id: 'paso1', name: 'Condition 1', type: 'condition', expression: { left: '', operator: 'is_not_empty' }, position: { x: 80, y: 80 },
    });
    expect(edgeKey(edges[0])).toBe('root__paso2');
  });
});
