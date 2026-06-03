import type { IpcMain } from 'electron';
import type { IPC_CHANNELS as IpcChannels } from '../../shared/ipc';
import type { CloudMessage, CloudSendMessageInput } from '../../shared/types';
import type { AppManifest, AppRegistry } from '../core/main-process-types';

interface AppCloudMessagingIpcDeps {
  IPC_CHANNELS: typeof IpcChannels;
  listLocalCloudMessages: (friendUserId: number) => Promise<CloudMessage[]>;
  ipcMain: IpcMain;
  registry: AppRegistry;
  resolveAppIdForWebContents: (webContentsId: number) => string | null;
  resolveInstalledManifest: (installDir: string) => Promise<AppManifest | null>;
  sendEncryptedCloudMessage: (input: CloudSendMessageInput) => Promise<CloudMessage>;
}

export const registerAppCloudMessagingIpcHandlers = ({
  IPC_CHANNELS,
  listLocalCloudMessages,
  ipcMain,
  registry,
  resolveAppIdForWebContents,
  resolveInstalledManifest,
  sendEncryptedCloudMessage,
}: AppCloudMessagingIpcDeps): void => {
  ipcMain.handle(IPC_CHANNELS.appMessagesSend, async (event, input: CloudSendMessageInput) => {
    const appId = resolveAppIdForWebContents(event.sender.id);
    if (!appId) {
      throw new Error('app_window_not_authorized');
    }
    const record = registry.apps[appId];
    const manifest = record?.installDir ? await resolveInstalledManifest(record.installDir) : null;
    if (manifest?.cloudMessaging?.enabled !== true) {
      throw new Error('app_cloud_messaging_not_declared');
    }
    return await sendEncryptedCloudMessage({
      ...input,
      delivery: input.delivery ?? manifest.cloudMessaging.defaultDelivery ?? 'persistent',
      source: 'app',
      sourceAppId: appId,
      sourceAppName: record?.name ?? appId,
    });
  });

  ipcMain.handle(IPC_CHANNELS.appMessagesList, async (event, friendUserId: number) => {
    const appId = resolveAppIdForWebContents(event.sender.id);
    if (!appId) {
      throw new Error('app_window_not_authorized');
    }
    const record = registry.apps[appId];
    const manifest = record?.installDir ? await resolveInstalledManifest(record.installDir) : null;
    if (manifest?.cloudMessaging?.enabled !== true) {
      throw new Error('app_cloud_messaging_not_declared');
    }
    return await listLocalCloudMessages(friendUserId);
  });
};
