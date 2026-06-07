import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  MemoryCreateInput,
  MemoryEntry,
  MemoryEvidence,
  MemoryKind,
  MemoryListInput,
  MemoryRevision,
  MemorySource,
  MemoryStatus,
  MemoryUpdateInput,
  MemoryUsageEvent,
} from '../shared/types';
import { loadOptionalBetterSqlite } from './runtime/optional-better-sqlite';

export interface MemoryAccess {
  caller: 'desktop-chat' | 'app-agent' | 'automation' | 'free-chat' | 'settings';
  appId?: string;
  appIds?: string[];
  runId?: string;
}

export interface MemoryMaintenanceRunInput {
  id?: string;
  status: 'skipped' | 'succeeded' | 'failed';
  summary: string;
  startedAt?: string;
  finishedAt?: string;
}

interface MemoryFile {
  entries?: Array<Partial<MemoryEntry>>;
}

interface SqliteStatement {
  all: (...args: unknown[]) => unknown[];
  get: (...args: unknown[]) => unknown;
  run: (...args: unknown[]) => unknown;
}

interface SqliteDatabase {
  exec: (sql: string) => unknown;
  prepare: (sql: string) => SqliteStatement;
  pragma?: (sql: string) => unknown;
  transaction?: <T extends (...args: never[]) => unknown>(fn: T) => T;
}

interface MemoryEntryRow {
  id: string;
  scope: string;
  app_id: string | null;
  kind: string;
  title: string;
  body: string;
  read_when: string;
  status: string;
  source: string;
  created_at: string;
  updated_at: string;
}

interface MemoryEvidenceRow {
  id: string;
  memory_id: string;
  source: string;
  excerpt: string;
  created_at: string;
}

interface MemoryUsageRow {
  id: string;
  memory_id: string;
  caller: string;
  app_id: string | null;
  run_id: string | null;
  reason: string | null;
  created_at: string;
}

interface MemoryRevisionRow {
  id: string;
  memory_id: string;
  title: string;
  body: string;
  read_when: string;
  kind: string;
  scope: string;
  app_id: string | null;
  status: string;
  source: string;
  created_at: string;
}

type EmitWarning = typeof process.emitWarning;

const MAX_TITLE_LENGTH = 120;
const MAX_BODY_LENGTH = 4_000;
const MAX_READ_WHEN_LENGTH = 1_000;
const MAX_EVIDENCE_LENGTH = 1_000;
const VALID_KINDS = new Set<MemoryKind>([
  'preference',
  'profile',
  'workflow',
  'constraint',
  'fact',
]);
const VALID_STATUSES = new Set<MemoryStatus>(['active', 'candidate', 'archived']);
const NODE_SQLITE_EXPERIMENTAL_WARNING = 'SQLite is an experimental feature and might change at any time';
let warnedAboutSqliteFallback = false;

const warnAboutSqliteFallback = (error?: unknown): void => {
  if (warnedAboutSqliteFallback) {
    return;
  }
  warnedAboutSqliteFallback = true;
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : null;
  console.warn(
    [
      '[Forger memory] better-sqlite3 could not be loaded; falling back to node:sqlite.',
      'For Desktop development/runtime, rebuild native Electron modules with: npx electron-rebuild -f -w better-sqlite3.',
      message ? `Load error: ${message}` : null,
    ]
      .filter(Boolean)
      .join(' '),
  );
};

const requireNodeSqlite = (): { DatabaseSync?: new (filename: string) => SqliteDatabase } => {
  const originalEmitWarning: EmitWarning = process.emitWarning;
  const emitWarning = originalEmitWarning as unknown as (warning: string | Error, ...args: unknown[]) => void;
  process.emitWarning = ((warning: string | Error, ...args: unknown[]) => {
    const warningMessage = typeof warning === 'string' ? warning : warning.message;
    const warningType = typeof args[0] === 'string' ? args[0] : undefined;
    if (warningMessage === NODE_SQLITE_EXPERIMENTAL_WARNING && warningType === 'ExperimentalWarning') {
      return;
    }
    return emitWarning(warning, ...args);
  }) as EmitWarning;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('node:sqlite') as { DatabaseSync?: new (filename: string) => SqliteDatabase };
  } finally {
    process.emitWarning = originalEmitWarning;
  }
};

export class MemoryStore {
  private db: SqliteDatabase | null = null;
  private loadPromise: Promise<void> | null = null;

  public constructor(private readonly metadataRoot: string) {}

  public async list(input: MemoryListInput = {}, access: MemoryAccess = { caller: 'settings' }): Promise<MemoryEntry[]> {
    await this.load();
    const allowed = this.allowedEntries(access);
    return allowed
      .filter((entry) => {
        if (input.scope && entry.scope !== input.scope) return false;
        if (input.appId && entry.appId !== input.appId) return false;
        if (input.kind && entry.kind !== input.kind) return false;
        if (input.status && entry.status !== input.status) return false;
        return true;
      })
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  public async create(input: MemoryCreateInput, access: MemoryAccess = { caller: 'settings' }): Promise<MemoryEntry> {
    await this.load();
    const now = new Date().toISOString();
    const body = sanitizeBody(input.body ?? input.text);
    if (!body) {
      throw new Error('memory_text_required');
    }
    const scope = input.scope === 'app' ? 'app' : 'global';
    const appId = scope === 'app' ? sanitizeAppId(input.appId) : undefined;
    const entry: MemoryEntry = {
      id: randomUUID(),
      scope,
      ...(appId ? { appId } : {}),
      kind: normalizeKind(input.kind),
      title: sanitizeTitle(input.title) || deriveTitle(body),
      body,
      readWhen: sanitizeReadWhen(input.readWhen ?? input.read_when),
      status: normalizeStatus(input.status),
      text: body,
      source: normalizeSource(input.source),
      createdAt: now,
      updatedAt: now,
    };
    this.assertCanWrite(entry, access);
    const db = this.requireDb();
    db.prepare(`
      INSERT INTO memory_entries (id, scope, app_id, kind, title, body, read_when, status, source, created_at, updated_at)
      VALUES (@id, @scope, @appId, @kind, @title, @body, @readWhen, @status, @source, @createdAt, @updatedAt)
    `).run(toEntryParams(entry));
    if (input.evidence) {
      this.insertEvidence(entry.id, sanitizeEvidence(input.evidence), entry.source, now);
    }
    return this.requireEntry(entry.id, access);
  }

  public async update(input: MemoryUpdateInput, access: MemoryAccess = { caller: 'settings' }): Promise<MemoryEntry> {
    await this.load();
    const current = this.requireEntry(input.id, access);
    this.assertCanWrite(current, access);
    this.insertRevision(current);
    const body = input.body !== undefined || input.text !== undefined
      ? sanitizeBody(input.body ?? input.text)
      : current.body;
    if (!body) {
      throw new Error('memory_text_required');
    }
    const scope = input.scope === 'app' ? 'app' : input.scope === 'global' ? 'global' : current.scope;
    const appId = scope === 'app' ? sanitizeAppId(input.appId ?? current.appId) : undefined;
    const next: MemoryEntry = {
      ...current,
      scope,
      ...(appId ? { appId } : {}),
      kind: input.kind ? normalizeKind(input.kind) : current.kind,
      title: input.title !== undefined ? sanitizeTitle(input.title) || deriveTitle(body) : current.title,
      body,
      readWhen: input.readWhen !== undefined || input.read_when !== undefined
        ? sanitizeReadWhen(input.readWhen ?? input.read_when)
        : current.readWhen,
      status: input.status ? normalizeStatus(input.status) : current.status,
      text: body,
      updatedAt: new Date().toISOString(),
    };
    if (!appId) {
      delete next.appId;
    }
    this.assertCanWrite(next, access);
    this.requireDb().prepare(`
      UPDATE memory_entries
      SET scope = @scope,
          app_id = @appId,
          kind = @kind,
          title = @title,
          body = @body,
          read_when = @readWhen,
          status = @status,
          source = @source,
          updated_at = @updatedAt
      WHERE id = @id
    `).run({
      id: next.id,
      scope: next.scope,
      appId: next.appId ?? null,
      kind: next.kind,
      title: next.title,
      body: next.body,
      readWhen: next.readWhen,
      status: next.status,
      source: next.source,
      updatedAt: next.updatedAt,
    });
    if (input.evidence) {
      this.insertEvidence(next.id, sanitizeEvidence(input.evidence), next.source, next.updatedAt);
    }
    return this.requireEntry(next.id, access);
  }

  public async delete(id: string, access: MemoryAccess = { caller: 'settings' }): Promise<{ success: boolean }> {
    await this.load();
    const entry = this.entryById(id);
    if (!entry) {
      return { success: false };
    }
    this.assertCanWrite(entry, access);
    this.requireDb().prepare('DELETE FROM memory_entries WHERE id = ?').run(id);
    return { success: true };
  }

  public async recordMaintenanceRun(input: MemoryMaintenanceRunInput): Promise<void> {
    await this.load();
    const now = new Date().toISOString();
    this.requireDb().prepare(`
      INSERT INTO memory_maintenance_runs (id, status, summary, started_at, finished_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      input.id ?? randomUUID(),
      input.status,
      sanitizeBody(input.summary),
      input.startedAt ?? now,
      input.finishedAt ?? now,
    );
  }

  public async buildContext(access: MemoryAccess, maxChars = 6_000): Promise<string> {
    const entries = (await this.list({ status: 'active' }, access));
    if (entries.length === 0) {
      return '';
    }
    const lines = [
      'Memoria de Forger:',
      'Todas las memorias activas se registran con titulo y read_when. Usa `memory_list` para leer el cuerpo de las memorias condicionales cuando read_when aplique.',
      '',
      'Registro de memorias:',
    ];
    const always = entries.filter((entry) => !entry.readWhen.trim());
    const conditional = entries.filter((entry) => entry.readWhen.trim());
    for (const entry of [...always, ...conditional]) {
      const label = entry.scope === 'global' ? 'global' : entry.appId ?? 'app';
      const readWhen = entry.readWhen.trim() || 'siempre';
      lines.push(`- ${entry.title} [${label}/${entry.kind}] read_when: ${readWhen}`);
      if (!entry.readWhen.trim()) {
        lines.push(`  ${entry.body}`);
      }
      this.recordUsage(entry, access, entry.readWhen.trim() ? 'registered' : 'injected');
      if (lines.join('\n').length >= maxChars) {
        break;
      }
    }
    return lines.join('\n').slice(0, maxChars).trim();
  }

  private allowedEntries(access: MemoryAccess): MemoryEntry[] {
    const entries = this.allEntries();
    if (access.caller === 'settings' || access.caller === 'desktop-chat' || access.caller === 'free-chat') {
      return entries;
    }
    const appIds = access.caller === 'automation'
      ? access.appIds ?? []
      : access.appId
        ? [access.appId]
        : [];
    const allowedApps = new Set(appIds);
    return entries.filter((entry) => entry.scope === 'global' || Boolean(entry.appId && allowedApps.has(entry.appId)));
  }

  private assertCanWrite(entry: MemoryEntry, access: MemoryAccess): void {
    if (access.caller === 'settings' || access.caller === 'desktop-chat' || access.caller === 'free-chat') {
      return;
    }
    if (entry.scope === 'global') {
      if (access.caller === 'automation') return;
      throw new Error('memory_scope_forbidden');
    }
    if (!entry.appId) {
      throw new Error('memory_app_required');
    }
    if (access.caller === 'app-agent' && entry.appId !== access.appId) {
      throw new Error('memory_scope_forbidden');
    }
    if (access.caller === 'automation' && !(access.appIds ?? []).includes(entry.appId)) {
      throw new Error('memory_scope_forbidden');
    }
  }

  private async load(): Promise<void> {
    if (!this.loadPromise) {
      this.loadPromise = this.loadFromDisk();
    }
    await this.loadPromise;
  }

  private async loadFromDisk(): Promise<void> {
    await fs.mkdir(this.metadataRoot, { recursive: true });
    this.db = this.openSqliteDatabase();
    if (!this.db) {
      throw new Error('memory_sqlite_unavailable');
    }
    this.db.pragma?.('journal_mode = WAL');
    this.db.pragma?.('foreign_keys = ON');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.createSchema();
    await this.migrateLegacyJson();
  }

  private openSqliteDatabase(): SqliteDatabase | null {
    const BetterSqlite3 = loadOptionalBetterSqlite();
    if (BetterSqlite3) {
      try {
        return new BetterSqlite3(this.sqlitePath()) as SqliteDatabase;
      } catch (error) {
        // Host-node tests can run with Electron-rebuilt native modules; fall through to node:sqlite.
        warnAboutSqliteFallback(error);
      }
    } else {
      warnAboutSqliteFallback();
    }
    try {
      const nodeSqlite = requireNodeSqlite();
      return nodeSqlite.DatabaseSync ? new nodeSqlite.DatabaseSync(this.sqlitePath()) : null;
    } catch {
      return null;
    }
  }

  private createSchema(): void {
    const db = this.requireDb();
    db.exec(`
      CREATE TABLE IF NOT EXISTS memory_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS memory_entries (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        app_id TEXT,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        read_when TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'active',
        source TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_memory_entries_scope ON memory_entries(scope, app_id);
      CREATE INDEX IF NOT EXISTS idx_memory_entries_status ON memory_entries(status, updated_at);
      CREATE TABLE IF NOT EXISTS memory_evidence (
        id TEXT PRIMARY KEY,
        memory_id TEXT NOT NULL REFERENCES memory_entries(id) ON DELETE CASCADE,
        source TEXT NOT NULL,
        excerpt TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS memory_usage_events (
        id TEXT PRIMARY KEY,
        memory_id TEXT NOT NULL REFERENCES memory_entries(id) ON DELETE CASCADE,
        caller TEXT NOT NULL,
        app_id TEXT,
        run_id TEXT,
        reason TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_memory_usage_memory ON memory_usage_events(memory_id, created_at);
      CREATE TABLE IF NOT EXISTS memory_revisions (
        id TEXT PRIMARY KEY,
        memory_id TEXT NOT NULL REFERENCES memory_entries(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        read_when TEXT NOT NULL,
        kind TEXT NOT NULL,
        scope TEXT NOT NULL,
        app_id TEXT,
        status TEXT NOT NULL,
        source TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS memory_maintenance_runs (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        summary TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT
      );
    `);
  }

  private async migrateLegacyJson(): Promise<void> {
    const db = this.requireDb();
    const migrated = db.prepare('SELECT value FROM memory_meta WHERE key = ?').get('legacy_json_migrated') as { value?: string } | undefined;
    if (migrated?.value === 'true') {
      return;
    }
    const raw = await fs.readFile(this.legacyJsonPath(), 'utf8').catch(() => '');
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as MemoryFile;
        const insert = db.prepare(`
          INSERT OR IGNORE INTO memory_entries (id, scope, app_id, kind, title, body, read_when, status, source, created_at, updated_at)
          VALUES (@id, @scope, @appId, @kind, @title, @body, @readWhen, @status, @source, @createdAt, @updatedAt)
        `);
        const migrateEntries = (entries: Array<Partial<MemoryEntry>>) => {
          for (const legacy of entries) {
            if (!legacy || typeof legacy !== 'object') continue;
            if (!VALID_KINDS.has(legacy.kind as MemoryKind)) continue;
            if (legacy.scope !== 'global' && legacy.scope !== 'app') continue;
            const body = sanitizeBody(legacy.body ?? legacy.text);
            if (!body) continue;
            const now = new Date().toISOString();
            const scope = legacy.scope === 'app' ? 'app' : 'global';
            const appId = scope === 'app' ? sanitizeAppId(legacy.appId) : undefined;
            insert.run({
              id: typeof legacy.id === 'string' ? legacy.id : randomUUID(),
              scope,
              appId: appId ?? null,
              kind: normalizeKind(legacy.kind),
              title: sanitizeTitle(legacy.title) || deriveTitle(body),
              body,
              readWhen: sanitizeReadWhen(legacy.readWhen),
              status: normalizeStatus(legacy.status),
              source: normalizeSource(legacy.source),
              createdAt: typeof legacy.createdAt === 'string' ? legacy.createdAt : now,
              updatedAt: typeof legacy.updatedAt === 'string' ? legacy.updatedAt : now,
            });
          }
        };
        if (db.transaction) {
          const transaction = db.transaction(migrateEntries);
          transaction(parsed.entries ?? []);
        } else {
          db.exec('BEGIN');
          try {
            migrateEntries(parsed.entries ?? []);
            db.exec('COMMIT');
          } catch (error) {
            db.exec('ROLLBACK');
            throw error;
          }
        }
      } catch {
        // A malformed legacy file should not prevent the SQLite memory store from starting.
      }
    }
    db.prepare('INSERT OR REPLACE INTO memory_meta (key, value) VALUES (?, ?)').run('legacy_json_migrated', 'true');
  }

  private allEntries(): MemoryEntry[] {
    const rows = this.requireDb().prepare('SELECT * FROM memory_entries ORDER BY updated_at DESC').all() as MemoryEntryRow[];
    return rows.map((row) => this.entryFromRow(row));
  }

  private entryById(id: string): MemoryEntry | null {
    const row = this.requireDb().prepare('SELECT * FROM memory_entries WHERE id = ?').get(id) as MemoryEntryRow | undefined;
    return row ? this.entryFromRow(row) : null;
  }

  private requireEntry(id: string, access: MemoryAccess): MemoryEntry {
    const entry = this.entryById(id);
    if (!entry) {
      throw new Error('memory_not_found');
    }
    if (!this.allowedEntries(access).some((allowed) => allowed.id === entry.id)) {
      throw new Error('memory_scope_forbidden');
    }
    return entry;
  }

  private entryFromRow(row: MemoryEntryRow): MemoryEntry {
    const entry: MemoryEntry = {
      id: row.id,
      scope: row.scope === 'app' ? 'app' : 'global',
      ...(row.app_id ? { appId: row.app_id } : {}),
      kind: normalizeKind(row.kind),
      title: row.title,
      body: row.body,
      readWhen: row.read_when,
      status: normalizeStatus(row.status),
      text: row.body,
      source: normalizeSource(row.source),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      evidence: this.evidenceFor(row.id),
      usage: this.usageFor(row.id),
      revisions: this.revisionsFor(row.id),
    };
    return entry;
  }

  private evidenceFor(memoryId: string): MemoryEvidence[] {
    const rows = this.requireDb().prepare('SELECT * FROM memory_evidence WHERE memory_id = ? ORDER BY created_at DESC').all(memoryId) as MemoryEvidenceRow[];
    return rows.map((row) => ({
      id: row.id,
      memoryId: row.memory_id,
      source: normalizeSource(row.source),
      excerpt: row.excerpt,
      createdAt: row.created_at,
    }));
  }

  private usageFor(memoryId: string): MemoryUsageEvent[] {
    const rows = this.requireDb().prepare('SELECT * FROM memory_usage_events WHERE memory_id = ? ORDER BY created_at DESC LIMIT 20').all(memoryId) as MemoryUsageRow[];
    return rows.map((row) => ({
      id: row.id,
      memoryId: row.memory_id,
      caller: normalizeCaller(row.caller),
      ...(row.app_id ? { appId: row.app_id } : {}),
      ...(row.run_id ? { runId: row.run_id } : {}),
      ...(row.reason ? { reason: row.reason } : {}),
      createdAt: row.created_at,
    }));
  }

  private revisionsFor(memoryId: string): MemoryRevision[] {
    const rows = this.requireDb().prepare('SELECT * FROM memory_revisions WHERE memory_id = ? ORDER BY created_at DESC LIMIT 20').all(memoryId) as MemoryRevisionRow[];
    return rows.map((row) => ({
      id: row.id,
      memoryId: row.memory_id,
      title: row.title,
      body: row.body,
      readWhen: row.read_when,
      kind: normalizeKind(row.kind),
      scope: row.scope === 'app' ? 'app' : 'global',
      ...(row.app_id ? { appId: row.app_id } : {}),
      status: normalizeStatus(row.status),
      source: normalizeSource(row.source),
      createdAt: row.created_at,
    }));
  }

  private insertEvidence(memoryId: string, excerpt: string, source: MemorySource, createdAt: string): void {
    if (!excerpt) return;
    this.requireDb().prepare(`
      INSERT INTO memory_evidence (id, memory_id, source, excerpt, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(randomUUID(), memoryId, source, excerpt, createdAt);
  }

  private insertRevision(entry: MemoryEntry): void {
    this.requireDb().prepare(`
      INSERT INTO memory_revisions (id, memory_id, title, body, read_when, kind, scope, app_id, status, source, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      randomUUID(),
      entry.id,
      entry.title,
      entry.body,
      entry.readWhen,
      entry.kind,
      entry.scope,
      entry.appId ?? null,
      entry.status,
      entry.source,
      new Date().toISOString(),
    );
  }

  private recordUsage(entry: MemoryEntry, access: MemoryAccess, reason: string): void {
    this.requireDb().prepare(`
      INSERT INTO memory_usage_events (id, memory_id, caller, app_id, run_id, reason, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), entry.id, access.caller, access.appId ?? null, access.runId ?? null, reason, new Date().toISOString());
  }

  private requireDb(): SqliteDatabase {
    if (!this.db) {
      throw new Error('memory_store_not_loaded');
    }
    return this.db;
  }

  private sqlitePath(): string {
    return path.join(this.metadataRoot, 'memory.sqlite');
  }

  private legacyJsonPath(): string {
    return path.join(this.metadataRoot, 'memory.json');
  }
}

function toEntryParams(entry: MemoryEntry): Record<string, string | null> {
  return {
    id: entry.id,
    scope: entry.scope,
    appId: entry.appId ?? null,
    kind: entry.kind,
    title: entry.title,
    body: entry.body,
    readWhen: entry.readWhen,
    status: entry.status,
    source: entry.source,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  };
}

function sanitizeTitle(value: unknown): string {
  return typeof value === 'string' ? value.trim().slice(0, MAX_TITLE_LENGTH) : '';
}

function sanitizeBody(value: unknown): string {
  return typeof value === 'string' ? value.trim().slice(0, MAX_BODY_LENGTH) : '';
}

function sanitizeReadWhen(value: unknown): string {
  return typeof value === 'string' ? value.trim().slice(0, MAX_READ_WHEN_LENGTH) : '';
}

function sanitizeEvidence(value: unknown): string {
  return typeof value === 'string' ? value.trim().slice(0, MAX_EVIDENCE_LENGTH) : '';
}

function sanitizeAppId(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 160) : undefined;
}

function normalizeKind(value: unknown): MemoryKind {
  return typeof value === 'string' && VALID_KINDS.has(value as MemoryKind)
    ? value as MemoryKind
    : 'preference';
}

function normalizeStatus(value: unknown): MemoryStatus {
  return typeof value === 'string' && VALID_STATUSES.has(value as MemoryStatus)
    ? value as MemoryStatus
    : 'active';
}

function normalizeSource(value: unknown): MemorySource {
  if (value === 'agent' || value === 'automation' || value === 'settings') {
    return value;
  }
  return 'user';
}

function normalizeCaller(value: unknown): MemoryAccess['caller'] {
  if (value === 'desktop-chat' || value === 'app-agent' || value === 'automation' || value === 'free-chat' || value === 'settings') {
    return value;
  }
  return 'settings';
}

function deriveTitle(body: string): string {
  const firstLine = body.split(/\r?\n/).find((line) => line.trim()) ?? body;
  return firstLine.trim().replace(/\s+/g, ' ').slice(0, MAX_TITLE_LENGTH) || 'Memory';
}
