import type { AgentProvider } from '../../shared/types';
import type {
  LlmProviderAuthProfileResolver,
  LlmProviderResolvedAuthContext,
  LlmProviderResolvedAuthProfile,
} from './types';

export const resolveLlmProviderAuthContext = async (
  provider: AgentProvider,
  authProfileId: string | undefined,
  resolveAuthProfile?: LlmProviderAuthProfileResolver,
): Promise<LlmProviderResolvedAuthContext | null> => {
  if (!authProfileId) {
    return null;
  }
  if (!resolveAuthProfile) {
    return null;
  }
  const profile = await resolveAuthProfile(provider, authProfileId);
  assertValidAuthProfile(provider, authProfileId, profile);
  const environment: Record<string, string> = {};
  if (provider === 'codex' && profile.runtimeAuthMode === 'materialized' && profile.codexHome) {
    environment.CODEX_HOME = profile.codexHome;
  }
  if (provider === 'claude' && profile.runtimeAuthMode === 'materialized' && profile.claudeConfigDir) {
    environment.CLAUDE_CONFIG_DIR = profile.claudeConfigDir;
  }
  return {
    profile,
    runtimeAuthMode: profile.runtimeAuthMode,
    environment,
    ...(provider === 'codex' && profile.runtimeAuthMode === 'materialized' && profile.codexHome
      ? { codexHome: profile.codexHome }
      : {}),
    ...(provider === 'codex' && profile.runtimeAuthMode === 'materialized' && profile.rootCodexHome
      ? { rootCodexHome: profile.rootCodexHome }
      : {}),
  };
};

function assertValidAuthProfile(
  provider: AgentProvider,
  authProfileId: string,
  profile: LlmProviderResolvedAuthProfile | null | undefined,
): asserts profile is LlmProviderResolvedAuthProfile {
  if (!profile) {
    throw new Error('provider_auth_profile_not_found');
  }
  const normalizedAuthProfileId = authProfileId === `${provider}:local-active` ? `${provider}:system` : authProfileId;
  if (profile.id !== normalizedAuthProfileId || profile.provider !== provider) {
    throw new Error('provider_auth_profile_mismatch');
  }
  if (profile.status !== 'connected' && profile.connected !== true) {
    throw new Error('provider_auth_profile_not_connected');
  }
  if (profile.active === false) {
    throw new Error('provider_auth_profile_not_active');
  }
  if (provider === 'antigravity' && profile.runtimeAuthMode !== 'externalActiveOnly') {
    throw new Error('provider_auth_profile_unsupported');
  }
}
