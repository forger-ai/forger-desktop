import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  BackgroundTask,
  BackgroundTaskStatus,
  BackgroundTaskStatusUpdate,
  BackgroundTaskUpsertInput,
} from '../shared/types';

interface BackgroundTaskStoreOptions {
  maxTasks?: number;
  onUpdated?: (task: BackgroundTask) => void;
}

const DEFAULT_MAX_TASKS = 200;

export const isActiveBackgroundTaskStatus = (status: BackgroundTaskStatus): boolean =>
  status === 'queued' || status === 'running';

export class BackgroundTaskStore {
  private readonly maxTasks: number;

  public constructor(
    private readonly metadataRoot: string,
    private readonly options: BackgroundTaskStoreOptions = {},
  ) {
    this.maxTasks = Math.max(1, options.maxTasks ?? DEFAULT_MAX_TASKS);
  }

  public async list(): Promise<BackgroundTask[]> {
    return this.sortTasks(await this.readAll());
  }

  public async get(id: string): Promise<BackgroundTask | null> {
    const tasks = await this.readAll();
    return tasks.find((task) => task.id === id) ?? null;
  }

  public async upsert(input: BackgroundTaskUpsertInput): Promise<BackgroundTask> {
    const now = new Date().toISOString();
    const tasks = await this.readAll();
    const current = tasks.find((task) => task.id === input.id) ?? null;
    const next: BackgroundTask = {
      id: input.id,
      source: input.source,
      title: sanitizeText(input.title ?? current?.title ?? input.id, 180),
      status: input.status ?? current?.status ?? 'queued',
      statusUpdates: sanitizeStatusUpdates(input.statusUpdates ?? current?.statusUpdates ?? [], now),
      ...(input.result ?? current?.result ? { result: input.result ?? current?.result } : {}),
      ...(input.app ?? current?.app ? { app: input.app ?? current?.app } : {}),
      ...(input.relatedEntity ?? current?.relatedEntity ? { relatedEntity: input.relatedEntity ?? current?.relatedEntity } : {}),
      createdAt: input.createdAt ?? current?.createdAt ?? now,
      updatedAt: input.updatedAt ?? now,
      ...(input.completedAt ?? current?.completedAt ? { completedAt: input.completedAt ?? current?.completedAt } : {}),
    };

    if (!isActiveBackgroundTaskStatus(next.status) && !next.completedAt) {
      next.completedAt = next.updatedAt;
    }

    const withoutCurrent = tasks.filter((task) => task.id !== next.id);
    await this.writeAll([next, ...withoutCurrent]);
    this.options.onUpdated?.(next);
    return next;
  }

  public async appendStatusUpdate(id: string, update: Omit<BackgroundTaskStatusUpdate, 'createdAt'> & { createdAt?: string }): Promise<BackgroundTask> {
    const current = await this.get(id);
    if (!current) {
      throw new Error('background_task_not_found');
    }
    const now = new Date().toISOString();
    const statusUpdates = [
      ...current.statusUpdates,
      {
        message: sanitizeText(update.message, 500),
        ...(update.status ? { status: update.status } : {}),
        createdAt: update.createdAt ?? now,
      },
    ].slice(-80);
    return await this.upsert({
      ...current,
      status: update.status ?? current.status,
      statusUpdates,
      updatedAt: now,
    });
  }

  private async readAll(): Promise<BackgroundTask[]> {
    const raw = await fs.readFile(this.filePath(), 'utf8').catch(() => '[]');
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) {
        return [];
      }
      return parsed.map(normalizeTask).filter((task): task is BackgroundTask => Boolean(task));
    } catch {
      return [];
    }
  }

  private async writeAll(tasks: BackgroundTask[]): Promise<void> {
    await fs.mkdir(this.metadataRoot, { recursive: true });
    const bounded = this.sortTasks(tasks).slice(0, this.maxTasks);
    await fs.writeFile(this.filePath(), JSON.stringify(bounded, null, 2), 'utf8');
  }

  private sortTasks(tasks: BackgroundTask[]): BackgroundTask[] {
    return [...tasks].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  }

  private filePath(): string {
    return path.join(this.metadataRoot, 'background-tasks.json');
  }
}

export const makeBackgroundTaskId = (prefix: string): string => `${prefix}:${randomUUID()}`;

const normalizeTask = (value: unknown): BackgroundTask | null => {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const input = value as Partial<BackgroundTask>;
  if (typeof input.id !== 'string' || typeof input.source !== 'string' || typeof input.title !== 'string') {
    return null;
  }
  if (!isBackgroundTaskStatus(input.status)) {
    return null;
  }
  const now = new Date().toISOString();
  return {
    id: input.id,
    source: input.source === 'automation' ? 'automation' : 'social-upload',
    title: sanitizeText(input.title, 180),
    status: input.status,
    statusUpdates: sanitizeStatusUpdates(input.statusUpdates ?? [], now),
    ...(input.result ? { result: input.result } : {}),
    ...(input.app ? { app: input.app } : {}),
    ...(input.relatedEntity ? { relatedEntity: input.relatedEntity } : {}),
    createdAt: typeof input.createdAt === 'string' ? input.createdAt : now,
    updatedAt: typeof input.updatedAt === 'string' ? input.updatedAt : now,
    ...(typeof input.completedAt === 'string' ? { completedAt: input.completedAt } : {}),
  };
};

const isBackgroundTaskStatus = (value: unknown): value is BackgroundTaskStatus =>
  value === 'queued'
  || value === 'running'
  || value === 'succeeded'
  || value === 'failed'
  || value === 'canceled'
  || value === 'skipped';

const sanitizeStatusUpdates = (updates: BackgroundTaskStatusUpdate[], fallbackDate: string): BackgroundTaskStatusUpdate[] =>
  Array.isArray(updates)
    ? updates
        .filter((update) => update && typeof update.message === 'string')
        .map((update) => ({
          message: sanitizeText(update.message, 500),
          ...(isBackgroundTaskStatus(update.status) ? { status: update.status } : {}),
          createdAt: typeof update.createdAt === 'string' ? update.createdAt : fallbackDate,
        }))
        .slice(-80)
    : [];

const sanitizeText = (value: string, maxLength: number): string => value.trim().slice(0, maxLength);
