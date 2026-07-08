import type { AgentRunActivity, AgentRunActivityItem, AgentRunActivityItemKind } from './types/agent-run-activity';

export type AgentRunActivityTimelineMode = 'live' | 'completed';

export interface AgentRunActivityTimelineDurationLabels {
  hours: string;
  minutes: string;
  seconds: string;
}

export interface AgentRunActivityTimelineKindLabels {
  mcp_call: string;
  file_read: string;
  file_write: string;
  command: string;
  connected_service: string;
  permission: string;
  status: string;
  assistant_note: string;
  error: string;
}

export interface AgentRunActivityTimelineLabels {
  fallbackTitle: string;
  workedFor: (duration: string, count: number) => string;
  activityTitle: (count: number) => string;
  duration: AgentRunActivityTimelineDurationLabels;
  kinds: AgentRunActivityTimelineKindLabels;
}

export interface AgentRunActivityProgressMessage {
  id?: string;
  message: string;
  createdAt?: string;
}

export interface AgentRunActivityTimelineRow {
  id: string;
  kind: AgentRunActivityItemKind;
  text: string;
  createdAt?: string;
}

export interface AgentRunActivityTimeline {
  title: string;
  summary?: string;
  status?: string;
  mode: AgentRunActivityTimelineMode;
  rows: AgentRunActivityTimelineRow[];
}

export interface BuildAgentRunActivityTimelineInput {
  activity?: AgentRunActivity | null;
  progressMessages?: Array<string | AgentRunActivityProgressMessage>;
  mode: AgentRunActivityTimelineMode;
  labels: AgentRunActivityTimelineLabels;
  completedAt?: string;
}

const activeStatuses = new Set(['queued', 'running', 'needs_permission']);

export const isActiveAgentRunActivityStatus = (status: string | undefined): boolean =>
  Boolean(status && activeStatuses.has(status));

export const formatAgentRunActivityDuration = (
  durationMs: number | undefined,
  labels: AgentRunActivityTimelineDurationLabels,
): string => {
  if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs < 0) {
    return '';
  }
  const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours} ${labels.hours} ${minutes} ${labels.minutes}`;
  if (minutes > 0) return `${minutes} ${labels.minutes} ${seconds} ${labels.seconds}`;
  return `${seconds} ${labels.seconds}`;
};

export const buildAgentRunActivityTimeline = ({
  activity,
  progressMessages = [],
  mode,
  labels,
  completedAt,
}: BuildAgentRunActivityTimelineInput): AgentRunActivityTimeline => {
  const rowsFromActivity = activity?.items.map((item, index) => rowFromActivityItem(item, index, labels)) ?? [];
  const rows = rowsFromActivity.length > 0
    ? rowsFromActivity
    : progressMessages
        .map((message, index) => rowFromProgressMessage(message, index))
        .filter((row): row is AgentRunActivityTimelineRow => Boolean(row));
  const orderedRows = rows.sort((left, right) => {
    const leftTime = Date.parse(left.createdAt ?? '');
    const rightTime = Date.parse(right.createdAt ?? '');
    if (!Number.isFinite(leftTime) || !Number.isFinite(rightTime)) return 0;
    return leftTime - rightTime;
  });
  const fallbackDurationMs = fallbackDurationFromRows(orderedRows, completedAt);
  const duration = formatAgentRunActivityDuration(activity?.durationMs ?? fallbackDurationMs, labels.duration);
  const count = activity?.counts.total ?? orderedRows.length;
  const title = mode === 'completed' && duration
    ? labels.workedFor(duration, count)
    : labels.activityTitle(count) || labels.fallbackTitle;

  return {
    title,
    ...(activity?.summary ? { summary: activity.summary } : {}),
    ...(activity?.status ? { status: activity.status } : {}),
    mode,
    rows: orderedRows,
  };
};

const fallbackDurationFromRows = (
  rows: AgentRunActivityTimelineRow[],
  completedAt: string | undefined,
): number | undefined => {
  if (!completedAt || rows.length === 0) {
    return undefined;
  }
  const finished = Date.parse(completedAt);
  const firstStarted = rows
    .map((row) => Date.parse(row.createdAt ?? ''))
    .find((value) => Number.isFinite(value));
  if (!Number.isFinite(finished) || firstStarted === undefined) {
    return undefined;
  }
  return Math.max(0, finished - firstStarted);
};

const rowFromActivityItem = (
  item: AgentRunActivityItem,
  index: number,
  labels: AgentRunActivityTimelineLabels,
): AgentRunActivityTimelineRow => ({
  id: item.id || `activity-${index}`,
  kind: item.kind,
  text: visibleTextForActivityItem(item, labels),
  createdAt: item.createdAt,
});

const rowFromProgressMessage = (
  message: string | AgentRunActivityProgressMessage,
  index: number,
): AgentRunActivityTimelineRow | null => {
  const text = typeof message === 'string' ? message : message.message;
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }
  return {
    id: typeof message === 'string' ? `progress-${index}` : message.id ?? `progress-${index}`,
    kind: 'status',
    text: trimmed,
    ...(typeof message === 'string' ? {} : message.createdAt ? { createdAt: message.createdAt } : {}),
  };
};

const visibleTextForActivityItem = (
  item: AgentRunActivityItem,
  labels: AgentRunActivityTimelineLabels,
): string => {
  if (item.kind === 'assistant_note' || item.kind === 'status' || item.kind === 'error') {
    return item.summary;
  }
  return labels.kinds[item.kind] || item.summary;
};
