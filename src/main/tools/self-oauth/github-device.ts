import type { InternalToolContext } from '../types';
import { postForm } from './http';
import { storeTokenResponse } from './token-store';
import { OAUTH_CLIENT_ID_SECRET, OAuthConnectionError, type DeviceCodeResponse, type OAuthTokenResponse } from './types';

const sleep = async (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export const runGitHubDeviceOAuthFlow = async (
  context: InternalToolContext,
  options: { toolId: string; clientId: string; scopes: string[]; pollIntervalMs?: number; timeoutMs?: number },
): Promise<void> => {
  const device = await fetch('https://github.com/login/device/code', {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: options.clientId, scope: options.scopes.join(' ') }),
  }).then(async (response) => {
    const data = await response.json().catch(() => ({})) as DeviceCodeResponse;
    if (!response.ok || data.error || !data.device_code || !data.verification_uri) {
      throw new OAuthConnectionError(data.error_description || data.error || 'GitHub device authorization failed.', `${options.toolId}_oauth_device_code_failed`);
    }
    // Preserve the validation as a type-level contract for the polling phase.
    return { ...data, device_code: data.device_code, verification_uri: data.verification_uri };
  });

  const deviceCode = device.device_code;
  const verificationUri = device.verification_uri_complete ?? device.verification_uri;

  await context.secretsStore.setToolSecret(options.toolId, OAUTH_CLIENT_ID_SECRET, options.clientId);
  await context.openExternalUrl(verificationUri);
  const deadline = Date.now() + (options.timeoutMs ?? Math.max(1, device.expires_in ?? 900) * 1000);
  let intervalMs = options.pollIntervalMs ?? Math.max(1, device.interval ?? 5) * 1000;

  while (Date.now() < deadline) {
    await sleep(intervalMs);
    const token = await postForm('https://github.com/login/oauth/access_token', new URLSearchParams({
      client_id: options.clientId,
      device_code: deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    }), options.toolId, 'device_poll').catch((error) => {
      if (error instanceof OAuthConnectionError && error.message === 'authorization_pending') return { error: 'authorization_pending' } as OAuthTokenResponse;
      if (error instanceof OAuthConnectionError && error.message === 'slow_down') {
        intervalMs += 5_000;
        return { error: 'slow_down' } as OAuthTokenResponse;
      }
      throw error;
    });
    if (token.error === 'authorization_pending' || token.error === 'slow_down') continue;
    await storeTokenResponse(context, options.toolId, token, { clientId: options.clientId, requireRefreshToken: false });
    return;
  }
  throw new OAuthConnectionError('GitHub device authorization timed out.', `${options.toolId}_oauth_device_timeout`);
};
