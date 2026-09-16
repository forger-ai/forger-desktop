import type { App } from 'electron';
import path from 'node:path';
import { CampaignMeasurement } from './campaign-measurement';
import { createCampaignCaptureTransport } from './campaign-measurement-transport';

/** Per-main-IPC composition owner. No state access, network, or lifecycle registration until first use. */
export const createCampaignMeasurementOwner = (options: {
  app: App;
  isDev: boolean;
  isTest: boolean;
  e2eProfileRoot?: string;
}) => {
  let measurement: CampaignMeasurement | null = null;
  return (): CampaignMeasurement => {
    if (!measurement) {
      const { app, isDev, isTest, e2eProfileRoot } = options;
      measurement = new CampaignMeasurement({
        filePath: path.join(e2eProfileRoot || app.getPath('userData'), 'campaign-measurement-v1.json'),
        enabled: app.isPackaged === true && !isDev && !isTest && !e2eProfileRoot,
        environment: 'production', version: app.getVersion(), platform: process.platform,
        // Public write-only project token. Recipient changes require a new consent version.
        send: createCampaignCaptureTransport('phc_v8cvWThh4auWRMzsCXDr46eCGuuxLa3JvTaoRmBycfUp'),
      });
      app.on('before-quit', () => measurement?.close());
    }
    return measurement;
  };
};
