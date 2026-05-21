import fs from 'node:fs/promises';
import path from 'node:path';

export interface OperationEntry {
  operationId: string;
  runId: string;
  appId: string;
  commitSha: string;
  createdAt: string;
  title?: string;
  summary?: string;
  revertedAt?: string;
}

export class OperationHistoryStore {
  public constructor(
    private readonly metadataRoot: string,
    private readonly legacyMetadataRoot?: string,
  ) {}

  public async read(appId: string): Promise<OperationEntry[]> {
    const filePath = await this.filePath(appId);
    const raw = await fs.readFile(filePath, 'utf8').catch(async () => {
      const legacyPath = this.legacyFilePath(appId);
      return legacyPath ? await fs.readFile(legacyPath, 'utf8').catch(() => '[]') : '[]';
    });
    try {
      const parsed = JSON.parse(raw) as OperationEntry[];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  public async write(appId: string, entries: OperationEntry[]): Promise<void> {
    const filePath = await this.filePath(appId);
    await fs.writeFile(filePath, JSON.stringify(entries, null, 2), 'utf8');
  }

  public async append(appId: string, entry: OperationEntry): Promise<void> {
    const entries = await this.read(appId);
    entries.unshift(entry);
    await this.write(appId, entries);
  }

  private async filePath(appId: string): Promise<string> {
    const dir = path.join(this.metadataRoot, 'operations');
    await fs.mkdir(dir, { recursive: true });
    return path.join(dir, `${appId}.json`);
  }

  private legacyFilePath(appId: string): string | null {
    return this.legacyMetadataRoot ? path.join(this.legacyMetadataRoot, 'operations', `${appId}.json`) : null;
  }
}
