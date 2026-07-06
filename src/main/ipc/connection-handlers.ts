import type { IpcMain } from 'electron';
import type { IPC_CHANNELS as IpcChannels } from '../../shared/ipc';
import type {
  CallConnectionActionInput,
  ConfigureConnectionInput,
  DisconnectConnectionInput,
} from '../../shared/types';
import type { ConnectionsService } from '../connections-service';

interface ConnectionIpcHandlersDeps {
  IPC_CHANNELS: typeof IpcChannels;
  ipcMain: IpcMain;
  getConnectionsService: () => ConnectionsService;
}

export const registerConnectionIpcHandlers = ({
  IPC_CHANNELS,
  ipcMain,
  getConnectionsService,
}: ConnectionIpcHandlersDeps): void => {
  ipcMain.handle(IPC_CHANNELS.connectionsList, async (_event, locale?: string) => await getConnectionsService().listState(locale));
  ipcMain.handle(IPC_CHANNELS.connectionsConfigure, async (_event, input: ConfigureConnectionInput) => await getConnectionsService().configure(input));
  ipcMain.handle(IPC_CHANNELS.connectionsDisconnect, async (_event, input: DisconnectConnectionInput) => await getConnectionsService().disconnect(input));
  ipcMain.handle(IPC_CHANNELS.connectionsCall, async (_event, input: CallConnectionActionInput) => await getConnectionsService().call(input));
  ipcMain.handle(IPC_CHANNELS.connectionsSetDefault, async (_event, input: { type: string; connectionId: string }) => await getConnectionsService().setDefaultConnection(input));
};
