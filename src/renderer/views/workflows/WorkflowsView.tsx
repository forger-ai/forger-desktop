import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Divider,
  List,
  ListItemButton,
  ListItemText,
  MenuItem,
  Paper,
  Stack,
  Switch,
  Tab,
  Tabs,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import AddRounded from '@mui/icons-material/AddRounded';
import PlayArrowRounded from '@mui/icons-material/PlayArrowRounded';
import StopRounded from '@mui/icons-material/StopRounded';
import DeleteOutlineRounded from '@mui/icons-material/DeleteOutlineRounded';
import CheckRounded from '@mui/icons-material/CheckRounded';
import CloseRounded from '@mui/icons-material/CloseRounded';
import type {
  AgentToolPackageDefinition,
  AppSummary,
  OfficialToolSummary,
  PersonalAgent,
  Workflow,
  WorkflowNodeRun,
  WorkflowRun,
  WorkflowRunSummary,
} from '@shared/types';
import type { AppDictionary } from '@renderer/i18n';
import { WorkflowEditor } from './WorkflowEditor';
import {
  draftFromWorkflow,
  draftToUpsertInput,
  emptyDraft,
  type WorkflowDraft,
} from './workflow-draft';

const getDesktopApi = () => {
  const desktopApi = window.forger;
  if (!desktopApi) {
    throw new Error('forger_bridge_unavailable');
  }
  return desktopApi;
};

const STATUS_COLORS: Record<string, 'default' | 'primary' | 'success' | 'error' | 'warning' | 'info'> = {
  pending: 'default',
  queued: 'info',
  running: 'primary',
  waiting_approval: 'warning',
  succeeded: 'success',
  failed: 'error',
  skipped: 'default',
  canceled: 'default',
};

export function WorkflowsView({ t }: { t: AppDictionary }) {
  const copy = t.sections.workflows;
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<WorkflowDraft | null>(null);
  const [tab, setTab] = useState<'editor' | 'runs'>('editor');
  const [runs, setRuns] = useState<WorkflowRunSummary[]>([]);
  const [selectedRun, setSelectedRun] = useState<WorkflowRun | null>(null);
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState<{ severity: 'success' | 'error'; message: string } | null>(null);
  const [apps, setApps] = useState<AppSummary[]>([]);
  const [agents, setAgents] = useState<PersonalAgent[]>([]);
  const [toolPackages, setToolPackages] = useState<AgentToolPackageDefinition[]>([]);
  const [officialTools, setOfficialTools] = useState<OfficialToolSummary[]>([]);
  const selectedIdRef = useRef<string | null>(null);
  selectedIdRef.current = selectedId;

  const selectedWorkflow = workflows.find((workflow) => workflow.id === selectedId) ?? null;

  const loadRuns = useCallback(async (workflowId: string, preferredRunId?: string) => {
    const desktopApi = getDesktopApi();
    const nextRuns = await desktopApi.workflowsListRuns(workflowId);
    setRuns(nextRuns);
    const targetRunId = preferredRunId ?? nextRuns[0]?.id;
    setSelectedRun(targetRunId ? await desktopApi.workflowsGetRun(targetRunId) : null);
  }, []);

  const refreshWorkflows = useCallback(async () => {
    const nextWorkflows = await getDesktopApi().workflowsList();
    setWorkflows(nextWorkflows);
    return nextWorkflows;
  }, []);

  useEffect(() => {
    const desktopApi = getDesktopApi();
    void refreshWorkflows().then((list) => {
      if (list[0]) {
        setSelectedId(list[0].id);
        setDraft(draftFromWorkflow(list[0]));
        void loadRuns(list[0].id);
      }
    }).catch(() => undefined);
    void desktopApi.listInstalledApps().then(setApps).catch(() => undefined);
    void desktopApi.personalAgentsList().then(setAgents).catch(() => undefined);
    void desktopApi.listAgentTools(t.locale).then(setToolPackages).catch(() => undefined);
    void desktopApi.listOfficialTools(t.locale).then((state) => setOfficialTools(state.tools)).catch(() => undefined);
    const unsubscribe = desktopApi.onWorkflowUpdated(({ workflow, run }) => {
      setWorkflows((current) => {
        const withoutCurrent = current.filter((item) => item.id !== workflow.id);
        return [workflow, ...withoutCurrent].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
      });
      if (selectedIdRef.current === workflow.id && run) {
        setRuns((current) => {
          const withoutCurrent = current.filter((item) => item.id !== run.id);
          return [run, ...withoutCurrent].sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
        });
        setSelectedRun((current) => (!current || current.id === run.id
          ? { transcript: current?.transcript ?? '', ...run }
          : current));
      }
    });
    return unsubscribe;
  }, []);

  const selectWorkflow = (workflow: Workflow) => {
    setSelectedId(workflow.id);
    setDraft(draftFromWorkflow(workflow));
    setBanner(null);
    void loadRuns(workflow.id);
  };

  const startNewWorkflow = () => {
    setSelectedId(null);
    setDraft(emptyDraft());
    setRuns([]);
    setSelectedRun(null);
    setTab('editor');
    setBanner(null);
  };

  const saveDraft = async () => {
    if (!draft) {
      return;
    }
    if (!draft.name.trim()) {
      setBanner({ severity: 'error', message: copy.nameRequired });
      return;
    }
    if (draft.nodes.length === 0) {
      setBanner({ severity: 'error', message: copy.nodesRequired });
      return;
    }
    setBusy(true);
    try {
      const saved = await getDesktopApi().workflowsUpsert(draftToUpsertInput(draft));
      await refreshWorkflows();
      setSelectedId(saved.id);
      setDraft(draftFromWorkflow(saved));
      setBanner({ severity: 'success', message: copy.saved });
    } catch (error) {
      const technicalCode = error instanceof Error ? error.message : '';
      setBanner({
        severity: 'error',
        message: technicalCode.includes('workflow_graph_has_cycle') ? copy.graphInvalid : copy.saveError,
      });
    } finally {
      setBusy(false);
    }
  };

  const runNow = async () => {
    if (!selectedWorkflow) {
      return;
    }
    setBusy(true);
    try {
      const run = await getDesktopApi().workflowsRunNow(selectedWorkflow.id);
      setTab('runs');
      await loadRuns(selectedWorkflow.id, run.id);
    } finally {
      setBusy(false);
    }
  };

  const toggleEnabled = async (workflow: Workflow) => {
    const updated = await getDesktopApi().workflowsSetEnabled(workflow.id, !workflow.enabled);
    setWorkflows((current) => current.map((item) => (item.id === updated.id ? updated : item)));
    if (draft?.id === updated.id) {
      setDraft((current) => (current ? { ...current, enabled: updated.enabled } : current));
    }
  };

  const deleteWorkflow = async (workflow: Workflow) => {
    if (!window.confirm(copy.deleteConfirm(workflow.name))) {
      return;
    }
    await getDesktopApi().workflowsDelete(workflow.id);
    const remaining = await refreshWorkflows();
    if (selectedId === workflow.id) {
      if (remaining[0]) {
        selectWorkflow(remaining[0]);
      } else {
        startNewWorkflow();
      }
    }
  };

  const approveNode = async (run: WorkflowRunSummary, nodeId: string, approved: boolean) => {
    await getDesktopApi().workflowsApproveNode({ runId: run.id, nodeId, approved });
    if (selectedWorkflow) {
      await loadRuns(selectedWorkflow.id, run.id);
    }
  };

  const cancelRun = async (run: WorkflowRunSummary) => {
    await getDesktopApi().workflowsCancelRun(run.id);
    if (selectedWorkflow) {
      await loadRuns(selectedWorkflow.id, run.id);
    }
  };

  return (
    <Stack spacing={2}>
      <Stack direction="row" justifyContent="space-between" alignItems="flex-start" flexWrap="wrap" useFlexGap spacing={1}>
        <Stack spacing={0.5}>
          <Typography variant="h4">{copy.title}</Typography>
          <Typography color="text.secondary">{copy.subtitle}</Typography>
        </Stack>
        <Button variant="contained" startIcon={<AddRounded />} onClick={startNewWorkflow}>
          {copy.newWorkflow}
        </Button>
      </Stack>
      {banner ? <Alert severity={banner.severity} onClose={() => setBanner(null)}>{banner.message}</Alert> : null}
      <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.5} alignItems="stretch">
        <Paper variant="outlined" sx={{ width: { xs: '100%', md: 280 }, borderRadius: 1, flexShrink: 0 }}>
          {workflows.length === 0 ? (
            <Typography variant="body2" color="text.secondary" sx={{ p: 2 }}>{copy.empty}</Typography>
          ) : (
            <List dense disablePadding>
              {workflows.map((workflow) => (
                <ListItemButton
                  key={workflow.id}
                  selected={workflow.id === selectedId}
                  onClick={() => selectWorkflow(workflow)}
                >
                  <ListItemText
                    primary={workflow.name}
                    secondary={workflow.trigger.type === 'scheduled'
                      ? `${copy.triggerScheduled} · ${t.sections.automations.frequencyLabels[workflow.trigger.frequency.type]}`
                      : copy.triggerManual}
                  />
                  <Stack direction="row" spacing={0.5} alignItems="center">
                    {workflow.running ? <CircularProgress size={14} /> : null}
                    <Chip
                      size="small"
                      color={workflow.enabled ? 'success' : 'default'}
                      label={workflow.enabled ? copy.active : copy.paused}
                    />
                  </Stack>
                </ListItemButton>
              ))}
            </List>
          )}
        </Paper>
        <Stack spacing={1.5} sx={{ flex: 1, minWidth: 0 }}>
          {draft ? (
            <>
              <Paper variant="outlined" sx={{ p: 2, borderRadius: 1 }}>
                <Stack spacing={1.5}>
                  <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.5}>
                    <TextField
                      size="small"
                      fullWidth
                      label={copy.name}
                      value={draft.name}
                      onChange={(event) => setDraft((current) => (current ? { ...current, name: event.target.value } : current))}
                    />
                    <TextField
                      size="small"
                      fullWidth
                      label={copy.description}
                      value={draft.description}
                      onChange={(event) => setDraft((current) => (current ? { ...current, description: event.target.value } : current))}
                    />
                  </Stack>
                  <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.5} alignItems={{ md: 'center' }} flexWrap="wrap" useFlexGap>
                    <TextField
                      select
                      size="small"
                      sx={{ minWidth: 180 }}
                      label={copy.triggerSection}
                      value={draft.trigger.type}
                      onChange={(event) => setDraft((current) => {
                        if (!current) {
                          return current;
                        }
                        return event.target.value === 'scheduled'
                          ? { ...current, trigger: { type: 'scheduled', frequency: { type: 'daily', timeOfDay: '09:00' } } }
                          : { ...current, trigger: { type: 'manual' } };
                      })}
                    >
                      <MenuItem value="manual">{copy.triggerManual}</MenuItem>
                      <MenuItem value="scheduled">{copy.triggerScheduled}</MenuItem>
                    </TextField>
                    {draft.trigger.type === 'scheduled' ? (
                      <>
                        <TextField
                          select
                          size="small"
                          sx={{ minWidth: 160 }}
                          label={t.sections.automations.frequency}
                          value={draft.trigger.frequency.type}
                          onChange={(event) => setDraft((current) => {
                            if (!current || current.trigger.type !== 'scheduled') {
                              return current;
                            }
                            const type = event.target.value as 'hourly' | 'daily' | 'weekly';
                            return {
                              ...current,
                              trigger: {
                                ...current.trigger,
                                frequency: type === 'hourly'
                                  ? { type: 'hourly' }
                                  : type === 'daily'
                                    ? { type: 'daily', timeOfDay: current.trigger.frequency.timeOfDay ?? '09:00' }
                                    : { type: 'weekly', timeOfDay: current.trigger.frequency.timeOfDay ?? '09:00', weeklyDay: current.trigger.frequency.weeklyDay ?? 1 },
                              },
                            };
                          })}
                        >
                          {(['hourly', 'daily', 'weekly'] as const).map((frequencyType) => (
                            <MenuItem key={frequencyType} value={frequencyType}>
                              {t.sections.automations.frequencyLabels[frequencyType]}
                            </MenuItem>
                          ))}
                        </TextField>
                        {draft.trigger.frequency.type !== 'hourly' ? (
                          <TextField
                            size="small"
                            type="time"
                            sx={{ minWidth: 130 }}
                            label={t.sections.automations.timeOfDay}
                            value={draft.trigger.frequency.timeOfDay ?? '09:00'}
                            onChange={(event) => setDraft((current) => current && current.trigger.type === 'scheduled'
                              ? { ...current, trigger: { ...current.trigger, frequency: { ...current.trigger.frequency, timeOfDay: event.target.value } } }
                              : current)}
                          />
                        ) : null}
                        {draft.trigger.frequency.type === 'weekly' ? (
                          <TextField
                            select
                            size="small"
                            sx={{ minWidth: 150 }}
                            label={t.sections.automations.weeklyDay}
                            value={draft.trigger.frequency.weeklyDay ?? 1}
                            onChange={(event) => setDraft((current) => current && current.trigger.type === 'scheduled'
                              ? { ...current, trigger: { ...current.trigger, frequency: { ...current.trigger.frequency, weeklyDay: Number(event.target.value) } } }
                              : current)}
                          >
                            {t.sections.automations.weekdays.map((day, index) => (
                              <MenuItem key={day} value={index}>{day}</MenuItem>
                            ))}
                          </TextField>
                        ) : null}
                      </>
                    ) : null}
                    <Box sx={{ flex: 1 }} />
                    {selectedWorkflow ? (
                      <Stack direction="row" spacing={1} alignItems="center">
                        <Tooltip title={selectedWorkflow.enabled ? copy.disable : copy.enable}>
                          <Switch
                            size="small"
                            checked={selectedWorkflow.enabled}
                            onChange={() => void toggleEnabled(selectedWorkflow)}
                          />
                        </Tooltip>
                        <Button
                          size="small"
                          variant="outlined"
                          startIcon={<PlayArrowRounded />}
                          disabled={busy || selectedWorkflow.running}
                          onClick={() => void runNow()}
                        >
                          {selectedWorkflow.running ? copy.running : copy.runNow}
                        </Button>
                        <Button
                          size="small"
                          color="error"
                          startIcon={<DeleteOutlineRounded />}
                          onClick={() => void deleteWorkflow(selectedWorkflow)}
                        >
                          {copy.delete}
                        </Button>
                      </Stack>
                    ) : null}
                    <Button variant="contained" size="small" disabled={busy} onClick={() => void saveDraft()}>
                      {copy.save}
                    </Button>
                  </Stack>
                  {selectedWorkflow?.nextRunAt ? (
                    <Typography variant="caption" color="text.secondary">
                      {copy.nextRun}: {new Date(selectedWorkflow.nextRunAt).toLocaleString()}
                    </Typography>
                  ) : null}
                </Stack>
              </Paper>
              <Tabs value={tab} onChange={(_event, value) => setTab(value as 'editor' | 'runs')}>
                <Tab value="editor" label={copy.editorTab} />
                <Tab value="runs" label={copy.runsTab} disabled={!selectedWorkflow} />
              </Tabs>
              {tab === 'editor' ? (
                <WorkflowEditor
                  draft={draft}
                  onDraftChange={(updater) => setDraft((current) => (current ? updater(current) : current))}
                  apps={apps}
                  agents={agents}
                  toolPackages={toolPackages}
                  officialTools={officialTools}
                  t={t}
                />
              ) : (
                <RunsPanel
                  copy={copy}
                  runs={runs}
                  selectedRun={selectedRun}
                  onSelectRun={(runId) => {
                    void getDesktopApi().workflowsGetRun(runId).then(setSelectedRun);
                  }}
                  onApprove={(run, nodeId, approved) => void approveNode(run, nodeId, approved)}
                  onCancel={(run) => void cancelRun(run)}
                />
              )}
            </>
          ) : (
            <Typography variant="body2" color="text.secondary">{copy.selectWorkflow}</Typography>
          )}
        </Stack>
      </Stack>
    </Stack>
  );
}

type WorkflowCopy = AppDictionary['sections']['workflows'];

const RunsPanel = ({ copy, runs, selectedRun, onSelectRun, onApprove, onCancel }: {
  copy: WorkflowCopy;
  runs: WorkflowRunSummary[];
  selectedRun: WorkflowRun | null;
  onSelectRun: (runId: string) => void;
  onApprove: (run: WorkflowRunSummary, nodeId: string, approved: boolean) => void;
  onCancel: (run: WorkflowRunSummary) => void;
}) => (
  <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.5}>
    <Paper variant="outlined" sx={{ width: { xs: '100%', md: 300 }, borderRadius: 1, flexShrink: 0 }}>
      {runs.length === 0 ? (
        <Typography variant="body2" color="text.secondary" sx={{ p: 2 }}>{copy.noRuns}</Typography>
      ) : (
        <List dense disablePadding>
          {runs.map((run) => (
            <ListItemButton key={run.id} selected={run.id === selectedRun?.id} onClick={() => onSelectRun(run.id)}>
              <ListItemText
                primary={new Date(run.startedAt).toLocaleString()}
                secondary={run.trigger}
              />
              <Chip size="small" color={STATUS_COLORS[run.status] ?? 'default'} label={copy.statusLabels[run.status]} />
            </ListItemButton>
          ))}
        </List>
      )}
    </Paper>
    <Paper variant="outlined" sx={{ flex: 1, borderRadius: 1, p: 2, minWidth: 0 }}>
      {!selectedRun ? (
        <Typography variant="body2" color="text.secondary">{copy.noRuns}</Typography>
      ) : (
        <Stack spacing={1.5}>
          <Stack direction="row" alignItems="center" spacing={1} flexWrap="wrap" useFlexGap>
            <Chip size="small" color={STATUS_COLORS[selectedRun.status] ?? 'default'} label={copy.statusLabels[selectedRun.status]} />
            <Typography variant="body2" color="text.secondary">
              {new Date(selectedRun.startedAt).toLocaleString()}
              {selectedRun.finishedAt ? ` → ${new Date(selectedRun.finishedAt).toLocaleString()}` : ''}
            </Typography>
            <Box sx={{ flex: 1 }} />
            {selectedRun.status === 'running' || selectedRun.status === 'waiting_approval' ? (
              <Button size="small" color="error" variant="outlined" startIcon={<StopRounded />} onClick={() => onCancel(selectedRun)}>
                {copy.cancelRun}
              </Button>
            ) : null}
          </Stack>
          {selectedRun.error ? <Alert severity="error">{selectedRun.error}</Alert> : null}
          <Divider />
          {selectedRun.nodeRuns.map((nodeRun) => (
            <NodeRunRow
              key={nodeRun.nodeId}
              copy={copy}
              nodeRun={nodeRun}
              waiting={selectedRun.status === 'waiting_approval' && selectedRun.pendingApprovalNodeId === nodeRun.nodeId}
              onApprove={(approved) => onApprove(selectedRun, nodeRun.nodeId, approved)}
            />
          ))}
        </Stack>
      )}
    </Paper>
  </Stack>
);

const NodeRunRow = ({ copy, nodeRun, waiting, onApprove }: {
  copy: WorkflowCopy;
  nodeRun: WorkflowNodeRun;
  waiting: boolean;
  onApprove: (approved: boolean) => void;
}) => (
  <Paper variant="outlined" sx={{ p: 1.5, borderRadius: 1 }}>
    <Stack spacing={1}>
      <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
        <Typography variant="subtitle2">{nodeRun.nodeName}</Typography>
        <Typography variant="caption" color="text.secondary">({nodeRun.nodeId} · {nodeRun.nodeType})</Typography>
        <Chip size="small" color={STATUS_COLORS[nodeRun.status] ?? 'default'} label={copy.statusLabels[nodeRun.status]} />
        {waiting ? (
          <Stack direction="row" spacing={1}>
            <Button size="small" color="success" variant="contained" startIcon={<CheckRounded />} onClick={() => onApprove(true)}>
              {copy.approve}
            </Button>
            <Button size="small" color="error" variant="outlined" startIcon={<CloseRounded />} onClick={() => onApprove(false)}>
              {copy.reject}
            </Button>
          </Stack>
        ) : null}
      </Stack>
      {nodeRun.summary ? (
        <Typography variant="body2">{nodeRun.summary}</Typography>
      ) : null}
      {nodeRun.error ? <Alert severity="error" variant="outlined">{nodeRun.error}</Alert> : null}
      {nodeRun.output && Object.keys(nodeRun.output).length > 0 ? (
        <Box component="pre" sx={{
          m: 0,
          p: 1,
          bgcolor: 'action.hover',
          borderRadius: 1,
          fontSize: 12,
          overflow: 'auto',
          maxHeight: 200,
        }}
        >
          {JSON.stringify(nodeRun.output, null, 2)}
        </Box>
      ) : null}
    </Stack>
  </Paper>
);
