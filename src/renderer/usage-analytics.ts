import type { AgentProvider, AppSummary, OfficialToolSummary, SubmitUsageEventInput, UsageEventName } from '@shared/types';

const TERMS_ACCEPTED_AT_KEY = 'forger.terms.acceptedAt';
const PRIVACY_ACCEPTED_AT_KEY = 'forger.privacy.acceptedAt';
const USAGE_ANALYTICS_ENABLED_KEY = 'forger.usageAnalytics.enabled';
const USAGE_ANALYTICS_DECIDED_AT_KEY = 'forger.usageAnalytics.decidedAt';
const INSTALLATION_IDENTIFIER_KEY = 'forger.installation.identifier';
const FORGER_INSTALLED_RECORDED_KEY = 'forger.usageAnalytics.forgerInstalledRecorded';
const DETECTED_USAGE_EVENT_PREFIX = 'forger.usageAnalytics.detected';

const CONSENT_EVENTS = new Set<UsageEventName>([
  'forger_installed',
  'usage_analytics_accepted',
  'usage_analytics_declined',
  'usage_analytics_revoked',
  'usage_analytics_enabled',
  'settings_usage_analytics_changed',
]);

type UsageAnalyticsOrigin =
  | 'user_action'
  | 'detected_on_startup';

type UsageAnalyticsContext = Pick<SubmitUsageEventInput, 'locale' | 'surface'>;

const appSource = (app?: Pick<AppSummary, 'privateLocal' | 'socialSource'> | null) => {
  if (app?.privateLocal) {
    return 'own';
  }
  if (app?.socialSource) {
    return 'downloaded';
  }
  return 'catalog';
};

const appSpecificEventName = (
  app: Pick<AppSummary, 'privateLocal' | 'socialSource'> | null | undefined,
  eventType: 'opened' | 'modified',
): Extract<UsageEventName, 'own_app_opened' | 'downloaded_app_opened' | 'own_app_modified' | 'downloaded_app_modified'> | null => {
  if (app?.privateLocal) {
    return eventType === 'opened' ? 'own_app_opened' : 'own_app_modified';
  }
  if (app?.socialSource) {
    return eventType === 'opened' ? 'downloaded_app_opened' : 'downloaded_app_modified';
  }
  return null;
};

const compactStringParameters = (parameters: Record<string, string | undefined>) => Object.fromEntries(
  Object.entries(parameters).filter(([, value]) => typeof value === 'string' && value.trim().length > 0),
) as Record<string, string>;

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

const submitDetectedUsageEventOnce = (
  dedupeKey: string,
  input: Omit<SubmitUsageEventInput, 'installationIdentifier'>,
) => {
  const installationIdentifier = getInstallationIdentifier();
  const storageKey = `${DETECTED_USAGE_EVENT_PREFIX}.${installationIdentifier}.${dedupeKey}`;
  if (window.localStorage.getItem(storageKey)) {
    return;
  }
  window.localStorage.setItem(storageKey, new Date().toISOString());
  submitUsageEvent(input);
};

export const usageAnalytics = {
  forgerOpened(input: UsageAnalyticsContext = {}) {
    submitUsageEvent({
      eventName: 'forger_opened',
      surface: input.surface ?? 'startup',
      locale: input.locale,
    });
  },

  llmProviderConnected(input: UsageAnalyticsContext & { provider: AgentProvider; origin?: UsageAnalyticsOrigin }) {
    const event = {
      eventName: 'llm_provider_connected',
      surface: input.surface ?? 'settings',
      locale: input.locale,
      stringParameters: compactStringParameters({
        provider: input.provider,
        origin: input.origin ?? 'user_action',
      }),
    } satisfies Omit<SubmitUsageEventInput, 'installationIdentifier'>;

    if (input.origin === 'detected_on_startup') {
      submitDetectedUsageEventOnce(`llm_provider_connected.${input.provider}`, event);
    } else {
      submitUsageEvent(event);
    }

    if (input.provider === 'codex' && input.origin !== 'detected_on_startup') {
      submitChatGptConnectedEvent({ surface: input.surface ?? 'settings', locale: input.locale });
    }
  },

  officialToolConnected(input: UsageAnalyticsContext & { toolId: string; origin?: UsageAnalyticsOrigin }) {
    const event = {
      eventName: 'official_tool_connected',
      surface: input.surface ?? 'tools',
      locale: input.locale,
      stringParameters: compactStringParameters({
        tool_id: input.toolId,
        origin: input.origin ?? 'user_action',
      }),
    } satisfies Omit<SubmitUsageEventInput, 'installationIdentifier'>;

    if (input.origin === 'detected_on_startup') {
      submitDetectedUsageEventOnce(`official_tool_connected.${input.toolId}`, event);
    } else {
      submitUsageEvent(event);
    }
  },

  catalogAppDownloaded(input: UsageAnalyticsContext & { appId?: string; source?: string; origin?: UsageAnalyticsOrigin }) {
    const event = {
      eventName: 'catalog_app_downloaded',
      surface: input.surface ?? 'catalog',
      locale: input.locale,
      stringParameters: compactStringParameters({
        app_id: input.appId,
        app_source: input.source ?? 'downloaded',
        origin: input.origin ?? 'user_action',
      }),
    } satisfies Omit<SubmitUsageEventInput, 'installationIdentifier'>;

    if (input.origin === 'detected_on_startup' && input.appId) {
      submitDetectedUsageEventOnce(`catalog_app_downloaded.${input.appId}`, event);
    } else {
      submitUsageEvent(event);
    }
  },

  localAppCreated(input: UsageAnalyticsContext & { appId?: string; origin?: UsageAnalyticsOrigin } = {}) {
    const event = {
      eventName: 'local_app_created',
      surface: input.surface ?? 'create',
      locale: input.locale,
      stringParameters: compactStringParameters({
        app_id: input.appId,
        app_source: 'own',
        origin: input.origin ?? 'user_action',
      }),
    } satisfies Omit<SubmitUsageEventInput, 'installationIdentifier'>;

    if (input.origin === 'detected_on_startup' && input.appId) {
      submitDetectedUsageEventOnce(`local_app_created.${input.appId}`, event);
    } else {
      submitUsageEvent(event);
    }
  },

  appOpened(input: UsageAnalyticsContext & { appId: string; app?: AppSummary | null }) {
    submitUsageEvent({
      eventName: 'app_opened',
      surface: input.surface ?? 'app',
      locale: input.locale,
      stringParameters: compactStringParameters({
        app_id: input.appId,
        app_source: appSource(input.app),
      }),
    });
    const eventName = appSpecificEventName(input.app, 'opened');
    if (!eventName) {
      return;
    }
    submitUsageEvent({
      eventName,
      surface: input.surface ?? 'app',
      locale: input.locale,
      stringParameters: compactStringParameters({
        app_id: input.appId,
        app_source: appSource(input.app),
        origin: 'user_action',
      }),
    });
  },

  appModified(input: UsageAnalyticsContext & { appId: string; app?: AppSummary | null; origin?: UsageAnalyticsOrigin }) {
    const eventName = appSpecificEventName(input.app, 'modified');
    if (!eventName) {
      return;
    }
    submitUsageEvent({
      eventName,
      surface: input.surface ?? 'chat',
      locale: input.locale,
      stringParameters: compactStringParameters({
        app_id: input.appId,
        app_source: appSource(input.app),
        origin: input.origin ?? 'user_action',
      }),
    });
  },

  personalAgentCreated(input: UsageAnalyticsContext = {}) {
    submitUsageEvent({
      eventName: 'personal_agent_created',
      surface: input.surface ?? 'agents',
      locale: input.locale,
      stringParameters: { origin: 'user_action' },
    });
  },

  personalAgentMessageSent(input: UsageAnalyticsContext = {}) {
    submitUsageEvent({
      eventName: 'personal_agent_message_sent',
      surface: input.surface ?? 'agents',
      locale: input.locale,
      stringParameters: { origin: 'user_action' },
    });
  },

  automationCreated(input: UsageAnalyticsContext = {}) {
    submitUsageEvent({
      eventName: 'automation_created',
      surface: input.surface ?? 'automations',
      locale: input.locale,
      stringParameters: { origin: 'user_action' },
    });
  },

  detectedStartupState(input: UsageAnalyticsContext & {
    apps?: AppSummary[];
    providers?: Partial<Record<AgentProvider, boolean>>;
    officialTools?: OfficialToolSummary[];
  }) {
    this.forgerOpened({ surface: input.surface ?? 'startup', locale: input.locale });
    for (const [provider, connected] of Object.entries(input.providers ?? {}) as Array<[AgentProvider, boolean | undefined]>) {
      if (connected) {
        this.llmProviderConnected({
          provider,
          surface: input.surface ?? 'startup',
          locale: input.locale,
          origin: 'detected_on_startup',
        });
      }
    }
    for (const tool of input.officialTools ?? []) {
      if (tool.configured) {
        this.officialToolConnected({
          toolId: tool.id,
          surface: input.surface ?? 'startup',
          locale: input.locale,
          origin: 'detected_on_startup',
        });
      }
    }
    for (const app of input.apps ?? []) {
      if (app.socialSource) {
        this.catalogAppDownloaded({
          appId: app.id,
          source: 'social',
          surface: input.surface ?? 'startup',
          locale: input.locale,
          origin: 'detected_on_startup',
        });
      } else if (app.privateLocal) {
        this.localAppCreated({
          appId: app.id,
          surface: input.surface ?? 'startup',
          locale: input.locale,
          origin: 'detected_on_startup',
        });
      }
    }
  },
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
