import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import type { IpcMain } from 'electron';
import type { ForgerAccountSession } from '../shared/types';
import type { StoredForgerAccount } from './forger-account-store';
import type { ForgerBackendClient } from './forger-backend-client';

const PROVIDERS = {
  google: {
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    callbackPath: '/oauth/google/callback',
    scopes: ['openid', 'email', 'profile'],
    displayName: 'Google',
    technicalPrefix: 'google_login',
    providerErrorCode: 'google_login_google_error',
    usePkce: true,
  },
  apple: {
    authUrl: 'https://appleid.apple.com/auth/authorize',
    callbackPath: '/oauth/apple/callback',
    scopes: ['email', 'name'],
    displayName: 'Apple',
    technicalPrefix: 'apple_login',
    providerErrorCode: 'apple_login_provider_error',
    usePkce: false,
  },
} as const;
const OAUTH_TIMEOUT_MS = 30 * 60 * 1000;
type OAuthProvider = keyof typeof PROVIDERS;

type AccountResult = ForgerAccountSession & { success: boolean; userMessage?: string; technicalCode?: string };

interface RegisterOptions {
  ipcMain: IpcMain;
  channel: string;
  provider?: OAuthProvider;
  backendClient: () => ForgerBackendClient | null;
  saveAccount: (
    account: StoredForgerAccount,
    details?: { userMessage?: string; technicalCode?: string },
  ) => Promise<ForgerAccountSession & { userMessage?: string; technicalCode?: string }>;
  openExternalUrl: (url: string) => Promise<void>;
  appendLog?: (event: string, payload?: Record<string, unknown>) => Promise<void>;
  refreshCatalog?: () => Promise<void>;
}

class ForgerCloudOAuthError extends Error {
  constructor(message: string, public readonly technicalCode: string) {
    super(message);
    this.name = 'ForgerCloudOAuthError';
  }
}

const base64Url = (buffer: Buffer): string =>
  buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');

const createPkcePair = (): { verifier: string; challenge: string } => {
  const verifier = base64Url(randomBytes(48));
  const challenge = base64Url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
};

const closeServer = async (server: http.Server): Promise<void> =>
  new Promise((resolve) => {
    server.close(() => resolve());
  });

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const sendHtml = (response: http.ServerResponse, statusCode: number, title: string, body: string): void => {
  const escapedTitle = escapeHtml(title);
  const escapedBody = escapeHtml(body);
  response.writeHead(statusCode, { 'Content-Type': 'text/html; charset=utf-8' });
  response.end(`<!doctype html>
<html lang="es">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapedTitle}</title></head>
<body style="font-family: system-ui, -apple-system, BlinkMacSystemFont, sans-serif; min-height: 100vh; display: grid; place-items: center; margin: 0; background: #101418; color: #f3f5f7;">
  <main style="max-width: 520px; padding: 32px; text-align: center;">
    <h1>${escapedTitle}</h1>
    <p>${escapedBody}</p>
  </main>
</body>
</html>`);
};

const log = (options: RegisterOptions, event: string, payload: Record<string, unknown>) => {
  void options.appendLog?.(`forger_cloud_oauth:${event}`, payload);
};

const runProviderLoginFlow = async (options: RegisterOptions): Promise<StoredForgerAccount & { success: boolean; userMessage?: string; technicalCode?: string }> => {
  const providerName = options.provider ?? 'google';
  const provider = PROVIDERS[providerName];
  const client = options.backendClient();
  if (!client) {
    return { success: false, authenticated: false, userMessage: 'No pudimos conectar con Forger Cloud.', technicalCode: 'backend_client_missing' };
  }

  const appleConfig = providerName === 'apple' ? await client.getAppleLoginOAuthConfig() : null;
  const clientId = providerName === 'google'
    ? await client.getGoogleLoginOAuthClientId()
    : appleConfig?.clientId ?? '';
  const state = base64Url(randomBytes(32));
  let expectedCallbackState = state;
  const nonce = base64Url(randomBytes(32));
  const pkce = provider.usePkce ? createPkcePair() : null;
  let server: http.Server | null = null;
  let redirectUri = 'http://127.0.0.1';
  let exchangeRedirectUri = '';
  let settled = false;
  let listeningResolve: ((port: number) => void) | null = null;
  let listeningReject: ((error: Error) => void) | null = null;

  const callbackPromise = new Promise<StoredForgerAccount & { success: boolean; userMessage?: string; technicalCode?: string }>((resolve, reject) => {
    server = http.createServer((request, response) => {
      void (async () => {
        const requestUrl = new URL(String(request.url), redirectUri);
        if (requestUrl.pathname !== provider.callbackPath) {
          sendHtml(response, 404, 'Forger Cloud', 'Esta ventana no corresponde al inicio de sesion de Forger Cloud.');
          return;
        }
        if (requestUrl.searchParams.get('state') !== expectedCallbackState) {
          throw new ForgerCloudOAuthError(`No pudimos validar el inicio de sesion con ${provider.displayName}.`, `${provider.technicalPrefix}_state_mismatch`);
        }
        const oauthError = requestUrl.searchParams.get('error');
        if (oauthError) {
          throw new ForgerCloudOAuthError(
            oauthError === 'access_denied' ? `${provider.displayName} cancelo el inicio de sesion.` : `${provider.displayName} no autorizo el inicio de sesion.`,
            oauthError === 'access_denied' ? `${provider.technicalPrefix}_access_denied` : provider.providerErrorCode,
          );
        }
        const code = requestUrl.searchParams.get('code');
        if (!code) {
          throw new ForgerCloudOAuthError(`${provider.displayName} no devolvio un codigo de autorizacion.`, `${provider.technicalPrefix}_code_missing`);
        }

        const result = providerName === 'google'
          ? await client.createGoogleLoginSession({
            clientId,
            code,
            codeVerifier: pkce!.verifier,
            redirectUri: exchangeRedirectUri,
          })
          : await client.createAppleLoginSession({
            clientId,
            code,
            nonce,
            redirectUri: exchangeRedirectUri,
          });

        if (!result.success) {
          throw new ForgerCloudOAuthError(result.userMessage ?? `No pudimos iniciar sesion con ${provider.displayName}.`, result.technicalCode ?? `${provider.technicalPrefix}_failed`);
        }

        sendHtml(response, 200, 'Forger Cloud', 'Sesion iniciada. Puedes volver a Forger.');
        settled = true;
        resolve(result);
      })().catch((error) => {
	        const message = error instanceof Error ? error.message : `No pudimos iniciar sesion con ${provider.displayName}.`;
	        if (!response.headersSent) {
	          sendHtml(response, 500, 'Forger Cloud', message);
	        }
        if (!settled) {
          settled = true;
          reject(error);
        }
      });
    });

    server.on('error', (error) => {
      listeningReject?.(error);
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server?.address();
      if (!address || typeof address !== 'object') {
        const error = new ForgerCloudOAuthError(`No pudimos preparar el callback local de ${provider.displayName}.`, `${provider.technicalPrefix}_port_unavailable`);
        listeningReject?.(error);
        if (!settled) {
          settled = true;
          reject(error);
        }
        return;
      }
      listeningResolve?.(address.port);
    });
  });
  callbackPromise.catch(() => undefined);

  const listeningPromise = new Promise<number>((resolve, reject) => {
    listeningResolve = resolve;
    listeningReject = reject;
  });

  let timeoutId: NodeJS.Timeout | null = null;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(() => reject(new ForgerCloudOAuthError(`${provider.displayName} no respondio a tiempo.`, `${provider.technicalPrefix}_timeout`)), OAUTH_TIMEOUT_MS);
  });

  try {
    const port = await listeningPromise;
    redirectUri = `http://127.0.0.1:${port}${provider.callbackPath}`;
    exchangeRedirectUri = providerName === 'apple' ? appleConfig?.redirectUri ?? '' : redirectUri;
    if (!exchangeRedirectUri) {
      throw new ForgerCloudOAuthError('Apple login no esta configurado en Forger Cloud.', 'apple_login_redirect_missing');
    }
    const authState = providerName === 'apple'
      ? `${state}.${base64Url(Buffer.from(redirectUri))}`
      : state;
    expectedCallbackState = authState;
    const authUrl = new URL(provider.authUrl);
    authUrl.searchParams.set('client_id', clientId);
    authUrl.searchParams.set('redirect_uri', exchangeRedirectUri);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', provider.scopes.join(' '));
    authUrl.searchParams.set('state', authState);
    if (providerName === 'apple') {
      authUrl.searchParams.set('nonce', base64Url(createHash('sha256').update(nonce).digest()));
    }
    if (pkce) {
      authUrl.searchParams.set('code_challenge', pkce.challenge);
      authUrl.searchParams.set('code_challenge_method', 'S256');
    }
    log(options, 'open_browser', { port });
    await options.openExternalUrl(authUrl.toString());
    return await Promise.race([callbackPromise, timeout]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    if (server) {
      await closeServer(server).catch(() => undefined);
    }
  }
};

export const registerForgerCloudOAuth = (options: RegisterOptions): void => {
  options.ipcMain.handle(options.channel, async (): Promise<AccountResult> => {
    try {
      const result = await runProviderLoginFlow(options);
      if (result.success) {
        const account = await options.saveAccount(result, {
          userMessage: result.userMessage,
          technicalCode: result.technicalCode,
        });
        await options.refreshCatalog?.();
        return { ...account, success: true, userMessage: result.userMessage, technicalCode: result.technicalCode };
      }
      return result;
    } catch (error) {
      const providerName = options.provider ?? 'google';
      const provider = PROVIDERS[providerName];
      const technicalCode = error instanceof ForgerCloudOAuthError ? error.technicalCode : `${provider.technicalPrefix}_unhandled_error`;
      const userMessage = error instanceof Error ? error.message : `No pudimos iniciar sesion con ${provider.displayName}.`;
      log(options, 'failed', { technicalCode });
      return { authenticated: false, success: false, userMessage, technicalCode };
    }
  });
};
