import {
  Alert,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Stack,
  Typography,
} from '@mui/material';
import type { AppSummary, WorkflowAppActionContract } from '@shared/types';
import type { AppDictionary } from '@renderer/i18n';
import type { AppActionContractChangeSummary, PendingAppActionChange } from './app-action-editor';

type WorkflowCopy = AppDictionary['sections']['workflows'];

export function AppActionChangeDialog({
  pending,
  contract,
  contractChanged,
  contractChange,
  apps,
  copy,
  onCancel,
  onApply,
}: {
  pending: PendingAppActionChange | null;
  contract?: WorkflowAppActionContract;
  contractChanged: boolean;
  contractChange: AppActionContractChangeSummary | null;
  apps: AppSummary[];
  copy: WorkflowCopy;
  onCancel: () => void;
  onApply: () => void;
}) {
  const fieldList = (fields: string[]): string => fields.length > 0
    ? fields.join(', ')
    : copy.appActionNoFields;
  const reviewedAction = pending?.kind === 'contract' ? pending.action : null;

  return (
    <Dialog open={pending !== null} onClose={onCancel} maxWidth="sm" fullWidth>
      <DialogTitle>{copy.appActionContractReviewTitle}</DialogTitle>
      <DialogContent>
        <DialogContentText>
          {pending?.kind === 'contract'
            ? (contractChanged ? copy.appActionContractChanged : copy.appActionContractPending)
            : copy.appActionChangeConfirm}
        </DialogContentText>
        {pending ? (
          <Typography variant="body2" fontWeight={700} sx={{ mt: 1.5 }}>
            {pending.kind === 'app'
              ? apps.find((app) => app.id === pending.appId)?.name ?? pending.appId
              : pending.action.title}
          </Typography>
        ) : null}
        {contractChange && reviewedAction ? (
          <Stack spacing={1.25} sx={{ mt: 2 }}>
            <Box>
              <Typography variant="caption" color="text.secondary">
                {contract ? copy.appActionEffectChange : copy.appActionCurrentEffect}
              </Typography>
              <Stack direction="row" spacing={0.75} alignItems="center" flexWrap="wrap" useFlexGap>
                {contract ? (
                  <>
                    <Chip size="small" variant="outlined" label={copy.appActionEffects[contract.effect]} />
                    <Typography aria-hidden="true">→</Typography>
                  </>
                ) : null}
                <Chip size="small" color={contract && contract.effect !== reviewedAction.effect ? 'warning' : 'default'} label={copy.appActionEffects[reviewedAction.effect]} />
              </Stack>
            </Box>
            <Typography variant="body2">
              {copy.appActionInputFields}: {contract ? `${fieldList(contractChange.savedInputFields)} → ` : ''}{fieldList(contractChange.currentInputFields)}
            </Typography>
            <Typography variant="body2">
              {copy.appActionOutputFields}: {contract ? `${fieldList(contractChange.savedOutputFields)} → ` : ''}{fieldList(contractChange.currentOutputFields)}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {copy.appActionValuesKept}: {fieldList(contractChange.keptInputValues)}
            </Typography>
            {contractChange.removedInputValues.length > 0 ? (
              <Alert severity="warning" variant="outlined">
                {copy.appActionValuesRemoved}: {contractChange.removedInputValues.join(', ')}
              </Alert>
            ) : (
              <Typography variant="body2" color="text.secondary">{copy.appActionNoValuesRemoved}</Typography>
            )}
          </Stack>
        ) : null}
      </DialogContent>
      <DialogActions>
        <Button onClick={onCancel}>{copy.cancel}</Button>
        <Button variant="contained" onClick={onApply}>
          {pending?.kind === 'contract' ? copy.appActionAdoptCurrentContract : copy.appActionApplyChange}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
