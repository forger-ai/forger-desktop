import { randomUUID } from 'node:crypto';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type {
  FilesActionResult,
  Workflow,
  WorkflowApplyInput,
  WorkflowApproveNodeInput,
  WorkflowNode,
  WorkflowNodeRun,
  WorkflowRestoreRevisionInput,
  WorkflowReviewReport,
  WorkflowRevision,
  WorkflowRun,
  WorkflowRunSummary,
  WorkflowRunTrigger,
  WorkflowUpdatedEvent,
  WorkflowUpsertInput,
} from '../shared/types';
import { appendTranscript } from './automation/agent-command-runner';
import {
  computeNextRunAt,
  defaultMissedRunWindowMinutes,
} from './automation-manager';
import {
  computeRunOutcome,
  resolveNodeReadiness,
  validateWorkflowGraph,
  type WorkflowNodeState,
} from './workflow/engine';
import {
  WorkflowNodeRuntime,
  type ActiveRunState,
  type WorkflowMcpNodeContext,
  type WorkflowNodeRuntimeOptions,
} from './workflow/node-runtime';
import { WorkflowStore, toWorkflowRunSummary } from './workflow/store';
import { sanitizeWorkflowUpsertInput } from './workflow/sanitize';
import {
  createWorkflowRevision,
  reviewWorkflowDefinition,
  workflowDefinitionHash,
  workflowForExecution,
} from './workflow/revisions';

export type { WorkflowMcpNodeContext, WorkflowNodeCompletion } from './workflow/node-runtime';

const MAX_TIMEOUT_MS = 2_147_483_647;
const MISSED_RUN_GRACE_MS = 60_000;
const MAX_PARALLEL_NODES = 4;

interface WorkflowManagerOptions extends WorkflowNodeRuntimeOptions {
  getValidToolIds?: () => ReadonlySet<string>;
  onWorkflowUpdated: (event: WorkflowUpdatedEvent) => void;
}

export interface WorkflowManagerInitializeOptions {
  recalculateSchedulesFromNow?: boolean;
}

export class WorkflowManager {
  private workflows = new Map<string, Workflow>();
  private timers = new Map<string, NodeJS.Timeout>();
  private activeRuns = new Map<string, ActiveRunState>();
  private revisions = new Map<string, WorkflowRevision[]>();
  private workflowOperationTails = new Map<string, Promise<void>>();
  private runTasks = new Map<string, Promise<void>>();
  private inFlightOperations = new Set<Promise<unknown>>();
  private disposed = false;
  private disposePromise: Promise<void> | null = null;
  private readonly store: WorkflowStore;
  private readonly nodeRuntime: WorkflowNodeRuntime;

  public constructor(private readonly options: WorkflowManagerOptions) {
    this.store = new WorkflowStore({ metadataRoot: options.metadataRoot });
    this.nodeRuntime = new WorkflowNodeRuntime(options);
  }

  public async initialize(options: WorkflowManagerInitializeOptions = {}): Promise<void> {
    this.disposed = false;
    this.disposePromise = null;
    await this.store.initialize();
    const entries = await this.store.readWorkflows();
    for (const entry of entries) {
      const normalized = this.normalizeWorkflow(entry);
      if (normalized) {
        let revisions = (await this.store.readRevisions(normalized.id))
          .filter((revision) => revision.workflowId === normalized.id)
          .sort((left, right) => right.revision - left.revision);
        if (revisions.length === 0) {
          const migrationAppliedAt = new Map([[normalized.revisionId, normalized.updatedAt]])
            .get(normalized.appliedRevisionId as string);
          const migrated = createWorkflowRevision(normalized, {
            id: normalized.revisionId,
            applied: normalized.appliedRevisionId === normalized.revisionId,
            appliedAt: migrationAppliedAt,
          });
          revisions = [migrated];
          await this.store.saveRevisions(normalized.id, revisions);
        }
        this.revisions.set(normalized.id, revisions);
        const applied = this.appliedRevisionFor(normalized);
        const withAppliedTrigger = applied
          ? { ...normalized, appliedTrigger: applied.workflow.trigger }
          : normalized;
        const recalculated = options.recalculateSchedulesFromNow
          && withAppliedTrigger.enabled
          && applied?.workflow.trigger.type === 'scheduled'
          ? { ...withAppliedTrigger, nextRunAt: computeNextRunAt(applied.workflow.trigger.frequency) }
          : withAppliedTrigger;
        this.workflows.set(withAppliedTrigger.id, recalculated);
      }
    }
    await this.failInterruptedRuns();
    await this.saveWorkflows();
    for (const workflow of this.workflows.values()) {
      await this.scheduleWorkflow(workflow.id);
    }
  }

  public dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.disposed = true;
    this.disposePromise = (async () => {
      const failures: unknown[] = [];
      const settledPromises = new Set<Promise<unknown>>();
      const settle = async (promises: Iterable<Promise<unknown>>): Promise<void> => {
        const pending = [...promises].filter((promise) => {
          if (settledPromises.has(promise)) return false;
          settledPromises.add(promise);
          return true;
        });
        const results = await Promise.allSettled(pending);
        for (const result of results) {
          if (result.status === 'rejected') {
            if (result.reason instanceof AggregateError) failures.push(...result.reason.errors);
            else failures.push(result.reason);
          }
        }
      };
      for (const timer of this.timers.values()) clearTimeout(timer);
      this.timers.clear();

      for (const active of this.activeRuns.values()) this.cancelActiveRun(active);
      await settle(this.workflowOperationTails.values());
      for (const active of this.activeRuns.values()) this.cancelActiveRun(active);
      await settle(this.runTasks.values());
      await settle(this.inFlightOperations);
      await settle(this.workflowOperationTails.values());
      for (const active of this.activeRuns.values()) this.cancelActiveRun(active);
      await settle(this.runTasks.values());
      await settle(
        [...this.activeRuns.keys()].map(async (runId) => {
          await Promise.resolve().then(() => this.options.releaseAppActions?.(runId));
        }),
      );
      try {
        await this.nodeRuntime.flushActivityPersistence();
      } catch (error) {
        if (error instanceof AggregateError) failures.push(...error.errors);
        else failures.push(error);
      }
      this.activeRuns.clear();
      if (failures.length > 0) {
        throw new AggregateError(failures, 'workflow_dispose_failed');
      }
    })();
    return this.disposePromise;
  }

  public list(): Workflow[] {
    return this.sortedWorkflows();
  }

  public get(id: string): Workflow | null {
    return this.workflows.get(id) ?? null;
  }

  public async upsert(input: WorkflowUpsertInput): Promise<Workflow> {
    const sanitized = sanitizeWorkflowUpsertInput(
      input,
      this.options.getValidToolIds?.(),
      { rejectInvalidNodes: true },
    );
    if (!sanitized.name.trim()) {
      throw new Error('workflow_name_required');
    }
    validateWorkflowGraph(sanitized.nodes, sanitized.edges);
    const create = sanitized.id === undefined;
    const workflowId = sanitized.id ?? randomUUID();
    return await this.withWorkflowLock(workflowId, async () => {
      this.assertNotDisposed();
      return await this.upsertUnlocked(sanitized, workflowId, create);
    });
  }

  private async upsertUnlocked(
    sanitized: WorkflowUpsertInput,
    workflowId: string,
    create: boolean,
  ): Promise<Workflow> {
    const now = new Date().toISOString();
    const current = this.workflows.get(workflowId);
    if (!create && !current) {
      throw new Error('workflow_not_found');
    }
    if (current && sanitized.expectedRevision === undefined) {
      throw new Error('workflow_expected_revision_required');
    }
    if (current && sanitized.expectedRevision !== undefined && sanitized.expectedRevision !== current.revision) {
      throw new Error('workflow_revision_conflict');
    }
    const revision = (current?.revision ?? 0) + 1;
    const revisionId = randomUUID();
    const workflow: Workflow = {
      id: current?.id ?? workflowId,
      name: sanitized.name,
      ...(sanitized.description ? { description: sanitized.description } : {}),
      trigger: sanitized.trigger,
      nodes: sanitized.nodes,
      edges: sanitized.edges,
      enabled: current?.enabled ?? false,
      running: current?.running ?? false,
      nextRunAt: current?.nextRunAt ?? null,
      createdAt: current?.createdAt ?? now,
      updatedAt: now,
      ...(current?.lastRun ? { lastRun: current.lastRun } : {}),
      revision,
      revisionId,
      ...(current?.appliedRevision !== undefined ? { appliedRevision: current.appliedRevision } : {}),
      ...(current?.appliedRevisionId ? { appliedRevisionId: current.appliedRevisionId } : {}),
      ...(current?.appliedTrigger ? { appliedTrigger: current.appliedTrigger } : {}),
    };
    const revisionSnapshot = createWorkflowRevision(workflow, { id: revisionId });
    const revisions = [revisionSnapshot, ...(this.revisions.get(workflow.id) ?? [])];
    this.revisions.set(workflow.id, revisions);
    await this.store.saveRevisions(workflow.id, revisions);
    this.workflows.set(workflow.id, workflow);
    await this.saveWorkflows();
    this.options.onWorkflowUpdated({ workflow });
    return workflow;
  }

  public async review(id: string): Promise<WorkflowReviewReport> {
    return await this.withWorkflowLock(id, async () => {
      this.assertNotDisposed();
      const workflow = this.requireWorkflow(id);
      const report = reviewWorkflowDefinition(workflow);
      const next: Workflow = { ...workflow, review: report };
      this.workflows.set(id, next);
      await this.saveWorkflows();
      this.options.onWorkflowUpdated({ workflow: next });
      return report;
    });
  }

  public async apply(id: string, input: WorkflowApplyInput): Promise<Workflow> {
    return await this.trackOperation(this.applyUnlockedBetweenPreflights(id, input));
  }

  private async applyUnlockedBetweenPreflights(id: string, input: WorkflowApplyInput): Promise<Workflow> {
    const captured = await this.withWorkflowLock(id, async () => {
      this.assertNotDisposed();
      const workflow = this.requireWorkflow(id);
      this.assertWorkflowReadyToApply(workflow, input);
      this.nodeRuntime.assertAuthenticAppActionNodes(workflow.nodes);
      return structuredClone(workflow);
    });
    const preflightNodes = await this.nodeRuntime.resolveLiveAppActionNodes(captured.nodes);
    const operationId = `workflow-apply-${randomUUID()}`;
    try {
      await this.nodeRuntime.preflightAppActionNodes(preflightNodes, operationId);
      return await this.withWorkflowLock(id, async () => {
        this.assertNotDisposed();
        const workflow = this.requireWorkflow(id);
        this.assertWorkflowReadyToApply(workflow, input);
        if (workflow.revisionId !== captured.revisionId) throw new Error('workflow_review_stale');
        this.nodeRuntime.assertAuthenticAppActionNodes(workflow.nodes);
        this.nodeRuntime.assertLiveAppActionNodesMatch(workflow.nodes, preflightNodes);

        const revisions = this.requireRevisions(id).map((revision) => revision.id === workflow.revisionId
          ? { ...revision, applied: true, appliedAt: new Date().toISOString() }
          : { ...revision, applied: false, appliedAt: undefined });
        const applied = revisions.find((revision) => revision.id === workflow.revisionId);
        if (!applied || applied.definitionHash !== input.definitionHash) {
          throw new Error('workflow_revision_not_found');
        }
        this.nodeRuntime.assertAuthenticAppActionNodes(applied.workflow.nodes);
        this.revisions.set(id, revisions);
        await this.store.saveRevisions(id, revisions);
        const next: Workflow = {
          ...workflow,
          appliedRevision: applied.revision,
          appliedRevisionId: applied.id,
          appliedTrigger: applied.workflow.trigger,
        };
        this.workflows.set(id, next);
        await this.saveWorkflows();
        this.options.onWorkflowUpdated({ workflow: next });
        return next;
      });
    } finally {
      await Promise.resolve(this.options.releaseAppActions?.(operationId)).catch(() => undefined);
    }
  }

  public async listRevisions(id: string): Promise<WorkflowRevision[]> {
    this.requireWorkflow(id);
    return structuredClone(this.requireRevisions(id));
  }

  public async restoreRevision(id: string, input: WorkflowRestoreRevisionInput): Promise<Workflow> {
    return await this.withWorkflowLock(id, async () => {
      this.assertNotDisposed();
      const current = this.requireWorkflow(id);
      this.assertExpectedRevision(current, input.expectedRevision);
      const source = this.requireRevisions(id).find((revision) => revision.id === input.revisionId);
      if (!source) throw new Error('workflow_revision_not_found');
      const snapshot = source.workflow;
      const sanitized = sanitizeWorkflowUpsertInput({
        id,
        expectedRevision: current.revision,
        name: snapshot.name,
        ...(snapshot.description ? { description: snapshot.description } : {}),
        trigger: snapshot.trigger,
        nodes: snapshot.nodes,
        edges: snapshot.edges,
      }, this.options.getValidToolIds?.());
      validateWorkflowGraph(sanitized.nodes, sanitized.edges);
      return await this.upsertUnlocked(sanitized, id, false);
    });
  }

  public async delete(id: string): Promise<FilesActionResult> {
    return await this.withWorkflowLock(id, async () => {
      this.assertNotDisposed();
      if (!this.workflows.has(id)) {
        return { success: false, technicalCode: 'workflow_not_found', userMessage: 'No encontramos ese flujo.' };
      }
      this.clearTimer(id);
      this.workflows.delete(id);
      this.revisions.delete(id);
      await this.store.deleteRevisions(id);
      await this.saveWorkflows();
      return { success: true, userMessage: 'Flujo eliminado.' };
    });
  }

  public async setEnabled(id: string, enabled: boolean): Promise<Workflow> {
    const next = await this.withWorkflowLock(id, async () => {
      this.assertNotDisposed();
      const workflow = this.requireWorkflow(id);
      if (enabled && !workflow.appliedRevisionId) {
        throw new Error('workflow_applied_revision_required');
      }
      const applied = workflow.appliedRevisionId ? this.appliedWorkflowFor(workflow) : null;
      if (enabled && applied?.trigger.type !== 'scheduled') {
        throw new Error('workflow_manual_cannot_activate');
      }
      const updated: Workflow = {
        ...workflow,
        enabled,
        nextRunAt: enabled && applied?.trigger.type === 'scheduled'
          ? computeNextRunAt(applied.trigger.frequency)
          : null,
        updatedAt: new Date().toISOString(),
      };
      this.workflows.set(id, updated);
      if (!enabled) this.clearTimer(id);
      await this.saveWorkflows();
      this.options.onWorkflowUpdated({ workflow: updated });
      return updated;
    });
    await this.scheduleWorkflow(id);
    return next;
  }

  public async runNow(id: string, trigger: WorkflowRunTrigger = 'manual'): Promise<WorkflowRunSummary> {
    return await this.trackOperation(this.startRun(id, trigger));
  }

  public async retryRun(runId: string): Promise<WorkflowRunSummary> {
    return await this.trackOperation(this.retryRunOperation(runId));
  }

  private async retryRunOperation(runId: string): Promise<WorkflowRunSummary> {
    this.assertNotDisposed();
    const previous = await this.store.readRun(runId);
    if (!previous || previous.status !== 'failed') {
      throw new Error('workflow_retry_not_safe');
    }
    if (previous.safeToRetry !== true) {
      throw new Error('workflow_run_effects_uncertain');
    }
    const revision = this.requireRevisions(previous.workflowId)
      .find((entry) => entry.id === previous.workflowRevisionId);
    if (!revision || revision.definitionHash !== previous.definitionHash) {
      throw new Error('workflow_retry_revision_unavailable');
    }
    return await this.startRun(previous.workflowId, previous.trigger, revision, previous.id);
  }

  /**
   * Runs a single node in isolation ("execute step"). Upstream context is
   * seeded from the latest stored outputs of previous runs, other nodes are
   * recorded as skipped, and approval pauses are bypassed because the person
   * triggers the step explicitly.
   */
  public async runNode(workflowId: string, nodeId: string): Promise<WorkflowRunSummary> {
    return await this.trackOperation(this.runNodeOperation(workflowId, nodeId));
  }

  private async runNodeOperation(workflowId: string, nodeId: string): Promise<WorkflowRunSummary> {
    const prepared = await this.withWorkflowLock(workflowId, async () => {
      this.assertNotDisposed();
      const current = this.requireWorkflow(workflowId);
      const revision = this.requireRunnableRevision(current);
      const workflow = workflowForExecution(current, revision);
      const node = workflow.nodes.find((entry) => entry.id === nodeId);
      if (!node) throw new Error('workflow_node_not_found');
      if (current.running) {
        const skipped = this.createRunRecord(workflow, revision, 'step', 'skipped', 'workflow_already_running');
        await this.persistRunUnlocked(workflow.id, skipped);
        return { run: skipped, execute: false };
      }
      const run = this.createRunRecord(workflow, revision, 'step', 'queued');
      for (const nodeRun of run.nodeRuns) {
        if (nodeRun.nodeId !== nodeId) nodeRun.status = 'skipped';
      }
      this.workflows.set(workflowId, { ...current, running: true, updatedAt: new Date().toISOString() });
      try {
        await this.saveWorkflows();
        await this.store.appendRunId(workflow.id, run.id);
        await this.persistRunUnlocked(workflow.id, run);
      } catch (error) {
        this.workflows.set(workflowId, current);
        await this.saveWorkflows().catch(() => undefined);
        throw error;
      }
      return { run, execute: true };
    });
    if (prepared.execute && !this.disposed) {
      this.launchRunTask(prepared.run, () => this.executeSingleNode(workflowId, prepared.run, nodeId));
    } else if (prepared.execute) {
      await this.cancelPreparedRun(workflowId, prepared.run);
    }
    return toWorkflowRunSummary(prepared.run);
  }

  private async executeSingleNode(workflowId: string, run: WorkflowRun, nodeId: string): Promise<void> {
    const active: ActiveRunState = {
      workflowId,
      canceled: false,
      children: new Set(),
      actionAbortControllers: new Set(),
      approvalResolvers: new Map(),
    };
    this.activeRuns.set(run.id, active);
    const transcriptPath = this.store.runTranscriptPath(run.id);
    try {
      const workflow = this.workflowForRun(run);
      const node = workflow.nodes.find((entry) => entry.id === nodeId) as WorkflowNode;
      await appendTranscript(transcriptPath, 'meta', `Workflow ${workflow.id} single-step run ${run.id} for node ${nodeId}`);
      run.status = 'running';
      await this.persistRun(workflowId, run);

      const samples = await this.collectLatestOutputs(workflowId);
      const states: Record<string, WorkflowNodeState> = Object.fromEntries(
        workflow.nodes.map((entry) => entry.id === nodeId
          ? [entry.id, { status: 'pending' as const }]
          : [entry.id, samples[entry.id] !== undefined
              ? { status: 'succeeded' as const, output: samples[entry.id] as Record<string, unknown> }
              : { status: 'skipped' as const }]),
      );
      const triggerContext: Record<string, unknown> = {
        type: 'step',
        firedAt: run.startedAt,
        workflow: { id: workflow.id, name: workflow.name },
      };
      const syncNodeRun = async (syncNodeId: string): Promise<void> => {
        /* c8 ignore next 3 -- executeNode only syncs the node it received. */
        if (syncNodeId !== nodeId) {
          return;
        }
        const state = states[nodeId];
        const nodeRun = run.nodeRuns.find((entry) => entry.nodeId === nodeId);
        /* c8 ignore next 3 -- states and nodeRuns are seeded from the same node list. */
        if (!state || !nodeRun) {
          return;
        }
        nodeRun.status = state.status;
        nodeRun.input = this.nodeRuntime.persistedNodeRunValue(node, state.input);
        nodeRun.output = this.nodeRuntime.persistedNodeRunValue(node, state.output);
        nodeRun.summary = state.summary;
        nodeRun.error = state.error;
        if (state.status === 'running' && !nodeRun.startedAt) {
          nodeRun.startedAt = new Date().toISOString();
        }
        if (['succeeded', 'failed', 'skipped', 'canceled'].includes(state.status) && !nodeRun.finishedAt) {
          nodeRun.finishedAt = new Date().toISOString();
        }
        const waitingNode = run.nodeRuns.find((entry) => entry.status === 'waiting_approval');
        run.pendingApprovalNodeId = waitingNode?.nodeId;
        run.status = waitingNode ? 'waiting_approval' : 'running';
        await this.persistRun(workflowId, run);
      };

      let preflightComplete = false;
      try {
        await this.nodeRuntime.preflightAppActionNodes([node], run.id);
        preflightComplete = true;
      } catch (error) {
        run.safeToRetry = true;
        throw error;
      }
      const stepNode = { ...node, requiresApproval: false } as WorkflowNode;
      await this.nodeRuntime.executeNode(
        workflow,
        run,
        stepNode,
        states,
        triggerContext,
        active,
        transcriptPath,
        syncNodeRun,
      );
      if (preflightComplete) run.safeToRetry = false;

      const state = states[nodeId];
      run.status = active.canceled
        ? 'canceled'
        : state?.status === 'succeeded' ? 'succeeded' : 'failed';
      run.error = state?.status === 'failed' ? state.error : undefined;
      run.finishedAt = new Date().toISOString();
      await this.persistRun(workflowId, run);
    } catch (error) {
      run.status = 'failed';
      run.error = error instanceof Error ? error.message : 'workflow_step_failed';
      run.finishedAt = new Date().toISOString();
      await this.persistRun(workflowId, run);
    } finally {
      await Promise.resolve(this.options.releaseAppActions?.(run.id)).catch(() => undefined);
      this.activeRuns.delete(run.id);
      await this.markWorkflowRunning(workflowId, false);
    }
  }

  /** Latest known successful output per node id, scanning stored runs newest-first. */
  public async collectLatestOutputs(workflowId: string): Promise<Record<string, unknown>> {
    const runIds = await this.store.readRunIds(workflowId);
    const outputs: Record<string, unknown> = {};
    for (const runId of runIds.slice(0, 20)) {
      const run = await this.store.readRun(runId);
      for (const nodeRun of run?.nodeRuns ?? []) {
        if (nodeRun.status === 'succeeded' && nodeRun.output !== undefined && !(nodeRun.nodeId in outputs)) {
          outputs[nodeRun.nodeId] = nodeRun.output;
        }
      }
    }
    return outputs;
  }

  public async listRuns(workflowId: string): Promise<WorkflowRunSummary[]> {
    const runIds = await this.store.readRunIds(workflowId);
    const runs = await Promise.all(runIds.map((runId) => this.store.readRun(runId)));
    return runs
      .filter((run): run is WorkflowRun => Boolean(run))
      .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))
      .map(toWorkflowRunSummary);
  }

  public async getRun(runId: string): Promise<WorkflowRun | null> {
    return await this.store.readRun(runId);
  }

  public async cancelRun(runId: string): Promise<FilesActionResult> {
    const active = this.activeRuns.get(runId);
    if (!active) {
      return { success: false, technicalCode: 'workflow_run_not_active', userMessage: 'Ese flujo no esta en ejecucion.' };
    }
    this.cancelActiveRun(active);
    await this.nodeRuntime.flushActivityPersistence().catch(() => undefined);
    return { success: true, userMessage: 'Deteniendo el flujo...' };
  }

  public async approveNode(input: WorkflowApproveNodeInput): Promise<FilesActionResult> {
    const active = this.activeRuns.get(input.runId);
    const resolver = active?.approvalResolvers.get(input.nodeId);
    if (!active || !resolver) {
      return {
        success: false,
        technicalCode: 'workflow_approval_not_pending',
        userMessage: 'Ese paso ya no esta esperando aprobacion.',
      };
    }
    active.approvalResolvers.delete(input.nodeId);
    resolver(input.approved);
    return {
      success: true,
      userMessage: input.approved ? 'Paso aprobado.' : 'Paso rechazado.',
    };
  }

  // --- Forger MCP bridge -------------------------------------------------

  public getNodeContext(nodeRunKey: string): WorkflowMcpNodeContext | null {
    return this.nodeRuntime.getNodeContext(nodeRunKey);
  }

  public completeNodeFromMcp(
    nodeRunKey: string,
    args: { output?: unknown; summary?: unknown },
  ): { success: boolean; errors?: string[]; technicalCode?: string } {
    return this.nodeRuntime.completeNodeFromMcp(nodeRunKey, args);
  }

  public failNodeFromMcp(
    nodeRunKey: string,
    args: { reason?: unknown },
  ): { success: boolean; technicalCode?: string } {
    return this.nodeRuntime.failNodeFromMcp(nodeRunKey, args);
  }

  // --- Run execution -----------------------------------------------------

  private async startRun(
    id: string,
    trigger: WorkflowRunTrigger,
    requestedRevision?: WorkflowRevision,
    retryOfRunId?: string,
  ): Promise<WorkflowRunSummary> {
    const prepared = await this.withWorkflowLock(id, async () => {
      this.assertNotDisposed();
      const current = this.requireWorkflow(id);
      if (trigger === 'scheduled' && (!current.enabled || !current.appliedRevisionId)) {
        throw new Error('workflow_schedule_not_active');
      }
      const revision = requestedRevision
        ? this.requireRequestedRevision(current.id, requestedRevision)
        : this.requireRunnableRevision(current);
      const workflow = workflowForExecution(current, revision);
      if (current.running) {
        const skipped = this.createRunRecord(
          workflow,
          revision,
          trigger,
          'skipped',
          'workflow_already_running',
          retryOfRunId,
        );
        await this.persistRunUnlocked(workflow.id, skipped);
        return { run: skipped, execute: false };
      }
      const run = this.createRunRecord(workflow, revision, trigger, 'queued', undefined, retryOfRunId);
      this.workflows.set(id, { ...current, running: true, updatedAt: new Date().toISOString() });
      try {
        await this.saveWorkflows();
        await this.store.appendRunId(workflow.id, run.id);
        await this.persistRunUnlocked(workflow.id, run);
      } catch (error) {
        this.workflows.set(id, current);
        await this.saveWorkflows().catch(() => undefined);
        throw error;
      }
      return { run, execute: true };
    });
    if (prepared.execute && !this.disposed) {
      this.launchRunTask(prepared.run, () => this.executeRun(id, prepared.run));
    } else if (prepared.execute) {
      await this.cancelPreparedRun(id, prepared.run);
    }
    return toWorkflowRunSummary(prepared.run);
  }

  private async executeRun(workflowId: string, run: WorkflowRun): Promise<void> {
    const active: ActiveRunState = {
      workflowId,
      canceled: false,
      children: new Set(),
      actionAbortControllers: new Set(),
      approvalResolvers: new Map(),
    };
    this.activeRuns.set(run.id, active);
    const transcriptPath = this.store.runTranscriptPath(run.id);
    try {
      const workflow = this.workflowForRun(run);
      let preflightComplete = false;
      try {
        await this.nodeRuntime.preflightAppActionNodes(workflow.nodes, run.id);
        preflightComplete = true;
      } catch (error) {
        run.safeToRetry = true;
        throw error;
      }
      await appendTranscript(transcriptPath, 'meta', `Workflow ${workflow.id} (${workflow.name}) run ${run.id} started`);
      run.status = 'running';
      await this.persistRun(workflowId, run);

      const states: Record<string, WorkflowNodeState> = Object.fromEntries(
        workflow.nodes.map((node) => [node.id, { status: 'pending' as const }]),
      );
      const triggerContext: Record<string, unknown> = {
        type: run.trigger,
        firedAt: run.startedAt,
        workflow: { id: workflow.id, name: workflow.name },
      };
      const executing = new Map<string, Promise<void>>();

      const syncNodeRun = async (nodeId: string): Promise<void> => {
        const node = workflow.nodes.find((entry) => entry.id === nodeId);
        const state = states[nodeId];
        /* c8 ignore next 3 -- states and nodeRuns are seeded from the same node list. */
        if (!node || !state) {
          return;
        }
        const nodeRun = run.nodeRuns.find((entry) => entry.nodeId === nodeId);
        if (nodeRun) {
          nodeRun.status = state.status;
          nodeRun.input = this.nodeRuntime.persistedNodeRunValue(node, state.input);
          nodeRun.output = this.nodeRuntime.persistedNodeRunValue(node, state.output);
          nodeRun.summary = state.summary;
          nodeRun.error = state.error;
          if (state.status === 'running' && !nodeRun.startedAt) {
            nodeRun.startedAt = new Date().toISOString();
          }
          if (['succeeded', 'failed', 'skipped', 'canceled'].includes(state.status) && !nodeRun.finishedAt) {
            nodeRun.finishedAt = new Date().toISOString();
          }
        }
        const waitingNode = run.nodeRuns.find((entry) => entry.status === 'waiting_approval');
        run.pendingApprovalNodeId = waitingNode?.nodeId;
        run.status = waitingNode ? 'waiting_approval' : 'running';
        await this.persistRun(workflowId, run);
      };

      while (true) {
        if (active.canceled) {
          break;
        }
        // Cascade skips until stable so unreachable branches resolve fully.
        let readiness = resolveNodeReadiness(workflow.nodes, workflow.edges, states);
        while (readiness.skipped.length > 0) {
          for (const nodeId of readiness.skipped) {
            states[nodeId] = { status: 'skipped' };
            await syncNodeRun(nodeId);
          }
          readiness = resolveNodeReadiness(workflow.nodes, workflow.edges, states);
        }
        const capacity = MAX_PARALLEL_NODES - executing.size;
        const toStart = readiness.ready.filter((nodeId) => !executing.has(nodeId)).slice(0, Math.max(0, capacity));
        for (const nodeId of toStart) {
          const node = workflow.nodes.find((entry) => entry.id === nodeId) as WorkflowNode;
          const promise = this.nodeRuntime.executeNode(
            workflow,
            run,
            node,
            states,
            triggerContext,
            active,
            transcriptPath,
            syncNodeRun,
          )
            .catch(async (error) => {
              states[node.id] = {
                status: 'failed',
                error: error instanceof Error ? error.message : 'workflow_node_failed',
              };
              await syncNodeRun(node.id);
            })
            .finally(() => {
              executing.delete(nodeId);
            });
          executing.set(nodeId, promise);
        }
        if (executing.size === 0) {
          break;
        }
        await Promise.race(executing.values());
      }
      await Promise.allSettled(executing.values());

      for (const node of workflow.nodes) {
        const state = states[node.id];
        if (state && !['succeeded', 'failed', 'skipped', 'canceled'].includes(state.status)) {
          states[node.id] = { status: 'canceled' };
          await syncNodeRun(node.id);
        }
      }

      const outcome = active.canceled
        ? { status: 'canceled' as const }
        : computeRunOutcome(workflow.nodes, workflow.edges, states);
      run.status = outcome.status;
      if (preflightComplete) run.safeToRetry = false;
      run.error = outcome.status === 'failed' ? outcome.error : undefined;
      run.pendingApprovalNodeId = undefined;
      run.finishedAt = new Date().toISOString();
      await appendTranscript(transcriptPath, 'meta', `Workflow run ${run.id} finished with status ${run.status}`);
      await this.persistRun(workflowId, run);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'workflow_run_failed';
      await appendTranscript(transcriptPath, 'meta', `Workflow run failed: ${message}`);
      run.status = 'failed';
      run.error = message;
      run.finishedAt = new Date().toISOString();
      await this.persistRun(workflowId, run);
    } finally {
      await Promise.resolve(this.options.releaseAppActions?.(run.id)).catch(() => undefined);
      this.activeRuns.delete(run.id);
      await this.markWorkflowRunning(workflowId, false);
      await this.scheduleWorkflow(workflowId);
    }
  }

  // --- Scheduling ---------------------------------------------------------

  private async scheduleWorkflow(id: string): Promise<void> {
    this.clearTimer(id);
    if (this.disposed) return;
    const current = this.workflows.get(id);
    if (!current?.enabled || !current.appliedRevisionId || !current.nextRunAt) {
      return;
    }
    const workflow = this.appliedWorkflowFor(current);
    if (workflow.trigger.type !== 'scheduled') return;
    const dueAt = Date.parse(current.nextRunAt);
    if (!Number.isFinite(dueAt)) return await this.handleDueScheduledRun(id);
    const delay = dueAt - Date.now();
    if (delay <= 0) {
      await this.handleDueScheduledRun(id);
      return;
    }
    const timer = setTimeout(() => {
      void this.scheduleWorkflow(id).catch(() => undefined);
    }, Math.min(delay, MAX_TIMEOUT_MS));
    this.timers.set(id, timer);
  }

  private async handleDueScheduledRun(id: string): Promise<void> {
    const decision: { reschedule: boolean; revision?: WorkflowRevision } = await this.withWorkflowLock(id, async () => {
      const current = this.workflows.get(id);
      if (this.disposed || !current?.enabled || !current.appliedRevisionId || !current.nextRunAt) {
        return { reschedule: false };
      }
      const revision = this.requireAppliedRevision(current);
      const workflow = workflowForExecution(current, revision);
      if (workflow.trigger.type !== 'scheduled') return { reschedule: false };
      const dueAt = Date.parse(current.nextRunAt);
      if (!Number.isFinite(dueAt)) {
        await this.skipMissedRunUnlocked(id, 'workflow_invalid_schedule');
        return { reschedule: true };
      }
      const latenessMs = Date.now() - dueAt;
      if (latenessMs < 0) return { reschedule: true };
      const missedRunPolicy = workflow.trigger.missedRunPolicy ?? 'within_window';
      if (latenessMs <= MISSED_RUN_GRACE_MS || missedRunPolicy === 'always') {
        await this.advanceScheduleUnlocked(id);
        return { reschedule: true, revision };
      }
      if (missedRunPolicy === 'within_window') {
        const windowMs = (workflow.trigger.missedRunWindowMinutes
          ?? defaultMissedRunWindowMinutes(workflow.trigger.frequency)) * 60_000;
        if (latenessMs <= windowMs) {
          await this.advanceScheduleUnlocked(id);
          return { reschedule: true, revision };
        }
      }
      await this.skipMissedRunUnlocked(id, 'workflow_missed_schedule');
      return { reschedule: true };
    });
    if (decision.reschedule) await this.scheduleWorkflow(id);
    if (decision.revision) {
      void this.trackOperation(this.startRun(id, 'scheduled', decision.revision)).catch(() => undefined);
    }
  }

  /** Must run while holding the workflow lock. */
  private async advanceScheduleUnlocked(id: string): Promise<void> {
    const current = this.workflows.get(id);
    if (!current?.appliedRevisionId) {
      return;
    }
    const workflow = this.appliedWorkflowFor(current);
    if (workflow.trigger.type !== 'scheduled') return;
    const next: Workflow = {
      ...current,
      nextRunAt: current.enabled ? computeNextRunAt(workflow.trigger.frequency) : null,
      updatedAt: new Date().toISOString(),
    };
    this.workflows.set(id, next);
    await this.saveWorkflows();
  }

  /** Must run while holding the workflow lock. */
  private async skipMissedRunUnlocked(id: string, error: string): Promise<void> {
    const current = this.workflows.get(id);
    if (!current) {
      return;
    }
    const revision = this.requireAppliedRevision(current);
    const workflow = workflowForExecution(current, revision);
    const run = this.createRunRecord(workflow, revision, 'scheduled', 'skipped', error);
    await this.store.appendRunId(workflow.id, run.id);
    await this.persistRunUnlocked(workflow.id, run);
    await this.advanceScheduleUnlocked(id);
  }

  // --- Persistence helpers --------------------------------------------------

  private createRunRecord(
    workflow: Workflow,
    revision: WorkflowRevision,
    trigger: WorkflowRunTrigger,
    status: WorkflowRun['status'],
    error?: string,
    retryOfRunId?: string,
  ): WorkflowRun {
    const now = new Date().toISOString();
    const nodeRuns: WorkflowNodeRun[] = workflow.nodes.map((node) => ({
      nodeId: node.id,
      nodeName: node.name,
      nodeType: node.type,
      status: status === 'skipped' ? 'skipped' : 'pending',
    }));
    return {
      id: randomUUID(),
      workflowId: workflow.id,
      trigger,
      status,
      startedAt: now,
      ...(status === 'skipped' ? { finishedAt: now } : {}),
      ...(error ? { error } : {}),
      nodeRuns,
      workflowRevision: revision.revision,
      workflowRevisionId: revision.id,
      definitionHash: revision.definitionHash,
      ...(retryOfRunId ? { retryOfRunId } : {}),
      safeToRetry: false,
      transcript: '',
    };
  }

  private async persistRun(workflowId: string, run: WorkflowRun): Promise<void> {
    await this.withWorkflowLock(workflowId, async () => {
      await this.persistRunUnlocked(workflowId, run);
    });
  }

  private async persistRunUnlocked(workflowId: string, run: WorkflowRun): Promise<void> {
    const workflow = this.workflows.get(workflowId);
    if (!workflow) {
      await this.store.writeRun(run);
      return;
    }
    const finishingActiveRun = this.activeRuns.has(run.id)
      && ['succeeded', 'completed_with_issues', 'failed', 'canceled'].includes(run.status);
    if (!finishingActiveRun) await this.store.writeRun(run);
    const next: Workflow = {
      ...workflow,
      ...(finishingActiveRun ? { running: false } : {}),
      lastRun: toWorkflowRunSummary(run),
      updatedAt: new Date().toISOString(),
    };
    this.workflows.set(workflowId, next);
    await this.saveWorkflows();
    if (finishingActiveRun) await this.store.writeRun(run);
    this.options.onWorkflowUpdated({ workflow: next, run: toWorkflowRunSummary(run) });
  }

  private async markWorkflowRunning(id: string, running: boolean): Promise<void> {
    await this.withWorkflowLock(id, async () => {
      await this.markWorkflowRunningUnlocked(id, running);
    });
  }

  private async markWorkflowRunningUnlocked(id: string, running: boolean): Promise<void> {
    const workflow = this.workflows.get(id);
    if (!workflow) {
      return;
    }
    if (workflow.running === running) return;
    const next: Workflow = { ...workflow, running, updatedAt: new Date().toISOString() };
    this.workflows.set(id, next);
    await this.saveWorkflows();
    this.options.onWorkflowUpdated({ workflow: next });
  }

  private async failInterruptedRuns(): Promise<void> {
    for (const workflow of this.workflows.values()) {
      const lastRun = workflow.lastRun;
      if (!lastRun || !['queued', 'running', 'waiting_approval'].includes(lastRun.status)) {
        continue;
      }
      const run = await this.store.readRun(lastRun.id);
      if (!run) {
        continue;
      }
      run.status = 'failed';
      run.error = 'workflow_interrupted';
      run.finishedAt = new Date().toISOString();
      run.pendingApprovalNodeId = undefined;
      for (const nodeRun of run.nodeRuns) {
        if (!['succeeded', 'failed', 'skipped'].includes(nodeRun.status)) {
          nodeRun.status = 'canceled';
        }
      }
      await this.store.writeRun(run);
      this.workflows.set(workflow.id, {
        ...workflow,
        running: false,
        lastRun: toWorkflowRunSummary(run),
      });
    }
  }

  private clearTimer(id: string): void {
    const timer = this.timers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(id);
    }
  }

  private killChild(child: ChildProcessWithoutNullStreams): void {
    try {
      if (process.platform !== 'win32' && typeof child.pid === 'number') {
        process.kill(-child.pid, 'SIGKILL');
      } else {
        child.kill('SIGKILL');
      }
    } catch {
      try {
        child.kill('SIGKILL');
      } catch {
        // The process already exited.
      }
    }
  }

  private requireWorkflow(id: string): Workflow {
    const workflow = this.workflows.get(id);
    if (!workflow) {
      throw new Error('workflow_not_found');
    }
    return workflow;
  }

  private assertNotDisposed(): void {
    if (this.disposed) throw new Error('workflow_manager_disposed');
  }

  private async withWorkflowLock<T>(workflowId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.workflowOperationTails.get(workflowId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => current, () => current);
    this.workflowOperationTails.set(workflowId, tail);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.workflowOperationTails.get(workflowId) === tail) {
        this.workflowOperationTails.delete(workflowId);
      }
    }
  }

  private trackOperation<T>(operation: Promise<T>): Promise<T> {
    this.inFlightOperations.add(operation);
    operation.finally(() => this.inFlightOperations.delete(operation)).catch(() => undefined);
    return operation;
  }

  private launchRunTask(run: WorkflowRun, execute: () => Promise<void>): void {
    const task = execute();
    this.runTasks.set(run.id, task);
    void task.finally(() => this.runTasks.delete(run.id)).catch(() => undefined);
  }

  private async cancelPreparedRun(workflowId: string, run: WorkflowRun): Promise<void> {
    run.status = 'canceled';
    run.finishedAt = new Date().toISOString();
    for (const nodeRun of run.nodeRuns) {
      if (!['succeeded', 'failed', 'skipped'].includes(nodeRun.status)) nodeRun.status = 'canceled';
    }
    await this.withWorkflowLock(workflowId, async () => {
      const workflow = this.workflows.get(workflowId) as Workflow;
      this.workflows.set(workflowId, { ...workflow, running: false });
      await this.persistRunUnlocked(workflowId, run);
    });
  }

  private cancelActiveRun(active: ActiveRunState): void {
    active.canceled = true;
    for (const resolver of active.approvalResolvers.values()) resolver(false);
    active.approvalResolvers.clear();
    for (const controller of active.actionAbortControllers) controller.abort();
    for (const child of active.children) this.killChild(child);
  }

  private assertWorkflowReadyToApply(workflow: Workflow, input: WorkflowApplyInput): void {
    this.assertExpectedRevision(workflow, input.expectedRevision);
    const definitionHash = workflowDefinitionHash(workflow);
    if (!workflow.review || workflow.review.status !== 'ready') {
      throw new Error('workflow_review_required');
    }
    if (workflow.review.definitionHash !== input.definitionHash || definitionHash !== input.definitionHash) {
      throw new Error('workflow_review_stale');
    }
  }

  private requireRevisions(id: string): WorkflowRevision[] {
    const revisions = this.revisions.get(id);
    if (!revisions) throw new Error('workflow_revision_not_found');
    return revisions;
  }

  private appliedRevisionFor(workflow: Workflow): WorkflowRevision | undefined {
    if (!workflow.appliedRevisionId) return undefined;
    return this.revisions.get(workflow.id)?.find((revision) => revision.id === workflow.appliedRevisionId);
  }

  private requireAppliedRevision(workflow: Workflow): WorkflowRevision {
    const revision = this.appliedRevisionFor(workflow);
    if (!revision) throw new Error('workflow_applied_revision_required');
    return revision;
  }

  private requireRunnableRevision(workflow: Workflow): WorkflowRevision {
    const revision = this.appliedRevisionFor(workflow)
      ?? this.requireRevisions(workflow.id).find((entry) => entry.id === workflow.revisionId);
    if (!revision) throw new Error('workflow_revision_not_found');
    return revision;
  }

  private requireRequestedRevision(workflowId: string, requested: WorkflowRevision): WorkflowRevision {
    const revision = this.requireRevisions(workflowId).find((entry) => entry.id === requested.id);
    if (!revision || revision.definitionHash !== requested.definitionHash) {
      throw new Error('workflow_run_revision_unavailable');
    }
    return revision;
  }

  private appliedWorkflowFor(workflow: Workflow): Workflow {
    return workflowForExecution(workflow, this.requireAppliedRevision(workflow));
  }

  private workflowForRun(run: WorkflowRun): Workflow {
    const current = this.requireWorkflow(run.workflowId);
    const revision = this.requireRevisions(run.workflowId)
      .find((entry) => entry.id === run.workflowRevisionId);
    if (!revision || revision.definitionHash !== run.definitionHash) {
      throw new Error('workflow_run_revision_unavailable');
    }
    return workflowForExecution(current, revision);
  }

  private assertExpectedRevision(workflow: Workflow, expectedRevision: number): void {
    if (!Number.isInteger(expectedRevision) || expectedRevision !== workflow.revision) {
      throw new Error('workflow_revision_conflict');
    }
  }

  private normalizeWorkflow(entry: Workflow): Workflow | null {
    if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string' || !entry.id) {
      return null;
    }
    try {
      const sanitized = sanitizeWorkflowUpsertInput(entry, this.options.getValidToolIds?.());
      if (!sanitized.name) {
        return null;
      }
      validateWorkflowGraph(sanitized.nodes, sanitized.edges);
      const legacy = !Number.isInteger(entry.revision) || entry.revision < 1 || typeof entry.revisionId !== 'string';
      const revision = legacy ? 1 : entry.revision;
      const revisionId = legacy ? randomUUID() : entry.revisionId;
      const enabled = Boolean(entry.enabled) && (!legacy || sanitized.trigger.type === 'scheduled');
      const normalized: Workflow = {
        id: entry.id,
        name: sanitized.name,
        ...(sanitized.description ? { description: sanitized.description } : {}),
        trigger: sanitized.trigger,
        nodes: sanitized.nodes,
        edges: sanitized.edges,
        enabled,
        running: false,
        nextRunAt: enabled
          ? entry.nextRunAt ?? (sanitized.trigger.type === 'scheduled'
              ? computeNextRunAt(sanitized.trigger.frequency)
              : null)
          : null,
        createdAt: entry.createdAt || new Date().toISOString(),
        updatedAt: entry.updatedAt || new Date().toISOString(),
        ...(entry.lastRun ? { lastRun: entry.lastRun } : {}),
        revision,
        revisionId,
        ...(legacy || Number.isInteger(entry.appliedRevision)
          ? { appliedRevision: legacy ? 1 : entry.appliedRevision }
          : {}),
        ...(legacy || (typeof entry.appliedRevisionId === 'string' && entry.appliedRevisionId)
          ? { appliedRevisionId: legacy ? revisionId : entry.appliedRevisionId }
          : {}),
      };
      if (
        !legacy
        && entry.review
        && (entry.review.status === 'ready' || entry.review.status === 'blocked')
        && Array.isArray(entry.review.issues)
        && entry.review.definitionHash === workflowDefinitionHash(normalized)
      ) {
        normalized.review = {
          status: entry.review.status,
          issues: entry.review.issues.filter((issue): issue is string => typeof issue === 'string'),
          definitionHash: entry.review.definitionHash,
        };
      }
      return normalized;
    } catch {
      return null;
    }
  }

  private sortedWorkflows(): Workflow[] {
    return Array.from(this.workflows.values()).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  }

  private async saveWorkflows(): Promise<void> {
    await this.store.saveWorkflows(this.sortedWorkflows());
  }
}

export const friendlyWorkflowFailureMessage = (message: string): string => {
  if (message === 'codex_auth_missing' || message === 'claude_auth_missing' || message === 'antigravity_auth_missing') {
    return 'El flujo no se pudo ejecutar porque el proveedor de agente no tiene una sesion activa.';
  }
  if (message.endsWith('_cli_missing')) {
    return 'El flujo no se pudo ejecutar porque el agente no esta listo en este equipo.';
  }
  if (message === 'workflow_missed_schedule') {
    return 'El flujo no se ejecuto porque Forger no estaba disponible dentro de la ventana configurada.';
  }
  if (message === 'workflow_interrupted') {
    return 'El flujo quedo interrumpido porque Forger se cerro durante la ejecucion.';
  }
  if (message.startsWith('codex_timeout_after_')) {
    return 'Un paso del flujo se detuvo porque tardo demasiado en responder.';
  }
  return 'El flujo no se pudo completar.';
};
