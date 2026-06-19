import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export type AppFolderGrantAccess = 'readWrite';

export interface AppFolderGrant {
  grantId: string;
  appId: string;
  path: string;
  realPath: string;
  access: AppFolderGrantAccess;
  createdAt: string;
  lastUsedAt?: string;
  revokedAt?: string;
}

export interface AppFolderGrantPublic {
  grantId: string;
  path: string;
  realPath: string;
  name: string;
  access: AppFolderGrantAccess;
  createdAt: string;
  lastUsedAt?: string;
}

interface StoreFile {
  grants?: AppFolderGrant[];
}

export class AppFolderGrantStore {
  private grants: AppFolderGrant[] = [];
  private loaded = false;

  public constructor(private readonly metadataRoot: string) {}

  public async create(appId: string, selectedPath: string): Promise<AppFolderGrantPublic> {
    await this.load();
    const realPath = await fs.realpath(selectedPath);
    const now = new Date().toISOString();
    const existing = this.grants.find((grant) => grant.appId === appId && !grant.revokedAt && grant.realPath === realPath);
    if (existing) {
      existing.path = selectedPath;
      existing.lastUsedAt = now;
      await this.save();
      return toPublicGrant(existing);
    }
    const grant: AppFolderGrant = {
      grantId: randomUUID(),
      appId,
      path: selectedPath,
      realPath,
      access: 'readWrite',
      createdAt: now,
      lastUsedAt: now,
    };
    this.grants.push(grant);
    await this.save();
    return toPublicGrant(grant);
  }

  public async list(appId: string): Promise<AppFolderGrantPublic[]> {
    await this.load();
    return this.grants.filter((grant) => grant.appId === appId && !grant.revokedAt).map(toPublicGrant);
  }

  public async revoke(appId: string, grantId: string): Promise<{ revoked: boolean }> {
    await this.load();
    const grant = this.grants.find((entry) => entry.appId === appId && entry.grantId === grantId && !entry.revokedAt);
    if (!grant) {
      return { revoked: false };
    }
    grant.revokedAt = new Date().toISOString();
    await this.save();
    return { revoked: true };
  }

  public async resolve(appId: string, grantId: string): Promise<AppFolderGrantPublic> {
    await this.load();
    const grant = this.grants.find((entry) => entry.appId === appId && entry.grantId === grantId && !entry.revokedAt);
    if (!grant) {
      throw new Error('folder_grant_not_found');
    }
    const realPath = await fs.realpath(grant.realPath).catch(() => null);
    if (!realPath) {
      throw new Error('folder_grant_path_missing');
    }
    if (realPath !== grant.realPath) {
      throw new Error('folder_grant_path_changed');
    }
    grant.lastUsedAt = new Date().toISOString();
    await this.save();
    return toPublicGrant(grant);
  }

  private async load(): Promise<void> {
    if (this.loaded) {
      return;
    }
    this.loaded = true;
    const raw = await fs.readFile(this.storePath(), 'utf8').catch(() => '');
    if (!raw.trim()) {
      this.grants = [];
      return;
    }
    const parsed = JSON.parse(raw) as StoreFile;
    this.grants = Array.isArray(parsed.grants)
      ? parsed.grants.filter(isGrant)
      : [];
  }

  private async save(): Promise<void> {
    const filePath = this.storePath();
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify({ grants: this.grants }, null, 2), 'utf8');
  }

  private storePath(): string {
    return path.join(this.metadataRoot, 'app-folder-grants.json');
  }
}

const toPublicGrant = (grant: AppFolderGrant): AppFolderGrantPublic => ({
  grantId: grant.grantId,
  path: grant.path,
  realPath: grant.realPath,
  name: path.basename(grant.realPath) || grant.realPath,
  access: grant.access,
  createdAt: grant.createdAt,
  ...(grant.lastUsedAt ? { lastUsedAt: grant.lastUsedAt } : {}),
});

const isGrant = (value: unknown): value is AppFolderGrant => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const grant = value as Partial<AppFolderGrant>;
  return typeof grant.grantId === 'string'
    && typeof grant.appId === 'string'
    && typeof grant.path === 'string'
    && typeof grant.realPath === 'string'
    && grant.access === 'readWrite'
    && typeof grant.createdAt === 'string';
};
