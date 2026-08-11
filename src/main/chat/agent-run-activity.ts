import fs from 'node:fs/promises';
import path from 'node:path';

import type {
  AgentProvider,
  AgentRunActivity,
  AgentRunActivityItem,
  AgentRunActivityItemKind,
  AgentRunActivitySourceRef,
  AgentRunActivityStatus,
  AgentRunActivitySurface,
} from '../../shared/types';
import { sanitizeReportPayload } from '../../shared/report-sanitizer';
import { isInternalProviderProgressText } from './progress-errors';

type OutputStream = 'stdout' | 'stderr' | 'meta';

interface CreateActivityInput {
  runId: string;
  surface: AgentRunActivitySurface;
  status?: AgentRunActivityStatus;
  startedAt?: string;
  updatedAt?: string;
  sourceRef?: AgentRunActivitySourceRef;
}

interface AppendOutputInput {
  activity: AgentRunActivity;
  provider: AgentProvider;
  stream: OutputStream;
  text: string;
  now?: string;
}

interface ParseProviderOutputInput {
  provider: AgentProvider;
  stream: OutputStream;
  text: string;
  now?: string;
}

interface FallbackInput {
  runId: string;
  surface: AgentRunActivitySurface;
  status: AgentRunActivityStatus | string;
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
  progressLog?: string[];
  error?: string;
  sourceRef?: AgentRunActivitySourceRef;
}

const MAX_ITEMS = 300;
const MAX_SUMMARY_CHARS = 20_000;
const MAX_DETAILS_CHARS = 8_000;

export const createAgentRunActivity = (input: CreateActivityInput): AgentRunActivity => {
  const now = input.updatedAt ?? input.startedAt ?? new Date().toISOString();
  return withCounts({
    runId: input.runId,
    surface: input.surface,
    status: input.status ?? 'queued',
    startedAt: input.startedAt ?? now,
    updatedAt: now,
    summary: '',
    items: [],
    counts: emptyCounts(),
    redactions: [],
    ...(input.sourceRef ? { sourceRef: input.sourceRef } : {}),
  });
};

export const appendProviderActivity = (input: AppendOutputInput): AgentRunActivity => {
  const text = input.text.trim();
  if (!text || input.stream === 'meta') {
    return input.activity;
  }
  const items = parseProviderItems(input.provider, input.stream, input.text, input.now ?? new Date().toISOString());
  if (items.length === 0) {
    return input.activity;
  }
  return appendActivityItems(input.activity, items, input.now);
};

export const parseProviderOutputActivityItems = (input: ParseProviderOutputInput): AgentRunActivityItem[] => {
  const text = input.text.trim();
  if (!text || input.stream === 'meta') {
    return [];
  }
  const redactions = new Set<string>();
  return parseProviderItems(input.provider, input.stream, input.text, input.now ?? new Date().toISOString())
    .map((item) => sanitizeItem(item, redactions))
    .filter((item) => item.summary.trim().length > 0);
};

export const appendActivityItems = (
  activity: AgentRunActivity,
  items: AgentRunActivityItem[],
  now = new Date().toISOString(),
): AgentRunActivity => {
  const redactions = new Set(activity.redactions);
  const sanitized = items
    .map((item) => sanitizeItem(item, redactions))
    .filter((item) => item.summary.trim().length > 0);
  if (sanitized.length === 0) {
    return activity;
  }
  const nextItems = dedupeAdjacent([...activity.items, ...sanitized]).slice(-MAX_ITEMS);
  return withCounts({
    ...activity,
    items: nextItems,
    updatedAt: now,
    summary: latestSummary(nextItems),
    redactions: Array.from(redactions),
  });
};

export const addStatusActivityItem = (
  activity: AgentRunActivity,
  summary: string,
  status: AgentRunActivityItem['status'] = 'running',
): AgentRunActivity =>
  appendActivityItems(activity, [{
    id: activityItemId(activity.runId, activity.items.length, 'status'),
    kind: 'status',
    summary,
    status,
    createdAt: new Date().toISOString(),
  }]);

export const addPermissionActivityItem = (
  activity: AgentRunActivity,
  summary: string,
  technicalLabel?: string,
): AgentRunActivity =>
  appendActivityItems(activity, [{
    id: activityItemId(activity.runId, activity.items.length, 'permission'),
    kind: 'permission',
    summary,
    technicalLabel,
    status: 'pending',
    createdAt: new Date().toISOString(),
  }]);

export const finalizeAgentRunActivity = (
  activity: AgentRunActivity,
  status: AgentRunActivityStatus,
  updatedAt = new Date().toISOString(),
  error?: string,
): AgentRunActivity => {
  const finishedAt = status === 'running' || status === 'queued' || status === 'needs_permission'
    ? undefined
    : updatedAt;
  const withError = error
    ? appendActivityItems(activity, [{
        id: activityItemId(activity.runId, activity.items.length, 'error'),
        kind: 'error',
        summary: error,
        status: 'failed',
        createdAt: updatedAt,
      }], updatedAt)
    : activity;
  const items = withError.items.length > 0
    ? withError.items
    : [{
        id: activityItemId(activity.runId, 0, 'status'),
        kind: 'status' as const,
        summary: status === 'completed' ? 'Completed.' : status === 'canceled' ? 'Canceled.' : status === 'failed' ? 'Failed.' : 'Working.',
        status: status === 'completed' ? 'completed' as const : status === 'failed' ? 'failed' as const : status === 'canceled' ? 'blocked' as const : 'running' as const,
        createdAt: updatedAt,
      }];
  return withCounts({
    ...withError,
    status,
    updatedAt,
    ...(finishedAt ? { finishedAt, durationMs: Math.max(0, Date.parse(finishedAt) - Date.parse(withError.startedAt)) } : {}),
    items,
    summary: latestSummary(items),
  });
};

export const activityFromProgressFallback = (input: FallbackInput): AgentRunActivity => {
  let activity = createAgentRunActivity({
    runId: input.runId,
    surface: input.surface,
    status: normalizeActivityStatus(input.status),
    startedAt: input.startedAt,
    updatedAt: input.updatedAt,
    sourceRef: input.sourceRef,
  });
  for (const [index, entry] of (input.progressLog ?? []).entries()) {
    activity = appendActivityItems(activity, [{
      id: activityItemId(input.runId, index, 'assistant_note'),
      kind: 'assistant_note',
      summary: entry,
      createdAt: input.updatedAt,
    }], input.updatedAt);
  }
  return finalizeAgentRunActivity(
    activity,
    normalizeActivityStatus(input.status),
    input.finishedAt ?? input.updatedAt,
    input.error,
  );
};

export const buildAgentRunActivityFromProgressLog = (input: FallbackInput): AgentRunActivity =>
  activityFromProgressFallback(input);

export const persistAgentRunActivity = async (
  metadataRoot: string,
  activity: AgentRunActivity,
): Promise<void> => {
  const filePath = path.join(metadataRoot, 'agent-run-activity', `${safePathSegment(activity.runId)}.json`);
  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, `${JSON.stringify(activity, null, 2)}\n`, 'utf8');
  } catch (error) {
    if ((error as { code?: unknown }).code === 'ENOENT') {
      return;
    }
    throw error;
  }
};

export const normalizeActivityStatus = (status: string): AgentRunActivityStatus => {
  if (status === 'queued' || status === 'running' || status === 'needs_permission' || status === 'completed' || status === 'failed' || status === 'canceled') {
    return status;
  }
  if (status === 'preview_ready' || status === 'applied' || status === 'undone') {
    return 'completed';
  }
  return 'running';
};

const parseProviderItems = (
  provider: AgentProvider,
  stream: OutputStream,
  text: string,
  now: string,
): AgentRunActivityItem[] => {
  if (provider === 'claude') {
    return parseClaudeItems(stream, text, now);
  }
  if (provider === 'antigravity') {
    return parseAntigravityItems(text, now);
  }
  return parseCodexItems(stream, text, now);
};

const parseCodexItems = (stream: OutputStream, text: string, now: string): AgentRunActivityItem[] => {
  const items: AgentRunActivityItem[] = [];
  for (const [index, line] of jsonLines(text).entries()) {
    const entry = parseJsonRecord(line);
    if (!entry) {
      if (!looksLikeStructuredFragment(line)) {
        pushTextItem(items, stream, line, now, index);
      }
      continue;
    }
    const item = recordValue(entry.item);
    const type = stringValue(entry.type);
    const itemType = stringValue(item?.type);
    if (!item) {
      if (type === 'thread.started') {
        items.push(statusItem('Provider thread started.', 'running', now, index));
        continue;
      }
      if (type === 'turn.started') {
        items.push(statusItem('Agent started working.', 'running', now, index));
        continue;
      }
      if (type === 'turn.completed') {
        items.push(statusItem('Agent turn completed.', 'completed', now, index));
        continue;
      }
      if (type.includes('tool')) {
        items.push(toolItem('codex', stringValue(entry.name) || type, entry, now, index));
      }
      continue;
    }
    if (itemType === 'agent_message') {
      const textValue = stringValue(item.text);
      if (textValue) {
        pushTextItem(items, 'stdout', textValue, now, index);
      }
      continue;
    }
    if (itemType === 'command_execution') {
      const command = stringValue(item.command) || stringValue(item.cmd) || stringValue(item.text);
      items.push(commandItem(command, item, now, index));
      continue;
    }
    if (itemType.includes('tool')) {
      const name = stringValue(item.name) || stringValue(item.tool_name) || itemType;
      items.push(toolItem('codex', name, item, now, index));
    }
  }
  return items;
};

const parseClaudeItems = (stream: OutputStream, text: string, now: string): AgentRunActivityItem[] => {
  const items: AgentRunActivityItem[] = [];
  for (const [index, line] of jsonLines(text).entries()) {
    const entry = parseJsonRecord(line);
    if (!entry) {
      if (!looksLikeStructuredFragment(line)) {
        pushTextItem(items, stream, line, now, index);
      }
      continue;
    }
    const type = stringValue(entry.type);
    if (type === 'system' && stringValue(entry.subtype) === 'init') {
      items.push(statusItem('Provider session started.', 'running', now, index));
    }
    const directText = stringValue(entry.result) || stringValue(entry.text);
    if (directText) {
      pushTextItem(items, 'stdout', directText, now, index);
    }
    for (const content of claudeContentItems(entry)) {
      const kind = stringValue(content.type);
      if (kind === 'text') {
        const note = stringValue(content.text);
        if (note) {
          pushTextItem(items, 'stdout', note, now, index);
        }
      } else if (kind === 'tool_use') {
        const name = stringValue(content.name) || 'tool_use';
        items.push(toolItem('claude', name, content, now, index));
      }
    }
    if (stringValue(entry.type) === 'tool_use') {
      items.push(toolItem('claude', stringValue(entry.name) || 'tool_use', entry, now, index));
    }
  }
  return items;
};

const parseAntigravityItems = (text: string, now: string): AgentRunActivityItem[] => {
  const items: AgentRunActivityItem[] = [];
  for (const [index, line] of text.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean).entries()) {
    if (looksLikeStructuredFragment(line)) {
      continue;
    }
    const mcpMatch = line.match(/(?:MCP tool|Calling MCP tool|Llamando herramienta MCP)[:\s]+([A-Za-z0-9_.:-]+)/);
    if (mcpMatch?.[1]) {
      items.push(toolItem('antigravity', mcpMatch[1], { line }, now, index));
      continue;
    }
    if (isAntigravityNoise(line)) {
      continue;
    }
    pushTextItem(items, 'stdout', line, now, index);
  }
  return items;
};

const claudeContentItems = (entry: Record<string, unknown>): Record<string, unknown>[] => {
  const message = recordValue(entry.message);
  const content = message?.content ?? entry.content;
  if (!Array.isArray(content)) {
    return [];
  }
  return content.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item));
};

const noteItem = (text: string, now: string, index: number): AgentRunActivityItem => ({
  id: activityItemId('provider', index, 'assistant_note'),
  kind: 'assistant_note',
  summary: stripMarkdown(text),
  createdAt: now,
});

const statusItem = (
  text: string,
  status: AgentRunActivityItem['status'],
  now: string,
  index: number,
): AgentRunActivityItem => ({
  id: activityItemId('provider', index, 'status'),
  kind: 'status',
  summary: text,
  status,
  createdAt: now,
});

const errorItem = (text: string, now: string, index: number): AgentRunActivityItem => ({
  id: activityItemId('provider', index, 'error'),
  kind: 'error',
  summary: stripMarkdown(text),
  status: 'failed',
  createdAt: now,
});

const pushTextItem = (
  items: AgentRunActivityItem[],
  stream: OutputStream,
  text: string,
  now: string,
  index: number,
): void => {
  if (isInternalProviderProgressText(text)) {
    return;
  }
  items.push(stream === 'stderr' ? errorItem(text, now, index) : noteItem(text, now, index));
};

const commandItem = (
  command: string,
  raw: Record<string, unknown>,
  now: string,
  index: number,
): AgentRunActivityItem => {
  const kind = classifyCommand(command);
  return {
    id: activityItemId('provider', index, kind),
    kind,
    summary: commandSummary(kind, command),
    technicalLabel: command.split(/\s+/).filter(Boolean)[0] || 'command',
    technicalDetails: command || JSON.stringify(raw),
    status: 'completed',
    createdAt: now,
  };
};

const toolItem = (
  provider: AgentProvider,
  name: string,
  raw: Record<string, unknown>,
  now: string,
  index: number,
): AgentRunActivityItem => {
  const kind = classifyTool(name);
  return {
    id: activityItemId('provider', index, kind),
    kind,
    summary: toolSummary(kind, name),
    technicalLabel: name,
    technicalDetails: JSON.stringify(raw, null, 2),
    status: 'completed',
    createdAt: now,
  };
};

const classifyTool = (name: string): AgentRunActivityItemKind => {
  const normalized = name.toLowerCase();
  if (normalized.startsWith('mcp__') || normalized.includes('.') || normalized.includes(':')) {
    return 'mcp_call';
  }
  if (['read', 'grep', 'glob', 'ls'].includes(normalized) || normalized.includes('read')) {
    return 'file_read';
  }
  if (normalized.includes('edit') || normalized.includes('write')) {
    return 'file_write';
  }
  if (normalized.includes('bash') || normalized.includes('shell')) {
    return 'command';
  }
  return 'mcp_call';
};

const classifyCommand = (command: string): AgentRunActivityItemKind => {
  const normalized = command.trim().toLowerCase();
  if (/\b(apply_patch|tee|sed\s+-i|perl\s+-pi|mkdir|touch|rm|mv|cp)\b/.test(normalized) || />|<<\s*['"]?eof/.test(normalized)) {
    return 'file_write';
  }
  if (/^\s*(rg|grep|sed\s+-n|cat|ls|find|git\s+(show|diff|status|log)|wc|nl)\b/.test(normalized)) {
    return 'file_read';
  }
  return 'command';
};

const toolSummary = (kind: AgentRunActivityItemKind, name: string): string => {
  if (kind === 'file_read') return 'Read or searched files.';
  if (kind === 'file_write') return 'Changed files.';
  if (kind === 'command') return 'Ran a command.';
  return readableToolName(name).startsWith('forger_') || readableToolName(name).includes('.')
    ? `Used ${readableToolName(name)}.`
    : 'Used a tool.';
};

const commandSummary = (kind: AgentRunActivityItemKind, command: string): string => {
  if (kind === 'file_read') return 'Read a file or searched code.';
  if (kind === 'file_write') return 'Changed files.';
  const label = command.split(/\s+/).filter(Boolean)[0];
  return label ? `Ran ${label}.` : 'Ran a command.';
};

const readableToolName = (name: string): string => name.replace(/^mcp__/, '').replace(/__/g, '.');

const sanitizeItem = (item: AgentRunActivityItem, redactions: Set<string>): AgentRunActivityItem => {
  const summary = sanitizeText(item.summary, redactions).slice(0, MAX_SUMMARY_CHARS);
  const technicalDetails = item.technicalDetails
    ? sanitizeText(item.technicalDetails, redactions).slice(0, MAX_DETAILS_CHARS)
    : undefined;
  const technicalLabel = item.technicalLabel
    ? sanitizeText(item.technicalLabel, redactions).slice(0, 180)
    : undefined;
  return {
    ...item,
    summary,
    ...(technicalLabel ? { technicalLabel } : {}),
    ...(technicalDetails ? { technicalDetails } : {}),
  };
};

export const sanitizeAgentRunActivityText = (value: string): string =>
  sanitizeText(value, new Set());

const sanitizeText = (value: string, redactions: Set<string>): string => {
  let output = sanitizeReportPayload(value, { maxStringLength: Number.MAX_SAFE_INTEGER });
  if (output !== value) {
    redactions.add('Hidden sensitive value');
  }
  const patterns: Array<[RegExp, string]> = [
    [/(authorization\s*[:=]\s*bearer\s+)[^\s"'`,}]+/gi, '$1[hidden sensitive value]'],
    [/(api[_-]?key\s*[:=]\s*)[^\s"'`,}]+/gi, '$1[hidden sensitive value]'],
    [/(token\s*[:=]\s*)[^\s"'`,}]+/gi, '$1[hidden sensitive value]'],
    [/(secret\s*[:=]\s*)[^\s"'`,}]+/gi, '$1[hidden sensitive value]'],
    [/(password\s*[:=]\s*)[^\s"'`,}]+/gi, '$1[hidden sensitive value]'],
    [/(cookie\s*[:=]\s*)[^\n]+/gi, '$1[hidden sensitive value]'],
    [/\b(sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|xox[baprs]-[A-Za-z0-9-]{12,})\b/g, '[hidden sensitive value]'],
  ];
  for (const [pattern, replacement] of patterns) {
    if (pattern.test(output)) {
      redactions.add('Hidden sensitive value');
      output = output.replace(pattern, replacement);
    }
  }
  return output.replace(/\0/g, '').trim();
};

const stripMarkdown = (text: string): string =>
  text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^[\s>*-]+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();

const jsonLines = (text: string): string[] =>
  text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);

const parseJsonRecord = (line: string): Record<string, unknown> | null => {
  try {
    const parsed = JSON.parse(line) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
};

const looksLikeStructuredFragment = (line: string): boolean => /^[{[]/.test(line);

const recordValue = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;

const stringValue = (value: unknown): string =>
  typeof value === 'string' ? value.trim() : '';

const isAntigravityNoise = (line: string): boolean =>
  [
    /^Print mode:/i,
    /^Created conversation\s+/i,
    /^Streaming conversation\s+/i,
    /^conversationID=/i,
    /^(?:conversation|Conversation|CONVERSATION)[\s_-]*(?:id|ID)\s*[:=]/,
    /^Authentication required\./i,
    /^Waiting for authentication/i,
    /^Or, paste the authorization code/i,
    /^MCP config/i,
    /^Using config/i,
    /^Log file:/i,
  ].some((pattern) => pattern.test(line));

const dedupeAdjacent = (items: AgentRunActivityItem[]): AgentRunActivityItem[] => {
  const output: AgentRunActivityItem[] = [];
  for (const item of items) {
    const last = output[output.length - 1];
    if (last && last.kind === item.kind && last.summary === item.summary && last.technicalLabel === item.technicalLabel) {
      continue;
    }
    output.push(item);
  }
  return output;
};

const withCounts = (activity: AgentRunActivity): AgentRunActivity => ({
  ...activity,
  counts: countItems(activity.items),
});

const countItems = (items: AgentRunActivityItem[]) => ({
  total: items.length,
  mcpCalls: items.filter((item) => item.kind === 'mcp_call').length,
  fileReads: items.filter((item) => item.kind === 'file_read').length,
  fileWrites: items.filter((item) => item.kind === 'file_write').length,
  commands: items.filter((item) => item.kind === 'command').length,
  connectedServices: items.filter((item) => item.kind === 'connected_service').length,
  permissions: items.filter((item) => item.kind === 'permission').length,
  notes: items.filter((item) => item.kind === 'assistant_note' || item.kind === 'status').length,
  errors: items.filter((item) => item.kind === 'error').length,
});

const emptyCounts = () => countItems([]);

const latestSummary = (items: AgentRunActivityItem[]): string =>
  // Callers sanitize or synthesize at least one item before deriving a summary.
  items[items.length - 1]!.summary;

const activityItemId = (runId: string, index: number, kind: AgentRunActivityItemKind): string =>
  `${runId}:${kind}:${Date.now()}:${index}`;

const safePathSegment = (value: string): string => value.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 160) || 'run';
