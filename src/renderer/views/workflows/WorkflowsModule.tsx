import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Button, Stack } from '@mui/material';
import type {
  AgentToolPackageDefinition,
  AppSummary,
  OfficialToolSummary,
  PersonalAgent,
  PersonalAgentGrantOptionConnection,
  Workflow,
  WorkflowRun,
  WorkflowRunSummary,
} from '@shared/types';
import type { AppDictionary } from '@renderer/i18n';
import { buildChatProviderOptions } from '@shared/agent-runtime-registry';
import type { View } from '@renderer/components/Sidebar';
import type { ProviderOption } from './WorkflowEditor';
import { WorkflowsListView } from './WorkflowsListView';
import { WorkflowEditorPage, type WorkflowGraphData } from './WorkflowEditorPage';
import { WorkflowDetailPage } from './WorkflowDetailPage';
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

const signatureOf = (draft: WorkflowDraft): string => JSON.stringify({
  name: draft.name.trim(),
  description: draft.description.trim(),
  trigger: draft.trigger,
  nodes: draft.nodes,
  edges: draft.edges,
});

export function WorkflowsModule({ t, view, selectedWorkflowId, isPinned, onBackToMore, onOpenList, onOpenDetail, onOpenEditor }: {
  t: AppDictionary;
  view: Extract<View, 'workflows' | 'workflowEditor' | 'workflowDetail'>;
  selectedWorkflowId: string | null;
  isPinned: boolean;
  onBackToMore: () => void;
  onOpenList: () => void;
  onOpenDetail: (id: string) => void;
  onOpenEditor: (id: string | null) => void;
}) {
  const copy = t.sections.workflows;
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [apps, setApps] = useState<AppSummary[]>([]);
  const [agents, setAgents] = useState<PersonalAgent[]>([]);
  const [toolPackages, setToolPackages] = useState<AgentToolPackageDefinition[]>([]);
  const [officialTools, setOfficialTools] = useState<OfficialToolSummary[]>([]);
  const [connectionOptions, setConnectionOptions] = useState<PersonalAgentGrantOptionConnection[]>([]);
  const [providerOptions, setProviderOptions] = useState<ProviderOption[]>([]);

  const [draft, setDraft] = useState<WorkflowDraft | null>(null);
  const [baseline, setBaseline] = useState<string>('');
  const [runs, setRuns] = useState<WorkflowRunSummary[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [selectedRun, setSelectedRun] = useState<WorkflowRun | null>(null);
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState<{ severity: 'success' | 'error'; message: string } | null>(null);

  const workflowsRef = useRef<Workflow[]>(workflows);
  workflowsRef.current = workflows;
  const selectedWorkflowIdRef = useRef<string | null>(selectedWorkflowId);
  selectedWorkflowIdRef.current = selectedWorkflowId;
  const selectedRunIdRef = useRef<string | null>(selectedRunId);
  selectedRunIdRef.current = selectedRunId;
  const draftInitRef = useRef<string | null>(null);

  const selectedWorkflow = workflows.find((workflow) => workflow.id === selectedWorkflowId) ?? null;

  const refreshWorkflows = useCallback(async () => {
    const next = await getDesktopApi().workflowsList();
    setWorkflows(next);
    return next;
  }, []);

  const loadRuns = useCallback(async (workflowId: string, preferredRunId?: string) => {
    const desktopApi = getDesktopApi();
    const nextRuns = await desktopApi.workflowsListRuns(workflowId);
    setRuns(nextRuns);
    const targetRunId = preferredRunId ?? nextRuns[0]?.id ?? null;
    setSelectedRunId(targetRunId);
    setSelectedRun(targetRunId ? await desktopApi.workflowsGetRun(targetRunId) : null);
  }, []);

  useEffect(() => {
    const desktopApi = getDesktopApi();
    void refreshWorkflows().catch(() => undefined);
    void desktopApi.listInstalledApps().then(setApps).catch(() => undefined);
    void desktopApi.personalAgentsList().then(setAgents).catch(() => undefined);
    void desktopApi.listAgentTools(t.locale).then(setToolPackages).catch(() => undefined);
    void desktopApi.listOfficialTools(t.locale).then((state) => setOfficialTools(state.tools)).catch(() => undefined);
    void desktopApi.personalAgentGrantOptionsList().then((options) => setConnectionOptions(options.connections)).catch(() => undefined);
    void Promise.all([
      desktopApi.getCodexAuthStatus().catch(() => ({ authenticated: false })),
      desktopApi.getClaudeAuthStatus().catch(() => ({ authenticated: false })),
      desktopApi.getAntigravityAuthStatus().catch(() => ({ authenticated: false })),
    ]).then(([codexStatus, claudeStatus, antigravityStatus]) => {
      setProviderOptions(buildChatProviderOptions({
        codexAuthenticated: Boolean(codexStatus.authenticated),
        claudeAuthenticated: Boolean(claudeStatus.authenticated),
        antigravityAuthenticated: Boolean(antigravityStatus.authenticated),
      }));
    });
    const unsubscribe = desktopApi.onWorkflowUpdated(({ workflow, run }) => {
      setWorkflows((current) => {
        const withoutCurrent = current.filter((item) => item.id !== workflow.id);
        return [workflow, ...withoutCurrent].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
      });
      if (selectedWorkflowIdRef.current === workflow.id && run) {
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

  // Initialise the working draft when entering create or a workflow's detail.
  useEffect(() => {
    if (view === 'workflows') {
      draftInitRef.current = null;
      return;
    }
    const key = `${view}:${selectedWorkflowId ?? ''}`;
    if (view === 'workflowEditor') {
      if (draftInitRef.current !== key) {
        draftInitRef.current = key;
        const next = emptyDraft();
        setDraft(next);
        setBaseline(signatureOf(next));
        setRuns([]);
        setSelectedRun(null);
        setSelectedRunId(null);
        setBanner(null);
      }
      return;
    }
    if (view === 'workflowDetail' && selectedWorkflowId) {
      const workflow = workflows.find((item) => item.id === selectedWorkflowId);
      if (workflow && draftInitRef.current !== key) {
        draftInitRef.current = key;
        const next = draftFromWorkflow(workflow);
        setDraft(next);
        setBaseline(signatureOf(next));
        setBanner(null);
        void loadRuns(workflow.id);
      }
    }
  }, [view, selectedWorkflowId, workflows, loadRuns]);

  const outputSamples = useMemo(() => {
    const samples: Record<string, unknown> = {};
    for (const run of runs) {
      for (const nodeRun of run.nodeRuns) {
        if (nodeRun.status === 'succeeded' && nodeRun.output !== undefined && !(nodeRun.nodeId in samples)) {
          samples[nodeRun.nodeId] = nodeRun.output;
        }
      }
    }
    return samples;
  }, [runs]);

  const savedNodeIds = useMemo(
    () => new Set(selectedWorkflow?.nodes.map((node) => node.id) ?? []),
    [selectedWorkflow],
  );

  const graphData: WorkflowGraphData = {
    apps, agents, toolPackages, officialTools, connectionOptions, providerOptions, outputSamples, savedNodeIds,
  };

  const dirty = draft ? signatureOf(draft) !== baseline : false;

  const onDraftChange = useCallback((updater: (current: WorkflowDraft) => WorkflowDraft) => {
    setDraft((current) => (current ? updater(current) : current));
  }, []);

  const saveDraft = useCallback(async () => {
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
      const wasCreate = !draft.id;
      const saved = await getDesktopApi().workflowsUpsert(draftToUpsertInput(draft));
      await refreshWorkflows();
      const savedDraft = draftFromWorkflow(saved);
      setDraft(savedDraft);
      setBaseline(signatureOf(savedDraft));
      setBanner({ severity: 'success', message: copy.saved });
      if (wasCreate) {
        draftInitRef.current = `workflowDetail:${saved.id}`;
        onOpenDetail(saved.id);
        void loadRuns(saved.id);
      }
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      setBanner({
        severity: 'error',
        message: code.includes('workflow_graph_has_cycle')
          ? copy.graphInvalid
          : code.includes('workflow_foreach_join_not_allowed')
            ? copy.forEachJoinNotAllowed
            : code.includes('workflow_foreach_requires_upstream')
              ? copy.forEachRequiresUpstream
              : copy.saveError,
      });
    } finally {
      setBusy(false);
    }
  }, [draft, copy, refreshWorkflows, onOpenDetail, loadRuns]);

  const discardDraft = useCallback(() => {
    if (!selectedWorkflow) {
      return;
    }
    const next = draftFromWorkflow(selectedWorkflow);
    setDraft(next);
    setBaseline(signatureOf(next));
    setBanner(null);
  }, [selectedWorkflow]);

  const runNow = useCallback(async (workflow: Workflow) => {
    setBusy(true);
    try {
      const run = await getDesktopApi().workflowsRunNow(workflow.id);
      if (selectedWorkflowIdRef.current === workflow.id) {
        await loadRuns(workflow.id, run.id);
      }
    } finally {
      setBusy(false);
    }
  }, [loadRuns]);

  const toggleEnabled = useCallback(async (workflow: Workflow) => {
    const updated = await getDesktopApi().workflowsSetEnabled(workflow.id, !workflow.enabled);
    setWorkflows((current) => current.map((item) => (item.id === updated.id ? updated : item)));
  }, []);

  const deleteWorkflow = useCallback(async (workflow: Workflow) => {
    await getDesktopApi().workflowsDelete(workflow.id);
    await refreshWorkflows();
  }, [refreshWorkflows]);

  const approveNode = useCallback(async (nodeId: string, approved: boolean) => {
    if (!selectedRunIdRef.current) {
      return;
    }
    await getDesktopApi().workflowsApproveNode({ runId: selectedRunIdRef.current, nodeId, approved });
    if (selectedWorkflowIdRef.current) {
      await loadRuns(selectedWorkflowIdRef.current, selectedRunIdRef.current ?? undefined);
    }
  }, [loadRuns]);

  const cancelRun = useCallback(async () => {
    if (!selectedRunIdRef.current) {
      return;
    }
    await getDesktopApi().workflowsCancelRun(selectedRunIdRef.current);
    if (selectedWorkflowIdRef.current) {
      await loadRuns(selectedWorkflowIdRef.current, selectedRunIdRef.current ?? undefined);
    }
  }, [loadRuns]);

  const runNodeStep = useCallback(async (nodeId: string) => {
    if (!selectedWorkflowIdRef.current) {
      return;
    }
    setBusy(true);
    try {
      const run = await getDesktopApi().workflowsRunNode(selectedWorkflowIdRef.current, nodeId);
      await loadRuns(selectedWorkflowIdRef.current, run.id);
    } finally {
      setBusy(false);
    }
  }, [loadRuns]);

  const selectRun = useCallback(async (runId: string) => {
    setSelectedRunId(runId);
    setSelectedRun(await getDesktopApi().workflowsGetRun(runId));
  }, []);

  if (view === 'workflows') {
    return (
      <Stack spacing={2}>
        {isPinned ? null : (
          <Button variant="text" onClick={onBackToMore} sx={{ alignSelf: 'flex-start' }}>
            {t.more.back}
          </Button>
        )}
        <WorkflowsListView
          t={t}
          workflows={workflows}
          busy={busy}
          onCreate={() => onOpenEditor(null)}
          onOpen={onOpenDetail}
          onToggleEnabled={(workflow) => void toggleEnabled(workflow)}
          onRunNow={(workflow) => void runNow(workflow)}
          onDelete={(workflow) => void deleteWorkflow(workflow)}
        />
      </Stack>
    );
  }

  return (
    <Box sx={{ height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      {view === 'workflowEditor' && draft ? (
        <WorkflowEditorPage
          t={t}
          draft={draft}
          onDraftChange={onDraftChange}
          data={graphData}
          busy={busy}
          banner={banner}
          onClearBanner={() => setBanner(null)}
          onSave={() => void saveDraft()}
          onBack={onOpenList}
        />
      ) : null}
      {view === 'workflowDetail' && draft && selectedWorkflow ? (
        <WorkflowDetailPage
          t={t}
          workflow={selectedWorkflow}
          draft={draft}
          onDraftChange={onDraftChange}
          data={graphData}
          dirty={dirty}
          busy={busy}
          banner={banner}
          onClearBanner={() => setBanner(null)}
          onSave={() => void saveDraft()}
          onDiscard={discardDraft}
          onBack={onOpenList}
          onRunNow={() => void runNow(selectedWorkflow)}
          onToggleEnabled={() => void toggleEnabled(selectedWorkflow)}
          onRunNode={(nodeId) => void runNodeStep(nodeId)}
          runs={runs}
          selectedRunId={selectedRunId}
          onSelectRun={(runId) => void selectRun(runId)}
          selectedRun={selectedRun}
          onApproveNode={(nodeId, approved) => void approveNode(nodeId, approved)}
          onCancelRun={() => void cancelRun()}
        />
      ) : null}
    </Box>
  );
}
