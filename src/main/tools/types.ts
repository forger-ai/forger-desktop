import type {
  CallOfficialToolInput,
  CallOfficialToolResult,
  OfficialToolDefinition,
  ToolMutationResult,
} from '../../shared/types';
import type { SecretsStore } from '../secrets-store';

export interface InternalOAuthTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  scope?: string;
}

export interface InternalToolContext {
  secretsStore: SecretsStore;
  getFreePort: () => Promise<number>;
  openExternalUrl: (url: string) => Promise<void>;
  isForgerAccountAuthenticated: () => boolean;
  getGmailOAuthClientId: () => Promise<string>;
  exchangeGmailOAuthCode: (input: {
    clientId: string;
    code: string;
    codeVerifier: string;
    redirectUri: string;
  }) => Promise<InternalOAuthTokenResponse>;
  refreshGmailOAuthAccessToken: (input: {
    clientId: string;
    refreshToken: string;
  }) => Promise<InternalOAuthTokenResponse>;
  appendLog?: (event: string, payload?: Record<string, unknown>) => Promise<void>;
}

export interface InternalToolModule {
  definition: OfficialToolDefinition;
  configure: (context: InternalToolContext) => Promise<ToolMutationResult>;
  execute: (input: CallOfficialToolInput, context: InternalToolContext) => Promise<CallOfficialToolResult>;
}
