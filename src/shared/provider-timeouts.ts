import type { AgentProvider } from './types/agent-runtime';

export const DEFAULT_PROVIDER_INACTIVITY_TIMEOUT_MINUTES = 240;
export const PROVIDER_INACTIVITY_TIMEOUT_OPTIONS_MINUTES = [0, 30, 60, 120, 240, 480, 720] as const;

export const DEFAULT_PROVIDER_INACTIVITY_TIMEOUTS_MINUTES: Record<AgentProvider, number> = {
  codex: DEFAULT_PROVIDER_INACTIVITY_TIMEOUT_MINUTES,
  claude: DEFAULT_PROVIDER_INACTIVITY_TIMEOUT_MINUTES,
  antigravity: DEFAULT_PROVIDER_INACTIVITY_TIMEOUT_MINUTES,
};

export const normalizeProviderInactivityTimeoutMinutes = (
  value: unknown,
  fallback = DEFAULT_PROVIDER_INACTIVITY_TIMEOUT_MINUTES,
): number => {
  const roundedFallback = typeof fallback === 'number' && Number.isFinite(fallback)
    ? Math.round(fallback)
    : DEFAULT_PROVIDER_INACTIVITY_TIMEOUT_MINUTES;
  const normalizedFallback = PROVIDER_INACTIVITY_TIMEOUT_OPTIONS_MINUTES.includes(roundedFallback as (typeof PROVIDER_INACTIVITY_TIMEOUT_OPTIONS_MINUTES)[number])
    ? roundedFallback
    : DEFAULT_PROVIDER_INACTIVITY_TIMEOUT_MINUTES;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return normalizedFallback;
  }
  const rounded = Math.round(value);
  return PROVIDER_INACTIVITY_TIMEOUT_OPTIONS_MINUTES.includes(rounded as (typeof PROVIDER_INACTIVITY_TIMEOUT_OPTIONS_MINUTES)[number])
    ? rounded
    : normalizedFallback;
};

export const providerInactivityTimeoutMinutesToMs = (value: unknown): number =>
  normalizeProviderInactivityTimeoutMinutes(value) * 60_000;
