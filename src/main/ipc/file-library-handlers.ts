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
  FilesRenameCategoryInput,
  FilesRenameInput,
  FilesStageForChatInput,
} from '../../shared/types';
import type { FileLibrary } from '../file-library';

interface FileLibraryIpcDeps {
  IPC_CHANNELS: typeof IpcChannels;
  dialog: Electron.Dialog;
  getFileLibrary: () => FileLibrary;
  ipcMain: IpcMain;
  mainWindow: Electron.BrowserWindow | null;
}

export const registerFileLibraryIpcHandlers = ({
  IPC_CHANNELS,
  dialog,
  getFileLibrary,
  ipcMain,
  mainWindow,
}: FileLibraryIpcDeps): void => {
  ipcMain.handle(IPC_CHANNELS.filesPickForChat, async () => {
    const options: Electron.OpenDialogOptions = { properties: ['openFile', 'multiSelections'] };
    const result = mainWindow && !mainWindow.isDestroyed()
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options);
    if (result.canceled) {
      return [];
    }
    return await getFileLibrary().pickFileInfo(result.filePaths);
  });
  ipcMain.handle(IPC_CHANNELS.filesStageForChat, async (_event, input: FilesStageForChatInput) => {
    return await getFileLibrary().stageFileForChat(input);
  });
  ipcMain.handle(IPC_CHANNELS.filesDiscardStagedForChat, async (_event, input: FilesDiscardStagedForChatInput) => {
    return await getFileLibrary().discardStagedFilesForChat(input);
  });
  ipcMain.handle(IPC_CHANNELS.filesList, async (_event, input?: FilesListInput) => await getFileLibrary().list(input ?? {}));
  ipcMain.handle(IPC_CHANNELS.filesListCategories, async () => await getFileLibrary().listCategories());
  ipcMain.handle(IPC_CHANNELS.filesCreateCategory, async (_event, input: FilesCreateCategoryInput) => await getFileLibrary().createCategory(input));
  ipcMain.handle(IPC_CHANNELS.filesRenameCategory, async (_event, input: FilesRenameCategoryInput) => await getFileLibrary().renameCategory(input));
  ipcMain.handle(IPC_CHANNELS.filesDeleteCategory, async (_event, input: FilesDeleteCategoryInput) => await getFileLibrary().deleteCategory(input));
  ipcMain.handle(IPC_CHANNELS.filesImport, async (_event, input: FilesImportInput) => await getFileLibrary().importFiles(input));
  ipcMain.handle(IPC_CHANNELS.filesMove, async (_event, input: FilesMoveInput) => await getFileLibrary().moveFiles(input));
  ipcMain.handle(IPC_CHANNELS.filesRename, async (_event, input: FilesRenameInput) => await getFileLibrary().renameFile(input));
  ipcMain.handle(IPC_CHANNELS.filesDelete, async (_event, input: FilesDeleteInput) => await getFileLibrary().deleteFiles(input));
};
