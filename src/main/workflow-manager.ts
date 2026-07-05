import { randomUUID } from 'node:crypto';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import type {
  AgentRuntime,
  AgentRuntimeRequest,
  AppSummary,
  CallOfficialToolInput,
  CallOfficialToolResult,
  FilesActionResult,
  PersonalAgent,
  Workflow,
  WorkflowApproveNodeInput,
  WorkflowConnectorNode,
  WorkflowForgerAgentNode,
  WorkflowLlmAgentNode,
  WorkflowNode,
  WorkflowNodeRun,
  WorkflowRun,
  WorkflowRunSummary,
  WorkflowRunTrigger,
  WorkflowUpdatedEvent,
  WorkflowUpsertInput,
} from '../shared/types';
import {
  appendTranscript,
  parseClaudeAssistantMessages,
  parseCodexAssistantMessages,
  runAgentCommand,
  type LlmAutomationMcpServerConfig,
} from './automation/agent-command-runner';
import {
  computeNextRunAt,
  defaultMissedRunWindowMinutes,
} from './automation-manager';
import { renderPromptFile } from './prompt-builder';
import type { LlmProviderAuthProfileResolver } from './llm-provider/types';
import {
  buildRunContext,
  computeRunOutcome,
  evaluateConditionExpression,
  renderTemplateString,
  resolveNodeReadiness,
  resolveTemplateValue,
  validateWorkflowGraph,
  type WorkflowNodeState,
  type WorkflowRunContext,
} from './workflow/engine';
import { WorkflowStore, toWorkflowRunSummary } from './workflow/store';
import { sanitizeWorkflowUpsertInput } from './workflow/sanitize';
import { validateOutputAgainstSchema } from './workflow/output-schema';

const MAX_TIMEOUT_MS = 2_147_483_647;
const MISSED_RUN_GRACE_MS = 60_000;
const MAX_PARALLEL_NODES = 4;
const DEFAULT_NODE_TIMEOUT_MS = 300_000;
const INPUT_CONTEXT_MAX_CHARS = 12_000;

export interface WorkflowMcpNodeContext {
  workflowId: string;
  workflowName: string;
  runId: string;
  nodeId: string;
  nodeName: string;
  input: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
}

export interface WorkflowNodeCompletion {
  status: 'succeeded' | 'failed';
  output?: Record<string, unknown>;
  summary?: string;
  reason?: string;
}

interface ActiveRunState {
  workflowId: string;
  canceled: boolean;
  children: Set<ChildProcessWithoutNullStreams>;
  approvalResolvers: Map<string, (approved: boolean) => void>;
}

interface WorkflowManagerOptions {
  forgerHomeRoot: string;
  metadataRoot: string;
  codexHome: string;
  providerProfilesRoot?: string;
  resolveAuthProfile?: LlmProviderAuthProfileResolver;
  getAgentRuntime: (requested?: AgentRuntimeRequest) => Promise<AgentRuntime>;
  getInstalledApps: () => AppSummary[];
  getCodexCliPath: () => Promise<string | null>;
  getClaudeCliPath: () => Promise<string | null>;
  getAntigravityCliPath?: () => Promise<string | null>;
  getCodexPathEntries: () => Promise<string[]>;
  getAgentNetworkAccess?: (appIds: string[]) => Promise<boolean>;
  getCodexAuthenticated: () => Promise<boolean>;
  getClaudeAuthenticated: () => Promise<boolean>;
  getAntigravityAuthenticated?: () => Promise<boolean>;
  createForgerMcpSession?: (
    nodeRunKey: string,
    appIds: string[],
    officialToolActionIds: string[],
  ) => { url: string; token: string } | null;
  releaseForgerMcpSession?: (token: string) => void;
  buildMemoryContext?: (appIds: string[]) => Promise<string>;
  listenAppMcps?: (appIds: string[], listenerId: string) => Promise<LlmAutomationMcpServerConfig[]>;
  releaseAppMcps?: (listenerId: string) => void;
  getPersonalAgent?: (agentId: string) => Promise<PersonalAgent | null>;
  callConnectorAction?: (input: CallOfficialToolInput) => Promise<CallOfficialToolResult>;
  getValidToolIds?: () => ReadonlySet<string>;
  onWorkflowUpdated: (event: WorkflowUpdatedEvent) => void;
}

export class WorkflowManager {
  private workflows = new Map<string, Workflow>();
  private timers = new Map<string, NodeJS.Timeout>();
  private activeRuns = new Map<string, ActiveRunState>();
  private nodeContexts = new Map<string, WorkflowMcpNodeContext>();
  private nodeCompletions = new Map<string, WorkflowNodeCompletion>();
  private readonly store: WorkflowStore;

  public constructor(private readonly options: WorkflowManagerOptions) {
    this.store = new WorkflowStore({ metadataRoot: options.metadataRoot });
  }

  public async initialize(): Promise<void> {
    await this.store.initialize();
    const entries = await this.store.readWorkflows();
    for (const entry of entries) {
      const normalized = this.normalizeWorkflow(entry);
      if (normalized) {
        this.workflows.set(normalized.id, normalized);
      }
    }
    await this.failInterruptedRuns();
    await this.saveWorkflows();
    for (const workflow of this.workflows.values()) {
      await this.scheduleWorkflow(workflow.id);
    }
  }

  public dispose(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
  }

  public list(): Workflow[] {
    return this.sortedWorkflows();
  }

  public get(id: string): Workflow | null {
    return this.workflows.get(id) ?? null;
  }

  public async upsert(input: WorkflowUpsertInput): Promise<Workflow> {
    const sanitized = sanitizeWorkflowUpsertInput(input, this.options.getValidToolIds?.());
    if (!sanitized.name.trim()) {
      throw new Error('workflow_name_required');
    }
    validateWorkflowGraph(sanitized.nodes, sanitized.edges);
    const now = new Date().toISOString();
    const current = input.id ? this.workflows.get(input.id) : undefined;
    if (input.id && !current) {
      throw new Error('workflow_not_found');
    }
    const enabled = typeof sanitized.enabled === 'boolean' ? sanitized.enabled : current?.enabled ?? true;
    const workflow: Workflow = {
      id: current?.id ?? randomUUID(),
      name: sanitized.name,
      ...(sanitized.description ? { description: sanitized.description } : {}),
      trigger: sanitized.trigger,
      nodes: sanitized.nodes,
      edges: sanitized.edges,
      enabled,
      running: current?.running ?? false,
      nextRunAt: enabled && sanitized.trigger.type === 'scheduled'
        ? computeNextRunAt(sanitized.trigger.frequency)
        : null,
      createdAt: current?.createdAt ?? now,
      updatedAt: now,
      ...(current?.lastRun ? { lastRun: current.lastRun } : {}),
    };
    this.workflows.set(workflow.id, workflow);
    await this.saveWorkflows();
    await this.scheduleWorkflow(workflow.id);
    this.options.onWorkflowUpdated({ workflow });
    return workflow;
  }

  public async delete(id: string): Promise<FilesActionResult> {
    if (!this.workflows.has(id)) {
      return { success: false, technicalCode: 'workflow_not_found', userMessage: 'No encontramos ese flujo.' };
    }
    this.clearTimer(id);
    this.workflows.delete(id);
    await this.saveWorkflows();
    return { success: true, userMessage: 'Flujo eliminado.' };
  }

  public async setEnabled(id: string, enabled: boolean): Promise<Workflow> {
    const workflow = this.requireWorkflow(id);
    const next: Workflow = {
      ...workflow,
      enabled,
      nextRunAt: enabled && workflow.trigger.type === 'scheduled'
        ? computeNextRunAt(workflow.trigger.frequency)
        : null,
      updatedAt: new Date().toISOString(),
    };
    this.workflows.set(id, next);
    if (!enabled) {
      this.clearTimer(id);
    }
    await this.saveWorkflows();
    await this.scheduleWorkflow(id);
    this.options.onWorkflowUpdated({ workflow: next });
    return next;
  }

  public async runNow(id: string, trigger: WorkflowRunTrigger = 'manual'): Promise<WorkflowRunSummary> {
    return await this.startRun(id, trigger);
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
    active.canceled = true;
    for (const resolver of active.approvalResolvers.values()) {
      resolver(false);
    }
    active.approvalResolvers.clear();
    for (const child of active.children) {
      this.killChild(child);
    }
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
    return this.nodeContexts.get(nodeRunKey) ?? null;
  }

  public completeNodeFromMcp(
    nodeRunKey: string,
    args: { output?: unknown; summary?: unknown },
  ): { success: boolean; errors?: string[]; technicalCode?: string } {
    const context = this.nodeContexts.get(nodeRunKey);
    if (!context) {
      return { success: false, technicalCode: 'workflow_node_context_not_found' };
    }
    const output = args.output && typeof args.output === 'object' && !Array.isArray(args.output)
      ? args.output as Record<string, unknown>
      : {};
    if (context.outputSchema) {
      const errors = validateOutputAgainstSchema(output, context.outputSchema);
      if (errors.length > 0) {
        return { success: false, errors, technicalCode: 'workflow_output_schema_invalid' };
      }
    }
    this.nodeCompletions.set(nodeRunKey, {
      status: 'succeeded',
      output,
      summary: typeof args.summary === 'string' ? args.summary.trim().slice(0, 2_000) : undefined,
    });
    return { success: true };
  }

  public failNodeFromMcp(
    nodeRunKey: string,
    args: { reason?: unknown },
  ): { success: boolean; technicalCode?: string } {
    const context = this.nodeContexts.get(nodeRunKey);
    if (!context) {
      return { success: false, technicalCode: 'workflow_node_context_not_found' };
    }
    const reason = typeof args.reason === 'string' && args.reason.trim()
      ? args.reason.trim().slice(0, 2_000)
      : 'workflow_node_reported_failure';
    this.nodeCompletions.set(nodeRunKey, { status: 'failed', reason });
    return { success: true };
  }

  // --- Run execution -----------------------------------------------------

  private async startRun(id: string, trigger: WorkflowRunTrigger): Promise<WorkflowRunSummary> {
    const workflow = this.requireWorkflow(id);
    if (workflow.running) {
      const skipped = this.createRunRecord(workflow, trigger, 'skipped', 'workflow_already_running');
      await this.persistRun(workflow.id, skipped);
      return toWorkflowRunSummary(skipped);
    }
    const run = this.createRunRecord(workflow, trigger, 'queued');
    await this.store.appendRunId(workflow.id, run.id);
    await this.persistRun(workflow.id, run);
    await this.markWorkflowRunning(workflow.id, true);
    void this.executeRun(workflow.id, run);
    return toWorkflowRunSummary(run);
  }

  private async executeRun(workflowId: string, run: WorkflowRun): Promise<void> {
    const active: ActiveRunState = {
      workflowId,
      canceled: false,
      children: new Set(),
      approvalResolvers: new Map(),
    };
    this.activeRuns.set(run.id, active);
    const transcriptPath = this.store.runTranscriptPath(run.id);
    try {
      const workflow = this.requireWorkflow(workflowId);
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
        if (!node || !state) {
          return;
        }
        const nodeRun = run.nodeRuns.find((entry) => entry.nodeId === nodeId);
        if (nodeRun) {
          nodeRun.status = state.status;
          nodeRun.output = state.output;
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
          const promise = this.executeNode(workflow, run, node, states, triggerContext, active, transcriptPath, syncNodeRun)
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
      this.activeRuns.delete(run.id);
      await this.markWorkflowRunning(workflowId, false);
      await this.scheduleWorkflow(workflowId);
    }
  }

  private async executeNode(
    workflow: Workflow,
    run: WorkflowRun,
    node: WorkflowNode,
    states: Record<string, WorkflowNodeState>,
    triggerContext: Record<string, unknown>,
    active: ActiveRunState,
    transcriptPath: string,
    syncNodeRun: (nodeId: string) => Promise<void>,
  ): Promise<void> {
    const context = buildRunContext(triggerContext, states);

    if (node.requiresApproval) {
      states[node.id] = { status: 'waiting_approval' };
      await syncNodeRun(node.id);
      const approved = await new Promise<boolean>((resolve) => {
        active.approvalResolvers.set(node.id, resolve);
      });
      if (active.canceled) {
        states[node.id] = { status: 'canceled' };
        await syncNodeRun(node.id);
        return;
      }
      if (!approved) {
        states[node.id] = { status: 'failed', error: 'workflow_node_approval_denied' };
        await syncNodeRun(node.id);
        return;
      }
    }

    states[node.id] = { status: 'running' };
    await syncNodeRun(node.id);
    await appendTranscript(transcriptPath, 'meta', `[node:${node.id}] ${node.name} (${node.type}) started`);

    let result: WorkflowNodeState;
    if (node.type === 'condition') {
      const value = evaluateConditionExpression(node.expression, context);
      result = { status: 'succeeded', output: { result: value }, summary: value ? 'Condicion verdadera' : 'Condicion falsa' };
    } else if (node.type === 'connector') {
      result = await this.executeConnectorNode(node, context);
    } else if (node.type === 'forger_agent') {
      result = await this.executeForgerAgentNode(workflow, run, node, context, active, transcriptPath);
    } else {
      result = await this.executeLlmNode(workflow, run, node, context, active, transcriptPath);
    }

    if (active.canceled && result.status === 'failed') {
      result = { status: 'canceled' };
    }
    states[node.id] = result;
    await appendTranscript(
      transcriptPath,
      'meta',
      `[node:${node.id}] finished with status ${result.status}${result.error ? `: ${result.error}` : ''}`,
    );
    await syncNodeRun(node.id);
  }

  private async executeConnectorNode(
    node: WorkflowConnectorNode,
    context: WorkflowRunContext,
  ): Promise<WorkflowNodeState> {
    if (!this.options.callConnectorAction) {
      return { status: 'failed', error: 'workflow_connectors_unavailable' };
    }
    const input = resolveTemplateValue(node.input, context) as Record<string, unknown>;
    const nodeRunInput = { toolId: node.toolId, actionId: node.actionId, input };
    try {
      const result = await this.options.callConnectorAction(nodeRunInput);
      if (!result.success) {
        return {
          status: 'failed',
          error: result.technicalCode ?? result.userMessage ?? 'workflow_connector_failed',
        };
      }
      const output = result.data && typeof result.data === 'object' && !Array.isArray(result.data)
        ? result.data as Record<string, unknown>
        : { value: result.data ?? null };
      return { status: 'succeeded', output, summary: result.userMessage };
    } catch (error) {
      return {
        status: 'failed',
        error: error instanceof Error ? error.message : 'workflow_connector_failed',
      };
    }
  }

  private async executeForgerAgentNode(
    workflow: Workflow,
    run: WorkflowRun,
    node: WorkflowForgerAgentNode,
    context: WorkflowRunContext,
    active: ActiveRunState,
    transcriptPath: string,
  ): Promise<WorkflowNodeState> {
    const agent = await (this.options.getPersonalAgent?.(node.agentId) ?? Promise.resolve(null));
    if (!agent) {
      return { status: 'failed', error: 'workflow_personal_agent_not_found' };
    }
    return await this.runAgentNode(workflow, run, node, context, active, transcriptPath, {
      prompt: node.prompt,
      runtime: agent.runtime,
      appIds: agent.appIds,
      toolIds: agent.toolIds,
      permissionMode: agent.permissionMode,
      networkAccess: agent.networkAccess,
      instructions: [agent.purpose, agent.instructions].filter(Boolean).join('\n\n'),
      outputSchema: node.outputSchema,
    });
  }

  private async executeLlmNode(
    workflow: Workflow,
    run: WorkflowRun,
    node: WorkflowLlmAgentNode,
    context: WorkflowRunContext,
    active: ActiveRunState,
    transcriptPath: string,
  ): Promise<WorkflowNodeState> {
    return await this.runAgentNode(workflow, run, node, context, active, transcriptPath, {
      prompt: node.prompt,
      runtime: node.runtime,
      appIds: node.appIds,
      toolIds: node.toolIds,
      outputSchema: node.outputSchema,
    });
  }

  private async runAgentNode(
    workflow: Workflow,
    run: WorkflowRun,
    node: WorkflowNode,
    context: WorkflowRunContext,
    active: ActiveRunState,
    transcriptPath: string,
    config: {
      prompt: string;
      runtime?: AgentRuntime;
      appIds: string[];
      toolIds: string[];
      permissionMode?: AgentRuntime['permissionMode'];
      networkAccess?: boolean;
      instructions?: string;
      outputSchema?: Record<string, unknown>;
    },
  ): Promise<WorkflowNodeState> {
    const nodeRunKey = `${run.id}:${node.id}`;
    let forgerMcpSession: { url: string; token: string } | null = null;
    let appMcpListening = false;
    try {
      const runtimeRequest = config.runtime ? { ...config.runtime, strict: true as const } : undefined;
      const runtime = await this.options.getAgentRuntime(runtimeRequest);
      await this.assertProviderReady(runtime);
      const providerCliPath = await this.resolveProviderCliPath(runtime);
      const pathEntries = await this.options.getCodexPathEntries();

      const inputContext = {
        trigger: context.trigger,
        nodes: Object.fromEntries(
          Object.entries(context.nodes)
            .filter(([, state]) => state.status === 'succeeded' || state.status === 'failed')
            .map(([nodeId, state]) => [nodeId, {
              status: state.status,
              output: state.output ?? null,
              summary: state.summary ?? null,
              error: state.error ?? null,
            }]),
        ),
      };
      this.nodeContexts.set(nodeRunKey, {
        workflowId: workflow.id,
        workflowName: workflow.name,
        runId: run.id,
        nodeId: node.id,
        nodeName: node.name,
        input: inputContext,
        ...(config.outputSchema ? { outputSchema: config.outputSchema } : {}),
      });
      this.nodeCompletions.delete(nodeRunKey);

      forgerMcpSession = this.options.createForgerMcpSession?.(nodeRunKey, config.appIds, config.toolIds) ?? null;
      const appMcpServers = await (this.options.listenAppMcps?.(config.appIds, nodeRunKey) ?? Promise.resolve([]));
      appMcpListening = true;
      const mcpServers: LlmAutomationMcpServerConfig[] = [
        ...(forgerMcpSession
          ? [{
              name: 'forger',
              url: forgerMcpSession.url,
              token: forgerMcpSession.token,
              tokenEnvVar: 'FORGER_MCP_TOKEN',
              toolTimeoutSec: 600,
            }]
          : []),
        ...appMcpServers,
      ];
      const networkAccess = config.networkAccess
        ?? await (this.options.getAgentNetworkAccess?.(config.appIds) ?? Promise.resolve(false));
      const memoryContext = await (this.options.buildMemoryContext?.(config.appIds) ?? Promise.resolve(''));
      const basePrompt = this.buildNodePrompt(workflow, node, config, context, inputContext);
      const prompt = [memoryContext, config.instructions, basePrompt].filter(Boolean).join('\n\n');

      let assistantMessages: string[] = [];
      const result = await runAgentCommand({ cliPath: providerCliPath, pathEntries }, {
        runtime: config.permissionMode ? { ...runtime, permissionMode: config.permissionMode } : runtime,
        cwd: this.options.forgerHomeRoot,
        codexHome: this.options.codexHome,
        providerProfilesRoot: this.options.providerProfilesRoot,
        resolveAuthProfile: this.options.resolveAuthProfile,
        prompt,
        transcriptPath,
        mcpServers,
        networkAccess,
        timeoutMs: node.timeoutMs ?? DEFAULT_NODE_TIMEOUT_MS,
        onChild: (child) => {
          active.children.add(child);
          child.once('exit', () => active.children.delete(child));
        },
        onAssistantMessages: (messages) => {
          assistantMessages = messages;
        },
      });

      const completion = this.nodeCompletions.get(nodeRunKey);
      if (completion) {
        if (completion.status === 'failed') {
          return { status: 'failed', error: completion.reason ?? 'workflow_node_reported_failure' };
        }
        return {
          status: 'succeeded',
          output: completion.output ?? {},
          summary: completion.summary ?? assistantMessages[assistantMessages.length - 1]?.slice(0, 2_000),
        };
      }

      const parsedMessages = runtime.provider === 'claude'
        ? parseClaudeAssistantMessages(result.stdout, result.stderr)
        : runtime.provider === 'antigravity'
          ? [result.stdout.trim()].filter(Boolean)
          : parseCodexAssistantMessages(result.stdout, result.stderr);
      const lastMessage = parsedMessages[parsedMessages.length - 1]
        ?? assistantMessages[assistantMessages.length - 1]
        ?? '';
      if (result.code !== 0) {
        return {
          status: 'failed',
          error: (result.stderr || result.stdout || 'workflow_agent_exec_failed').trim().slice(0, 2_000),
        };
      }
      // The agent finished without reporting through MCP: fall back to its
      // final message so downstream nodes still receive usable output.
      return {
        status: 'succeeded',
        output: { text: lastMessage },
        summary: lastMessage.slice(0, 2_000),
      };
    } finally {
      this.nodeContexts.delete(nodeRunKey);
      this.nodeCompletions.delete(nodeRunKey);
      if (forgerMcpSession) {
        this.options.releaseForgerMcpSession?.(forgerMcpSession.token);
      }
      if (appMcpListening) {
        this.options.releaseAppMcps?.(nodeRunKey);
      }
    }
  }

  private buildNodePrompt(
    workflow: Workflow,
    node: WorkflowNode,
    config: { prompt: string; appIds: string[]; outputSchema?: Record<string, unknown> },
    context: WorkflowRunContext,
    inputContext: Record<string, unknown>,
  ): string {
    const installedApps = this.options.getInstalledApps();
    const selected = installedApps.filter((appEntry) => config.appIds.includes(appEntry.id));
    const appLines = selected.length > 0
      ? selected.map((appEntry) =>
          [
            `- ${appEntry.name ?? appEntry.id} (id: ${appEntry.id})`,
            `  Status: ${appEntry.status}`,
            `  Description: ${appEntry.description ?? ''}`,
            `  Relative workspace: ${path.posix.join('apps', appEntry.id)}`,
          ].join('\n'),
        )
      : ['- No included apps.'];
    const serializedInput = JSON.stringify(inputContext, null, 2);
    const truncatedInput = serializedInput.length > INPUT_CONTEXT_MAX_CHARS
      ? `${serializedInput.slice(0, INPUT_CONTEXT_MAX_CHARS)}\n... (truncated, call workflow_get_context for the full input)`
      : serializedInput;
    const outputSchemaSection = config.outputSchema
      ? `## Expected Output Schema\n\n\`\`\`json\n${JSON.stringify(config.outputSchema, null, 2)}\n\`\`\``
      : '';
    return renderPromptFile('workflows/llm-node.md', {
      workflowName: workflow.name,
      nodeName: node.name,
      nodeId: node.id,
      forgerPartial: renderPromptFile('partials/forger.md', {}),
      outputSchemaSection,
      appLines: appLines.join('\n'),
      inputContext: truncatedInput,
      userInstruction: renderTemplateString(config.prompt, context),
    });
  }

  private async assertProviderReady(runtime: AgentRuntime): Promise<void> {
    if (runtime.provider === 'antigravity') {
      if (!(await (this.options.getAntigravityAuthenticated?.() ?? Promise.resolve(false)))) {
        throw new Error('antigravity_auth_missing');
      }
      return;
    }
    if (runtime.provider === 'claude') {
      if (!(await this.options.getClaudeAuthenticated())) {
        throw new Error('claude_auth_missing');
      }
      return;
    }
    if (!(await this.options.getCodexAuthenticated())) {
      throw new Error('codex_auth_missing');
    }
  }

  private async resolveProviderCliPath(runtime: AgentRuntime): Promise<string> {
    if (runtime.provider === 'claude') {
      const cliPath = await this.options.getClaudeCliPath();
      if (!cliPath) {
        throw new Error('claude_cli_missing');
      }
      return cliPath;
    }
    if (runtime.provider === 'antigravity') {
      const cliPath = await (this.options.getAntigravityCliPath?.() ?? Promise.resolve(null));
      if (!cliPath) {
        throw new Error('antigravity_cli_missing');
      }
      return cliPath;
    }
    const cliPath = await this.options.getCodexCliPath();
    if (!cliPath) {
      throw new Error('codex_cli_missing');
    }
    return cliPath;
  }

  // --- Scheduling ---------------------------------------------------------

  private async scheduleWorkflow(id: string): Promise<void> {
    this.clearTimer(id);
    const workflow = this.workflows.get(id);
    if (!workflow?.enabled || workflow.trigger.type !== 'scheduled' || !workflow.nextRunAt) {
      return;
    }
    const dueAt = Date.parse(workflow.nextRunAt);
    if (!Number.isFinite(dueAt)) {
      await this.skipMissedRun(id, 'workflow_invalid_schedule');
      return;
    }
    const delay = dueAt - Date.now();
    if (delay <= 0) {
      await this.handleDueScheduledRun(id);
      return;
    }
    const timer = setTimeout(() => {
      void this.scheduleWorkflow(id);
    }, Math.min(delay, MAX_TIMEOUT_MS));
    this.timers.set(id, timer);
  }

  private async handleDueScheduledRun(id: string): Promise<void> {
    const workflow = this.workflows.get(id);
    if (!workflow?.enabled || workflow.trigger.type !== 'scheduled' || !workflow.nextRunAt) {
      return;
    }
    const dueAt = Date.parse(workflow.nextRunAt);
    const latenessMs = Date.now() - dueAt;
    const missedRunPolicy = workflow.trigger.missedRunPolicy ?? 'within_window';
    if (latenessMs <= MISSED_RUN_GRACE_MS || missedRunPolicy === 'always') {
      await this.advanceSchedule(id);
      void this.startRun(id, 'scheduled');
      return;
    }
    if (missedRunPolicy === 'within_window') {
      const windowMs = (workflow.trigger.missedRunWindowMinutes
        ?? defaultMissedRunWindowMinutes(workflow.trigger.frequency)) * 60_000;
      if (latenessMs <= windowMs) {
        await this.advanceSchedule(id);
        void this.startRun(id, 'scheduled');
        return;
      }
    }
    await this.skipMissedRun(id, 'workflow_missed_schedule');
  }

  private async advanceSchedule(id: string): Promise<void> {
    const workflow = this.workflows.get(id);
    if (!workflow || workflow.trigger.type !== 'scheduled') {
      return;
    }
    const next: Workflow = {
      ...workflow,
      nextRunAt: workflow.enabled ? computeNextRunAt(workflow.trigger.frequency) : null,
      updatedAt: new Date().toISOString(),
    };
    this.workflows.set(id, next);
    await this.saveWorkflows();
    await this.scheduleWorkflow(id);
  }

  private async skipMissedRun(id: string, error: string): Promise<void> {
    const workflow = this.workflows.get(id);
    if (!workflow) {
      return;
    }
    const run = this.createRunRecord(workflow, 'scheduled', 'skipped', error);
    await this.store.appendRunId(workflow.id, run.id);
    await this.persistRun(workflow.id, run);
    await this.advanceSchedule(id);
  }

  // --- Persistence helpers --------------------------------------------------

  private createRunRecord(
    workflow: Workflow,
    trigger: WorkflowRunTrigger,
    status: WorkflowRun['status'],
    error?: string,
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
      transcript: '',
    };
  }

  private async persistRun(workflowId: string, run: WorkflowRun): Promise<void> {
    await this.store.writeRun(run);
    const workflow = this.workflows.get(workflowId);
    if (!workflow) {
      return;
    }
    const next: Workflow = {
      ...workflow,
      lastRun: toWorkflowRunSummary(run),
      updatedAt: new Date().toISOString(),
    };
    this.workflows.set(workflowId, next);
    await this.saveWorkflows();
    this.options.onWorkflowUpdated({ workflow: next, run: toWorkflowRunSummary(run) });
  }

  private async markWorkflowRunning(id: string, running: boolean): Promise<void> {
    const workflow = this.workflows.get(id);
    if (!workflow) {
      return;
    }
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
      const enabled = Boolean(entry.enabled);
      return {
        id: entry.id,
        name: sanitized.name,
        ...(sanitized.description ? { description: sanitized.description } : {}),
        trigger: sanitized.trigger,
        nodes: sanitized.nodes,
        edges: sanitized.edges,
        enabled,
        running: false,
        nextRunAt: enabled && sanitized.trigger.type === 'scheduled'
          ? entry.nextRunAt ?? computeNextRunAt(sanitized.trigger.frequency)
          : null,
        createdAt: entry.createdAt || new Date().toISOString(),
        updatedAt: entry.updatedAt || new Date().toISOString(),
        ...(entry.lastRun ? { lastRun: entry.lastRun } : {}),
      };
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
