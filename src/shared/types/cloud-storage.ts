import type { SubscriptionTier } from './account';

export interface CloudStorageBreakdown {
  backupsBytes: number;
  uploadedAppsBytes: number;
  pendingUserAppUploadsBytes: number;
  otherBytes: number;
}

export interface CloudStorageUsage {
  usedBytes: number;
  limitBytes: number;
  remainingBytes: number;
  plan: SubscriptionTier;
  breakdown: CloudStorageBreakdown;
}
