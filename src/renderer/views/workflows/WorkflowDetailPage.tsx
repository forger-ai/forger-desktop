import { useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  IconButton,
  List,
  ListItemButton,
  ListItemText,
  Paper,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material';
import ArrowBackRounded from '@mui/icons-material/ArrowBackRounded';
import EditRounded from '@mui/icons-material/EditRounded';
import PlayArrowRounded from '@mui/icons-material/PlayArrowRounded';
import StopRounded from '@mui/icons-material/StopRounded';
import HistoryRounded from '@mui/icons-material/HistoryRounded';
import CloseRounded from '@mui/icons-material/CloseRounded';
import type {
  Workflow,
  WorkflowNodeRun,
  WorkflowRun,
  WorkflowRunStatus,
  WorkflowRunSummary,
} from '@shared/types';
import type { AppDictionary } from '@renderer/i18n';
import { WorkflowEditor } from './WorkflowEditor';
import { WorkflowParamsForm } from './WorkflowParamsForm';
import { WorkflowRunModal } from './WorkflowRunModal';
import type { WorkflowGraphData } from './WorkflowEditorPage';
import type { WorkflowDraft } from './workflow-draft';

const STATUS_COLORS: Record<WorkflowRunStatus, 'default' | 'primary' | 'success' | 'error' | 'warning' | 'info'> = {
  queued: 'info',
  running: 'primary',
  waiting_approval: 'warning',
  succeeded: 'success',
  failed: 'error',
  skipped: 'default',
  canceled: 'default',
};

export function WorkflowDetailPage({
  t, workflow, draft, onDraftChange, data,
  dirty, busy, banner, onClearBanner, onSave, onDiscard, onBack,
  onRunNow, onToggleEnabled, onRunNode,
  runs, selectedRunId, onSelectRun, selectedRun, onApproveNode, onCancelRun,
}: {
  t: AppDictionary;
  workflow: Workflow;
  draft: WorkflowDraft;
  onDraftChange: (updater: (current: WorkflowDraft) => WorkflowDraft) => void;
  data: WorkflowGraphData;
  dirty: boolean;
  busy: boolean;
  banner: { severity: 'success' | 'error'; message: string } | null;
  onClearBanner: () => void;
  onSave: () => void;
  onDiscard: () => void;
  onBack: () => void;
  onRunNow: () => void;
  onToggleEnabled: () => void;
  onRunNode: (nodeId: string) => void;
  runs: WorkflowRunSummary[];
  selectedRunId: string | null;
  onSelectRun: (runId: string) => void;
  selectedRun: WorkflowRun | null;
  onApproveNode: (nodeId: string, approved: boolean) => void;
  onCancelRun: () => void;
}) {
  const copy = t.sections.workflows;
  const running = workflow.running;
  const [paramsOpen, setParamsOpen] = useState(false);
  const [paramsSnapshot, setParamsSnapshot] = useState<Pick<WorkflowDraft, 'name' | 'description' | 'trigger'> | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [focusNodeId, setFocusNodeId] = useState<string | null>(null);

  const nodeRunsById = useMemo(() => {
    const map: Record<string, WorkflowNodeRun> = {};
    for (const nodeRun of selectedRun?.nodeRuns ?? []) {
      map[nodeRun.nodeId] = nodeRun;
    }
    return map;
  }, [selectedRun]);

  const openParams = () => {
    setParamsSnapshot({ name: draft.name, description: draft.description, trigger: draft.trigger });
    setParamsOpen(true);
  };
  const cancelParams = () => {
    if (paramsSnapshot) {
      onDraftChange((current) => ({ ...current, ...paramsSnapshot }));
    }
    setParamsOpen(false);
  };
  const saveParams = () => {
    onSave();
    setParamsOpen(false);
  };

  return (
    <Stack sx={{ height: '100%', minHeight: 0 }} spacing={1.5}>
      <Stack direction="row" alignItems="center" spacing={1} sx={{ flexShrink: 0 }} flexWrap="wrap" useFlexGap>
        <Tooltip title={copy.back}>
          <IconButton size="small" onClick={onBack}><ArrowBackRounded /></IconButton>
        </Tooltip>
        <Typography variant="h5" sx={{ wordBreak: 'break-word' }}>{workflow.name}</Typography>
        <Tooltip title={copy.editParams}>
          <IconButton size="small" onClick={openParams}><EditRounded fontSize="small" /></IconButton>
        </Tooltip>
        {running ? <Chip size="small" color="info" icon={<CircularProgress size={12} />} label={copy.running} /> : (
          <Chip size="small" color={workflow.enabled ? 'success' : 'default'} label={workflow.enabled ? copy.active : copy.paused} />
        )}
        <Box sx={{ flex: 1 }} />
        <Button size="small" variant="outlined" onClick={onToggleEnabled} disabled={busy}>
          {workflow.enabled ? copy.disable : copy.enable}
        </Button>
        <Button
          size="small"
          variant="outlined"
          startIcon={<PlayArrowRounded />}
          disabled={busy || running}
          onClick={onRunNow}
        >
          {running ? copy.running : copy.runNow}
        </Button>
        <Tooltip title={copy.runsTitle}>
          <IconButton
            size="small"
            color={drawerOpen ? 'primary' : 'default'}
            data-onboarding-target="workflow-run-history"
            onClick={() => setDrawerOpen((open) => !open)}
          >
            <HistoryRounded />
          </IconButton>
        </Tooltip>
      </Stack>

      {banner ? <Alert severity={banner.severity} onClose={onClearBanner} sx={{ flexShrink: 0 }}>{banner.message}</Alert> : null}
      {running ? <Alert severity="info" variant="outlined" sx={{ flexShrink: 0 }}>{copy.lockedWhileRunning}</Alert> : null}
      {dirty && !running ? (
        <Alert
          severity="warning"
          sx={{ flexShrink: 0 }}
          action={(
            <Stack direction="row" spacing={1}>
              <Button size="small" color="inherit" onClick={onDiscard}>{copy.discardChanges}</Button>
              <Button size="small" variant="contained" disabled={busy} onClick={onSave}>{copy.saveChanges}</Button>
            </Stack>
          )}
        >
          {copy.unsavedChanges}
        </Alert>
      ) : null}

      <Box sx={{ flex: 1, minHeight: 0, display: 'flex', gap: 1.5 }}>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <WorkflowEditor
            draft={draft}
            onDraftChange={onDraftChange}
            apps={data.apps}
            agents={data.agents}
            toolPackages={data.toolPackages}
            officialTools={data.officialTools}
            connectionOptions={data.connectionOptions}
            providerOptions={data.providerOptions}
            outputSamples={data.outputSamples}
            savedNodeIds={data.savedNodeIds}
            onRunNode={onRunNode}
            readOnly={running}
            nodeRuns={nodeRunsById}
            onOpenNodeRun={(nodeId) => setFocusNodeId(nodeId)}
            t={t}
          />
        </Box>
        {drawerOpen ? (
          <Paper variant="outlined" sx={{ width: 300, flexShrink: 0, borderRadius: 1, overflow: 'auto', display: 'flex', flexDirection: 'column' }}>
            <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ p: 1.5, pb: 1 }}>
              <Typography variant="subtitle2">{copy.runsTitle}</Typography>
              <IconButton size="small" onClick={() => setDrawerOpen(false)}><CloseRounded fontSize="small" /></IconButton>
            </Stack>
            <Divider />
            {runs.length === 0 ? (
              <Typography variant="body2" color="text.secondary" sx={{ p: 1.5 }}>{copy.noRuns}</Typography>
            ) : (
              <List dense disablePadding>
                {runs.map((run) => (
                  <ListItemButton key={run.id} selected={run.id === selectedRunId} onClick={() => onSelectRun(run.id)}>
                    <ListItemText
                      primary={new Date(run.startedAt).toLocaleString()}
                      secondary={copy.runTriggers[run.trigger]}
                    />
                    <Chip size="small" color={STATUS_COLORS[run.status] ?? 'default'} label={copy.statusLabels[run.status]} />
                  </ListItemButton>
                ))}
              </List>
            )}
          </Paper>
        ) : null}
      </Box>

      {selectedRun && (selectedRun.status === 'running' || selectedRun.status === 'waiting_approval') ? (
        <Stack direction="row" justifyContent="flex-end" sx={{ flexShrink: 0 }}>
          <Button size="small" color="error" variant="outlined" startIcon={<StopRounded />} onClick={onCancelRun}>
            {copy.cancelRun}
          </Button>
        </Stack>
      ) : null}

      <WorkflowRunModal
        open={Boolean(focusNodeId)}
        run={selectedRun}
        focusNodeId={focusNodeId}
        copy={copy}
        onClose={() => setFocusNodeId(null)}
        onApprove={(nodeId, approved) => { onApproveNode(nodeId, approved); setFocusNodeId(null); }}
      />

      <Dialog open={paramsOpen} onClose={cancelParams} fullWidth maxWidth="sm">
        <DialogTitle>{copy.editParams}</DialogTitle>
        <DialogContent dividers>
          <WorkflowParamsForm draft={draft} onChange={onDraftChange} t={t} />
        </DialogContent>
        <DialogActions>
          <Button onClick={cancelParams}>{copy.cancel}</Button>
          <Button variant="contained" disabled={busy} onClick={saveParams}>{copy.save}</Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}
