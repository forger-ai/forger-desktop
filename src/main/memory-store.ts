import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  MemoryCreateInput,
  MemoryEntry,
  MemoryListInput,
  MemoryUpdateInput,
} from '../shared/types';

export interface MemoryAccess {
  caller: 'desktop-chat' | 'app-agent' | 'automation' | 'settings';
  appId?: string;
  appIds?: string[];
}

interface MemoryFile {
  entries?: MemoryEntry[];
}

const MAX_TEXT_LENGTH = 2_000;
const VALID_KINDS = new Set<MemoryEntry['kind']>([
  'preference',
  'profile',
  'workflow',
  'constraint',
  'fact',
]);

export class MemoryStore {
  private entries = new Map<string, MemoryEntry>();
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
        return true;
      })
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  public async create(input: MemoryCreateInput, access: MemoryAccess = { caller: 'settings' }): Promise<MemoryEntry> {
    await this.load();
    const now = new Date().toISOString();
    const scope = input.scope === 'app' ? 'app' : 'global';
    const appId = scope === 'app' ? sanitizeAppId(input.appId) : undefined;
    const kind = normalizeKind(input.kind);
    const text = sanitizeText(input.text);
    if (!text) {
      throw new Error('memory_text_required');
    }
    const entry: MemoryEntry = {
      id: randomUUID(),
      scope,
      ...(appId ? { appId } : {}),
      kind,
      text,
      source: normalizeSource(input.source),
      createdAt: now,
      updatedAt: now,
    };
    this.assertCanWrite(entry, access);
    this.entries.set(entry.id, entry);
    await this.persist();
    return entry;
  }

  public async update(input: MemoryUpdateInput, access: MemoryAccess = { caller: 'settings' }): Promise<MemoryEntry> {
    await this.load();
    const current = this.entries.get(input.id);
    if (!current) {
      throw new Error('memory_not_found');
    }
    this.assertCanWrite(current, access);
    const scope = input.scope === 'app' ? 'app' : input.scope === 'global' ? 'global' : current.scope;
    const appId = scope === 'app' ? sanitizeAppId(input.appId ?? current.appId) : undefined;
    const next: MemoryEntry = {
      ...current,
      scope,
      kind: input.kind ? normalizeKind(input.kind) : current.kind,
      text: input.text !== undefined ? sanitizeText(input.text) : current.text,
      updatedAt: new Date().toISOString(),
    };
    if (appId) {
      next.appId = appId;
    } else {
      delete next.appId;
    }
    if (!next.text) {
      throw new Error('memory_text_required');
    }
    this.assertCanWrite(next, access);
    this.entries.set(next.id, next);
    await this.persist();
    return next;
  }

  public async delete(id: string, access: MemoryAccess = { caller: 'settings' }): Promise<{ success: boolean }> {
    await this.load();
    const entry = this.entries.get(id);
    if (!entry) {
      return { success: false };
    }
    this.assertCanWrite(entry, access);
    this.entries.delete(id);
    await this.persist();
    return { success: true };
  }

  public async buildContext(access: MemoryAccess, maxChars = 6_000): Promise<string> {
    const entries = await this.list({}, access);
    if (entries.length === 0) {
      return '';
    }
    const lines = ['Memoria relevante:'];
    for (const entry of entries) {
      const label = entry.scope === 'global' ? 'global' : entry.appId ?? 'app';
      lines.push(`- [${label}/${entry.kind}] ${entry.text}`);
      if (lines.join('\n').length >= maxChars) {
        break;
      }
    }
    return lines.join('\n').slice(0, maxChars).trim();
  }

  private allowedEntries(access: MemoryAccess): MemoryEntry[] {
    const entries = [...this.entries.values()];
    if (access.caller === 'settings' || access.caller === 'desktop-chat') {
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
    if (access.caller === 'settings' || access.caller === 'desktop-chat') {
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
    const raw = await fs.readFile(this.filePath(), 'utf8').catch(() => '');
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw) as MemoryFile;
      for (const entry of parsed.entries ?? []) {
        if (isMemoryEntry(entry)) {
          this.entries.set(entry.id, entry);
        }
      }
    } catch {
      this.entries.clear();
    }
  }

  private async persist(): Promise<void> {
    const filePath = this.filePath();
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const temporaryPath = `${filePath}.${process.pid}.tmp`;
    const payload = {
      entries: [...this.entries.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
    };
    await fs.writeFile(temporaryPath, JSON.stringify(payload, null, 2), 'utf8');
    await fs.rename(temporaryPath, filePath);
  }

  private filePath(): string {
    return path.join(this.metadataRoot, 'memory.json');
  }
}

function sanitizeText(value: unknown): string {
  return typeof value === 'string' ? value.trim().slice(0, MAX_TEXT_LENGTH) : '';
}

function sanitizeAppId(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 160) : undefined;
}

function normalizeKind(value: unknown): MemoryEntry['kind'] {
  return typeof value === 'string' && VALID_KINDS.has(value as MemoryEntry['kind'])
    ? value as MemoryEntry['kind']
    : 'preference';
}

function normalizeSource(value: unknown): MemoryEntry['source'] {
  if (value === 'agent' || value === 'automation' || value === 'settings') {
    return value;
  }
  return 'user';
}

function isMemoryEntry(value: unknown): value is MemoryEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Partial<MemoryEntry>;
  return Boolean(
    typeof entry.id === 'string' &&
    (entry.scope === 'global' || entry.scope === 'app') &&
    typeof entry.text === 'string' &&
    VALID_KINDS.has(entry.kind as MemoryEntry['kind']) &&
    typeof entry.createdAt === 'string' &&
    typeof entry.updatedAt === 'string',
  );
}
