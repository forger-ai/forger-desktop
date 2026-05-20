import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import type { Server } from 'node:http';
import type { InternalToolContext } from '../types';
import {
  META_GRAPH_API_VERSION,
  META_SCOPES,
  META_TOOL_ID,
  META_USER_TOKEN_SECRET,
  type MetaTokenResponse,
} from './types';

const AUTH_URL = `https://www.facebook.com/${META_GRAPH_API_VERSION}/dialog/oauth`;
const CALLBACK_PATH = '/oauth/meta/callback';
const OAUTH_TIMEOUT_MS = 30 * 60 * 1000;

// Meta does NOT allow arbitrary loopback ports the way Google's installed-
// app flow does. The Meta App must explicitly list each redirect URI in
// "Valid OAuth Redirect URIs". The Forger Cloud-managed Meta App registers
// the ports below; the OAuth flow tries them in order until it finds one
// that is free. Adding ports here without also adding them in the Meta
// App settings will result in an "Invalid redirect URI" error from Meta.
const PREFERRED_REDIRECT_PORTS = [7861, 7862, 7863, 7864, 7865, 7866, 7867, 7868, 7869, 7870] as const;

export class MetaOAuthError extends Error {
  constructor(
    message: string,
    public readonly technicalCode: string,
  ) {
    super(message);
    this.name = 'MetaOAuthError';
  }
}

const base64Url = (buffer: Buffer): string =>
  buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');

const createPkcePair = (): { verifier: string; challenge: string } => {
  const verifier = base64Url(randomBytes(48));
  const challenge = base64Url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
};

const getClientId = async (context: InternalToolContext): Promise<string> => {
  if (!context.isForgerAccountAuthenticated()) {
    throw new MetaOAuthError(
      'Inicia sesion en Forger antes de conectar Meta.',
      'forger_account_required',
    );
  }
  const clientId = (await context.getMetaOAuthClientId()).trim();
  if (!clientId) {
    throw new MetaOAuthError(
      'Meta necesita una app OAuth configurada en Forger Cloud.',
      'meta_oauth_client_missing',
    );
  }
  return clientId;
};

const toMetaOAuthError = (
  error: unknown,
  fallbackMessage: string,
  fallbackCode: string,
): MetaOAuthError => {
  if (error instanceof MetaOAuthError) {
    return error;
  }
  if (error instanceof Error) {
    const technicalCode = typeof (error as Error & { technicalCode?: unknown }).technicalCode === 'string'
      ? (error as Error & { technicalCode: string }).technicalCode
      : fallbackCode;
    return new MetaOAuthError(error.message || fallbackMessage, technicalCode);
  }
  return new MetaOAuthError(fallbackMessage, fallbackCode);
};

const exchangeCode = async (input: {
  clientId: string;
  code: string;
  codeVerifier: string;
  redirectUri: string;
  context: InternalToolContext;
}): Promise<MetaTokenResponse> => {
  if (!input.context.isForgerAccountAuthenticated()) {
    throw new MetaOAuthError(
      'Inicia sesion en Forger antes de conectar Meta.',
      'forger_account_required',
    );
  }
  try {
    return await input.context.exchangeMetaOAuthCode({
      clientId: input.clientId,
      code: input.code,
      codeVerifier: input.codeVerifier,
      redirectUri: input.redirectUri,
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new MetaOAuthError(
        'Meta no respondio a tiempo durante OAuth.',
        'meta_oauth_token_timeout',
      );
    }
    throw toMetaOAuthError(
      error,
      'Forger Cloud no pudo completar OAuth con Meta.',
      'meta_oauth_backend_exchange_failed',
    );
  }
};

export const refreshMetaAccessToken = async (context: InternalToolContext): Promise<string> => {
  if (!context.isForgerAccountAuthenticated()) {
    throw new MetaOAuthError(
      'Inicia sesion en Forger para usar Meta.',
      'forger_account_required',
    );
  }
  const clientId = await getClientId(context);
  const userToken = await context.secretsStore.getToolSecret(META_TOOL_ID, META_USER_TOKEN_SECRET);
  if (!userToken) {
    throw new MetaOAuthError('Meta no esta conectado.', 'meta_oauth_not_connected');
  }

  // Meta does not use a separate refresh_token. Instead, we exchange the
  // current long-lived token for a fresh long-lived token via Forger Cloud
  // (which holds the App Secret needed for the exchange call).
  const token = await context.refreshMetaOAuthAccessToken({
    clientId,
    userToken,
  }).catch((error) => {
    throw toMetaOAuthError(
      error,
      'Forger Cloud no pudo renovar Meta.',
      'meta_oauth_backend_refresh_failed',
    );
  });
  if (!token.access_token) {
    throw new MetaOAuthError('Meta no devolvio access token.', 'meta_oauth_access_token_missing');
  }
  // Persist the rotated token so future calls re-use it.
  const saved = await context.secretsStore.setToolSecret(META_TOOL_ID, META_USER_TOKEN_SECRET, token.access_token);
  if (!saved.success) {
    throw new MetaOAuthError(
      saved.userMessage,
      saved.technicalCode ?? 'meta_oauth_secret_save_failed',
    );
  }
  return token.access_token;
};

export const getCachedUserAccessToken = async (
  context: InternalToolContext,
): Promise<string> => {
  const userToken = await context.secretsStore.getToolSecret(META_TOOL_ID, META_USER_TOKEN_SECRET);
  if (!userToken) {
    throw new MetaOAuthError('Meta no esta conectado.', 'meta_oauth_not_connected');
  }
  return userToken;
};

const closeServer = async (server: Server): Promise<void> =>
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
  const success = statusCode >= 200 && statusCode < 300;
  const escapedTitle = escapeHtml(title);
  const escapedBody = escapeHtml(body);
  response.writeHead(statusCode, { 'Content-Type': 'text/html; charset=utf-8' });
  response.end(`<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapedTitle}</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #101418;
      --panel: #161b21;
      --line: #2a323c;
      --text: #f3f5f7;
      --muted: #aab2bd;
      --ok: #8bd39b;
      --danger: #ff8a8a;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      padding: 32px;
      background:
        radial-gradient(circle at 70% 15%, rgba(255, 114, 87, 0.12), transparent 34%),
        var(--bg);
      color: var(--text);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    main {
      width: min(520px, 100%);
      border: 1px solid var(--line);
      border-radius: 12px;
      background: color-mix(in srgb, var(--panel) 94%, transparent);
      padding: 28px;
      box-shadow: 0 24px 80px rgba(0, 0, 0, 0.32);
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 24px;
      color: var(--muted);
      font-weight: 700;
      letter-spacing: 0;
    }
    .mark {
      width: 30px;
      height: 30px;
      border-radius: 8px;
      display: grid;
      place-items: center;
      background: #f4f4f2;
      color: #101418;
      font-weight: 900;
    }
    .status {
      width: 42px;
      height: 42px;
      border-radius: 50%;
      display: grid;
      place-items: center;
      margin-bottom: 16px;
      background: ${success ? 'rgba(139, 211, 155, 0.16)' : 'rgba(255, 138, 138, 0.16)'};
      color: ${success ? 'var(--ok)' : 'var(--danger)'};
      font-size: 24px;
      font-weight: 800;
    }
    h1 {
      margin: 0 0 10px;
      font-size: clamp(28px, 4vw, 40px);
      line-height: 1.05;
      letter-spacing: 0;
    }
    p {
      margin: 0;
      color: var(--muted);
      font-size: 17px;
      line-height: 1.5;
    }
  </style>
</head>
<body>
  <main>
    <div class="brand"><div class="mark">F</div><span>Forger</span></div>
    <div class="status">${success ? '✓' : '!'}</div>
    <h1>${escapedTitle}</h1>
    <p>${escapedBody}</p>
  </main>
</body>
</html>`);
};

const appendOAuthLog = (
  context: InternalToolContext,
  event: string,
  payload?: Record<string, unknown>,
): void => {
  void context.appendLog?.(`meta_oauth:${event}`, payload ?? {});
};

const bindServerOnPreferredPort = async (
  server: Server,
): Promise<number> => {
  let lastError: Error | null = null;
  for (const port of PREFERRED_REDIRECT_PORTS) {
    try {
      const bound = await new Promise<number>((resolve, reject) => {
        const onError = (err: Error) => {
          server.off('listening', onListening);
          reject(err);
        };
        const onListening = () => {
          server.off('error', onError);
          const address = server.address();
          if (!address || typeof address !== 'object') {
            reject(new Error('address_unavailable'));
            return;
          }
          resolve(address.port);
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, '127.0.0.1');
      });
      return bound;
    } catch (error) {
      lastError = error as Error;
    }
  }
  throw new MetaOAuthError(
    'No hay puertos locales libres entre los preautorizados para OAuth de Meta.',
    'meta_oauth_no_redirect_port_available',
  );
};

export const runMetaOAuthFlow = async (context: InternalToolContext): Promise<void> => {
  const clientId = await getClientId(context);
  const state = base64Url(randomBytes(32));
  const pkce = createPkcePair();

  let settled = false;
  let server: Server | null = null;
  let redirectUri = '';

  const callbackPromise = new Promise<void>((resolve, reject) => {
    server = http.createServer((request, response) => {
      void (async () => {
        const requestUrl = new URL(request.url ?? '/', redirectUri || 'http://127.0.0.1');
        if (requestUrl.pathname !== CALLBACK_PATH) {
          sendHtml(response, 404, 'Forger', 'Esta pagina no pertenece al flujo de Meta.');
          return;
        }
        appendOAuthLog(context, 'callback_received');

        if (requestUrl.searchParams.get('state') !== state) {
          appendOAuthLog(context, 'state_mismatch');
          sendHtml(
            response,
            400,
            'No pudimos conectar Meta',
            'La respuesta de Meta no coincide con la solicitud original.',
          );
          throw new MetaOAuthError(
            'La respuesta de Meta no coincide con la solicitud original.',
            'meta_oauth_state_mismatch',
          );
        }

        const oauthError = requestUrl.searchParams.get('error');
        if (oauthError) {
          appendOAuthLog(context, 'meta_error', { error: oauthError });
          sendHtml(
            response,
            400,
            'No pudimos conectar Meta',
            'Meta cancelo o rechazo la autorizacion.',
          );
          throw new MetaOAuthError(
            oauthError === 'access_denied'
              ? 'La autorizacion de Meta fue cancelada.'
              : 'Meta rechazo la autorizacion.',
            oauthError === 'access_denied' ? 'meta_oauth_access_denied' : 'meta_oauth_meta_error',
          );
        }

        const code = requestUrl.searchParams.get('code');
        if (!code) {
          appendOAuthLog(context, 'code_missing');
          sendHtml(
            response,
            400,
            'No pudimos conectar Meta',
            'Meta no devolvio un codigo de autorizacion.',
          );
          throw new MetaOAuthError(
            'Meta no devolvio un codigo de autorizacion.',
            'meta_oauth_code_missing',
          );
        }
        appendOAuthLog(context, 'code_received');

        const token = await exchangeCode({
          clientId,
          code,
          codeVerifier: pkce.verifier,
          redirectUri,
          context,
        });
        if (!token.access_token) {
          appendOAuthLog(context, 'access_token_missing');
          sendHtml(
            response,
            400,
            'No pudimos conectar Meta',
            'Meta no devolvio un access token utilizable.',
          );
          throw new MetaOAuthError(
            'Meta no devolvio un access token utilizable.',
            'meta_oauth_access_token_missing',
          );
        }

        const saved = await context.secretsStore.setToolSecret(
          META_TOOL_ID,
          META_USER_TOKEN_SECRET,
          token.access_token,
        );
        if (!saved.success) {
          appendOAuthLog(context, 'secret_save_failed', { technicalCode: saved.technicalCode });
          sendHtml(response, 500, 'No pudimos conectar Meta', saved.userMessage);
          throw new MetaOAuthError(
            saved.technicalCode ?? 'meta_oauth_secret_save_failed',
            saved.technicalCode ?? 'meta_oauth_secret_save_failed',
          );
        }

        appendOAuthLog(context, 'user_access_token_saved');
        sendHtml(response, 200, 'Meta conectado', 'Puedes volver a Forger.');
        settled = true;
        resolve();
      })().catch((error) => {
        if (!response.headersSent) {
          sendHtml(
            response,
            500,
            'No pudimos conectar Meta',
            error instanceof Error ? error.message : 'Forger no pudo completar OAuth con Meta.',
          );
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
      appendOAuthLog(context, 'server_error', { message: error.message });
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
  });

  let timeoutId: NodeJS.Timeout | null = null;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(
      () => reject(new MetaOAuthError('La conexion con Meta expiro.', 'meta_oauth_timeout')),
      OAUTH_TIMEOUT_MS,
    );
  });

  try {
    if (!server) {
      throw new MetaOAuthError(
        'No pudimos preparar el servidor local de OAuth para Meta.',
        'meta_oauth_server_unavailable',
      );
    }
    const port = await bindServerOnPreferredPort(server);
    redirectUri = `http://127.0.0.1:${port}${CALLBACK_PATH}`;
    appendOAuthLog(context, 'listening', { port });

    const authUrl = new URL(AUTH_URL);
    authUrl.searchParams.set('client_id', clientId);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', META_SCOPES.join(','));
    authUrl.searchParams.set('state', state);
    authUrl.searchParams.set('code_challenge', pkce.challenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');
    appendOAuthLog(context, 'open_browser', { port });
    await context.openExternalUrl(authUrl.toString());
    await Promise.race([callbackPromise, timeout]);
    appendOAuthLog(context, 'completed');
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    if (server) {
      await closeServer(server).catch(() => undefined);
      appendOAuthLog(context, 'closed');
    }
  }
};
