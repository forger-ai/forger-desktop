import type { BrowserWindow } from 'electron';

import { IPC_CHANNELS } from '../shared/ipc';
import type {
  AppCodexConversationEvent,
  AppCodexTaskEvent,
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
    const progress = cleanOptionalText(event.progress?.message ?? run.progress.at(-1)?.message);
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
    const progress = cleanOptionalText(event.progress ?? run.progressLog?.at(-1));
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
      startedAt: run.createdAt,
      updatedAt: run.updatedAt,
    });
  }

  public recordAppPromptTaskEvent(
    event: AppCodexTaskEvent,
    context: AppRunContext = {},
  ): LlmRunsSnapshot {
    const task = event.task;
    const progress = cleanOptionalText(task.progressLog?.at(-1));
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
      startedAt: task.createdAt,
      updatedAt: task.updatedAt,
    });
  }

  private upsert(input: LlmRunSnapshotItem): LlmRunsSnapshot {
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
