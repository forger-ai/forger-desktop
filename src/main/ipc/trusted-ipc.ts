import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron';
import { z, type ZodType } from 'zod';
import type { IPC_CHANNELS as IpcChannels } from '../../shared/ipc';

export const IPC_SENDER_NOT_AUTHORIZED = 'ipc_sender_not_authorized';
export const IPC_INPUT_INVALID = 'ipc_input_invalid';

export type IpcInputValidatorRegistry = Readonly<Record<string, ZodType<unknown[]>>>;

interface TrustedIpcMainOptions {
  ipcMain: IpcMain;
  getMainWindow: () => BrowserWindow | null;
  getAdditionalTrustedWindows?: () => BrowserWindow[];
  inputValidators?: IpcInputValidatorRegistry;
}

const hasBeenDestroyed = (value: unknown): boolean => {
  if (!value || typeof value !== 'object') return false;
  const isDestroyed = (value as { isDestroyed?: unknown }).isDestroyed;
  if (typeof isDestroyed !== 'function') return false;
  try {
    return Boolean(isDestroyed.call(value));
  } catch {
    return true;
  }
};

const requireTrustedSender = (
  event: IpcMainInvokeEvent | undefined,
  getMainWindow: () => BrowserWindow | null,
  getAdditionalTrustedWindows: () => BrowserWindow[],
): void => {
  let trustedWindows: BrowserWindow[];
  try {
    const mainWindow = getMainWindow();
    const additionalWindows = getAdditionalTrustedWindows();
    if (!Array.isArray(additionalWindows)) throw new Error(IPC_SENDER_NOT_AUTHORIZED);
    trustedWindows = [mainWindow, ...additionalWindows].filter(
      (window): window is BrowserWindow => Boolean(window),
    );
  } catch {
    throw new Error(IPC_SENDER_NOT_AUTHORIZED);
  }

  const sender = event?.sender;
  if (!sender || hasBeenDestroyed(sender)) {
    throw new Error(IPC_SENDER_NOT_AUTHORIZED);
  }

  try {
    const trustedWindow = trustedWindows.find((window) => window.webContents === sender);
    const trustedWebContents = trustedWindow?.webContents;
    if (
      !trustedWindow
      || !trustedWebContents
      || hasBeenDestroyed(trustedWindow)
      || hasBeenDestroyed(trustedWebContents)
    ) {
      throw new Error(IPC_SENDER_NOT_AUTHORIZED);
    }
    const senderFrame = event?.senderFrame;
    const mainFrame = sender.mainFrame ?? trustedWebContents.mainFrame;
    if (senderFrame && mainFrame && senderFrame !== mainFrame) {
      throw new Error(IPC_SENDER_NOT_AUTHORIZED);
    }
  } catch (error) {
    if (error instanceof Error && error.message === IPC_SENDER_NOT_AUTHORIZED) throw error;
    throw new Error(IPC_SENDER_NOT_AUTHORIZED);
  }
};

export const createTrustedIpcMain = ({
  ipcMain,
  getMainWindow,
  getAdditionalTrustedWindows = () => [],
  inputValidators = {},
}: TrustedIpcMainOptions): IpcMain => {
  const handle: IpcMain['handle'] = (channel, listener) => {
    ipcMain.handle(channel, async (event, ...args) => {
      requireTrustedSender(event, getMainWindow, getAdditionalTrustedWindows);
      const validator = inputValidators[channel];
      if (validator && !validator.safeParse(args).success) {
        throw new Error(IPC_INPUT_INVALID);
      }
      return await listener(event, ...args);
    });
  };

  return new Proxy(ipcMain, {
    get(target, property) {
      if (property === 'handle') return handle;
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
};

const identifier = z.string().trim().min(1).max(512);
const secretName = z.string().trim().min(1).max(256);
const secretValue = z.string().min(1).max(1_048_576);
const locale = z.string().max(64);
const appOperationArgs = z.tuple([identifier, locale.optional()]);
const backupTarget = z.object({
  appId: identifier,
  backupId: identifier,
}).strict();

export const createHighRiskIpcInputValidators = (
  channels: typeof IpcChannels,
): IpcInputValidatorRegistry => ({
  [channels.deleteBackup]: z.tuple([backupTarget]),
  [channels.deleteBackups]: z.tuple([z.object({
    appId: identifier,
    backupIds: z.array(identifier).min(1).max(1_000),
  }).strict()]),
  [channels.restoreBackup]: z.tuple([backupTarget]),
  [channels.installApp]: appOperationArgs,
  [channels.updateApp]: appOperationArgs,
  [channels.uninstallApp]: z.tuple([identifier]),
  [channels.createUserSecret]: z.tuple([z.object({
    name: secretName,
    value: secretValue,
  }).strict()]),
  [channels.updateUserSecret]: z.tuple([z.object({
    id: identifier,
    name: secretName,
    value: secretValue.optional(),
  }).strict()]),
  [channels.deleteUserSecret]: z.tuple([z.object({
    id: identifier,
  }).strict()]),
  [channels.connectAppSecret]: z.tuple([z.object({
    appId: identifier,
    appSecretName: secretName,
    userSecretId: identifier,
  }).strict()]),
  [channels.disconnectAppSecret]: z.tuple([z.object({
    appId: identifier,
    appSecretName: secretName,
  }).strict()]),
});
