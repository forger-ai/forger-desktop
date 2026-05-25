import type fs from 'node:fs/promises';
import type * as Electron from 'electron';
import type { BrowserWindow, IpcMain } from 'electron';
import type { IPC_CHANNELS as IpcChannels } from '../../shared/ipc';
import type {
  AgentDefaults,
  AppAgent,
  AppExternalFolderSelection,
  CallOfficialToolInput,
} from '../../shared/types';
import type { AppManifest, AppRegistry } from '../core/main-process-types';
import type { OfficialToolsService } from '../official-tools-service';

interface AppRuntimeIpcDeps {
  APP_CLAUDE_MODEL_OPTIONS: unknown[];
  APP_CODEX_MODEL_OPTIONS: unknown[];
  BrowserWindow: typeof BrowserWindow;
  IPC_CHANNELS: typeof IpcChannels;
  dialog: Electron.Dialog;
  fs: typeof fs;
  getCodexAuthStatus: () => Promise<{ authenticated: boolean }>;
  getOfficialToolsService: () => OfficialToolsService;
  ipcMain: IpcMain;
  normalizeManifestAgentDefaults: (manifest: AppManifest | null) => AgentDefaults;
  registry: AppRegistry;
  resolveAppIdForWebContents: (webContentsId: number) => string | null;
  resolveInstalledAgents: (appId: string) => Promise<AppAgent[]>;
  resolveInstalledManifest: (installDir: string) => Promise<AppManifest | null>;
  signAppFolderGrant: (appId: string, folderPath: string) => AppExternalFolderSelection;
}

export const registerAppRuntimeIpcHandlers = ({
  APP_CLAUDE_MODEL_OPTIONS,
  APP_CODEX_MODEL_OPTIONS,
  BrowserWindow,
  IPC_CHANNELS,
  dialog,
  fs,
  getCodexAuthStatus,
  getOfficialToolsService,
  ipcMain,
  normalizeManifestAgentDefaults,
  registry,
  resolveAppIdForWebContents,
  resolveInstalledAgents,
  resolveInstalledManifest,
  signAppFolderGrant,
}: AppRuntimeIpcDeps): void => {
  ipcMain.handle(IPC_CHANNELS.appSelectExternalFolder, async (event): Promise<AppExternalFolderSelection> => {
    const appId = resolveAppIdForWebContents(event.sender.id);
    if (!appId) {
      throw new Error('app_window_not_authorized');
    }

    const ownerWindow = BrowserWindow.fromWebContents(event.sender);
    const options: Electron.OpenDialogOptions = { properties: ['openDirectory'] };
    const result = ownerWindow && !ownerWindow.isDestroyed()
      ? await dialog.showOpenDialog(ownerWindow, options)
      : await dialog.showOpenDialog(options);
    if (result.canceled || result.filePaths.length === 0) {
      return { canceled: true };
    }

    const selectedPath = await fs.realpath(result.filePaths[0]);
    return signAppFolderGrant(appId, selectedPath);
  });

  ipcMain.handle(IPC_CHANNELS.appAiSubscriptionStatus, async (event) => {
    const appId = resolveAppIdForWebContents(event.sender.id);
    if (!appId) {
      throw new Error('app_window_not_authorized');
    }
    const status = await getCodexAuthStatus();
    return { connected: status.authenticated };
  });

  ipcMain.handle(IPC_CHANNELS.appGetContext, async (event) => {
    const appId = resolveAppIdForWebContents(event.sender.id);
    if (!appId) {
      return {};
    }
    const record = registry.apps[appId];
    const manifest = record?.installDir ? await resolveInstalledManifest(record.installDir) : null;
    return {
      agents: await resolveInstalledAgents(appId),
      agentDefaults: normalizeManifestAgentDefaults(manifest),
      agentModelOptions: {
        codex: APP_CODEX_MODEL_OPTIONS,
        claude: APP_CLAUDE_MODEL_OPTIONS,
      },
    };
  });

  ipcMain.handle(IPC_CHANNELS.appToolsListAvailable, async (event) => {
    const appId = resolveAppIdForWebContents(event.sender.id);
    if (!appId) {
      throw new Error('app_window_not_authorized');
    }
    return await getOfficialToolsService().listToolsForApp(appId);
  });

  ipcMain.handle(IPC_CHANNELS.appToolsGetStatus, async (event, toolId: string) => {
    const appId = resolveAppIdForWebContents(event.sender.id);
    if (!appId) {
      throw new Error('app_window_not_authorized');
    }
    const available = await getOfficialToolsService().listToolsForApp(appId);
    return available.find((tool) => tool.id === toolId) ?? null;
  });

  ipcMain.handle(IPC_CHANNELS.appToolsCall, async (event, input: CallOfficialToolInput) => {
    const appId = resolveAppIdForWebContents(event.sender.id);
    if (!appId) {
      throw new Error('app_window_not_authorized');
    }
    return await getOfficialToolsService().callFromApp(appId, input);
  });
};
