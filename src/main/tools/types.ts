import type {
  CallOfficialToolInput,
  CallOfficialToolResult,
  ConfigureOfficialToolInput,
  OfficialToolDefinition,
  OfficialToolRuntimeEvent,
  ToolMutationResult,
} from '../../shared/types';
import type { SecretsStore } from '../secrets-store';
import type { SelfOAuthCallbackServiceLike } from '../oauth-callback/types';

export interface InternalOAuthTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  scope?: string;
}

export interface InternalToolContext {
  metadataRoot: string;
  secretsStore: SecretsStore;
  locale?: string;
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
  selfOAuthCallbackService?: SelfOAuthCallbackServiceLike;
  appendLog?: (event: string, payload?: Record<string, unknown>) => Promise<void>;
  emitEvent?: (event: OfficialToolRuntimeEvent) => void;
}

export interface InternalToolModule {
  definition: OfficialToolDefinition;
  configure: (context: InternalToolContext, input?: ConfigureOfficialToolInput) => Promise<ToolMutationResult>;
  execute: (input: CallOfficialToolInput, context: InternalToolContext) => Promise<CallOfficialToolResult>;
  isConfigured?: (context: InternalToolContext) => Promise<boolean>;
  start?: (context: InternalToolContext) => Promise<void>;
  stop?: (context: InternalToolContext) => Promise<void>;
  deactivate?: (context: InternalToolContext) => Promise<void>;
}
