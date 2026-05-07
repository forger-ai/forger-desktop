import { safeStorage } from 'electron';
import { randomUUID } from 'node:crypto';
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
const ALGORITHM = 'electron-safe-storage';

interface EncryptedSecretValue {
  algorithm: typeof ALGORITHM;
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

export class SecretsVaultUnavailableError extends Error {
  constructor(message = 'secrets_vault_unavailable') {
    super(message);
    this.name = 'SecretsVaultUnavailableError';
  }
}

export const isSecretsVaultUnavailableError = (error: unknown): error is SecretsVaultUnavailableError =>
  error instanceof SecretsVaultUnavailableError;

const createEmptyVault = (): SecretsVault => ({
  version: VAULT_VERSION,
  secrets: {},
  appMappings: {},
});

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const isVault = (value: unknown): value is SecretsVault => {
  if (!isPlainRecord(value)) {
    return false;
  }
  return (
    value.version === VAULT_VERSION
    && isPlainRecord(value.secrets)
    && isPlainRecord(value.appMappings)
  );
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

const unavailableResult = (): SecretMutationResult => ({
  success: false,
  userMessage: 'No pudimos leer los secretos guardados. Revisa el espacio seguro antes de guardar cambios.',
  technicalCode: 'secrets_vault_unavailable',
});

const encryptionUnavailableResult = (): SecretMutationResult => ({
  success: false,
  userMessage: 'El sistema no tiene disponible el almacenamiento seguro de secretos.',
  technicalCode: 'secrets_encryption_unavailable',
});

const isSecretsEncryptionUnavailableError = (error: unknown): boolean =>
  error instanceof Error && error.message === 'secrets_encryption_unavailable';

export class SecretsStore {
  private vault: SecretsVault = createEmptyVault();
  private loaded = false;

  constructor(private readonly userDataPath: string) {}

  async load(): Promise<void> {
    if (this.loaded) {
      return;
    }

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
    const loadError = await this.loadForMutation();
    if (loadError) {
      return loadError;
    }

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
    const loadError = await this.loadForMutation();
    if (loadError) {
      return loadError;
    }

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
    const loadError = await this.loadForMutation();
    if (loadError) {
      return loadError;
    }

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
    const loadError = await this.loadForMutation();
    if (loadError) {
      return loadError;
    }

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
    const loadError = await this.loadForMutation();
    if (loadError) {
      return loadError;
    }

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

      let value: string;
      try {
        value = this.decrypt(secret.encryptedValue);
      } catch (error) {
        if (!isSecretsEncryptionUnavailableError(error)) {
          throw error;
        }
        if (declaration.required) {
          missingRequired.push(declaration);
        }
        continue;
      }
      env[appSecretEnvName(declaration.name)] = value;
      secretValues.push(value);
    }

    return { env, missingRequired, secretValues };
  }

  private async loadForMutation(): Promise<SecretMutationResult | null> {
    try {
      await this.load();
    } catch (error) {
      if (isSecretsVaultUnavailableError(error)) {
        return unavailableResult();
      }
      throw error;
    }

    try {
      this.requireSafeStorage();
      return null;
    } catch {
      return encryptionUnavailableResult();
    }
  }

  private encrypt(value: string): EncryptedSecretValue {
    this.requireSafeStorage();
    return {
      algorithm: ALGORITHM,
      ciphertext: safeStorage.encryptString(value).toString('base64'),
    };
  }

  private decrypt(value: EncryptedSecretValue): string {
    if (value.algorithm !== ALGORITHM) {
      throw new SecretsVaultUnavailableError('secrets_vault_unsupported_algorithm');
    }
    this.requireSafeStorage();
    return safeStorage.decryptString(Buffer.from(value.ciphertext, 'base64'));
  }

  private requireSafeStorage(): void {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('secrets_encryption_unavailable');
    }
  }

  private getVaultPath(): string {
    return path.join(this.userDataPath, 'secrets.vault.json');
  }

  private async readVault(): Promise<SecretsVault> {
    let raw: string;
    try {
      raw = await fs.readFile(this.getVaultPath(), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return createEmptyVault();
      }
      throw new SecretsVaultUnavailableError();
    }

    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!isVault(parsed)) {
        throw new SecretsVaultUnavailableError('secrets_vault_invalid');
      }
      return parsed;
    } catch (error) {
      if (isSecretsVaultUnavailableError(error)) {
        throw error;
      }
      throw new SecretsVaultUnavailableError('secrets_vault_invalid');
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
}
