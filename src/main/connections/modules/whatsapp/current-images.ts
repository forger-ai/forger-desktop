import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import type { WhatsAppLocalStore } from './store';
import type { WhatsAppCurrentMessageImagesResult, WhatsAppMessageAttachment } from './types';

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_PIXELS = 40_000_000;
type Image = NonNullable<WhatsAppCurrentMessageImagesResult['images']>[number];
export type ImageCodec = (bytes: Buffer, dimensions: { width: number; height: number }) => Promise<Image>;
export interface CurrentImagesScope { chatId: string; identityIds: string[]; stableMessageRef: string }
interface ImagePorts {
  download: (attachment: WhatsAppMessageAttachment) => Promise<AsyncIterable<Uint8Array>>;
  codec?: ImageCodec;
  authorize?: () => Promise<boolean>;
}

const dimensions = (bytes: Buffer): { width: number; height: number } => {
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) && bytes.toString('ascii', 12, 16) === 'IHDR') {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset++] !== 0xff) break;
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      if (marker === 0xda || marker === 0xd9) break;
      if (offset + 2 > bytes.length) break;
      const length = bytes.readUInt16BE(offset);
      if (length < 2 || offset + length > bytes.length) break;
      if ([0xc0, 0xc1, 0xc2].includes(marker) && length >= 7) return { width: bytes.readUInt16BE(offset + 5), height: bytes.readUInt16BE(offset + 3) };
      offset += length;
    }
  }
  throw new Error('unsupported');
};

const electronCodec: ImageCodec = async bytes => {
  const { nativeImage } = await import('electron');
  let decoded = nativeImage.createFromBuffer(bytes);
  const size = decoded.getSize();
  if (decoded.isEmpty() || !size.width || !size.height || size.width * size.height > MAX_PIXELS) throw new Error('invalid');
  if (Math.max(size.width, size.height) > 2048) {
    decoded = decoded.resize(size.width >= size.height ? { width: 2048 } : { height: 2048 });
  }
  const png = decoded.toPNG();
  if (png.length <= 2 * 1024 * 1024) return { data: png.toString('base64'), mimeType: 'image/png' };
  return { data: decoded.toJPEG(85).toString('base64'), mimeType: 'image/jpeg' };
};

export const normalizeImage = async (bytes: Buffer, codec: ImageCodec = electronCodec): Promise<Image> => {
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new Error('size');
  const size = dimensions(bytes);
  if (!size.width || !size.height || size.width * size.height > MAX_PIXELS) throw new Error('size');
  const image = await codec(bytes, size);
  if (!image.data || Buffer.byteLength(image.data, 'base64') > MAX_OUTPUT_BYTES) throw new Error('size');
  return image;
};

const readCache = async (rootPath: string, filePath: string): Promise<Buffer> => {
  const root = path.resolve(rootPath);
  if ((await fs.lstat(root)).isSymbolicLink()) throw new Error('cache');
  const realRoot = await fs.realpath(root);
  const target = path.resolve(filePath);
  if (!target.startsWith(root + path.sep)) throw new Error('cache');
  let cursor = root;
  for (const part of path.relative(root, target).split(path.sep)) {
    cursor = path.join(cursor, part);
    if ((await fs.lstat(cursor)).isSymbolicLink()) throw new Error('cache');
  }
  if (!(await fs.realpath(target)).startsWith(realRoot + path.sep)) throw new Error('cache');
  const handle = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_IMAGE_BYTES) throw new Error('size');
    // A concurrent writer cannot make this allocation grow without bound.
    const bytes = Buffer.alloc(Math.min(stat.size + 1, MAX_IMAGE_BYTES + 1));
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > MAX_IMAGE_BYTES) throw new Error('size');
    return bytes.subarray(0, bytesRead);
  } finally { await handle.close(); }
};

const readStream = async (stream: AsyncIterable<Uint8Array>): Promise<Buffer> => {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of stream) {
    size += chunk.byteLength;
    if (size > MAX_IMAGE_BYTES) throw new Error('size');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks, size);
};

/** Only an observed message in the authorized chat can supply visual input. */
export const readCurrentMessageImages = async (store: WhatsAppLocalStore, scope: CurrentImagesScope, ports: ImagePorts): Promise<WhatsAppCurrentMessageImagesResult> => {
  try {
    if (ports.authorize && !await ports.authorize()) throw new Error('revoked');
    const message = await store.getMessageInChat(scope.stableMessageRef, [scope.chatId, ...scope.identityIds]);
    if (!message) return { success: false, userMessage: 'No encontré la foto del mensaje que inició esta tarea.', technicalCode: 'whatsapp_current_images_not_found' };
    const attachments = message.attachments.filter(item => item.kind === 'image');
    if (!attachments.length) return { success: false, userMessage: 'El mensaje que inició esta tarea no contiene una foto compatible.', technicalCode: 'whatsapp_current_images_missing' };
    if (attachments.length > 4) throw new Error('size');
    const images: Image[] = []; let total = 0;
    for (const attachment of attachments) {
      if (ports.authorize && !await ports.authorize()) throw new Error('revoked');
      if ((attachment.sizeBytes ?? 0) > MAX_IMAGE_BYTES) throw new Error('size');
      const bytes = attachment.localPath ? await readCache(store.downloadsDirectory(), attachment.localPath) : await readStream(await ports.download(attachment));
      if (ports.authorize && !await ports.authorize()) throw new Error('revoked');
      const image = await normalizeImage(bytes, ports.codec);
      if (ports.authorize && !await ports.authorize()) throw new Error('revoked');
      total += Buffer.byteLength(image.data, 'base64');
      if (total > MAX_OUTPUT_BYTES) throw new Error('size');
      images.push(image);
    }
    return { success: true, images };
  } catch {
    return { success: false, userMessage: 'No pude leer esta foto. Envía una imagen PNG o JPEG normal de hasta 10 MB con la petición en su descripción.', technicalCode: 'whatsapp_current_images_unavailable' };
  }
};
