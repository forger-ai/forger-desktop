import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ephemeralModule = require('../../dist-electron/main/tools/self-oauth/ephemeral.js');
const httpModule = require('../../dist-electron/main/tools/self-oauth/http.js');
const {
  runGitHubDeviceOAuthFlow,
} = require('../../dist-electron/main/tools/self-oauth/github-device.js');
const {
  runLoopbackOAuthFlow,
} = require('../../dist-electron/main/tools/self-oauth/loopback.js');
const {
  getStoredOAuthAccessToken,
  storeTokenResponse,
} = require('../../dist-electron/main/tools/self-oauth/token-store.js');
const {
  OAuthConnectionError,
} = require('../../dist-electron/main/tools/self-oauth/types.js');
const {
  sendOAuthCallbackPage,
} = require('../../dist-electron/main/oauth-callback/page.js');
const {
  SelfOAuthCallbackService,
} = require('../../dist-electron/main/oauth-callback/service.js');
const {
  readCallbackPort,
  writeCallbackPort,
} = require('../../dist-electron/main/oauth-callback/store.js');

const responseCapture = (headersSent = false) => ({
  headersSent,
  statusCode: null,
  headers: null,
  body: '',
  writeHead(statusCode, headers) {
    this.statusCode = statusCode;
    this.headers = headers;
    this.headersSent = true;
  },
  end(body = '') {
    this.body += body;
  },
});

const createSecretsContext = (initial = {}) => {
  const values = new Map(Object.entries(initial));
  const writes = [];
  return {
    values,
    writes,
    context: {
      locale: 'en',
      secretsStore: {
        getToolSecret: async (toolId, key) => values.get(`${toolId}:${key}`) ?? null,
        setToolSecret: async (toolId, key, value) => {
          writes.push([toolId, key, value]);
          values.set(`${toolId}:${key}`, value);
          return { success: true };
        },
      },
      openExternalUrl: async () => undefined,
    },
  };
};

const jsonResponse = (payload, status = 200, rejectJson = false) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => rejectJson ? Promise.reject(new Error('invalid json')) : payload,
});

const withFetch = async (handler, action) => {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  try {
    return await action();
  } finally {
    globalThis.fetch = original;
  }
};

test('OAuth callback pages escape all visible content and render idle semantics', () => {
  const response = responseCapture();
  sendOAuthCallbackPage(response, 202, 'idle', '<Forger & "OAuth">', "Wait 'here'");
  assert.equal(response.statusCode, 202);
  assert.equal(response.headers['Content-Type'], 'text/html; charset=utf-8');
  assert.match(response.body, />\.\.\.<\/div>/);
  assert.match(response.body, /&lt;Forger &amp; &quot;OAuth&quot;&gt;/);
  assert.match(response.body, /Wait &#39;here&#39;/);
});

test('callback port storage validates fields, preserves permissions, and tolerates chmod races', async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'forger-b25-callback-store-'));
  const originalChmod = fs.chmod;
  try {
    await fs.writeFile(path.join(root, 'oauth-callback.json'), JSON.stringify({
      port: 0,
      previousPort: 65536,
      rotatedAt: 42,
    }), 'utf8');
    assert.deepEqual(await readCallbackPort(root), {});
    await fs.writeFile(path.join(root, 'oauth-callback.json'), JSON.stringify({
      port: 1234,
      previousPort: 1233,
      rotatedAt: '2026-08-10T00:00:00.000Z',
    }), 'utf8');
    assert.deepEqual(await readCallbackPort(root), {
      port: 1234,
      previousPort: 1233,
      rotatedAt: '2026-08-10T00:00:00.000Z',
    });
    fs.chmod = async () => { throw new Error('metadata removed'); };
    await assert.doesNotReject(() => writeCallbackPort(root, { port: 4321 }));
    assert.deepEqual(await readCallbackPort(root), { port: 4321 });
  } finally {
    fs.chmod = originalChmod;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('ephemeral callback server reports listen failures, uses fallback hosts, and closes defensively', async () => {
  const originalCreateServer = http.createServer;
  try {
    http.createServer = () => {
      const server = new EventEmitter();
      server.address = () => null;
      server.listen = (_port, _host, callback) => callback();
      server.close = (callback) => callback();
      return server;
    };
    await assert.rejects(() => ephemeralModule.runEphemeralCallbackServer({ callbackPath: '/oauth/test', handle: async () => undefined }), /oauth_callback_port_unavailable/);

    let requestHandler;
    let addressCalls = 0;
    let handledUrl;
    http.createServer = (handler) => {
      requestHandler = handler;
      const server = new EventEmitter();
      server.address = () => (++addressCalls === 1 ? { port: 4545 } : null);
      server.listen = (_port, _host, callback) => callback();
      server.close = () => { throw new Error('already closed'); };
      return server;
    };
    const running = await ephemeralModule.runEphemeralCallbackServer({
      callbackPath: '/oauth/test',
      handle: async (url) => { handledUrl = url.toString(); },
    });
    requestHandler({ url: undefined }, responseCapture());
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(handledUrl, 'http://127.0.0.1/');
    await assert.doesNotReject(() => running.close());

    http.createServer = () => {
      const server = new EventEmitter();
      server.address = () => ({ port: 4545 });
      server.listen = () => server.emit('error', new Error('listen failed'));
      server.close = (callback) => callback();
      return server;
    };
    await assert.rejects(() => ephemeralModule.runEphemeralCallbackServer({ callbackPath: '/oauth/test', handle: async () => undefined }), /listen failed/);
  } finally {
    http.createServer = originalCreateServer;
  }
});

test('OAuth HTTP helper maps network, invalid JSON, provider, and fallback failures', async () => {
  await withFetch(async () => { throw new Error('offline'); }, async () => {
    await assert.rejects(() => httpModule.postForm('https://oauth.test/token', new URLSearchParams(), 'demo', 'exchange'), (error) =>
      error instanceof OAuthConnectionError && error.message === 'offline' && error.technicalCode === 'demo_oauth_exchange_failed');
  });
  await withFetch(async () => { throw 'offline'; }, async () => {
    await assert.rejects(() => httpModule.postForm('https://oauth.test/token', new URLSearchParams(), 'demo', 'refresh'), /OAuth request failed/);
  });
  await withFetch(async () => jsonResponse({}, 500, true), async () => {
    await assert.rejects(() => httpModule.postForm('https://oauth.test/token', new URLSearchParams(), 'demo', 'refresh'), /OAuth refresh failed/);
  });
  await withFetch(async () => jsonResponse({ error: 'invalid_grant', error_description: 'Grant expired' }), async () => {
    await assert.rejects(() => httpModule.postForm('https://oauth.test/token', new URLSearchParams(), 'demo', 'refresh'), /Grant expired/);
  });
});

test('token storage validates required tokens, optional metadata, expiry, cached access, and refresh', async () => {
  const { context, values, writes } = createSecretsContext();
  await assert.rejects(() => storeTokenResponse(context, 'demo', {}, {}), /access token/);
  await assert.rejects(() => storeTokenResponse(context, 'demo', { access_token: 'access' }, { requireRefreshToken: true }), /refresh token/);
  await storeTokenResponse(context, 'demo', {
    access_token: 'access',
    refresh_token: 'refresh',
    scope: 'read write',
    expires_in: -10,
  }, { clientId: 'client', clientSecret: 'secret', requireRefreshToken: true });
  assert.equal(writes.length, 6);
  assert.equal(Number(values.get('demo:oauth_access_token_expires_at')) <= Date.now(), true);

  values.set('demo:oauth_access_token', 'cached');
  values.set('demo:oauth_access_token_expires_at', 'not-a-number');
  assert.equal(await getStoredOAuthAccessToken(context, { toolId: 'demo', tokenUrl: 'https://oauth.test/token' }), 'cached');

  values.set('demo:oauth_access_token_expires_at', String(Date.now()));
  values.delete('demo:oauth_refresh_token');
  await assert.rejects(() => getStoredOAuthAccessToken(context, { toolId: 'demo', tokenUrl: 'https://oauth.test/token' }), /not configured/);

  values.set('demo:custom-client', 'custom-id');
  values.set('demo:custom-secret', 'custom-secret');
  values.set('demo:custom-refresh', 'custom-refresh');
  await withFetch(async (_url, options) => {
    const body = new URLSearchParams(String(options.body));
    assert.equal(body.get('client_id'), 'custom-id');
    assert.equal(body.get('refresh_token'), 'custom-refresh');
    return jsonResponse({ access_token: 'refreshed', expires_in: Number.NaN });
  }, async () => {
    assert.equal(await getStoredOAuthAccessToken(context, {
      toolId: 'demo',
      tokenUrl: 'https://oauth.test/token',
      clientIdSecret: 'custom-client',
      clientSecretSecret: 'custom-secret',
      refreshTokenSecret: 'custom-refresh',
    }), 'refreshed');
  });
});

test('GitHub device flow validates device responses, handles slow polling, fallback URL, and timeout', async () => {
  const { context } = createSecretsContext();
  await withFetch(async () => jsonResponse({ error: 'bad_client' }, 400), async () => {
    await assert.rejects(() => runGitHubDeviceOAuthFlow(context, { toolId: 'github', clientId: 'bad', scopes: [] }), /bad_client/);
  });
  await withFetch(async () => jsonResponse({ error_description: 'described failure' }, 400), async () => {
    await assert.rejects(() => runGitHubDeviceOAuthFlow(context, { toolId: 'github', clientId: 'bad', scopes: [] }), /described failure/);
  });
  await withFetch(async () => jsonResponse({}, 500, true), async () => {
    await assert.rejects(() => runGitHubDeviceOAuthFlow(context, { toolId: 'github', clientId: 'bad', scopes: [] }), /GitHub device authorization failed/);
  });

  const originalSetTimeout = globalThis.setTimeout;
  let openedUrl = '';
  context.openExternalUrl = async (url) => { openedUrl = url; };
  try {
    globalThis.setTimeout = (callback) => {
      queueMicrotask(callback);
      return 1;
    };
    let poll = 0;
    await withFetch(async (url) => {
      if (String(url).endsWith('/device/code')) {
        return jsonResponse({ device_code: 'device', verification_uri: 'https://github.test/device', expires_in: 30, interval: 0 });
      }
      poll += 1;
      if (poll === 1) return jsonResponse({ error: 'slow_down' });
      return jsonResponse({ access_token: 'github-token' });
    }, async () => {
      await runGitHubDeviceOAuthFlow(context, { toolId: 'github', clientId: 'client', scopes: ['repo'], timeoutMs: 1_000 });
    });
    assert.equal(openedUrl, 'https://github.test/device');

    const originalPostForm = httpModule.postForm;
    httpModule.postForm = async () => { throw new Error('poll transport failed'); };
    try {
      await withFetch(async () => jsonResponse({
        device_code: 'device', verification_uri: 'https://github.test/device',
      }), async () => {
        await assert.rejects(() => runGitHubDeviceOAuthFlow(context, {
          toolId: 'github', clientId: 'client', scopes: [],
        }), /poll transport failed/);
      });
    } finally {
      httpModule.postForm = originalPostForm;
    }
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }

  await withFetch(async (url) => String(url).endsWith('/device/code')
    ? jsonResponse({ device_code: 'device', verification_uri: 'https://github.test/device', expires_in: 0 })
    : jsonResponse({ error: 'authorization_pending' }), async () => {
    await assert.rejects(() => runGitHubDeviceOAuthFlow(context, {
      toolId: 'github', clientId: 'client', scopes: [], pollIntervalMs: 0, timeoutMs: 0,
    }), /timed out/);
  });
});

test('shared loopback OAuth handles callback paths, provider errors, missing codes, custom params, and timeout cleanup', async () => {
  const runCase = async (query, expectedCode, errorValue = undefined) => {
    let flow;
    let openedUrl;
    const { context } = createSecretsContext();
    context.selfOAuthCallbackService = {
      callbackUrl: () => 'http://127.0.0.1:4444/oauth/demo/callback',
      registerFlow: (registered) => { flow = registered; return () => undefined; },
    };
    context.openExternalUrl = async (url) => { openedUrl = url; };
    const promise = runLoopbackOAuthFlow(context, {
      toolId: 'demo', clientId: 'client', clientSecret: 'secret',
      authUrl: 'https://oauth.test/auth', tokenUrl: 'https://oauth.test/token',
      callbackPath: '/oauth/demo/callback', scopes: ['read'], timeoutMs: 1_000,
      authParams: { audience: 'forger' }, requireRefreshToken: false,
    });
    await new Promise((resolve) => setImmediate(resolve));
    const auth = new URL(openedUrl);
    assert.equal(auth.searchParams.get('audience'), 'forger');
    const urls = [query(auth.searchParams.get('state'))].flat().map((value) => new URL(value));
    const responses = urls.map(() => responseCapture());
    if (errorValue !== undefined) {
      const originalPostForm = httpModule.postForm;
      httpModule.postForm = async () => { throw errorValue; };
      try {
        for (let index = 0; index < urls.length; index += 1) await flow.handle(urls[index], responses[index]);
      } finally {
        httpModule.postForm = originalPostForm;
      }
    } else {
      for (let index = 0; index < urls.length; index += 1) await flow.handle(urls[index], responses[index]);
    }
    await assert.rejects(promise, (error) => expectedCode ? error?.technicalCode === expectedCode : error === errorValue);
    return responses;
  };

  const wrongPath = await runCase((state) => [
    'http://127.0.0.1:4444/wrong',
    `http://127.0.0.1:4444/oauth/demo/callback?state=${state}`,
  ], 'demo_oauth_code_missing');
  assert.equal(wrongPath[0].statusCode, 404);
  assert.equal((await runCase((state) => `http://127.0.0.1:4444/oauth/demo/callback?state=${state}&error=denied`, 'demo_oauth_provider_error'))[0].statusCode, 400);
  assert.equal((await runCase((state) => `http://127.0.0.1:4444/oauth/demo/callback?state=${state}`, 'demo_oauth_code_missing'))[0].statusCode, 400);
  assert.equal((await runCase((state) => `http://127.0.0.1:4444/oauth/demo/callback?state=${state}&code=ok`, undefined, 'boom'))[0].statusCode, 400);
  const hiddenResponse = responseCapture(true);
  let hiddenFlow;
  const { context } = createSecretsContext();
  context.selfOAuthCallbackService = {
    callbackUrl: () => 'http://127.0.0.1:4444/oauth/demo/callback',
    registerFlow: (flow) => { hiddenFlow = flow; return () => undefined; },
  };
  const timed = runLoopbackOAuthFlow(context, {
    toolId: 'demo', clientId: 'client', clientSecret: 'secret', authUrl: 'https://oauth.test/auth',
    tokenUrl: 'https://oauth.test/token', callbackPath: '/oauth/demo/callback', scopes: [], timeoutMs: 5,
  });
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(timed, /timed out/);
  assert.equal(typeof hiddenFlow.handle, 'function');
  assert.equal(hiddenResponse.headersSent, true);

  const originalEphemeral = ephemeralModule.runEphemeralCallbackServer;
  ephemeralModule.runEphemeralCallbackServer = async () => { throw new Error('callback setup failed'); };
  try {
    await assert.rejects(() => runLoopbackOAuthFlow(createSecretsContext().context, {
      toolId: 'demo', clientId: 'client', clientSecret: 'secret', authUrl: 'https://oauth.test/auth',
      tokenUrl: 'https://oauth.test/token', callbackPath: '/oauth/demo/callback', scopes: [], timeoutMs: 100,
    }), /callback setup failed/);
  } finally {
    ephemeralModule.runEphemeralCallbackServer = originalEphemeral;
  }
});

test('callback service exposes idle, expiry, thrown-flow, registration cleanup, and stopped states', async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'forger-b25-callback-service-'));
  const service = new SelfOAuthCallbackService({ metadataRoot: root });
  try {
    assert.equal(service.getState(), null);
    assert.equal(service.callbackUrl('/oauth/demo'), '');
    await service.stop();
    await service.start();
    await service.start();
    const baseUrl = service.getState().baseUrl;
    const idle = await fetch(`${baseUrl}/unknown`);
    assert.equal(idle.status, 404);

    const expiredFlow = { callbackPath: '/expired', expiresAt: Date.now() - 1, handle: async () => assert.fail('expired flow ran') };
    const cleanupExpired = service.registerFlow(expiredFlow);
    assert.equal((await fetch(`${baseUrl}/expired`)).status, 408);
    cleanupExpired();

    const throwingFlow = { callbackPath: '/throws', expiresAt: Date.now() + 1_000, handle: async () => { throw 'boom'; } };
    const cleanupThrowing = service.registerFlow(throwingFlow);
    assert.equal((await fetch(`${baseUrl}/throws`)).status, 500);
    cleanupThrowing();

    const errorFlow = { callbackPath: '/error', expiresAt: Date.now() + 1_000, handle: async () => { throw new Error('visible failure'); } };
    service.registerFlow(errorFlow);
    assert.match(await (await fetch(`${baseUrl}/error`)).text(), /visible failure/);

    const alreadySent = responseCapture(true);
    service.registerFlow({ callbackPath: '/', expiresAt: Date.now() + 1_000, handle: async () => { throw new Error('hidden failure'); } });
    await service.handle({ url: undefined }, alreadySent);
    assert.equal(alreadySent.body, '');

    let firstRan = false;
    const first = { callbackPath: '/replace', expiresAt: Date.now() + 1_000, handle: async (_url, response) => { firstRan = true; response.end('first'); } };
    const second = { callbackPath: '/replace', expiresAt: Date.now() + 1_000, handle: async (_url, response) => response.end('second') };
    const cleanupFirst = service.registerFlow(first);
    service.registerFlow(second);
    cleanupFirst();
    assert.equal(await (await fetch(`${baseUrl}/replace`)).text(), 'second');
    assert.equal(firstRan, false);
  } finally {
    await service.stop();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('callback service surfaces unavailable first ports and invalid bound addresses while logging starts', async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'forger-b25-callback-listen-'));
  const service = new SelfOAuthCallbackService({ metadataRoot: root });
  const failingListen = service.listen;
  try {
    service.listen = async () => { throw new Error('listen failed'); };
    await assert.rejects(() => service.start(), /oauth_callback_port_unavailable/);

    const originalCreateServer = http.createServer;
    http.createServer = () => {
      const server = new EventEmitter();
      server.listen = (_port, _host, callback) => callback();
      server.address = () => null;
      server.close = (callback) => callback();
      return server;
    };
    service.listen = failingListen;
    try {
      await assert.rejects(() => service.listen(0), /oauth_callback_address_unavailable/);
    } finally {
      http.createServer = originalCreateServer;
    }

    const logs = [];
    const logged = new SelfOAuthCallbackService({
      metadataRoot: root,
      appendLog: async (...args) => { logs.push(args); },
    });
    await logged.start();
    await logged.stop();
    assert.equal(logs[0][0], 'self_oauth_callback:started');

    const persistedPort = JSON.parse(await fs.readFile(path.join(root, 'oauth-callback.json'), 'utf8')).port;
    await fs.writeFile(path.join(root, 'oauth-callback.json'), JSON.stringify({
      port: persistedPort,
      previousPort: persistedPort === 1 ? 2 : persistedPort - 1,
    }), 'utf8');
    const retainedPrevious = new SelfOAuthCallbackService({ metadataRoot: root });
    await retainedPrevious.start();
    assert.equal(retainedPrevious.getState().portChanged, true);
    await retainedPrevious.stop();

    const unstarted = new SelfOAuthCallbackService({ metadataRoot: root });
    const idle = responseCapture();
    await unstarted.handle({ url: undefined }, idle);
    assert.equal(idle.statusCode, 404);
  } finally {
    await service.stop();
    await fs.rm(root, { recursive: true, force: true });
  }
});
