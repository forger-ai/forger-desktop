import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { AgentPermissionMode, AgentProvider, AgentRuntime, AgentToolId, AutomationFrequency, AutomationMissedRunPolicy, PersonalAgent, PersonalAgentConnectionGrant, PersonalAgentConversation, PersonalAgentConversationOrigin, PersonalAgentCreateInput, PersonalAgentHeartbeatSummary, PersonalAgentJournalEntry, PersonalAgentMemory, PersonalAgentMessage, PersonalAgentMessageAuthorType, PersonalAgentMessageFile, PersonalAgentMessageKind, PersonalAgentMessageRole, PersonalAgentMessageSource, PersonalAgentPeerGrant, PersonalAgentPeerThread, PersonalAgentPermission, PersonalAgentRoutine, PersonalAgentRoutineRun, PersonalAgentRoutineRunStatus, PersonalAgentRun, PersonalAgentRunProgress, PersonalAgentRunStatus, PersonalAgentScheduledWakeup, PersonalAgentUpdatePermissionsInput, PersonalAgentWorkspaceEntry, PersonalAgentWorkspaceFile, SharedFileRef } from '../../shared/types';
import { buildGlobalSkillTemplates } from '../prompt-builder/official-tools';
import { buildPersonalAgentWorkspaceDocuments } from '../prompt-builder/personal-agents';
import { forgerSkillRoots, writeSkillTemplates } from '../prompt-builder/skill-template-writer';
import { openPersonalAgentSqliteDatabase, type SqliteDatabase } from './sqlite';
import { AgentRoutineStore } from './agent-store-routines';
import { PERSONAL_AGENT_SCHEMA_SQL } from './agent-store-schema';
import { readPersonalAgentWorkspaceEntries } from './agent-store-workspace';
import {
  MAX_DESCRIPTION_LENGTH,
  MAX_GRANTS,
  MAX_MESSAGE_FILES,
  MAX_NAME_LENGTH,
  MAX_PEER_CRITERIA_LENGTH,
  MAX_TEXT_LENGTH,
  MAX_WORKSPACE_TEXT_FILE_BYTES,
  decodeConnectionGrant,
  deriveTitle,
  encodeConnectionGrant,
  isDuplicateFinalProgress,
  isLegacyWorkspacePrompt,
  isTerminalRunStatus,
  journalEntryFromRow,
  memoryFromRow,
  normalizeAgentProvider,
  normalizeAgentRuntime,
  normalizeConnectionGrants,
  normalizeConversationOrigin,
  normalizeConversationStatus,
  normalizeGrantTargets,
  normalizeMessageAuthorType,
  normalizeMessageRole,
  normalizeMessageSource,
  normalizeMessageText,
  normalizePeerGrants,
  normalizePeerThreadStatus,
  normalizePermissionMode,
  normalizeRunStatus,
  normalizeSharedFileRefs,
  normalizeSharedFileSource,
  parsePermissionGrant,
  permissionFromRow,
  runProgressFromRow,
  sanitizeAgentId,
  sanitizeGrantTarget,
  sanitizeText,
  statementChanges,
} from './agent-store-normalizers';

export { isTerminalRunStatus } from './agent-store-normalizers';
interface AgentStoreOptions {
  metadataRoot: string;
  forgerHomeRoot: string;
}

interface AgentRow {
  id: string;
  name: string;
  description: string;
  purpose: string;
  instructions: string;
  permission_mode: string;
  network_access: number;
  runtime_provider?: string | null;
  runtime_model?: string | null;
  runtime_effort?: string | null;
  created_at: string;
  updated_at: string;
}

interface PermissionRow {
  id: string;
  agent_id: string;
  kind?: string;
  target_id?: string;
  permission: string;
  mode: string;
  granted: number;
  created_at: string;
  updated_at: string;
}

interface ConversationRow {
  id: string;
  agent_id: string;
  title: string;
  status: string;
  origin?: string;
  read_only?: number;
  initiator_agent_id?: string | null;
  peer_thread_id?: string | null;
  routine_id?: string | null;
  draft_message?: string | null;
  provider_thread_id?: string | null;
  provider?: string | null;
  created_at: string;
  updated_at: string;
}

interface MessageRow {
  id: string;
  agent_id: string;
  conversation_id: string;
  run_id: string | null;
  role: string;
  kind: string;
  author_type?: string | null;
  author_agent_id?: string | null;
  source?: string | null;
  routine_id?: string | null;
  wakeup_id?: string | null;
  content: string;
  created_at: string;
}

interface MessageFileRow {
  id: string;
  message_id: string;
  agent_id: string;
  conversation_id: string;
  name: string;
  path: string;
  relative_path: string;
  size_bytes: number | null;
  source: string | null;
  created_at: string;
}

interface PeerGrantRow {
  id: string;
  agent_id: string;
  peer_agent_id: string;
  criteria: string;
  created_at: string;
  updated_at: string;
  peer_name?: string | null;
  peer_description?: string | null;
}

interface PeerThreadRow {
  id: string;
  caller_agent_id: string;
  target_agent_id: string;
  source_conversation_id: string;
  target_conversation_id: string;
  parent_thread_id: string | null;
  root_thread_id: string | null;
  created_by_run_id: string | null;
  title: string;
  status: string;
  created_at: string;
  updated_at: string;
  caller_name?: string | null;
  target_name?: string | null;
}

interface RunRow {
  id: string;
  agent_id: string;
  conversation_id: string;
  status: string;
  error: string | null;
  created_at: string;
  updated_at: string;
}

interface RunProgressRow {
  id: string;
  agent_id: string;
  conversation_id: string;
  run_id: string;
  message: string;
  created_at: string;
}

interface MemoryRow {
  id: string;
  agent_id: string;
  remember_when: string;
  title: string;
  content: string;
  created_at: string;
  updated_at: string;
}

interface JournalEntryRow {
  id: string;
  agent_id: string;
  conversation_id: string | null;
  body: string;
  created_at: string;
}

const OTHERS_PEER_BLOCK_BEGIN = '<!-- FORGER_MANAGED_PEER_AGENTS_BEGIN -->';
const OTHERS_PEER_BLOCK_END = '<!-- FORGER_MANAGED_PEER_AGENTS_END -->';

export class AgentStore {
  private db: SqliteDatabase | null = null;
  private loadPromise: Promise<void> | null = null;
  private readonly routineStore: AgentRoutineStore;

  public constructor(private readonly options: AgentStoreOptions) {
    this.routineStore = new AgentRoutineStore({
      load: () => this.load(),
      requireDb: () => this.requireDb(),
      requireAgent: (agentId) => this.requireAgent(agentId),
      requireConversation: (conversationId) => this.requireConversation(conversationId),
      createConversation: (input) => this.createConversation(input),
      updateConversationTitle: (input) => this.updateConversationTitle(input),
      touchConversation: (agentId, conversationId, updatedAt) => this.touchConversation(agentId, conversationId, updatedAt),
    });
  }

  public async listAgents(): Promise<PersonalAgent[]> {
    await this.load();
    const rows = this.requireDb().prepare('SELECT * FROM personal_agents ORDER BY updated_at DESC').all() as AgentRow[];
    return rows.map((row) => this.agentFromRow(row));
  }

  public async getHeartbeatSummary(): Promise<PersonalAgentHeartbeatSummary> {
    await this.load();
    const rows = this.requireDb().prepare('SELECT id, name, description FROM personal_agents ORDER BY updated_at DESC').all() as Pick<AgentRow, 'id' | 'name' | 'description'>[];
    const agents = rows
      .map((row) => {
        const id = sanitizeAgentId(row.id);
        if (!id) return null;
        const name = sanitizeText(row.name, MAX_NAME_LENGTH) || id;
        const description = sanitizeText(row.description, MAX_DESCRIPTION_LENGTH);
        return {
          id,
          name,
          ...(description ? { description } : {}),
        };
      })
      .filter((agent): agent is { id: string; name: string; description?: string } => Boolean(agent));
    const ids = agents.map((agent) => agent.id);
    return {
      supported: true,
      count: ids.length,
      ids,
      agents,
    };
  }

  public async createAgent(input: PersonalAgentCreateInput): Promise<PersonalAgent> {
    await this.load();
    const now = new Date().toISOString();
    const name = sanitizeText(input.name, MAX_NAME_LENGTH);
    if (!name) {
      throw new Error('personal_agent_name_required');
    }
    const agent: PersonalAgent = {
      id: randomUUID(),
      name,
      description: sanitizeText(input.description, MAX_DESCRIPTION_LENGTH),
      purpose: sanitizeText(input.purpose, MAX_TEXT_LENGTH),
      instructions: sanitizeText(input.instructions, MAX_TEXT_LENGTH),
      permissionMode: normalizePermissionMode(input.permissionMode),
      networkAccess: input.networkAccess === true,
      ...(normalizeAgentRuntime(input.runtime) ? { runtime: normalizeAgentRuntime(input.runtime) as AgentRuntime } : {}),
      appIds: normalizeGrantTargets(input.appIds),
      toolIds: normalizeGrantTargets(input.toolIds) as AgentToolId[],
      connectionGrants: normalizeConnectionGrants(input.connectionGrants),
      peerAgentGrants: normalizePeerGrants(input.peerAgentGrants),
      createdAt: now,
      updatedAt: now,
    };
    this.requireDb().prepare(`
      INSERT INTO personal_agents (id, name, description, purpose, instructions, permission_mode, network_access, runtime_provider, runtime_model, runtime_effort, created_at, updated_at)
      VALUES (@id, @name, @description, @purpose, @instructions, @permissionMode, @networkAccess, @runtimeProvider, @runtimeModel, @runtimeEffort, @createdAt, @updatedAt)
    `).run({
      id: agent.id,
      name: agent.name,
      description: agent.description,
      purpose: agent.purpose,
      instructions: agent.instructions,
      permissionMode: agent.permissionMode,
      networkAccess: agent.networkAccess ? 1 : 0,
      runtimeProvider: agent.runtime?.provider ?? null,
      runtimeModel: agent.runtime?.model ?? null,
      runtimeEffort: agent.runtime?.effort ?? null,
      createdAt: agent.createdAt,
      updatedAt: agent.updatedAt,
    });
    await this.ensureWorkspace(agent);
    await this.upsertPermission({
      agentId: agent.id,
      kind: 'legacy',
      targetId: 'network_access',
      mode: agent.permissionMode,
      granted: agent.networkAccess,
    });
    await this.replaceGrants(agent.id, 'app', agent.appIds, now);
    await this.replaceGrants(agent.id, 'tool', agent.toolIds, now);
    await this.replaceConnectionGrants(agent.id, agent.connectionGrants, now);
    await this.replacePeerGrants(agent.id, agent.peerAgentGrants, now);
    await this.syncOthersWorkspaceFile(await this.requireAgent(agent.id));
    return this.requireAgent(agent.id);
  }

  public async getAgent(id: string): Promise<PersonalAgent | null> {
    await this.load();
    return this.agentById(id);
  }

  public async requireAgent(id: string): Promise<PersonalAgent> {
    const agent = await this.getAgent(id);
    if (!agent) {
      throw new Error('personal_agent_not_found');
    }
    return agent;
  }

  public async deleteAgent(agentId: string): Promise<{ success: boolean }> {
    await this.load();
    const agent = await this.requireAgent(agentId);
    this.requireDb().prepare('DELETE FROM personal_agents WHERE id = ?').run(agent.id);
    await fs.rm(this.agentRoot(agent.id), { force: true, recursive: true });
    return { success: true };
  }

  public async updateAgentPermissions(input: PersonalAgentUpdatePermissionsInput): Promise<PersonalAgent> {
    await this.load();
    const agent = await this.requireAgent(input.agentId);
    const now = new Date().toISOString();
    const permissionMode = normalizePermissionMode(input.permissionMode ?? agent.permissionMode);
    const networkAccess = typeof input.networkAccess === 'boolean' ? input.networkAccess : agent.networkAccess;
    const runtime = 'runtime' in input ? normalizeAgentRuntime(input.runtime) : agent.runtime;
    this.requireDb().prepare(`
      UPDATE personal_agents
      SET permission_mode = ?, network_access = ?, runtime_provider = ?, runtime_model = ?, runtime_effort = ?, updated_at = ?
      WHERE id = ?
    `).run(permissionMode, networkAccess ? 1 : 0, runtime?.provider ?? null, runtime?.model ?? null, runtime?.effort ?? null, now, agent.id);
    await this.upsertPermission({
      agentId: agent.id,
      kind: 'legacy',
      targetId: 'network_access',
      mode: permissionMode,
      granted: networkAccess,
    });
    if (input.appIds) {
      await this.replaceGrants(agent.id, 'app', normalizeGrantTargets(input.appIds), now);
    }
    if (input.toolIds) {
      await this.replaceGrants(agent.id, 'tool', normalizeGrantTargets(input.toolIds), now);
    }
    if (input.connectionGrants) {
      await this.replaceConnectionGrants(agent.id, normalizeConnectionGrants(input.connectionGrants), now);
    }
    if (input.peerAgentGrants) {
      await this.replacePeerGrants(agent.id, normalizePeerGrants(input.peerAgentGrants), now);
      await this.syncOthersWorkspaceFile(await this.requireAgent(agent.id));
    }
    return await this.requireAgent(agent.id);
  }

  public async listPeerGrants(agentId: string): Promise<PersonalAgentPeerGrant[]> {
    await this.load();
    await this.requireAgent(agentId);
    return this.peerGrantsForAgent(agentId);
  }

  public async getPeerGrant(agentId: string, peerAgentId: string): Promise<PersonalAgentPeerGrant | null> {
    await this.load();
    const peerId = sanitizeAgentId(peerAgentId);
    if (!peerId) {
      return null;
    }
    return this.peerGrantsForAgent(agentId).find((grant) => grant.agentId === peerId) ?? null;
  }

  public async createPeerThread(input: {
    callerAgentId: string;
    targetAgentId: string;
    sourceConversationId: string;
    targetConversationId: string;
    parentThreadId?: string | null;
    createdByRunId?: string | null;
    title?: string;
  }): Promise<PersonalAgentPeerThread> {
    await this.load();
    const caller = await this.requireAgent(input.callerAgentId);
    const target = await this.requireAgent(input.targetAgentId);
    if (caller.id === target.id) {
      throw new Error('personal_agent_peer_self_call_blocked');
    }
    const sourceConversation = await this.requireConversation(input.sourceConversationId);
    if (sourceConversation.agentId !== caller.id) {
      throw new Error('personal_agent_peer_source_conversation_mismatch');
    }
    const targetConversation = await this.requireConversation(input.targetConversationId);
    if (targetConversation.agentId !== target.id) {
      throw new Error('personal_agent_peer_target_conversation_mismatch');
    }
    const parentThread = input.parentThreadId ? this.peerThreadRowById(input.parentThreadId) : null;
    if (input.parentThreadId && !parentThread) {
      throw new Error('personal_agent_peer_parent_thread_not_found');
    }
    const now = new Date().toISOString();
    const threadId = randomUUID();
    const rootThreadId = parentThread?.root_thread_id ?? parentThread?.id ?? null;
    const title = sanitizeText(input.title, 160) || `${caller.name} -> ${target.name}`;
    this.requireDb().prepare(`
      INSERT INTO personal_agent_peer_threads (
        id,
        caller_agent_id,
        target_agent_id,
        source_conversation_id,
        target_conversation_id,
        parent_thread_id,
        root_thread_id,
        created_by_run_id,
        title,
        status,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      threadId,
      caller.id,
      target.id,
      sourceConversation.id,
      targetConversation.id,
      parentThread?.id ?? null,
      rootThreadId,
      sanitizeAgentId(input.createdByRunId) ?? input.createdByRunId ?? null,
      title,
      'active',
      now,
      now,
    );
    this.requireDb().prepare(`
      UPDATE personal_agent_conversations
      SET origin = 'agent', read_only = 1, initiator_agent_id = ?, peer_thread_id = ?, updated_at = ?
      WHERE id = ?
    `).run(caller.id, threadId, now, targetConversation.id);
    this.touchConversation(caller.id, sourceConversation.id, now);
    const row = this.peerThreadRowById(threadId);
    if (!row) {
      throw new Error('personal_agent_peer_thread_not_found');
    }
    return this.peerThreadFromRow(row, { includeMessages: true, includeChildren: true });
  }

  public async updatePeerThreadStatus(input: { threadId: string; status: PersonalAgentPeerThread['status'] }): Promise<PersonalAgentPeerThread> {
    await this.load();
    const thread = this.peerThreadRowById(input.threadId);
    if (!thread) {
      throw new Error('personal_agent_peer_thread_not_found');
    }
    const now = new Date().toISOString();
    this.requireDb().prepare('UPDATE personal_agent_peer_threads SET status = ?, updated_at = ? WHERE id = ?').run(
      normalizePeerThreadStatus(input.status),
      now,
      thread.id,
    );
    const updated = this.peerThreadRowById(thread.id);
    if (!updated) {
      throw new Error('personal_agent_peer_thread_not_found');
    }
    return this.peerThreadFromRow(updated, { includeMessages: true, includeChildren: true });
  }

  public async getPeerThread(threadId: string): Promise<PersonalAgentPeerThread | null> {
    await this.load();
    const row = this.peerThreadRowById(threadId);
    return row ? this.peerThreadFromRow(row, { includeMessages: true, includeChildren: true }) : null;
  }

  public async getPeerThreadByTargetConversation(conversationId: string): Promise<PersonalAgentPeerThread | null> {
    await this.load();
    const row = this.peerThreadRowByTargetConversation(conversationId);
    return row ? this.peerThreadFromRow(row, { includeMessages: true, includeChildren: true }) : null;
  }

  public async listPeerThreadsForConversation(input: { agentId: string; conversationId: string }): Promise<PersonalAgentPeerThread[]> {
    await this.load();
    const conversation = await this.requireConversation(input.conversationId);
    if (conversation.agentId !== input.agentId) {
      throw new Error('personal_agent_conversation_mismatch');
    }
    return this.peerThreadsForConversation(input.conversationId, { includeMessages: false });
  }

  public async listRecentPeerThreadsForAgent(agentId: string, limit = 10): Promise<PersonalAgentPeerThread[]> {
    await this.load();
    const agent = await this.requireAgent(agentId);
    const safeLimit = Math.max(1, Math.min(50, Math.floor(limit)));
    const rows = this.requireDb().prepare(`
      SELECT
        thread_row.*,
        caller.name AS caller_name,
        target.name AS target_name
      FROM personal_agent_peer_threads thread_row
      INNER JOIN personal_agents caller ON caller.id = thread_row.caller_agent_id
      INNER JOIN personal_agents target ON target.id = thread_row.target_agent_id
      WHERE thread_row.caller_agent_id = ? OR thread_row.target_agent_id = ?
      ORDER BY thread_row.updated_at DESC
      LIMIT ?
    `).all(agent.id, agent.id, safeLimit) as PeerThreadRow[];
    return rows.map((row) => this.peerThreadFromRow(row, { includeMessages: false, includeChildren: true }));
  }

  public async requirePeerThreadAccess(input: { agentId: string; threadId: string }): Promise<PersonalAgentPeerThread> {
    await this.load();
    const thread = this.peerThreadRowById(input.threadId);
    if (!thread) {
      throw new Error('personal_agent_peer_thread_not_found');
    }
    if (thread.caller_agent_id !== input.agentId && thread.target_agent_id !== input.agentId) {
      throw new Error('personal_agent_peer_thread_not_allowed');
    }
    return this.peerThreadFromRow(thread, { includeMessages: true, includeChildren: true });
  }

  public async listPermissions(agentId: string): Promise<PersonalAgentPermission[]> {
    await this.load();
    const rows = this.requireDb().prepare('SELECT * FROM personal_agent_permissions WHERE agent_id = ? ORDER BY created_at ASC').all(agentId) as PermissionRow[];
    return rows.map(permissionFromRow);
  }

  public async listRoutines(agentId: string): Promise<PersonalAgentRoutine[]> {
    return this.routineStore.listRoutines(agentId);
  }

  public async getRoutine(routineId: string): Promise<PersonalAgentRoutine | null> {
    return this.routineStore.getRoutine(routineId);
  }

  public async requireRoutine(routineId: string): Promise<PersonalAgentRoutine> {
    return this.routineStore.requireRoutine(routineId);
  }

  public async createRoutine(input: {
    agentId: string;
    name: string;
    prompt: string;
    frequency: AutomationFrequency;
    missedRunPolicy: AutomationMissedRunPolicy;
    missedRunWindowMinutes?: number;
    enabled: boolean;
    nextRunAt: string | null;
    authorizationText: string;
  }): Promise<PersonalAgentRoutine> {
    return this.routineStore.createRoutine(input);
  }

  public async updateRoutine(input: {
    routineId: string;
    name: string;
    prompt: string;
    frequency: AutomationFrequency;
    missedRunPolicy: AutomationMissedRunPolicy;
    missedRunWindowMinutes?: number;
    enabled: boolean;
    nextRunAt: string | null;
    authorizationText: string;
  }): Promise<PersonalAgentRoutine> {
    return this.routineStore.updateRoutine(input);
  }

  public async deleteRoutine(routineId: string): Promise<{ success: boolean }> {
    return this.routineStore.deleteRoutine(routineId);
  }

  public async setRoutineEnabled(input: { routineId: string; enabled: boolean; nextRunAt: string | null }): Promise<PersonalAgentRoutine> {
    return this.routineStore.setRoutineEnabled(input);
  }

  public async updateRoutineSchedule(input: { routineId: string; running?: boolean; nextRunAt?: string | null; lastUpdatedAt?: string }): Promise<PersonalAgentRoutine> {
    return this.routineStore.updateRoutineSchedule(input);
  }

  public async createRoutineRun(input: {
    routineId: string;
    trigger: PersonalAgentRoutineRun['trigger'];
    status?: PersonalAgentRoutineRunStatus;
    error?: string;
    messageId?: string;
  }): Promise<PersonalAgentRoutineRun> {
    return this.routineStore.createRoutineRun(input);
  }

  public async updateRoutineRun(input: { runId: string; status: PersonalAgentRoutineRunStatus; error?: string; messageId?: string }): Promise<PersonalAgentRoutineRun> {
    return this.routineStore.updateRoutineRun(input);
  }

  public async scheduleWakeup(input: {
    agentId: string;
    conversationId: string;
    prompt: string;
    dueAt: string;
    createdByRunId?: string | null;
  }): Promise<PersonalAgentScheduledWakeup> {
    return this.routineStore.scheduleWakeup(input);
  }

  public async cancelWakeup(input: { wakeupId?: string; conversationId?: string }): Promise<PersonalAgentScheduledWakeup | null> {
    return this.routineStore.cancelWakeup(input);
  }

  public async updateWakeupStatus(input: { wakeupId: string; status: PersonalAgentScheduledWakeup['status'] }): Promise<PersonalAgentScheduledWakeup> {
    return this.routineStore.updateWakeupStatus(input);
  }

  public async listScheduledWakeups(): Promise<PersonalAgentScheduledWakeup[]> {
    return this.routineStore.listScheduledWakeups();
  }

  public async updateConversationDraft(input: { conversationId: string; draftMessage: string }): Promise<PersonalAgentConversation> {
    return this.routineStore.updateConversationDraft(input);
  }

  public async createConversation(input: {
    agentId: string;
    title?: string;
    origin?: PersonalAgentConversationOrigin;
    readOnly?: boolean;
    initiatorAgentId?: string | null;
    peerThreadId?: string | null;
    routineId?: string | null;
  }): Promise<PersonalAgentConversation> {
    await this.load();
    const agent = await this.requireAgent(input.agentId);
    const now = new Date().toISOString();
    const conversationId = randomUUID();
    const origin = normalizeConversationOrigin(input.origin);
    const initiatorAgentId = sanitizeAgentId(input.initiatorAgentId) ?? null;
    const peerThreadId = sanitizeAgentId(input.peerThreadId) ?? null;
    const routineId = sanitizeAgentId(input.routineId) ?? null;
    this.requireDb().prepare(`
      INSERT INTO personal_agent_conversations (id, agent_id, title, status, origin, read_only, initiator_agent_id, peer_thread_id, routine_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      conversationId,
      agent.id,
      sanitizeText(input.title, 160) || agent.name,
      'active',
      origin,
      input.readOnly === true || origin === 'agent' ? 1 : 0,
      initiatorAgentId,
      peerThreadId,
      routineId,
      now,
      now,
    );
    return await this.requireConversation(conversationId);
  }

  public async updateConversationTitle(input: { conversationId: string; title: string }): Promise<PersonalAgentConversation> {
    await this.load();
    const conversation = await this.requireConversation(input.conversationId);
    const title = sanitizeText(input.title, 160);
    if (!title) {
      throw new Error('personal_agent_conversation_title_required');
    }
    const now = new Date().toISOString();
    this.requireDb().prepare('UPDATE personal_agent_conversations SET title = ?, updated_at = ? WHERE id = ?').run(
      title,
      now,
      conversation.id,
    );
    this.requireDb().prepare('UPDATE personal_agents SET updated_at = ? WHERE id = ?').run(now, conversation.agentId);
    return await this.requireConversation(conversation.id);
  }

  public async updateConversationProviderThread(input: { conversationId: string; providerThreadId: string | null }): Promise<PersonalAgentConversation> {
    await this.load();
    const conversation = await this.requireConversation(input.conversationId);
    const now = new Date().toISOString();
    this.requireDb().prepare('UPDATE personal_agent_conversations SET provider_thread_id = ?, updated_at = ? WHERE id = ?').run(
      input.providerThreadId,
      now,
      conversation.id,
    );
    return await this.requireConversation(conversation.id);
  }

  public async updateConversationProvider(input: { conversationId: string; provider: AgentProvider; providerThreadId?: string | null }): Promise<PersonalAgentConversation> {
    await this.load();
    const conversation = await this.requireConversation(input.conversationId);
    const now = new Date().toISOString();
    this.requireDb().prepare('UPDATE personal_agent_conversations SET provider = ?, provider_thread_id = ?, updated_at = ? WHERE id = ?').run(
      input.provider,
      input.providerThreadId ?? conversation.providerThreadId ?? null,
      now,
      input.conversationId,
    );
    return await this.requireConversation(input.conversationId);
  }

  public async listConversations(agentId: string): Promise<PersonalAgentConversation[]> {
    await this.load();
    await this.requireAgent(agentId);
    const rows = this.requireDb().prepare(`
      SELECT * FROM personal_agent_conversations
      WHERE agent_id = ?
      ORDER BY updated_at DESC
    `).all(agentId) as ConversationRow[];
    return rows.map((row) => this.conversationFromRow(row));
  }

  public async getConversation(id: string): Promise<PersonalAgentConversation | null> {
    await this.load();
    const row = this.requireDb().prepare('SELECT * FROM personal_agent_conversations WHERE id = ?').get(id) as ConversationRow | undefined;
    return row ? this.conversationFromRow(row) : null;
  }

  public async requireConversation(id: string): Promise<PersonalAgentConversation> {
    const conversation = await this.getConversation(id);
    if (!conversation) {
      throw new Error('personal_agent_conversation_not_found');
    }
    return conversation;
  }

  public async addMessage(input: {
    agentId: string;
    conversationId: string;
    runId?: string;
    role: PersonalAgentMessageRole;
    kind?: PersonalAgentMessageKind;
    authorType?: PersonalAgentMessageAuthorType;
    authorAgentId?: string | null;
    source?: PersonalAgentMessageSource;
    routineId?: string | null;
    wakeupId?: string | null;
    content: string;
    files?: SharedFileRef[];
  }): Promise<PersonalAgentMessage> {
    await this.load();
    const content = sanitizeText(input.content, MAX_TEXT_LENGTH);
    if (!content) {
      throw new Error('personal_agent_message_required');
    }
    const conversation = await this.requireConversation(input.conversationId);
    if (conversation.agentId !== input.agentId) {
      throw new Error('personal_agent_conversation_mismatch');
    }
    const now = new Date().toISOString();
    const authorType = normalizeMessageAuthorType(input.authorType, input.role);
    const authorAgentId = authorType === 'agent' ? sanitizeAgentId(input.authorAgentId) ?? input.agentId : null;
    const source = normalizeMessageSource(input.source);
    const routineId = sanitizeAgentId(input.routineId) ?? null;
    const wakeupId = sanitizeAgentId(input.wakeupId) ?? null;
    const message: PersonalAgentMessage = {
      id: randomUUID(),
      agentId: input.agentId,
      conversationId: input.conversationId,
      ...(input.runId ? { runId: input.runId } : {}),
      role: normalizeMessageRole(input.role),
      kind: input.kind === 'intermediate' ? 'intermediate' : 'message',
      authorType,
      ...(authorAgentId ? { authorAgentId } : {}),
      source,
      ...(routineId ? { routineId } : {}),
      ...(wakeupId ? { wakeupId } : {}),
      content,
      createdAt: now,
    };
    this.requireDb().prepare(`
      INSERT INTO personal_agent_messages (id, agent_id, conversation_id, run_id, role, kind, author_type, author_agent_id, source, routine_id, wakeup_id, content, created_at)
      VALUES (@id, @agentId, @conversationId, @runId, @role, @kind, @authorType, @authorAgentId, @source, @routineId, @wakeupId, @content, @createdAt)
    `).run({ ...message, runId: message.runId ?? null, authorAgentId, routineId, wakeupId });
    const files = normalizeSharedFileRefs(input.files).slice(0, MAX_MESSAGE_FILES);
    if (files.length > 0) {
      const insertFile = this.requireDb().prepare(`
        INSERT INTO personal_agent_message_files (id, message_id, agent_id, conversation_id, name, path, relative_path, size_bytes, source, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const messageFiles = files.map((fileRef) => ({
        id: randomUUID(),
        messageId: message.id,
        agentId: input.agentId,
        conversationId: input.conversationId,
        name: sanitizeText(fileRef.name, 240) || path.basename(fileRef.path),
        path: fileRef.path,
        relativePath: sanitizeText(fileRef.relativePath, 1_000) || path.basename(fileRef.path),
        sizeBytes: typeof fileRef.sizeBytes === 'number' && Number.isFinite(fileRef.sizeBytes) ? Math.max(0, Math.floor(fileRef.sizeBytes)) : undefined,
        source: normalizeSharedFileSource(fileRef.source),
        createdAt: now,
      } satisfies PersonalAgentMessageFile));
      for (const file of messageFiles) {
        insertFile.run(
          file.id,
          file.messageId,
          file.agentId,
          file.conversationId,
          file.name,
          file.path,
          file.relativePath,
          file.sizeBytes ?? null,
          file.source ?? null,
          file.createdAt,
        );
      }
      message.files = messageFiles;
    }
    this.requireDb().prepare('UPDATE personal_agent_conversations SET updated_at = ? WHERE id = ?').run(now, input.conversationId);
    this.requireDb().prepare('UPDATE personal_agents SET updated_at = ? WHERE id = ?').run(now, input.agentId);
    this.touchPeerThreadsForConversation(input.conversationId, now);
    return message;
  }

  public async deleteDuplicateRunProgress(input: { runId: string; finalContent: string }): Promise<number> {
    await this.load();
    const run = this.requireRun(input.runId);
    const normalizedFinal = normalizeMessageText(input.finalContent);
    if (!normalizedFinal) {
      return 0;
    }
    const db = this.requireDb();
    const messageRows = db.prepare(`
      SELECT id, content FROM personal_agent_messages
      WHERE run_id = ? AND role = 'assistant' AND kind = 'intermediate'
    `).all(run.id) as Pick<MessageRow, 'id' | 'content'>[];
    const progressRows = db.prepare(`
      SELECT id, message FROM personal_agent_run_progress
      WHERE run_id = ?
    `).all(run.id) as Pick<RunProgressRow, 'id' | 'message'>[];
    const duplicateMessageIds = messageRows
      .filter((row) => isDuplicateFinalProgress(normalizedFinal, row.content))
      .map((row) => row.id);
    const duplicateProgressIds = progressRows
      .filter((row) => isDuplicateFinalProgress(normalizedFinal, row.message))
      .map((row) => row.id);
    let deleted = 0;
    const deleteMessage = db.prepare('DELETE FROM personal_agent_messages WHERE id = ?');
    const deleteProgress = db.prepare('DELETE FROM personal_agent_run_progress WHERE id = ?');
    duplicateMessageIds.forEach((id) => {
      deleted += statementChanges(deleteMessage.run(id));
    });
    duplicateProgressIds.forEach((id) => {
      deleted += statementChanges(deleteProgress.run(id));
    });
    if (deleted > 0) {
      this.touchConversation(run.agentId, run.conversationId, new Date().toISOString());
    }
    return deleted;
  }

  public async createRun(input: { agentId: string; conversationId: string }): Promise<PersonalAgentRun> {
    await this.load();
    const conversation = await this.requireConversation(input.conversationId);
    if (conversation.agentId !== input.agentId) {
      throw new Error('personal_agent_conversation_mismatch');
    }
    const activeRun = this.latestRunForConversation(input.conversationId);
    if (activeRun && !isTerminalRunStatus(activeRun.status)) {
      throw new Error('personal_agent_run_active');
    }
    const now = new Date().toISOString();
    const run: PersonalAgentRun = {
      id: randomUUID(),
      agentId: input.agentId,
      conversationId: input.conversationId,
      status: 'queued',
      progress: [],
      createdAt: now,
      updatedAt: now,
    };
    this.requireDb().prepare(`
      INSERT INTO personal_agent_runs (id, agent_id, conversation_id, status, error, created_at, updated_at)
      VALUES (@id, @agentId, @conversationId, @status, @error, @createdAt, @updatedAt)
    `).run({
      id: run.id,
      agentId: run.agentId,
      conversationId: run.conversationId,
      status: run.status,
      error: null,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
    });
    this.touchConversation(input.agentId, input.conversationId, now);
    return run;
  }

  public async updateRunStatus(input: { runId: string; status: PersonalAgentRunStatus; error?: string }): Promise<PersonalAgentRun> {
    await this.load();
    const run = this.requireRun(input.runId);
    const now = new Date().toISOString();
    this.requireDb().prepare(`
      UPDATE personal_agent_runs
      SET status = ?, error = ?, updated_at = ?
      WHERE id = ?
    `).run(normalizeRunStatus(input.status), sanitizeText(input.error, MAX_TEXT_LENGTH) || null, now, input.runId);
    this.touchConversation(run.agentId, run.conversationId, now);
    return this.requireRun(input.runId);
  }

  public async addRunProgress(input: { runId: string; message: string }): Promise<PersonalAgentRunProgress> {
    await this.load();
    const run = this.requireRun(input.runId);
    const message = sanitizeText(input.message, MAX_TEXT_LENGTH);
    if (!message) {
      throw new Error('personal_agent_run_progress_required');
    }
    const now = new Date().toISOString();
    const progress: PersonalAgentRunProgress = {
      id: randomUUID(),
      agentId: run.agentId,
      conversationId: run.conversationId,
      runId: run.id,
      message,
      createdAt: now,
    };
    this.requireDb().prepare(`
      INSERT INTO personal_agent_run_progress (id, agent_id, conversation_id, run_id, message, created_at)
      VALUES (@id, @agentId, @conversationId, @runId, @message, @createdAt)
    `).run(progress);
    this.touchConversation(run.agentId, run.conversationId, now);
    return progress;
  }

  public async getRun(runId: string): Promise<PersonalAgentRun | null> {
    await this.load();
    return this.runById(runId);
  }

  public async workspaceRootForAgent(agentId: string): Promise<string> {
    await this.load();
    const agent = await this.requireAgent(agentId);
    await this.ensureWorkspace(agent);
    const workspaceRoot = this.workspaceRoot(agentId);
    const stat = await fs.stat(workspaceRoot).catch(() => null);
    if (!stat?.isDirectory()) {
      throw new Error('personal_agent_workspace_missing');
    }
    return workspaceRoot;
  }

  public async createMemory(input: { agentId: string; rememberWhen?: string; title?: string; content: string }): Promise<PersonalAgentMemory> {
    await this.load();
    await this.requireAgent(input.agentId);
    const content = sanitizeText(input.content, MAX_TEXT_LENGTH);
    if (!content) {
      throw new Error('personal_agent_memory_required');
    }
    const now = new Date().toISOString();
    const memory: PersonalAgentMemory = {
      id: randomUUID(),
      agentId: input.agentId,
      rememberWhen: sanitizeText(input.rememberWhen, 1_000),
      title: sanitizeText(input.title, 160) || deriveTitle(content),
      content,
      createdAt: now,
      updatedAt: now,
    };
    this.requireDb().prepare(`
      INSERT INTO personal_agent_memories (id, agent_id, remember_when, title, content, created_at, updated_at)
      VALUES (@id, @agentId, @rememberWhen, @title, @content, @createdAt, @updatedAt)
    `).run(memory);
    return memory;
  }

  public async listMemories(agentId: string): Promise<PersonalAgentMemory[]> {
    await this.load();
    const rows = this.requireDb().prepare('SELECT * FROM personal_agent_memories WHERE agent_id = ? ORDER BY updated_at DESC').all(agentId) as MemoryRow[];
    return rows.map(memoryFromRow);
  }

  public async createJournalEntry(input: { agentId: string; conversationId?: string; body: string }): Promise<PersonalAgentJournalEntry> {
    await this.load();
    await this.requireAgent(input.agentId);
    if (input.conversationId) {
      const conversation = await this.requireConversation(input.conversationId);
      if (conversation.agentId !== input.agentId) {
        throw new Error('personal_agent_conversation_mismatch');
      }
    }
    const body = sanitizeText(input.body, MAX_TEXT_LENGTH);
    if (!body) {
      throw new Error('personal_agent_journal_entry_required');
    }
    const now = new Date().toISOString();
    const entry: PersonalAgentJournalEntry = {
      id: randomUUID(),
      agentId: input.agentId,
      ...(input.conversationId ? { conversationId: input.conversationId } : {}),
      body,
      createdAt: now,
    };
    this.requireDb().prepare(`
      INSERT INTO personal_agent_journal_entries (id, agent_id, conversation_id, body, created_at)
      VALUES (@id, @agentId, @conversationId, @body, @createdAt)
    `).run({
      ...entry,
      conversationId: entry.conversationId ?? null,
    });
    return entry;
  }

  public async listJournalEntries(agentId: string): Promise<PersonalAgentJournalEntry[]> {
    await this.load();
    const rows = this.requireDb().prepare('SELECT * FROM personal_agent_journal_entries WHERE agent_id = ? ORDER BY created_at DESC').all(agentId) as JournalEntryRow[];
    return rows.map(journalEntryFromRow);
  }

  public async listWorkspace(agentId: string): Promise<PersonalAgentWorkspaceEntry[]> {
    await this.load();
    await this.requireAgent(agentId);
    const workspaceRoot = this.workspaceRoot(agentId);
    return await readPersonalAgentWorkspaceEntries({
      workspaceRoot,
      ensureContained: (root, candidate) => this.ensureWorkspaceContained(root, candidate),
    });
  }

  public async readWorkspaceTextFile(input: { agentId: string; relativePath: string }): Promise<PersonalAgentWorkspaceFile> {
    await this.load();
    await this.requireAgent(input.agentId);
    const filePath = await this.resolveWorkspaceFile(input.agentId, input.relativePath);
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) {
      throw new Error('personal_agent_workspace_file_required');
    }
    if (stat.size > MAX_WORKSPACE_TEXT_FILE_BYTES) {
      throw new Error('personal_agent_workspace_file_too_large');
    }
    const content = await fs.readFile(filePath, 'utf8');
    return {
      agentId: input.agentId,
      relativePath: path.relative(this.workspaceRoot(input.agentId), filePath),
      content,
      updatedAt: stat.mtime.toISOString(),
    };
  }

  public async writeWorkspaceTextFile(input: { agentId: string; relativePath: string; content: string }): Promise<PersonalAgentWorkspaceFile> {
    await this.load();
    await this.requireAgent(input.agentId);
    if (Buffer.byteLength(input.content, 'utf8') > MAX_WORKSPACE_TEXT_FILE_BYTES) {
      throw new Error('personal_agent_workspace_file_too_large');
    }
    const filePath = await this.resolveWorkspaceFile(input.agentId, input.relativePath);
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) {
      throw new Error('personal_agent_workspace_file_required');
    }
    await fs.writeFile(filePath, input.content, 'utf8');
    return await this.readWorkspaceTextFile({ agentId: input.agentId, relativePath: input.relativePath });
  }

  private async upsertPermission(input: { agentId: string; kind: PersonalAgentPermission['kind']; targetId: string; mode: AgentPermissionMode; granted: boolean }): Promise<void> {
    const now = new Date().toISOString();
    const permission = input.kind === 'legacy' ? input.targetId : `${input.kind}:${input.targetId}`;
    this.requireDb().prepare(`
      INSERT INTO personal_agent_permissions (id, agent_id, kind, target_id, permission, mode, granted, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(agent_id, kind, target_id) DO UPDATE SET permission = excluded.permission, mode = excluded.mode, granted = excluded.granted, updated_at = excluded.updated_at
    `).run(randomUUID(), input.agentId, input.kind, input.targetId, permission, input.mode, input.granted ? 1 : 0, now, now);
  }

  private async replaceGrants(agentId: string, kind: 'app' | 'tool', targetIds: string[], now: string): Promise<void> {
    const db = this.requireDb();
    db.prepare('DELETE FROM personal_agent_permissions WHERE agent_id = ? AND kind = ?').run(agentId, kind);
    for (const targetId of targetIds.slice(0, MAX_GRANTS)) {
      db.prepare(`
        INSERT INTO personal_agent_permissions (id, agent_id, kind, target_id, permission, mode, granted, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(randomUUID(), agentId, kind, targetId, `${kind}:${targetId}`, 'safe', 1, now, now);
    }
  }

  private async replaceConnectionGrants(agentId: string, grants: PersonalAgentConnectionGrant[], now: string): Promise<void> {
    const db = this.requireDb();
    db.prepare('DELETE FROM personal_agent_permissions WHERE agent_id = ? AND kind = ?').run(agentId, 'connection');
    for (const grant of grants.slice(0, MAX_GRANTS)) {
      const targetId = encodeConnectionGrant(grant);
      db.prepare(`
        INSERT INTO personal_agent_permissions (id, agent_id, kind, target_id, permission, mode, granted, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(randomUUID(), agentId, 'connection', targetId, `connection:${grant.type}`, 'safe', 1, now, now);
    }
  }

  private async replacePeerGrants(agentId: string, grants: PersonalAgentPeerGrant[], now: string): Promise<void> {
    const db = this.requireDb();
    db.prepare('DELETE FROM personal_agent_peer_grants WHERE agent_id = ?').run(agentId);
    const insert = db.prepare(`
      INSERT INTO personal_agent_peer_grants (id, agent_id, peer_agent_id, criteria, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(agent_id, peer_agent_id) DO UPDATE SET criteria = excluded.criteria, updated_at = excluded.updated_at
    `);
    for (const grant of grants.slice(0, MAX_GRANTS)) {
      const peerAgentId = sanitizeAgentId(grant.agentId);
      if (!peerAgentId || peerAgentId === agentId) {
        continue;
      }
      const peer = await this.agentById(peerAgentId);
      if (!peer) {
        continue;
      }
      insert.run(randomUUID(), agentId, peer.id, sanitizeText(grant.criteria, MAX_PEER_CRITERIA_LENGTH), now, now);
    }
  }

  private async load(): Promise<void> {
    if (!this.loadPromise) {
      this.loadPromise = this.loadFromDisk();
    }
    await this.loadPromise;
  }

  private async loadFromDisk(): Promise<void> {
    await fs.mkdir(this.options.metadataRoot, { recursive: true });
    this.db = openPersonalAgentSqliteDatabase(this.sqlitePath());
    if (!this.db) {
      throw new Error('personal_agent_sqlite_unavailable');
    }
    this.db.pragma?.('journal_mode = WAL');
    this.db.pragma?.('foreign_keys = ON');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.createSchema();
  }

  private createSchema(): void {
    this.requireDb().exec(PERSONAL_AGENT_SCHEMA_SQL);
    this.ensureColumn('personal_agents', 'runtime_provider', 'TEXT');
    this.ensureColumn('personal_agents', 'runtime_model', 'TEXT');
    this.ensureColumn('personal_agents', 'runtime_effort', 'TEXT');
    this.ensureColumn('personal_agent_conversations', 'origin', "TEXT NOT NULL DEFAULT 'user'");
    this.ensureColumn('personal_agent_conversations', 'read_only', 'INTEGER NOT NULL DEFAULT 0');
    this.ensureColumn('personal_agent_conversations', 'initiator_agent_id', 'TEXT REFERENCES personal_agents(id) ON DELETE SET NULL');
    this.ensureColumn('personal_agent_conversations', 'peer_thread_id', 'TEXT');
    this.ensureColumn('personal_agent_conversations', 'routine_id', 'TEXT');
    this.ensureColumn('personal_agent_conversations', 'draft_message', "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn('personal_agent_conversations', 'provider', 'TEXT');
    this.ensureColumn('personal_agent_conversations', 'provider_thread_id', 'TEXT');
    this.ensureColumn('personal_agent_messages', 'run_id', 'TEXT REFERENCES personal_agent_runs(id) ON DELETE SET NULL');
    this.ensureColumn('personal_agent_messages', 'author_type', "TEXT NOT NULL DEFAULT 'human'");
    this.ensureColumn('personal_agent_messages', 'author_agent_id', 'TEXT REFERENCES personal_agents(id) ON DELETE SET NULL');
    this.ensureColumn('personal_agent_messages', 'source', "TEXT NOT NULL DEFAULT 'human'");
    this.ensureColumn('personal_agent_messages', 'routine_id', 'TEXT');
    this.ensureColumn('personal_agent_messages', 'wakeup_id', 'TEXT');
    this.ensureColumn('personal_agent_routines', 'frequency_interval_minutes', 'INTEGER');
    this.ensureColumn('personal_agent_permissions', 'kind', "TEXT NOT NULL DEFAULT 'legacy'");
    this.ensureColumn('personal_agent_permissions', 'target_id', "TEXT NOT NULL DEFAULT ''");
    this.backfillPermissionGrantColumns();
    this.requireDb().exec(`
      CREATE INDEX IF NOT EXISTS idx_personal_agent_permissions_agent_kind ON personal_agent_permissions(agent_id, kind);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_personal_agent_permissions_unique_grant ON personal_agent_permissions(agent_id, kind, target_id);
    `);
  }

  private ensureColumn(tableName: string, columnName: string, columnDefinition: string): void {
    const rows = this.requireDb().prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name?: string }>;
    if (rows.some((row) => row.name === columnName)) {
      return;
    }
    this.requireDb().exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDefinition}`);
  }

  private async ensureWorkspace(agent: PersonalAgent): Promise<void> {
    const workspaceRoot = this.workspaceRoot(agent.id);
    await fs.mkdir(workspaceRoot, { recursive: true });
    await Promise.all(
      forgerSkillRoots(path, workspaceRoot).map((skillsRoot) =>
        writeSkillTemplates({ fs, path }, skillsRoot, buildGlobalSkillTemplates())),
    );
    const docs = buildPersonalAgentWorkspaceDocuments(agent);
    await Promise.all(
      Object.entries(docs).map(async ([filename, content]) => {
        const filePath = path.join(workspaceRoot, filename);
        if (await this.shouldWriteWorkspacePromptFile(filePath)) {
          await fs.writeFile(filePath, `${content.trim()}\n`, 'utf8');
        }
      }),
    );
    await this.syncOthersWorkspaceFile(agent);
  }

  private async shouldWriteWorkspacePromptFile(filePath: string): Promise<boolean> {
    try {
      const existing = await fs.readFile(filePath, 'utf8');
      const trimmed = existing.trim();
      return trimmed.length === 0 || isLegacyWorkspacePrompt(trimmed);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return true;
      }
      throw error;
    }
  }

  private async syncOthersWorkspaceFile(agent: PersonalAgent): Promise<void> {
    const workspaceRoot = this.workspaceRoot(agent.id);
    const filePath = path.join(workspaceRoot, 'OTHERS.md');
    const docs = buildPersonalAgentWorkspaceDocuments(agent);
    const fallbackContent = `${docs['OTHERS.md'].trim()}\n`;
    let existing = await fs.readFile(filePath, 'utf8').catch((error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return fallbackContent;
      }
      throw error;
    });
    if (!existing.trim()) {
      existing = fallbackContent;
    }
    const block = this.buildOthersManagedPeerBlock(agent);
    const beginIndex = existing.indexOf(OTHERS_PEER_BLOCK_BEGIN);
    const endIndex = existing.indexOf(OTHERS_PEER_BLOCK_END);
    const next = beginIndex >= 0 && endIndex > beginIndex
      ? `${existing.slice(0, beginIndex).trimEnd()}\n\n${block}\n${existing.slice(endIndex + OTHERS_PEER_BLOCK_END.length).trimStart()}`
      : `${existing.trimEnd()}\n\n${block}\n`;
    if (next !== existing) {
      await fs.writeFile(filePath, next, 'utf8');
    }
  }

  private buildOthersManagedPeerBlock(agent: PersonalAgent): string {
    const lines = [
      OTHERS_PEER_BLOCK_BEGIN,
      '## Forger-Managed Agent Peers',
      '',
      'This block is generated from Forger Desktop permissions. Edit peer access in Forger Settings; manual notes belong outside this block.',
      '',
    ];
    if (agent.peerAgentGrants.length === 0) {
      lines.push('- No peer agents are currently allowed.');
    } else {
      lines.push(...agent.peerAgentGrants.map((grant) => {
        const label = grant.name ? `${grant.name} (${grant.agentId})` : grant.agentId;
        const criteria = grant.criteria || 'No specific criteria recorded.';
        return `- ${label}: ${criteria}`;
      }));
    }
    lines.push('', OTHERS_PEER_BLOCK_END);
    return lines.join('\n');
  }

  private async agentById(id: string): Promise<PersonalAgent | null> {
    const row = this.requireDb().prepare('SELECT * FROM personal_agents WHERE id = ?').get(id) as AgentRow | undefined;
    return row ? this.agentFromRow(row) : null;
  }

  private agentFromRow(row: AgentRow): PersonalAgent {
    const appIds = this.grantsForAgent(row.id, 'app') as string[];
    const toolIds = this.grantsForAgent(row.id, 'tool') as AgentToolId[];
    const connectionGrants = this.connectionGrantsForAgent(row.id);
    const peerAgentGrants = this.peerGrantsForAgent(row.id);
    const runtime = normalizeAgentRuntime({
      provider: row.runtime_provider,
      model: row.runtime_model,
      effort: row.runtime_effort,
    });
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      purpose: row.purpose,
      instructions: row.instructions,
      permissionMode: normalizePermissionMode(row.permission_mode),
      networkAccess: row.network_access !== 0,
      ...(runtime ? { runtime } : {}),
      appIds,
      toolIds,
      connectionGrants,
      peerAgentGrants,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private peerGrantsForAgent(agentId: string): PersonalAgentPeerGrant[] {
    const rows = this.requireDb().prepare(`
      SELECT
        grant_row.*,
        peer.name AS peer_name,
        peer.description AS peer_description
      FROM personal_agent_peer_grants grant_row
      INNER JOIN personal_agents peer ON peer.id = grant_row.peer_agent_id
      WHERE grant_row.agent_id = ?
      ORDER BY grant_row.updated_at DESC
    `).all(agentId) as PeerGrantRow[];
    return rows.map((row) => ({
      agentId: row.peer_agent_id,
      ...(row.peer_name ? { name: row.peer_name } : {}),
      ...(row.peer_description ? { description: row.peer_description } : {}),
      criteria: sanitizeText(row.criteria, MAX_PEER_CRITERIA_LENGTH),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  private connectionGrantsForAgent(agentId: string): PersonalAgentConnectionGrant[] {
    const rows = this.requireDb().prepare(`
      SELECT target_id FROM personal_agent_permissions
      WHERE agent_id = ? AND kind = ? AND granted != 0
      ORDER BY created_at ASC
    `).all(agentId, 'connection') as Array<{ target_id?: string }>;
    return normalizeConnectionGrants(rows.map((row) => decodeConnectionGrant(row.target_id)));
  }

  private grantsForAgent(agentId: string, kind: 'app' | 'tool'): string[] {
    const rows = this.requireDb().prepare(`
      SELECT target_id FROM personal_agent_permissions
      WHERE agent_id = ? AND kind = ? AND granted != 0
      ORDER BY created_at ASC
    `).all(agentId, kind) as Array<{ target_id?: string }>;
    const values = rows.map((row) => sanitizeGrantTarget(row.target_id)).filter((value): value is string => Boolean(value));
    return [...new Set(values)].slice(0, MAX_GRANTS);
  }

  private backfillPermissionGrantColumns(): void {
    const rows = this.requireDb().prepare('SELECT id, permission, kind, target_id FROM personal_agent_permissions').all() as PermissionRow[];
    const update = this.requireDb().prepare('UPDATE personal_agent_permissions SET kind = ?, target_id = ?, permission = ? WHERE id = ?');
    for (const row of rows) {
      const parsed = parsePermissionGrant(row);
      if (row.kind !== parsed.kind || row.target_id !== parsed.targetId || row.permission !== parsed.permission) {
        update.run(parsed.kind, parsed.targetId, parsed.permission, row.id);
      }
    }
  }

  private conversationFromRow(row: ConversationRow): PersonalAgentConversation {
    const activeRun = this.latestRunForConversation(row.id);
    const origin = normalizeConversationOrigin(row.origin);
    const peerThread = row.peer_thread_id ? this.peerThreadRowById(row.peer_thread_id) : this.peerThreadRowByTargetConversation(row.id);
    const initiatorAgentId = sanitizeAgentId(row.initiator_agent_id) ?? peerThread?.caller_agent_id ?? null;
    const initiatorAgentName = initiatorAgentId ? this.agentNameById(initiatorAgentId) : null;
    const scheduledWakeup = this.routineStore.scheduledWakeupForConversation(row.id);
    return {
      id: row.id,
      agentId: row.agent_id,
      title: row.title,
      status: normalizeConversationStatus(row.status),
      origin,
      readOnly: row.read_only !== 0 || origin === 'agent',
      ...(initiatorAgentId ? { initiatorAgentId } : {}),
      ...(initiatorAgentName ? { initiatorAgentName } : {}),
      ...(row.peer_thread_id ?? peerThread?.id ? { peerThreadId: row.peer_thread_id ?? peerThread?.id } : {}),
      ...(sanitizeAgentId(row.routine_id) ? { routineId: sanitizeAgentId(row.routine_id) as string } : {}),
      ...(row.draft_message ? { draftMessage: row.draft_message } : {}),
      ...(scheduledWakeup ? { scheduledWakeup } : {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      ...(row.provider_thread_id ? { providerThreadId: row.provider_thread_id } : {}),
      ...(normalizeAgentProvider(row.provider) ? { provider: normalizeAgentProvider(row.provider) } : {}),
      messages: this.messagesForConversation(row.id),
      ...(activeRun ? { activeRun } : {}),
      peerThreads: this.peerThreadsForConversation(row.id, { includeMessages: false }),
    };
  }

  private messagesForConversation(conversationId: string): PersonalAgentMessage[] {
    const rows = this.requireDb().prepare('SELECT * FROM personal_agent_messages WHERE conversation_id = ? ORDER BY created_at ASC').all(conversationId) as MessageRow[];
    return rows.map((row) => this.messageFromRow(row));
  }

  private messageFromRow(row: MessageRow): PersonalAgentMessage {
    const authorType = normalizeMessageAuthorType(row.author_type, row.role);
    const authorAgentId = authorType === 'agent' ? sanitizeAgentId(row.author_agent_id) : null;
    const authorAgentName = authorAgentId ? this.agentNameById(authorAgentId) : null;
    const files = this.messageFilesForMessage(row.id);
    return {
      id: row.id,
      agentId: row.agent_id,
      conversationId: row.conversation_id,
      ...(row.run_id ? { runId: row.run_id } : {}),
      role: normalizeMessageRole(row.role),
      kind: row.kind === 'intermediate' ? 'intermediate' : 'message',
      authorType,
      ...(authorAgentId ? { authorAgentId } : {}),
      ...(authorAgentName ? { authorAgentName } : {}),
      source: normalizeMessageSource(row.source),
      ...(sanitizeAgentId(row.routine_id) ? { routineId: sanitizeAgentId(row.routine_id) as string } : {}),
      ...(sanitizeAgentId(row.wakeup_id) ? { wakeupId: sanitizeAgentId(row.wakeup_id) as string } : {}),
      content: row.content,
      createdAt: row.created_at,
      ...(files.length > 0 ? { files } : {}),
    };
  }

  private messageFilesForMessage(messageId: string): PersonalAgentMessageFile[] {
    const rows = this.requireDb().prepare(`
      SELECT * FROM personal_agent_message_files
      WHERE message_id = ?
      ORDER BY created_at ASC
    `).all(messageId) as MessageFileRow[];
    return rows.map((row) => ({
      id: row.id,
      messageId: row.message_id,
      agentId: row.agent_id,
      conversationId: row.conversation_id,
      name: row.name,
      path: row.path,
      relativePath: row.relative_path,
      ...(typeof row.size_bytes === 'number' ? { sizeBytes: row.size_bytes } : {}),
      ...(normalizeSharedFileSource(row.source) ? { source: normalizeSharedFileSource(row.source) } : {}),
      createdAt: row.created_at,
    }));
  }

  private peerThreadRowById(threadId: string): PeerThreadRow | null {
    const id = sanitizeAgentId(threadId);
    if (!id) {
      return null;
    }
    return this.requireDb().prepare(`
      SELECT
        thread_row.*,
        caller.name AS caller_name,
        target.name AS target_name
      FROM personal_agent_peer_threads thread_row
      INNER JOIN personal_agents caller ON caller.id = thread_row.caller_agent_id
      INNER JOIN personal_agents target ON target.id = thread_row.target_agent_id
      WHERE thread_row.id = ?
    `).get(id) as PeerThreadRow | undefined ?? null;
  }

  private peerThreadRowByTargetConversation(conversationId: string): PeerThreadRow | null {
    return this.requireDb().prepare(`
      SELECT
        thread_row.*,
        caller.name AS caller_name,
        target.name AS target_name
      FROM personal_agent_peer_threads thread_row
      INNER JOIN personal_agents caller ON caller.id = thread_row.caller_agent_id
      INNER JOIN personal_agents target ON target.id = thread_row.target_agent_id
      WHERE thread_row.target_conversation_id = ?
    `).get(conversationId) as PeerThreadRow | undefined ?? null;
  }

  private peerThreadFromRow(
    row: PeerThreadRow,
    options: { includeMessages: boolean; includeChildren: boolean },
  ): PersonalAgentPeerThread {
    const messages = options.includeMessages ? this.messagesForConversation(row.target_conversation_id) : [];
    const children = options.includeChildren ? this.peerThreadChildren(row.id, options) : [];
    return {
      id: row.id,
      callerAgentId: row.caller_agent_id,
      ...(row.caller_name ? { callerAgentName: row.caller_name } : {}),
      targetAgentId: row.target_agent_id,
      ...(row.target_name ? { targetAgentName: row.target_name } : {}),
      sourceConversationId: row.source_conversation_id,
      targetConversationId: row.target_conversation_id,
      parentThreadId: row.parent_thread_id,
      rootThreadId: row.root_thread_id,
      createdByRunId: row.created_by_run_id,
      title: row.title,
      status: normalizePeerThreadStatus(row.status),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      ...(messages.length > 0 ? { messages } : {}),
      ...(children.length > 0 ? { children } : {}),
    };
  }

  private peerThreadChildren(
    parentThreadId: string,
    options: { includeMessages: boolean; includeChildren: boolean },
  ): PersonalAgentPeerThread[] {
    const rows = this.requireDb().prepare(`
      SELECT
        thread_row.*,
        caller.name AS caller_name,
        target.name AS target_name
      FROM personal_agent_peer_threads thread_row
      INNER JOIN personal_agents caller ON caller.id = thread_row.caller_agent_id
      INNER JOIN personal_agents target ON target.id = thread_row.target_agent_id
      WHERE thread_row.parent_thread_id = ?
      ORDER BY thread_row.updated_at DESC
    `).all(parentThreadId) as PeerThreadRow[];
    return rows.map((row) => this.peerThreadFromRow(row, options));
  }

  private peerThreadsForConversation(conversationId: string, options: { includeMessages: boolean }): PersonalAgentPeerThread[] {
    const rows = this.requireDb().prepare(`
      SELECT
        thread_row.*,
        caller.name AS caller_name,
        target.name AS target_name
      FROM personal_agent_peer_threads thread_row
      INNER JOIN personal_agents caller ON caller.id = thread_row.caller_agent_id
      INNER JOIN personal_agents target ON target.id = thread_row.target_agent_id
      WHERE thread_row.source_conversation_id = ?
      ORDER BY thread_row.updated_at DESC
    `).all(conversationId) as PeerThreadRow[];
    return rows.map((row) => this.peerThreadFromRow(row, { includeMessages: options.includeMessages, includeChildren: true }));
  }

  private agentNameById(agentId: string): string | null {
    const row = this.requireDb().prepare('SELECT name FROM personal_agents WHERE id = ?').get(agentId) as Pick<AgentRow, 'name'> | undefined;
    return row?.name ?? null;
  }

  private latestRunForConversation(conversationId: string): PersonalAgentRun | null {
    const row = this.requireDb().prepare(`
      SELECT * FROM personal_agent_runs
      WHERE conversation_id = ?
      ORDER BY created_at DESC
      LIMIT 1
    `).get(conversationId) as RunRow | undefined;
    return row ? this.runFromRow(row) : null;
  }

  private requireRun(runId: string): PersonalAgentRun {
    const run = this.runById(runId);
    if (!run) {
      throw new Error('personal_agent_run_not_found');
    }
    return run;
  }

  private runById(runId: string): PersonalAgentRun | null {
    const row = this.requireDb().prepare('SELECT * FROM personal_agent_runs WHERE id = ?').get(runId) as RunRow | undefined;
    return row ? this.runFromRow(row) : null;
  }

  private runFromRow(row: RunRow): PersonalAgentRun {
    return {
      id: row.id,
      agentId: row.agent_id,
      conversationId: row.conversation_id,
      status: normalizeRunStatus(row.status),
      progress: this.progressForRun(row.id),
      ...(row.error ? { error: row.error } : {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private progressForRun(runId: string): PersonalAgentRunProgress[] {
    const rows = this.requireDb().prepare('SELECT * FROM personal_agent_run_progress WHERE run_id = ? ORDER BY created_at ASC').all(runId) as RunProgressRow[];
    return rows.map(runProgressFromRow);
  }

  private touchConversation(agentId: string, conversationId: string, updatedAt: string): void {
    this.requireDb().prepare('UPDATE personal_agent_conversations SET updated_at = ? WHERE id = ?').run(updatedAt, conversationId);
    this.requireDb().prepare('UPDATE personal_agents SET updated_at = ? WHERE id = ?').run(updatedAt, agentId);
    this.touchPeerThreadsForConversation(conversationId, updatedAt);
  }

  private touchPeerThreadsForConversation(conversationId: string, updatedAt: string): void {
    const rows = this.requireDb().prepare(`
      SELECT id, caller_agent_id, source_conversation_id, root_thread_id
      FROM personal_agent_peer_threads
      WHERE source_conversation_id = ? OR target_conversation_id = ?
    `).all(conversationId, conversationId) as Pick<PeerThreadRow, 'id' | 'caller_agent_id' | 'source_conversation_id' | 'root_thread_id'>[];
    const updateThread = this.requireDb().prepare('UPDATE personal_agent_peer_threads SET updated_at = ? WHERE id = ?');
    const updateConversation = this.requireDb().prepare('UPDATE personal_agent_conversations SET updated_at = ? WHERE id = ?');
    const updateAgent = this.requireDb().prepare('UPDATE personal_agents SET updated_at = ? WHERE id = ?');
    for (const row of rows) {
      updateThread.run(updatedAt, row.id);
      if (row.root_thread_id) {
        updateThread.run(updatedAt, row.root_thread_id);
      }
      if (row.source_conversation_id !== conversationId) {
        updateConversation.run(updatedAt, row.source_conversation_id);
        updateAgent.run(updatedAt, row.caller_agent_id);
      }
    }
  }

  private requireDb(): SqliteDatabase {
    if (!this.db) {
      throw new Error('personal_agent_store_not_loaded');
    }
    return this.db;
  }

  private sqlitePath(): string {
    return path.join(this.options.metadataRoot, 'personal-agents.sqlite');
  }

  private agentRoot(agentId: string): string {
    return path.join(this.options.forgerHomeRoot, 'agents', agentId);
  }

  private workspaceRoot(agentId: string): string {
    return path.join(this.agentRoot(agentId), 'workspace');
  }

  private async ensureWorkspaceContained(workspaceRoot: string, candidatePath: string): Promise<string> {
    const [realWorkspaceRoot, realCandidatePath] = await Promise.all([
      fs.realpath(workspaceRoot),
      fs.realpath(candidatePath),
    ]);
    const relativePath = path.relative(realWorkspaceRoot, realCandidatePath);
    if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
      throw new Error('personal_agent_workspace_path_outside_root');
    }
    return realCandidatePath;
  }
  private async resolveWorkspaceFile(agentId: string, relativePath: string): Promise<string> {
    const cleanRelativePath = path.normalize(relativePath);
    if (!cleanRelativePath || cleanRelativePath.startsWith('..') || path.isAbsolute(cleanRelativePath)) {
      throw new Error('personal_agent_workspace_path_outside_root');
    }
    const workspaceRoot = this.workspaceRoot(agentId);
    const candidatePath = path.join(workspaceRoot, cleanRelativePath);
    return await this.ensureWorkspaceContained(workspaceRoot, candidatePath);
  }
}
