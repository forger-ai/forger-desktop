import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import type { Server } from 'node:http';
import type { InternalToolContext } from '../types';
import { getSharedCopy } from '../../../shared/i18n';
import {
  GMAIL_REFRESH_TOKEN_SECRET,
  GMAIL_SCOPES,
  GMAIL_SELF_OAUTH_CLIENT_ID_SECRET,
  GMAIL_SELF_OAUTH_CLIENT_SECRET_SECRET,
  GMAIL_TOOL_ID,
  type GoogleTokenResponse,
} from './types';
import { runLoopbackOAuthFlow } from '../self-oauth';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const CALLBACK_PATH = '/oauth/gmail/callback';
const OAUTH_TIMEOUT_MS = 30 * 60 * 1000;

export class GmailOAuthError extends Error {
  constructor(
    message: string,
    public readonly technicalCode: string,
  ) {
    super(message);
    this.name = 'GmailOAuthError';
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
    throw new GmailOAuthError(
      getSharedCopy(context.locale).tools.gmailForgerAccountRequired,
      'forger_account_required',
    );
  }
  const clientId = (await context.getGmailOAuthClientId()).trim();
  if (!clientId) {
    throw new GmailOAuthError(
      'Gmail necesita una app OAuth configurada para conectar la cuenta.',
      'gmail_oauth_client_missing',
    );
  }
  return clientId;
};

const toGmailOAuthError = (error: unknown, fallbackMessage: string, fallbackCode: string): GmailOAuthError => {
  if (error instanceof GmailOAuthError) {
    return error;
  }
  if (error instanceof Error) {
    const technicalCode = typeof (error as Error & { technicalCode?: unknown }).technicalCode === 'string'
      ? (error as Error & { technicalCode: string }).technicalCode
      : fallbackCode;
    return new GmailOAuthError(error.message || fallbackMessage, technicalCode);
  }
  return new GmailOAuthError(fallbackMessage, fallbackCode);
};

const exchangeCode = async (input: {
  clientId: string;
  clientSecret?: string;
  code: string;
  codeVerifier: string;
  redirectUri: string;
  context: InternalToolContext;
}): Promise<GoogleTokenResponse> => {
  if (input.clientSecret) {
    const body = new URLSearchParams({
      client_id: input.clientId,
      client_secret: input.clientSecret,
      code: input.code,
      code_verifier: input.codeVerifier,
      redirect_uri: input.redirectUri,
      grant_type: 'authorization_code',
    });
    const response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    }).catch((error) => {
      throw toGmailOAuthError(error, 'Google no respondio durante OAuth.', 'gmail_oauth_google_exchange_failed');
    });
    const token = await response.json().catch(() => ({})) as GoogleTokenResponse;
    if (!response.ok || token.error) {
      throw new GmailOAuthError(
        token.error_description || token.error || 'Google no pudo completar OAuth.',
        'gmail_oauth_google_exchange_failed',
      );
    }
    return token;
  }

  if (!input.context.isForgerAccountAuthenticated()) {
    throw new GmailOAuthError(
      getSharedCopy(input.context.locale).tools.gmailForgerAccountRequired,
      'forger_account_required',
    );
  }

  try {
    return await input.context.exchangeGmailOAuthCode({
      clientId: input.clientId,
      code: input.code,
      codeVerifier: input.codeVerifier,
      redirectUri: input.redirectUri,
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new GmailOAuthError('Google no respondio a tiempo durante OAuth.', 'gmail_oauth_token_timeout');
    }
    throw toGmailOAuthError(error, 'Forger Cloud no pudo completar OAuth con Gmail.', 'gmail_oauth_backend_exchange_failed');
  }
};

export const refreshGmailAccessToken = async (context: InternalToolContext): Promise<string> => {
  const refreshToken = await context.secretsStore.getToolSecret(GMAIL_TOOL_ID, GMAIL_REFRESH_TOKEN_SECRET);
  if (!refreshToken) {
    throw new GmailOAuthError('Gmail no esta conectado.', 'gmail_oauth_not_connected');
  }
  const selfClientId = await context.secretsStore.getToolSecret(GMAIL_TOOL_ID, GMAIL_SELF_OAUTH_CLIENT_ID_SECRET);
  const selfClientSecret = await context.secretsStore.getToolSecret(GMAIL_TOOL_ID, GMAIL_SELF_OAUTH_CLIENT_SECRET_SECRET);

  if (selfClientId && selfClientSecret) {
    const response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: selfClientId,
        client_secret: selfClientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }),
    }).catch((error) => {
      throw toGmailOAuthError(error, 'Google no pudo renovar Gmail.', 'gmail_oauth_google_refresh_failed');
    });
    const token = await response.json().catch(() => ({})) as GoogleTokenResponse;
    if (!response.ok || token.error || !token.access_token) {
      throw new GmailOAuthError(
        token.error_description || token.error || 'Google no devolvio access token.',
        'gmail_oauth_google_refresh_failed',
      );
    }
    return token.access_token;
  }

  if (!context.isForgerAccountAuthenticated()) {
    throw new GmailOAuthError(
      getSharedCopy(context.locale).tools.gmailForgerAccountRequired,
      'forger_account_required',
    );
  }
  const clientId = await getClientId(context);

  const token = await context.refreshGmailOAuthAccessToken({
    clientId,
    refreshToken,
  }).catch((error) => {
    throw toGmailOAuthError(error, 'Forger Cloud no pudo renovar Gmail.', 'gmail_oauth_backend_refresh_failed');
  });
  if (!token.access_token) {
    throw new GmailOAuthError('Google no devolvio access token.', 'gmail_oauth_access_token_missing');
  }
  return token.access_token;
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

const appendOAuthLog = (context: InternalToolContext, event: string, payload?: Record<string, unknown>): void => {
  void context.appendLog?.(`gmail_oauth:${event}`, payload ?? {});
};

export const runGmailOAuthFlow = async (
  context: InternalToolContext,
  options: { clientId?: string; clientSecret?: string } = {},
): Promise<void> => {
  const copy = getSharedCopy(context.locale).gmailOAuth;
  const clientId = options.clientId?.trim() || await getClientId(context);
  const clientSecret = options.clientSecret?.trim();
  if (clientSecret) {
    await runLoopbackOAuthFlow(context, {
      toolId: GMAIL_TOOL_ID,
      clientId,
      clientSecret,
      authUrl: AUTH_URL,
      tokenUrl: TOKEN_URL,
      callbackPath: CALLBACK_PATH,
      scopes: GMAIL_SCOPES,
      authParams: { access_type: 'offline', prompt: 'consent' },
    });
    await context.secretsStore.setToolSecret(GMAIL_TOOL_ID, GMAIL_SELF_OAUTH_CLIENT_ID_SECRET, clientId);
    await context.secretsStore.setToolSecret(GMAIL_TOOL_ID, GMAIL_SELF_OAUTH_CLIENT_SECRET_SECRET, clientSecret);
    return;
  }
  const state = base64Url(randomBytes(32));
  const pkce = createPkcePair();

  let settled = false;
  let server: Server | null = null;
  let listeningResolve: ((port: number) => void) | null = null;
  let listeningReject: ((error: Error) => void) | null = null;
  let redirectUri = '';

  const callbackPromise = new Promise<void>((resolve, reject) => {
    server = http.createServer((request, response) => {
      void (async () => {
        const requestUrl = new URL(request.url ?? '/', redirectUri || 'http://127.0.0.1');
        if (requestUrl.pathname !== CALLBACK_PATH) {
          sendHtml(response, 404, 'Forger', copy.notFoundBody);
          return;
        }
        appendOAuthLog(context, 'callback_received');

        if (requestUrl.searchParams.get('state') !== state) {
          appendOAuthLog(context, 'state_mismatch');
          sendHtml(response, 400, copy.errorTitle, copy.stateMismatch);
          throw new GmailOAuthError(copy.stateMismatch, 'gmail_oauth_state_mismatch');
        }

        const oauthError = requestUrl.searchParams.get('error');
        if (oauthError) {
          appendOAuthLog(context, 'google_error', { error: oauthError });
          sendHtml(response, 400, copy.errorTitle, copy.googleRejected);
          throw new GmailOAuthError(
            oauthError === 'access_denied' ? copy.accessDenied : copy.googleError,
            oauthError === 'access_denied' ? 'gmail_oauth_access_denied' : 'gmail_oauth_google_error',
          );
        }

        const code = requestUrl.searchParams.get('code');
        if (!code) {
          appendOAuthLog(context, 'code_missing');
          sendHtml(response, 400, copy.errorTitle, copy.codeMissing);
          throw new GmailOAuthError(copy.codeMissing, 'gmail_oauth_code_missing');
        }
        appendOAuthLog(context, 'code_received');

        const token = await exchangeCode({
          clientId,
          ...(clientSecret ? { clientSecret } : {}),
          code,
          codeVerifier: pkce.verifier,
          redirectUri,
          context,
        });
        if (!token.refresh_token) {
          appendOAuthLog(context, 'refresh_token_missing');
          sendHtml(response, 400, copy.errorTitle, copy.refreshTokenMissing);
          throw new GmailOAuthError(copy.refreshTokenMissing, 'gmail_oauth_refresh_token_missing');
        }

        const saved = await context.secretsStore.setToolSecret(GMAIL_TOOL_ID, GMAIL_REFRESH_TOKEN_SECRET, token.refresh_token);
        if (!saved.success) {
          appendOAuthLog(context, 'secret_save_failed', { technicalCode: saved.technicalCode });
          const message = saved.userMessage ?? copy.fallbackError;
          const technicalCode = saved.technicalCode ?? 'gmail_oauth_secret_save_failed';
          sendHtml(response, 500, copy.errorTitle, message);
          throw new GmailOAuthError(message, technicalCode);
        }

        if (clientSecret) {
          await context.secretsStore.setToolSecret(GMAIL_TOOL_ID, GMAIL_SELF_OAUTH_CLIENT_ID_SECRET, clientId);
          await context.secretsStore.setToolSecret(GMAIL_TOOL_ID, GMAIL_SELF_OAUTH_CLIENT_SECRET_SECRET, clientSecret);
        }

        appendOAuthLog(context, 'refresh_token_saved');
        sendHtml(response, 200, copy.successTitle, copy.successBody);
        settled = true;
        resolve();
      })().catch((error) => {
	        if (!response.headersSent) {
	          sendHtml(
	            response,
	            500,
	            copy.errorTitle,
	            error instanceof Error ? error.message : copy.fallbackError,
	          );
	        }
        if (!settled) {
          settled = true;
          reject(error);
        }
      });
    });

    server.on('error', (error) => {
      appendOAuthLog(context, 'server_error', { message: error.message });
      listeningReject?.(error);
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server?.address();
      if (!address || typeof address !== 'object') {
        const error = new GmailOAuthError(copy.portUnavailable, 'gmail_oauth_port_unavailable');
        appendOAuthLog(context, 'port_unavailable');
        listeningReject?.(error);
        if (!settled) {
          settled = true;
          reject(error);
        }
        return;
      }
      appendOAuthLog(context, 'listening', { port: address.port });
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
    timeoutId = setTimeout(() => reject(new GmailOAuthError(copy.timeout, 'gmail_oauth_timeout')), OAUTH_TIMEOUT_MS);
  });

  try {
    const port = await listeningPromise;
    redirectUri = `http://127.0.0.1:${port}${CALLBACK_PATH}`;
    const authUrl = new URL(AUTH_URL);
    authUrl.searchParams.set('client_id', clientId);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', GMAIL_SCOPES.join(' '));
    authUrl.searchParams.set('access_type', 'offline');
    authUrl.searchParams.set('prompt', 'consent');
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
