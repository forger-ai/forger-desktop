import TerminalRounded from '@mui/icons-material/TerminalRounded';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  Link,
  LinearProgress,
  Stack,
  Typography,
} from '@mui/material';
import { useEffect, useState } from 'react';
import type { MouseEvent } from 'react';
import type { AppDictionary } from '@renderer/i18n';

export type LlmProviderConnectKey = 'codex' | 'claude' | 'antigravity';

interface LlmProviderConnectModalProps {
  open: boolean;
  provider: LlmProviderConnectKey;
  providerName: string;
  providerOwner: string;
  authenticated: boolean;
  busy: boolean;
  installed?: boolean;
  title: string;
  body: string;
  steps: readonly string[];
  termsUrl: string;
  privacyUrl: string;
  connectLabel: string;
  t: AppDictionary;
  onClose: () => void;
  onConnect: () => Promise<void>;
  onOpenExternalUrl: (url: string) => void;
}

export function LlmProviderConnectModal({
  open,
  provider,
  providerName,
  providerOwner,
  authenticated,
  busy,
  installed = true,
  title,
  body,
  steps,
  termsUrl,
  privacyUrl,
  connectLabel,
  t,
  onClose,
  onConnect,
  onOpenExternalUrl,
}: LlmProviderConnectModalProps) {
  const [accepted, setAccepted] = useState(false);

  useEffect(() => {
    if (!open) {
      setAccepted(false);
    }
  }, [open, provider]);

  const openExternal = (url: string) => (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    onOpenExternalUrl(url);
  };

  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} maxWidth="sm" fullWidth data-provider={provider}>
      <DialogTitle>{t.llmProviderConnect.title(providerName)}</DialogTitle>
      <DialogContent>
        <Stack spacing={2.25} sx={{ pt: 0.5 }}>
          <Stack direction="row" spacing={1} alignItems="center" useFlexGap flexWrap="wrap">
            <Chip
              color={authenticated ? 'success' : installed ? 'default' : 'warning'}
              label={authenticated ? t.llmProviderConnect.connected : installed ? t.llmProviderConnect.notConnected : t.llmProviderConnect.notInstalled}
            />
            {busy ? (
              <Typography variant="body2" color="text.secondary">{t.llmProviderConnect.connecting(providerName)}</Typography>
            ) : null}
          </Stack>

          <Stack spacing={0.75}>
            <Typography variant="h6" sx={{ lineHeight: 1.2 }}>{title}</Typography>
            <Typography color="text.secondary">{body}</Typography>
          </Stack>

          {busy ? (
            <Alert severity="info">
              <Stack spacing={1}>
                <Typography variant="body2">{t.llmProviderConnect.connecting(providerName)}</Typography>
                <LinearProgress />
              </Stack>
            </Alert>
          ) : null}

          <Stack spacing={1.25}>
            {steps.map((step, index) => (
              <Stack key={step} direction="row" spacing={1.5} alignItems="flex-start">
                <Box
                  sx={{
                    width: 26,
                    height: 26,
                    borderRadius: '50%',
                    bgcolor: 'primary.main',
                    color: 'primary.contrastText',
                    display: 'grid',
                    placeItems: 'center',
                    fontSize: 13,
                    fontWeight: 800,
                    flex: '0 0 auto',
                  }}
                >
                  {index + 1}
                </Box>
                <Typography variant="body2" color="text.primary">{step}</Typography>
              </Stack>
            ))}
          </Stack>

          <Alert severity="warning" variant="outlined">
            <Stack spacing={1}>
              <Typography variant="body2">
                {t.llmProviderConnect.dataNotice(providerName, providerOwner)}
              </Typography>
              <Typography variant="body2">
                {t.llmProviderConnect.policyPrefix(providerOwner)}{' '}
                <Link href={termsUrl} onClick={openExternal(termsUrl)}>
                  {t.llmProviderConnect.termsLink}
                </Link>{' '}
                {t.llmProviderConnect.policyJoiner}{' '}
                <Link href={privacyUrl} onClick={openExternal(privacyUrl)}>
                  {t.llmProviderConnect.privacyLink}
                </Link>
                .
              </Typography>
            </Stack>
          </Alert>

          <FormControlLabel
            sx={{
              alignItems: 'flex-start',
              m: 0,
              '& .MuiCheckbox-root': { p: 0.5, mr: 1 },
              '& .MuiFormControlLabel-label': { lineHeight: 1.35 },
            }}
            control={
              <Checkbox
                checked={accepted}
                onChange={(event) => setAccepted(event.target.checked)}
              />
            }
            label={t.llmProviderConnect.checkbox(providerName)}
          />
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2.5 }}>
        <Button onClick={onClose} disabled={busy}>{t.actions.close}</Button>
        {!authenticated ? (
          <Button
            variant="contained"
            startIcon={busy ? <CircularProgress color="inherit" size={16} /> : <TerminalRounded />}
            disabled={busy || !accepted}
            onClick={() => void onConnect()}
          >
            {connectLabel}
          </Button>
        ) : null}
      </DialogActions>
    </Dialog>
  );
}
