import TerminalRounded from '@mui/icons-material/TerminalRounded';
import RefreshRounded from '@mui/icons-material/RefreshRounded';
import CheckCircleRounded from '@mui/icons-material/CheckCircleRounded';
import ExpandMoreRounded from '@mui/icons-material/ExpandMoreRounded';
import { useEffect, useState } from 'react';
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  List,
  ListItem,
  ListItemIcon,
  ListItemText,
  Stack,
  Typography,
} from '@mui/material';
import type { AppDictionary } from '@renderer/i18n';
import type { CodexAuthStatus } from '@shared/types';

interface CodexConfigModalProps {
  open: boolean;
  status: CodexAuthStatus;
  busy: boolean;
  t: AppDictionary;
  onClose: () => void;
  onConnect: () => Promise<void>;
  onRefresh: () => Promise<void>;
}

export function CodexConfigModal({
  open,
  status,
  busy,
  t,
  onClose,
  onConnect,
  onRefresh,
}: CodexConfigModalProps) {
  const [acceptedConditions, setAcceptedConditions] = useState(false);

  useEffect(() => {
    if (!open) {
      setAcceptedConditions(false);
    }
  }, [open]);

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
          {status.authenticated ? (
            <Alert severity="success" icon={<CheckCircleRounded />}>
              <Stack spacing={1}>
                <Typography fontWeight={700}>{t.codexSetup.successTitle}</Typography>
                <Typography variant="body2">{t.codexSetup.successBody}</Typography>
              </Stack>
            </Alert>
          ) : (
            <>
              <Typography color="text.secondary">{t.codexSetup.body}</Typography>
              <Alert severity="warning">
                <Typography variant="body2">{t.codexSetup.quotaDisclaimer}</Typography>
              </Alert>
              <List>
                {t.codexSetup.steps.map((step, index) => (
                  <ListItem key={step} disableGutters>
                    <ListItemIcon>
                      {index === 0 ? <TerminalRounded /> : index === 3 ? <RefreshRounded /> : <CheckCircleRounded />}
                    </ListItemIcon>
                    <ListItemText primary={step} />
                  </ListItem>
                ))}
              </List>
              <Accordion disableGutters>
                <AccordionSummary expandIcon={<ExpandMoreRounded />}>
                  <Typography fontWeight={700}>{t.codexSetup.conditionsTitle}</Typography>
                </AccordionSummary>
                <AccordionDetails>
                  <Stack spacing={1.5}>
                    <Alert severity="warning">
                      <Typography variant="body2">{t.codexSetup.privacy}</Typography>
                    </Alert>
                  </Stack>
                </AccordionDetails>
              </Accordion>
              <FormControlLabel
                control={
                  <Checkbox
                    checked={acceptedConditions}
                    onChange={(event) => setAcceptedConditions(event.target.checked)}
                  />
                }
                label={t.codexSetup.conditionsCheckbox}
              />
            </>
          )}
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
        {!status.authenticated ? (
          <Button
            variant="contained"
            startIcon={<TerminalRounded />}
            disabled={busy || !acceptedConditions}
            onClick={() => void onConnect()}
          >
            {t.settings.codexConnectAction}
          </Button>
        ) : null}
      </DialogActions>
    </Dialog>
  );
}
