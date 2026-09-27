import { Agent, fetch, type Dispatcher } from 'undici';
import { createDecipheriv, createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { MAX_IMAGE_BYTES } from './current-images';
import { encodeStableMessageRef, normalizeBaileysMessage } from './normalizer';
import type { WhatsAppStableMessageRef } from './types';

const MEDIA_ORIGIN = 'https://mmg.whatsapp.net';
const assertMediaUrl = (input: string | URL): void => {
  const url = new URL(input);
  if (url.origin !== MEDIA_ORIGIN || url.username || url.password || url.hash) throw new Error('image_source_invalid');
};

/** Strip alternate message types and validate the actual media locator on every reupload. */
export const safeImageDownloadMessage = (raw: unknown, expected: WhatsAppStableMessageRef): Record<string, unknown> => {
  const candidate = raw as { key?: unknown; message?: { imageMessage?: { url?: unknown; directPath?: unknown } } } | null;
  const media = candidate?.message?.imageMessage;
  if (!media) throw new Error('image_source_invalid');
  const result = { key: candidate!.key, message: { imageMessage: media } };
  const normalized = normalizeBaileysMessage(result);
  if (!normalized || encodeStableMessageRef(normalized.stableMessageRef) !== encodeStableMessageRef(expected)) throw new Error('image_source_invalid');
  if (typeof media.url !== 'string') throw new Error('image_source_invalid');
  assertMediaUrl(media.url);
  if (media.directPath !== undefined && (typeof media.directPath !== 'string' || !media.directPath.startsWith('/') || media.directPath.startsWith('//') || media.directPath.includes('\\'))) throw new Error('image_source_invalid');
  return result;
};

/** Defense in depth: every dispatched request stays on the media host without redirects. */
export const createImageDownloadDispatcher = (agent: Pick<Agent, 'dispatch'>): Pick<Dispatcher, 'dispatch'> => ({
  dispatch(options, handler) {
    try { assertMediaUrl(new URL(options.path, options.origin)); }
    catch { handler.onError?.(new Error('image_source_invalid')); return false; }
    // Undici handlers keep abort/body state on `this`; delegation must preserve
    // the original receiver consistently across every callback.
    const onHeaders: NonNullable<Dispatcher.DispatchHandlers['onHeaders']> = (status, headers, resume, statusText) => {
      if (status >= 300 && status < 400) { handler.onError?.(new Error('image_redirect_denied')); return false; }
      return handler.onHeaders?.(status, headers, resume, statusText) ?? true;
    };
    return agent.dispatch(options, new Proxy(handler, {
      get(target, key) {
        if (key === 'onHeaders') return onHeaders;
        const value: unknown = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }));
  },
});

interface ImageMediaKeys { iv: Uint8Array; cipherKey: Uint8Array; macKey: Uint8Array }
export interface ImageDownloadInput {
  message: unknown;
  expected: WhatsAppStableMessageRef;
  keys: (mediaKey: Uint8Array, type: 'image') => Promise<ImageMediaKeys>;
  authorize: () => Promise<boolean>;
  reupload: (message: unknown) => Promise<unknown>;
  fetch?: typeof fetch;
  timeoutMs?: number;
  dispatcher?: Pick<Agent, 'dispatch' | 'destroy'>;
}

const bytesFromJson = (value: unknown): Buffer => {
  if (typeof value === 'string') return Buffer.from(value, 'base64');
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (value && typeof value === 'object' && 'type' in value && value.type === 'Buffer' && 'data' in value && Array.isArray(value.data)) return Buffer.from(value.data);
  // Baileys may persist a Uint8Array as an object with numeric keys.
  if (value && typeof value === 'object') {
    const entries = Object.entries(value);
    if (entries.length && entries.every(([key, item], index) => key === String(index) && typeof item === 'number' && Number.isInteger(item) && item >= 0 && item <= 255)) return Buffer.from(entries.map(([, item]) => item as number));
  }
  throw new Error('image_key_invalid');
};

/** One abort listener for an outstanding control operation, removed as soon as it settles. */
const withAbort = async <T>(signal: AbortSignal, operation: Promise<T>): Promise<T> => {
  let cancel!: () => void;
  const canceled = new Promise<never>((_resolve, reject) => {
    cancel = () => reject(signal.reason);
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
  });
  try { return await Promise.race([canceled, operation]); }
  finally { signal.removeEventListener('abort', cancel); }
};

const readEncryptedBody = async (response: Awaited<ReturnType<typeof fetch>>, signal: AbortSignal): Promise<Buffer> => {
  if (!response.body) throw new Error('image_body_missing');
  const reader = response.body.getReader();
  const chunks: Buffer[] = []; let total = 0;
  try {
    // Also bound reader.read independently: an early fetch termination can lose
    // its abort listener before the response body is consumed.
    for (;;) {
      const next = await withAbort(signal, reader.read());
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_IMAGE_BYTES + 26) throw new Error('image_download_size');
      chunks.push(Buffer.from(next.value));
    }
    return Buffer.concat(chunks, total);
  } finally {
    // Cancel initiates teardown immediately; do not await a broken source’s
    // cancellation promise. The owning Agent is destroyed by the outer finally.
    try { void reader.cancel().catch(() => undefined); } finally { reader.releaseLock(); }
  }
};

export async function* downloadImageStream(input: ImageDownloadInput): AsyncGenerator<Uint8Array> {
  const agent = input.dispatcher ?? new Agent({ headersTimeout: 25_000, bodyTimeout: 25_000, connect: { timeout: 25_000 } });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('image_download_timeout')), input.timeoutMs ?? 25_000);
  try {
    let message = safeImageDownloadMessage(input.message, input.expected);
    let reuploaded = false;
    for (;;) {
      if (!await withAbort(controller.signal, input.authorize())) throw new Error('image_access_revoked');
      const media = (message.message as { imageMessage: Record<string, unknown> }).imageMessage;
      const url = typeof media.directPath === 'string' ? MEDIA_ORIGIN + media.directPath : media.url as string;
      const response = await withAbort(controller.signal, (input.fetch ?? fetch)(url, {
        signal: controller.signal, redirect: 'error', headers: { Origin: 'https://web.whatsapp.com' }, dispatcher: createImageDownloadDispatcher(agent) as Dispatcher,
      }));
      if ((response.status === 404 || response.status === 410) && !reuploaded) {
        await withAbort(controller.signal, response.body?.cancel() ?? Promise.resolve());
        reuploaded = true;
        message = safeImageDownloadMessage(await withAbort(controller.signal, input.reupload(message)), input.expected);
        continue;
      }
      if (!response.ok) { await withAbort(controller.signal, response.body?.cancel() ?? Promise.resolve()); throw new Error('image_download_failed'); }
      const encrypted = await readEncryptedBody(response, controller.signal);
      if (encrypted.length <= 10) throw new Error('image_download_invalid');
      if (media.fileEncSha256 && !createHash('sha256').update(encrypted).digest().equals(bytesFromJson(media.fileEncSha256))) throw new Error('image_integrity');
      const mediaKey = bytesFromJson(media.mediaKey);
      if (mediaKey.length !== 32) throw new Error('image_key_invalid');
      const keys = await withAbort(controller.signal, input.keys(mediaKey, 'image'));
      const ciphertext = encrypted.subarray(0, -10);
      const mac = createHmac('sha256', keys.macKey).update(keys.iv).update(ciphertext).digest().subarray(0, 10);
      if (!timingSafeEqual(mac, encrypted.subarray(-10))) throw new Error('image_integrity');
      const decipher = createDecipheriv('aes-256-cbc', keys.cipherKey, keys.iv);
      const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      if (plain.length > MAX_IMAGE_BYTES) throw new Error('image_download_size');
      if (media.fileSha256 && !createHash('sha256').update(plain).digest().equals(bytesFromJson(media.fileSha256))) throw new Error('image_integrity');
      if (!await withAbort(controller.signal, input.authorize())) throw new Error('image_access_revoked');
      yield plain;
      return;
    }
  } finally { clearTimeout(timer); controller.abort(); await agent.destroy(); }
}
