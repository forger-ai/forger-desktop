import { activityReason } from './activityReason';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Box, Button, Chip, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle, Paper, Stack, Typography } from '@mui/material';
import type { WhatsAppAgentActivityItem, WhatsAppAgentBindingKey } from '@shared/types';
import type { ChannelCopy } from './copy';

export function ActivityDialog({ binding, c, onClose, onOpenConversation }: { binding: WhatsAppAgentBindingKey; c: ChannelCopy; onClose: () => void; onOpenConversation?: (id: string) => void }) {
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const [items, setItems] = useState<WhatsAppAgentActivityItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => {
    setLoading(true);
    try { const result = await window.forger.personalAgentWhatsAppActivityList(binding); if (active.current) { setItems(result); setError(''); } }
    catch { if (active.current) setError(c.activityFailed); } finally { if (active.current) setLoading(false); }
  }, [binding, c.activityFailed]);
  useEffect(() => { void refresh(); const timer = window.setInterval(() => void refresh(), 5000); return () => window.clearInterval(timer); }, [refresh]);
  const action = async (item: WhatsAppAgentActivityItem, kind: 'cancel' | 'retry' | 'dismiss') => {
    setBusy(true);
    try {
      const input = { ...binding, requestId: item.requestId };
      if (kind === 'cancel') await window.forger.personalAgentWhatsAppRequestCancel(input);
      else if (kind === 'retry') await window.forger.personalAgentWhatsAppDeliveryRetry(input);
      else await window.forger.personalAgentWhatsAppRequestDismiss(input);
      await refresh();
    } catch { setError(c.actionFailed); } finally { setBusy(false); }
  };
  const es = c.close === 'Cerrar';
  const statusLabels = es
    ? { queued: 'En cola', active: 'Trabajando', waiting_approval: 'Esperando aprobación', completed: 'Completada', failed: 'Falló', canceled: 'Cancelada', interrupted: 'Interrumpida', dismissed: 'Descartada', pending: 'Pendiente', sending: 'Enviando', sent: 'Enviada', unknown: 'Sin confirmar' }
    : { queued: 'Queued', active: 'Working', waiting_approval: 'Waiting for approval', completed: 'Completed', failed: 'Failed', canceled: 'Canceled', interrupted: 'Interrupted', dismissed: 'Dismissed', pending: 'Pending', sending: 'Sending', sent: 'Sent', unknown: 'Unconfirmed' };
  return <Dialog open onClose={onClose} fullWidth maxWidth="md">
    <DialogTitle>{c.activity}</DialogTitle>
    <DialogContent><Stack spacing={2}>
      {loading ? <CircularProgress size={20} aria-label={c.activity} /> : null}
      {error ? <Alert severity="error" action={<Button onClick={() => void refresh()}>{c.retry}</Button>}>{error}</Alert> : null}
      {!loading && !items.length ? <Typography>{c.emptyActivity}</Typography> : null}
      {items.map((item) => <Paper key={item.requestId} variant="outlined" sx={{ p: 2 }}><Stack spacing={1}>
        <Typography variant="caption">{item.requestId}</Typography>
        <Stack direction="row" spacing={1}><Chip size="small" label={`${c.execution}: ${statusLabels[item.status]}`} />{item.deliveryState ? <Chip size="small" label={`${c.delivery}: ${statusLabels[item.deliveryState]}`} /> : null}</Stack>
        <Typography variant="caption">{es ? 'Recibida' : 'Received'}: {new Date(item.createdAt).toLocaleString()} · {es ? 'Actualizada' : 'Updated'}: {new Date(item.updatedAt).toLocaleString()}</Typography>
        <Typography variant="subtitle2">{c.request}</Typography><Typography sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{item.requestText}</Typography>
        {item.responseText ? <Box><Typography variant="subtitle2">{c.reply}</Typography><Typography sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{item.responseText}</Typography></Box> : null}
        {item.reason ? <Alert severity="warning">{activityReason(item.reason, es)}</Alert> : null}
        {item.deliveryState === 'unknown' ? <Alert severity="warning">{c.unknownHelp}</Alert> : null}
        <Stack direction="row" spacing={1} flexWrap="wrap">
          {['queued', 'active', 'waiting_approval'].includes(item.status) ? <Button disabled={busy} onClick={() => void action(item, 'cancel')}>{c.cancelRequest}</Button> : null}
          {item.canRetryDelivery && item.deliveryState === 'failed' ? <Button disabled={busy} onClick={() => void action(item, 'retry')}>{c.retryDelivery}</Button> : null}
          {item.status !== 'dismissed' && (item.status === 'interrupted' || item.deliveryState === 'unknown') ? <Button disabled={busy} onClick={() => void action(item, 'dismiss')}>{c.dismiss}</Button> : null}
          {item.conversationId && onOpenConversation ? <Button onClick={() => onOpenConversation(item.conversationId!)}>{c.history}</Button> : null}
        </Stack>
      </Stack></Paper>)}
      <Typography variant="caption">{c.cancelHelp}</Typography>
    </Stack></DialogContent>
    <DialogActions><Button onClick={onClose}>{c.close}</Button></DialogActions>
  </Dialog>;
}
