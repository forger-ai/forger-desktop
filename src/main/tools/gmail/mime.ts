import fs from 'node:fs/promises';
import path from 'node:path';
import type { GmailSendInput } from './types';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_SEND_ATTACHMENT_BYTES = 25 * 1024 * 1024;

const normalizeRecipients = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean);
};

const normalizeAttachments = (value: unknown): GmailSendInput['attachments'] => {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const attachments = value.flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return [];
    }
    const candidate = item as Record<string, unknown>;
    const filePath = typeof candidate.filePath === 'string' ? candidate.filePath.trim() : '';
    if (!filePath || !path.isAbsolute(filePath)) {
      return [];
    }
    const filename = typeof candidate.filename === 'string' ? candidate.filename.trim() : '';
    const mimeType = typeof candidate.mimeType === 'string' ? candidate.mimeType.trim() : '';
    return [{
      filePath,
      ...(filename ? { filename } : {}),
      ...(mimeType ? { mimeType } : {}),
    }];
  });
  return attachments.length > 0 ? attachments : undefined;
};

export const parseSendInput = (input: unknown): GmailSendInput | null => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return null;
  }
  const candidate = input as Record<string, unknown>;
  const to = normalizeRecipients(candidate.to);
  const cc = normalizeRecipients(candidate.cc);
  const bcc = normalizeRecipients(candidate.bcc);
  const subject = typeof candidate.subject === 'string' ? candidate.subject.trim() : '';
  const body = typeof candidate.body === 'string' ? candidate.body : '';
  const attachments = normalizeAttachments(candidate.attachments);

  if (to.length === 0 || !subject || !body) {
    return null;
  }
  const allRecipients = [...to, ...cc, ...bcc];
  if (allRecipients.some((recipient) => !EMAIL_PATTERN.test(recipient))) {
    return null;
  }

  return {
    to,
    ...(cc.length > 0 ? { cc } : {}),
    ...(bcc.length > 0 ? { bcc } : {}),
    subject,
    body,
    ...(attachments ? { attachments } : {}),
  };
};

const encodeHeader = (value: string): string => {
  if (/^[\x20-\x7E]*$/.test(value)) {
    return value;
  }
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
};

export const toBase64Url = (value: string | Buffer): string =>
  Buffer.from(value).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');

const inferMimeType = (filename: string): string => {
  const extension = path.extname(filename).toLowerCase();
  const mimeTypes: Record<string, string> = {
    '.csv': 'text/csv',
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.gif': 'image/gif',
    '.heic': 'image/heic',
    '.jpeg': 'image/jpeg',
    '.jpg': 'image/jpeg',
    '.json': 'application/json',
    '.md': 'text/markdown',
    '.pdf': 'application/pdf',
    '.png': 'image/png',
    '.txt': 'text/plain',
    '.xls': 'application/vnd.ms-excel',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.zip': 'application/zip',
  };
  return mimeTypes[extension] ?? 'application/octet-stream';
};

const encodeAttachmentBody = (buffer: Buffer): string => {
  const base64 = buffer.toString('base64');
  return base64.match(/.{1,76}/g)?.join('\r\n') ?? '';
};

const buildTextEmail = (input: GmailSendInput): string => {
  const lines = [
    `To: ${input.to.join(', ')}`,
    ...(input.cc?.length ? [`Cc: ${input.cc.join(', ')}`] : []),
    ...(input.bcc?.length ? [`Bcc: ${input.bcc.join(', ')}`] : []),
    `Subject: ${encodeHeader(input.subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: 8bit',
    '',
    input.body,
  ];
  return toBase64Url(lines.join('\r\n'));
};

export const buildRawEmail = async (input: GmailSendInput): Promise<string> => {
  if (!input.attachments?.length) {
    return buildTextEmail(input);
  }

  const boundary = `forger-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const lines = [
    `To: ${input.to.join(', ')}`,
    ...(input.cc?.length ? [`Cc: ${input.cc.join(', ')}`] : []),
    ...(input.bcc?.length ? [`Bcc: ${input.bcc.join(', ')}`] : []),
    `Subject: ${encodeHeader(input.subject)}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: 8bit',
    '',
    input.body,
  ];

  for (const attachment of input.attachments) {
    const stat = await fs.stat(attachment.filePath);
    if (!stat.isFile() || stat.size > MAX_SEND_ATTACHMENT_BYTES) {
      throw new Error('gmail_send_attachment_invalid');
    }
    const filename = attachment.filename || path.basename(attachment.filePath);
    const mimeType = attachment.mimeType || inferMimeType(filename);
    const buffer = await fs.readFile(attachment.filePath);
    lines.push(
      `--${boundary}`,
      `Content-Type: ${mimeType}; name="${encodeHeader(filename)}"`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${encodeHeader(filename)}"`,
      '',
      encodeAttachmentBody(buffer),
    );
  }

  lines.push(`--${boundary}--`, '');
  return toBase64Url(lines.join('\r\n'));
};
