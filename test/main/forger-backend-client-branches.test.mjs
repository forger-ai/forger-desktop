import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ForgerBackendClient } = require('../../dist-electron/main/forger-backend-client.js');

const createClient = (root, fetchImpl, token = undefined) => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  const client = new ForgerBackendClient({
    backendBaseUrl: 'https://platform.test',
    localCatalogJsonUrl: () => undefined,
    token: () => token,
    mapBackendCategory: () => 'productividad',
    toCatalogStatus: () => 'not_installed',
    getUserMessage: () => undefined,
    platform: () => 'darwin_arm64',
    desktopVersion: () => '0.1.test',
    reportingLogPath: () => join(root, 'reporting.log'),
  });
  return {
    client,
    restore: () => {
      globalThis.fetch = previousFetch;
    },
  };
};

const jsonResponse = (status, body, headers = {}) => new Response(JSON.stringify(body), {
  status,
  headers: {
    'content-type': 'application/json',
    ...headers,
  },
});

const readLogEntries = async (root) => {
  const raw = await readFile(join(root, 'reporting.log'), 'utf8');
  return raw.trim().split('\n').map((line) => JSON.parse(line));
};

test('backend client maps profile cooldowns, OAuth token posts, device failures, and reporting network failures safely', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forger-backend-branches-'));
  const requests = [];
  const harness = createClient(root, async (url, init = {}) => {
    requests.push({ url, init });
    const parsed = new URL(url);
    if (parsed.pathname === '/api/v1/me/profile') {
      return jsonResponse(429, {
        error: 'username_change_cooldown',
        username_change_available_at: '2026-06-21T00:00:00Z',
      });
    }
    if (parsed.pathname === '/api/v1/oauth/gmail/token') {
      const body = JSON.parse(init.body);
      assert.equal(body.code, 'oauth-code');
      return jsonResponse(502, { error: 'upstream' });
    }
    if (parsed.pathname === '/api/v1/oauth/gmail/refresh') {
      const body = JSON.parse(init.body);
      assert.equal(body.refresh_token, 'refresh-token');
      return jsonResponse(200, { access_token: 'access-token' });
    }
    if (parsed.pathname === '/api/v1/me/devices/register') {
      return jsonResponse(401, { error: 'expired' });
    }
    if (parsed.pathname === '/api/v1/me/devices') {
      return jsonResponse(200, { devices: 'not-array' });
    }
    if (parsed.pathname === '/api/v1/me/devices/7/pairing_codes') {
      return jsonResponse(500, { error: 'failed' });
    }
    if (parsed.pathname === '/api/v1/usage_events') {
      throw new TypeError('usage offline');
    }
    if (parsed.pathname === '/api/v1/desktop_error_reports') {
      throw new TypeError('reports offline');
    }
    return jsonResponse(404, { error: 'not_found' });
  }, 'session-token');

  try {
    const profile = await harness.client.updateAccountProfile({ username: 'new_name' });
    assert.equal(profile.success, false);
    assert.equal(profile.authenticated, true);
    assert.equal(profile.technicalCode, 'profile_update_failed_429');
    assert.match(profile.userMessage, /21\/06\/2026|2026/);

    await assert.rejects(
      () => harness.client.exchangeGmailOAuthCode({
        clientId: 'client-id',
        code: 'oauth-code',
        codeVerifier: 'verifier',
        redirectUri: 'http://127.0.0.1/callback',
      }),
      (error) => error.technicalCode === 'upstream',
    );
    assert.deepEqual(await harness.client.refreshGmailOAuthAccessToken({
      clientId: 'client-id',
      refreshToken: 'refresh-token',
    }), { access_token: 'access-token' });

    await assert.rejects(
      () => harness.client.registerDevice({
        deviceUid: 'device',
        deviceSecret: 'secret',
        name: 'Mac',
        platform: 'darwin_arm64',
      }),
      (error) => error.technicalCode === 'device_register_failed_401',
    );
    assert.deepEqual(await harness.client.listDevices(), []);
    await assert.rejects(
      () => harness.client.createDevicePairingCode({
        deviceId: 7,
        codeDigest: 'digest',
        expiresAt: '2026-05-21T00:00:00Z',
      }),
      (error) => error.technicalCode === 'pairing_code_failed_500',
    );

    const usage = await harness.client.submitUsageEvent({
      eventName: 'app_opened',
      installationIdentifier: 'install',
      surface: 'app',
    });
    assert.equal(usage.success, false);
    assert.equal(usage.technicalCode, 'usage_event_network_failed');

    const report = await harness.client.submitDesktopErrorReport({
      source: 'main',
      operation: 'startup',
      message: 'Failed',
      technicalCode: 'startup_failed',
    });
    assert.equal(report.success, false);
    assert.equal(report.technicalCode, 'desktop_error_report_network_failed');

    const entries = await readLogEntries(root);
    assert.equal(entries.some((entry) => entry.event === 'usage_event:submit_failed'), true);
    assert.equal(entries.some((entry) => entry.event === 'desktop_error_report:submit_failed'), true);
    assert.equal(requests.some((request) => request.init.headers?.Authorization === 'Bearer session-token'), true);
  } finally {
    harness.restore();
    await rm(root, { recursive: true, force: true });
  }
});

test('social profile resolver maps missing usernames to a profile-specific message', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forger-social-profile-missing-'));
  let requestPath;
  const harness = createClient(root, async (url) => {
    const parsed = new URL(url);
    requestPath = parsed.pathname;
    return jsonResponse(404, { error: 'not_found' });
  }, 'session-token');

  try {
    await assert.rejects(
      () => harness.client.getSocialProfile('missing_user'),
      (error) => {
        assert.equal(error.message, 'No encontramos el perfil @missing_user.');
        assert.equal(error.technicalCode, 'social_profile_not_found');
        return true;
      },
    );
    assert.equal(requestPath, '/api/v1/social/profiles/missing_user');
  } finally {
    harness.restore();
    await rm(root, { recursive: true, force: true });
  }
});
