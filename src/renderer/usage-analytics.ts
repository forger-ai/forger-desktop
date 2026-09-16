import type { SubmitUsageEventInput, UsageEventName } from '@shared/types';
import { recordCampaignFirstAppCreated } from './campaign-measurement';

/**
 * Compatibility surface for retired product-usage instrumentation. These calls do not
 * create identifiers, persist event history, or invoke the legacy remote collector.
 * Its former default-on preference never authorizes the separate campaign recipient.
 */
export const getUsageAnalyticsEnabled = () => false;
export const setUsageAnalyticsPreference = (_enabled: boolean) => undefined;
export const shouldSubmitUsageEvent = (_eventName: UsageEventName) => false;
export const submitUsageEvent = (_input: Omit<SubmitUsageEventInput, 'installationIdentifier'>) => undefined;
export const submitForgerInstalledEvent = (_input: Pick<SubmitUsageEventInput, 'locale' | 'surface'> = {}) => undefined;
export const submitChatGptConnectedEvent = (_input: Pick<SubmitUsageEventInput, 'locale' | 'surface'> = {}) => undefined;

/** Legal acknowledgements remain independent of optional measurement. */
export const recordLegalWelcomeDecision = (_enabled: boolean) => {
  const now = new Date().toISOString();
  for (const key of ['forger.terms.acceptedAt', 'forger.privacy.acceptedAt']) {
    window.localStorage.setItem(key, window.localStorage.getItem(key) ?? now);
  }
  return now;
};

type LegacySignal = Record<string, unknown>;
const retiredSignal = (_input?: LegacySignal) => undefined;
export const usageAnalytics = {
  forgerOpened: retiredSignal,
  llmProviderConnected: retiredSignal,
  officialToolConnected: retiredSignal,
  catalogAppDownloaded: retiredSignal,
  appOpened: retiredSignal,
  appModified: retiredSignal,
  personalAgentCreated: retiredSignal,
  personalAgentMessageSent: retiredSignal,
  automationCreated: retiredSignal,
  detectedStartupState: retiredSignal,
  localAppCreated(input: LegacySignal & { origin?: 'user_action' | 'detected_on_startup' } = {}) {
    // App names/identifiers never cross this boundary. Existing apps detected on startup are not acquisitions.
    if (input.origin === 'user_action') recordCampaignFirstAppCreated();
  },
};
