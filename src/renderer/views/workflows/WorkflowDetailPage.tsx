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
import CloseRounded from '@mui/icons-material/CloseRounded';
import EditRounded from '@mui/icons-material/EditRounded';
import HistoryRounded from '@mui/icons-material/HistoryRounded';
import PlayArrowRounded from '@mui/icons-material/PlayArrowRounded';
import RestoreRounded from '@mui/icons-material/RestoreRounded';
import StopRounded from '@mui/icons-material/StopRounded';
import type {
  Workflow,
  WorkflowNodeRun,
  WorkflowReviewReport,
  WorkflowRevisionSummary,
  WorkflowRun,
  WorkflowRunStatus,
  WorkflowRunSummary,
} from '@shared/types';
import type { AppDictionary } from '@renderer/i18n';
import { WorkflowEditor } from './WorkflowEditor';
import { WorkflowParamsForm } from './WorkflowParamsForm';
import { WorkflowRunModal } from './WorkflowRunModal';
import { WorkflowReviewDialog } from './WorkflowReviewDialog';
import { WorkflowRevisionsDialog } from './WorkflowRevisionsDialog';
import type { WorkflowGraphData } from './WorkflowEditorPage';
import type { WorkflowDraft } from './workflow-draft';

const STATUS_COLORS: Record<WorkflowRunStatus, 'default' | 'primary' | 'success' | 'error' | 'warning' | 'info'> = {
  queued: 'info',
  running: 'primary',
  waiting_approval: 'warning',
  succeeded: 'success',
  completed_with_issues: 'warning',
  failed: 'error',
  skipped: 'default',
  canceled: 'default',
};

export function WorkflowDetailPage({
  t, workflow, draft, onDraftChange, data,
  dirty, busy, banner, onClearBanner, onSave, onDiscard, onBack,
  onRunNow, onToggleEnabled, onReview, review, reviewOpen, onCloseReview, onApplyReview,
  revisions, onReloadRevisions, onRestoreRevision, onRunNode,
  runs, selectedRunId, onSelectRun, selectedRun, onApproveNode, onCancelRun, onRetryRun,
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
  onReview: () => void;
  review: WorkflowReviewReport | null;
  reviewOpen: boolean;
  onCloseReview: () => void;
  onApplyReview: () => void;
  revisions: WorkflowRevisionSummary[];
  onReloadRevisions: () => void;
  onRestoreRevision: (revision: WorkflowRevisionSummary) => void;
  onRunNode: (nodeId: string) => void;
  runs: WorkflowRunSummary[];
  selectedRunId: string | null;
  onSelectRun: (runId: string) => void;
  selectedRun: WorkflowRun | null;
  onApproveNode: (nodeId: string, approved: boolean) => void;
  onCancelRun: () => void;
  onRetryRun: (runId: string) => void;
}) {
  const copy = t.sections.workflows;
  const running = workflow.running;
  const [paramsOpen, setParamsOpen] = useState(false);
  const [paramsSnapshot, setParamsSnapshot] = useState<Pick<WorkflowDraft, 'name' | 'description' | 'trigger'> | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [revisionsOpen, setRevisionsOpen] = useState(false);
  const [restoreRevision, setRestoreRevision] = useState<WorkflowRevisionSummary | null>(null);
  const [confirmNewRun, setConfirmNewRun] = useState(false);
  const [focusNodeId, setFocusNodeId] = useState<string | null>(null);
  const pendingApprovalRun = selectedRun?.status === 'waiting_approval'
    ? selectedRun
    : runs.find((run) => run.status === 'waiting_approval');
  const pendingApprovalNodeId = pendingApprovalRun?.pendingApprovalNodeId;
  const applied = Boolean(workflow.appliedRevision);
  const appliedScheduled = workflow.appliedTrigger?.type === 'scheduled'
    || (workflow.appliedRevision === workflow.revision && workflow.trigger.type === 'scheduled')
    || workflow.enabled;

  const nodeRunsById = useMemo(() => {
    const map: Record<string, WorkflowNodeRun> = {};
    for (const nodeRun of selectedRun?.nodeRuns ?? []) map[nodeRun.nodeId] = nodeRun;
    return map;
  }, [selectedRun]);

  const openParams = () => {
    setParamsSnapshot({ name: draft.name, description: draft.description, trigger: draft.trigger });
    setParamsOpen(true);
  };
  const cancelParams = () => {
    if (paramsSnapshot) onDraftChange((current) => ({ ...current, ...paramsSnapshot }));
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
          <Chip
            size="small"
            color={appliedScheduled
              ? workflow.enabled ? 'success' : 'default'
              : applied ? 'success' : 'default'}
            label={appliedScheduled
              ? workflow.enabled ? copy.active : copy.paused
              : applied ? copy.appliedRevision : copy.draftRevision}
          />
        )}
        {pendingApprovalNodeId ? (
          <Chip
            size="small"
            color="warning"
            label={copy.pendingApproval}
            onClick={() => {
              if (pendingApprovalRun && pendingApprovalRun.id !== selectedRunId) onSelectRun(pendingApprovalRun.id);
              setFocusNodeId(pendingApprovalNodeId);
            }}
          />
        ) : null}
        <Box sx={{ flex: 1 }} />
        {appliedScheduled ? (
          <Button size="small" variant="outlined" onClick={onToggleEnabled} disabled={busy || !applied}>
            {workflow.enabled ? copy.deactivateSchedule : copy.activateSchedule}
          </Button>
        ) : null}
        <Button size="small" variant="outlined" disabled={busy || dirty || running} onClick={onReview}>
          {copy.review}
        </Button>
        <Button
          size="small"
          variant="outlined"
          disabled={busy || dirty || running || review?.status !== 'ready' || workflow.appliedRevision === workflow.revision}
          onClick={onApplyReview}
        >
          {copy.applyReview}
        </Button>
        <Button
          size="small"
          variant="outlined"
          startIcon={<PlayArrowRounded />}
          disabled={busy || running || !applied}
          onClick={onRunNow}
        >
          {running ? copy.running : copy.runApplied}
        </Button>
        <Tooltip title={copy.revisions}>
          <IconButton size="small" onClick={() => { setRevisionsOpen(true); onReloadRevisions(); }}>
            <RestoreRounded />
          </IconButton>
        </Tooltip>
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
              <Button size="small" variant="contained" disabled={busy} onClick={onSave}>{copy.saveDraft}</Button>
            </Stack>
          )}
        >
          {copy.unsavedChanges}
        </Alert>
      ) : null}
      {selectedRun?.status === 'failed' ? (
        <Alert
          severity={selectedRun.safeToRetry ? 'info' : 'warning'}
          sx={{ flexShrink: 0 }}
          action={selectedRun.safeToRetry ? (
            <Button color="inherit" size="small" disabled={busy} onClick={() => onRetryRun(selectedRun.id)}>
              {copy.retryRun}
            </Button>
          ) : (
            <Button color="inherit" size="small" disabled={busy || !applied} onClick={() => setConfirmNewRun(true)}>
              {copy.startNewRun}
            </Button>
          )}
        >
          {selectedRun.safeToRetry ? copy.retryRun : copy.newRunEffectsWarning}
        </Alert>
      ) : null}

      <Box sx={{ flex: 1, minHeight: 0, display: 'flex', gap: 1.5 }}>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <WorkflowEditor
            draft={draft}
            onDraftChange={onDraftChange}
            apps={data.apps}
            appActions={data.appActions}
            loadingAppActionAppIds={data.loadingAppActionAppIds}
            loadedAppActionAppIds={data.loadedAppActionAppIds}
            onRequestAppActions={data.onRequestAppActions}
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

      <WorkflowReviewDialog
        open={reviewOpen}
        review={review}
        busy={busy}
        copy={copy}
        onClose={onCloseReview}
        onApply={onApplyReview}
      />

      <WorkflowRevisionsDialog
        open={revisionsOpen}
        revisions={revisions}
        busy={busy}
        copy={copy}
        onClose={() => setRevisionsOpen(false)}
        onRestore={(revision) => setRestoreRevision(revision)}
      />

      <Dialog open={Boolean(restoreRevision)} onClose={busy ? undefined : () => setRestoreRevision(null)} maxWidth="xs" fullWidth>
        <DialogTitle>{copy.restoreRevisionTitle}</DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary">{copy.restoreRevisionWarning}</Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setRestoreRevision(null)} disabled={busy}>{copy.cancel}</Button>
          <Button
            variant="contained"
            disabled={busy}
            onClick={() => {
              if (restoreRevision) onRestoreRevision(restoreRevision);
              setRestoreRevision(null);
              setRevisionsOpen(false);
            }}
          >
            {copy.restoreAsDraft}
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={confirmNewRun} onClose={() => setConfirmNewRun(false)} maxWidth="xs" fullWidth>
        <DialogTitle>{copy.startNewRun}</DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary">{copy.newRunEffectsWarning}</Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmNewRun(false)}>{copy.cancel}</Button>
          <Button color="warning" variant="contained" onClick={() => { setConfirmNewRun(false); onRunNow(); }}>
            {copy.startNewRun}
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={paramsOpen} onClose={cancelParams} fullWidth maxWidth="sm">
        <DialogTitle>{copy.editParams}</DialogTitle>
        <DialogContent dividers>
          <WorkflowParamsForm draft={draft} onChange={onDraftChange} t={t} />
        </DialogContent>
        <DialogActions>
          <Button onClick={cancelParams}>{copy.cancel}</Button>
          <Button variant="contained" disabled={busy} onClick={saveParams}>{copy.saveDraft}</Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}
