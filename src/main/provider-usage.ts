import os from 'node:os';
import type fs from 'node:fs/promises';
import type path from 'node:path';
import type {
  AgentProviderUsageEntry,
  AgentProviderUsageResult,
  AgentProviderUsageWindow,
  AgentProviderUsageWindowKind,
  AntigravityAuthStatus,
  ClaudeAuthStatus,
  CodexAuthStatus,
  CodexRateLimitBucket,
  FailureDiagnosticFields,
} from '../shared/types';

const CLAUDE_USAGE_URL = 'https://claude.ai/settings/usage';
const CLAUDE_OAUTH_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const CLAUDE_OAUTH_USAGE_TIMEOUT_MS = 5_000;
const ANTIGRAVITY_USAGE_URL = 'https://gemini.google.com/usage';
const MAX_CLAUDE_AUDIT_FILES = 80;
const MAX_CLAUDE_AUDIT_DEPTH = 10;
const MAX_CLAUDE_AUDIT_BYTES = 512 * 1024;
const RATE_LIMIT_STALE_GRACE_SECONDS = 5 * 60;

interface ProviderUsageDeps {
  fs: typeof fs;
  path: typeof path;
  codexUsageDashboardUrl: string;
  getCodexAuthStatus: () => Promise<CodexAuthStatus>;
  getClaudeAuthStatus: () => Promise<ClaudeAuthStatus>;
  getAntigravityAuthStatus: () => Promise<AntigravityAuthStatus>;
  failureDiagnostic: (error: unknown, fallbackCode: string) => FailureDiagnosticFields;
  homeDir?: () => string;
  claudeAuditRoots?: () => string[];
  readClaudeOAuthToken?: () => Promise<string | null>;
  fetchClaudeUsagePayload?: (token: string) => Promise<unknown>;
  appendLog?: (event: string, context?: Record<string, unknown>) => Promise<void>;
}

const providerLabels = {
  codex: 'ChatGPT',
  claude: 'Claude',
  antigravity: 'Google',
} as const;

const clampPercent = (value: number): number => Math.max(0, Math.min(100, Math.round(value)));

const isStaleReset = (resetsAt: number | undefined): boolean =>
  typeof resetsAt === 'number' && resetsAt < Math.floor(Date.now() / 1000) - RATE_LIMIT_STALE_GRACE_SECONDS;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const windowKindForCodexBucket = (bucket: CodexRateLimitBucket): AgentProviderUsageWindowKind | null => {
  const duration = bucket.primary?.windowDurationMins;
  if (duration !== undefined) {
    if (duration >= 250 && duration <= 350) {
      return 'five_hour';
    }
    if (duration >= 9_000 && duration <= 11_000) {
      return 'weekly';
    }
  }

  const name = `${bucket.limitName ?? ''} ${bucket.limitId ?? ''}`.toLowerCase();
  if (/\b(5h|5\s*hour|five\s*hour)\b/.test(name)) {
    return 'five_hour';
  }
  if (/\b(weekly|week|7d|7\s*day)\b/.test(name)) {
    return 'weekly';
  }
  return null;
};

const windowKindForCodexWindow = (
  bucket: CodexRateLimitBucket,
  window: CodexRateLimitBucket['primary'],
): AgentProviderUsageWindowKind | null => {
  const duration = window?.windowDurationMins;
  if (duration !== undefined) {
    if (duration >= 250 && duration <= 350) {
      return 'five_hour';
    }
    if (duration >= 9_000 && duration <= 11_000) {
      return 'weekly';
    }
  }
  return windowKindForCodexBucket(bucket);
};

const labelForWindow = (kind: AgentProviderUsageWindowKind): string => kind === 'five_hour' ? '5h' : 'Weekly';

export const normalizeCodexUsageWindows = (status: CodexAuthStatus): AgentProviderUsageWindow[] => {
  const buckets = status.rateLimits?.buckets ?? [];
  const primary = status.rateLimits?.primary;
  const allBuckets = primary ? [primary, ...buckets.filter((bucket) => bucket.limitId !== primary.limitId)] : buckets;
  const byKind = new Map<AgentProviderUsageWindowKind, AgentProviderUsageWindow>();

  for (const bucket of allBuckets) {
    for (const rateLimitWindow of [bucket.primary, bucket.secondary]) {
      if (!rateLimitWindow) {
        continue;
      }
      const kind = windowKindForCodexWindow(bucket, rateLimitWindow);
      if (!kind || byKind.has(kind)) {
        continue;
      }
      const usedPercent = rateLimitWindow.usedPercent;
      const normalizedUsed = typeof usedPercent === 'number' ? clampPercent(usedPercent) : undefined;
      const resetsAt = typeof rateLimitWindow.resetsAt === 'number' ? rateLimitWindow.resetsAt : undefined;
      if (isStaleReset(resetsAt)) {
        continue;
      }
      byKind.set(kind, {
        kind,
        label: labelForWindow(kind),
        source: 'codex_rate_limits',
        ...(normalizedUsed !== undefined ? { usedPercent: normalizedUsed, remainingPercent: clampPercent(100 - normalizedUsed) } : {}),
        ...(resetsAt !== undefined ? { resetsAt } : {}),
      });
    }
  }

  return ['five_hour', 'weekly']
    .map((kind) => byKind.get(kind as AgentProviderUsageWindowKind))
    .filter((window): window is AgentProviderUsageWindow => Boolean(window));
};

const defaultClaudeAuditRoots = (pathModule: typeof path, homeDir: string): string[] => [
  pathModule.join(homeDir, 'Library', 'Application Support', 'Claude', 'local-agent-mode-sessions'),
  pathModule.join(homeDir, '.claude', 'projects'),
];

const listClaudeAuditFiles = async (
  fsModule: typeof fs,
  pathModule: typeof path,
  roots: string[],
): Promise<string[]> => {
  const files: string[] = [];

  const visit = async (dir: string, depth: number): Promise<void> => {
    if (files.length >= MAX_CLAUDE_AUDIT_FILES || depth > MAX_CLAUDE_AUDIT_DEPTH) {
      return;
    }
    let entries: Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }>;
    try {
      entries = await fsModule.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= MAX_CLAUDE_AUDIT_FILES) {
        return;
      }
      const fullPath = pathModule.join(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(fullPath, depth + 1);
      } else if (entry.isFile() && (entry.name === 'audit.jsonl' || entry.name.endsWith('.jsonl'))) {
        files.push(fullPath);
      }
    }
  };

  for (const root of roots) {
    await visit(root, 0);
  }

  const withStats = await Promise.all(files.map(async (filePath) => {
    const stat = await fsModule.stat(filePath).catch(() => null);
    return { filePath, mtimeMs: stat?.mtimeMs ?? 0 };
  }));
  return withStats
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
    .map((entry) => entry.filePath)
    .slice(0, MAX_CLAUDE_AUDIT_FILES);
};

const readFileTail = async (fsModule: typeof fs, filePath: string): Promise<string> => {
  const stat = await fsModule.stat(filePath);
  const handle = await fsModule.open(filePath, 'r');
  try {
    const length = Math.min(stat.size, MAX_CLAUDE_AUDIT_BYTES);
    const start = Math.max(0, stat.size - length);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);
    return buffer.toString('utf8');
  } finally {
    await handle.close();
  }
};

const windowKindForClaudeRateLimit = (value: unknown): AgentProviderUsageWindowKind | null => {
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value.toLowerCase().replace(/[^a-z0-9]+/g, '_');
  if (normalized.includes('five_hour') || normalized.includes('5_hour') || normalized.includes('5h')) return 'five_hour';
  if (normalized.includes('weekly') || normalized.includes('week') || normalized.includes('7_day') || normalized.includes('7d')) return 'weekly';
  return null;
};

export const parseClaudeUsageWindowsFromJsonl = (text: string): AgentProviderUsageWindow[] => {
  const byKind = new Map<AgentProviderUsageWindowKind, AgentProviderUsageWindow & { timestampMs: number }>();
  for (const line of text.split(/\r?\n/)) {
    if (!line.includes('"rate_limit_event"')) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const rateLimitInfo = isRecord(parsed) && isRecord(parsed.rate_limit_info)
      ? parsed.rate_limit_info
      : isRecord(parsed) && isRecord(parsed.rateLimitInfo)
        ? parsed.rateLimitInfo
        : null;
    if (!isRecord(parsed) || parsed.type !== 'rate_limit_event' || !rateLimitInfo) {
      continue;
    }
    const info = rateLimitInfo;
    const kind = windowKindForClaudeRateLimit(info.rateLimitType);
    if (!kind) {
      continue;
    }
    const timestamp = typeof parsed._audit_timestamp === 'string' ? Date.parse(parsed._audit_timestamp) : 0;
    const utilization = typeof info.utilization === 'number' && Number.isFinite(info.utilization) ? info.utilization : undefined;
    const usedPercent = utilization !== undefined ? clampPercent(utilization * 100) : undefined;
    const resetsAt = typeof info.resetsAt === 'number' && Number.isFinite(info.resetsAt) ? info.resetsAt : undefined;
    if (isStaleReset(resetsAt)) {
      continue;
    }
    const window: AgentProviderUsageWindow & { timestampMs: number } = {
      kind,
      label: labelForWindow(kind),
      source: 'claude_audit',
      timestampMs: Number.isFinite(timestamp) ? timestamp : 0,
      ...(usedPercent !== undefined ? { usedPercent, remainingPercent: clampPercent(100 - usedPercent) } : {}),
      ...(resetsAt !== undefined ? { resetsAt } : {}),
    };
    const existing = byKind.get(kind);
    const windowHasPercent = typeof window.usedPercent === 'number';
    const existingHasPercent = typeof existing?.usedPercent === 'number';
    if (!existing || (!existingHasPercent && windowHasPercent) || (existingHasPercent === windowHasPercent && existing.timestampMs <= window.timestampMs)) {
      byKind.set(kind, window);
    }
  }
  return ['five_hour', 'weekly']
    .map((kind) => byKind.get(kind as AgentProviderUsageWindowKind))
    .filter((window): window is AgentProviderUsageWindow & { timestampMs: number } => Boolean(window))
    .map(({ timestampMs: _timestampMs, ...window }) => window);
};

const toEpochSeconds = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 1e12 ? Math.floor(value / 1000) : Math.floor(value);
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : undefined;
  }
  return undefined;
};

const claudeApiWindowKeys: Array<{ key: string; kind: AgentProviderUsageWindowKind }> = [
  { key: 'five_hour', kind: 'five_hour' },
  { key: 'seven_day', kind: 'weekly' },
];

export const parseClaudeUsageWindowsFromApi = (payload: unknown): AgentProviderUsageWindow[] => {
  if (!isRecord(payload)) {
    return [];
  }
  const windows: AgentProviderUsageWindow[] = [];
  for (const { key, kind } of claudeApiWindowKeys) {
    const entry = payload[key];
    if (!isRecord(entry)) {
      continue;
    }
    const utilization = typeof entry.utilization === 'number' && Number.isFinite(entry.utilization)
      ? entry.utilization
      : undefined;
    if (utilization === undefined) {
      continue;
    }
    const resetsAt = toEpochSeconds(entry.resets_at ?? entry.resetsAt);
    if (isStaleReset(resetsAt)) {
      continue;
    }
    const usedPercent = clampPercent(utilization);
    windows.push({
      kind,
      label: labelForWindow(kind),
      source: 'claude_api',
      usedPercent,
      remainingPercent: clampPercent(100 - usedPercent),
      ...(resetsAt !== undefined ? { resetsAt } : {}),
    });
  }
  return windows;
};

const defaultFetchClaudeUsagePayload = async (token: string): Promise<unknown> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CLAUDE_OAUTH_USAGE_TIMEOUT_MS);
  try {
    const response = await fetch(CLAUDE_OAUTH_USAGE_URL, {
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
        Accept: 'application/json',
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      return null;
    }
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
};

const readClaudeUsageWindowsFromApi = async (deps: ProviderUsageDeps): Promise<AgentProviderUsageWindow[]> => {
  const readToken = deps.readClaudeOAuthToken;
  if (!readToken) {
    await deps.appendLog?.('provider_usage:claude_oauth_reader_missing');
    return [];
  }
  const token = await readToken().catch(() => null);
  if (!token) {
    await deps.appendLog?.('provider_usage:claude_oauth_token_missing');
    return [];
  }
  const fetchPayload = deps.fetchClaudeUsagePayload ?? defaultFetchClaudeUsagePayload;
  const payload = await fetchPayload(token).catch(() => null);
  const windows = parseClaudeUsageWindowsFromApi(payload);
  if (!payload || windows.length === 0) {
    await deps.appendLog?.('provider_usage:claude_oauth_checked', {
      hasPayload: Boolean(payload),
      windowCount: windows.length,
    });
  }
  return windows;
};

const readClaudeUsageWindows = async (deps: ProviderUsageDeps): Promise<AgentProviderUsageWindow[]> => {
  const roots = deps.claudeAuditRoots?.() ?? defaultClaudeAuditRoots(deps.path, deps.homeDir?.() ?? os.homedir());
  const files = await listClaudeAuditFiles(deps.fs, deps.path, roots);
  const byKind = new Map<AgentProviderUsageWindowKind, AgentProviderUsageWindow>();
  for (const filePath of files) {
    const windows = parseClaudeUsageWindowsFromJsonl(await readFileTail(deps.fs, filePath).catch(() => ''));
    for (const window of windows) {
      if (!byKind.has(window.kind)) {
        byKind.set(window.kind, window);
      }
    }
    if (byKind.size >= 2) {
      break;
    }
  }
  return ['five_hour', 'weekly']
    .map((kind) => byKind.get(kind as AgentProviderUsageWindowKind))
    .filter((window): window is AgentProviderUsageWindow => Boolean(window));
};

const connected = (status: unknown): boolean => isRecord(status) && status.authenticated === true;

export const getAgentProviderUsage = async (deps: ProviderUsageDeps): Promise<AgentProviderUsageResult> => {
  const checkedAt = new Date().toISOString();
  const providers: AgentProviderUsageEntry[] = [];

  const codex = await deps.getCodexAuthStatus().catch(() => null);
  if (connected(codex)) {
    const windows = normalizeCodexUsageWindows(codex as CodexAuthStatus);
    providers.push({
      provider: 'codex',
      label: providerLabels.codex,
      connected: true,
      checkedAt,
      windows,
      externalUrl: deps.codexUsageDashboardUrl,
      ...(windows.length === 0 ? { unavailableReason: 'not_available' as const } : {}),
    });
  }

  const claude = await deps.getClaudeAuthStatus().catch(() => null);
  if (connected(claude)) {
    let windows: AgentProviderUsageWindow[] = [];
    let unavailableReason: AgentProviderUsageEntry['unavailableReason'] = 'no_recent_usage';
    try {
      windows = await readClaudeUsageWindowsFromApi(deps);
      if (windows.length === 0) {
        windows = await readClaudeUsageWindows(deps);
      }
      unavailableReason = windows.length > 0 ? undefined : 'no_recent_usage';
    } catch {
      unavailableReason = 'read_failed';
    }
    providers.push({
      provider: 'claude',
      label: providerLabels.claude,
      connected: true,
      checkedAt,
      windows,
      externalUrl: CLAUDE_USAGE_URL,
      ...(unavailableReason ? { unavailableReason } : {}),
    });
  }

  const antigravity = await deps.getAntigravityAuthStatus().catch(() => null);
  if (connected(antigravity)) {
    providers.push({
      provider: 'antigravity',
      label: providerLabels.antigravity,
      connected: true,
      checkedAt,
      windows: [],
      externalUrl: ANTIGRAVITY_USAGE_URL,
      unavailableReason: 'not_available',
    });
  }

  return { success: true, checkedAt, providers };
};

export const getAgentProviderUsageSafely = async (deps: ProviderUsageDeps): Promise<AgentProviderUsageResult> => {
  try {
    return await getAgentProviderUsage(deps);
  } catch (error) {
    return {
      success: false,
      checkedAt: new Date().toISOString(),
      providers: [],
      userMessage: 'No pudimos leer el uso de proveedores.',
      ...deps.failureDiagnostic(error, 'provider_usage_failed'),
    };
  }
};
