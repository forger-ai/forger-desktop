import { useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  Dialog,
  DialogContent,
  DialogTitle,
  Stack,
  Tab,
  Tabs,
  Typography,
} from '@mui/material';
import CheckRounded from '@mui/icons-material/CheckRounded';
import CloseRounded from '@mui/icons-material/CloseRounded';
import type { WorkflowNodeRunStatus, WorkflowRun } from '@shared/types';
import type { AppDictionary } from '@renderer/i18n';

type WorkflowCopy = AppDictionary['sections']['workflows'];

const STATUS_COLORS: Record<WorkflowNodeRunStatus, 'default' | 'primary' | 'success' | 'error' | 'warning'> = {
  pending: 'default',
  running: 'primary',
  waiting_approval: 'warning',
  succeeded: 'success',
  failed: 'error',
  skipped: 'default',
  canceled: 'default',
};

const CodeBlock = ({ value, empty }: { value: unknown; empty: string }) => {
  const text = typeof value === 'string'
    ? value
    : value && (typeof value !== 'object' || Object.keys(value).length > 0)
      ? JSON.stringify(value, null, 2)
      : '';
  if (!text.trim()) {
    return <Typography variant="body2" color="text.secondary">{empty}</Typography>;
  }
  return (
    <Box
      component="pre"
      sx={{ m: 0, p: 1.5, bgcolor: 'action.hover', borderRadius: 1, fontSize: 12, overflow: 'auto', maxHeight: 360, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}
    >
      {text}
    </Box>
  );
};

/** Input / Log / Output detail for a single node run, opened from a node badge. */
export function WorkflowRunModal({ open, run, focusNodeId, copy, onClose, onApprove }: {
  open: boolean;
  run: WorkflowRun | null;
  focusNodeId: string | null;
  copy: WorkflowCopy;
  onClose: () => void;
  onApprove?: (nodeId: string, approved: boolean) => void;
}) {
  const [tab, setTab] = useState<'input' | 'log' | 'output'>('input');
  useEffect(() => {
    setTab('input');
  }, [focusNodeId, run?.id]);

  const nodeRun = run?.nodeRuns.find((entry) => entry.nodeId === focusNodeId) ?? null;
  const waiting = run?.status === 'waiting_approval' && run.pendingApprovalNodeId === focusNodeId;
  const logText = [nodeRun?.summary, nodeRun?.error, run?.transcript].filter(Boolean).join('\n\n');

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="md">
      <DialogTitle sx={{ pb: 1 }}>
        <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
          <Typography variant="h6" component="span">{nodeRun?.nodeName ?? copy.runDetail}</Typography>
          {nodeRun ? (
            <Chip size="small" color={STATUS_COLORS[nodeRun.status]} label={copy.statusLabels[nodeRun.status]} />
          ) : null}
        </Stack>
      </DialogTitle>
      <DialogContent dividers>
        {!nodeRun ? (
          <Typography variant="body2" color="text.secondary">{copy.noRuns}</Typography>
        ) : (
          <Stack spacing={1.5}>
            {nodeRun.error ? <Alert severity="error" variant="outlined">{nodeRun.error}</Alert> : null}
            <Tabs value={tab} onChange={(_event, value) => setTab(value as typeof tab)}>
              <Tab value="input" label={copy.input} />
              <Tab value="log" label={copy.log} />
              <Tab value="output" label={copy.output} />
            </Tabs>
            {tab === 'input' ? <CodeBlock value={nodeRun.input} empty={copy.noData} /> : null}
            {tab === 'log' ? <CodeBlock value={logText} empty={copy.noData} /> : null}
            {tab === 'output' ? <CodeBlock value={nodeRun.output} empty={copy.noData} /> : null}
            {waiting && onApprove ? (
              <Stack direction="row" spacing={1}>
                <Button color="success" variant="contained" startIcon={<CheckRounded />} onClick={() => onApprove(nodeRun.nodeId, true)}>
                  {copy.approve}
                </Button>
                <Button color="error" variant="outlined" startIcon={<CloseRounded />} onClick={() => onApprove(nodeRun.nodeId, false)}>
                  {copy.reject}
                </Button>
              </Stack>
            ) : null}
          </Stack>
        )}
      </DialogContent>
    </Dialog>
  );
}
