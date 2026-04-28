import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  AppSecretDeclaration,
  CreateUserSecretInput,
  SecretMutationResult,
  UpdateUserSecretInput,
  UserSecretSummary,
} from '../shared/types';

const VAULT_VERSION = 1;
const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;

interface EncryptedSecretValue {
  algorithm: typeof ALGORITHM;
  iv: string;
  tag: string;
  ciphertext: string;
}

interface PersistedSecretRecord {
  id: string;
  name: string;
  encryptedValue: EncryptedSecretValue;
  createdAt: string;
  updatedAt: string;
}

interface SecretsVault {
  version: typeof VAULT_VERSION;
  secrets: Record<string, PersistedSecretRecord>;
  appMappings: Record<string, Record<string, string>>;
}

export interface ResolvedAppSecretsEnv {
  env: Record<string, string>;
  missingRequired: AppSecretDeclaration[];
  secretValues: string[];
}

const createEmptyVault = (): SecretsVault => ({
  version: VAULT_VERSION,
  secrets: {},
  appMappings: {},
});

const isVault = (value: unknown): value is SecretsVault => {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Partial<SecretsVault>;
  return candidate.version === VAULT_VERSION && typeof candidate.secrets === 'object' && typeof candidate.appMappings === 'object';
};

const normalizeSecretName = (value: unknown): string => {
  if (typeof value !== 'string') {
    return '';
  }
  return value.replace(/\s+/g, ' ').trim();
};

export const appSecretEnvName = (name: string): string =>
  name
    .trim()
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();

export class SecretsStore {
  private vault: SecretsVault = createEmptyVault();
  private loaded = false;
  private key: Buffer | null = null;

  constructor(private readonly userDataPath: string) {}

  async load(): Promise<void> {
    if (this.loaded) {
      return;
    }

    this.key = await this.readOrCreateKey();
    this.vault = await this.readVault();
    this.loaded = true;
  }

  async listUserSecrets(): Promise<UserSecretSummary[]> {
    await this.load();
    return Object.values(this.vault.secrets)
      .map(({ id, name, createdAt, updatedAt }) => ({ id, name, createdAt, updatedAt }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async createUserSecret(input: CreateUserSecretInput): Promise<SecretMutationResult> {
    await this.load();
    const name = normalizeSecretName(input.name);
    const value = typeof input.value === 'string' ? input.value : '';

    if (!name) {
      return { success: false, userMessage: 'Asigna un nombre para guardar el secreto.', technicalCode: 'secret_name_required' };
    }
    if (!value) {
      return { success: false, userMessage: 'Ingresa un valor para guardar el secreto.', technicalCode: 'secret_value_required' };
    }

    const now = new Date().toISOString();
    const id = randomUUID();
    this.vault.secrets[id] = {
      id,
      name,
      encryptedValue: this.encrypt(value),
      createdAt: now,
      updatedAt: now,
    };
    await this.saveVault();

    return { success: true, userMessage: 'Secreto guardado.' };
  }

  async updateUserSecret(input: UpdateUserSecretInput): Promise<SecretMutationResult> {
    await this.load();
    const existing = this.vault.secrets[input.id];
    if (!existing) {
      return { success: false, userMessage: 'Ese secreto ya no existe.', technicalCode: 'secret_not_found' };
    }

    const name = normalizeSecretName(input.name);
    if (!name) {
      return { success: false, userMessage: 'Asigna un nombre para guardar el secreto.', technicalCode: 'secret_name_required' };
    }

    const nextValue = typeof input.value === 'string' ? input.value : undefined;
    if (nextValue !== undefined && !nextValue) {
      return { success: false, userMessage: 'Ingresa un valor para actualizar el secreto.', technicalCode: 'secret_value_required' };
    }

    existing.name = name;
    existing.updatedAt = new Date().toISOString();
    if (nextValue !== undefined) {
      existing.encryptedValue = this.encrypt(nextValue);
    }
    await this.saveVault();

    return { success: true, userMessage: 'Secreto actualizado.' };
  }

  async deleteUserSecret(id: string): Promise<SecretMutationResult> {
    await this.load();
    if (!this.vault.secrets[id]) {
      return { success: false, userMessage: 'Ese secreto ya no existe.', technicalCode: 'secret_not_found' };
    }

    delete this.vault.secrets[id];
    for (const mappings of Object.values(this.vault.appMappings)) {
      for (const [appSecretName, mappedSecretId] of Object.entries(mappings)) {
        if (mappedSecretId === id) {
          delete mappings[appSecretName];
        }
      }
    }
    await this.saveVault();

    return { success: true, userMessage: 'Secreto eliminado.' };
  }

  async connectAppSecret(appId: string, appSecretName: string, userSecretId: string): Promise<SecretMutationResult> {
    await this.load();
    if (!this.vault.secrets[userSecretId]) {
      return { success: false, userMessage: 'El secreto elegido ya no existe.', technicalCode: 'secret_not_found' };
    }

    const normalizedAppSecretName = normalizeSecretName(appSecretName);
    if (!appId || !normalizedAppSecretName) {
      return { success: false, userMessage: 'No pudimos conectar este secreto.', technicalCode: 'invalid_app_secret_mapping' };
    }

    this.vault.appMappings[appId] = {
      ...(this.vault.appMappings[appId] ?? {}),
      [normalizedAppSecretName]: userSecretId,
    };
    await this.saveVault();

    return { success: true, userMessage: 'Secreto conectado.' };
  }

  async disconnectAppSecret(appId: string, appSecretName: string): Promise<SecretMutationResult> {
    await this.load();
    const normalizedAppSecretName = normalizeSecretName(appSecretName);
    if (this.vault.appMappings[appId]) {
      delete this.vault.appMappings[appId][normalizedAppSecretName];
    }
    await this.saveVault();

    return { success: true, userMessage: 'Secreto desconectado.' };
  }

  async getMappedSecretId(appId: string, appSecretName: string): Promise<string | undefined> {
    await this.load();
    return this.vault.appMappings[appId]?.[appSecretName];
  }

  async resolveAppEnv(appId: string, declarations: AppSecretDeclaration[]): Promise<ResolvedAppSecretsEnv> {
    await this.load();
    const env: Record<string, string> = {};
    const missingRequired: AppSecretDeclaration[] = [];
    const secretValues: string[] = [];

    for (const declaration of declarations) {
      const mappedSecretId = this.vault.appMappings[appId]?.[declaration.name];
      const secret = mappedSecretId ? this.vault.secrets[mappedSecretId] : undefined;
      if (!secret) {
        if (declaration.required) {
          missingRequired.push(declaration);
        }
        continue;
      }

      const value = this.decrypt(secret.encryptedValue);
      env[appSecretEnvName(declaration.name)] = value;
      secretValues.push(value);
    }

    return { env, missingRequired, secretValues };
  }

  private encrypt(value: string): EncryptedSecretValue {
    const key = this.requireKey();
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, key, iv);
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();

    return {
      algorithm: ALGORITHM,
      iv: iv.toString('base64'),
      tag: tag.toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    };
  }

  private decrypt(value: EncryptedSecretValue): string {
    if (value.algorithm !== ALGORITHM) {
      throw new Error('unsupported_secret_algorithm');
    }
    const key = this.requireKey();
    const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(value.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(value.tag, 'base64'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(value.ciphertext, 'base64')),
      decipher.final(),
    ]);
    return plaintext.toString('utf8');
  }

  private requireKey(): Buffer {
    if (!this.key) {
      throw new Error('secrets_key_unavailable');
    }
    return this.key;
  }

  private getVaultPath(): string {
    return path.join(this.userDataPath, 'secrets.vault.json');
  }

  private getKeyPath(): string {
    return path.join(this.userDataPath, 'secrets.key');
  }

  private async readVault(): Promise<SecretsVault> {
    try {
      const raw = await fs.readFile(this.getVaultPath(), 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      return isVault(parsed) ? parsed : createEmptyVault();
    } catch {
      return createEmptyVault();
    }
  }

  private async saveVault(): Promise<void> {
    const vaultPath = this.getVaultPath();
    const tempPath = `${vaultPath}.tmp`;
    await fs.mkdir(path.dirname(vaultPath), { recursive: true });
    await fs.writeFile(tempPath, JSON.stringify(this.vault, null, 2), { encoding: 'utf8', mode: 0o600 });
    await fs.rename(tempPath, vaultPath);
    await fs.chmod(vaultPath, 0o600).catch(() => undefined);
  }

  private async readOrCreateKey(): Promise<Buffer> {
    const keyPath = this.getKeyPath();
    try {
      const raw = await fs.readFile(keyPath, 'utf8');
      const key = Buffer.from(raw.trim(), 'base64');
      if (key.length === KEY_BYTES) {
        return key;
      }
    } catch {
      // create a new managed key below
    }

    const key = randomBytes(KEY_BYTES);
    await fs.mkdir(path.dirname(keyPath), { recursive: true });
    await fs.writeFile(keyPath, key.toString('base64'), { encoding: 'utf8', mode: 0o600 });
    await fs.chmod(keyPath, 0o600).catch(() => undefined);
    return key;
  }
}
