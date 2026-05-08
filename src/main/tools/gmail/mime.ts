import type { GmailSendInput } from './types';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const normalizeRecipients = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean);
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

export const buildRawEmail = (input: GmailSendInput): string => {
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
