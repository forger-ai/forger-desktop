import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSummary, OfficialToolSummary, SubmitUsageEventInput } from '@shared/types';

import {
  getInstallationIdentifier,
  getUsageAnalyticsEnabled,
  recordLegalWelcomeDecision,
  setUsageAnalyticsPreference,
  shouldSubmitUsageEvent,
  submitChatGptConnectedEvent,
  submitForgerInstalledEvent,
  submitUsageEvent,
  usageAnalytics,
} from '@renderer/usage-analytics';

const INSTALLATION_IDENTIFIER_KEY = 'forger.installation.identifier';
const FORGER_INSTALLED_RECORDED_KEY = 'forger.usageAnalytics.forgerInstalledRecorded';

const makeApp = (overrides: Partial<AppSummary> = {}): AppSummary => ({
  id: 'app-1',
  category: 'productivity',
  status: 'installed',
  ...overrides,
});

const makeOfficialTool = (id: string, configured: boolean): OfficialToolSummary => ({
  id,
  configured,
  name: id,
  description: `${id} connector`,
  version: '1.0.0',
  runtime: 'builtin',
  official: true,
  status: 'installed',
  actions: [],
  secrets: [],
});

describe('usage analytics service boundaries', () => {
  const submitted: SubmitUsageEventInput[] = [];
  let submitUsageEventMock: ReturnType<typeof vi.fn>;

  const installBridge = () => {
    submitUsageEventMock = vi.fn(async (input: SubmitUsageEventInput) => {
      submitted.push(input);
      return { success: true };
    });
    Object.defineProperty(window, 'forger', {
      configurable: true,
      value: { submitUsageEvent: submitUsageEventMock },
    });
  };

  beforeEach(() => {
    submitted.length = 0;
    window.localStorage.clear();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-10T12:34:56.000Z'));
    vi.stubGlobal('crypto', {
      randomUUID: vi.fn(() => '11111111-2222-4333-8444-555555555555'),
      getRandomValues: vi.fn(),
    });
    installBridge();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    window.localStorage.clear();
    Object.defineProperty(window, 'forger', { configurable: true, value: undefined });
  });

  it('creates, persists, reuses, and falls back when generating installation identifiers', () => {
    expect(getInstallationIdentifier()).toBe('11111111-2222-4333-8444-555555555555');
    expect(getInstallationIdentifier()).toBe('11111111-2222-4333-8444-555555555555');

    window.localStorage.removeItem(INSTALLATION_IDENTIFIER_KEY);
    const getRandomValues = vi.fn((values: Uint8Array) => {
      values.forEach((_value, index) => { values[index] = index; });
      return values;
    });
    vi.stubGlobal('crypto', { getRandomValues });

    expect(getInstallationIdentifier()).toBe('000102030405060708090a0b0c0d0e0f');
    expect(getRandomValues).toHaveBeenCalledOnce();
  });

  it('records the legal decision without replacing earlier acceptance timestamps', () => {
    window.localStorage.setItem('forger.terms.acceptedAt', '2025-01-01T00:00:00.000Z');

    expect(recordLegalWelcomeDecision(false)).toBe('2026-08-10T12:34:56.000Z');
    expect(window.localStorage.getItem('forger.terms.acceptedAt')).toBe('2025-01-01T00:00:00.000Z');
    expect(window.localStorage.getItem('forger.privacy.acceptedAt')).toBe('2026-08-10T12:34:56.000Z');
    expect(window.localStorage.getItem('forger.usageAnalytics.enabled')).toBe('false');
    expect(window.localStorage.getItem('forger.usageAnalytics.decidedAt')).toBe('2026-08-10T12:34:56.000Z');
    expect(window.localStorage.getItem(INSTALLATION_IDENTIFIER_KEY)).toBeTruthy();

    window.localStorage.removeItem('forger.terms.acceptedAt');
    window.localStorage.removeItem('forger.privacy.acceptedAt');
    recordLegalWelcomeDecision(true);
    expect(window.localStorage.getItem('forger.terms.acceptedAt')).toBe('2026-08-10T12:34:56.000Z');

    setUsageAnalyticsPreference(true);
    expect(getUsageAnalyticsEnabled()).toBe(true);
    expect(window.localStorage.getItem('forger.usageAnalytics.enabled')).toBe('true');
    expect(getUsageAnalyticsEnabled()).toBe(true);
  });

  it('honors opt-out for product events while always allowing consent events', async () => {
    setUsageAnalyticsPreference(false);
    expect(getUsageAnalyticsEnabled()).toBe(false);
    expect(shouldSubmitUsageEvent('catalog_viewed')).toBe(false);
    expect(shouldSubmitUsageEvent('usage_analytics_revoked')).toBe(true);

    submitUsageEvent({ eventName: 'catalog_viewed' });
    submitUsageEvent({ eventName: 'usage_analytics_revoked', occurredAt: '2026-01-01T00:00:00.000Z' });
    await Promise.resolve();

    expect(submitted).toEqual([
      expect.objectContaining({
        eventName: 'usage_analytics_revoked',
        occurredAt: '2026-01-01T00:00:00.000Z',
        installationIdentifier: '11111111-2222-4333-8444-555555555555',
      }),
    ]);
  });

  it('supplies event metadata and tolerates a missing or rejecting bridge', async () => {
    submitUsageEvent({ eventName: 'forger_opened', locale: 'es', surface: 'startup' });
    expect(submitted[0]).toMatchObject({
      eventName: 'forger_opened',
      locale: 'es',
      surface: 'startup',
      occurredAt: '2026-08-10T12:34:56.000Z',
    });

    Object.defineProperty(window, 'forger', { configurable: true, value: undefined });
    expect(() => submitUsageEvent({ eventName: 'forger_opened' })).not.toThrow();

    installBridge();
    submitUsageEventMock.mockRejectedValueOnce(new Error('offline'));
    submitUsageEvent({ eventName: 'forger_opened' });
    await Promise.resolve();
    await Promise.resolve();
    expect(submitUsageEventMock).toHaveBeenCalledOnce();
  });

  it('reports provider and official-tool connections with defaults and startup deduplication', () => {
    usageAnalytics.llmProviderConnected({ provider: 'codex' });
    usageAnalytics.llmProviderConnected({ provider: 'claude', surface: 'accounts', locale: 'es' });
    usageAnalytics.llmProviderConnected({ provider: 'antigravity', origin: 'detected_on_startup' });
    usageAnalytics.llmProviderConnected({ provider: 'antigravity', origin: 'detected_on_startup' });
    usageAnalytics.officialToolConnected({ toolId: 'github' });
    usageAnalytics.officialToolConnected({ toolId: 'gmail', origin: 'detected_on_startup' });
    usageAnalytics.officialToolConnected({ toolId: 'gmail', origin: 'detected_on_startup' });

    expect(submitted.map((event) => event.eventName)).toEqual([
      'llm_provider_connected',
      'chatgpt_connected',
      'llm_provider_connected',
      'llm_provider_connected',
      'official_tool_connected',
      'official_tool_connected',
    ]);
    expect(submitted[0].stringParameters).toEqual({ provider: 'codex', origin: 'user_action' });
    expect(submitted[2].stringParameters).toEqual({ provider: 'claude', origin: 'user_action' });
    expect(submitted[3].stringParameters).toEqual({ provider: 'antigravity', origin: 'detected_on_startup' });
  });

  it('reports catalog and local creation events across user, detected, and incomplete inputs', () => {
    usageAnalytics.catalogAppDownloaded({ appId: 'social-1', origin: 'detected_on_startup' });
    usageAnalytics.catalogAppDownloaded({ appId: 'social-1', origin: 'detected_on_startup' });
    usageAnalytics.catalogAppDownloaded({ origin: 'detected_on_startup', source: ' ' });
    usageAnalytics.catalogAppDownloaded({ appId: 'social-2', source: 'community', origin: 'user_action' });
    usageAnalytics.catalogAppDownloaded({ appId: 'social-3' });
    usageAnalytics.localAppCreated({ appId: 'own-1', origin: 'detected_on_startup' });
    usageAnalytics.localAppCreated({ appId: 'own-1', origin: 'detected_on_startup' });
    usageAnalytics.localAppCreated({ origin: 'detected_on_startup' });
    usageAnalytics.localAppCreated();

    expect(submitted).toHaveLength(7);
    expect(submitted[1].stringParameters).toEqual({ origin: 'detected_on_startup' });
    expect(submitted[2].stringParameters).toEqual({ app_id: 'social-2', app_source: 'community', origin: 'user_action' });
    expect(submitted.at(-1)).toMatchObject({
      eventName: 'local_app_created',
      surface: 'create',
      stringParameters: { app_source: 'own', origin: 'user_action' },
    });
  });

  it('classifies app open and modification events by ownership', () => {
    const own = makeApp({ id: 'own', privateLocal: true });
    const downloaded = makeApp({
      id: 'downloaded',
      socialSource: { userAppId: 1, slug: 'downloaded', ownerUsername: 'owner' },
    });
    const catalog = makeApp({ id: 'catalog' });

    usageAnalytics.appOpened({ appId: own.id, app: own });
    usageAnalytics.appOpened({ appId: downloaded.id, app: downloaded, surface: 'details', locale: 'es' });
    usageAnalytics.appOpened({ appId: catalog.id, app: catalog });
    usageAnalytics.appModified({ appId: own.id, app: own });
    usageAnalytics.appModified({ appId: downloaded.id, app: downloaded, origin: 'detected_on_startup' });
    usageAnalytics.appModified({ appId: catalog.id, app: null });

    expect(submitted.map((event) => event.eventName)).toEqual([
      'app_opened', 'own_app_opened',
      'app_opened', 'downloaded_app_opened',
      'app_opened',
      'own_app_modified', 'downloaded_app_modified',
    ]);
    expect(submitted[0].stringParameters?.app_source).toBe('own');
    expect(submitted[2].stringParameters?.app_source).toBe('downloaded');
    expect(submitted[4].stringParameters?.app_source).toBe('catalog');
    expect(submitted.at(-1)?.stringParameters?.origin).toBe('detected_on_startup');
  });

  it('reports simple actions and scans connected startup state once', () => {
    usageAnalytics.personalAgentCreated();
    usageAnalytics.personalAgentMessageSent();
    usageAnalytics.personalAgentMessageSent({ surface: 'conversation', locale: 'es' });
    usageAnalytics.automationCreated();
    usageAnalytics.detectedStartupState({
      providers: { codex: true, claude: false, antigravity: true },
      officialTools: [makeOfficialTool('github', true), makeOfficialTool('gmail', false)],
      apps: [
        makeApp({ id: 'social', socialSource: { userAppId: 1, slug: 'social', ownerUsername: 'owner' } }),
        makeApp({ id: 'own', privateLocal: true }),
        makeApp({ id: 'catalog' }),
      ],
    });
    usageAnalytics.detectedStartupState({ surface: 'resume', locale: 'es' });

    expect(submitted.map((event) => event.eventName)).toEqual([
      'personal_agent_created',
      'personal_agent_message_sent',
      'personal_agent_message_sent',
      'automation_created',
      'forger_opened',
      'llm_provider_connected',
      'llm_provider_connected',
      'official_tool_connected',
      'catalog_app_downloaded',
      'local_app_created',
      'forger_opened',
    ]);
    usageAnalytics.forgerOpened();
    expect(submitted.at(-1)).toMatchObject({ eventName: 'forger_opened', surface: 'startup' });
  });

  it('deduplicates the installation event per identifier and supports ChatGPT defaults', () => {
    submitForgerInstalledEvent();
    submitForgerInstalledEvent({ surface: 'welcome', locale: 'es' });
    window.localStorage.setItem(INSTALLATION_IDENTIFIER_KEY, 'replacement-installation');
    submitForgerInstalledEvent({ surface: 'welcome', locale: 'es' });
    submitChatGptConnectedEvent();
    submitChatGptConnectedEvent({ surface: 'provider', locale: 'es' });

    expect(window.localStorage.getItem(FORGER_INSTALLED_RECORDED_KEY)).toBe('replacement-installation');
    expect(submitted.map((event) => event.eventName)).toEqual([
      'forger_installed',
      'forger_installed',
      'chatgpt_connected',
      'chatgpt_connected',
    ]);
    expect(submitted[0].surface).toBe('onboarding');
    expect(submitted.at(-1)).toMatchObject({ surface: 'provider', locale: 'es' });
  });
});
