import type { SqliteDatabase } from '../sqlite';
import type { WhatsAppAgentActivity, WhatsAppAgentBinding, WhatsAppAgentBindingKey } from './types';

const keyArgs = (key: WhatsAppAgentBindingKey): [string, string, string] => [key.connectionId, key.chatId, key.agentId];

/** Durable inbox, run correlation and delivery state. No transport or runner side effects. */
export class WhatsAppAgentRequestStore {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly readBinding: (key: WhatsAppAgentBindingKey) => WhatsAppAgentBinding | null,
  ) {
    this.migrateRequests();
  }

  private migrateRequests(): void {
    const columns = this.db.prepare('PRAGMA table_info(whatsapp_agent_bindings)').all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === 'configuration_version')) {
      this.db.exec('ALTER TABLE whatsapp_agent_bindings ADD COLUMN configuration_version INTEGER NOT NULL DEFAULT 1');
    }
    this.db.exec(`CREATE TABLE IF NOT EXISTS whatsapp_agent_requests (
      request_id TEXT PRIMARY KEY, run_id TEXT NOT NULL UNIQUE,
      connection_id TEXT NOT NULL, chat_id TEXT NOT NULL, agent_id TEXT NOT NULL,
      conversation_id TEXT, stable_message_ref TEXT NOT NULL,
      request_text TEXT NOT NULL, response_text TEXT, author_id TEXT, is_from_me INTEGER NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued', delivery_state TEXT, reason TEXT,
      revision INTEGER NOT NULL, retry_at INTEGER NOT NULL DEFAULT 0,
      UNIQUE(connection_id, chat_id, stable_message_ref)
    ); CREATE INDEX IF NOT EXISTS idx_whatsapp_request_queue
      ON whatsapp_agent_requests(connection_id, chat_id, agent_id, status);
    CREATE TABLE IF NOT EXISTS whatsapp_agent_outbox_accounts (
      connection_id TEXT PRIMARY KEY, next_send_at INTEGER NOT NULL
    );`);
    // Legacy rows have no request body: preserve them for audit; never replay them.
    this.db.exec(`INSERT OR IGNORE INTO whatsapp_agent_requests
      (request_id, run_id, connection_id, chat_id, agent_id, conversation_id, stable_message_ref,
       request_text, response_text, author_id, is_from_me, created_at, updated_at, status, delivery_state, reason, revision)
      SELECT t.turn_id, t.run_id, t.connection_id, t.chat_id, t.agent_id, b.conversation_id, t.turn_id,
        '', NULL, NULL, 0, datetime('now'), datetime('now'),
        CASE t.status WHEN 'active' THEN 'active' WHEN 'sent' THEN 'completed' ELSE 'interrupted' END,
        d.state, 'legacy_request', t.revision
      FROM whatsapp_agent_turns t LEFT JOIN whatsapp_agent_bindings b
        ON b.connection_id=t.connection_id AND b.chat_id=t.chat_id AND b.agent_id=t.agent_id
      LEFT JOIN whatsapp_agent_deliveries d ON d.turn_id=t.turn_id;`);
  }

  queueRequest(
    input: Omit<WhatsAppAgentActivity, 'status' | 'deliveryState' | 'responseText' | 'reason' | 'retryAt'>,
    status: 'queued' | 'interrupted' = 'queued',
    reason: string | null = null,
  ): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db
        .prepare(
          `INSERT INTO whatsapp_agent_requests
        (request_id,run_id,connection_id,chat_id,agent_id,conversation_id,stable_message_ref,request_text,
         author_id,is_from_me,created_at,updated_at,revision,status,reason) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          input.requestId,
          input.runId,
          ...keyArgs(input),
          input.conversationId,
          input.stableMessageRef,
          input.requestText,
          input.authorId,
          input.isFromMe ? 1 : 0,
          input.createdAt,
          input.updatedAt,
          input.revision,
          status,
          reason,
        );
      this.db
        .prepare(
          `UPDATE whatsapp_agent_seen_messages SET state='handled' WHERE connection_id=? AND chat_id=? AND stable_message_ref=?`,
        )
        .run(input.connectionId, input.chatId, input.stableMessageRef);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  listActivity(key?: WhatsAppAgentBindingKey): WhatsAppAgentActivity[] {
    const sql = `SELECT * FROM whatsapp_agent_requests ${key ? 'WHERE connection_id=? AND chat_id=? AND agent_id=?' : ''} ORDER BY rowid`;
    const rows = this.db.prepare(sql).all(...(key ? keyArgs(key) : [])) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      connectionId: r.connection_id as string,
      chatId: r.chat_id as string,
      agentId: r.agent_id as string,
      requestId: r.request_id as string,
      runId: r.run_id as string,
      requestText: r.request_text as string,
      responseText: r.response_text as string | null,
      authorId: r.author_id as string | null,
      isFromMe: Boolean(r.is_from_me),
      createdAt: r.created_at as string,
      updatedAt: r.updated_at as string,
      status: r.status as WhatsAppAgentActivity['status'],
      deliveryState: r.delivery_state as WhatsAppAgentActivity['deliveryState'],
      reason: r.reason as string | null,
      conversationId: r.conversation_id as string | null,
      stableMessageRef: r.stable_message_ref as string,
      revision: r.revision as number,
      retryAt: r.retry_at as number,
    }));
  }

  updateRequest(
    requestId: string,
    update: Partial<
      Pick<
        WhatsAppAgentActivity,
        'status' | 'deliveryState' | 'reason' | 'responseText' | 'revision' | 'retryAt' | 'requestText'
      >
    >,
  ): void {
    const columns = {
      status: 'status',
      deliveryState: 'delivery_state',
      reason: 'reason',
      responseText: 'response_text',
      revision: 'revision',
      retryAt: 'retry_at',
      requestText: 'request_text',
    };
    const entries = Object.entries(update) as Array<[keyof typeof columns, unknown]>;
    this.db
      .prepare(
        `UPDATE whatsapp_agent_requests SET ${entries.map(([k]) => `${columns[k]}=?`).join(',')}, updated_at=? WHERE request_id=?`,
      )
      .run(...entries.map(([, v]) => v), new Date().toISOString(), requestId);
  }

  activateRequest(request: WhatsAppAgentActivity, binding: WhatsAppAgentBinding): WhatsAppAgentBinding | null {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const changed = this.db
        .prepare(
          `UPDATE whatsapp_agent_bindings SET active_turn_id=?,revision=revision+1
        WHERE connection_id=? AND chat_id=? AND agent_id=? AND active_turn_id IS NULL AND enabled=1 AND revision=?`,
        )
        .run(request.requestId, ...keyArgs(binding), binding.revision) as { changes: number };
      if (!changed.changes) {
        this.db.exec('ROLLBACK');
        return null;
      }
      this.updateRequest(request.requestId, { status: 'active', revision: binding.revision + 1 });
      this.db
        .prepare(
          `INSERT INTO whatsapp_agent_turns(turn_id,connection_id,chat_id,agent_id,revision,run_id)
        VALUES(?,?,?,?,?,?)`,
        )
        .run(request.requestId, ...keyArgs(binding), binding.revision + 1, request.runId);
      this.db.exec('COMMIT');
      return this.readBinding(binding);
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  settleRequest(
    key: WhatsAppAgentBindingKey,
    requestId: string,
    revision: number,
    update: Parameters<WhatsAppAgentRequestStore['updateRequest']>[1],
  ): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.updateRequest(requestId, update);
      this.db
        .prepare(
          `UPDATE whatsapp_agent_bindings SET active_turn_id=NULL
        WHERE connection_id=? AND chat_id=? AND agent_id=? AND active_turn_id=? AND revision=?`,
        )
        .run(...keyArgs(key), requestId, revision);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  nextSendAt(connectionId: string): number {
    const row = this.db
      .prepare('SELECT next_send_at FROM whatsapp_agent_outbox_accounts WHERE connection_id=?')
      .get(connectionId) as { next_send_at: number } | undefined;
    return row?.next_send_at ?? 0;
  }

  reserveSend(connectionId: string, next: number): void {
    this.db
      .prepare(
        `INSERT INTO whatsapp_agent_outbox_accounts VALUES(?,?) ON CONFLICT(connection_id) DO UPDATE SET next_send_at=excluded.next_send_at`,
      )
      .run(connectionId, next);
  }
}
