import type { CampaignMeasurementStatus } from '@shared/campaign-measurement';

export const MEASUREMENT_CHANGED_EVENT = 'forger-campaign-measurement-changed';
export const MEASUREMENT_LINK_EVENT = 'forger-campaign-measurement-link';
const SEEN_KEY = 'forger.campaignMeasurement.profileSeen';

// Snapshot before any legacy startup code can write identifiers or onboarding defaults.
const previouslyUsedProfile = (() => {
  try {
    return [SEEN_KEY, 'forger.installation.identifier', 'forger.terms.acceptedAt',
      'forger.privacy.acceptedAt', 'forger.onboarding.global.dismissed'].some((key) => window.localStorage.getItem(key) !== null);
  } catch { return true; }
})();
let initialization: Promise<CampaignMeasurementStatus> | null = null;
export const initializeCampaignMeasurement = () => {
  if (typeof window.forger?.initializeCampaignMeasurement !== 'function') return Promise.reject(new Error('measurement_unavailable'));
  if (!initialization) {
    let existingProfile = previouslyUsedProfile;
    try { window.localStorage.setItem(SEEN_KEY, 'true'); } catch { existingProfile = true; }
    initialization = window.forger.initializeCampaignMeasurement(existingProfile).catch((error: unknown) => {
      initialization = null;
      throw error;
    });
  }
  return initialization.then(() => window.forger.getCampaignMeasurementStatus());
};

export const recordCampaignFirstAppCreated = () => {
  if (!window.forger?.recordCampaignFirstAppCreated) return;
  void initializeCampaignMeasurement().then(() => window.forger.recordCampaignFirstAppCreated()).catch(() => undefined);
};
