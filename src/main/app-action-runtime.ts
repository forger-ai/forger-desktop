import { randomUUID } from 'node:crypto';
import type { AppMcpManager, AppMcpServerConfig } from './app-mcp-manager';
import { AppMcpClient } from './app-mcp-client';
import type {
  WorkflowAppActionCallInput,
  WorkflowAppActionDefinition,
  WorkflowAppActionNode,
} from '../shared/types/workflows';

export interface WorkflowAppActionClient {
  listActions: () => Promise<WorkflowAppActionDefinition[]>;
  callAction: (input: {
    toolName: string;
    input: Record<string, unknown>;
    signal?: AbortSignal;
    timeoutMs?: number;
  }) => Promise<Record<string, unknown>>;
  close: () => Promise<void>;
}

export interface WorkflowAppActionRuntimeOptions {
  appMcpManager: Pick<AppMcpManager, 'listenRequiredMcps' | 'releaseMcps'>;
  createClient?: (config: AppMcpServerConfig) => WorkflowAppActionClient;
}

interface PreparedAppActionRun {
  clients: Map<string, WorkflowAppActionClient>;
  actions: Map<string, WorkflowAppActionDefinition[]>;
}

const unavailableError = (appId: string, code: string): Error =>
  new Error(`workflow_app_action_app_unavailable:${appId}:${code}`);

const distinctAppIds = (nodes: WorkflowAppActionNode[]): string[] =>
  [...new Set(nodes.map((node) => node.appId))];

export class WorkflowAppActionRuntime {
  private readonly preparedRuns = new Map<string, PreparedAppActionRun>();
  private readonly createClient: (config: AppMcpServerConfig) => WorkflowAppActionClient;

  public constructor(private readonly options: WorkflowAppActionRuntimeOptions) {
    this.createClient = options.createClient ?? ((config) => new AppMcpClient({
      url: config.url,
      token: config.token,
      timeoutMs: Math.max(1, Math.floor((config.toolTimeoutSec ?? 60) * 1_000)),
    }));
  }

  public async preflightAppActions(
    nodes: WorkflowAppActionNode[],
    runId: string,
  ): Promise<void> {
    await this.releaseAppActions(runId);
    const appIds = distinctAppIds(nodes);
    if (appIds.length === 0) return;
    const listened = await this.options.appMcpManager.listenRequiredMcps(appIds, runId);
    if (listened.failures.length > 0) {
      const failure = listened.failures[0];
      throw unavailableError(failure.appId, failure.code);
    }
    const clients = new Map<string, WorkflowAppActionClient>();
    const actions = new Map<string, WorkflowAppActionDefinition[]>();
    try {
      for (const { appId, config } of listened.servers) {
        clients.set(appId, this.createClient(config));
      }
      if (clients.size !== appIds.length) {
        throw new Error('workflow_app_action_discovery_failed');
      }
      await Promise.all(appIds.map(async (appId) => {
        const client = clients.get(appId);
        if (!client) throw new Error('workflow_app_action_discovery_failed');
        actions.set(appId, await client.listActions());
      }));
      for (const node of nodes) {
        const live = actions.get(node.appId)?.find((action) => action.toolName === node.toolName);
        if (!live) throw new Error('workflow_app_action_not_found');
        if (live.contractHash !== node.action.contractHash) {
          throw new Error('workflow_app_action_contract_changed');
        }
      }
      this.preparedRuns.set(runId, { clients, actions });
    } catch (error) {
      await Promise.allSettled([...clients.values()].map((client) => client.close()));
      this.options.appMcpManager.releaseMcps(runId);
      throw error;
    }
  }

  public async releaseAppActions(runId: string): Promise<void> {
    const prepared = this.preparedRuns.get(runId);
    this.preparedRuns.delete(runId);
    if (prepared) {
      await Promise.allSettled([...prepared.clients.values()].map((client) => client.close()));
    }
    this.options.appMcpManager.releaseMcps(runId);
  }

  public async listAppActions(appId: string): Promise<WorkflowAppActionDefinition[]> {
    const listenerId = `workflow-action-discovery:${randomUUID()}`;
    const listened = await this.options.appMcpManager.listenRequiredMcps([appId], listenerId);
    if (listened.failures.length > 0) {
      const failure = listened.failures[0];
      throw unavailableError(failure.appId, failure.code);
    }
    const server = listened.servers.find((entry) => entry.appId === appId);
    if (!server) {
      this.options.appMcpManager.releaseMcps(listenerId);
      throw new Error('workflow_app_action_discovery_failed');
    }
    const client = this.createClient(server.config);
    try {
      return await client.listActions();
    } finally {
      await client.close().catch(() => undefined);
      this.options.appMcpManager.releaseMcps(listenerId);
    }
  }

  public async callAppAction(input: WorkflowAppActionCallInput): Promise<Record<string, unknown>> {
    const prepared = this.preparedRuns.get(input.runId);
    if (!prepared) throw new Error('workflow_app_action_run_not_preflighted');
    const client = prepared.clients.get(input.appId);
    if (!client) {
      throw new Error('workflow_app_action_run_not_preflighted');
    }
    const liveActions = await client.listActions();
    const action = liveActions.find((candidate) => candidate.toolName === input.toolName);
    if (!action) throw new Error('workflow_app_action_not_found');
    if (action.contractHash !== input.expectedContractHash) {
      throw new Error('workflow_app_action_contract_changed');
    }
    prepared.actions.set(input.appId, liveActions);
    return await client.callAction({
      toolName: input.toolName,
      input: input.input,
      signal: input.signal,
      timeoutMs: input.timeoutMs,
    });
  }

  public workflowManagerOptions(): {
    listAppActions: (appId: string) => Promise<WorkflowAppActionDefinition[]>;
    callAppAction: (input: WorkflowAppActionCallInput) => Promise<Record<string, unknown>>;
    preflightAppActions: (nodes: WorkflowAppActionNode[], runId: string) => Promise<void>;
    releaseAppActions: (runId: string) => Promise<void>;
  } {
    return {
      listAppActions: (appId) => this.listAppActions(appId),
      callAppAction: (input) => this.callAppAction(input),
      preflightAppActions: (nodes, runId) => this.preflightAppActions(nodes, runId),
      releaseAppActions: (runId) => this.releaseAppActions(runId),
    };
  }

  public async dispose(): Promise<void> {
    await Promise.allSettled(
      [...this.preparedRuns.keys()].map((runId) => this.releaseAppActions(runId)),
    );
  }
}
