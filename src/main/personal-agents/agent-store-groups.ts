import { randomUUID } from 'node:crypto';

import type {
  PersonalAgent,
  PersonalAgentGroup,
  PersonalAgentGroupCreateInput,
  PersonalAgentGroupUpdateInput,
  PersonalAgentUpdateGroupInput,
} from '../../shared/types';
import type { SqliteDatabase } from './sqlite';
import { MAX_NAME_LENGTH, sanitizeAgentId, sanitizeText, statementChanges } from './agent-store-normalizers';

interface GroupRow {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
}

interface AgentGroupStoreOptions {
  load: () => Promise<void>;
  requireDb: () => SqliteDatabase;
  requireAgent: (agentId: string) => Promise<PersonalAgent>;
}

export class AgentGroupStore {
  public constructor(private readonly options: AgentGroupStoreOptions) {}

  public async list(): Promise<PersonalAgentGroup[]> {
    await this.options.load();
    const rows = this.options.requireDb().prepare('SELECT * FROM personal_agent_groups ORDER BY name COLLATE NOCASE ASC').all() as GroupRow[];
    return rows.map(groupFromRow);
  }

  public async create(input: PersonalAgentGroupCreateInput): Promise<PersonalAgentGroup> {
    await this.options.load();
    const name = sanitizeText(input.name, MAX_NAME_LENGTH);
    if (!name) throw new Error('personal_agent_group_name_required');
    const now = new Date().toISOString();
    const group: PersonalAgentGroup = { id: randomUUID(), name, createdAt: now, updatedAt: now };
    this.options.requireDb().prepare('INSERT INTO personal_agent_groups (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run(group.id, group.name, group.createdAt, group.updatedAt);
    return group;
  }

  public async update(input: PersonalAgentGroupUpdateInput): Promise<PersonalAgentGroup> {
    await this.options.load();
    const groupId = sanitizeAgentId(input.groupId);
    const name = sanitizeText(input.name, MAX_NAME_LENGTH);
    if (!groupId || !name) throw new Error('personal_agent_group_input_invalid');
    const now = new Date().toISOString();
    const result = this.options.requireDb().prepare('UPDATE personal_agent_groups SET name = ?, updated_at = ? WHERE id = ?').run(name, now, groupId);
    if (statementChanges(result) === 0) throw new Error('personal_agent_group_not_found');
    return this.require(groupId);
  }

  public async delete(groupId: string): Promise<{ success: boolean }> {
    await this.options.load();
    const id = sanitizeAgentId(groupId);
    if (!id) throw new Error('personal_agent_group_not_found');
    const result = this.options.requireDb().prepare('DELETE FROM personal_agent_groups WHERE id = ?').run(id);
    if (statementChanges(result) === 0) throw new Error('personal_agent_group_not_found');
    return { success: true };
  }

  public async updateAgent(input: PersonalAgentUpdateGroupInput): Promise<PersonalAgent> {
    await this.options.load();
    const agent = await this.options.requireAgent(input.agentId);
    const groupId = sanitizeAgentId(input.groupId ?? undefined) ?? null;
    if (groupId) this.require(groupId);
    const now = new Date().toISOString();
    this.options.requireDb().prepare('UPDATE personal_agents SET group_id = ?, updated_at = ? WHERE id = ?').run(groupId, now, agent.id);
    return this.options.requireAgent(agent.id);
  }

  public require(id: string): PersonalAgentGroup {
    const row = this.options.requireDb().prepare('SELECT * FROM personal_agent_groups WHERE id = ?').get(id) as GroupRow | undefined;
    if (!row) throw new Error('personal_agent_group_not_found');
    return groupFromRow(row);
  }
}

const groupFromRow = (row: GroupRow): PersonalAgentGroup => ({
  id: row.id,
  name: row.name,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});
