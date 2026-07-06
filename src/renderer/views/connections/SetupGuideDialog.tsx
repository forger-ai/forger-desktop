import { Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, Divider, IconButton, Paper, Stack, Tooltip, Typography } from '@mui/material';
import ContentCopyRounded from '@mui/icons-material/ContentCopyRounded';
import OpenInNewRounded from '@mui/icons-material/OpenInNewRounded';
import type { ConnectionSetupGuide } from '@shared/types';
import { getSetupGuideUiCopy } from './setupGuideUiCopy';

export function SetupGuideDialog({
  guide,
  locale,
  onClose,
  onCopy,
  onOpenExternalUrl,
  open,
}: {
  guide: ConnectionSetupGuide | null;
  locale?: string;
  onClose: () => void;
  onCopy: (value: string) => void;
  onOpenExternalUrl: (url: string) => void;
  open: boolean;
}) {
  const copy = getSetupGuideUiCopy(locale);
  if (!guide) return null;
  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>{guide.title}</DialogTitle>
      <DialogContent dividers>
        <Stack spacing={2}>
          <Typography color="text.secondary">{guide.summary}</Typography>
          {guide.portal ? (
            <Button
              startIcon={<OpenInNewRounded />}
              sx={{ alignSelf: 'flex-start' }}
              variant="outlined"
              onClick={() => onOpenExternalUrl(guide.portal?.url ?? '')}
            >
              {copy.openProvider}: {guide.portal.label}
            </Button>
          ) : null}
          {guide.copyValues?.length ? (
            <Stack spacing={1}>
              <Typography variant="subtitle2">{copy.values}</Typography>
              {guide.copyValues.map((value, index) => (
                <Paper key={`${value.kind}-${index}-${value.value}`} variant="outlined" sx={{ p: 1, pr: 0.5 }}>
                  <Stack direction="row" spacing={1} alignItems="center">
                    <Box sx={{ minWidth: 0, flex: 1 }}>
                      <Typography variant="caption" color="text.secondary">{value.label}</Typography>
                      <Typography variant="body2" sx={{ fontFamily: 'monospace', overflowWrap: 'anywhere' }}>
                        {value.value}
                      </Typography>
                    </Box>
                    <Tooltip title={copy.copy}>
                      <IconButton aria-label={copy.copy} onClick={() => onCopy(value.value)}>
                        <ContentCopyRounded fontSize="small" />
                      </IconButton>
                    </Tooltip>
                  </Stack>
                </Paper>
              ))}
            </Stack>
          ) : null}
          <Divider />
          <Stack spacing={1}>
            <Typography variant="subtitle2">{copy.steps}</Typography>
            <Box component="ol" sx={{ m: 0, pl: 2.5 }}>
              {guide.steps.map((step) => (
                <Typography key={step} component="li" variant="body2" sx={{ mb: 0.75 }}>{step}</Typography>
              ))}
            </Box>
          </Stack>
          {guide.notes?.length ? (
            <Stack spacing={0.5}>
              <Typography variant="subtitle2">{copy.notes}</Typography>
              {guide.notes.map((note) => <Typography key={note} variant="body2" color="text.secondary">{note}</Typography>)}
            </Stack>
          ) : null}
          {guide.commonErrors?.length ? (
            <Stack spacing={0.5}>
              <Typography variant="subtitle2">{copy.commonErrors}</Typography>
              {guide.commonErrors.map((note) => <Typography key={note} variant="body2" color="text.secondary">{note}</Typography>)}
            </Stack>
          ) : null}
        </Stack>
      </DialogContent>
      <DialogActions><Button onClick={onClose}>{copy.close}</Button></DialogActions>
    </Dialog>
  );
}
