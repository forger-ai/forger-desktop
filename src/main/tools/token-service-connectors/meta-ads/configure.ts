import type { ConfigureOfficialToolInput, ToolMutationResult } from '../../../../shared/types';
import {
  OAUTH_ACCESS_TOKEN_EXPIRES_AT_SECRET,
  OAUTH_ACCESS_TOKEN_SECRET,
  OAUTH_CLIENT_ID_SECRET,
  OAUTH_CLIENT_SECRET_SECRET,
  runLoopbackOAuthFlow,
} from '../../self-oauth';
import type { InternalToolContext } from '../../types';
import { clean } from '../helpers';
import { AD_ACCOUNT_ID_SECRET, API_VERSION_SECRET, ID, META_SCOPES, tokenUrl, version } from './client';

export const configureMetaAds = async (
  context: InternalToolContext,
  input?: ConfigureOfficialToolInput,
): Promise<ToolMutationResult> => {
  const provided = input?.secrets ?? {};
  const clientId = clean(provided[OAUTH_CLIENT_ID_SECRET]) || clean(await context.secretsStore.getToolSecret(ID, OAUTH_CLIENT_ID_SECRET));
  const clientSecret = clean(provided[OAUTH_CLIENT_SECRET_SECRET]) || clean(await context.secretsStore.getToolSecret(ID, OAUTH_CLIENT_SECRET_SECRET));
  const accountId = clean(provided[AD_ACCOUNT_ID_SECRET]) || clean(await context.secretsStore.getToolSecret(ID, AD_ACCOUNT_ID_SECRET));
  if (!clientId || !clientSecret || !accountId) return { success: false, userMessage: 'Completa client ID, client secret y Ad Account ID de Meta Ads.', technicalCode: 'meta_ads_oauth_credentials_required' };
  await context.secretsStore.setToolSecret(ID, OAUTH_CLIENT_ID_SECRET, clientId);
  await context.secretsStore.setToolSecret(ID, OAUTH_CLIENT_SECRET_SECRET, clientSecret);
  await context.secretsStore.setToolSecret(ID, AD_ACCOUNT_ID_SECRET, accountId);
  if (clean(provided[API_VERSION_SECRET])) await context.secretsStore.setToolSecret(ID, API_VERSION_SECRET, clean(provided[API_VERSION_SECRET]));
  if (clean(provided[OAUTH_ACCESS_TOKEN_SECRET])) {
    await context.secretsStore.setToolSecret(ID, OAUTH_ACCESS_TOKEN_SECRET, clean(provided[OAUTH_ACCESS_TOKEN_SECRET]));
    await context.secretsStore.setToolSecret(ID, OAUTH_ACCESS_TOKEN_EXPIRES_AT_SECRET, String(Date.now() + 3600_000));
    return { success: true, userMessage: 'Meta Ads conectado.' };
  }
  const v = await version(context);
  await runLoopbackOAuthFlow(context, {
    toolId: ID, clientId, clientSecret, authUrl: `https://www.facebook.com/${v}/dialog/oauth`,
    tokenUrl: tokenUrl(v), callbackPath: '/oauth/meta_ads/callback', scopes: META_SCOPES,
    requireRefreshToken: false,
  });
  return { success: true, userMessage: 'Meta Ads conectado.' };
};
