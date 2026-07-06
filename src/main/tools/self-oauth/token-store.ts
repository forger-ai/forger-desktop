import type { InternalToolContext } from '../types';
import { postForm } from './http';
import {
  OAUTH_ACCESS_TOKEN_EXPIRES_AT_SECRET,
  OAUTH_ACCESS_TOKEN_SECRET,
  OAUTH_CLIENT_ID_SECRET,
  OAUTH_CLIENT_SECRET_SECRET,
  OAUTH_REFRESH_TOKEN_SECRET,
  OAUTH_SCOPE_SECRET,
  OAuthConnectionError,
  type OAuthTokenResponse,
} from './types';

const ACCESS_TOKEN_REFRESH_SKEW_MS = 60_000;

export const storeTokenResponse = async (
  context: InternalToolContext,
  toolId: string,
  token: OAuthTokenResponse,
  options: { clientId?: string; clientSecret?: string; requireRefreshToken?: boolean } = {},
): Promise<void> => {
  if (!token.access_token) throw new OAuthConnectionError('OAuth did not return an access token.', `${toolId}_oauth_access_token_missing`);
  if (options.requireRefreshToken && !token.refresh_token) throw new OAuthConnectionError('OAuth did not return a refresh token.', `${toolId}_oauth_refresh_token_missing`);
  if (options.clientId) await context.secretsStore.setToolSecret(toolId, OAUTH_CLIENT_ID_SECRET, options.clientId);
  if (options.clientSecret) await context.secretsStore.setToolSecret(toolId, OAUTH_CLIENT_SECRET_SECRET, options.clientSecret);
  await context.secretsStore.setToolSecret(toolId, OAUTH_ACCESS_TOKEN_SECRET, token.access_token);
  if (token.refresh_token) await context.secretsStore.setToolSecret(toolId, OAUTH_REFRESH_TOKEN_SECRET, token.refresh_token);
  if (token.scope) await context.secretsStore.setToolSecret(toolId, OAUTH_SCOPE_SECRET, token.scope);
  if (typeof token.expires_in === 'number' && Number.isFinite(token.expires_in)) {
    await context.secretsStore.setToolSecret(toolId, OAUTH_ACCESS_TOKEN_EXPIRES_AT_SECRET, String(Date.now() + Math.max(0, token.expires_in) * 1000));
  }
};

export const getStoredOAuthAccessToken = async (
  context: InternalToolContext,
  options: { toolId: string; tokenUrl: string; clientIdSecret?: string; clientSecretSecret?: string; refreshTokenSecret?: string },
): Promise<string> => {
  const toolId = options.toolId;
  const currentToken = await context.secretsStore.getToolSecret(toolId, OAUTH_ACCESS_TOKEN_SECRET);
  const expiresAt = Number(await context.secretsStore.getToolSecret(toolId, OAUTH_ACCESS_TOKEN_EXPIRES_AT_SECRET));
  if (currentToken && (!Number.isFinite(expiresAt) || expiresAt > Date.now() + ACCESS_TOKEN_REFRESH_SKEW_MS)) return currentToken;

  const clientId = await context.secretsStore.getToolSecret(toolId, options.clientIdSecret ?? OAUTH_CLIENT_ID_SECRET);
  const clientSecret = await context.secretsStore.getToolSecret(toolId, options.clientSecretSecret ?? OAUTH_CLIENT_SECRET_SECRET);
  const refreshToken = await context.secretsStore.getToolSecret(toolId, options.refreshTokenSecret ?? OAUTH_REFRESH_TOKEN_SECRET);
  if (!clientId || !clientSecret || !refreshToken) throw new OAuthConnectionError('OAuth connection is not configured.', `${toolId}_oauth_not_connected`);

  const token = await postForm(options.tokenUrl, new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  }), toolId, 'refresh');
  await storeTokenResponse(context, toolId, token, { clientId, clientSecret });
  return token.access_token!;
};
