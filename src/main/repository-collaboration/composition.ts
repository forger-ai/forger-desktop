import type { ConnectionsService } from '../connections-service';
import type { MainLifecycleDeps } from '../core/main-lifecycle';
import type { MainLifecycleState } from '../core/main-lifecycle-types';
import type { StartupLogger } from '../core/startup-loading';
import path from 'node:path';
import {
  BUNDLED_GIT_VERSION,
  DEFAULT_NODE_VERSION,
} from '../core/agent-runtime-defaults';
import type { CodexReasoningEffort } from '../../shared/types';
import {
  startRepositoryCollaborationRuntime,
  stopRepositoryCollaborationRuntime,
} from './runtime';

type RuntimeDependencies = Pick<
  MainLifecycleDeps,
  | 'getForgerMetadataRoot'
  | 'getCodexAuthStatus'
  | 'chooseAgentRuntime'
  | 'ensureRuntimeInstalled'
  | 'getRuntimePathEntries'
  | 'getRuntimesRoot'
> & {
  getConnectionsService: () => ConnectionsService;
  getCodexHome: () => string;
  getCodexRoot: () => string;
  resolvePlatformAlias: () => string;
  resolveCodexCliPath: (root: string) => Promise<string | null>;
};

export function createRepositoryCollaborationHooks(deps: RuntimeDependencies) {
  return {
    stopRepositoryCollaboration: stopRepositoryCollaborationRuntime,
    startRepositoryCollaboration: async (): Promise<void> => {
      await startRepositoryCollaborationRuntime({
        metadataRoot: deps.getForgerMetadataRoot(),
        connections: deps.getConnectionsService(),
        sourceCodexHome: deps.getCodexHome,
        // Authentication and runtime preparation are lazy: startup never logs in or downloads a runtime.
        resolveRuntime: async () => {
          const status = await deps.getCodexAuthStatus();
          if (!status.authenticated)
            throw new Error('repository_execution_auth_required');
          const cliPath = await deps.resolveCodexCliPath(deps.getCodexRoot());
          if (!cliPath) throw new Error('repository_execution_runtime_missing');
          const runtime = await deps.chooseAgentRuntime({
            provider: 'codex',
            permissionMode: 'safe',
          });
          if (
            runtime.authProfileId &&
            !['codex:system', 'codex:local-active'].includes(
              runtime.authProfileId,
            )
          ) {
            throw new Error('repository_execution_auth_required');
          }
          const node = await deps.ensureRuntimeInstalled(
            'node',
            DEFAULT_NODE_VERSION,
          );
          return {
            cliPath,
            pathEntries: deps.getRuntimePathEntries(node),
            gitRoot: path.join(
              deps.getRuntimesRoot(),
              'git',
              BUNDLED_GIT_VERSION,
              deps.resolvePlatformAlias(),
            ),
            model: runtime.model,
            effort: runtime.effort as CodexReasoningEffort,
            authenticated: true,
          };
        },
      });
    },
  };
}

export async function startRepositoryConnections(options: {
  state: Pick<MainLifecycleState, 'connectionsService'>;
  getConnectionsService: MainLifecycleDeps['getConnectionsService'];
  startRepositoryCollaboration?: () => Promise<void>;
  initializeChannels?: () => Promise<void>;
  startupLogger: StartupLogger;
  appendInstallLog: MainLifecycleDeps['appendInstallLog'];
}): Promise<void> {
  const { state, startupLogger } = options;
  await startupLogger.step('startup:connections:create', () => {
    state.connectionsService = options.getConnectionsService();
  });
  await startupLogger.step('startup:connections:load', async () => {
    await state.connectionsService?.load();
  });
  await startupLogger
    .step('startup:repository_collaboration:start', async () => {
      await options.startRepositoryCollaboration?.();
    })
    .catch(() => {
      void options.appendInstallLog('repository_collaboration:start_failed', {
        code: 'unavailable',
      });
    });
  await options.initializeChannels?.();
  await startupLogger.step('startup:connections:start', async () => {
    await state.connectionsService?.start?.();
  });
}
