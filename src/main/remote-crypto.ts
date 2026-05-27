import { createCipheriv, createDecipheriv, createECDH, createHash, randomBytes } from 'node:crypto';

export interface RemoteEnvelope {
  sessionId: string;
  keyId: string;
  nonce: string;
  timestamp: string;
  browserPublicKeyJwk?: JsonWebKey;
  ciphertext: string;
}

export class RemoteSessionCrypto {
  private readonly ecdh = createECDH('prime256v1');
  private readonly sharedKeys = new Map<string, Buffer>();
  private currentKeyId = '';

  constructor() {
    this.ecdh.generateKeys();
  }

  desktopPublicKeyJwk(): JsonWebKey {
    return publicKeyToJwk(this.ecdh.getPublicKey());
  }

  decrypt<T>(envelope: RemoteEnvelope): T {
    const key = this.keyFor(envelope);
    const iv = Buffer.from(envelope.nonce, 'base64');
    const ciphertext = Buffer.from(envelope.ciphertext, 'base64');
    const tag = ciphertext.subarray(ciphertext.length - 16);
    const encrypted = ciphertext.subarray(0, ciphertext.length - 16);
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(aad(envelope.sessionId, envelope.keyId, envelope.timestamp));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return JSON.parse(plaintext.toString('utf8')) as T;
  }

  encrypt(sessionId: string, payload: unknown): RemoteEnvelope {
    if (!this.currentKeyId) {
      throw new Error('remote_session_key_missing');
    }
    return this.encryptForKey(sessionId, this.currentKeyId, payload);
  }

  encryptForKey(sessionId: string, keyId: string, payload: unknown): RemoteEnvelope {
    const sharedKey = this.sharedKeys.get(keyId);
    if (!sharedKey) {
      throw new Error('remote_session_key_missing');
    }
    const nonce = randomBytes(12);
    const timestamp = new Date().toISOString();
    const cipher = createCipheriv('aes-256-gcm', sharedKey, nonce);
    cipher.setAAD(aad(sessionId, keyId, timestamp));
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
      sessionId,
      keyId,
      nonce: nonce.toString('base64'),
      timestamp,
      ciphertext: Buffer.concat([encrypted, tag]).toString('base64'),
    };
  }

  private keyFor(envelope: RemoteEnvelope): Buffer {
    const existing = this.sharedKeys.get(envelope.keyId);
    if (existing) {
      this.currentKeyId = envelope.keyId;
      return existing;
    }
    if (!envelope.browserPublicKeyJwk) {
      throw new Error('remote_browser_key_missing');
    }
    const secret = this.ecdh.computeSecret(jwkToPublicKey(envelope.browserPublicKeyJwk));
    const sharedKey = createHash('sha256').update(secret).digest();
    this.sharedKeys.set(envelope.keyId, sharedKey);
    this.currentKeyId = envelope.keyId;
    return sharedKey;
  }
}

const aad = (sessionId: string, keyId: string, timestamp: string): Buffer =>
  Buffer.from(`${sessionId}\n${keyId}\n${timestamp}`, 'utf8');

const publicKeyToJwk = (key: Buffer): JsonWebKey => ({
  kty: 'EC',
  crv: 'P-256',
  x: base64url(key.subarray(1, 33)),
  y: base64url(key.subarray(33, 65)),
  ext: true,
});

const jwkToPublicKey = (jwk: JsonWebKey): Buffer => {
  if (typeof jwk.x !== 'string' || typeof jwk.y !== 'string') {
    throw new Error('remote_browser_key_invalid');
  }
  return Buffer.concat([Buffer.from([4]), base64urlDecode(jwk.x), base64urlDecode(jwk.y)]);
};

const base64url = (value: Buffer): string =>
  value.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');

const base64urlDecode = (value: string): Buffer => {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  return Buffer.from(padded, 'base64');
};
