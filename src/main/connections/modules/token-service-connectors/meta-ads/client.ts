import {
  OAUTH_CLIENT_SECRET_SECRET,
  getStoredOAuthAccessToken,
} from '../../../../tools/self-oauth';
import type { InternalToolContext } from '../../../../tools/types';
import { clean, json, proof } from '../helpers';

export const ID = 'meta_ads';
export const AD_ACCOUNT_ID_SECRET = 'ad_account_id';
export const API_VERSION_SECRET = 'api_version';
export const META_SCOPES = ['ads_management', 'ads_read', 'leads_retrieval', 'pages_show_list', 'pages_read_engagement'];

export const version = async (context: InternalToolContext): Promise<string> =>
  clean(await context.secretsStore.getToolSecret(ID, API_VERSION_SECRET)) || 'v23.0';

export const tokenUrl = (v: string): string =>
  `https://graph.facebook.com/${v}/oauth/access_token`;

export const adAccount = (value: string): string =>
  clean(value).startsWith('act_') ? clean(value) : `act_${clean(value)}`;

export const graph = async (
  context: InternalToolContext,
  path: string,
  init: RequestInit = {},
): Promise<unknown> => {
  const v = await version(context);
  const token = await getStoredOAuthAccessToken(context, { toolId: ID, tokenUrl: tokenUrl(v) });
  const clientSecret = clean(await context.secretsStore.getToolSecret(ID, OAUTH_CLIENT_SECRET_SECRET));
  const url = new URL(`https://graph.facebook.com/${v}${path}`);
  const appProof = proof(token, clientSecret);
  if (appProof) url.searchParams.set('appsecret_proof', appProof);
  return json(url.toString(), { ...init, headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) } }, ID);
};

export const withParams = (path: string, values: Record<string, unknown>): string => {
  const url = new URL(`https://graph.local${path}`);
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== '') url.searchParams.set(key, String(value));
  }
  return `${url.pathname}${url.search}`;
};
