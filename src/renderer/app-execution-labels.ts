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

  const labels = {
    starting_forger: t.appExecution.startingForger,
    starting_remote_tunnel: t.appExecution.startingRemoteTunnel,
    running_forger: t.appExecution.runningForger,
    running_local_network: t.appExecution.runningLocalNetwork,
    running_remote_tunnel: t.appExecution.runningRemoteTunnel,
  } as const;
  return labels[`${state.phase}_${state.mode}` as keyof typeof labels];
};
