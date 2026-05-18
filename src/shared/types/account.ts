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
}

export interface CloudDeviceSummary {
  id: number;
  deviceUid: string;
  name: string;
  platform?: string;
  publicKey?: string;
  keyFingerprint?: string;
  paired: boolean;
  online: boolean;
  lastSeenAt?: string;
  installedApps: CloudDeviceAppSummary[];
}

export interface CloudDevicesState {
  currentDevice?: CloudDeviceSummary;
  devices: CloudDeviceSummary[];
  connected: boolean;
  pairingCode?: string;
  pairingExpiresAt?: string;
  userMessage?: string;
  technicalCode?: string;
}
