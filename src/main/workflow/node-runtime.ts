import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import type {
  AgentRunActivity,
  AgentRuntime,
  AgentRuntimeRequest,
  AppSummary,
  CallConnectionActionInput,
  CallConnectionActionResult,
  CallOfficialToolInput,
  CallOfficialToolResult,
  ConnectionSessionGrant,
  PersonalAgent,
  Workflow,
  WorkflowConnectionNode,
  WorkflowForgerAgentNode,
  WorkflowForgerToolNode,
  WorkflowLlmAgentNode,
  WorkflowNode,
  WorkflowRun,
} from '../../shared/types';
import type {
  WorkflowAppActionCallInput,
  WorkflowAppActionDefinition,
  WorkflowAppActionNode,
} from '../../shared/types/workflows';
import {
  appendTranscript,
  parseClaudeAssistantMessages,
  parseCodexAssistantMessages,
  runAgentCommand,
  type LlmAutomationMcpServerConfig,
} from '../automation/agent-command-runner';
import {
  appendProviderActivity,
  createAgentRunActivity,
  finalizeAgentRunActivity,
  persistAgentRunActivity,
} from '../chat/agent-run-activity';
import type { LlmProviderAuthProfileResolver } from '../llm-provider/types';
import { renderPromptFile } from '../prompt-builder';
import {
  buildRunContext,
  evaluateConditionExpression,
  lookupContextPath,
  renderTemplateString,
  resolveTemplateValue,
  type WorkflowNodeState,
  type WorkflowRunContext,
} from './engine';
import {
  createWorkflowValueReceipt,
  validateOutputAgainstSchema,
  validateWorkflowStructuredValueLimits,
} from './output-schema';
import {
  assertAuthenticWorkflowAppAction,
  workflowAppActionContractValue,
} from './revisions';

const MAX_FOREACH_ITEMS = 100;
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

export interface ActiveRunState {
  workflowId: string;
  canceled: boolean;
  children: Set<ChildProcessWithoutNullStreams>;
  actionAbortControllers: Set<AbortController>;
  approvalResolvers: Map<string, (approved: boolean) => void>;
}

export interface WorkflowNodeRuntimeOptions {
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
    forgerToolActionIds: string[],
    connectionGrants: ConnectionSessionGrant[],
  ) => { url: string; token: string } | null;
  releaseForgerMcpSession?: (token: string) => void;
  buildMemoryContext?: (appIds: string[]) => Promise<string>;
  listenAppMcps?: (appIds: string[], listenerId: string) => Promise<LlmAutomationMcpServerConfig[]>;
  listenRequiredAppMcps?: (
    appIds: string[],
    listenerId: string,
  ) => Promise<{
    servers: Array<{ appId: string; config: LlmAutomationMcpServerConfig }>;
    failures: Array<{ appId: string; code: string }>;
  }>;
  releaseAppMcps?: (listenerId: string) => void;
  getPersonalAgent?: (agentId: string) => Promise<PersonalAgent | null>;
  callForgerToolAction?: (input: CallOfficialToolInput) => Promise<CallOfficialToolResult>;
  callConnectionAction?: (input: CallConnectionActionInput) => Promise<CallConnectionActionResult>;
  callConnectorAction?: (input: CallOfficialToolInput) => Promise<CallOfficialToolResult>;
  listAppActions?: (appId: string) => Promise<WorkflowAppActionDefinition[]>;
  callAppAction?: (input: WorkflowAppActionCallInput) => Promise<unknown>;
  preflightAppActions?: (nodes: WorkflowAppActionNode[], runId: string) => Promise<void>;
  releaseAppActions?: (runId: string) => void | Promise<void>;
  onAgentRunActivity?: (activity: AgentRunActivity) => void;
  persistAgentRunActivity?: (activity: AgentRunActivity) => Promise<void>;
}

export class WorkflowNodeRuntime {
  private nodeContexts = new Map<string, WorkflowMcpNodeContext>();
  private nodeCompletions = new Map<string, WorkflowNodeCompletion>();
  private activityPersistenceTail: Promise<void> = Promise.resolve();
  private readonly backgroundFailures: unknown[] = [];

  public constructor(private readonly options: WorkflowNodeRuntimeOptions) {}

  public async flushActivityPersistence(): Promise<void> {
    await this.activityPersistenceTail;
    if (this.backgroundFailures.length > 0) {
      throw new AggregateError(this.backgroundFailures, 'workflow_background_task_failed');
    }
  }

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

  public async executeNode(
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
    const debugInput = this.buildNodeDebugInput(node, context);

    if (this.requiresApproval(node)) {
      const approval = new Promise<boolean>((resolve) => {
        if (active.canceled) resolve(false);
        else active.approvalResolvers.set(node.id, resolve);
      });
      try {
        states[node.id] = { status: 'waiting_approval', input: debugInput };
        await syncNodeRun(node.id);
        if (active.canceled) {
          states[node.id] = { status: 'canceled', input: debugInput };
          await syncNodeRun(node.id);
          return;
        }
        const approved = await approval;
        if (active.canceled) {
          states[node.id] = { status: 'canceled', input: debugInput };
          await syncNodeRun(node.id);
          return;
        }
        if (!approved) {
          states[node.id] = { status: 'failed', input: debugInput, error: 'workflow_node_approval_denied' };
          await syncNodeRun(node.id);
          return;
        }
      } finally {
        active.approvalResolvers.delete(node.id);
      }
    }

    states[node.id] = { status: 'running', input: debugInput };
    await syncNodeRun(node.id);
    if (active.canceled) {
      states[node.id] = { status: 'canceled', input: debugInput };
      await syncNodeRun(node.id);
      return;
    }
    await appendTranscript(transcriptPath, 'meta', `[node:${node.id}] ${node.name} (${node.type}) started`);
    if (active.canceled) {
      states[node.id] = { status: 'canceled', input: debugInput };
      await syncNodeRun(node.id);
      return;
    }

    let result = node.forEach
      ? await this.executeNodeForEach(workflow, run, node, context, active, transcriptPath)
      : await this.executeNodeOnce(workflow, run, node, context, active, transcriptPath);

    if (active.canceled && result.status === 'failed') {
      result = { status: 'canceled', input: result.input ?? debugInput };
    }
    states[node.id] = { ...result, input: result.input ?? debugInput };
    await appendTranscript(
      transcriptPath,
      'meta',
      `[node:${node.id}] finished with status ${result.status}${result.error ? `: ${result.error}` : ''}`,
    );
    await syncNodeRun(node.id);
  }

  public async preflightAppActionNodes(nodes: WorkflowNode[], runId: string): Promise<void> {
    const actionNodes = nodes.filter((node): node is WorkflowAppActionNode => node.type === 'app_action');
    if (actionNodes.length === 0) {
      return;
    }
    if (!this.options.callAppAction) {
      throw new Error('workflow_app_actions_unavailable');
    }
    if (this.options.preflightAppActions) {
      await this.options.preflightAppActions(actionNodes, runId);
      return;
    }
    if (!this.options.listAppActions) {
      throw new Error('workflow_app_actions_unavailable');
    }
    const appIds = Array.from(new Set(actionNodes.map((node) => node.appId)));
    const discovered = await Promise.allSettled(appIds.map(async (appId) => ({
      appId,
      actions: await this.options.listAppActions!(appId),
    })));
    if (discovered.some((result) => result.status === 'rejected')) {
      throw new Error('workflow_app_action_discovery_failed');
    }
    const actionsByApp = new Map(discovered.map((result) => {
      const value = (result as PromiseFulfilledResult<{
        appId: string;
        actions: WorkflowAppActionDefinition[];
      }>).value;
      return [value.appId, value.actions] as const;
    }));
    for (const node of actionNodes) {
      const live = actionsByApp.get(node.appId)?.find((action) => action.toolName === node.toolName);
      if (!live) {
        throw new Error('workflow_app_action_not_found');
      }
      if (live.contractHash !== node.action.contractHash) {
        throw new Error('workflow_app_action_contract_changed');
      }
    }
  }

  public persistedNodeRunValue(
    node: WorkflowNode,
    value: Record<string, unknown> | undefined,
  ): Record<string, unknown> | undefined {
    if (value === undefined || node.type !== 'app_action') {
      return value;
    }
    return createWorkflowValueReceipt(value);
  }

  public assertAuthenticAppActionNodes(nodes: WorkflowNode[]): void {
    for (const node of nodes) {
      if (node.type !== 'app_action') continue;
      assertAuthenticWorkflowAppAction(node.toolName, node.action);
      if (
        validateWorkflowStructuredValueLimits(node.input).length > 0
        || validateWorkflowStructuredValueLimits(workflowAppActionContractValue(node.toolName, node.action)).length > 0
      ) {
        throw new Error('workflow_app_action_contract_limits_exceeded');
      }
    }
  }

  public async resolveLiveAppActionNodes(nodes: WorkflowNode[]): Promise<WorkflowNode[]> {
    this.assertAuthenticAppActionNodes(nodes);
    const actionNodes = nodes.filter((node): node is WorkflowAppActionNode => node.type === 'app_action');
    if (actionNodes.length === 0 || !this.options.listAppActions) return nodes;
    const appIds = [...new Set(actionNodes.map((node) => node.appId))];
    const discovered = await Promise.all(appIds.map(async (appId) => [
      appId,
      await this.options.listAppActions!(appId),
    ] as const));
    const actionsByApp = new Map(discovered);
    return nodes.map((node) => {
      if (node.type !== 'app_action') return node;
      const live = actionsByApp.get(node.appId)?.find((action) => action.toolName === node.toolName);
      if (!live) throw new Error('workflow_app_action_not_found');
      assertAuthenticWorkflowAppAction(live.toolName, live);
      if (validateWorkflowStructuredValueLimits(workflowAppActionContractValue(live.toolName, live)).length > 0) {
        throw new Error('workflow_app_action_contract_limits_exceeded');
      }
      if (live.contractHash !== node.action.contractHash) {
        throw new Error('workflow_app_action_contract_changed');
      }
      const { toolName: _toolName, ...action } = live;
      return { ...node, action };
    });
  }

  public assertLiveAppActionNodesMatch(storedNodes: WorkflowNode[], liveNodes: WorkflowNode[]): void {
    const liveById = new Map(liveNodes.map((node) => [node.id, node]));
    for (const stored of storedNodes) {
      if (stored.type !== 'app_action') continue;
      const live = liveById.get(stored.id);
      if (
        live?.type !== 'app_action'
        || live.appId !== stored.appId
        || live.toolName !== stored.toolName
        || live.action.contractHash !== stored.action.contractHash
      ) {
        throw new Error('workflow_app_action_contract_changed');
      }
    }
  }

  private buildAgentInputContext(context: WorkflowRunContext): Record<string, unknown> {
    const iteration = context as unknown as { item?: unknown; itemIndex?: number };
    return {
      trigger: context.trigger,
      ...(iteration.item !== undefined ? { item: iteration.item, itemIndex: iteration.itemIndex } : {}),
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
  }

  private buildNodeDebugInput(node: WorkflowNode, context: WorkflowRunContext): Record<string, unknown> {
    if (node.type === 'app_action') {
      return {
        appId: node.appId,
        toolName: node.toolName,
        input: resolveTemplateValue(node.input, context) as Record<string, unknown>,
      };
    }
    if (node.type === 'forger_tool') {
      return {
        toolId: node.toolId,
        actionId: node.toolId,
        input: resolveTemplateValue(node.input, context) as Record<string, unknown>,
      };
    }
    if (node.type === 'connection') {
      return {
        type: node.connectionType,
        actionId: node.actionId,
        ...(node.connectionId ? { connectionId: node.connectionId } : {}),
        input: resolveTemplateValue(node.input, context) as Record<string, unknown>,
      };
    }
    if (node.type === 'llm_agent' || node.type === 'forger_agent') {
      const inputContext = this.buildAgentInputContext(context);
      return {
        inputContext,
        renderedPrompt: renderTemplateString(node.prompt, context),
      };
    }
    return { expression: node.expression };
  }

  private requiresApproval(node: WorkflowNode): boolean {
    return node.requiresApproval === true || node.type === 'app_action';
  }

  private async executeNodeOnce(
    workflow: Workflow,
    run: WorkflowRun,
    node: WorkflowNode,
    context: WorkflowRunContext,
    active: ActiveRunState,
    transcriptPath: string,
  ): Promise<WorkflowNodeState> {
    if (node.type === 'condition') {
      const value = evaluateConditionExpression(node.expression, context);
      return { status: 'succeeded', output: { result: value }, summary: value ? 'Condicion verdadera' : 'Condicion falsa' };
    }
    if (node.type === 'app_action') {
      return await this.executeAppActionNode(run, node, context, active);
    }
    if (node.type === 'forger_tool') {
      return await this.executeForgerToolNode(node, context);
    }
    if (node.type === 'connection') {
      return await this.executeConnectionNode(node, context);
    }
    if (node.type === 'forger_agent') {
      return await this.executeForgerAgentNode(workflow, run, node, context, active, transcriptPath);
    }
    return await this.executeLlmNode(workflow, run, node, context, active, transcriptPath);
  }

  private async executeAppActionNode(
    run: WorkflowRun,
    node: WorkflowAppActionNode,
    context: WorkflowRunContext,
    active: ActiveRunState,
  ): Promise<WorkflowNodeState> {
    if (!this.options.callAppAction) {
      return { status: 'failed', error: 'workflow_app_actions_unavailable' };
    }
    const input = resolveTemplateValue(node.input, context) as Record<string, unknown>;
    const nodeRunInput = { appId: node.appId, toolName: node.toolName, input };
    if (validateOutputAgainstSchema(input, node.action.inputSchema).length > 0) {
      return { status: 'failed', input: nodeRunInput, error: 'workflow_app_action_input_schema_invalid' };
    }
    const controller = new AbortController();
    active.actionAbortControllers.add(controller);
    try {
      const result = await this.options.callAppAction({
        ...nodeRunInput,
        expectedContractHash: node.action.contractHash,
        timeoutMs: node.timeoutMs ?? DEFAULT_NODE_TIMEOUT_MS,
        runId: run.id,
        nodeId: node.id,
        signal: controller.signal,
      });
      if (!result || typeof result !== 'object' || Array.isArray(result)) {
        return { status: 'failed', input: nodeRunInput, error: 'workflow_app_action_output_schema_invalid' };
      }
      const output = result as Record<string, unknown>;
      if (validateWorkflowStructuredValueLimits(output).length > 0) {
        return { status: 'failed', input: nodeRunInput, error: 'workflow_app_action_output_limits_exceeded' };
      }
      if (validateOutputAgainstSchema(output, node.action.outputSchema).length > 0) {
        return { status: 'failed', input: nodeRunInput, error: 'workflow_app_action_output_schema_invalid' };
      }
      return { status: 'succeeded', input: nodeRunInput, output };
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      const stableError = message === 'app_mcp_structured_content_invalid'
        ? 'workflow_app_action_output_limits_exceeded'
        : message.startsWith('workflow_app_action_')
          ? message
          : 'workflow_app_action_call_failed';
      return {
        status: active.canceled ? 'canceled' : 'failed',
        input: nodeRunInput,
        ...(!active.canceled
          ? { error: stableError }
          : {}),
      };
    } finally {
      active.actionAbortControllers.delete(controller);
    }
  }

  /**
   * Runs a node once per item of the referenced upstream list. Iterations
   * are sequential, expose {{item.*}} and {{itemIndex}} to templates, stop
   * at the first failure, and aggregate into { items, count }. Condition
   * nodes also aggregate a top-level result (true when every item passed)
   * so their branching edges keep working.
   */
  private async executeNodeForEach(
    workflow: Workflow,
    run: WorkflowRun,
    node: WorkflowNode,
    context: WorkflowRunContext,
    active: ActiveRunState,
    transcriptPath: string,
  ): Promise<WorkflowNodeState> {
    const listPath = (node.forEach as string).replace(/^\{\{\s*/, '').replace(/\s*\}\}$/, '');
    const list = lookupContextPath(context, listPath);
    if (!Array.isArray(list)) {
      return { status: 'failed', error: `workflow_foreach_not_a_list:${listPath}` };
    }
    const items = list.slice(0, MAX_FOREACH_ITEMS);
    const results: Array<Record<string, unknown>> = [];
    for (const [index, item] of items.entries()) {
      if (active.canceled) {
        return { status: 'canceled', output: { items: results, count: results.length } };
      }
      const iterationContext = { ...context, item, itemIndex: index } as unknown as WorkflowRunContext;
      await appendTranscript(transcriptPath, 'meta', `[node:${node.id}] forEach item ${index + 1}/${items.length}`);
      if (active.canceled) {
        return { status: 'canceled', output: { items: results, count: results.length } };
      }
      const result = await this.executeNodeOnce(workflow, run, node, iterationContext, active, transcriptPath);
      if (result.status !== 'succeeded') {
        return {
          status: 'failed',
          error: `workflow_foreach_item_failed:${index}:${result.error ?? 'workflow_node_failed'}`,
          output: { items: results, count: results.length, failedIndex: index },
        };
      }
      results.push(result.output ?? {});
    }
    return {
      status: 'succeeded',
      output: {
        items: results,
        count: results.length,
        ...(node.type === 'condition'
          ? { result: results.every((entry) => entry.result === true) }
          : {}),
      },
      summary: `${results.length} ejecuciones`,
    };
  }

  private async executeForgerToolNode(
    node: WorkflowForgerToolNode,
    context: WorkflowRunContext,
  ): Promise<WorkflowNodeState> {
    const executor = this.options.callForgerToolAction ?? this.options.callConnectorAction;
    if (!executor) {
      return { status: 'failed', error: 'workflow_forger_tools_unavailable' };
    }
    const input = resolveTemplateValue(node.input, context) as Record<string, unknown>;
    const nodeRunInput = { toolId: node.toolId, actionId: node.toolId, input };
    try {
      const result = await executor(nodeRunInput);
      if (!result.success) {
        return {
          status: 'failed',
          input: nodeRunInput,
          error: result.technicalCode ?? result.userMessage ?? 'workflow_forger_tool_failed',
        };
      }
      const output = result.data && typeof result.data === 'object' && !Array.isArray(result.data)
        ? result.data as Record<string, unknown>
        : { value: result.data ?? null };
      return { status: 'succeeded', input: nodeRunInput, output, summary: result.userMessage };
    } catch (error) {
      return {
        status: 'failed',
        input: nodeRunInput,
        error: error instanceof Error ? error.message : 'workflow_forger_tool_failed',
      };
    }
  }

  private async executeConnectionNode(
    node: WorkflowConnectionNode,
    context: WorkflowRunContext,
  ): Promise<WorkflowNodeState> {
    if (!this.options.callConnectionAction) {
      return { status: 'failed', error: 'workflow_connections_unavailable' };
    }
    const input = resolveTemplateValue(node.input, context) as Record<string, unknown>;
    const nodeRunInput = {
      type: node.connectionType,
      actionId: node.actionId,
      ...(node.connectionId ? { connectionId: node.connectionId } : {}),
      input,
    };
    try {
      const result = await this.options.callConnectionAction(nodeRunInput);
      if (!result.success) {
        return {
          status: 'failed',
          input: nodeRunInput,
          error: result.technicalCode ?? result.userMessage ?? 'workflow_connection_failed',
        };
      }
      const output = result.data && typeof result.data === 'object' && !Array.isArray(result.data)
        ? result.data as Record<string, unknown>
        : { value: result.data ?? null };
      return { status: 'succeeded', input: nodeRunInput, output, summary: result.userMessage };
    } catch (error) {
      return {
        status: 'failed',
        input: nodeRunInput,
        error: error instanceof Error ? error.message : 'workflow_connection_failed',
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
      connectionGrants: agent.connectionGrants,
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
      connectionGrants: node.connectionGrants,
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
      connectionGrants: ConnectionSessionGrant[];
      permissionMode?: AgentRuntime['permissionMode'];
      networkAccess?: boolean;
      instructions?: string;
      outputSchema?: Record<string, unknown>;
    },
  ): Promise<WorkflowNodeState> {
    const nodeRunKey = `${run.id}:${node.id}`;
    let forgerMcpSession: { url: string; token: string } | null = null;
    let appMcpListening = false;
    const startedAt = new Date().toISOString();
    let activity = createAgentRunActivity({
      runId: nodeRunKey,
      surface: 'workflow_node',
      status: 'running',
      startedAt,
      updatedAt: startedAt,
      sourceRef: {
        workflowId: workflow.id,
        workflowName: workflow.name,
        nodeId: node.id,
        nodeName: node.name,
        title: node.name,
        appId: config.appIds[0],
      },
    });
    const emitActivity = (next: AgentRunActivity): void => {
      activity = next;
      this.options.onAgentRunActivity?.(activity);
      const persist = this.options.persistAgentRunActivity
        ?? ((value: AgentRunActivity) => persistAgentRunActivity(this.options.metadataRoot, value));
      this.activityPersistenceTail = this.activityPersistenceTail
        .then(() => persist(activity))
        .catch((error) => {
          this.backgroundFailures.push(error);
        });
    };
    emitActivity(activity);
    const inputContext = this.buildAgentInputContext(context);
    let nodeRunInput: Record<string, unknown> = {
      renderedPrompt: renderTemplateString(config.prompt, context),
      inputContext,
    };
    try {
      const memoryContext = await (this.options.buildMemoryContext?.(config.appIds) ?? Promise.resolve(''));
      const basePrompt = this.buildNodePrompt(workflow, node, config, context, inputContext);
      const prompt = [memoryContext, config.instructions, basePrompt].filter(Boolean).join('\n\n');
      nodeRunInput = { renderedPrompt: prompt, inputContext };

      const runtimeRequest = config.runtime ? { ...config.runtime, strict: true as const } : undefined;
      const runtime = await this.options.getAgentRuntime(runtimeRequest);
      await this.assertProviderReady(runtime);
      const providerCliPath = await this.resolveProviderCliPath(runtime);
      const pathEntries = await this.options.getCodexPathEntries();

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

      forgerMcpSession = this.options.createForgerMcpSession?.(
        nodeRunKey,
        config.appIds,
        config.toolIds,
        config.connectionGrants,
      ) ?? null;
      appMcpListening = true;
      const appMcpServers = this.options.listenRequiredAppMcps
        ? await this.listenRequiredAppMcps(config.appIds, nodeRunKey)
        : await (this.options.listenAppMcps?.(config.appIds, nodeRunKey) ?? Promise.resolve([]));
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
        onOutput: (stream, text) => {
          const nextActivity = appendProviderActivity({
            activity,
            provider: runtime.provider,
            stream,
            text,
          });
          if (nextActivity.counts.total !== activity.counts.total) {
            emitActivity({
              ...nextActivity,
              status: 'running',
              updatedAt: new Date().toISOString(),
            });
          }
        },
        onAssistantMessages: (messages) => {
          assistantMessages = messages;
        },
      });

      const completion = this.nodeCompletions.get(nodeRunKey);
      if (completion) {
        if (completion.status === 'failed') {
          emitActivity(finalizeAgentRunActivity(activity, 'failed', new Date().toISOString(), completion.reason));
          return { status: 'failed', input: nodeRunInput, error: completion.reason ?? 'workflow_node_reported_failure' };
        }
        emitActivity(finalizeAgentRunActivity(activity, 'completed', new Date().toISOString()));
        return {
          status: 'succeeded',
          input: nodeRunInput,
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
        emitActivity(finalizeAgentRunActivity(
          activity,
          'failed',
          new Date().toISOString(),
          (result.stderr || result.stdout || 'workflow_agent_exec_failed').trim().slice(0, 2_000),
        ));
        return {
          status: 'failed',
          input: nodeRunInput,
          error: (result.stderr || result.stdout || 'workflow_agent_exec_failed').trim().slice(0, 2_000),
        };
      }
      emitActivity(finalizeAgentRunActivity(activity, 'completed', new Date().toISOString()));
      return {
        status: 'succeeded',
        input: nodeRunInput,
        output: { text: lastMessage },
        summary: lastMessage.slice(0, 2_000),
      };
    } catch (error) {
      emitActivity(finalizeAgentRunActivity(
        activity,
        'failed',
        new Date().toISOString(),
        error instanceof Error ? error.message : 'workflow_agent_exec_failed',
      ));
      return {
        status: 'failed',
        input: nodeRunInput,
        error: error instanceof Error ? error.message : 'workflow_agent_exec_failed',
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

  private async listenRequiredAppMcps(
    appIds: string[],
    listenerId: string,
  ): Promise<LlmAutomationMcpServerConfig[]> {
    const result = await this.options.listenRequiredAppMcps!(appIds, listenerId);
    if (result.failures.length > 0) {
      throw new Error('workflow_required_app_mcp_unavailable');
    }
    return result.servers.map((server) => server.config);
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
}
