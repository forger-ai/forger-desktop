import type { CallConnectionActionResult } from './types/connections';

export type WhatsAppPairingPresentation =
  | { kind: 'idle' }
  | { kind: 'qr'; qrDataUrl: string; expiresAt?: string }
  | { kind: 'pairing_code'; pairingCode: string; expiresAt?: string }
  | { kind: 'waiting'; status?: string }
  | { kind: 'error'; message: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const cleanString = (value: unknown): string =>
  typeof value === 'string' ? value.trim() : '';

export const getWhatsAppPairingPresentation = (
  result: CallConnectionActionResult | null | undefined,
): WhatsAppPairingPresentation => {
  if (!result) {
    return { kind: 'idle' };
  }
  if (!result.success) {
    return {
      kind: 'error',
      message: cleanString(result.userMessage) || cleanString(result.technicalCode) || 'whatsapp_pairing_failed',
    };
  }

  const data = isRecord(result.data) ? result.data : {};
  const qrDataUrl = cleanString(data.qrDataUrl);
  if (qrDataUrl) {
    return {
      kind: 'qr',
      qrDataUrl,
      ...(cleanString(data.expiresAt) ? { expiresAt: cleanString(data.expiresAt) } : {}),
    };
  }

  const pairingCode = cleanString(data.pairingCode);
  if (pairingCode) {
    return {
      kind: 'pairing_code',
      pairingCode,
      ...(cleanString(data.expiresAt) ? { expiresAt: cleanString(data.expiresAt) } : {}),
    };
  }

  return {
    kind: 'waiting',
    ...(cleanString(data.status) ? { status: cleanString(data.status) } : {}),
  };
};
