import type fs from 'node:fs/promises';
import os from 'node:os';
import type path from 'node:path';
import { fileURLToPath } from 'node:url';
import type * as Electron from 'electron';
import type { IPC_CHANNELS as IpcChannels } from '../../shared/ipc';
import type { FailureDiagnosticFields } from '../../shared/types';

interface RegisterExternalUrlIpcHandlersDeps {
  IPC_CHANNELS: typeof IpcChannels;
  failureDiagnostic: (error: unknown, fallbackCode: string) => FailureDiagnosticFields;
  fs: typeof fs;
  ipcMain: Electron.IpcMain;
  path: typeof path;
  shell: typeof Electron.shell;
}

const stripLineSuffixFromLocalPath = (filePath: string): string | null => {
  const stripped = filePath.replace(/:(\d+)(?::\d+)?$/, '');
  return stripped === filePath ? null : stripped;
};

const resolveExistingLocalOpenPath = async (
  filePath: string,
  fsModule: typeof fs,
): Promise<string> => {
  const stripped = stripLineSuffixFromLocalPath(filePath);
  const candidates = stripped ? [filePath, stripped] : [filePath];
  for (const candidate of candidates) {
    try {
      await fsModule.stat(candidate);
      return candidate;
    } catch {
      // Keep trying fallbacks, then let shell.openPath report the final failure.
    }
  }
  return filePath;
};

const resolveLocalOpenPath = async (
  targetUrl: string,
  deps: { fs: typeof fs; path: typeof path },
): Promise<string | null> => {
  if (targetUrl === '~' || /^~[\\/]/.test(targetUrl)) {
    const relativeHomePath = targetUrl === '~' ? '' : targetUrl.slice(2);
    return await resolveExistingLocalOpenPath(deps.path.join(os.homedir(), relativeHomePath), deps.fs);
  }
  if (deps.path.isAbsolute(targetUrl)) {
    return await resolveExistingLocalOpenPath(targetUrl, deps.fs);
  }
  try {
    const parsed = new URL(targetUrl);
    if (parsed.protocol !== 'file:') return null;
    return await resolveExistingLocalOpenPath(fileURLToPath(parsed), deps.fs);
  } catch {
    return null;
  }
};

export const registerExternalUrlIpcHandlers = ({
  IPC_CHANNELS,
  failureDiagnostic,
  fs,
  ipcMain,
  path,
  shell,
}: RegisterExternalUrlIpcHandlersDeps): void => {
  ipcMain.handle(IPC_CHANNELS.openExternalUrl, async (_event, targetUrl: string) => {
    const localPath = await resolveLocalOpenPath(targetUrl, { fs, path });
    if (localPath) {
      try {
        const openError = await shell.openPath(localPath);
        if (openError) {
          return {
            success: false,
            userMessage: 'No pudimos abrir ese enlace.',
            technicalCode: 'open_local_path_failed',
            sensitiveDetails: { error: openError },
          };
        }
        return { success: true };
      } catch (error) {
        return { success: false, userMessage: 'No pudimos abrir ese enlace.', ...failureDiagnostic(error, 'open_local_path_failed') };
      }
    }

    let parsed: URL;
    try {
      parsed = new URL(targetUrl);
    } catch {
      return { success: false, userMessage: 'No pudimos abrir ese enlace.', technicalCode: 'unsupported_url_protocol' };
    }

    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return { success: false, userMessage: 'No pudimos abrir ese enlace.', technicalCode: 'unsupported_url_protocol' };
    }

    try {
      await shell.openExternal(parsed.toString());
      return { success: true };
    } catch (error) {
      return { success: false, userMessage: 'No pudimos abrir ese enlace.', ...failureDiagnostic(error, 'open_external_url_failed') };
    }
  });
};
