import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  List,
  ListItem,
  ListItemText,
  Stack,
  Typography,
} from '@mui/material';
import type { WorkflowReviewReport } from '@shared/types';
import type { AppDictionary } from '@renderer/i18n';

type WorkflowCopy = AppDictionary['sections']['workflows'];

const issueText = (issue: unknown): string => {
  if (typeof issue === 'string') return issue;
  if (issue && typeof issue === 'object') {
    const value = issue as { message?: unknown; code?: unknown };
    if (typeof value.message === 'string') return value.message;
    if (typeof value.code === 'string') return value.code;
  }
  return String(issue);
};

export function WorkflowReviewDialog({ open, review, busy, copy, onClose, onApply }: {
  open: boolean;
  review: WorkflowReviewReport | null;
  busy: boolean;
  copy: WorkflowCopy;
  onClose: () => void;
  onApply: () => void;
}) {
  const ready = review?.status === 'ready';
  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} fullWidth maxWidth="sm">
      <DialogTitle>{copy.reviewTitle}</DialogTitle>
      <DialogContent dividers>
        <Stack spacing={2}>
          <Alert severity="info" variant="outlined">{copy.reviewGuarantee}</Alert>
          {review ? (
            <Alert severity={ready ? 'success' : 'warning'}>
              {ready ? copy.reviewReady : copy.reviewNeedsAttention}
            </Alert>
          ) : null}
          {review?.issues.length ? (
            <List dense disablePadding>
              {review.issues.map((issue, index) => (
                <ListItem key={`${index}-${issueText(issue)}`} disableGutters>
                  <ListItemText primary={issueText(issue)} />
                </ListItem>
              ))}
            </List>
          ) : review ? (
            <Typography variant="body2" color="text.secondary">{copy.reviewNoIssues}</Typography>
          ) : null}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>{copy.cancel}</Button>
        <Button variant="contained" onClick={onApply} disabled={busy || !ready}>
          {copy.applyReview}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
