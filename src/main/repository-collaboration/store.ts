import { COLLABORATION_SCHEMA } from './schema';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import {
  openPersonalAgentSqliteDatabase,
  type SqliteDatabase,
} from '../personal-agents/sqlite';
import type {
  ConfigureRepositoryCollaborationGroupInput,
  RepositoryCollaborationGroup,
  RepositoryCollaborationOutbox,
  RepositoryCollaborationSnapshot,
  RepositoryCollaborationTask,
  SetRepositoryCollaborationAccessInput,
} from '../../shared/types/repository-collaboration';
import type { LocalRepository } from './types';
type Row = Record<string, string | number | null>;
const id = () => randomUUID().replaceAll('-', '').slice(0, 16);
export interface StoredOutbox extends RepositoryCollaborationOutbox {
  participantId: string;
  replyToMessageId: string | null;
}
export class RepositoryCollaborationStore {
  private readonly db: SqliteDatabase;
  private transactionDepth = 0;
  constructor(filename: string) {
    mkdirSync(path.dirname(filename), { recursive: true });
    const db = openPersonalAgentSqliteDatabase(filename);
    if (!db)
      throw new Error('No se pudo abrir el almacenamiento de colaboración.');
    this.db = db;
    this.db.exec(COLLABORATION_SCHEMA);
  }
  private all(sql: string, ...args: unknown[]): Row[] {
    return this.db.prepare(sql).all(...args) as Row[];
  }
  private one(sql: string, ...args: unknown[]): Row | undefined {
    return this.db.prepare(sql).get(...args) as Row | undefined;
  }
  private run(sql: string, ...args: unknown[]) {
    this.db.prepare(sql).run(...args);
  }
  private transaction<T>(fn: () => T): T {
    if (this.transactionDepth > 0) return fn();
    this.db.exec('BEGIN IMMEDIATE');
    this.transactionDepth += 1;
    let result: T;
    try {
      result = fn();
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    } finally {
      this.transactionDepth -= 1;
    }
    return result;
  }
  close(): void {
    (
      this.db as SqliteDatabase & {
        close?: () => void;
      }
    ).close?.();
  }
  private groupRow(row: Row): RepositoryCollaborationGroup {
    return {
      id: String(row.id),
      connectionId: String(row.connection_id),
      chatId: String(row.chat_id),
      title: String(row.title),
      enabled: !!row.enabled,
      activatedAt: row.activated_at === null ? null : Number(row.activated_at),
    };
  }
  group(groupId: string): RepositoryCollaborationGroup | undefined {
    const row = this.one(
      'SELECT * FROM collaboration_groups WHERE id=?',
      groupId,
    );
    return row && this.groupRow(row);
  }
  findGroup(
    connectionId: string,
    chatId: string,
  ): RepositoryCollaborationGroup | undefined {
    const row = this.one(
      'SELECT * FROM collaboration_groups WHERE connection_id=? AND chat_id=?',
      connectionId,
      chatId,
    );
    return row && this.groupRow(row);
  }
  configureGroup(
    input: ConfigureRepositoryCollaborationGroupInput,
    now: number,
  ): RepositoryCollaborationGroup {
    const prior = this.findGroup(input.connectionId, input.chatId);
    const groupId = prior?.id ?? id();
    const activatedAt = input.enabled
      ? prior?.enabled
        ? prior.activatedAt
        : now
      : (prior?.activatedAt ?? null);
    this.run(
      'INSERT INTO collaboration_groups(id,connection_id,chat_id,title,enabled,activated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(connection_id,chat_id) DO UPDATE SET title=excluded.title,enabled=excluded.enabled,activated_at=excluded.activated_at',
      groupId,
      input.connectionId,
      input.chatId,
      input.title,
      input.enabled ? 1 : 0,
      activatedAt,
    );
    return this.group(groupId)!;
  }
  repositories(groupId?: string): LocalRepository[] {
    return this.all(
      `SELECT * FROM collaboration_repositories WHERE removed=0${groupId ? ' AND group_id=?' : ''}`,
      ...(groupId ? [groupId] : []),
    ).map((row) => ({
      id: String(row.id),
      groupId: String(row.group_id),
      name: String(row.name),
      root: String(row.root),
    }));
  }
  addRepository(groupId: string, name: string, root: string): LocalRepository {
    const repository = { id: id(), groupId, name, root };
    this.run(
      'INSERT INTO collaboration_repositories(id,group_id,name,root) VALUES(?,?,?,?)',
      repository.id,
      groupId,
      name,
      root,
    );
    return repository;
  }
  removeRepository(groupId: string, repositoryId: string): void {
    this.transaction(() => {
      this.run(
        'DELETE FROM collaboration_grants WHERE group_id=? AND repository_id=?',
        groupId,
        repositoryId,
      );
      this.run(
        'UPDATE collaboration_repositories SET removed=1 WHERE group_id=? AND id=?',
        groupId,
        repositoryId,
      );
    });
  }
  setAccess(input: SetRepositoryCollaborationAccessInput): void {
    this.transaction(() => {
      this.run(
        'INSERT INTO collaboration_participants(group_id,participant_id,display_name) VALUES(?,?,?) ON CONFLICT(group_id,participant_id) DO UPDATE SET display_name=excluded.display_name',
        input.groupId,
        input.participantId,
        input.displayName,
      );
      this.run(
        'DELETE FROM collaboration_grants WHERE group_id=? AND participant_id=?',
        input.groupId,
        input.participantId,
      );
      for (const repositoryId of new Set(input.repositoryIds))
        this.run(
          'INSERT INTO collaboration_grants(group_id,participant_id,repository_id) VALUES(?,?,?)',
          input.groupId,
          input.participantId,
          repositoryId,
        );
    });
  }
  allowedRepositoryIds(groupId: string, participantId: string): string[] {
    return this.all(
      'SELECT g.repository_id FROM collaboration_grants g JOIN collaboration_repositories r ON r.id=g.repository_id WHERE g.group_id=? AND g.participant_id=? AND r.removed=0',
      groupId,
      participantId,
    ).map((row) => String(row.repository_id));
  }
  claimMessage(input: {
    connectionId: string;
    chatId: string;
    messageId: string;
    senderId: string;
  }): boolean {
    return this.transaction(() => {
      if (
        this.one(
          'SELECT 1 FROM collaboration_receipts WHERE connection_id=? AND chat_id=? AND message_id=? AND sender_id=?',
          input.connectionId,
          input.chatId,
          input.messageId,
          input.senderId,
        )
      )
        return false;
      this.run(
        'INSERT INTO collaboration_receipts VALUES(?,?,?,?)',
        input.connectionId,
        input.chatId,
        input.messageId,
        input.senderId,
      );
      return true;
    });
  }
  createTask(
    input: {
      groupId: string;
      participantId: string;
      participantName: string;
      repositoryIds: string[];
      prompt: string;
      sourceMessageId: string;
      parentTaskId?: string;
      conversationId?: string;
    },
    now: number,
  ): RepositoryCollaborationTask {
    return this.transaction(() => {
      const taskId = id();
      this.run(
        'INSERT INTO collaboration_tasks(id,group_id,participant_id,participant_name,prompt,status,created_at,updated_at,source_message_id,parent_task_id,conversation_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
        taskId,
        input.groupId,
        input.participantId,
        input.participantName,
        input.prompt,
        'queued',
        now,
        now,
        input.sourceMessageId,
        input.parentTaskId ?? null,
        input.conversationId ?? null,
      );
      for (const repositoryId of new Set(input.repositoryIds))
        this.run(
          'INSERT INTO collaboration_task_repositories VALUES(?,?,?)',
          taskId,
          repositoryId,
          input.groupId,
        );
      return this.task(taskId)!;
    });
  }
  createTaskForMessage(
    message: {
      connectionId: string;
      chatId: string;
      messageId: string;
      senderId: string;
    },
    input: Parameters<RepositoryCollaborationStore['createTask']>[0],
    now: number,
    acknowledgement?: (task: RepositoryCollaborationTask) => string,
  ): RepositoryCollaborationTask | null {
    return this.transaction(() => {
      if (!this.claimMessage(message)) return null;
      const task = this.createTask(input, now);
      if (acknowledgement)
        this.enqueueOutput({
          groupId: task.groupId,
          taskId: task.id,
          participantId: task.participantId,
          text: acknowledgement(task),
          replyToMessageId: message.messageId,
        });
      return task;
    });
  }
  completeTaskWithOutput(
    taskId: string,
    update: Parameters<RepositoryCollaborationStore['updateTask']>[1],
    output: Parameters<RepositoryCollaborationStore['enqueueOutput']>[0],
    now: number,
  ): void {
    this.transaction(() => {
      this.updateTask(taskId, update, now);
      this.enqueueOutput(output);
    });
  }
  private taskRow(row: Row): RepositoryCollaborationTask {
    return {
      id: String(row.id),
      groupId: String(row.group_id),
      participantId: String(row.participant_id),
      participantName: String(row.participant_name),
      prompt: String(row.prompt),
      status: row.status as RepositoryCollaborationTask['status'],
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      sourceMessageId: String(row.source_message_id),
      parentTaskId: row.parent_task_id as string | null,
      conversationId: row.conversation_id as string | null,
      result: row.result as string | null,
      errorCode:
        (row.error_code as RepositoryCollaborationTask['errorCode']) ??
        undefined,
      repositoryIds: this.all(
        'SELECT repository_id FROM collaboration_task_repositories WHERE task_id=?',
        row.id,
      ).map((r) => String(r.repository_id)),
    };
  }
  task(taskId: string): RepositoryCollaborationTask | undefined {
    const row = this.one(
      'SELECT * FROM collaboration_tasks WHERE id=?',
      taskId,
    );
    return row && this.taskRow(row);
  }
  tasks(): RepositoryCollaborationTask[] {
    return this.all(
      'SELECT * FROM collaboration_tasks ORDER BY created_at,rowid',
    ).map((row) => this.taskRow(row));
  }
  updateTask(
    taskId: string,
    update: Partial<
      Pick<
        RepositoryCollaborationTask,
        'status' | 'result' | 'conversationId' | 'errorCode'
      >
    >,
    now: number,
  ): void {
    const columns: string[] = ['updated_at=?'];
    const values: unknown[] = [now];
    for (const [key, column] of [
      ['status', 'status'],
      ['result', 'result'],
      ['conversationId', 'conversation_id'],
      ['errorCode', 'error_code'],
    ] as const) {
      if (update[key] !== undefined) {
        columns.push(`${column}=?`);
        values.push(update[key]);
      }
    }
    this.run(
      `UPDATE collaboration_tasks SET ${columns.join(',')} WHERE id=?`,
      ...values,
      taskId,
    );
  }
  recoverInterrupted(now: number): void {
    this.run(
      "UPDATE collaboration_tasks SET status='needs_attention',error_code='interrupted',updated_at=?,result=? WHERE status IN ('running','cancelling')",
      now,
      'La ejecución se interrumpió. Revisa los cambios antes de volver a intentarlo.',
    );
    this.run(
      "UPDATE collaboration_outbox SET status='suppressed' WHERE status='pending' AND task_id IN (SELECT id FROM collaboration_tasks WHERE status='needs_attention')",
    );
  }
  enqueueOutput(input: {
    groupId: string;
    taskId?: string;
    participantId: string;
    text: string;
    replyToMessageId?: string;
  }): void {
    this.run(
      'INSERT INTO collaboration_outbox(id,group_id,task_id,participant_id,text,reply_to_message_id) VALUES(?,?,?,?,?,?)',
      id(),
      input.groupId,
      input.taskId ?? null,
      input.participantId,
      input.text,
      input.replyToMessageId ?? null,
    );
  }
  outbox(): StoredOutbox[] {
    return this.all('SELECT * FROM collaboration_outbox ORDER BY rowid').map(
      (row) => ({
        id: String(row.id),
        groupId: String(row.group_id),
        taskId: row.task_id as string | null,
        participantId: String(row.participant_id),
        text: String(row.text),
        status: row.status as StoredOutbox['status'],
        attempts: Number(row.attempts),
        messageId: row.message_id as string | null,
        replyToMessageId: row.reply_to_message_id as string | null,
      }),
    );
  }
  updateOutput(
    outputId: string,
    status: StoredOutbox['status'],
    messageId?: string,
  ): void {
    this.run(
      "UPDATE collaboration_outbox SET status=?,attempts=attempts+1,message_id=COALESCE(?,message_id) WHERE id=? AND status='pending'",
      status,
      messageId ?? null,
      outputId,
    );
  }
  taskFromReply(
    groupId: string,
    messageId: string,
  ): RepositoryCollaborationTask | undefined {
    const row = this.one(
      'SELECT task_id FROM collaboration_outbox WHERE group_id=? AND message_id=? AND task_id IS NOT NULL',
      groupId,
      messageId,
    );
    return row ? this.task(String(row.task_id)) : undefined;
  }
  snapshot(connectionId: string): RepositoryCollaborationSnapshot {
    const groups = this.all(
      'SELECT * FROM collaboration_groups WHERE connection_id=?',
      connectionId,
    ).map((row) => this.groupRow(row));
    const ids = new Set(groups.map((g) => g.id));
    return {
      groups,
      repositories: this.repositories()
        .filter((r) => ids.has(r.groupId))
        .map(({ id, groupId, name }) => ({ id, groupId, name })),
      participants: this.all('SELECT * FROM collaboration_participants')
        .filter((r) => ids.has(String(r.group_id)))
        .map((r) => ({
          groupId: String(r.group_id),
          participantId: String(r.participant_id),
          displayName: String(r.display_name),
        })),
      grants: this.all('SELECT * FROM collaboration_grants')
        .filter((r) => ids.has(String(r.group_id)))
        .map((r) => ({
          groupId: String(r.group_id),
          participantId: String(r.participant_id),
          repositoryId: String(r.repository_id),
        })),
      tasks: this.tasks().filter((t) => ids.has(t.groupId)),
      outbox: this.outbox()
        .filter((o) => ids.has(o.groupId))
        .map(({ id, groupId, taskId, status, attempts, text, messageId }) => ({
          id,
          groupId,
          taskId,
          status,
          attempts,
          text,
          messageId,
        })),
    };
  }
}
