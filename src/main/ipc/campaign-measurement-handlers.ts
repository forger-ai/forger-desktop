import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron';
import { IPC_CHANNELS } from '../../shared/ipc';
import { isCampaignCode } from '../../shared/campaign-measurement';
import type { CampaignMeasurement } from '../campaign-measurement';
import { createTrustedIpcMain } from './trusted-ipc';

export const registerCampaignMeasurementIpcHandlers = (deps: {
  ipcMain: IpcMain;
  getMainWindow: () => BrowserWindow | null;
  getMeasurement: () => CampaignMeasurement;
  hasExistingApps: () => boolean;
}) => {
  // Consent is reserved for the primary Desktop window, never installed apps or friend-chat windows.
  const ipc = createTrustedIpcMain({ ipcMain: deps.ipcMain, getMainWindow: deps.getMainWindow });
  const assertMainFrame = (event: IpcMainInvokeEvent) => {
    const frame = deps.getMainWindow()?.webContents.mainFrame;
    if (!frame || !event.senderFrame || event.senderFrame !== frame) throw new Error('ipc_sender_not_authorized');
  };
  ipc.handle(IPC_CHANNELS.initializeCampaignMeasurement, (event, existingProfile: unknown) => {
    assertMainFrame(event);
    if (typeof existingProfile !== 'boolean') throw new Error('invalid_profile_state');
    const hasExistingApps = deps.hasExistingApps() !== false;
    return deps.getMeasurement().initialize(existingProfile || hasExistingApps, hasExistingApps);
  });
  ipc.handle(IPC_CHANNELS.getCampaignMeasurementStatus, (event) => { assertMainFrame(event); return deps.getMeasurement().getStatus(); });
  ipc.handle(IPC_CHANNELS.setCampaignMeasurementConsent, (event, input: unknown) => {
    assertMainFrame(event);
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('invalid_consent');
    const value = input as Record<string, unknown>;
    if (Object.keys(value).some((key) => !['enabled', 'campaignCode'].includes(key))
      || typeof value.enabled !== 'boolean'
      || !(value.campaignCode === undefined || value.campaignCode === null || isCampaignCode(value.campaignCode))) throw new Error('invalid_consent');
    return deps.getMeasurement().setConsent(value.enabled, value.campaignCode);
  });
  ipc.handle(IPC_CHANNELS.recordCampaignFirstAppCreated, (event) => { assertMainFrame(event); return deps.getMeasurement().recordFirstAppCreated(); });
};
