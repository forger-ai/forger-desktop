import type { AppConnectMode, AppExecutionMode, AppExecutionPhase } from './catalog';

export interface ForgerAccountUser {
  id: number;
  email: string;
  username?: string;
  firstName?: string;
  lastName?: string;
  confirmed: boolean;
  subscriptionTier: SubscriptionTier;
  usernameChangedAt?: string;
  usernameChangeAvailableAt?: string;
}

export interface ForgerAccountSession {
  authenticated: boolean;
  confirmationRequired?: boolean;
  user?: ForgerAccountUser;
}

export type SubscriptionTier = 'free' | 'demo' | 'pro';

export interface ForgerAccountRegisterInput {
  firstName: string;
  lastName?: string;
  username?: string;
  email: string;
  password: string;
  country?: string;
  age?: number;
  gender?: 'male' | 'female' | 'other';
  locale?: string;
}

export interface ForgerAccountLoginInput {
  email: string;
  password: string;
  locale?: string;
}

export interface ForgerAccountProfileInput {
  username: string;
}

export interface CloudDeviceAppSummary {
  id: string;
  name: string;
  status: string;
  version?: string;
  localNetworkShareSupported?: boolean;
  remoteTunnelSupported?: boolean;
  executionPhase?: AppExecutionPhase;
  executionMode?: AppExecutionMode | null;
  connectMode?: AppConnectMode | null;
}

export interface CloudDeviceSummary {
  id: number;
  deviceUid: string;
  name: string;
  kind?: 'desktop' | 'mobile';
  platform?: string;
  publicKey?: string;
  keyFingerprint?: string;
  paired: boolean;
  online: boolean;
  lastSeenAt?: string;
  installedApps: CloudDeviceAppSummary[];
}

export interface MobilePairingRequestSummary {
  id: number;
  mobileDeviceId: number;
  desktopDeviceId: number;
  status: 'pending' | 'accepted' | 'rejected' | 'confirmed' | 'expired';
  code?: string;
  codeExpiresAt?: string;
  expiresAt: string;
  mobileDevice: CloudDeviceSummary;
  desktopDevice: CloudDeviceSummary;
}

export interface CloudDevicesState {
  currentDevice?: CloudDeviceSummary;
  devices: CloudDeviceSummary[];
  pairingRequests?: MobilePairingRequestSummary[];
  connected: boolean;
  registrationRequired?: boolean;
  pairingCode?: string;
  pairingExpiresAt?: string;
  userMessage?: string;
  technicalCode?: string;
}
