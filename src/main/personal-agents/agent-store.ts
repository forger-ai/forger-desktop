import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { AgentPermissionMode, AgentProvider, AgentRuntime, AgentToolId, PersonalAgent, PersonalAgentConnectionGrant, PersonalAgentConversation, PersonalAgentConversationStatus, PersonalAgentCreateInput, PersonalAgentHeartbeatSummary, PersonalAgentJournalEntry, PersonalAgentMemory, PersonalAgentMessage, PersonalAgentMessageKind, PersonalAgentMessageRole, PersonalAgentPermission, PersonalAgentRun, PersonalAgentRunProgress, PersonalAgentRunStatus, PersonalAgentUpdatePermissionsInput, PersonalAgentWorkspaceEntry, PersonalAgentWorkspaceFile } from '../../shared/types';
import { buildGlobalSkillTemplates } from '../prompt-builder/official-tools';
import { buildPersonalAgentWorkspaceDocuments } from '../prompt-builder/personal-agents';
import { forgerSkillRoots, writeSkillTemplates } from '../prompt-builder/skill-template-writer';
import { openPersonalAgentSqliteDatabase, type SqliteDatabase } from './sqlite';

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
  content: string;
  created_at: string;
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

const MAX_NAME_LENGTH = 100;
const MAX_DESCRIPTION_LENGTH = 500;
const MAX_TEXT_LENGTH = 8_000;
const MAX_GRANTS = 200;
const MAX_WORKSPACE_TREE_DEPTH = 4;
const MAX_WORKSPACE_TREE_ENTRIES = 200;
const MAX_WORKSPACE_TEXT_FILE_BYTES = 256 * 1024;

export class AgentStore {
  private db: SqliteDatabase | null = null;
  private loadPromise: Promise<void> | null = null;

  public constructor(private readonly options: AgentStoreOptions) {}

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
    return await this.requireAgent(agent.id);
  }

  public async listPermissions(agentId: string): Promise<PersonalAgentPermission[]> {
    await this.load();
    const rows = this.requireDb().prepare('SELECT * FROM personal_agent_permissions WHERE agent_id = ? ORDER BY created_at ASC').all(agentId) as PermissionRow[];
    return rows.map(permissionFromRow);
  }

  public async createConversation(input: { agentId: string; title?: string }): Promise<PersonalAgentConversation> {
    await this.load();
    const agent = await this.requireAgent(input.agentId);
    const now = new Date().toISOString();
    const conversationId = randomUUID();
    this.requireDb().prepare(`
      INSERT INTO personal_agent_conversations (id, agent_id, title, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      conversationId,
      agent.id,
      sanitizeText(input.title, 160) || agent.name,
      'active',
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
    content: string;
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
    const message: PersonalAgentMessage = {
      id: randomUUID(),
      agentId: input.agentId,
      conversationId: input.conversationId,
      ...(input.runId ? { runId: input.runId } : {}),
      role: normalizeMessageRole(input.role),
      kind: input.kind === 'intermediate' ? 'intermediate' : 'message',
      content,
      createdAt: now,
    };
    this.requireDb().prepare(`
      INSERT INTO personal_agent_messages (id, agent_id, conversation_id, run_id, role, kind, content, created_at)
      VALUES (@id, @agentId, @conversationId, @runId, @role, @kind, @content, @createdAt)
    `).run({ ...message, runId: message.runId ?? null });
    this.requireDb().prepare('UPDATE personal_agent_conversations SET updated_at = ? WHERE id = ?').run(now, input.conversationId);
    this.requireDb().prepare('UPDATE personal_agents SET updated_at = ? WHERE id = ?').run(now, input.agentId);
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
    const message = sanitizeText(input.message, 1_000);
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
    await this.requireAgent(agentId);
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
    let count = 0;
    const workspaceRoot = this.workspaceRoot(agentId);

    const readEntries = async (currentRoot: string, depth: number): Promise<PersonalAgentWorkspaceEntry[]> => {
      if (depth > MAX_WORKSPACE_TREE_DEPTH || count >= MAX_WORKSPACE_TREE_ENTRIES) {
        return [];
      }
      const entries = await fs.readdir(currentRoot, { withFileTypes: true });
      const visibleEntries = entries
        .filter((entry) => !entry.name.startsWith('.'))
        .sort((left, right) => {
          if (left.isDirectory() !== right.isDirectory()) {
            return left.isDirectory() ? -1 : 1;
          }
          return left.name.localeCompare(right.name);
        });
      const tree: PersonalAgentWorkspaceEntry[] = [];
      for (const entry of visibleEntries) {
        if (count >= MAX_WORKSPACE_TREE_ENTRIES) break;
        const absolutePath = path.join(currentRoot, entry.name);
        const relativePath = path.relative(workspaceRoot, absolutePath);
        if (entry.isDirectory()) {
          const containedPath = await this.ensureWorkspaceContained(workspaceRoot, absolutePath);
          count += 1;
          tree.push({
            name: entry.name,
            relativePath,
            kind: 'directory',
            children: await readEntries(containedPath, depth + 1),
          });
        } else if (entry.isFile()) {
          count += 1;
          tree.push({
            name: entry.name,
            relativePath,
            kind: 'file',
          });
        }
      }
      return tree;
    };

    return await readEntries(workspaceRoot, 0);
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
    this.requireDb().exec(`
      CREATE TABLE IF NOT EXISTS personal_agents (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        purpose TEXT NOT NULL DEFAULT '',
        instructions TEXT NOT NULL DEFAULT '',
        permission_mode TEXT NOT NULL DEFAULT 'safe',
        network_access INTEGER NOT NULL DEFAULT 0,
        runtime_provider TEXT,
        runtime_model TEXT,
        runtime_effort TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS personal_agent_permissions (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL REFERENCES personal_agents(id) ON DELETE CASCADE,
        kind TEXT NOT NULL DEFAULT 'legacy',
        target_id TEXT NOT NULL DEFAULT '',
        permission TEXT NOT NULL,
        mode TEXT NOT NULL DEFAULT 'safe',
        granted INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(agent_id, kind, target_id)
      );
      CREATE TABLE IF NOT EXISTS personal_agent_conversations (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL REFERENCES personal_agents(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        provider TEXT,
        provider_thread_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_personal_agent_conversations_agent ON personal_agent_conversations(agent_id, updated_at);
      CREATE TABLE IF NOT EXISTS personal_agent_messages (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL REFERENCES personal_agents(id) ON DELETE CASCADE,
        conversation_id TEXT NOT NULL REFERENCES personal_agent_conversations(id) ON DELETE CASCADE,
        run_id TEXT REFERENCES personal_agent_runs(id) ON DELETE SET NULL,
        role TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'message',
        content TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_personal_agent_messages_conversation ON personal_agent_messages(conversation_id, created_at);
      CREATE TABLE IF NOT EXISTS personal_agent_runs (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL REFERENCES personal_agents(id) ON DELETE CASCADE,
        conversation_id TEXT NOT NULL REFERENCES personal_agent_conversations(id) ON DELETE CASCADE,
        status TEXT NOT NULL DEFAULT 'queued',
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_personal_agent_runs_conversation ON personal_agent_runs(conversation_id, updated_at);
      CREATE TABLE IF NOT EXISTS personal_agent_run_progress (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL REFERENCES personal_agents(id) ON DELETE CASCADE,
        conversation_id TEXT NOT NULL REFERENCES personal_agent_conversations(id) ON DELETE CASCADE,
        run_id TEXT NOT NULL REFERENCES personal_agent_runs(id) ON DELETE CASCADE,
        message TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_personal_agent_run_progress_run ON personal_agent_run_progress(run_id, created_at);
      CREATE TABLE IF NOT EXISTS personal_agent_memories (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL REFERENCES personal_agents(id) ON DELETE CASCADE,
        remember_when TEXT NOT NULL DEFAULT '',
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS personal_agent_journal_entries (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL REFERENCES personal_agents(id) ON DELETE CASCADE,
        conversation_id TEXT REFERENCES personal_agent_conversations(id) ON DELETE SET NULL,
        body TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    this.ensureColumn('personal_agents', 'runtime_provider', 'TEXT');
    this.ensureColumn('personal_agents', 'runtime_model', 'TEXT');
    this.ensureColumn('personal_agents', 'runtime_effort', 'TEXT');
    this.ensureColumn('personal_agent_conversations', 'provider', 'TEXT');
    this.ensureColumn('personal_agent_conversations', 'provider_thread_id', 'TEXT');
    this.ensureColumn('personal_agent_messages', 'run_id', 'TEXT REFERENCES personal_agent_runs(id) ON DELETE SET NULL');
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

  private async agentById(id: string): Promise<PersonalAgent | null> {
    const row = this.requireDb().prepare('SELECT * FROM personal_agents WHERE id = ?').get(id) as AgentRow | undefined;
    return row ? this.agentFromRow(row) : null;
  }

  private agentFromRow(row: AgentRow): PersonalAgent {
    const appIds = this.grantsForAgent(row.id, 'app') as string[];
    const toolIds = this.grantsForAgent(row.id, 'tool') as AgentToolId[];
    const connectionGrants = this.connectionGrantsForAgent(row.id);
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
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
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
    return {
      id: row.id,
      agentId: row.agent_id,
      title: row.title,
      status: normalizeConversationStatus(row.status),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      ...(row.provider_thread_id ? { providerThreadId: row.provider_thread_id } : {}),
      ...(normalizeAgentProvider(row.provider) ? { provider: normalizeAgentProvider(row.provider) } : {}),
      messages: this.messagesForConversation(row.id),
      ...(activeRun ? { activeRun } : {}),
    };
  }

  private messagesForConversation(conversationId: string): PersonalAgentMessage[] {
    const rows = this.requireDb().prepare('SELECT * FROM personal_agent_messages WHERE conversation_id = ? ORDER BY created_at ASC').all(conversationId) as MessageRow[];
    return rows.map(messageFromRow);
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

const sanitizeText = (value: unknown, maxLength: number): string =>
  typeof value === 'string' ? value.trim().slice(0, maxLength) : '';

const normalizeMessageText = (value: unknown): string =>
  sanitizeText(value, MAX_TEXT_LENGTH).replace(/\s+/g, ' ').trim();

const normalizeProgressPrefix = (value: unknown): string =>
  normalizeMessageText(value)
    .replace(/(?:\.{3}|…)+$/g, '')
    .trim();

const isDuplicateFinalProgress = (normalizedFinal: string, candidate: unknown): boolean => {
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

const statementChanges = (result: unknown): number =>
  result && typeof result === 'object' && typeof (result as { changes?: unknown }).changes === 'number'
    ? (result as { changes: number }).changes
    : 0;

const sanitizeAgentId = (value: unknown): string | null =>
  typeof value === 'string' && /^[a-zA-Z0-9_-]{1,120}$/.test(value) ? value : null;

const sanitizeGrantTarget = (value: unknown): string | null =>
  typeof value === 'string' && /^[a-zA-Z0-9._:-]{1,180}$/.test(value.trim()) ? value.trim() : null;

const normalizeGrantTargets = (value: unknown): string[] => {
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

const normalizeConnectionGrants = (value: unknown): PersonalAgentConnectionGrant[] => {
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

const encodeConnectionGrant = (grant: PersonalAgentConnectionGrant): string =>
  JSON.stringify(grant);

const decodeConnectionGrant = (value: unknown): PersonalAgentConnectionGrant | null => {
  if (typeof value !== 'string' || !value.trim()) {
    return null;
  }
  try {
    return normalizeConnectionGrant(JSON.parse(value) as unknown);
  } catch {
    return null;
  }
};

const normalizePermissionMode = (value: unknown): AgentPermissionMode => value === 'unsafe' ? 'unsafe' : 'safe';

const normalizeAgentProvider = (value: unknown): AgentProvider | null => {
  if (value === 'codex' || value === 'claude' || value === 'antigravity') {
    return value;
  }
  return null;
};

const normalizeAgentRuntime = (value: unknown): AgentRuntime | undefined => {
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

const normalizeMessageRole = (value: unknown): PersonalAgentMessageRole => {
  if (value === 'assistant' || value === 'system') return value;
  return 'user';
};

const normalizeConversationStatus = (value: unknown): PersonalAgentConversationStatus => value === 'archived' ? 'archived' : 'active';

const normalizeRunStatus = (value: unknown): PersonalAgentRunStatus => {
  if (value === 'running' || value === 'needs_permission' || value === 'completed' || value === 'failed' || value === 'canceled') return value;
  return 'queued';
};

export const isTerminalRunStatus = (status: PersonalAgentRunStatus | undefined): boolean =>
  status === 'completed' || status === 'failed' || status === 'canceled';

const deriveTitle = (body: string): string => body.split(/\s+/).slice(0, 8).join(' ').slice(0, 160);

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

const isLegacyWorkspacePrompt = (content: string): boolean =>
  LEGACY_WORKSPACE_PROMPT_SNIPPETS.some((snippet) => content.includes(snippet)) ||
  LEGACY_MINIMAL_WORKSPACE_PROMPT_PATTERNS.some((pattern) => pattern.test(content));

const parsePermissionGrant = (row: Pick<PermissionRow, 'permission'> & Partial<Pick<PermissionRow, 'kind' | 'target_id'>>): { kind: PersonalAgentPermission['kind']; targetId: string; permission: string } => {
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

const permissionFromRow = (row: PermissionRow): PersonalAgentPermission => ({
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

const messageFromRow = (row: MessageRow): PersonalAgentMessage => ({
  id: row.id,
  agentId: row.agent_id,
  conversationId: row.conversation_id,
  ...(row.run_id ? { runId: row.run_id } : {}),
  role: normalizeMessageRole(row.role),
  kind: row.kind === 'intermediate' ? 'intermediate' : 'message',
  content: row.content,
  createdAt: row.created_at,
});

const runProgressFromRow = (row: RunProgressRow): PersonalAgentRunProgress => ({
  id: row.id,
  agentId: row.agent_id,
  conversationId: row.conversation_id,
  runId: row.run_id,
  message: row.message,
  createdAt: row.created_at,
});

const memoryFromRow = (row: MemoryRow): PersonalAgentMemory => ({
  id: row.id,
  agentId: row.agent_id,
  rememberWhen: row.remember_when,
  title: row.title,
  content: row.content,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const journalEntryFromRow = (row: JournalEntryRow): PersonalAgentJournalEntry => ({
  id: row.id,
  agentId: row.agent_id,
  ...(row.conversation_id ? { conversationId: row.conversation_id } : {}),
  body: row.body,
  createdAt: row.created_at,
});
