import { randomUUID } from 'node:crypto';
import type {
  AutomationFrequency,
  AutomationMissedRunPolicy,
  PersonalAgent,
  PersonalAgentConversation,
  PersonalAgentConversationOrigin,
  PersonalAgentRoutine,
  PersonalAgentRoutineRun,
  PersonalAgentRoutineRunStatus,
  PersonalAgentRoutineRunSummary,
  PersonalAgentScheduledWakeup,
} from '../../shared/types';
import type { SqliteDatabase } from './sqlite';
import {
  MAX_NAME_LENGTH,
  MAX_TEXT_LENGTH,
  normalizeRoutineRunStatus,
  normalizeWakeupStatus,
  sanitizeAgentId,
  sanitizeText,
} from './agent-store-normalizers';

interface RoutineRow {
  id: string;
  agent_id: string;
  conversation_id: string;
  name: string;
  prompt: string;
  frequency_type: string;
  frequency_time_of_day: string | null;
  frequency_weekly_day: number | null;
  missed_run_policy: string;
  missed_run_window_minutes: number | null;
  enabled: number;
  running: number;
  next_run_at: string | null;
  authorization_text: string;
  created_at: string;
  updated_at: string;
}

interface RoutineRunRow {
  id: string;
  routine_id: string;
  agent_id: string;
  conversation_id: string;
  trigger: string;
  status: string;
  started_at: string;
  finished_at: string | null;
  error: string | null;
  message_id: string | null;
}

interface WakeupRow {
  id: string;
  agent_id: string;
  conversation_id: string;
  prompt: string;
  due_at: string;
  status: string;
  created_by_run_id: string | null;
  created_at: string;
  updated_at: string;
}

interface AgentRoutineStoreContext {
  load: () => Promise<void>;
  requireDb: () => SqliteDatabase;
  requireAgent: (agentId: string) => Promise<PersonalAgent>;
  requireConversation: (conversationId: string) => Promise<PersonalAgentConversation>;
  createConversation: (input: {
    agentId: string;
    title?: string;
    origin?: PersonalAgentConversationOrigin;
    routineId?: string | null;
  }) => Promise<PersonalAgentConversation>;
  updateConversationTitle: (input: { conversationId: string; title: string }) => Promise<PersonalAgentConversation>;
  touchConversation: (agentId: string, conversationId: string, updatedAt: string) => void;
}

export class AgentRoutineStore {
  public constructor(private readonly context: AgentRoutineStoreContext) {}

  public async listRoutines(agentId: string): Promise<PersonalAgentRoutine[]> {
    await this.context.load();
    await this.context.requireAgent(agentId);
    const rows = this.context.requireDb().prepare('SELECT * FROM personal_agent_routines WHERE agent_id = ? ORDER BY updated_at DESC').all(agentId) as RoutineRow[];
    return rows.map((row) => this.routineFromRow(row));
  }

  public async getRoutine(routineId: string): Promise<PersonalAgentRoutine | null> {
    await this.context.load();
    const row = this.routineRowById(routineId);
    return row ? this.routineFromRow(row) : null;
  }

  public async requireRoutine(routineId: string): Promise<PersonalAgentRoutine> {
    const routine = await this.getRoutine(routineId);
    if (!routine) {
      throw new Error('personal_agent_routine_not_found');
    }
    return routine;
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
    await this.context.load();
    const agent = await this.context.requireAgent(input.agentId);
    const name = sanitizeText(input.name, MAX_NAME_LENGTH);
    const prompt = sanitizeText(input.prompt, MAX_TEXT_LENGTH);
    const authorizationText = sanitizeText(input.authorizationText, MAX_TEXT_LENGTH);
    if (!name) throw new Error('personal_agent_routine_name_required');
    if (!prompt) throw new Error('personal_agent_routine_prompt_required');
    if (!authorizationText) throw new Error('personal_agent_routine_authorization_required');
    const now = new Date().toISOString();
    const routineId = randomUUID();
    const conversation = await this.context.createConversation({
      agentId: agent.id,
      title: name,
      origin: 'routine',
      routineId,
    });
    const frequency = normalizeRoutineFrequency(input.frequency);
    this.context.requireDb().prepare(`
      INSERT INTO personal_agent_routines (
        id, agent_id, conversation_id, name, prompt, frequency_type,
        frequency_time_of_day, frequency_weekly_day, missed_run_policy,
        missed_run_window_minutes, enabled, running, next_run_at,
        authorization_text, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      routineId,
      agent.id,
      conversation.id,
      name,
      prompt,
      frequency.type,
      frequency.timeOfDay ?? null,
      frequency.weeklyDay ?? null,
      normalizeMissedRunPolicy(input.missedRunPolicy),
      normalizeMissedRunWindowMinutes(input.missedRunWindowMinutes, frequency),
      input.enabled ? 1 : 0,
      0,
      input.enabled ? input.nextRunAt : null,
      authorizationText,
      now,
      now,
    );
    return await this.requireRoutine(routineId);
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
    await this.context.load();
    const routine = await this.requireRoutine(input.routineId);
    const name = sanitizeText(input.name, MAX_NAME_LENGTH);
    const prompt = sanitizeText(input.prompt, MAX_TEXT_LENGTH);
    const authorizationText = sanitizeText(input.authorizationText, MAX_TEXT_LENGTH);
    if (!name) throw new Error('personal_agent_routine_name_required');
    if (!prompt) throw new Error('personal_agent_routine_prompt_required');
    if (!authorizationText) throw new Error('personal_agent_routine_authorization_required');
    const frequency = normalizeRoutineFrequency(input.frequency);
    const now = new Date().toISOString();
    this.context.requireDb().prepare(`
      UPDATE personal_agent_routines
      SET name = ?, prompt = ?, frequency_type = ?, frequency_time_of_day = ?,
        frequency_weekly_day = ?, missed_run_policy = ?, missed_run_window_minutes = ?,
        enabled = ?, next_run_at = ?, authorization_text = ?, updated_at = ?
      WHERE id = ?
    `).run(
      name,
      prompt,
      frequency.type,
      frequency.timeOfDay ?? null,
      frequency.weeklyDay ?? null,
      normalizeMissedRunPolicy(input.missedRunPolicy),
      normalizeMissedRunWindowMinutes(input.missedRunWindowMinutes, frequency),
      input.enabled ? 1 : 0,
      input.enabled ? input.nextRunAt : null,
      authorizationText,
      now,
      routine.id,
    );
    await this.context.updateConversationTitle({ conversationId: routine.conversationId, title: name });
    return await this.requireRoutine(routine.id);
  }

  public async deleteRoutine(routineId: string): Promise<{ success: boolean }> {
    await this.context.load();
    const routine = await this.requireRoutine(routineId);
    this.context.requireDb().prepare(`
      UPDATE personal_agent_conversations
      SET origin = 'user', routine_id = NULL, updated_at = ?
      WHERE id = ?
    `).run(new Date().toISOString(), routine.conversationId);
    this.context.requireDb().prepare('DELETE FROM personal_agent_routines WHERE id = ?').run(routine.id);
    return { success: true };
  }

  public async setRoutineEnabled(input: { routineId: string; enabled: boolean; nextRunAt: string | null }): Promise<PersonalAgentRoutine> {
    await this.context.load();
    const routine = await this.requireRoutine(input.routineId);
    const now = new Date().toISOString();
    this.context.requireDb().prepare(`
      UPDATE personal_agent_routines
      SET enabled = ?, next_run_at = ?, updated_at = ?
      WHERE id = ?
    `).run(input.enabled ? 1 : 0, input.enabled ? input.nextRunAt : null, now, routine.id);
    return await this.requireRoutine(routine.id);
  }

  public async updateRoutineSchedule(input: { routineId: string; running?: boolean; nextRunAt?: string | null; lastUpdatedAt?: string }): Promise<PersonalAgentRoutine> {
    await this.context.load();
    const routine = await this.requireRoutine(input.routineId);
    const now = input.lastUpdatedAt ?? new Date().toISOString();
    this.context.requireDb().prepare(`
      UPDATE personal_agent_routines
      SET running = ?, next_run_at = ?, updated_at = ?
      WHERE id = ?
    `).run(
      typeof input.running === 'boolean' ? (input.running ? 1 : 0) : (routine.running ? 1 : 0),
      Object.prototype.hasOwnProperty.call(input, 'nextRunAt') ? input.nextRunAt ?? null : routine.nextRunAt,
      now,
      routine.id,
    );
    return await this.requireRoutine(routine.id);
  }

  public async createRoutineRun(input: {
    routineId: string;
    trigger: PersonalAgentRoutineRun['trigger'];
    status?: PersonalAgentRoutineRunStatus;
    error?: string;
    messageId?: string;
  }): Promise<PersonalAgentRoutineRun> {
    await this.context.load();
    const routine = await this.requireRoutine(input.routineId);
    const now = new Date().toISOString();
    const run: PersonalAgentRoutineRun = {
      id: randomUUID(),
      routineId: routine.id,
      agentId: routine.agentId,
      conversationId: routine.conversationId,
      trigger: input.trigger,
      status: normalizeRoutineRunStatus(input.status),
      startedAt: now,
      ...(input.status === 'skipped' ? { finishedAt: now } : {}),
      ...(sanitizeText(input.error, MAX_TEXT_LENGTH) ? { error: sanitizeText(input.error, MAX_TEXT_LENGTH) } : {}),
      ...(sanitizeAgentId(input.messageId) ? { messageId: sanitizeAgentId(input.messageId) as string } : {}),
    };
    this.context.requireDb().prepare(`
      INSERT INTO personal_agent_routine_runs (id, routine_id, agent_id, conversation_id, trigger, status, started_at, finished_at, error, message_id)
      VALUES (@id, @routineId, @agentId, @conversationId, @trigger, @status, @startedAt, @finishedAt, @error, @messageId)
    `).run({ ...run, finishedAt: run.finishedAt ?? null, error: run.error ?? null, messageId: run.messageId ?? null });
    return run;
  }

  public async updateRoutineRun(input: { runId: string; status: PersonalAgentRoutineRunStatus; error?: string; messageId?: string }): Promise<PersonalAgentRoutineRun> {
    await this.context.load();
    const current = this.routineRunRowById(input.runId);
    if (!current) {
      throw new Error('personal_agent_routine_run_not_found');
    }
    const status = normalizeRoutineRunStatus(input.status);
    const finishedAt = status === 'succeeded' || status === 'failed' || status === 'skipped'
      ? new Date().toISOString()
      : null;
    this.context.requireDb().prepare(`
      UPDATE personal_agent_routine_runs
      SET status = ?, finished_at = ?, error = ?, message_id = ?
      WHERE id = ?
    `).run(
      status,
      finishedAt,
      sanitizeText(input.error, MAX_TEXT_LENGTH) || null,
      sanitizeAgentId(input.messageId) ?? current.message_id,
      current.id,
    );
    const updated = this.routineRunRowById(current.id);
    if (!updated) throw new Error('personal_agent_routine_run_not_found');
    return routineRunFromRow(updated);
  }

  public async scheduleWakeup(input: {
    agentId: string;
    conversationId: string;
    prompt: string;
    dueAt: string;
    createdByRunId?: string | null;
  }): Promise<PersonalAgentScheduledWakeup> {
    await this.context.load();
    const conversation = await this.context.requireConversation(input.conversationId);
    if (conversation.agentId !== input.agentId) {
      throw new Error('personal_agent_conversation_mismatch');
    }
    const prompt = sanitizeText(input.prompt, MAX_TEXT_LENGTH);
    if (!prompt) {
      throw new Error('personal_agent_wakeup_prompt_required');
    }
    const active = this.scheduledWakeupRowForConversation(conversation.id);
    if (active) {
      throw new Error('personal_agent_wakeup_active');
    }
    const now = new Date().toISOString();
    const wakeup: PersonalAgentScheduledWakeup = {
      id: randomUUID(),
      agentId: conversation.agentId,
      conversationId: conversation.id,
      prompt,
      dueAt: input.dueAt,
      status: 'scheduled',
      createdByRunId: input.createdByRunId ?? null,
      createdAt: now,
      updatedAt: now,
    };
    this.context.requireDb().prepare(`
      INSERT INTO personal_agent_wakeups (id, agent_id, conversation_id, prompt, due_at, status, created_by_run_id, created_at, updated_at)
      VALUES (@id, @agentId, @conversationId, @prompt, @dueAt, @status, @createdByRunId, @createdAt, @updatedAt)
    `).run(wakeup);
    this.context.touchConversation(wakeup.agentId, wakeup.conversationId, now);
    return wakeup;
  }

  public async cancelWakeup(input: { wakeupId?: string; conversationId?: string }): Promise<PersonalAgentScheduledWakeup | null> {
    await this.context.load();
    const row = input.wakeupId
      ? this.wakeupRowById(input.wakeupId)
      : input.conversationId
        ? this.scheduledWakeupRowForConversation(input.conversationId)
        : null;
    if (!row || normalizeWakeupStatus(row.status) !== 'scheduled') {
      return null;
    }
    return this.updateWakeupStatus({ wakeupId: row.id, status: 'canceled' });
  }

  public async updateWakeupStatus(input: { wakeupId: string; status: PersonalAgentScheduledWakeup['status'] }): Promise<PersonalAgentScheduledWakeup> {
    await this.context.load();
    const row = this.wakeupRowById(input.wakeupId);
    if (!row) {
      throw new Error('personal_agent_wakeup_not_found');
    }
    const now = new Date().toISOString();
    this.context.requireDb().prepare('UPDATE personal_agent_wakeups SET status = ?, updated_at = ? WHERE id = ?').run(
      normalizeWakeupStatus(input.status),
      now,
      row.id,
    );
    this.context.touchConversation(row.agent_id, row.conversation_id, now);
    const updated = this.wakeupRowById(row.id);
    if (!updated) throw new Error('personal_agent_wakeup_not_found');
    return wakeupFromRow(updated);
  }

  public async listScheduledWakeups(): Promise<PersonalAgentScheduledWakeup[]> {
    await this.context.load();
    const rows = this.context.requireDb().prepare('SELECT * FROM personal_agent_wakeups WHERE status = ? ORDER BY due_at ASC').all('scheduled') as WakeupRow[];
    return rows.map(wakeupFromRow);
  }

  public async updateConversationDraft(input: { conversationId: string; draftMessage: string }): Promise<PersonalAgentConversation> {
    await this.context.load();
    const conversation = await this.context.requireConversation(input.conversationId);
    const now = new Date().toISOString();
    this.context.requireDb().prepare('UPDATE personal_agent_conversations SET draft_message = ?, updated_at = ? WHERE id = ?').run(
      sanitizeText(input.draftMessage, MAX_TEXT_LENGTH),
      now,
      conversation.id,
    );
    return await this.context.requireConversation(conversation.id);
  }

  public scheduledWakeupForConversation(conversationId: string): PersonalAgentScheduledWakeup | null {
    const row = this.scheduledWakeupRowForConversation(conversationId);
    return row ? wakeupFromRow(row) : null;
  }

  private routineRowById(routineId: string): RoutineRow | null {
    const id = sanitizeAgentId(routineId);
    if (!id) {
      return null;
    }
    return this.context.requireDb().prepare('SELECT * FROM personal_agent_routines WHERE id = ?').get(id) as RoutineRow | undefined ?? null;
  }

  private routineFromRow(row: RoutineRow): PersonalAgentRoutine {
    const lastRun = this.latestRoutineRunForRoutine(row.id);
    return {
      id: row.id,
      agentId: row.agent_id,
      conversationId: row.conversation_id,
      name: row.name,
      prompt: row.prompt,
      frequency: frequencyFromRow(row),
      missedRunPolicy: normalizeMissedRunPolicy(row.missed_run_policy),
      ...(typeof row.missed_run_window_minutes === 'number' ? { missedRunWindowMinutes: row.missed_run_window_minutes } : {}),
      enabled: row.enabled !== 0,
      running: row.running !== 0,
      nextRunAt: row.next_run_at,
      authorizationText: row.authorization_text,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      ...(lastRun ? { lastRun } : {}),
    };
  }

  private routineRunRowById(runId: string): RoutineRunRow | null {
    const id = sanitizeAgentId(runId);
    if (!id) {
      return null;
    }
    return this.context.requireDb().prepare('SELECT * FROM personal_agent_routine_runs WHERE id = ?').get(id) as RoutineRunRow | undefined ?? null;
  }

  private latestRoutineRunForRoutine(routineId: string): PersonalAgentRoutineRunSummary | null {
    const row = this.context.requireDb().prepare(`
      SELECT * FROM personal_agent_routine_runs
      WHERE routine_id = ?
      ORDER BY started_at DESC
      LIMIT 1
    `).get(routineId) as RoutineRunRow | undefined;
    return row ? routineRunFromRow(row) : null;
  }

  private wakeupRowById(wakeupId: string): WakeupRow | null {
    const id = sanitizeAgentId(wakeupId);
    if (!id) {
      return null;
    }
    return this.context.requireDb().prepare('SELECT * FROM personal_agent_wakeups WHERE id = ?').get(id) as WakeupRow | undefined ?? null;
  }

  private scheduledWakeupRowForConversation(conversationId: string): WakeupRow | null {
    const id = sanitizeAgentId(conversationId);
    if (!id) {
      return null;
    }
    return this.context.requireDb().prepare(`
      SELECT * FROM personal_agent_wakeups
      WHERE conversation_id = ? AND status = 'scheduled'
      ORDER BY due_at ASC
      LIMIT 1
    `).get(id) as WakeupRow | undefined ?? null;
  }
}

export const PERSONAL_AGENT_ROUTINE_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS personal_agent_routines (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES personal_agents(id) ON DELETE CASCADE,
    conversation_id TEXT NOT NULL REFERENCES personal_agent_conversations(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    prompt TEXT NOT NULL,
    frequency_type TEXT NOT NULL,
    frequency_time_of_day TEXT,
    frequency_weekly_day INTEGER,
    missed_run_policy TEXT NOT NULL DEFAULT 'within_window',
    missed_run_window_minutes INTEGER,
    enabled INTEGER NOT NULL DEFAULT 1,
    running INTEGER NOT NULL DEFAULT 0,
    next_run_at TEXT,
    authorization_text TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(conversation_id)
  );
  CREATE INDEX IF NOT EXISTS idx_personal_agent_routines_agent ON personal_agent_routines(agent_id, updated_at);
  CREATE INDEX IF NOT EXISTS idx_personal_agent_routines_next_run ON personal_agent_routines(enabled, next_run_at);
  CREATE TABLE IF NOT EXISTS personal_agent_routine_runs (
    id TEXT PRIMARY KEY,
    routine_id TEXT NOT NULL REFERENCES personal_agent_routines(id) ON DELETE CASCADE,
    agent_id TEXT NOT NULL REFERENCES personal_agents(id) ON DELETE CASCADE,
    conversation_id TEXT NOT NULL REFERENCES personal_agent_conversations(id) ON DELETE CASCADE,
    trigger TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',
    started_at TEXT NOT NULL,
    finished_at TEXT,
    error TEXT,
    message_id TEXT REFERENCES personal_agent_messages(id) ON DELETE SET NULL
  );
  CREATE INDEX IF NOT EXISTS idx_personal_agent_routine_runs_routine ON personal_agent_routine_runs(routine_id, started_at);
  CREATE TABLE IF NOT EXISTS personal_agent_wakeups (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES personal_agents(id) ON DELETE CASCADE,
    conversation_id TEXT NOT NULL REFERENCES personal_agent_conversations(id) ON DELETE CASCADE,
    prompt TEXT NOT NULL,
    due_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'scheduled',
    created_by_run_id TEXT REFERENCES personal_agent_runs(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_personal_agent_wakeups_status_due ON personal_agent_wakeups(status, due_at);
`;

const normalizeRoutineFrequency = (value: unknown): AutomationFrequency => {
  const input = value && typeof value === 'object' ? value as Partial<AutomationFrequency> : {};
  if (input.type === 'daily') {
    return { type: 'daily', timeOfDay: formatTimeOfDay(input.timeOfDay) };
  }
  if (input.type === 'weekly') {
    return {
      type: 'weekly',
      timeOfDay: formatTimeOfDay(input.timeOfDay),
      weeklyDay: normalizeWeeklyDay(input.weeklyDay),
    };
  }
  return { type: 'hourly' };
};

const normalizeMissedRunPolicy = (value: unknown): AutomationMissedRunPolicy =>
  value === 'skip' || value === 'always' || value === 'within_window' ? value : 'within_window';

const normalizeMissedRunWindowMinutes = (value: unknown, frequency: AutomationFrequency): number => {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return defaultMissedRunWindowMinutes(frequency);
  }
  return Math.min(30 * 24 * 60, Math.max(1, Math.round(numeric)));
};

const defaultMissedRunWindowMinutes = (frequency: AutomationFrequency): number => {
  if (frequency.type === 'hourly') return 30;
  if (frequency.type === 'daily') return 6 * 60;
  return 24 * 60;
};

const formatTimeOfDay = (value: unknown): string => {
  const match = /^(\d{1,2}):(\d{2})$/.exec(typeof value === 'string' ? value : '');
  if (!match) {
    return '09:00';
  }
  const hour = Math.min(23, Math.max(0, Number(match[1])));
  const minute = Math.min(59, Math.max(0, Number(match[2])));
  return `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`;
};

const normalizeWeeklyDay = (value: unknown): number => {
  const day = typeof value === 'number' && Number.isInteger(value) ? value : 1;
  return Math.min(6, Math.max(0, day));
};

const frequencyFromRow = (row: Pick<RoutineRow, 'frequency_type' | 'frequency_time_of_day' | 'frequency_weekly_day'>): AutomationFrequency => {
  if (row.frequency_type === 'daily') {
    return { type: 'daily', timeOfDay: formatTimeOfDay(row.frequency_time_of_day ?? undefined) };
  }
  if (row.frequency_type === 'weekly') {
    return {
      type: 'weekly',
      timeOfDay: formatTimeOfDay(row.frequency_time_of_day ?? undefined),
      weeklyDay: normalizeWeeklyDay(row.frequency_weekly_day ?? undefined),
    };
  }
  return { type: 'hourly' };
};

const routineRunFromRow = (row: RoutineRunRow): PersonalAgentRoutineRun => ({
  id: row.id,
  routineId: row.routine_id,
  agentId: row.agent_id,
  conversationId: row.conversation_id,
  trigger: row.trigger === 'manual' ? 'manual' : 'scheduled',
  status: normalizeRoutineRunStatus(row.status),
  startedAt: row.started_at,
  ...(row.finished_at ? { finishedAt: row.finished_at } : {}),
  ...(row.error ? { error: row.error } : {}),
  ...(row.message_id ? { messageId: row.message_id } : {}),
});

const wakeupFromRow = (row: WakeupRow): PersonalAgentScheduledWakeup => ({
  id: row.id,
  agentId: row.agent_id,
  conversationId: row.conversation_id,
  prompt: row.prompt,
  dueAt: row.due_at,
  status: normalizeWakeupStatus(row.status),
  createdByRunId: row.created_by_run_id,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});
