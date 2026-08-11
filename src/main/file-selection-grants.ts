import { randomBytes } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import fs, { type FileHandle } from 'node:fs/promises';
import path from 'node:path';

export const FILE_SELECTION_GRANT_TTL_MS = 10 * 60 * 1000;
export const MAX_FILE_SELECTION_GRANTS = 256;

interface FileFingerprint {
  birthtimeNs: string;
  ctimeNs: string;
  dev: string;
  ino: string;
  mtimeNs: string;
  size: string;
}

type FileSelectionGrantState = 'available' | 'leased' | 'imported';

interface StoredFileSelectionGrant {
  expiresAt: number;
  fingerprint: FileFingerprint;
  grantId: string;
  importName: string;
  leaseId?: string;
  realPath: string;
  selectedPath: string;
  senderId: number;
  staged: boolean;
  state: FileSelectionGrantState;
}

export interface FileSelectionGrantHandle {
  grantId: string;
}

export interface ResolvedFileSelectionGrant {
  grantId: string;
  sourcePath: string;
  staged: boolean;
}

export interface OpenedFileSelectionGrant {
  fileHandle: FileHandle;
  grantId: string;
  name: string;
  staged: boolean;
  verify: () => Promise<void>;
}

export interface FileSelectionImportLease {
  commit: () => Promise<void>;
  openFiles: () => Promise<OpenedFileSelectionGrant[]>;
  rollback: () => Promise<void>;
}

export interface FileSelectionGrantStoreOptions {
  cleanupExpiredStagedFiles?: (grants: ResolvedFileSelectionGrant[]) => Promise<void>;
  maxGrants?: number;
  now?: () => number;
  ttlMs?: number;
}

interface FileSelectionGrantIssueInput {
  senderId: number;
  files: Array<{
    name?: string;
    sourcePath: string;
    staged: boolean;
  }>;
}

const fingerprintFromStat = (stat: BigIntStats): FileFingerprint => ({
  birthtimeNs: stat.birthtimeNs.toString(),
  ctimeNs: stat.ctimeNs.toString(),
  dev: stat.dev.toString(),
  ino: stat.ino.toString(),
  mtimeNs: stat.mtimeNs.toString(),
  size: stat.size.toString(),
});

const fingerprintFor = async (filePath: string): Promise<FileFingerprint> => {
  const stat = await fs.stat(filePath, { bigint: true }).catch(() => null);
  if (!stat?.isFile()) {
    throw new Error('file_selection_not_file');
  }
  return fingerprintFromStat(stat);
};

const fingerprintsMatch = (left: FileFingerprint, right: FileFingerprint): boolean => (
  left.birthtimeNs === right.birthtimeNs
  && left.ctimeNs === right.ctimeNs
  && left.dev === right.dev
  && left.ino === right.ino
  && left.mtimeNs === right.mtimeNs
  && left.size === right.size
);

const closeOpenedFiles = async (files: OpenedFileSelectionGrant[]): Promise<void> => {
  await Promise.allSettled(files.map((file) => file.fileHandle.close()));
};

export class FileSelectionGrantStore {
  private readonly cleanupExpiredStagedFiles: (grants: ResolvedFileSelectionGrant[]) => Promise<void>;
  private readonly grants = new Map<string, StoredFileSelectionGrant>();
  private readonly maxGrants: number;
  private readonly now: () => number;
  private operationQueue: Promise<void> = Promise.resolve();
  private readonly ttlMs: number;

  public constructor(options: FileSelectionGrantStoreOptions = {}) {
    this.cleanupExpiredStagedFiles = options.cleanupExpiredStagedFiles ?? (async () => undefined);
    this.maxGrants = Math.max(1, Math.floor(options.maxGrants ?? MAX_FILE_SELECTION_GRANTS));
    this.now = options.now ?? Date.now;
    this.ttlMs = Math.max(1, Math.floor(options.ttlMs ?? FILE_SELECTION_GRANT_TTL_MS));
  }

  public async issueMany(input: FileSelectionGrantIssueInput): Promise<FileSelectionGrantHandle[]> {
    return await this.runExclusive(async () => {
      await this.pruneExpired();
      if (!Number.isInteger(input.senderId)) {
        throw new Error('invalid_file_selection_sender');
      }
      if (input.files.length + this.grants.size > this.maxGrants) {
        throw new Error('too_many_file_selection_grants');
      }

      const prepared: Array<Omit<StoredFileSelectionGrant, 'expiresAt' | 'grantId' | 'senderId' | 'state'>> = [];
      for (const file of input.files) {
        const selectedPath = path.resolve(file.sourcePath);
        const realPath = await fs.realpath(selectedPath).catch(() => null);
        if (!realPath) {
          throw new Error('file_selection_not_file');
        }
        prepared.push({
          fingerprint: await fingerprintFor(realPath),
          importName: file.name?.trim() || path.basename(selectedPath),
          realPath,
          selectedPath,
          staged: file.staged,
        });
      }

      const issuedAt = this.now();
      return prepared.map((file) => {
        const grantId = this.nextId();
        this.grants.set(grantId, {
          ...file,
          expiresAt: issuedAt + this.ttlMs,
          grantId,
          senderId: input.senderId,
          state: 'available',
        });
        return { grantId };
      });
    });
  }

  public async leaseForImport(senderId: number, grantIds: string[]): Promise<FileSelectionImportLease> {
    const leaseId = this.nextId();
    await this.runExclusive(async () => {
      const records = await this.validateOwnedRecords(senderId, grantIds);
      for (const record of records) {
        if (record.state === 'leased') {
          throw new Error('file_selection_grant_leased');
        }
        if (record.state === 'imported') {
          throw new Error('file_selection_grant_replayed');
        }
        await this.validateFileIdentity(record);
      }
      for (const record of records) {
        record.leaseId = leaseId;
        record.state = 'leased';
      }
    });

    let finalized = false;
    let opened = false;
    return {
      commit: async () => {
        if (finalized) {
          return;
        }
        finalized = true;
        await this.finishLease(leaseId, grantIds, true);
      },
      openFiles: async () => {
        if (finalized || opened) {
          throw new Error('file_selection_lease_unavailable');
        }
        opened = true;
        try {
          return await this.openLeaseFiles(leaseId, grantIds);
        } catch (error) {
          opened = false;
          throw error;
        }
      },
      rollback: async () => {
        if (finalized) {
          return;
        }
        finalized = true;
        await this.finishLease(leaseId, grantIds, false);
      },
    };
  }

  public async release(senderId: number, grantIds: string[]): Promise<ResolvedFileSelectionGrant[]> {
    return await this.runExclusive(async () => {
      const records = await this.validateOwnedRecords(senderId, grantIds);
      for (const record of records) {
        if (record.state === 'leased') {
          throw new Error('file_selection_grant_leased');
        }
      }
      const stagedCleanup = await this.stagedCleanupFor(records);
      for (const record of records) {
        this.grants.delete(record.grantId);
      }
      return stagedCleanup;
    });
  }

  public async revokeSender(senderId: number): Promise<ResolvedFileSelectionGrant[]> {
    return await this.runExclusive(async () => {
      const records = [...this.grants.values()].filter((grant) => grant.senderId === senderId);
      const stagedCleanup = await this.stagedCleanupFor(records);
      for (const record of records) {
        this.grants.delete(record.grantId);
      }
      return stagedCleanup;
    });
  }

  private async finishLease(leaseId: string, grantIds: string[], commit: boolean): Promise<void> {
    await this.runExclusive(async () => {
      const expired: StoredFileSelectionGrant[] = [];
      for (const grantId of grantIds) {
        const record = this.grants.get(grantId);
        if (!record || record.state !== 'leased' || record.leaseId !== leaseId) {
          continue;
        }
        delete record.leaseId;
        if (!commit) {
          if (record.expiresAt <= this.now()) {
            this.grants.delete(grantId);
            expired.push(record);
          } else {
            record.state = 'available';
          }
          continue;
        }
        if (record.staged) {
          record.state = 'imported';
        } else {
          this.grants.delete(grantId);
        }
      }
      await this.cleanupExpired(expired);
    });
  }

  private nextId(): string {
    let id = '';
    do {
      id = randomBytes(32).toString('base64url');
    } while (this.grants.has(id));
    return id;
  }

  private async openLeaseFiles(leaseId: string, grantIds: string[]): Promise<OpenedFileSelectionGrant[]> {
    return await this.runExclusive(async () => {
      const records = grantIds.map((grantId) => {
        const record = this.grants.get(grantId);
        if (!record || record.state !== 'leased' || record.leaseId !== leaseId) {
          throw new Error('file_selection_lease_unavailable');
        }
        return record;
      });
      const opened: OpenedFileSelectionGrant[] = [];
      try {
        for (const record of records) {
          await this.validateFileIdentity(record);
          const fileHandle = await fs.open(record.realPath, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => null);
          if (!fileHandle) {
            throw new Error('file_selection_changed');
          }
          const stat = await fileHandle.stat({ bigint: true }).catch(() => null);
          if (!stat?.isFile()) {
            await fileHandle.close().catch(() => undefined);
            throw new Error('file_selection_not_file');
          }
          if (!fingerprintsMatch(fingerprintFromStat(stat), record.fingerprint)) {
            await fileHandle.close().catch(() => undefined);
            throw new Error('file_selection_changed');
          }
          opened.push({
            fileHandle,
            grantId: record.grantId,
            name: record.importName,
            staged: record.staged,
            verify: async () => {
              const currentStat = await fileHandle.stat({ bigint: true }).catch(() => null);
              if (!currentStat?.isFile() || !fingerprintsMatch(fingerprintFromStat(currentStat), record.fingerprint)) {
                throw new Error('file_selection_changed');
              }
            },
          });
        }
        return opened;
      } catch (error) {
        await closeOpenedFiles(opened);
        throw error;
      }
    });
  }

  private async pruneExpired(): Promise<void> {
    const now = this.now();
    const expired: StoredFileSelectionGrant[] = [];
    for (const [grantId, grant] of this.grants) {
      if (grant.state !== 'leased' && grant.expiresAt <= now) {
        this.grants.delete(grantId);
        expired.push(grant);
      }
    }
    await this.cleanupExpired(expired);
  }

  private async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.operationQueue;
    let release: (() => void) | undefined;
    this.operationQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release?.();
    }
  }

  private async stagedCleanupFor(records: StoredFileSelectionGrant[]): Promise<ResolvedFileSelectionGrant[]> {
    const stagedCleanup: ResolvedFileSelectionGrant[] = [];
    for (const record of records) {
      if (!record.staged) {
        continue;
      }
      try {
        await this.validateFileIdentity(record);
        stagedCleanup.push({ grantId: record.grantId, sourcePath: record.realPath, staged: true });
      } catch {
        // A changed path is revoked but never returned as a deletion target.
      }
    }
    return stagedCleanup;
  }

  private async cleanupExpired(records: StoredFileSelectionGrant[]): Promise<void> {
    if (records.length === 0) {
      return;
    }
    const stagedCleanup = await this.stagedCleanupFor(records);
    if (stagedCleanup.length === 0) {
      return;
    }
    await this.cleanupExpiredStagedFiles(stagedCleanup).catch(() => undefined);
  }

  private async validateFileIdentity(record: StoredFileSelectionGrant): Promise<void> {
    const currentRealPath = await fs.realpath(record.selectedPath).catch(() => null);
    if (!currentRealPath) {
      throw new Error('file_selection_not_file');
    }
    if (currentRealPath !== record.realPath) {
      throw new Error('file_selection_changed');
    }
    const currentFingerprint = await fingerprintFor(currentRealPath);
    if (!fingerprintsMatch(currentFingerprint, record.fingerprint)) {
      throw new Error('file_selection_changed');
    }
  }

  private async validateOwnedRecords(senderId: number, grantIds: string[]): Promise<StoredFileSelectionGrant[]> {
    if (!Number.isInteger(senderId) || !Array.isArray(grantIds)) {
      throw new Error('invalid_file_selection_grant');
    }
    const uniqueIds = new Set(grantIds);
    if (uniqueIds.size !== grantIds.length) {
      throw new Error('duplicate_file_selection_grant');
    }

    const records: StoredFileSelectionGrant[] = [];
    for (const grantId of grantIds) {
      if (typeof grantId !== 'string' || !grantId) {
        throw new Error('invalid_file_selection_grant');
      }
      const record = this.grants.get(grantId);
      if (!record) {
        throw new Error('invalid_file_selection_grant');
      }
      if (record.senderId !== senderId) {
        throw new Error('file_selection_grant_sender_mismatch');
      }
      if (record.state !== 'leased' && record.expiresAt <= this.now()) {
        this.grants.delete(grantId);
        await this.cleanupExpired([record]);
        throw new Error('expired_file_selection_grant');
      }
      records.push(record);
    }
    return records;
  }
}
