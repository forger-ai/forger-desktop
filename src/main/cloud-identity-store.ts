import { safeStorage } from 'electron';
import { createHash, generateKeyPairSync, privateDecrypt, publicEncrypt, randomBytes, createCipheriv, createDecipheriv, sign } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

interface StoredCloudIdentity {
  version: 1;
  publicKey: string;
  encryptedPrivateKey: string;
  keyFingerprint: string;
  createdAt: string;
  updatedAt: string;
}

export interface CloudIdentitySummary {
  publicKey: string;
  keyFingerprint: string;
  secretKeyPreview: string;
  createdAt: string;
  updatedAt: string;
}

export interface EncryptedCloudText {
  algorithm: 'rsa-oaep-sha256+aes-256-gcm';
  keyFingerprint?: string;
  encryptedKey: string;
  iv: string;
  tag: string;
  ciphertext: string;
}

export class CloudIdentityStore {
  private identity: StoredCloudIdentity | null = null;

  constructor(private readonly filePath: string) {}

  async getSummary(): Promise<CloudIdentitySummary> {
    const identity = await this.loadOrCreate();
    return this.summary(identity);
  }

  async getPublicRegistration(): Promise<{ publicKey: string; keyFingerprint: string }> {
    const identity = await this.loadOrCreate();
    return { publicKey: identity.publicKey, keyFingerprint: identity.keyFingerprint };
  }

  async revealSecretKey(): Promise<string> {
    const identity = await this.loadOrCreate();
    return this.decryptPrivateKey(identity);
  }

  async regenerate(): Promise<CloudIdentitySummary> {
    const identity = await this.createIdentity();
    await this.save(identity);
    this.identity = identity;
    return this.summary(identity);
  }

  encryptFor(publicKey: string, text: string, keyFingerprint?: string): EncryptedCloudText {
    const key = randomBytes(32);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
      algorithm: 'rsa-oaep-sha256+aes-256-gcm',
      keyFingerprint,
      encryptedKey: publicEncrypt({ key: publicKey, oaepHash: 'sha256' }, key).toString('base64'),
      iv: iv.toString('base64'),
      tag: tag.toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    };
  }

  async decrypt(input: EncryptedCloudText): Promise<string> {
    const identity = await this.loadOrCreate();
    const privateKey = this.decryptPrivateKey(identity);
    const key = privateDecrypt({ key: privateKey, oaepHash: 'sha256' }, Buffer.from(input.encryptedKey, 'base64'));
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(input.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(input.tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(input.ciphertext, 'base64')), decipher.final()]).toString('utf8');
  }

  async signText(text: string): Promise<{ signature: string; keyFingerprint: string; algorithm: string }> {
    const identity = await this.loadOrCreate();
    const privateKey = this.decryptPrivateKey(identity);
    return {
      signature: sign('sha256', Buffer.from(text, 'utf8'), privateKey).toString('base64'),
      keyFingerprint: identity.keyFingerprint,
      algorithm: 'rsa-sha256',
    };
  }

  private async loadOrCreate(): Promise<StoredCloudIdentity> {
    if (this.identity) {
      return this.identity;
    }
    try {
      const parsed = JSON.parse(await fs.readFile(this.filePath, 'utf8')) as StoredCloudIdentity;
      if (parsed?.version === 1 && parsed.publicKey && parsed.encryptedPrivateKey && parsed.keyFingerprint) {
        this.identity = parsed;
        return parsed;
      }
    } catch {
      // Create below.
    }
    const identity = await this.createIdentity();
    await this.save(identity);
    this.identity = identity;
    return identity;
  }

  private async createIdentity(): Promise<StoredCloudIdentity> {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('cloud_identity_encryption_unavailable');
    }
    const { publicKey, privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const now = new Date().toISOString();
    return {
      version: 1,
      publicKey,
      encryptedPrivateKey: safeStorage.encryptString(privateKey).toString('base64'),
      keyFingerprint: createHash('sha256').update(publicKey).digest('hex'),
      createdAt: now,
      updatedAt: now,
    };
  }

  private decryptPrivateKey(identity: StoredCloudIdentity): string {
    return safeStorage.decryptString(Buffer.from(identity.encryptedPrivateKey, 'base64'));
  }

  private async save(identity: StoredCloudIdentity): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, JSON.stringify(identity, null, 2), 'utf8');
  }

  private summary(identity: StoredCloudIdentity): CloudIdentitySummary {
    return {
      publicKey: identity.publicKey,
      keyFingerprint: identity.keyFingerprint,
      secretKeyPreview: identity.keyFingerprint,
      createdAt: identity.createdAt,
      updatedAt: identity.updatedAt,
    };
  }
}
