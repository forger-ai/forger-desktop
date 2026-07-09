import type {
  AgentPermissionMode,
  AgentProvider,
  AgentRuntime,
  PersonalAgentConnectionGrant,
  PersonalAgentConversationOrigin,
  PersonalAgentConversationStatus,
  PersonalAgentJournalEntry,
  PersonalAgentMemory,
  PersonalAgentMessageAuthorType,
  PersonalAgentMessageRole,
  PersonalAgentMessageSource,
  PersonalAgentPeerGrant,
  PersonalAgentPeerThread,
  PersonalAgentPermission,
  PersonalAgentRoutineRunStatus,
  PersonalAgentRunProgress,
  PersonalAgentRunStatus,
  PersonalAgentWakeupStatus,
  SharedFileRef,
} from '../../shared/types';

export const MAX_NAME_LENGTH = 100;
export const MAX_DESCRIPTION_LENGTH = 500;
export const MAX_TEXT_LENGTH = 8_000;
export const MAX_GRANTS = 200;
export const MAX_WORKSPACE_TREE_DEPTH = 4;
export const MAX_WORKSPACE_TREE_ENTRIES = 200;
export const MAX_WORKSPACE_TEXT_FILE_BYTES = 256 * 1024;
export const MAX_PEER_CRITERIA_LENGTH = 2_000;
export const MAX_MESSAGE_FILES = 25;

type PermissionRowLike = {
  id: string;
  agent_id: string;
  permission: string;
  mode: string;
  granted: number;
  created_at: string;
  updated_at: string;
  kind?: string;
  target_id?: string;
};

type RunProgressRowLike = {
  id: string;
  agent_id: string;
  conversation_id: string;
  run_id: string;
  message: string;
  created_at: string;
};

type MemoryRowLike = {
  id: string;
  agent_id: string;
  remember_when: string;
  title: string;
  content: string;
  created_at: string;
  updated_at: string;
};

type JournalEntryRowLike = {
  id: string;
  agent_id: string;
  conversation_id: string | null;
  body: string;
  created_at: string;
};

export const sanitizeText = (value: unknown, maxLength: number): string =>
  typeof value === 'string' ? value.trim().slice(0, maxLength) : '';

export const normalizeMessageText = (value: unknown): string =>
  sanitizeText(value, MAX_TEXT_LENGTH).replace(/\s+/g, ' ').trim();

const normalizeProgressPrefix = (value: unknown): string =>
  normalizeMessageText(value)
    .replace(/(?:\.{3}|…)+$/g, '')
    .trim();

export const isDuplicateFinalProgress = (normalizedFinal: string, candidate: unknown): boolean => {
  const normalizedCandidate = normalizeMessageText(candidate);
  if (!normalizedCandidate) {
    return false;
  }
  if (normalizedCandidate === normalizedFinal) {
    return true;
  }
  const prefix = normalizeProgressPrefix(normalizedCandidate);
  return prefix.length >= 80 && normalizedFinal.startsWith(prefix);
};

export const statementChanges = (result: unknown): number =>
  result && typeof result === 'object' && typeof (result as { changes?: unknown }).changes === 'number'
    ? (result as { changes: number }).changes
    : 0;

export const sanitizeAgentId = (value: unknown): string | null =>
  typeof value === 'string' && /^[a-zA-Z0-9_-]{1,120}$/.test(value) ? value : null;

export const sanitizeGrantTarget = (value: unknown): string | null =>
  typeof value === 'string' && /^[a-zA-Z0-9._:-]{1,180}$/.test(value.trim()) ? value.trim() : null;

export const normalizeGrantTargets = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  const targets = value.map(sanitizeGrantTarget).filter((target): target is string => Boolean(target));
  return [...new Set(targets)].slice(0, MAX_GRANTS);
};

const normalizeConnectionGrant = (value: unknown): PersonalAgentConnectionGrant | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const input = value as Partial<PersonalAgentConnectionGrant>;
  const type = sanitizeGrantTarget(input.type) ?? '';
  const actions = normalizeGrantTargets(input.actions);
  const connectionIds = normalizeGrantTargets(input.connectionIds);
  if (!type || actions.length === 0) {
    return null;
  }
  return {
    type,
    actions,
    multiple: input.multiple === true,
    ...(connectionIds.length ? { connectionIds } : {}),
  };
};

export const normalizeConnectionGrants = (value: unknown): PersonalAgentConnectionGrant[] => {
  if (!Array.isArray(value)) return [];
  const grants = new Map<string, PersonalAgentConnectionGrant>();
  for (const item of value) {
    const grant = normalizeConnectionGrant(item);
    if (!grant) continue;
    const key = `${grant.type}:${grant.connectionIds?.join(',') ?? '*'}`;
    const existing = grants.get(key);
    grants.set(key, existing
      ? {
          type: grant.type,
          actions: [...new Set([...existing.actions, ...grant.actions])],
          multiple: existing.multiple || grant.multiple,
          ...(existing.connectionIds ?? grant.connectionIds ? { connectionIds: [...new Set([...(existing.connectionIds ?? []), ...(grant.connectionIds ?? [])])] } : {}),
        }
      : grant);
  }
  return [...grants.values()].slice(0, MAX_GRANTS);
};

const normalizePeerGrant = (value: unknown): PersonalAgentPeerGrant | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const input = value as Partial<PersonalAgentPeerGrant>;
  const agentId = sanitizeAgentId(input.agentId);
  if (!agentId) {
    return null;
  }
  return {
    agentId,
    criteria: sanitizeText(input.criteria, MAX_PEER_CRITERIA_LENGTH),
  };
};

export const normalizePeerGrants = (value: unknown): PersonalAgentPeerGrant[] => {
  if (!Array.isArray(value)) return [];
  const grants = new Map<string, PersonalAgentPeerGrant>();
  for (const item of value) {
    const grant = normalizePeerGrant(item);
    if (!grant) continue;
    grants.set(grant.agentId, grant);
  }
  return [...grants.values()].slice(0, MAX_GRANTS);
};

export const encodeConnectionGrant = (grant: PersonalAgentConnectionGrant): string =>
  JSON.stringify(grant);

export const decodeConnectionGrant = (value: unknown): PersonalAgentConnectionGrant | null => {
  if (typeof value !== 'string' || !value.trim()) {
    return null;
  }
  try {
    return normalizeConnectionGrant(JSON.parse(value) as unknown);
  } catch {
    return null;
  }
};

export const normalizePermissionMode = (value: unknown): AgentPermissionMode => value === 'unsafe' ? 'unsafe' : 'safe';

export const normalizeAgentProvider = (value: unknown): AgentProvider | null => {
  if (value === 'codex' || value === 'claude' || value === 'antigravity') {
    return value;
  }
  return null;
};

export const normalizeAgentRuntime = (value: unknown): AgentRuntime | undefined => {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const input = value as { provider?: unknown; model?: unknown; effort?: unknown; permissionMode?: unknown };
  const provider = normalizeAgentProvider(input.provider);
  const model = sanitizeText(input.model, 160);
  const effort = sanitizeText(input.effort, 40);
  if (!provider || !model || !effort) {
    return undefined;
  }
  return {
    provider,
    model,
    effort: effort as AgentRuntime['effort'],
    ...(input.permissionMode ? { permissionMode: normalizePermissionMode(input.permissionMode) } : {}),
  };
};

export const normalizeMessageRole = (value: unknown): PersonalAgentMessageRole => {
  if (value === 'assistant' || value === 'system') return value;
  return 'user';
};

export const normalizeMessageAuthorType = (value: unknown, role?: unknown): PersonalAgentMessageAuthorType => {
  if (value === 'agent') return 'agent';
  if (value === 'system' || role === 'system') return 'system';
  if (role === 'assistant') return 'agent';
  return 'human';
};

export const normalizeSharedFileSource = (value: unknown): SharedFileRef['source'] | undefined =>
  value === 'attached' || value === 'mentioned' ? value : undefined;

export const normalizeSharedFileRefs = (value: unknown): SharedFileRef[] => {
  if (!Array.isArray(value)) return [];
  const files: SharedFileRef[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const input = item as SharedFileRef;
    const filePath = sanitizeText(input.path, 2_000);
    if (!filePath) continue;
    files.push({
      path: filePath,
      ...(sanitizeText(input.id, 240) ? { id: sanitizeText(input.id, 240) } : {}),
      ...(sanitizeText(input.name, 240) ? { name: sanitizeText(input.name, 240) } : {}),
      ...(sanitizeText(input.relativePath, 1_000) ? { relativePath: sanitizeText(input.relativePath, 1_000) } : {}),
      ...(typeof input.sizeBytes === 'number' && Number.isFinite(input.sizeBytes) ? { sizeBytes: Math.max(0, Math.floor(input.sizeBytes)) } : {}),
      ...(sanitizeText(input.modifiedAt, 100) ? { modifiedAt: sanitizeText(input.modifiedAt, 100) } : {}),
      ...(normalizeSharedFileSource(input.source) ? { source: normalizeSharedFileSource(input.source) } : {}),
    });
  }
  return files;
};

export const normalizeConversationOrigin = (value: unknown): PersonalAgentConversationOrigin => {
  if (value === 'agent' || value === 'routine') return value;
  return 'user';
};

export const normalizeConversationStatus = (value: unknown): PersonalAgentConversationStatus => value === 'archived' ? 'archived' : 'active';

export const normalizeMessageSource = (value: unknown): PersonalAgentMessageSource => {
  if (value === 'routine' || value === 'scheduled_wakeup') return value;
  return 'human';
};

export const normalizePeerThreadStatus = (value: unknown): PersonalAgentPeerThread['status'] => {
  if (value === 'failed' || value === 'completed') return value;
  return 'active';
};

export const normalizeRunStatus = (value: unknown): PersonalAgentRunStatus => {
  if (value === 'running' || value === 'needs_permission' || value === 'completed' || value === 'failed' || value === 'canceled') return value;
  return 'queued';
};

export const normalizeRoutineRunStatus = (value: unknown): PersonalAgentRoutineRunStatus => {
  if (value === 'running' || value === 'succeeded' || value === 'failed' || value === 'skipped') return value;
  return 'queued';
};

export const normalizeWakeupStatus = (value: unknown): PersonalAgentWakeupStatus => {
  if (value === 'fired' || value === 'canceled') return value;
  return 'scheduled';
};

export const isTerminalRunStatus = (status: PersonalAgentRunStatus | undefined): boolean =>
  status === 'completed' || status === 'failed' || status === 'canceled';

export const deriveTitle = (body: string): string => body.split(/\s+/).slice(0, 8).join(' ').slice(0, 160);

const LEGACY_WORKSPACE_PROMPT_SNIPPETS = [
  'This is the private workspace for this personal Forger agent.',
  'The agent uses this space for its own working notes',
  'This agent helps the person with a recurring personal workflow.',
  'Work with clear steps, ask when essential context is missing',
  'Keep the person in control. Explain functional impact',
];

const LEGACY_MINIMAL_WORKSPACE_PROMPT_PATTERNS = [
  /^# Who\b[\s\S]{0,500}$/,
  /^# Why\b[\s\S]{0,500}$/,
  /^# How\b[\s\S]{0,500}$/,
  /^# Human\b[\s\S]{0,500}$/,
];

export const isLegacyWorkspacePrompt = (content: string): boolean =>
  LEGACY_WORKSPACE_PROMPT_SNIPPETS.some((snippet) => content.includes(snippet)) ||
  LEGACY_MINIMAL_WORKSPACE_PROMPT_PATTERNS.some((pattern) => pattern.test(content));

export const parsePermissionGrant = (row: Pick<PermissionRowLike, 'permission'> & Partial<Pick<PermissionRowLike, 'kind' | 'target_id'>>): { kind: PersonalAgentPermission['kind']; targetId: string; permission: string } => {
  const rawKind = row.kind === 'app' || row.kind === 'tool' || row.kind === 'connection' ? row.kind : 'legacy';
  const rawTarget = rawKind === 'connection' && typeof row.target_id === 'string'
    ? row.target_id
    : sanitizeGrantTarget(row.target_id) ?? '';
  if (rawKind !== 'legacy' && rawTarget) {
    return { kind: rawKind, targetId: rawTarget, permission: `${rawKind}:${rawTarget}` };
  }
  const permission = sanitizeGrantTarget(row.permission) ?? 'unknown';
  if (permission.startsWith('app:')) {
    const targetId = sanitizeGrantTarget(permission.slice(4)) ?? '';
    return targetId ? { kind: 'app', targetId, permission: `app:${targetId}` } : { kind: 'legacy', targetId: permission, permission };
  }
  if (permission.startsWith('tool:')) {
    const targetId = sanitizeGrantTarget(permission.slice(5)) ?? '';
    return targetId ? { kind: 'tool', targetId, permission: `tool:${targetId}` } : { kind: 'legacy', targetId: permission, permission };
  }
  return { kind: 'legacy', targetId: permission, permission };
};

export const permissionFromRow = (row: PermissionRowLike): PersonalAgentPermission => ({
  id: row.id,
  agentId: row.agent_id,
  kind: parsePermissionGrant(row).kind,
  targetId: parsePermissionGrant(row).targetId,
  permission: row.permission,
  mode: normalizePermissionMode(row.mode),
  granted: row.granted !== 0,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export const runProgressFromRow = (row: RunProgressRowLike): PersonalAgentRunProgress => ({
  id: row.id,
  agentId: row.agent_id,
  conversationId: row.conversation_id,
  runId: row.run_id,
  message: row.message,
  createdAt: row.created_at,
});

export const memoryFromRow = (row: MemoryRowLike): PersonalAgentMemory => ({
  id: row.id,
  agentId: row.agent_id,
  rememberWhen: row.remember_when,
  title: row.title,
  content: row.content,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export const journalEntryFromRow = (row: JournalEntryRowLike): PersonalAgentJournalEntry => ({
  id: row.id,
  agentId: row.agent_id,
  ...(row.conversation_id ? { conversationId: row.conversation_id } : {}),
  body: row.body,
  createdAt: row.created_at,
});
