import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  Typography,
} from '@mui/material';
import type { AppDictionary } from '@renderer/i18n';

export type PromptPreview = { title: string; description?: string; prompt: string } | null;

interface PromptPreviewDialogProps {
  preview: PromptPreview;
  t: AppDictionary;
  onClose: () => void;
}

export function PromptPreviewDialog({ preview, t, onClose }: PromptPreviewDialogProps) {
  return (
    <Dialog open={preview !== null} onClose={onClose} fullWidth maxWidth="md">
      <DialogTitle>{preview?.title}</DialogTitle>
      <DialogContent>
        <Stack spacing={1.5}>
          {preview?.description ? (
            <Typography color="text.secondary">{preview.description}</Typography>
          ) : null}
          <Typography variant="caption" color="text.secondary">
            {t.appView.promptPreviewLabel}
          </Typography>
          <Box
            component="pre"
            sx={{
              m: 0,
              p: 1.5,
              border: '1px solid',
              borderColor: 'divider',
              bgcolor: 'background.default',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              fontFamily: 'monospace',
              fontSize: 13,
              lineHeight: 1.55,
            }}
          >
            {preview?.prompt}
          </Box>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{t.actions.close}</Button>
      </DialogActions>
    </Dialog>
  );
}
