import type * as Electron from 'electron';
import type { IpcMain } from 'electron';
import type { IPC_CHANNELS as IpcChannels } from '../../shared/ipc';
import type {
  FilesCreateCategoryInput,
  FilesDeleteCategoryInput,
  FilesDeleteInput,
  FilesDiscardStagedForChatInput,
  FilesImportInput,
  FilesListInput,
  FilesMoveInput,
  FilesReleaseSelectionsInput,
  FilesRenameCategoryInput,
  FilesRenameInput,
  FilesStageForChatInput,
} from '../../shared/types';
import { FileSelectionGrantStore, MAX_FILE_SELECTION_GRANTS } from '../file-selection-grants';
import type { FileLibrary } from '../file-library';

interface FileLibraryIpcDeps {
  IPC_CHANNELS: typeof IpcChannels;
  dialog: Electron.Dialog;
  getFileLibrary: () => FileLibrary;
  getMainWindow: () => Electron.BrowserWindow | null;
  ipcMain: IpcMain;
  fileSelectionGrants?: FileSelectionGrantStore;
}

const senderIdFor = (event: Electron.IpcMainInvokeEvent): number => {
  const senderId = event?.sender?.id;
  if (!Number.isInteger(senderId)) {
    throw new Error('invalid_file_selection_sender');
  }
  return senderId;
};

const grantIdsFrom = (input: FilesImportInput | FilesDiscardStagedForChatInput | FilesReleaseSelectionsInput): string[] => {
  if (
    !input
    || typeof input !== 'object'
    || !Array.isArray(input.grantIds)
    || input.grantIds.length > MAX_FILE_SELECTION_GRANTS
    || input.grantIds.some((grantId) => typeof grantId !== 'string' || !grantId)
    || 'sourcePaths' in input
  ) {
    throw new Error('invalid_file_selection_grant_input');
  }
  return input.grantIds;
};

export const registerFileLibraryIpcHandlers = ({
  IPC_CHANNELS,
  dialog,
  getFileLibrary,
  getMainWindow,
  ipcMain,
  fileSelectionGrants: providedFileSelectionGrants,
}: FileLibraryIpcDeps): void => {
  const trackedSenders = new Set<number>();
  const cleanupStaged = async (grants: Awaited<ReturnType<FileSelectionGrantStore['release']>>): Promise<void> => {
    if (grants.length > 0) {
      await getFileLibrary().discardStagedFilesForChat({ sourcePaths: grants.map((grant) => grant.sourcePath) });
    }
  };
  const fileSelectionGrants = providedFileSelectionGrants ?? new FileSelectionGrantStore({
    cleanupExpiredStagedFiles: cleanupStaged,
  });
  const trackSender = (event: Electron.IpcMainInvokeEvent, senderId: number): void => {
    if (trackedSenders.has(senderId)) {
      return;
    }
    trackedSenders.add(senderId);
    const revoke = (): void => {
      trackedSenders.delete(senderId);
      void fileSelectionGrants.revokeSender(senderId).then(cleanupStaged).catch(() => undefined);
    };
    if (typeof event.sender.isDestroyed === 'function' && event.sender.isDestroyed()) {
      revoke();
      return;
    }
    if (typeof event.sender.once === 'function') {
      event.sender.once('destroyed', revoke);
    }
  };
  const releaseSelections = async (event: Electron.IpcMainInvokeEvent, input: FilesReleaseSelectionsInput): Promise<{ success: true }> => {
    const released = await fileSelectionGrants.release(senderIdFor(event), grantIdsFrom(input));
    await cleanupStaged(released);
    return { success: true };
  };

  ipcMain.handle(IPC_CHANNELS.filesPickForChat, async (event) => {
    const options: Electron.OpenDialogOptions = { properties: ['openFile', 'multiSelections'] };
    const mainWindow = getMainWindow();
    const result = mainWindow && !mainWindow.isDestroyed()
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options);
    if (result.canceled) {
      return [];
    }
    const picked = await getFileLibrary().pickFileInfo(result.filePaths);
    const grants = await fileSelectionGrants.issueMany({
      senderId: senderIdFor(event),
      files: picked.map((file) => ({ name: file.name, sourcePath: file.sourcePath, staged: false })),
    });
    trackSender(event, senderIdFor(event));
    return picked.map(({ sourcePath: _sourcePath, ...metadata }, index) => ({
      ...metadata,
      grantId: grants[index].grantId,
    }));
  });
  ipcMain.handle(IPC_CHANNELS.filesStageForChat, async (event, input: FilesStageForChatInput) => {
    const library = getFileLibrary();
    const staged = await library.stageFileForChat(input);
    try {
      const [grant] = await fileSelectionGrants.issueMany({
        senderId: senderIdFor(event),
        files: [{ name: staged.name, sourcePath: staged.sourcePath, staged: true }],
      });
      trackSender(event, senderIdFor(event));
      const { sourcePath: _sourcePath, ...metadata } = staged;
      return { ...metadata, grantId: grant.grantId };
    } catch (error) {
      await library.discardStagedFilesForChat({ sourcePaths: [staged.sourcePath] }).catch(() => undefined);
      throw error;
    }
  });
  ipcMain.handle(IPC_CHANNELS.filesDiscardStagedForChat, async (event, input: FilesDiscardStagedForChatInput) => {
    return await releaseSelections(event, input);
  });
  ipcMain.handle(IPC_CHANNELS.filesReleaseSelections, releaseSelections);
  ipcMain.handle(IPC_CHANNELS.filesList, async (_event, input?: FilesListInput) => await getFileLibrary().list(input ?? {}));
  ipcMain.handle(IPC_CHANNELS.filesListCategories, async () => await getFileLibrary().listCategories());
  ipcMain.handle(IPC_CHANNELS.filesCreateCategory, async (_event, input: FilesCreateCategoryInput) => await getFileLibrary().createCategory(input));
  ipcMain.handle(IPC_CHANNELS.filesRenameCategory, async (_event, input: FilesRenameCategoryInput) => await getFileLibrary().renameCategory(input));
  ipcMain.handle(IPC_CHANNELS.filesDeleteCategory, async (_event, input: FilesDeleteCategoryInput) => await getFileLibrary().deleteCategory(input));
  ipcMain.handle(IPC_CHANNELS.filesImport, async (event, input: FilesImportInput) => {
    const lease = await fileSelectionGrants.leaseForImport(senderIdFor(event), grantIdsFrom(input));
    let openedFiles: Awaited<ReturnType<typeof lease.openFiles>> = [];
    try {
      openedFiles = await lease.openFiles();
      const imported = await getFileLibrary().importFiles({
        sources: openedFiles,
        categoryPath: input.categoryPath,
        appId: input.appId,
      });
      await lease.commit();
      return imported;
    } catch (error) {
      await lease.rollback();
      throw error;
    } finally {
      await Promise.allSettled(openedFiles.map((file) => file.fileHandle.close()));
    }
  });
  ipcMain.handle(IPC_CHANNELS.filesMove, async (_event, input: FilesMoveInput) => await getFileLibrary().moveFiles(input));
  ipcMain.handle(IPC_CHANNELS.filesRename, async (_event, input: FilesRenameInput) => await getFileLibrary().renameFile(input));
  ipcMain.handle(IPC_CHANNELS.filesDelete, async (_event, input: FilesDeleteInput) => await getFileLibrary().deleteFiles(input));
};
