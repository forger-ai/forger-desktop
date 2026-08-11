import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { registerForgerCloudOAuth } = require('../../dist-electron/main/forger-cloud-oauth.js');

const register = (overrides = {}) => {
  const handlers = new Map();
  const saved = [];
  registerForgerCloudOAuth({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    channel: 'cloud:apple-login',
    provider: 'apple',
    backendClient: () => ({
      getAppleLoginOAuthConfig: async () => ({
        clientId: 'com.forger.desktop',
        redirectUri: 'https://api.forger.example/oauth/apple/callback',
      }),
      createAppleLoginSession: async () => { throw new Error('Unexpected Apple exchange'); },
    }),
    saveAccount: async (account, details) => {
      saved.push({ account, details });
      return { ...account, ...details };
    },
    openExternalUrl: async () => { throw new Error('Unexpected browser open'); },
    ...overrides,
  });
  return { handler: handlers.get('cloud:apple-login'), saved };
};

const localCallbackFromAppleState = (authorization) => {
  const state = authorization.searchParams.get('state');
  const encodedCallback = state.split('.', 2)[1];
  return { state, callback: Buffer.from(encodedCallback, 'base64url').toString('utf8') };
};

test('Apple login uses its hosted redirect, nonce, and local state callback before saving the account', async () => {
  let exchange;
  const refreshed = [];
  const { handler, saved } = register({
    backendClient: () => ({
      getAppleLoginOAuthConfig: async () => ({
        clientId: 'com.forger.desktop',
        redirectUri: 'https://api.forger.example/oauth/apple/callback',
      }),
      createAppleLoginSession: async (input) => {
        exchange = input;
        return {
          success: true,
          authenticated: true,
          token: 'apple-session',
          user: { id: 7, email: 'apple@example.com', username: 'apple-user', confirmed: true },
          userMessage: 'Apple conectado',
          technicalCode: 'apple_login_ok',
        };
      },
    }),
    openExternalUrl: async (url) => {
      const authorization = new URL(url);
      assert.equal(authorization.origin + authorization.pathname, 'https://appleid.apple.com/auth/authorize');
      assert.equal(authorization.searchParams.get('client_id'), 'com.forger.desktop');
      assert.equal(authorization.searchParams.get('redirect_uri'), 'https://api.forger.example/oauth/apple/callback');
      assert.equal(authorization.searchParams.get('scope'), 'email name');
      assert.ok(authorization.searchParams.get('nonce'));
      assert.equal(authorization.searchParams.has('code_challenge'), false);
      const { state, callback } = localCallbackFromAppleState(authorization);
      const response = await fetch(`${callback}?state=${encodeURIComponent(state)}&code=apple-code`);
      assert.equal(response.status, 200);
      assert.match(await response.text(), /Sesion iniciada/);
    },
    refreshCatalog: async () => refreshed.push(true),
  });

  const result = await handler();
  assert.equal(result.success, true);
  assert.equal(result.token, 'apple-session');
  assert.deepEqual(exchange, {
    clientId: 'com.forger.desktop',
    code: 'apple-code',
    nonce: exchange.nonce,
    redirectUri: 'https://api.forger.example/oauth/apple/callback',
  });
  assert.ok(exchange.nonce.length > 20);
  assert.equal(saved.length, 1);
  assert.deepEqual(saved[0].details, { userMessage: 'Apple conectado', technicalCode: 'apple_login_ok' });
  assert.equal(refreshed.length, 1);
});

test('Apple login rejects absent hosted callback configuration before opening the browser', async () => {
  for (const [name, appleConfig] of [
    ['empty redirect', { clientId: 'com.forger.desktop', redirectUri: '' }],
    ['missing config', null],
  ]) {
    const { handler } = register({
      channel: `cloud:apple-login-${name}`,
      ipcMain: {
        handle: (_channel, callback) => {
          register.lastHandler = callback;
        },
      },
      backendClient: () => ({
        getAppleLoginOAuthConfig: async () => appleConfig,
      }),
      openExternalUrl: async () => { throw new Error('Browser must not open'); },
    });
    const result = await (handler ?? register.lastHandler)();
    assert.equal(result.success, false, name);
    assert.equal(result.technicalCode, 'apple_login_redirect_missing', name);
  }
});

test('Apple callback maps opaque exchange failures to a safe provider message', async () => {
  const { handler } = register({
    backendClient: () => ({
      getAppleLoginOAuthConfig: async () => ({
        clientId: 'com.forger.desktop',
        redirectUri: 'https://api.forger.example/oauth/apple/callback',
      }),
      createAppleLoginSession: async () => { throw 'opaque apple failure'; },
    }),
    openExternalUrl: async (url) => {
      const authorization = new URL(url);
      const { state, callback } = localCallbackFromAppleState(authorization);
      const response = await fetch(`${callback}?state=${encodeURIComponent(state)}&code=apple-code`);
      assert.equal(response.status, 500);
      assert.match(await response.text(), /No pudimos iniciar sesion con Apple/);
    },
  });

  const result = await handler();
  assert.deepEqual(result, {
    authenticated: false,
    success: false,
    userMessage: 'No pudimos iniciar sesion con Apple.',
    technicalCode: 'apple_login_unhandled_error',
  });
});
