import {
  Button,
  Chip,
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
import type { WorkflowRevisionSummary } from '@shared/types';
import type { AppDictionary } from '@renderer/i18n';

type WorkflowCopy = AppDictionary['sections']['workflows'];

export function WorkflowRevisionsDialog({ open, revisions, busy, copy, onClose, onRestore }: {
  open: boolean;
  revisions: WorkflowRevisionSummary[];
  busy: boolean;
  copy: WorkflowCopy;
  onClose: () => void;
  onRestore: (revision: WorkflowRevisionSummary) => void;
}) {
  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} fullWidth maxWidth="sm">
      <DialogTitle>{copy.revisions}</DialogTitle>
      <DialogContent dividers>
        {revisions.length === 0 ? (
          <Typography variant="body2" color="text.secondary">{copy.noRevisions}</Typography>
        ) : (
          <List disablePadding>
            {revisions.map((revision) => (
              <ListItem
                key={revision.id}
                disableGutters
                divider
                secondaryAction={(
                  <Button size="small" disabled={busy} onClick={() => onRestore(revision)}>
                    {copy.restoreAsDraft}
                  </Button>
                )}
              >
                <ListItemText
                  primary={(
                    <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
                      <Typography variant="body2" fontWeight={600}>{copy.revisionNumber(revision.revision)}</Typography>
                      <Chip
                        size="small"
                        color={revision.applied ? 'success' : 'default'}
                        label={revision.applied ? copy.appliedRevision : copy.draftRevision}
                      />
                    </Stack>
                  )}
                  secondary={new Date(revision.createdAt).toLocaleString()}
                />
              </ListItem>
            ))}
          </List>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>{copy.cancel}</Button>
      </DialogActions>
    </Dialog>
  );
}
