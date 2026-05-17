import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import type { IpcMain } from 'electron';
import type { ForgerAccountSession } from '../shared/types';
import type { StoredForgerAccount } from './forger-account-store';
import type { ForgerBackendClient } from './forger-backend-client';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const CALLBACK_PATH = '/oauth/google/callback';
const OAUTH_TIMEOUT_MS = 30 * 60 * 1000;
const GOOGLE_LOGIN_SCOPES = ['openid', 'email', 'profile'] as const;

type AccountResult = ForgerAccountSession & { success: boolean; userMessage?: string; technicalCode?: string };

interface RegisterOptions {
  ipcMain: IpcMain;
  channel: string;
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

const log = (options: RegisterOptions, event: string, payload?: Record<string, unknown>) => {
  void options.appendLog?.(`forger_cloud_oauth:${event}`, payload ?? {});
};

const runGoogleLoginFlow = async (options: RegisterOptions): Promise<StoredForgerAccount & { success: boolean; userMessage?: string; technicalCode?: string }> => {
  const client = options.backendClient();
  if (!client) {
    return { success: false, authenticated: false, userMessage: 'No pudimos conectar con Forger Cloud.', technicalCode: 'backend_client_missing' };
  }

  const clientId = await client.getGoogleLoginOAuthClientId();
  const state = base64Url(randomBytes(32));
  const pkce = createPkcePair();
  let server: http.Server | null = null;
  let redirectUri = '';
  let settled = false;
  let listeningResolve: ((port: number) => void) | null = null;
  let listeningReject: ((error: Error) => void) | null = null;

  const callbackPromise = new Promise<StoredForgerAccount & { success: boolean; userMessage?: string; technicalCode?: string }>((resolve, reject) => {
    server = http.createServer((request, response) => {
      void (async () => {
        const requestUrl = new URL(request.url ?? '/', redirectUri || 'http://127.0.0.1');
        if (requestUrl.pathname !== CALLBACK_PATH) {
          sendHtml(response, 404, 'Forger Cloud', 'Esta ventana no corresponde al inicio de sesion de Forger Cloud.');
          return;
        }
        if (requestUrl.searchParams.get('state') !== state) {
          throw new ForgerCloudOAuthError('No pudimos validar el inicio de sesion con Google.', 'google_login_state_mismatch');
        }
        const oauthError = requestUrl.searchParams.get('error');
        if (oauthError) {
          throw new ForgerCloudOAuthError(
            oauthError === 'access_denied' ? 'Google cancelo el inicio de sesion.' : 'Google no autorizo el inicio de sesion.',
            oauthError === 'access_denied' ? 'google_login_access_denied' : 'google_login_google_error',
          );
        }
        const code = requestUrl.searchParams.get('code');
        if (!code) {
          throw new ForgerCloudOAuthError('Google no devolvio un codigo de autorizacion.', 'google_login_code_missing');
        }

        const result = await client.createGoogleLoginSession({
          clientId,
          code,
          codeVerifier: pkce.verifier,
          redirectUri,
        });

        if (!result.success) {
          throw new ForgerCloudOAuthError(result.userMessage ?? 'No pudimos iniciar sesion con Google.', result.technicalCode ?? 'google_login_failed');
        }

        sendHtml(response, 200, 'Forger Cloud', 'Sesion iniciada. Puedes volver a Forger.');
        settled = true;
        resolve(result);
      })().catch((error) => {
        const message = error instanceof Error ? error.message : 'No pudimos iniciar sesion con Google.';
        if (!response.headersSent) {
          sendHtml(response, 500, 'Forger Cloud', message);
        } else if (!response.writableEnded) {
          response.end();
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
        const error = new ForgerCloudOAuthError('No pudimos preparar el callback local de Google.', 'google_login_port_unavailable');
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

  const listeningPromise = new Promise<number>((resolve, reject) => {
    listeningResolve = resolve;
    listeningReject = reject;
  });

  let timeoutId: NodeJS.Timeout | null = null;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(() => reject(new ForgerCloudOAuthError('Google no respondio a tiempo.', 'google_login_timeout')), OAUTH_TIMEOUT_MS);
  });

  try {
    const port = await listeningPromise;
    redirectUri = `http://127.0.0.1:${port}${CALLBACK_PATH}`;
    const authUrl = new URL(AUTH_URL);
    authUrl.searchParams.set('client_id', clientId);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', GOOGLE_LOGIN_SCOPES.join(' '));
    authUrl.searchParams.set('state', state);
    authUrl.searchParams.set('code_challenge', pkce.challenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');
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
      const result = await runGoogleLoginFlow(options);
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
      const technicalCode = error instanceof ForgerCloudOAuthError ? error.technicalCode : 'google_login_unhandled_error';
      const userMessage = error instanceof Error ? error.message : 'No pudimos iniciar sesion con Google.';
      log(options, 'failed', { technicalCode });
      return { authenticated: false, success: false, userMessage, technicalCode };
    }
  });
};
