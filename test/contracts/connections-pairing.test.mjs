import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  getWhatsAppPairingPresentation,
} = require('../../dist-electron/shared/connections-pairing.js');

test('WhatsApp pairing presentation exposes QR data URLs for image rendering', () => {
  assert.deepEqual(getWhatsAppPairingPresentation({
    success: true,
    data: {
      status: 'qr_ready',
      qrDataUrl: 'data:image/png;base64,abc',
      expiresAt: '2026-07-06T12:00:00.000Z',
    },
  }), {
    kind: 'qr',
    qrDataUrl: 'data:image/png;base64,abc',
    expiresAt: '2026-07-06T12:00:00.000Z',
  });
});

test('WhatsApp pairing presentation keeps waiting and error states user-facing', () => {
  assert.deepEqual(getWhatsAppPairingPresentation({
    success: true,
    data: { status: 'qr_pending' },
  }), { kind: 'waiting', status: 'qr_pending' });

  assert.deepEqual(getWhatsAppPairingPresentation({
    success: false,
    userMessage: 'No pudimos generar el QR.',
    technicalCode: 'qr_failed',
  }), { kind: 'error', message: 'No pudimos generar el QR.' });
});
