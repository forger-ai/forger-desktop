import CheckCircleRounded from '@mui/icons-material/CheckCircleRounded';
import ContentCopyRounded from '@mui/icons-material/ContentCopyRounded';
import StopCircleRounded from '@mui/icons-material/StopCircleRounded';
import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import QRCode from 'qrcode';
import { useEffect, useState } from 'react';
import type { LocalNetworkShareStatus } from '@shared/types';
import type { AppDictionary } from '@renderer/i18n';

interface LocalNetworkShareDialogProps {
  appName: string;
  open: boolean;
  status: LocalNetworkShareStatus | null;
  t: AppDictionary;
  onClose: () => void;
  onStop: () => void;
  onCopied: () => void;
}

export function LocalNetworkShareDialog({
  appName,
  open,
  status,
  t,
  onClose,
  onStop,
  onCopied,
}: LocalNetworkShareDialogProps) {
  const [qrDataUrl, setQrDataUrl] = useState<string>('');
  const connected = Boolean(status?.connectedAt);
  const link = status?.connectUrl ?? status?.url ?? '';

  useEffect(() => {
    let canceled = false;
    if (!open || !link) {
      setQrDataUrl('');
      return;
    }
    void QRCode.toDataURL(link, { margin: 1, width: 224 }).then((value) => {
      if (!canceled) setQrDataUrl(value);
    });
    return () => {
      canceled = true;
    };
  }, [link, open]);

  const copyLink = async () => {
    await navigator.clipboard.writeText(link);
    onCopied();
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle>{t.localNetwork.title(appName)}</DialogTitle>
      <DialogContent>
        <Stack spacing={2.25} alignItems="stretch">
          {connected ? (
            <Alert severity="success" icon={<CheckCircleRounded fontSize="inherit" />}>
              {t.localNetwork.connectedBody}
            </Alert>
          ) : (
            <>
              <Typography color="text.secondary">{t.localNetwork.waitingBody}</Typography>
              {qrDataUrl ? (
                <Box
                  component="img"
                  src={qrDataUrl}
                  alt={t.localNetwork.menuAction}
                  sx={{ width: 224, height: 224, alignSelf: 'center', borderRadius: 1, border: '1px solid', borderColor: 'divider' }}
                />
              ) : null}
              <TextField value={link} size="small" fullWidth slotProps={{ input: { readOnly: true } }} />
            </>
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{t.localNetwork.close}</Button>
        <Button startIcon={<ContentCopyRounded />} onClick={() => void copyLink()} disabled={!link || connected}>
          {t.localNetwork.copyLink}
        </Button>
        <Button color="warning" startIcon={<StopCircleRounded />} onClick={onStop}>
          {t.localNetwork.stop}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
