import { safeStorage } from 'electron';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export interface StoredCloudDevice {
  deviceUid: string;
  deviceSecret: string;
  cloudId?: number;
}

interface CloudDeviceStorageOptions {
  filePath: string;
  accountStorageKey: () => string | undefined;
}

export class CloudDeviceStorage {
  private stored: StoredCloudDevice | null = null;
  private storedPath: string | undefined;

  constructor(private readonly options: CloudDeviceStorageOptions) {}

  reset(): void {
    this.stored = null;
    this.storedPath = undefined;
  }

  async loadOrCreate(): Promise<StoredCloudDevice> {
    const existing = await this.load();
    if (existing) {
      return existing;
    }
    this.stored = {
      deviceUid: randomUUID(),
      deviceSecret: randomBytes(32).toString('hex'),
    };
    await this.save(this.stored);
    return this.stored;
  }

  async load(): Promise<StoredCloudDevice | null> {
    const filePath = this.currentFilePath();
    if (this.stored && this.storedPath === filePath) {
      return this.stored;
    }
    this.stored = null;
    this.storedPath = filePath;
    try {
      const raw = await fs.readFile(filePath, 'utf8');
      const parsed = JSON.parse(raw) as StoredCloudDevice & { encrypted?: boolean };
      if (parsed.encrypted && safeStorage.isEncryptionAvailable()) {
        parsed.deviceSecret = safeStorage.decryptString(Buffer.from(parsed.deviceSecret, 'base64'));
      }
      if (parsed.deviceUid && parsed.deviceSecret) {
        this.stored = parsed;
        return parsed;
      }
    } catch {
      return null;
    }
    return null;
  }

  async save(stored: StoredCloudDevice): Promise<void> {
    const filePath = this.storedPath ?? this.currentFilePath();
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const payload = safeStorage.isEncryptionAvailable()
      ? {
          ...stored,
          encrypted: true,
          deviceSecret: safeStorage.encryptString(stored.deviceSecret).toString('base64'),
        }
      : stored;
    this.stored = stored;
    await fs.writeFile(filePath, JSON.stringify(payload, null, 2), 'utf8');
  }

  private currentFilePath(): string {
    const accountStorageKey = this.options.accountStorageKey()?.replace(/[^a-zA-Z0-9_-]/g, '_');
    if (!accountStorageKey) {
      return this.options.filePath;
    }
    const extension = path.extname(this.options.filePath);
    const basename = path.basename(this.options.filePath, extension);
    return path.join(path.dirname(this.options.filePath), `${basename}-${accountStorageKey}${extension}`);
  }
}

export const randomPairingCode = (): string => {
  let code = '';
  while (code.length < 8) {
    code += randomBytes(6).toString('base64url').replace(/[^A-Z0-9]/gi, '').toUpperCase();
  }
  return code.slice(0, 8);
};

export const digestPairingCode = (code: string): string =>
  createHash('sha256').update(code.toUpperCase().replace(/[^A-Z0-9]/g, '')).digest('hex');
