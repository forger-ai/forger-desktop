import type { Dialog, IpcMain } from 'electron';
import { z } from 'zod';
import type { IPC_CHANNELS as IpcChannels } from '../../shared/ipc';
import type {
  RepositoryCollaborationApi,
  RepositoryCollaborationRepository,
  RepositoryCollaborationSnapshot,
} from '../../shared/types/repository-collaboration';

type CollaborationService = Omit<
  RepositoryCollaborationApi,
  'snapshot' | 'addRepository'
> & {
  snapshot(
    connectionId: string,
  ): RepositoryCollaborationSnapshot | Promise<RepositoryCollaborationSnapshot>;
  addRepository(input: {
    groupId: string;
    name: string;
    root: string;
  }): Promise<RepositoryCollaborationRepository>;
};
const identifier = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9_-]+$/);
const label = z
  .string()
  .trim()
  .min(1)
  .max(160)
  .regex(/^[^\u0000-\u001f\u007f]+$/);
const chatId = z
  .string()
  .max(160)
  .regex(/^[a-zA-Z0-9_-]+@g\.us$/);
const participantId = z
  .string()
  .max(180)
  .regex(/^[a-zA-Z0-9_.:+-]+@(lid|s\.whatsapp\.net)$/);
const configure = z
  .object({
    connectionId: identifier,
    chatId,
    title: label,
    enabled: z.boolean(),
  })
  .strict();
const addRepository = z
  .object({ groupId: identifier, name: label.max(80) })
  .strict();
const removeRepository = z
  .object({ groupId: identifier, repositoryId: identifier })
  .strict();
const access = z
  .object({
    groupId: identifier,
    participantId,
    displayName: label,
    repositoryIds: z.array(identifier).max(100),
  })
  .strict();
const task = z.object({ taskId: identifier }).strict();
const participants = z.object({ connectionId: identifier, chatId }).strict();

const parse = <T>(schema: z.ZodType<T>, input: unknown): T => {
  const result = schema.safeParse(input);
  if (!result.success) throw new Error('ipc_input_invalid');
  return result.data;
};

/** Receives the trusted IPC wrapper; filesystem roots only originate in the native dialog. */
export const registerRepositoryCollaborationIpcHandlers = ({
  ipcMain,
  IPC_CHANNELS,
  getService,
  dialog,
}: {
  ipcMain: IpcMain;
  IPC_CHANNELS: typeof IpcChannels;
  getService: () => CollaborationService;
  dialog: Pick<Dialog, 'showOpenDialog'>;
}): void => {
  ipcMain.handle(
    IPC_CHANNELS.repositoryCollaborationSnapshot,
    async (_event, input: unknown) =>
      getService().snapshot(parse(identifier, input)),
  );
  ipcMain.handle(
    IPC_CHANNELS.repositoryCollaborationListGroups,
    async (_event, input: unknown) =>
      getService().listGroups(parse(identifier, input)),
  );
  ipcMain.handle(
    IPC_CHANNELS.repositoryCollaborationListParticipants,
    async (_event, input: unknown) => {
      const parsed = parse(participants, input);
      return getService().listParticipants(parsed.connectionId, parsed.chatId);
    },
  );
  ipcMain.handle(
    IPC_CHANNELS.repositoryCollaborationConfigureGroup,
    async (_event, input: unknown) =>
      getService().configureGroup(parse(configure, input)),
  );
  ipcMain.handle(
    IPC_CHANNELS.repositoryCollaborationAddRepository,
    async (_event, input: unknown) => {
      const parsed = parse(addRepository, input);
      const selection = await dialog.showOpenDialog({
        properties: ['openDirectory'],
      });
      if (selection.canceled || selection.filePaths.length !== 1) return null;
      const repository = await getService().addRepository({
        ...parsed,
        root: selection.filePaths[0],
      });
      return {
        id: repository.id,
        groupId: repository.groupId,
        name: repository.name,
      };
    },
  );
  ipcMain.handle(
    IPC_CHANNELS.repositoryCollaborationRemoveRepository,
    async (_event, input: unknown) =>
      getService().removeRepository(parse(removeRepository, input)),
  );
  ipcMain.handle(
    IPC_CHANNELS.repositoryCollaborationSetAccess,
    async (_event, input: unknown) =>
      getService().setAccess(parse(access, input)),
  );
  ipcMain.handle(
    IPC_CHANNELS.repositoryCollaborationCancelTask,
    async (_event, input: unknown) =>
      getService().cancelTask(parse(task, input)),
  );
  ipcMain.handle(
    IPC_CHANNELS.repositoryCollaborationRetryTask,
    async (_event, input: unknown) =>
      getService().retryTask(parse(task, input)),
  );
};
