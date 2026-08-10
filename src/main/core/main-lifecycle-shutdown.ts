import type { App } from 'electron';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Server } from 'node:http';
import type { RunningAppProcess } from './main-process-types';
import type { MainLifecycleState } from './main-lifecycle-types';

interface GracefulShutdownOptions {
  app: App;
  state: MainLifecycleState;
  runningApps: Map<string, RunningAppProcess>;
  stopInstalledApp: (appId: string) => Promise<unknown>;
  terminateProcess: (child: ChildProcessWithoutNullStreams) => Promise<void>;
  closeServer: (server: Server) => Promise<void>;
}

export const registerGracefulShutdownHandlers = ({
  app,
  state,
  runningApps,
  stopInstalledApp,
  terminateProcess,
  closeServer,
}: GracefulShutdownOptions): void => {
  let gracefulShutdownStarted = false;
  const performGracefulShutdown = async (): Promise<void> => {
    state.memoryMaintenanceManager?.dispose();
    state.personalAgentRoutineManager?.dispose?.();
    state.automationManager?.dispose();
    await state.workflowFeatureController?.dispose();
    state.workflowFeatureController = null;
    state.workflowManager = null;
    await state.appMcpToolService?.dispose?.();
    state.appMcpToolService = null;
    state.appMcpManager?.dispose();
    await Promise.allSettled([
      state.localNetworkShareManager?.stopAll?.() ?? Promise.resolve(),
      state.remoteNetworkShareManager?.stopAll?.() ?? Promise.resolve(),
      state.remoteAgentSessionService?.stopAll?.() ?? Promise.resolve(),
    ]);
    await Promise.resolve(state.desktopRuntimeBridge?.stop());
    state.desktopRuntimeBridge = null;
    await Promise.resolve(state.selfOAuthCallbackService?.stop());
    state.selfOAuthCallbackService = null;
    await Promise.resolve(state.officialToolsService?.stopActiveTools?.());
    state.cloudDeviceManager?.stop();
    state.devCatalogService?.stop?.();
    state.forgerMcpServer?.stop();
    state.forgerMcpServer = null;
    state.speechToTextService?.stop();
    state.speechToTextService = null;
    state.textToSpeechService?.stop();
    state.textToSpeechService = null;
    state.wakeWordService?.stop();
    state.wakeWordService = null;

    const runningAppIds = [...runningApps.keys()];
    await Promise.allSettled(runningAppIds.map((appId) => stopInstalledApp(appId)));
    await Promise.allSettled([...runningApps.values()].flatMap((running) => [
      terminateProcess(running.backend),
      terminateProcess(running.frontend),
      closeServer(running.proxyServer),
    ]));
  };

  app.on('before-quit', (event) => {
    if (gracefulShutdownStarted) {
      return;
    }
    gracefulShutdownStarted = true;
    const shouldResumeQuit = typeof event?.preventDefault === 'function';
    event?.preventDefault?.();
    void performGracefulShutdown().finally(() => {
      if (shouldResumeQuit) {
        app.quit();
      }
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });
};
