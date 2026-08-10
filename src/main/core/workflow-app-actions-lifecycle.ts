import type {
  AppSummary,
  WorkflowAppActionCallInput,
  WorkflowAppActionCallResult,
  WorkflowAppActionCatalog,
  WorkflowAppActionDefinition,
  WorkflowAppActionSelection,
} from '../../shared/types';
import type { RequiredAppMcpListenResult } from '../app-mcp-manager';

interface AppMcpManagerForTools {
  listenRequiredMcps(appIds: string[], runId: string): Promise<RequiredAppMcpListenResult>;
  releaseMcps(runId: string): void;
}

export interface AppMcpToolLifecycleService {
  listAppActions(appId: string): Promise<WorkflowAppActionCatalog>;
  prepareAppActions(
    selections: WorkflowAppActionSelection[],
    runId: string,
    signal?: AbortSignal,
  ): Promise<WorkflowAppActionDefinition[]>;
  callAppAction(input: WorkflowAppActionCallInput): Promise<WorkflowAppActionCallResult>;
  releaseAppActions(runId: string): void | Promise<void>;
  dispose?(): void | Promise<void>;
}

export type AppMcpToolServiceConstructor = new (options: {
  appMcpManager: AppMcpManagerForTools;
  getInstalledApps: () => AppSummary[];
}) => AppMcpToolLifecycleService;

export const createAppMcpToolLifecycleService = (
  Service: AppMcpToolServiceConstructor | undefined,
  appMcpManager: object | null,
  getInstalledApps: () => AppSummary[],
): AppMcpToolLifecycleService | null => Service && isAppMcpManagerForTools(appMcpManager)
  ? new Service({ appMcpManager, getInstalledApps })
  : null;

export const createWorkflowAppActionBindings = (
  getService: () => AppMcpToolLifecycleService | null | undefined,
) => ({
  listAppActions: async (appId: string) => {
    const service = requireService(getService());
    return await service.listAppActions(appId);
  },
  prepareAppActions: async (
    selections: WorkflowAppActionSelection[],
    runId: string,
    signal?: AbortSignal,
  ) => {
    const service = requireService(getService());
    return await service.prepareAppActions(selections, runId, signal);
  },
  callAppAction: async (input: WorkflowAppActionCallInput) => {
    const service = requireService(getService());
    return await service.callAppAction(input);
  },
  releaseAppActions: async (runId: string) => {
    await getService()?.releaseAppActions(runId);
  },
});

const requireService = (
  service: AppMcpToolLifecycleService | null | undefined,
): AppMcpToolLifecycleService => {
  if (!service) throw new Error('workflow_app_actions_unavailable');
  return service;
};

const isAppMcpManagerForTools = (value: object | null): value is AppMcpManagerForTools =>
  value !== null
  && 'listenRequiredMcps' in value
  && typeof value.listenRequiredMcps === 'function'
  && 'releaseMcps' in value
  && typeof value.releaseMcps === 'function';
