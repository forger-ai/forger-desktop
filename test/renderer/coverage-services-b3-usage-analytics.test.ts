import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSummary } from '@shared/types';
import { getUsageAnalyticsEnabled, recordLegalWelcomeDecision, setUsageAnalyticsPreference,
  shouldSubmitUsageEvent, submitChatGptConnectedEvent, submitForgerInstalledEvent, submitUsageEvent, usageAnalytics } from '@renderer/usage-analytics';

const created = vi.fn();
vi.mock('@renderer/campaign-measurement', () => ({ recordCampaignFirstAppCreated: () => created() }));

describe('retired usage analytics compatibility', () => {
  const legacySubmit = vi.fn();
  beforeEach(() => {
    created.mockClear(); legacySubmit.mockClear(); window.localStorage.clear();
    Object.defineProperty(window, 'forger', { configurable: true, value: { submitUsageEvent: legacySubmit } });
  });

  it('never inherits old default-on or explicit consent and creates no legacy identity', () => {
    for (const value of [null, 'true', 'false']) {
      if (value !== null) window.localStorage.setItem('forger.usageAnalytics.enabled', value);
      expect(getUsageAnalyticsEnabled()).toBe(false);
      for (const event of ['forger_installed', 'usage_analytics_declined', 'usage_analytics_revoked', 'forger_opened'] as const) {
        expect(shouldSubmitUsageEvent(event)).toBe(false);
        submitUsageEvent({ eventName: event });
      }
      submitForgerInstalledEvent(); submitChatGptConnectedEvent();
      recordLegalWelcomeDecision(false); setUsageAnalyticsPreference(true);
    }
    expect(legacySubmit).not.toHaveBeenCalled();
    expect(window.localStorage.getItem('forger.installation.identifier')).toBeNull();
    expect(window.localStorage.getItem('forger.usageAnalytics.forgerInstalledRecorded')).toBeNull();
  });

  it('preserves legal timestamps independently of optional measurement', () => {
    window.localStorage.setItem('forger.terms.acceptedAt', '2025-01-01T00:00:00Z');
    recordLegalWelcomeDecision(false);
    expect(window.localStorage.getItem('forger.terms.acceptedAt')).toBe('2025-01-01T00:00:00Z');
    expect(window.localStorage.getItem('forger.privacy.acceptedAt')).toBeTruthy();
    expect(legacySubmit).not.toHaveBeenCalled();
  });

  it('startup detection, providers and normal legacy product signals send nothing', () => {
    const ownApp = { id: 'private-app', privateLocal: true, category: 'productivity', status: 'installed' } as AppSummary;
    usageAnalytics.detectedStartupState({ apps: [ownApp], providers: { codex: true }, officialTools: [] });
    usageAnalytics.llmProviderConnected({ provider: 'claude' });
    usageAnalytics.officialToolConnected({ toolId: 'private-tool' });
    usageAnalytics.catalogAppDownloaded({ appId: 'private-app' });
    usageAnalytics.appOpened({ appId: 'private-app', app: ownApp });
    usageAnalytics.appModified({ appId: 'private-app', app: ownApp });
    usageAnalytics.personalAgentCreated(); usageAnalytics.personalAgentMessageSent(); usageAnalytics.automationCreated();
    expect(created).not.toHaveBeenCalled();
    expect(legacySubmit).not.toHaveBeenCalled();
    expect(window.localStorage.getItem('forger.installation.identifier')).toBeNull();
  });

  it('routes only genuine creation actions to the narrow measurement owner, without app metadata', () => {
    usageAnalytics.localAppCreated({ appId: 'secret-app-id', origin: 'detected_on_startup' });
    expect(created).not.toHaveBeenCalled();
    usageAnalytics.localAppCreated({ appId: 'secret-app-id', origin: 'user_action' });
    expect(created).toHaveBeenCalledExactlyOnceWith();
    expect(legacySubmit).not.toHaveBeenCalled();
  });
});
