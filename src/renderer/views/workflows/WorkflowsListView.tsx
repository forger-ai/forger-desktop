import { useState } from 'react';
import {
  Button,
  Card,
  CardActionArea,
  CardContent,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  IconButton,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material';
import AddRounded from '@mui/icons-material/AddRounded';
import PlayArrowRounded from '@mui/icons-material/PlayArrowRounded';
import PauseRounded from '@mui/icons-material/PauseRounded';
import DeleteOutlineRounded from '@mui/icons-material/DeleteOutlineRounded';
import type { Workflow } from '@shared/types';
import type { AppDictionary } from '@renderer/i18n';

const formatSchedule = (workflow: Workflow, t: AppDictionary): string => {
  if (workflow.trigger.type !== 'scheduled') {
    return t.sections.workflows.triggerManual;
  }
  return `${t.sections.workflows.triggerScheduled} · ${t.sections.automations.frequencyLabels[workflow.trigger.frequency.type]}`;
};

const hasAppliedSchedule = (workflow: Workflow): boolean =>
  workflow.appliedTrigger?.type === 'scheduled'
  || (workflow.appliedRevision === workflow.revision && workflow.trigger.type === 'scheduled')
  || workflow.enabled;

export function WorkflowsListView({ t, workflows, busy, onCreate, onOpen, onToggleEnabled, onRunNow, onDelete }: {
  t: AppDictionary;
  workflows: Workflow[];
  busy: boolean;
  onCreate: () => void;
  onOpen: (id: string) => void;
  onToggleEnabled: (workflow: Workflow) => void;
  onRunNow: (workflow: Workflow) => void;
  onDelete: (workflow: Workflow) => void;
}) {
  const copy = t.sections.workflows;
  const [pendingDelete, setPendingDelete] = useState<Workflow | null>(null);

  return (
    <Stack spacing={2} data-onboarding-target="workflows-list">
      <Stack direction="row" justifyContent="space-between" alignItems="flex-start" spacing={2}>
        <Stack spacing={0.5}>
          <Typography variant="h4">{copy.title}</Typography>
          <Typography color="text.secondary">{copy.subtitle}</Typography>
        </Stack>
        <Button variant="contained" startIcon={<AddRounded />} data-onboarding-target="workflow-add-step" onClick={onCreate}>
          {copy.newWorkflow}
        </Button>
      </Stack>

      {workflows.length === 0 ? (
        <Card variant="outlined">
          <CardContent>
            <Typography color="text.secondary">{copy.empty}</Typography>
          </CardContent>
        </Card>
      ) : (
        <Stack spacing={1.5}>
          {workflows.map((workflow) => (
            <Card key={workflow.id} variant="outlined">
              <Stack direction="row" alignItems="stretch">
                <CardActionArea onClick={() => onOpen(workflow.id)} sx={{ flex: 1 }}>
                  <CardContent>
                    <Stack spacing={1}>
                      <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
                        <Typography variant="h6" sx={{ wordBreak: 'break-word' }}>{workflow.name}</Typography>
                        {workflow.running ? <CircularProgress size={14} /> : null}
                        <Chip
                          size="small"
                          color={workflow.running
                            ? 'info'
                            : hasAppliedSchedule(workflow)
                              ? workflow.enabled ? 'success' : 'default'
                              : workflow.appliedRevision ? 'success' : 'default'}
                          label={workflow.running
                            ? copy.running
                            : hasAppliedSchedule(workflow)
                              ? workflow.enabled ? copy.active : copy.paused
                              : workflow.appliedRevision ? copy.appliedRevision : copy.draftRevision}
                        />
                        <Chip size="small" variant="outlined" label={formatSchedule(workflow, t)} />
                      </Stack>
                      {workflow.description ? (
                        <Typography variant="body2" color="text.secondary" sx={{ wordBreak: 'break-word' }}>
                          {workflow.description}
                        </Typography>
                      ) : null}
                      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
                        <Typography variant="caption" color="text.secondary">
                          {copy.lastRun}: {workflow.lastRun ? new Date(workflow.lastRun.startedAt).toLocaleString() : '—'}
                        </Typography>
                        <Typography variant="caption" color="text.secondary">
                          {copy.nextRun}: {workflow.nextRunAt ? new Date(workflow.nextRunAt).toLocaleString() : '—'}
                        </Typography>
                      </Stack>
                    </Stack>
                  </CardContent>
                </CardActionArea>
                <Stack direction="row" spacing={0.25} alignItems="center" sx={{ px: 1 }}>
                  <Tooltip title={workflow.appliedRevision ? copy.runApplied : copy.appliedRequired}>
                    <span>
                      <IconButton size="small" disabled={busy || workflow.running || !workflow.appliedRevision} onClick={() => onRunNow(workflow)}>
                        <PlayArrowRounded fontSize="small" />
                      </IconButton>
                    </span>
                  </Tooltip>
                  {hasAppliedSchedule(workflow) ? (
                    <Tooltip title={workflow.enabled ? copy.deactivateSchedule : copy.activateSchedule}>
                      <span>
                        <IconButton size="small" disabled={busy || !workflow.appliedRevision} onClick={() => onToggleEnabled(workflow)}>
                          {workflow.enabled ? <PauseRounded fontSize="small" /> : <PlayArrowRounded fontSize="small" />}
                        </IconButton>
                      </span>
                    </Tooltip>
                  ) : null}
                  <Tooltip title={copy.delete}>
                    <IconButton size="small" color="error" onClick={() => setPendingDelete(workflow)}>
                      <DeleteOutlineRounded fontSize="small" />
                    </IconButton>
                  </Tooltip>
                </Stack>
              </Stack>
            </Card>
          ))}
        </Stack>
      )}

      <Dialog open={Boolean(pendingDelete)} onClose={() => setPendingDelete(null)}>
        <DialogTitle>{copy.delete}</DialogTitle>
        <DialogContent>
          <DialogContentText>
            {pendingDelete ? copy.deleteConfirm(pendingDelete.name) : ''}
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setPendingDelete(null)}>{copy.cancel}</Button>
          <Button
            color="error"
            variant="contained"
            onClick={() => {
              if (pendingDelete) {
                onDelete(pendingDelete);
              }
              setPendingDelete(null);
            }}
          >
            {copy.delete}
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}
