import type { SubmitUsageEventInput, UsageEventName } from '@shared/types';

const TERMS_ACCEPTED_AT_KEY = 'forger.terms.acceptedAt';
const PRIVACY_ACCEPTED_AT_KEY = 'forger.privacy.acceptedAt';
const USAGE_ANALYTICS_ENABLED_KEY = 'forger.usageAnalytics.enabled';
const USAGE_ANALYTICS_DECIDED_AT_KEY = 'forger.usageAnalytics.decidedAt';
const INSTALLATION_IDENTIFIER_KEY = 'forger.installation.identifier';
const FORGER_INSTALLED_RECORDED_KEY = 'forger.usageAnalytics.forgerInstalledRecorded';

const CONSENT_EVENTS = new Set<UsageEventName>([
  'forger_installed',
  'usage_analytics_accepted',
  'usage_analytics_declined',
  'usage_analytics_revoked',
  'usage_analytics_enabled',
  'settings_usage_analytics_changed',
]);

const randomInstallationIdentifier = () => {
  const webCrypto = globalThis.crypto;
  if (webCrypto?.randomUUID) {
    return webCrypto.randomUUID();
  }
  const values = new Uint8Array(16);
  webCrypto.getRandomValues(values);
  return Array.from(values, (value) => value.toString(16).padStart(2, '0')).join('');
};

export const getInstallationIdentifier = () => {
  const current = window.localStorage.getItem(INSTALLATION_IDENTIFIER_KEY);
  if (current) {
    return current;
  }
  const next = randomInstallationIdentifier();
  window.localStorage.setItem(INSTALLATION_IDENTIFIER_KEY, next);
  return next;
};

export const getUsageAnalyticsEnabled = () => window.localStorage.getItem(USAGE_ANALYTICS_ENABLED_KEY) !== 'false';

export const recordLegalWelcomeDecision = (enabled: boolean) => {
  const now = new Date().toISOString();
  window.localStorage.setItem(TERMS_ACCEPTED_AT_KEY, window.localStorage.getItem(TERMS_ACCEPTED_AT_KEY) ?? now);
  window.localStorage.setItem(PRIVACY_ACCEPTED_AT_KEY, window.localStorage.getItem(PRIVACY_ACCEPTED_AT_KEY) ?? now);
  window.localStorage.setItem(USAGE_ANALYTICS_ENABLED_KEY, String(enabled));
  window.localStorage.setItem(USAGE_ANALYTICS_DECIDED_AT_KEY, now);
  getInstallationIdentifier();
  return now;
};

export const setUsageAnalyticsPreference = (enabled: boolean) => {
  window.localStorage.setItem(USAGE_ANALYTICS_ENABLED_KEY, String(enabled));
  window.localStorage.setItem(USAGE_ANALYTICS_DECIDED_AT_KEY, new Date().toISOString());
  getInstallationIdentifier();
};

export const shouldSubmitUsageEvent = (eventName: UsageEventName) =>
  CONSENT_EVENTS.has(eventName) || getUsageAnalyticsEnabled();

export const submitUsageEvent = (input: Omit<SubmitUsageEventInput, 'installationIdentifier'>) => {
  if (!shouldSubmitUsageEvent(input.eventName)) {
    return;
  }
  window.forger?.submitUsageEvent({
    ...input,
    installationIdentifier: getInstallationIdentifier(),
    occurredAt: input.occurredAt ?? new Date().toISOString(),
  }).catch(() => undefined);
};

export const submitForgerInstalledEvent = (input: Pick<SubmitUsageEventInput, 'locale' | 'surface'> = {}) => {
  const installationIdentifier = getInstallationIdentifier();
  const recordedIdentifier = window.localStorage.getItem(FORGER_INSTALLED_RECORDED_KEY);
  if (recordedIdentifier === installationIdentifier) {
    return;
  }
  window.localStorage.setItem(FORGER_INSTALLED_RECORDED_KEY, installationIdentifier);
  submitUsageEvent({
    eventName: 'forger_installed',
    surface: input.surface ?? 'onboarding',
    locale: input.locale,
  });
};

export const submitChatGptConnectedEvent = (input: Pick<SubmitUsageEventInput, 'locale' | 'surface'> = {}) => {
  submitUsageEvent({
    eventName: 'chatgpt_connected',
    surface: input.surface ?? 'settings',
    locale: input.locale,
  });
};
