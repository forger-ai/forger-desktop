import { deriveAppExecutionState } from '@shared/app-execution-state';
import type { AppSummary } from '@shared/types';
import type { AppDictionary } from './i18n';

export const appExecutionTooltip = (
  app: Pick<AppSummary, 'status' | 'localNetworkShare' | 'remoteNetworkShare'>,
  t: AppDictionary,
  options: { startingInForger?: boolean } = {},
): string | undefined => {
  const state = deriveAppExecutionState(app, options);
  if (state.phase === 'stopped') {
    return undefined;
  }
  if (state.phase === 'error') {
    return t.actions.error;
  }

  const key = `${state.phase}_${state.mode}`;
  switch (key) {
    case 'starting_forger':
      return t.appExecution.startingForger;
    case 'starting_local_network':
      return t.appExecution.startingLocalNetwork;
    case 'starting_remote_tunnel':
      return t.appExecution.startingRemoteTunnel;
    case 'running_forger':
      return t.appExecution.runningForger;
    case 'running_local_network':
      return t.appExecution.runningLocalNetwork;
    case 'running_remote_tunnel':
      return t.appExecution.runningRemoteTunnel;
    default:
      return undefined;
  }
};
