import { createHash, randomBytes } from 'node:crypto';

export const base64Url = (buffer: Buffer): string =>
  buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');

export const createPkcePair = (): { verifier: string; challenge: string } => {
  const verifier = base64Url(randomBytes(48));
  const challenge = base64Url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
};

export const oauthState = (): string => base64Url(randomBytes(32));
