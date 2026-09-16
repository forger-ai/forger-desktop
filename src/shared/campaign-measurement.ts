/** Deliberately closed cross-repository campaign contract. Never accept free-form UTM values. */
export const CAMPAIGN_CODES = [
  'ig_202609_paid_01', 'ig_202609_paid_02',
  'ig_202609_org_01', 'ig_202609_org_02', 'ig_202609_org_03', 'ig_202609_org_04',
  'fb_202609_org_01', 'fb_202609_org_02', 'fb_202609_org_03', 'fb_202609_org_04',
] as const;
export type CampaignCode = typeof CAMPAIGN_CODES[number];
export const isCampaignCode = (value: unknown): value is CampaignCode =>
  typeof value === 'string' && (CAMPAIGN_CODES as readonly string[]).includes(value);

export interface CampaignMeasurementStatus {
  available: boolean;
  consent: 'undecided' | 'enabled' | 'disabled';
  campaignCode: CampaignCode | null;
  attributionLocked: boolean;
  newProfile: boolean;
}

export interface CampaignMeasurementConsent {
  enabled: boolean;
  campaignCode?: CampaignCode | null;
}
