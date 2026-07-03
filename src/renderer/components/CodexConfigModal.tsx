import RefreshRounded from '@mui/icons-material/RefreshRounded';
import CheckCircleRounded from '@mui/icons-material/CheckCircleRounded';
import ExpandMoreRounded from '@mui/icons-material/ExpandMoreRounded';
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  LinearProgress,
  Stack,
  Typography,
} from '@mui/material';
import type { AppDictionary } from '@renderer/i18n';
import type { CodexAuthStatus, CodexRateLimitBucket } from '@shared/types';
import { LlmProviderConnectModal } from './LlmProviderConnectModal';

interface CodexConfigModalProps {
  open: boolean;
  status: CodexAuthStatus;
  busy: boolean;
  t: AppDictionary;
  onClose: () => void;
  onConnect: () => Promise<void>;
  onRefresh: () => Promise<void>;
  onOpenExternalUrl: (url: string) => void;
}

export function CodexConfigModal({
  open,
  status,
  busy,
  t,
  onClose,
  onConnect,
  onRefresh,
  onOpenExternalUrl,
}: CodexConfigModalProps) {
  const usageBucket = status.rateLimits?.primary ?? status.rateLimits?.buckets[0];

  if (!status.authenticated) {
    return (
      <LlmProviderConnectModal
        open={open}
        provider="codex"
        providerName={t.llmProviderConnect.providers.codex.name}
        providerOwner={t.llmProviderConnect.providers.codex.owner}
        authenticated={status.authenticated}
        installed={status.installed}
        busy={busy}
        title={t.llmProviderConnect.providers.codex.title}
        body={t.llmProviderConnect.providers.codex.body}
        steps={t.llmProviderConnect.providers.codex.steps}
        termsUrl="https://openai.com/policies/row-terms-of-use/"
        privacyUrl="https://openai.com/policies/row-privacy-policy/"
        connectLabel={t.settings.codexConnectAction}
        t={t}
        onClose={onClose}
        onConnect={onConnect}
        onOpenExternalUrl={onOpenExternalUrl}
      />
    );
  }

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>{t.codexSetup.title}</DialogTitle>
      <DialogContent>
        <Stack spacing={2}>
          <Stack direction="row" spacing={1} alignItems="center">
            <Chip
              color={status.authenticated ? 'success' : 'default'}
              label={status.authenticated ? t.settings.codexConnected : t.settings.codexDisconnected}
            />
            {status.authenticated ? (
              <Typography variant="body2" color="text.secondary">
                {t.codexSetup.ready}
              </Typography>
            ) : null}
          </Stack>
          <Alert severity="success" icon={<CheckCircleRounded />}>
            <Stack spacing={1}>
              <Typography fontWeight={700}>{t.codexSetup.successTitle}</Typography>
              <Typography variant="body2">{t.codexSetup.successBody}</Typography>
            </Stack>
          </Alert>
          {status.authenticated && usageBucket ? (
            <CodexUsagePanel bucket={usageBucket} t={t} />
          ) : null}
          <Accordion disableGutters>
            <AccordionSummary expandIcon={<ExpandMoreRounded />}>
              <Typography fontWeight={700}>{t.settings.technicalDetails}</Typography>
            </AccordionSummary>
            <AccordionDetails>
              <Box sx={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12 }}>
                <Typography variant="caption" component="div" color="text.secondary">
                  {t.settings.codexCliPathLabel}: {status.codexCliPath ?? '-'}
                </Typography>
                <Typography variant="caption" component="div" color="text.secondary">
                  {t.settings.codexHomeLabel}: {status.codexHome || '-'}
                </Typography>
                <Typography variant="caption" component="div" color="text.secondary">
                  {t.settings.codexAuthFileLabel}: {status.authFilePath || '-'}
                </Typography>
              </Box>
            </AccordionDetails>
          </Accordion>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{t.actions.close}</Button>
        <Button variant="outlined" startIcon={<RefreshRounded />} disabled={busy} onClick={() => void onRefresh()}>
          {t.settings.codexRefreshAction}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

const CodexUsagePanel = ({ bucket, t }: { bucket: CodexRateLimitBucket; t: AppDictionary }) => {
  const usedPercent = Math.round(bucket.primary?.usedPercent ?? 0);
  const remainingPercent = Math.round(bucket.primary?.remainingPercent ?? Math.max(0, 100 - usedPercent));
  const resetLabel = bucket.primary?.resetsAt
    ? t.settings.codexUsageReset(new Date(bucket.primary.resetsAt * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))
    : null;
  const bucketName = bucket.limitName || bucket.limitId;
  return (
    <Alert severity={bucket.rateLimitReachedType ? 'warning' : usedPercent >= 90 ? 'warning' : 'info'}>
      <Stack spacing={1}>
        <Stack direction="row" spacing={1} alignItems="center" justifyContent="space-between">
          <Typography fontWeight={700}>{t.settings.codexUsageTitle}</Typography>
          {bucket.rateLimitReachedType ? <Chip size="small" color="warning" label={t.settings.codexUsageLimitReached} /> : null}
        </Stack>
        <LinearProgress variant="determinate" value={usedPercent} />
        <Stack direction="row" spacing={1} flexWrap="wrap">
          <Chip size="small" label={t.settings.codexUsageUsed(usedPercent)} />
          <Chip size="small" label={t.settings.codexUsageRemaining(remainingPercent)} />
          {bucket.primary?.windowDurationMins ? <Chip size="small" label={t.settings.codexUsageWindow(bucket.primary.windowDurationMins)} /> : null}
          {resetLabel ? <Chip size="small" label={resetLabel} /> : null}
        </Stack>
        <Typography variant="caption" color="text.secondary">
          {t.settings.codexUsageBucket(bucketName)}
        </Typography>
      </Stack>
    </Alert>
  );
};
