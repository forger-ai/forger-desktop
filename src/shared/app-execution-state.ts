import type { AppConnectMode, AppExecutionMode, AppExecutionPhase, AppSummary } from './types/catalog';

export interface AppExecutionState {
  phase: AppExecutionPhase;
  mode: AppExecutionMode | null;
  connectMode: AppConnectMode | null;
}

interface DeriveAppExecutionStateOptions {
  startingInForger?: boolean;
}

const isRemoteRunningState = (state?: string): boolean =>
  state === 'waiting_for_session' || state === 'connected';

export const deriveAppExecutionState = (
  app: Pick<AppSummary, 'status' | 'localNetworkShare' | 'remoteNetworkShare'>,
  options: DeriveAppExecutionStateOptions = {},
): AppExecutionState => {
  const remoteState = app.remoteNetworkShare?.state;
  if (remoteState === 'preparing') {
    return { phase: 'starting', mode: 'remote_tunnel', connectMode: 'remote_tunnel' };
  }
  if (app.remoteNetworkShare?.active && isRemoteRunningState(remoteState)) {
    return { phase: 'running', mode: 'remote_tunnel', connectMode: 'remote_tunnel' };
  }
  if (remoteState === 'error') {
    return { phase: 'error', mode: 'remote_tunnel', connectMode: null };
  }
  if (app.localNetworkShare?.active || app.localNetworkShare?.connectedAt) {
    return { phase: 'running', mode: 'local_network', connectMode: 'local_network' };
  }
  if (options.startingInForger) {
    return { phase: 'starting', mode: 'forger', connectMode: null };
  }
  if (app.status === 'installing') {
    return { phase: 'starting', mode: 'forger', connectMode: null };
  }
  if (app.status === 'running') {
    return { phase: 'running', mode: 'forger', connectMode: null };
  }
  if (app.status === 'error' || app.status === 'conflict') {
    return { phase: 'error', mode: null, connectMode: null };
  }
  return { phase: 'stopped', mode: null, connectMode: null };
};

export const withAppExecutionState = <T extends AppSummary>(
  app: T,
  options?: DeriveAppExecutionStateOptions,
): T => {
  const execution = deriveAppExecutionState(app, options);
  return {
    ...app,
    executionPhase: execution.phase,
    executionMode: execution.mode,
    connectMode: execution.connectMode,
  };
};
