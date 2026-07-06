import { OAuthConnectionError, type OAuthTokenResponse } from './types';

export const postForm = async (
  url: string,
  body: URLSearchParams,
  toolId: string,
  purpose: string,
): Promise<OAuthTokenResponse> => {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
    },
    body,
  }).catch((error) => {
    const message = error instanceof Error ? error.message : 'OAuth request failed.';
    throw new OAuthConnectionError(message, `${toolId}_oauth_${purpose}_failed`);
  });
  const token = await response.json().catch(() => ({})) as OAuthTokenResponse;
  if (!response.ok || token.error) {
    throw new OAuthConnectionError(
      token.error_description || token.error || `OAuth ${purpose} failed.`,
      `${toolId}_oauth_${purpose}_failed`,
    );
  }
  return token;
};
