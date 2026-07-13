import type { BrowserWindow } from 'electron';

import { IPC_CHANNELS } from '../shared/ipc';
import type {
  AgentRunActivity,
  AppCodexConversationEvent,
  AppCodexTaskEvent,
  ChatRunEvent,
  LlmRunSnapshotItem,
  LlmRunStatus,
  LlmRunsSnapshot,
  PersonalAgentConversationEvent,
} from '../shared/types';

interface LlmRunsStoreOptions {
  getMainWindow: () => BrowserWindow | null;
  now?: () => Date;
}

interface AppRunContext {
  appName?: string;
}

interface PersonalRunContext {
  agentName?: string;
}

const ACTIVE_STATUSES = new Set<LlmRunStatus>(['queued', 'running', 'needs_permission']);
const TERMINAL_STATUSES = new Set<LlmRunStatus>(['completed', 'failed', 'canceled']);

export class LlmRunsStore {
  private readonly runs = new Map<string, LlmRunSnapshotItem>();

  public constructor(private readonly options: LlmRunsStoreOptions) {}

  public snapshot(): LlmRunsSnapshot {
    const items = Array.from(this.runs.values())
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    return {
      items,
      activeCount: items.filter((item) => ACTIVE_STATUSES.has(item.status)).length,
      errorCount: items.filter((item) => item.status === 'failed').length,
      updatedAt: this.isoNow(),
    };
  }

  public recordPersonalAgentConversationEvent(
    event: PersonalAgentConversationEvent,
    context: PersonalRunContext = {},
  ): LlmRunsSnapshot | null {
    const run = event.run ?? event.conversation.activeRun;
    if (!run) {
      return null;
    }
    const activity = run.activity ?? null;
    const progress = cleanOptionalText(activity?.summary ?? event.progress?.message ?? run.progress.at(-1)?.message);
    const error = cleanOptionalText(run.error);
    return this.upsert({
      id: `personal-agent:${run.id}`,
      kind: 'personal_agent_conversation',
      sourceId: run.id,
      appName: cleanText(context.agentName, 'Personal agent'),
      title: cleanText(event.conversation.title, context.agentName ?? 'Personal agent'),
      status: normalizeStatus(run.status),
      ...(progress ? { progress } : {}),
      ...(error ? { error } : {}),
      ...(activity ? { activity } : {}),
      startedAt: run.createdAt,
      updatedAt: run.updatedAt,
    });
  }

  public recordAppAgentConversationEvent(
    event: AppCodexConversationEvent,
    context: AppRunContext = {},
  ): LlmRunsSnapshot | null {
    const run = event.run ?? event.conversation.activeRun;
    if (!run) {
      return null;
    }
    const activity = run.activity ?? null;
    const progress = cleanOptionalText(activity?.summary ?? event.progress ?? run.progressLog?.at(-1));
    const error = cleanOptionalText(run.error);
    return this.upsert({
      id: `app-agent-thread:${event.conversation.appId}:${run.runId}`,
      kind: 'app_agent_thread',
      sourceId: run.runId,
      appId: event.conversation.appId,
      appName: cleanText(context.appName, event.conversation.appId),
      title: cleanText(event.conversation.title, context.appName ?? event.conversation.appId),
      status: normalizeStatus(run.status),
      ...(progress ? { progress } : {}),
      ...(error ? { error } : {}),
      ...(activity ? { activity } : {}),
      startedAt: run.createdAt,
      updatedAt: run.updatedAt,
    });
  }

  public recordAppPromptTaskEvent(
    event: AppCodexTaskEvent,
    context: AppRunContext = {},
  ): LlmRunsSnapshot {
    const task = event.task;
    const activity = task.activity ?? null;
    const progress = cleanOptionalText(activity?.summary ?? task.progressLog?.at(-1));
    const error = cleanOptionalText(task.error);
    return this.upsert({
      id: `app-prompt-task:${task.appId}:${task.runId}`,
      kind: 'app_prompt_task',
      sourceId: task.runId,
      appId: task.appId,
      appName: cleanText(context.appName, task.appId),
      title: cleanText(task.templateId, 'Prompt task'),
      status: normalizeStatus(task.status),
      ...(progress ? { progress } : {}),
      ...(error ? { error } : {}),
      ...(activity ? { activity } : {}),
      startedAt: task.createdAt,
      updatedAt: task.updatedAt,
    });
  }

  public recordChatRunEvent(
    event: ChatRunEvent,
    context: AppRunContext = {},
  ): LlmRunsSnapshot {
    const run = event.run;
    const activity = run.activity ?? null;
    const progress = cleanOptionalText(activity?.summary ?? run.progressLog?.at(-1));
    const error = cleanOptionalText(run.userMessage);
    return this.upsert({
      id: `desktop-chat:${run.runId}`,
      kind: 'desktop_chat',
      sourceId: run.runId,
      appId: run.appId,
      appName: cleanText(context.appName, run.appId === 'forger' ? 'Forger' : run.appId),
      title: cleanText(activity?.sourceRef?.title, run.appId === 'forger' ? 'Forger chat' : 'App chat'),
      status: normalizeStatus(run.status),
      ...(progress ? { progress } : {}),
      ...(run.status === 'failed' && error ? { error } : {}),
      ...(activity ? { activity } : {}),
      startedAt: run.createdAt,
      updatedAt: run.updatedAt,
    });
  }

  public recordWorkflowNodeActivity(
    activity: AgentRunActivity,
    context: AppRunContext = {},
  ): LlmRunsSnapshot {
    const source = activity.sourceRef;
    return this.upsert({
      id: `workflow-node:${activity.runId}`,
      kind: 'workflow_node',
      sourceId: activity.runId,
      ...(source?.appId ? { appId: source.appId } : {}),
      appName: cleanText(context.appName ?? source?.workflowName ?? source?.appName, 'Workflow'),
      title: cleanText(source?.nodeName ?? source?.title, source?.workflowName ?? 'Workflow node'),
      status: normalizeStatus(activity.status),
      ...(cleanOptionalText(activity.summary) ? { progress: cleanOptionalText(activity.summary) } : {}),
      ...(activity.status === 'failed' && cleanOptionalText(activity.summary) ? { error: cleanOptionalText(activity.summary) } : {}),
      activity,
      startedAt: activity.startedAt,
      updatedAt: activity.updatedAt,
    });
  }

  private upsert(input: LlmRunSnapshotItem): LlmRunsSnapshot {
    const current = this.runs.get(input.id);
    if (current && !shouldReplaceRun(current, input)) {
      return this.snapshot();
    }
    this.runs.set(input.id, input);
    return this.emit();
  }

  private emit(): LlmRunsSnapshot {
    const snapshot = this.snapshot();
    const window = this.options.getMainWindow();
    if (window && !window.isDestroyed()) {
      window.webContents.send(IPC_CHANNELS.llmRunsSnapshotChanged, snapshot);
    }
    return snapshot;
  }

  private isoNow(): string {
    return (this.options.now?.() ?? new Date()).toISOString();
  }
}

const normalizeStatus = (value: string): LlmRunStatus => {
  if (
    value === 'queued'
    || value === 'running'
    || value === 'needs_permission'
    || value === 'completed'
    || value === 'failed'
    || value === 'canceled'
  ) {
    return value;
  }
  if (value === 'preview_ready' || value === 'applied' || value === 'undone') {
    return 'completed';
  }
  return 'running';
};

const cleanText = (value: string | undefined, fallback: string): string => {
  const trimmed = value?.trim().replace(/\s+/g, ' ') ?? '';
  return (trimmed || fallback).slice(0, 140);
};

const cleanOptionalText = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim().replace(/\s+/g, ' ') ?? '';
  return trimmed ? trimmed.slice(0, 240) : undefined;
};

const shouldReplaceRun = (current: LlmRunSnapshotItem, incoming: LlmRunSnapshotItem): boolean => {
  const timestampComparison = incoming.updatedAt.localeCompare(current.updatedAt);
  if (timestampComparison !== 0) {
    return timestampComparison > 0;
  }
  const currentTerminal = TERMINAL_STATUSES.has(current.status);
  const incomingTerminal = TERMINAL_STATUSES.has(incoming.status);
  if (currentTerminal !== incomingTerminal) {
    return incomingTerminal;
  }
  return true;
};
