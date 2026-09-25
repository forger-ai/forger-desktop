import type { SqliteDatabase } from '../sqlite';
import { normalizeAgentAliasKey } from './parser';
import type { WhatsAppAgentBinding, WhatsAppAgentBindingInput, WhatsAppAgentBindingKey, WhatsAppAgentTurn, WhatsAppAgentUnsettledMessage } from './types';

interface BindingRow {
  connection_id: string;
  chat_id: string;
  agent_id: string;
  alias: string;
  owner_id: string;
  enabled: number;
  allow_agent_capabilities: number;
  purpose: string;
  scope: string;
  conversation_id: string | null;
  revision: number;
  active_turn_id: string | null;
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS whatsapp_agent_aliases (
    connection_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    alias TEXT NOT NULL,
    alias_key TEXT NOT NULL,
    PRIMARY KEY (connection_id, agent_id),
    UNIQUE (connection_id, alias_key)
  );
  CREATE TABLE IF NOT EXISTS whatsapp_agent_bindings (
    connection_id TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 0,
    allow_agent_capabilities INTEGER NOT NULL DEFAULT 0,
    purpose TEXT NOT NULL DEFAULT '',
    scope TEXT NOT NULL DEFAULT '',
    conversation_id TEXT,
    revision INTEGER NOT NULL DEFAULT 1,
    active_turn_id TEXT,
    PRIMARY KEY (connection_id, chat_id, agent_id),
    FOREIGN KEY (connection_id, agent_id) REFERENCES whatsapp_agent_aliases(connection_id, agent_id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_whatsapp_agent_bindings_chat ON whatsapp_agent_bindings(connection_id, chat_id);
  CREATE TABLE IF NOT EXISTS whatsapp_agent_binding_participants (
    connection_id TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    participant_id TEXT NOT NULL,
    PRIMARY KEY (connection_id, chat_id, agent_id, participant_id),
    FOREIGN KEY (connection_id, chat_id, agent_id) REFERENCES whatsapp_agent_bindings(connection_id, chat_id, agent_id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS whatsapp_agent_seen_messages (
    connection_id TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    stable_message_ref TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending',
    agent_id TEXT,
    turn_id TEXT,
    revision INTEGER,
    PRIMARY KEY (connection_id, chat_id, stable_message_ref)
  );
  CREATE TABLE IF NOT EXISTS whatsapp_agent_turns (
    turn_id TEXT PRIMARY KEY,
    connection_id TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    run_id TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'active'
  );
  CREATE TABLE IF NOT EXISTS whatsapp_agent_deliveries (
    connection_id TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    state TEXT NOT NULL,
    stable_message_ref TEXT,
    PRIMARY KEY (connection_id, chat_id, agent_id, turn_id)
  );
`;

const nonempty = (value: string, field: string): string => {
  const text = value.trim();
  if (!text) throw new Error(`whatsapp_agent_${field}_required`);
  return text;
};

const keyArgs = (key: WhatsAppAgentBindingKey): [string, string, string] => [key.connectionId, key.chatId, key.agentId];

export class WhatsAppAgentChannelStore {
  constructor(private readonly db: SqliteDatabase) {
    this.db.exec(SCHEMA);
    const columns = this.db.prepare('PRAGMA table_info(whatsapp_agent_bindings)').all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === 'allow_agent_capabilities')) {
      this.db.exec('ALTER TABLE whatsapp_agent_bindings ADD COLUMN allow_agent_capabilities INTEGER NOT NULL DEFAULT 0');
    }
  }

  putBinding(input: WhatsAppAgentBindingInput): WhatsAppAgentBinding {
    const connectionId = nonempty(input.connectionId, 'connection_id');
    const chatId = nonempty(input.chatId, 'chat_id');
    const agentId = nonempty(input.agentId, 'agent_id');
    const alias = nonempty(input.alias, 'alias');
    const aliasKey = normalizeAgentAliasKey(alias);
    if (alias.length > 80 || /[\r\n]/u.test(alias)) throw new Error('whatsapp_agent_alias_invalid');
    const ownerId = nonempty(input.ownerId, 'owner_id');
    if (input.enabled && !input.purpose.trim()) throw new Error('whatsapp_agent_purpose_required');
    const currentBinding = this.getBinding(connectionId, chatId, agentId);
    if (input.expectedRevision !== undefined && currentBinding?.revision !== input.expectedRevision) {
      throw new Error('whatsapp_agent_binding_revision_conflict');
    }
    const participants = [...new Set(input.participantsAllowed.map((id) => id.trim()).filter(Boolean))];
    const existingAlias = this.db.prepare(`
      SELECT agent_id FROM whatsapp_agent_aliases WHERE connection_id = ? AND alias_key = ?
    `).get(connectionId, aliasKey) as { agent_id: string } | undefined;
    if (existingAlias && existingAlias.agent_id !== agentId) throw new Error('whatsapp_agent_alias_conflict');
    const priorAlias = this.db.prepare(`
      SELECT alias FROM whatsapp_agent_aliases WHERE connection_id = ? AND agent_id = ?
    `).get(connectionId, agentId) as { alias: string } | undefined;

    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare(`
        INSERT INTO whatsapp_agent_aliases (connection_id, agent_id, alias, alias_key)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(connection_id, agent_id) DO UPDATE SET alias = excluded.alias, alias_key = excluded.alias_key
      `).run(connectionId, agentId, alias, aliasKey);
      this.db.prepare(`
        INSERT INTO whatsapp_agent_bindings (
          connection_id, chat_id, agent_id, owner_id, enabled, allow_agent_capabilities, purpose, scope, conversation_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(connection_id, chat_id, agent_id) DO UPDATE SET
          owner_id = excluded.owner_id,
          enabled = excluded.enabled,
          allow_agent_capabilities = excluded.allow_agent_capabilities,
          purpose = excluded.purpose,
          scope = excluded.scope,
          conversation_id = excluded.conversation_id,
          revision = whatsapp_agent_bindings.revision + 1,
          active_turn_id = NULL
      `).run(connectionId, chatId, agentId, ownerId, input.enabled ? 1 : 0,
        (input.allowAgentCapabilities ?? currentBinding?.allowAgentCapabilities ?? false) ? 1 : 0,
        input.purpose.trim(), input.scope.trim(), input.conversationId?.trim() || null);
      if (priorAlias && priorAlias.alias !== alias) {
        // The alias is connection-wide. Changing it also invalidates runs in
        // other chats that would otherwise keep an unchanged revision.
        this.db.prepare(`
          UPDATE whatsapp_agent_bindings
          SET revision = revision + 1, active_turn_id = NULL
          WHERE connection_id = ? AND agent_id = ? AND chat_id <> ?
        `).run(connectionId, agentId, chatId);
      }
      this.db.prepare(`
        DELETE FROM whatsapp_agent_binding_participants
        WHERE connection_id = ? AND chat_id = ? AND agent_id = ?
      `).run(connectionId, chatId, agentId);
      const insert = this.db.prepare(`
        INSERT INTO whatsapp_agent_binding_participants (connection_id, chat_id, agent_id, participant_id)
        VALUES (?, ?, ?, ?)
      `);
      for (const participant of participants) insert.run(connectionId, chatId, agentId, participant);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    const binding = this.getBinding(connectionId, chatId, agentId);
    if (!binding) throw new Error('whatsapp_agent_binding_not_saved');
    return binding;
  }

  getBinding(connectionId: string, chatId: string, agentId: string): WhatsAppAgentBinding | null {
    const row = this.db.prepare(`
      SELECT b.*, a.alias FROM whatsapp_agent_bindings b
      JOIN whatsapp_agent_aliases a ON a.connection_id = b.connection_id AND a.agent_id = b.agent_id
      WHERE b.connection_id = ? AND b.chat_id = ? AND b.agent_id = ?
    `).get(connectionId, chatId, agentId) as BindingRow | undefined;
    return row ? this.fromRow(row) : null;
  }

  listBindingsForChat(connectionId: string, chatId: string): WhatsAppAgentBinding[] {
    const rows = this.db.prepare(`
      SELECT b.*, a.alias FROM whatsapp_agent_bindings b
      JOIN whatsapp_agent_aliases a ON a.connection_id = b.connection_id AND a.agent_id = b.agent_id
      WHERE b.connection_id = ? AND b.chat_id = ? ORDER BY LENGTH(a.alias) DESC, a.alias_key
    `).all(connectionId, chatId) as BindingRow[];
    return rows.map((row) => this.fromRow(row));
  }

  listBindings(connectionId?: string): WhatsAppAgentBinding[] {
    const rows = connectionId
      ? this.db.prepare(`
        SELECT b.*, a.alias FROM whatsapp_agent_bindings b
        JOIN whatsapp_agent_aliases a ON a.connection_id = b.connection_id AND a.agent_id = b.agent_id
        WHERE b.connection_id = ? ORDER BY b.chat_id, a.alias_key
      `).all(connectionId) as BindingRow[]
      : this.db.prepare(`
        SELECT b.*, a.alias FROM whatsapp_agent_bindings b
        JOIN whatsapp_agent_aliases a ON a.connection_id = b.connection_id AND a.agent_id = b.agent_id
        ORDER BY b.connection_id, b.chat_id, a.alias_key
      `).all() as BindingRow[];
    return rows.map((row) => this.fromRow(row));
  }

  deleteBinding(key: WhatsAppAgentBindingKey): boolean {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = this.db.prepare(`
        DELETE FROM whatsapp_agent_bindings WHERE connection_id = ? AND chat_id = ? AND agent_id = ?
      `).run(...keyArgs(key)) as { changes: number };
      this.db.prepare(`
        DELETE FROM whatsapp_agent_binding_participants WHERE connection_id = ? AND chat_id = ? AND agent_id = ?
      `).run(...keyArgs(key));
      this.db.prepare(`
        DELETE FROM whatsapp_agent_aliases WHERE connection_id = ? AND agent_id = ?
        AND NOT EXISTS (
          SELECT 1 FROM whatsapp_agent_bindings WHERE connection_id = ? AND agent_id = ?
        )
      `).run(key.connectionId, key.agentId, key.connectionId, key.agentId);
      this.db.exec('COMMIT');
      return result.changes > 0;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  claimMessage(connectionId: string, chatId: string, stableMessageRef: string): 'new' | 'pending' | 'admitting' | 'duplicate' {
    const ref = nonempty(stableMessageRef, 'stable_message_ref');
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO whatsapp_agent_seen_messages (connection_id, chat_id, stable_message_ref)
      VALUES (?, ?, ?)
    `).run(connectionId, chatId, ref) as { changes: number };
    if (result.changes > 0) return 'new';
    const row = this.db.prepare(`
      SELECT state FROM whatsapp_agent_seen_messages
      WHERE connection_id = ? AND chat_id = ? AND stable_message_ref = ?
    `).get(connectionId, chatId, ref) as { state: string } | undefined;
    return row?.state === 'pending' || row?.state === 'admitting' ? row.state : 'duplicate';
  }

  markMessageHandled(connectionId: string, chatId: string, stableMessageRef: string): void {
    this.db.prepare(`
      UPDATE whatsapp_agent_seen_messages SET state = 'handled'
      WHERE connection_id = ? AND chat_id = ? AND stable_message_ref = ?
    `).run(connectionId, chatId, stableMessageRef);
  }

  listUnsettledMessages(connectionId?: string): WhatsAppAgentUnsettledMessage[] {
    const sql = `SELECT connection_id, chat_id, stable_message_ref, state, agent_id, turn_id, revision
      FROM whatsapp_agent_seen_messages WHERE state IN ('pending', 'admitting')`;
    const rows = (connectionId
      ? this.db.prepare(`${sql} AND connection_id = ? ORDER BY chat_id, stable_message_ref`).all(connectionId)
      : this.db.prepare(`${sql} ORDER BY connection_id, chat_id, stable_message_ref`).all()) as Array<{
        connection_id: string; chat_id: string; stable_message_ref: string; state: 'pending' | 'admitting';
        agent_id: string | null; turn_id: string | null; revision: number | null;
      }>;
    return rows.map((row) => ({
      connectionId: row.connection_id,
      chatId: row.chat_id,
      stableMessageRef: row.stable_message_ref,
      state: row.state,
      agentId: row.agent_id,
      turnId: row.turn_id,
      revision: row.revision,
    }));
  }

  prepareTurn(key: WhatsAppAgentBindingKey, expectedRevision: number, turnId: string, stableMessageRef: string): WhatsAppAgentBinding | null {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = this.db.prepare(`
        UPDATE whatsapp_agent_bindings
        SET active_turn_id = ?, revision = revision + 1
        WHERE connection_id = ? AND chat_id = ? AND agent_id = ? AND enabled = 1 AND revision = ?
      `).run(turnId, ...keyArgs(key), expectedRevision) as { changes: number };
      if (result.changes === 0) {
        this.db.exec('ROLLBACK');
        return null;
      }
      const changed = this.db.prepare(`
        UPDATE whatsapp_agent_seen_messages
        SET state = 'admitting', agent_id = ?, turn_id = ?, revision = ?
        WHERE connection_id = ? AND chat_id = ? AND stable_message_ref = ? AND state = 'pending'
      `).run(key.agentId, turnId, expectedRevision + 1, key.connectionId, key.chatId, stableMessageRef) as { changes: number };
      if (changed.changes === 0) {
        this.db.exec('ROLLBACK');
        return null;
      }
      this.db.exec('COMMIT');
      return this.getBinding(key.connectionId, key.chatId, key.agentId);
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  transition(key: WhatsAppAgentBindingKey, expectedRevision: number, enabled: boolean, activeTurnId: string | null): WhatsAppAgentBinding | null {
    const result = this.db.prepare(`
      UPDATE whatsapp_agent_bindings
      SET enabled = ?, active_turn_id = ?, revision = revision + 1
      WHERE connection_id = ? AND chat_id = ? AND agent_id = ? AND revision = ?
    `).run(enabled ? 1 : 0, activeTurnId, ...keyArgs(key), expectedRevision) as { changes: number };
    return result.changes > 0 ? this.getBinding(key.connectionId, key.chatId, key.agentId) : null;
  }

  recordRun(key: WhatsAppAgentBindingKey, turnId: string, revision: number, runId: string): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare(`
        INSERT INTO whatsapp_agent_turns (turn_id, connection_id, chat_id, agent_id, revision, run_id)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(turnId, ...keyArgs(key), revision, nonempty(runId, 'run_id'));
      this.db.prepare(`
        UPDATE whatsapp_agent_seen_messages SET state = 'handled'
        WHERE connection_id = ? AND chat_id = ? AND agent_id = ? AND turn_id = ? AND revision = ?
      `).run(...keyArgs(key), turnId, revision);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  findTurnByRunId(runId: string): WhatsAppAgentTurn | null {
    const row = this.db.prepare(`
      SELECT turn_id, connection_id, chat_id, agent_id, revision, run_id, status
      FROM whatsapp_agent_turns WHERE run_id = ?
    `).get(runId) as {
      turn_id: string;
      connection_id: string;
      chat_id: string;
      agent_id: string;
      revision: number;
      run_id: string;
      status: WhatsAppAgentTurn['status'];
    } | undefined;
    return row ? this.toTurn(row) : null;
  }

  findTurnByTurnId(turnId: string): WhatsAppAgentTurn | null {
    const row = this.db.prepare(`
      SELECT turn_id, connection_id, chat_id, agent_id, revision, run_id, status
      FROM whatsapp_agent_turns WHERE turn_id = ?
    `).get(turnId) as {
      turn_id: string;
      connection_id: string;
      chat_id: string;
      agent_id: string;
      revision: number;
      run_id: string;
      status: WhatsAppAgentTurn['status'];
    } | undefined;
    return row ? this.toTurn(row) : null;
  }

  private toTurn(row: {
    turn_id: string; connection_id: string; chat_id: string; agent_id: string;
    revision: number; run_id: string; status: WhatsAppAgentTurn['status'];
  }): WhatsAppAgentTurn {
    return {
      turnId: row.turn_id,
      connectionId: row.connection_id,
      chatId: row.chat_id,
      agentId: row.agent_id,
      revision: row.revision,
      runId: row.run_id,
      status: row.status,
    };
  }

  markTurnStatus(turnId: string, status: WhatsAppAgentTurn['status']): void {
    this.db.prepare('UPDATE whatsapp_agent_turns SET status = ? WHERE turn_id = ?').run(status, turnId);
  }

  claimDelivery(key: WhatsAppAgentBindingKey, turnId: string, revision: number): boolean {
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO whatsapp_agent_deliveries
        (connection_id, chat_id, agent_id, turn_id, revision, state)
      VALUES (?, ?, ?, ?, ?, 'unknown')
    `).run(...keyArgs(key), turnId, revision) as { changes: number };
    return result.changes > 0;
  }

  hasDelivery(key: WhatsAppAgentBindingKey, turnId: string): boolean {
    return Boolean(this.db.prepare(`
      SELECT 1 FROM whatsapp_agent_deliveries
      WHERE connection_id = ? AND chat_id = ? AND agent_id = ? AND turn_id = ?
    `).get(...keyArgs(key), turnId));
  }

  getDelivery(key: WhatsAppAgentBindingKey, turnId: string): { state: 'sent' | 'failed' | 'unknown'; stableMessageRef: string | null } | null {
    const row = this.db.prepare(`
      SELECT state, stable_message_ref FROM whatsapp_agent_deliveries
      WHERE connection_id = ? AND chat_id = ? AND agent_id = ? AND turn_id = ?
    `).get(...keyArgs(key), turnId) as { state: 'sent' | 'failed' | 'unknown'; stable_message_ref: string | null } | undefined;
    return row ? { state: row.state, stableMessageRef: row.stable_message_ref } : null;
  }

  getLatestDelivery(key: WhatsAppAgentBindingKey): {
    turnId: string;
    revision: number;
    state: 'sent' | 'failed' | 'unknown';
    stableMessageRef: string | null;
  } | null {
    const row = this.db.prepare(`
      SELECT turn_id, revision, state, stable_message_ref
      FROM whatsapp_agent_deliveries
      WHERE connection_id = ? AND chat_id = ? AND agent_id = ?
      ORDER BY rowid DESC LIMIT 1
    `).get(...keyArgs(key)) as {
      turn_id: string; revision: number; state: 'sent' | 'failed' | 'unknown'; stable_message_ref: string | null;
    } | undefined;
    return row ? {
      turnId: row.turn_id,
      revision: row.revision,
      state: row.state,
      stableMessageRef: row.stable_message_ref,
    } : null;
  }

  finishTurn(key: WhatsAppAgentBindingKey, turnId: string, revision: number): void {
    this.db.prepare(`
      UPDATE whatsapp_agent_bindings SET active_turn_id = NULL
      WHERE connection_id = ? AND chat_id = ? AND agent_id = ?
        AND active_turn_id = ? AND revision = ?
    `).run(...keyArgs(key), turnId, revision);
  }

  markDelivery(key: WhatsAppAgentBindingKey, turnId: string, state: 'sent' | 'failed' | 'unknown', stableMessageRef?: string): void {
    this.db.prepare(`
      UPDATE whatsapp_agent_deliveries SET state = ?, stable_message_ref = ?
      WHERE connection_id = ? AND chat_id = ? AND agent_id = ? AND turn_id = ?
    `).run(state, stableMessageRef ?? null, ...keyArgs(key), turnId);
  }

  private fromRow(row: BindingRow): WhatsAppAgentBinding {
    const participants = this.db.prepare(`
      SELECT participant_id FROM whatsapp_agent_binding_participants
      WHERE connection_id = ? AND chat_id = ? AND agent_id = ? ORDER BY participant_id
    `).all(row.connection_id, row.chat_id, row.agent_id) as Array<{ participant_id: string }>;
    return {
      connectionId: row.connection_id,
      chatId: row.chat_id,
      agentId: row.agent_id,
      alias: row.alias,
      ownerId: row.owner_id,
      enabled: Boolean(row.enabled),
      allowAgentCapabilities: Boolean(row.allow_agent_capabilities),
      purpose: row.purpose,
      scope: row.scope,
      participantsAllowed: participants.map((item) => item.participant_id),
      conversationId: row.conversation_id,
      revision: row.revision,
      activeTurnId: row.active_turn_id,
    };
  }
}
