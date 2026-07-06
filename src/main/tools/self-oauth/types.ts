export const OAUTH_CLIENT_ID_SECRET = 'oauth_client_id';
export const OAUTH_CLIENT_SECRET_SECRET = 'oauth_client_secret';
export const OAUTH_REFRESH_TOKEN_SECRET = 'oauth_refresh_token';
export const OAUTH_ACCESS_TOKEN_SECRET = 'oauth_access_token';
export const OAUTH_ACCESS_TOKEN_EXPIRES_AT_SECRET = 'oauth_access_token_expires_at';
export const OAUTH_SCOPE_SECRET = 'oauth_scope';

export interface OAuthTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  scope?: string;
  error?: string;
  error_description?: string;
}

export interface DeviceCodeResponse {
  device_code?: string;
  user_code?: string;
  verification_uri?: string;
  verification_uri_complete?: string;
  expires_in?: number;
  interval?: number;
  error?: string;
  error_description?: string;
}

export class OAuthConnectionError extends Error {
  constructor(message: string, public readonly technicalCode: string) {
    super(message);
    this.name = 'OAuthConnectionError';
  }
}
