import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  OAuthConnectionError,
  runLoopbackOAuthFlow,
  runGitHubDeviceOAuthFlow,
} = require('../../dist-electron/main/tools/self-oauth.js');
const {
  SelfOAuthCallbackService,
} = require('../../dist-electron/main/oauth-callback/service.js');

const createSecretsStore = () => {
  const values = new Map();
  return {
    values,
    async setToolSecret(toolId, name, value) {
      values.set(`${toolId}:${name}`, value);
      return { success: true, userMessage: 'ok' };
    },
    async getToolSecret(toolId, name) {
      return values.get(`${toolId}:${name}`) ?? null;
    },
    async hasToolSecret(toolId, name) {
      return values.has(`${toolId}:${name}`);
    },
    async deleteToolSecrets(toolId) {
      for (const key of [...values.keys()]) {
        if (key.startsWith(`${toolId}:`)) values.delete(key);
      }
      return { success: true, userMessage: 'ok' };
    },
  };
};

const createContext = (overrides = {}) => ({
  metadataRoot: '/tmp/forger-oauth-test',
  secretsStore: overrides.secretsStore ?? createSecretsStore(),
  getFreePort: async () => 0,
  openExternalUrl: async () => undefined,
  isForgerAccountAuthenticated: () => false,
  getGmailOAuthClientId: async () => '',
  exchangeGmailOAuthCode: async () => ({}),
  refreshGmailOAuthAccessToken: async () => ({}),
  appendLog: async () => undefined,
  emitEvent: () => undefined,
  ...overrides,
});

const jsonResponse = (payload, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => payload,
  text: async () => JSON.stringify(payload),
});

const withMockedFetch = async (handler, operation) => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => handler(String(url), options);
  try {
    return await operation();
  } finally {
    globalThis.fetch = previousFetch;
  }
};

const waitForUrl = async (readUrl, timeoutMs = 5_000) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const url = readUrl();
    if (url) return url;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('url_timeout');
};

test('self OAuth callback service persists and rotates its local port', async () => {
  const metadataRoot = await mkdtemp(join(tmpdir(), 'forger-oauth-callback-'));
  const blocker = http.createServer((_request, response) => response.end('busy'));
  try {
    const first = new SelfOAuthCallbackService({ metadataRoot });
    await first.start();
    const initial = first.getState();
    assert.ok(initial.port > 0);
    await first.stop();

    const second = new SelfOAuthCallbackService({ metadataRoot });
    await second.start();
    assert.equal(second.getState().port, initial.port);
    await second.stop();

    await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    const occupied = blocker.address().port;
    await writeFile(join(metadataRoot, 'oauth-callback.json'), JSON.stringify({ port: occupied }), 'utf8');
    const rotated = new SelfOAuthCallbackService({ metadataRoot });
    await rotated.start();
    assert.notEqual(rotated.getState().port, occupied);
    assert.equal(rotated.getState().previousPort, occupied);
    assert.equal(rotated.getState().portChanged, true);
    await rotated.stop();
  } finally {
    await new Promise((resolve) => blocker.close(() => resolve())).catch(() => undefined);
    await rm(metadataRoot, { recursive: true, force: true });
  }
});

test('loopback OAuth stores refresh token, client credentials, and exchanged access metadata', async () => {
  const secretsStore = createSecretsStore();
  let openedUrl = '';
  const context = createContext({
    secretsStore,
    openExternalUrl: async (url) => {
      openedUrl = url;
    },
  });

  await withMockedFetch(
    (url, options) => {
      assert.equal(url, 'https://oauth2.example.test/token');
      const body = new URLSearchParams(String(options.body));
      assert.equal(body.get('client_id'), 'client-id');
      assert.equal(body.get('client_secret'), 'client-secret');
      assert.equal(body.get('grant_type'), 'authorization_code');
      assert.equal(body.get('code'), 'code-1');
      assert.ok(body.get('code_verifier'));
      return jsonResponse({ access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 3600 });
    },
    async () => {
      const flow = runLoopbackOAuthFlow(context, {
        toolId: 'calendar',
        clientId: 'client-id',
        clientSecret: 'client-secret',
        authUrl: 'https://accounts.example.test/oauth',
        tokenUrl: 'https://oauth2.example.test/token',
        callbackPath: '/oauth/calendar/callback',
        scopes: ['scope.one', 'scope.two'],
      });
      const authUrl = new URL(await waitForUrl(() => openedUrl));
      assert.equal(authUrl.origin + authUrl.pathname, 'https://accounts.example.test/oauth');
      assert.equal(authUrl.searchParams.get('client_id'), 'client-id');
      assert.equal(authUrl.searchParams.get('scope'), 'scope.one scope.two');
      assert.equal(authUrl.searchParams.get('code_challenge_method'), 'S256');
      const redirectUri = new URL(authUrl.searchParams.get('redirect_uri'));
      await new Promise((resolve, reject) => {
        http.get(`${redirectUri.href}?state=${authUrl.searchParams.get('state')}&code=code-1`, (response) => {
          response.resume();
          response.on('end', resolve);
        }).on('error', reject);
      });
      await flow;
      assert.equal(await secretsStore.getToolSecret('calendar', 'oauth_client_id'), 'client-id');
      assert.equal(await secretsStore.getToolSecret('calendar', 'oauth_client_secret'), 'client-secret');
      assert.equal(await secretsStore.getToolSecret('calendar', 'oauth_refresh_token'), 'refresh-1');
      assert.equal(await secretsStore.getToolSecret('calendar', 'oauth_access_token'), 'access-1');
    },
  );
});

test('loopback OAuth uses the app-wide callback service when available', async () => {
  const metadataRoot = await mkdtemp(join(tmpdir(), 'forger-oauth-shared-'));
  const callbackService = new SelfOAuthCallbackService({ metadataRoot });
  await callbackService.start();
  const secretsStore = createSecretsStore();
  let openedUrl = '';
  const context = createContext({
    metadataRoot,
    secretsStore,
    selfOAuthCallbackService: callbackService,
    openExternalUrl: async (url) => {
      openedUrl = url;
    },
  });
  try {
    await withMockedFetch(
      (url, options) => {
        assert.equal(url, 'https://oauth2.example.test/token');
        const body = new URLSearchParams(String(options.body));
        assert.equal(body.get('redirect_uri'), `${callbackService.getState().baseUrl}/oauth/calendar/callback`);
        return jsonResponse({ access_token: 'access-shared', refresh_token: 'refresh-shared' });
      },
      async () => {
        const flow = runLoopbackOAuthFlow(context, {
          toolId: 'calendar',
          clientId: 'client-id',
          clientSecret: 'client-secret',
          authUrl: 'https://accounts.example.test/oauth',
          tokenUrl: 'https://oauth2.example.test/token',
          callbackPath: '/oauth/calendar/callback',
          scopes: ['scope.one'],
        });
        const authUrl = new URL(await waitForUrl(() => openedUrl));
        assert.equal(authUrl.searchParams.get('redirect_uri'), `${callbackService.getState().baseUrl}/oauth/calendar/callback`);
        const redirectUri = new URL(authUrl.searchParams.get('redirect_uri'));
        await new Promise((resolve, reject) => {
          http.get(`${redirectUri.href}?state=${authUrl.searchParams.get('state')}&code=code-1`, (response) => {
            response.resume();
            response.on('end', resolve);
          }).on('error', reject);
        });
        await flow;
        assert.equal(await secretsStore.getToolSecret('calendar', 'oauth_refresh_token'), 'refresh-shared');
      },
    );
  } finally {
    await callbackService.stop();
    await rm(metadataRoot, { recursive: true, force: true });
  }
});

test('loopback OAuth rejects state mismatch without storing tokens', async () => {
  const secretsStore = createSecretsStore();
  let openedUrl = '';
  const context = createContext({
    secretsStore,
    openExternalUrl: async (url) => {
      openedUrl = url;
    },
  });

  const flow = runLoopbackOAuthFlow(context, {
    toolId: 'calendar',
    clientId: 'client-id',
    clientSecret: 'client-secret',
    authUrl: 'https://accounts.example.test/oauth',
    tokenUrl: 'https://oauth2.example.test/token',
    callbackPath: '/oauth/calendar/callback',
    scopes: ['scope.one'],
  });
  const authUrl = new URL(await waitForUrl(() => openedUrl));
  const redirectUri = new URL(authUrl.searchParams.get('redirect_uri'));
  const rejected = assert.rejects(flow, (error) => error instanceof OAuthConnectionError && error.technicalCode === 'calendar_oauth_state_mismatch');
  await new Promise((resolve, reject) => {
    http.get(`${redirectUri.href}?state=wrong&code=code-1`, (response) => {
      response.resume();
      response.on('end', resolve);
    }).on('error', reject);
  });
  await rejected;
  assert.equal(await secretsStore.getToolSecret('calendar', 'oauth_refresh_token'), null);
});

test('GitHub device flow opens verification URL and stores access token', async () => {
  const secretsStore = createSecretsStore();
  const opened = [];
  const context = createContext({
    secretsStore,
    openExternalUrl: async (url) => {
      opened.push(url);
    },
  });
  let pollCount = 0;

  await withMockedFetch(
    (url, options) => {
      if (url === 'https://github.com/login/device/code') {
        const body = new URLSearchParams(String(options.body));
        assert.equal(body.get('client_id'), 'github-client');
        return jsonResponse({
          device_code: 'device-code',
          user_code: 'ABCD-1234',
          verification_uri: 'https://github.com/login/device',
          verification_uri_complete: 'https://github.com/login/device?user_code=ABCD-1234',
          interval: 1,
          expires_in: 60,
        });
      }
      if (url === 'https://github.com/login/oauth/access_token') {
        pollCount += 1;
        return pollCount === 1
          ? jsonResponse({ error: 'authorization_pending' })
          : jsonResponse({ access_token: 'github-access-token', token_type: 'bearer', scope: 'repo' });
      }
      throw new Error(`unexpected_fetch:${url}`);
    },
    async () => {
      await runGitHubDeviceOAuthFlow(context, {
        toolId: 'github',
        clientId: 'github-client',
        scopes: ['repo'],
        pollIntervalMs: 1,
      });
      assert.deepEqual(opened, ['https://github.com/login/device?user_code=ABCD-1234']);
      assert.equal(await secretsStore.getToolSecret('github', 'oauth_client_id'), 'github-client');
      assert.equal(await secretsStore.getToolSecret('github', 'oauth_access_token'), 'github-access-token');
    },
  );
});
