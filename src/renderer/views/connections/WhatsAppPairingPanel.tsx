import { Alert, Box, Button, Stack, Typography } from '@mui/material';
import type { WhatsAppPairingPresentation } from '@shared/connections-pairing';

export function WhatsAppPairingPanel({ presentation, waitingLabel, resultLabel, locale, busy, onRetry }: {
  presentation: WhatsAppPairingPresentation;
  waitingLabel: string;
  resultLabel: string;
  locale: string;
  busy: boolean;
  onRetry: () => void;
}) {
  const spanish = locale.startsWith('es');
  const retry = spanish ? 'Generar un nuevo QR' : 'Generate a new QR';
  if (presentation.kind === 'error' || presentation.kind === 'expired') {
    return <Alert severity={presentation.kind === 'error' ? 'error' : 'warning'} action={
      <Button color="inherit" disabled={busy} onClick={onRetry}>{retry}</Button>
    }>{presentation.kind === 'error' ? presentation.message : spanish
      ? 'Este QR venció. Genera uno nuevo para vincular WhatsApp.'
      : 'This QR expired. Generate a new one to link WhatsApp.'}</Alert>;
  }
  if (presentation.kind === 'qr') return <Stack spacing={1} alignItems="center">
    <Typography variant="body2" color="text.secondary">{waitingLabel}</Typography>
    <Box component="img" src={presentation.qrDataUrl} alt={resultLabel} sx={{
      width: 360, height: 360, maxWidth: '100%', objectFit: 'contain', bgcolor: '#fff', imageRendering: 'pixelated',
    }} />
    <Typography variant="caption" color="text.secondary">{spanish
      ? 'WhatsApp → Dispositivos vinculados → Vincular un dispositivo. El QR se actualiza automáticamente.'
      : 'WhatsApp → Linked devices → Link a device. The QR updates automatically.'}</Typography>
  </Stack>;
  if (presentation.kind === 'pairing_code') return <Alert severity="info">{resultLabel}: <strong>{presentation.pairingCode}</strong></Alert>;
  if (presentation.kind === 'waiting') return <Alert severity="info" variant="outlined">{waitingLabel}</Alert>;
  return null;
}
