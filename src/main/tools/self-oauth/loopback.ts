import type http from 'node:http';
import type { InternalToolContext } from '../types';
import { getSharedCopy } from '../../../shared/i18n';
import { sendOAuthCallbackPage } from '../../oauth-callback/page';
import { createPkcePair, oauthState } from './crypto';
import { runEphemeralCallbackServer } from './ephemeral';
import { postForm } from './http';
import { storeTokenResponse } from './token-store';
import { OAuthConnectionError } from './types';

const DEFAULT_OAUTH_TIMEOUT_MS = 30 * 60 * 1000;
const cleanString = (value: unknown): string => typeof value === 'string' ? value.trim() : '';

export const runLoopbackOAuthFlow = async (
  context: InternalToolContext,
  options: {
    toolId: string; clientId: string; clientSecret: string; authUrl: string; tokenUrl: string;
    callbackPath: string; scopes: readonly string[]; authParams?: Record<string, string>;
    timeoutMs?: number; requireRefreshToken?: boolean;
  },
): Promise<void> => {
  const state = oauthState();
  const pkce = createPkcePair();
  let redirectUri = context.selfOAuthCallbackService?.callbackUrl(options.callbackPath) ?? '';
  let settled = false;
  let setupError: unknown;
  let cleanup: () => void = () => undefined;
  let close: () => Promise<void> = async () => undefined;
  const copy = getSharedCopy(context.locale).oauthCallback;

  const callbackPromise = new Promise<void>((resolve, reject) => {
    const handle = async (requestUrl: URL, response: http.ServerResponse): Promise<void> => {
      try {
        if (requestUrl.pathname !== options.callbackPath) return sendOAuthCallbackPage(response, 404, 'idle', 'Forger', copy.notFoundBody);
        if (requestUrl.searchParams.get('state') !== state) throw new OAuthConnectionError(copy.stateMismatch, `${options.toolId}_oauth_state_mismatch`);
        const oauthError = cleanString(requestUrl.searchParams.get('error'));
        if (oauthError) throw new OAuthConnectionError(copy.providerRejected, `${options.toolId}_oauth_provider_error`);
        const code = cleanString(requestUrl.searchParams.get('code'));
        if (!code) throw new OAuthConnectionError(copy.codeMissing, `${options.toolId}_oauth_code_missing`);
        const token = await postForm(options.tokenUrl, new URLSearchParams({
          client_id: options.clientId, client_secret: options.clientSecret, code,
          code_verifier: pkce.verifier, redirect_uri: redirectUri, grant_type: 'authorization_code',
        }), options.toolId, 'exchange');
        await storeTokenResponse(context, options.toolId, token, {
          clientId: options.clientId, clientSecret: options.clientSecret,
          requireRefreshToken: options.requireRefreshToken ?? true,
        });
        sendOAuthCallbackPage(response, 200, 'success', copy.successTitle, copy.successBody);
        settled = true;
        resolve();
      } catch (error) {
        if (!response.headersSent) {
          const body = error instanceof Error ? error.message : copy.errorBody;
          sendOAuthCallbackPage(response, 400, 'error', copy.errorTitle, body);
        }
        if (!settled) {
          settled = true;
          reject(error);
        }
      }
    };
    const flow = { type: options.toolId, callbackPath: options.callbackPath, expiresAt: Date.now() + (options.timeoutMs ?? DEFAULT_OAUTH_TIMEOUT_MS), handle };
    if (context.selfOAuthCallbackService && redirectUri) cleanup = context.selfOAuthCallbackService.registerFlow(flow);
    else void runEphemeralCallbackServer(flow).then((server) => { redirectUri = server.redirectUri; close = server.close; }).catch((error) => {
      setupError = error;
      reject(error);
    });
  });
  callbackPromise.catch(() => undefined);

  let timeoutId: NodeJS.Timeout | null = null;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(() => reject(new OAuthConnectionError('OAuth timed out.', `${options.toolId}_oauth_timeout`)), options.timeoutMs ?? DEFAULT_OAUTH_TIMEOUT_MS);
  });

  try {
    while (!redirectUri) {
      if (setupError) throw setupError;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const authUrl = new URL(options.authUrl);
    authUrl.searchParams.set('client_id', options.clientId);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', options.scopes.join(' '));
    authUrl.searchParams.set('state', state);
    authUrl.searchParams.set('code_challenge', pkce.challenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');
    for (const [key, value] of Object.entries(options.authParams ?? {})) authUrl.searchParams.set(key, value);
    await context.appendLog?.(`${options.toolId}_oauth:open_browser`, { callback: context.selfOAuthCallbackService ? 'shared' : 'ephemeral' });
    await context.openExternalUrl(authUrl.toString());
    await Promise.race([callbackPromise, timeout]);
    await context.appendLog?.(`${options.toolId}_oauth:completed`);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    cleanup();
    await close();
  }
};
