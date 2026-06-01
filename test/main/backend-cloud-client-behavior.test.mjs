/* eslint-disable max-lines */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ForgerBackendClient } = require('../../dist-electron/main/forger-backend-client.js');
const {
  backendError,
  buildBackendHeaders,
  defaultReportingLogPath,
  googleLoginErrorMessage,
  normalizeRemoteBackup,
  normalizeRemoteBackupsUsage,
  normalizeRuntimePlatform,
  parseAccountPayload,
  remoteBackupErrorMessage,
  safeValidationKeys,
  usernameCooldownMessage,
} = require('../../dist-electron/main/forger-backend/client-helpers.js');
const {
  normalizeCloudDevice,
  normalizeCloudMessage,
  normalizeCloudUser,
  normalizeFriendship,
} = require('../../dist-electron/main/forger-backend/cloud-normalizers.js');
const { mapCatalogItem } = require('../../dist-electron/main/forger-backend/catalog-normalizers.js');

const jsonResponse = (status, body, headers = {}) => new Response(JSON.stringify(body), {
  status,
  headers: {
    'content-type': 'application/json',
    ...headers,
  },
});

test('forum participation backend client reads one-time prompt state and opt-in action', async () => {
  const requests = [];
  const harness = createClient(async (url, init = {}) => {
    requests.push({ url, init });
    const parsed = new URL(url);
    if (parsed.pathname === '/api/v1/me/forum/participation' && (!init.method || init.method === 'GET')) {
      return jsonResponse(200, {
        status: 'opted_out',
        first_prompt_shown_at: null,
        is_moderator: false,
      });
    }
    if (parsed.pathname === '/api/v1/me/forum/participation' && init.method === 'PATCH') {
      return jsonResponse(200, {
        status: 'opted_in',
        first_prompt_shown_at: '2026-06-01T10:00:00Z',
        opted_in_at: '2026-06-01T10:00:00Z',
        is_moderator: true,
      });
    }
    return jsonResponse(404, { error: 'not_found' });
  }, 'session-token');

  try {
    const initial = await harness.client.getForumParticipation();
    assert.equal(initial.status, 'opted_out');
    assert.equal(initial.firstPromptShownAt, undefined);
    assert.equal(initial.isModerator, false);

    const updated = await harness.client.updateForumParticipation('opt_in');
    assert.equal(updated.status, 'opted_in');
    assert.equal(updated.firstPromptShownAt, '2026-06-01T10:00:00Z');
    assert.equal(updated.optedInAt, '2026-06-01T10:00:00Z');
    assert.equal(updated.isModerator, true);

    assert.equal(requests[0].url, 'https://platform.test/api/v1/me/forum/participation');
    assert.equal(requests[1].init.method, 'PATCH');
    assert.deepEqual(JSON.parse(requests[1].init.body), { forum_action: 'opt_in' });
    assert.equal(requests.every((request) => request.init.headers.Authorization === 'Bearer session-token'), true);
  } finally {
    harness.restore();
  }
});

const createClient = (fetchImpl, token = 'token-1', overrides = {}) => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  const client = new ForgerBackendClient({
    backendBaseUrl: 'https://platform.test',
    localCatalogJsonUrl: overrides.localCatalogJsonUrl ?? (() => undefined),
    token: () => token,
    mapBackendCategory: () => 'productividad',
    toCatalogStatus: () => 'not_installed',
    getUserMessage: () => undefined,
    platform: () => 'darwin_arm64',
    desktopVersion: () => '0.2.test',
    reportingLogPath: overrides.reportingLogPath ?? (() => undefined),
  });
  return {
    client,
    restore: () => {
      globalThis.fetch = previousFetch;
    },
  };
};

const mapCatalog = (entry, includeDirectDownloadUrl = true) => mapCatalogItem(entry, includeDirectDownloadUrl, {
  backendBaseUrl: 'https://platform.test',
  mapBackendCategory: () => 'productividad',
  toCatalogStatus: () => 'not_installed',
  getUserMessage: (slug) => slug === 'finance-os' ? 'Instalada localmente' : undefined,
});

test('backend helper errors and validation details stay safe for logs', () => {
  const validationPayload = JSON.parse(`{
    "errors": {
      "email": ["invalid", "taken", "too long", "bad", "missing", "extra"],
      "profile.username": "reserved",
      "unsafe key with spaces": ["leak"],
      "__proto__": ["drop"],
      "constructor": ["drop"],
      "prototype": ["drop"]
    }
  }`);
  const error = backendError('Visible message', 'safe_code');
  assert.equal(error.message, 'Visible message');
  assert.equal(error.technicalCode, 'safe_code');
  assert.deepEqual(buildBackendHeaders('abc', { contentType: 'application/json' }), {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Authorization: 'Bearer abc',
  });
  assert.deepEqual(buildBackendHeaders(undefined, { accept: 'text/plain', contentType: false }), {
    Accept: 'text/plain',
  });
  assert.deepEqual(safeValidationKeys(validationPayload), Object.fromEntries([
    ['email', ['invalid', 'taken', 'too long', 'bad', 'missing']],
    ['profile.username', ['reserved']],
  ]));
  assert.equal(safeValidationKeys({ errors: [] }), undefined);
  assert.equal(safeValidationKeys(null), undefined);
  assert.equal(safeValidationKeys({ errors: { 'unsafe key with spaces': ['drop'] } }), undefined);
  assert.equal(normalizeRuntimePlatform('linux', 'arm/v7'), 'linux_arm_v7');
  assert.equal(remoteBackupErrorMessage(403, null), 'Forger Cloud Sync requiere una cuenta demo o pro.');
  assert.match(remoteBackupErrorMessage(422, { error: 'storage_limit_exceeded' }), /espacio/);
  assert.match(remoteBackupErrorMessage(422, { error: 'backup_count_limit_exceeded' }), /maximo/);
  assert.match(remoteBackupErrorMessage(500, { error: 'other' }), /No pudimos subir/);
  assert.equal(googleLoginErrorMessage({ error: 'google_login_server_not_configured' }), 'Google login no esta configurado en Forger Cloud.');
  assert.equal(googleLoginErrorMessage({ error: 'google_login_email_unverified' }), 'Google no confirmo este correo.');
  assert.equal(googleLoginErrorMessage({ error: 'google_login_account_conflict' }), 'Este correo ya esta vinculado a otra cuenta de Google.');
  assert.equal(googleLoginErrorMessage({ error: 'unknown' }), 'No pudimos iniciar sesion con Google.');
  assert.match(usernameCooldownMessage('not-a-date'), /30 dias/);
});

test('reporting log path resolves under the Desktop logs folder without writing user data', () => {
  assert.match(defaultReportingLogPath(), /forger-desktop(?:-dev)?\/logs\/reporting\.log$/);
});

test('account payload parsing requires both a user and an available token', () => {
  assert.deepEqual(parseAccountPayload(null, undefined, undefined), { authenticated: false });
  assert.equal(parseAccountPayload({
    authenticated: true,
    user: {
      id: 3,
      email: 'person@example.com',
      username: 'person',
      confirmed: true,
      subscription_tier: 'free',
    },
  }, undefined, undefined).authenticated, false);
  const parsed = parseAccountPayload({
    authenticated: true,
    confirmation_required: true,
    user: {
      id: 3,
      email: 'person@example.com',
      username: 'person',
      confirmed: true,
      subscription_tier: 'free',
    },
  }, 'new-token', undefined);
  assert.equal(parsed.authenticated, true);
  assert.equal(parsed.confirmationRequired, true);
  assert.equal(parsed.token, 'new-token');
  assert.equal(parsed.user.username, 'person');
});

test('remote backup helpers reject malformed summaries and clamp invalid usage numbers', () => {
  assert.equal(normalizeRemoteBackup({
    id: '10',
    app_id: 123,
    app_name: 'Finance OS',
  }), undefined);
  assert.equal(normalizeRemoteBackup({
    id: '11',
    app_id: 'finance-os',
    app_name: {},
  }), undefined);

  const backup = normalizeRemoteBackup({
    id: '12',
    app_id: ' finance-os ',
    app_name: ' Finance OS ',
    app_version: 42,
    backup_type: 'weird',
    source: 'cron',
    metadata: ['drop'],
    file_count: 'not-a-number',
    total_bytes: -5,
    checksum_sha256: null,
    signature: 1,
    created_at: 99,
    download_url: { href: 'bad' },
  });

  assert.equal(backup.appId, 'finance-os');
  assert.equal(backup.appName, 'Finance OS');
  assert.equal(backup.appVersion, undefined);
  assert.equal(backup.backupType, 'backup');
  assert.equal(backup.source, 'manual');
  assert.deepEqual(backup.metadata, {});
  assert.equal(backup.fileCount, 0);
  assert.equal(backup.totalBytes, 0);
  assert.equal(backup.checksumSha256, '');
  assert.equal(backup.signature, undefined);
  assert.equal(backup.downloadUrl, undefined);
  const signed = normalizeRemoteBackup({
    id: 13,
    app_id: 'recipes',
    app_name: 'Recipes',
    app_version: '2.0.0',
    backup_type: 'sync_snapshot',
    source: 'auto_sync',
    metadata: { reason: 'sync' },
    file_count: 2,
    total_bytes: 10,
    checksum_sha256: 'abc',
    signature: 'sig',
    signature_key_fingerprint: 'fp',
    signature_algorithm: 'rsa',
    created_at: '2026-05-21T00:00:00Z',
    updated_at: '2026-05-21T00:01:00Z',
    download_url: 'https://platform.test/download',
  });
  assert.equal(signed.signatureKeyFingerprint, 'fp');
  assert.equal(signed.signatureAlgorithm, 'rsa');
  assert.equal(signed.updatedAt, '2026-05-21T00:01:00Z');
  assert.equal(signed.downloadUrl, 'https://platform.test/download');
  assert.deepEqual(normalizeRemoteBackupsUsage({
    used_bytes: '32',
    limit_bytes: 'bad',
    backup_count: -1,
    backup_count_limit: null,
  }), {
    usedBytes: 32,
    limitBytes: 0,
    backupCount: 0,
    backupCountLimit: 0,
  });
});

test('cloud normalizers reject malformed top-level and nested cloud records', () => {
  assert.equal(normalizeCloudDevice(null), undefined);
  assert.equal(normalizeCloudDevice({ id: 'not-a-number' }), undefined);
  assert.deepEqual(normalizeCloudDevice({
    id: '8',
    device_uid: 42,
    name: 99,
    platform: 'darwin',
    public_key: 'public',
    key_fingerprint: 'fingerprint',
    paired: true,
    online: true,
    last_seen_at: '2026-05-21T00:00:00Z',
    installed_apps: [
      null,
      { id: '', name: 'Missing id' },
      { id: 'finance-os', name: 77, status: 10, version: 4 },
      { id: 'recipes', name: 'Recipes', status: 'running', version: '2.0.0' },
    ],
  }), {
    id: 8,
    deviceUid: '',
    name: 'Forger Desktop',
    platform: 'darwin',
    publicKey: 'public',
    keyFingerprint: 'fingerprint',
    paired: true,
    online: true,
    lastSeenAt: '2026-05-21T00:00:00Z',
    installedApps: [{
    id: 'finance-os',
    name: 'finance-os',
    status: 'installed',
    version: undefined,
    }, {
      id: 'recipes',
      name: 'Recipes',
      status: 'running',
      version: '2.0.0',
    }],
  });

  assert.equal(normalizeCloudUser(null), undefined);
  assert.equal(normalizeCloudUser({ id: 4, username: '' }), undefined);
  assert.deepEqual(normalizeCloudUser({
    id: '5',
    username: 'friend',
    devices: [
      null,
      { id: 'bad', device_uid: 'device' },
      { id: 9, device_uid: '', public_key: 'drop' },
      { id: '10', device_uid: 'device-10', public_key: 42, key_fingerprint: 77 },
    ],
  }).devices, [{
    id: 10,
    deviceUid: 'device-10',
    publicKey: undefined,
    keyFingerprint: undefined,
    online: false,
  }]);

  assert.equal(normalizeFriendship(null), undefined);
  assert.equal(normalizeFriendship({ id: 1, friend: { id: 2 } }), undefined);
  assert.equal(normalizeCloudMessage(null), undefined);
  assert.equal(normalizeCloudMessage({
    sender: { id: 1, username: 'me' },
    recipient: null,
  }), undefined);
  const message = normalizeCloudMessage({
    id: '12',
    sender: { id: 1, username: 'me' },
    recipient: { id: 2, username: 'friend' },
    delivery_mode: 'ephemeral',
    source: 'app',
    status: 'blocked',
    metadata: [],
    envelopes: [
      null,
      { ciphertext: '' },
      { id: '7', ciphertext: 'sealed', metadata: [] },
    ],
  });
  assert.equal(message.id, 12);
  assert.equal(message.deliveryMode, 'ephemeral');
  assert.equal(message.source, 'app');
  assert.equal(message.status, 'blocked');
  assert.deepEqual(message.metadata, {});
  assert.deepEqual(message.envelopes, [{
    id: 7,
    deviceUid: undefined,
    keyFingerprint: undefined,
    ciphertext: 'sealed',
    metadata: {},
    readAt: undefined,
  }]);
  assert.equal(normalizeCloudMessage({
    id: 13,
    sender: { id: 1, username: 'me' },
    recipient: { id: 2, username: 'friend' },
    delivery_mode: 'unknown',
    source: 'unknown',
    status: 'not_delivered',
    client_message_id: 'client-1',
    source_app_id: 'finance-os',
    source_app_name: 'Finance OS',
    metadata: { scope: 'test' },
    envelopes: [{
      id: '8',
      device_uid: 'device-1',
      key_fingerprint: 'fingerprint',
      ciphertext: 'sealed-2',
      metadata: { key: 'value' },
      read_at: '2026-05-21T00:00:00Z',
    }],
    delivered_at: '2026-05-21T00:01:00Z',
    created_at: '2026-05-21T00:02:00Z',
    updated_at: '2026-05-21T00:03:00Z',
  }).status, 'not_delivered');
  assert.equal(normalizeCloudMessage({
    sender: { id: 1, username: 'me' },
    recipient: { id: 2, username: 'friend' },
    status: 'pending_permission',
  }).status, 'pending_permission');
  assert.equal(normalizeCloudMessage({
    sender: { id: 1, username: 'me' },
    recipient: { id: 2, username: 'friend' },
    status: 'unknown',
  }).status, 'stored');
});

test('catalog normalizer keeps runtime contracts and drops malformed backend metadata safely', () => {
  const app = mapCatalog({
    slug: 'finance-os',
    name: 'Finance OS',
    short_description: null,
    description: 'Finance app',
    category: 'finance',
    icon_url: '/icons/finance.png',
    status: 'beta',
    average_rating: '4.5',
    ratings_count: 'bad',
    recent_ratings: [
      { id: 'bad', score: 5 },
      { id: '4', score: '4', user: { first_name: 'Ana', last_initial: 'P' } },
    ],
    current_user_rating: { id: 9, score: 'bad' },
    tools: {
      required: [
        { toolId: 'gmail', actions: ['gmail.search_messages', ''], reason: ' Leer correo ' },
        { toolId: 'missing-reason', actions: ['gmail.send_email'] },
      ],
      optional: 'bad',
    },
    latest_version: {
      id: 22,
      version: '1.2.3',
      download_url: 'https://downloads.test/finance.zip',
      changelog: { summary: 'Updated', changes: ['Visible', 42] },
      agents: [
        {
          id: 'advisor',
          title: 'Advisor',
          prompts: {
            initial: {
              body: 'Review {{file}}.',
              variables: {
                file: { type: 'path', required: true },
                'bad space': { type: 'text' },
                unsafe: { type: 'date' },
              },
            },
          },
          kind: 'orchestrator',
          provider: 'claude',
          model: 'sonnet',
          effort: 'high',
          runtimeRecommendations: {
            codex: { model: 'gpt-5.4', reasoningEffort: 'medium' },
          },
        },
        { id: 'missing-prompt', title: 'Drop' },
      ],
      promptTemplates: [
        {
          id: 'summary',
          title: 'Summary',
          prompt: 'Summarize {{file}}.',
          runtime: { provider: 'codex', model: 'gpt-5.5', effort: 'high' },
          reasoningEffort: 'xhigh',
        },
        { id: 'empty', title: 'Drop', prompt: '' },
      ],
    },
  }, false);

  assert.equal(app.description, 'Finance app');
  assert.equal(app.iconUrl, 'https://platform.test/icons/finance.png');
  assert.equal(app.catalogStatus, 'beta');
  assert.equal(app.beta, true);
  assert.equal(app.latestVersionId, 22);
  assert.equal(app.downloadUrl, undefined);
  assert.deepEqual(app.changelog, { version: '1.2.3', summary: 'Updated', changes: ['Visible'] });
  assert.equal(app.averageRating, 4.5);
  assert.equal(app.ratingsCount, undefined);
  assert.deepEqual(app.recentRatings.map((rating) => [rating.id, rating.score]), [[4, 4]]);
  assert.equal(app.currentUserRating, undefined);
  assert.deepEqual(app.tools, {
    required: [{ toolId: 'gmail', actions: ['gmail.search_messages'], reason: 'Leer correo' }],
    optional: [],
  });
  assert.deepEqual(app.agents[0].runtime, { provider: 'claude', model: 'sonnet', effort: 'high' });
  assert.deepEqual(app.agents[0].prompts.initial.variables, { file: { type: 'path', required: true } });
  assert.deepEqual(app.agents[0].runtimeRecommendations, {
    codex: { model: 'gpt-5.4', reasoningEffort: 'medium' },
  });
  assert.deepEqual(app.promptTemplates.map((template) => [template.id, template.reasoningEffort]), [['summary', 'xhigh']]);
  assert.deepEqual(app.promptTemplates[0].runtime, { provider: 'codex', model: 'gpt-5.5', effort: 'high' });
  assert.equal(app.userMessage, 'Instalada localmente');
  assert.equal(app.requiredPythonVersion, undefined);
  assert.equal(app.requiredNodeVersion, undefined);
  assert.equal(app.checksumSha256, undefined);

  const publicApp = mapCatalog({
    slug: 'recipes',
    name: 'Recipes',
    category: 'recipes',
    icon_url: 'http://[bad-url]',
    latest_version: { version: '2.0.0', download_url: 'https://downloads.test/recipes.zip' },
  });
  assert.equal(publicApp.iconUrl, undefined);
  assert.equal(publicApp.downloadUrl, 'https://downloads.test/recipes.zip');
  assert.equal(publicApp.description, '');
  assert.equal(publicApp.beta, false);
});

test('catalog normalizer keeps optional tools, direct agents, and prompt template fallbacks', () => {
  const app = mapCatalog({
    slug: 'recipes',
    name: 'Recipes',
    short_description: '  ',
    description: null,
    category: 'recipes',
    tools: {
      required: [
        null,
        [],
        { toolId: 7, actions: ['gmail.search_messages'], reason: 'Bad tool id' },
      ],
      optional: [
        { toolId: ' gmail ', actions: ['gmail.send_email', 99], reason: ' Puede enviar ' },
      ],
    },
    agents: [
      null,
      [],
      {
        id: ' cook ',
        title: ' Cook ',
        description: ' Helps cook ',
        initialPrompt: ' Make dinner ',
        initialPromptTemplate: 'recipe-template',
        kind: 'classic',
        model: ' gpt-test ',
        reasoningEffort: 'low',
        prompts: {
          initial: { body: ' Start ', variables: [] },
          resume: { body: ' Resume ', variables: { note: { type: 'text', required: false } } },
          steer: { body: '', variables: { ignored: { type: 'text' } } },
        },
      },
    ],
    prompt_templates: [
      null,
      [],
      {
        id: ' weekly ',
        title: ' Weekly ',
        description: ' Plan week ',
        prompt: ' Plan {{days}} ',
        model: ' gpt-template ',
        reasoningEffort: 'medium',
      },
    ],
  });

  assert.deepEqual(app.tools, {
    required: [],
    optional: [{ toolId: 'gmail', actions: ['gmail.send_email'], reason: 'Puede enviar' }],
  });
  assert.deepEqual(app.agents.map((agent) => ({
    id: agent.id,
    title: agent.title,
    description: agent.description,
    initialPrompt: agent.initialPrompt,
    initialPromptTemplate: agent.initialPromptTemplate,
    kind: agent.kind,
    model: agent.model,
    reasoningEffort: agent.reasoningEffort,
    resume: agent.prompts.resume,
  })), [{
    id: 'cook',
    title: 'Cook',
    description: 'Helps cook',
    initialPrompt: 'Make dinner',
    initialPromptTemplate: 'recipe-template',
    kind: 'classic',
    model: 'gpt-test',
    reasoningEffort: 'low',
    resume: { body: 'Resume', variables: { note: { type: 'text', required: false } } },
  }]);
  assert.deepEqual(app.promptTemplates, [{
    id: 'weekly',
    title: 'Weekly',
    description: 'Plan week',
    prompt: 'Plan {{days}}',
    model: 'gpt-template',
    reasoningEffort: 'medium',
    runtime: { provider: 'codex', model: 'gpt-template', effort: 'medium' },
  }]);
});

test('catalog listing falls back to local metadata and dedupes backend apps first', async () => {
  const requests = [];
  const harness = createClient(async (url) => {
    requests.push(String(url));
    const parsed = new URL(url);
    if (parsed.pathname === '/api/v1/catalog/apps') {
      return jsonResponse(200, [{
        slug: 'finance-os',
        name: 'Finance OS',
        short_description: 'Backend finance',
        description: 'Backend app',
        category: 'finance',
        icon_url: '/icons/finance.png',
        status: 'production',
        latest_version: { id: 7, version: '1.0.0', checksum_sha256: 'abc' },
      }]);
    }
    return jsonResponse(200, [
      {
        slug: 'finance-os',
        name: 'Finance Local',
        description: 'Local duplicate',
        category: 'finance',
        latest_version: { version: 'local' },
      },
      {
        slug: 'recipes',
        name: 'Recipes',
        description: 'Local recipes',
        category: 'food',
        icon_url: 'icons/recipes.svg',
        latest_version: { version: '2.0.0', download_url: 'https://downloads.test/recipes.zip' },
      },
    ]);
  }, 'session-token', { localCatalogJsonUrl: () => 'https://local.test/catalog.json' });

  try {
    const apps = await harness.client.listCatalogApps();
    assert.deepEqual(apps.map((app) => app.id), ['finance-os', 'recipes']);
    assert.equal(apps[0].name, 'Finance OS');
    assert.equal(apps[0].latestVersionId, 7);
    assert.equal(apps[0].downloadUrl, undefined);
    assert.equal(apps[1].downloadUrl, 'https://downloads.test/recipes.zip');
    assert.equal(requests.includes('https://local.test/catalog.json'), true);
  } finally {
    harness.restore();
  }

  const fallback = createClient(async (url) => {
    if (String(url).includes('/api/v1/catalog/apps')) {
      throw new Error('backend down');
    }
    return jsonResponse(200, [{ slug: 'local-only', name: 'Local', description: 'Only local', category: 'dev' }]);
  }, 'session-token', { localCatalogJsonUrl: () => 'https://local.test/catalog.json' });
  try {
    assert.deepEqual((await fallback.client.listCatalogApps()).map((app) => app.id), ['local-only']);
  } finally {
    fallback.restore();
  }
});

test('backend client covers fallback branches for auth, reporting, local catalog, and cloud backups', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'forger-cloud-branch-fallbacks-'));
  const archivePath = join(root, 'backup.zip');
  await writeFile(archivePath, 'zip-bytes');
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const requests = [];
  const harness = createClient(async (url, init = {}) => {
    requests.push({ url, init });
    const parsed = new URL(url);
    if (parsed.pathname === '/api/v1/catalog/apps') {
      return jsonResponse(200, []);
    }
    if (parsed.pathname === '/local-catalog.json') {
      return jsonResponse(200, { apps: [] });
    }
    if (parsed.pathname === '/api/v1/session' && init.method === 'POST') {
      return jsonResponse(200, { authenticated: true, user: { id: 1, email: 'person@example.com' } });
    }
    if (parsed.pathname === '/api/v1/me/profile') {
      return jsonResponse(500, {});
    }
    if (parsed.pathname === '/api/v1/catalog/apps/recipes/rating') {
      return jsonResponse(403, { error: 'confirmation_required' });
    }
    if (parsed.pathname === '/api/v1/usage_events') {
      throw 'usage offline';
    }
    if (parsed.pathname === '/api/v1/desktop_error_reports') {
      throw 'report offline';
    }
    if (parsed.pathname === '/api/v1/me/backups' && init.method === 'GET') {
      return jsonResponse(503, { error: 'down' });
    }
    if (parsed.pathname === '/api/v1/me/backups' && init.method === 'POST') {
      return jsonResponse(201, {
        id: '77',
        app_id: 'recipes',
        app_name: 'Recipes',
        backup_type: 'sync_snapshot',
        source: 'auto_sync',
        checksum_sha256: 'abc',
      });
    }
    if (parsed.pathname === '/api/v1/me/backups/77/download') {
      return new Response('archive-bytes', { status: 200 });
    }
    if (parsed.pathname === '/api/v1/me/backups/77') {
      return new Response(null, { status: 204 });
    }
    if (parsed.pathname === '/api/v1/app_versions/88/download') {
      return jsonResponse(500, { error: 'down' });
    }
    return jsonResponse(404, { error: 'not_found' });
  }, '', {
    localCatalogJsonUrl: () => 'https://platform.test/local-catalog.json',
    reportingLogPath: () => join(root, 'logs', 'reporting.log'),
  });

  try {
    assert.deepEqual(await harness.client.listCatalogApps(), []);
    const login = await harness.client.loginAccount({ email: 'person@example.com', password: 'secret', locale: 'es' });
    assert.equal(login.success, false);
    assert.equal(login.technicalCode, 'login_failed_200');
    await harness.client.logoutAccount();
    assert.equal(requests.some((request) => new URL(request.url).pathname === '/api/v1/session' && request.init.method === 'DELETE'), false);

    const profile = await harness.client.updateAccountProfile({ username: 'next' });
    assert.equal(profile.success, false);
    assert.equal(profile.authenticated, false);
    assert.equal(profile.userMessage, 'No pudimos actualizar tu perfil.');

    const rating = await harness.client.submitAppRating({ appId: 'recipes', score: 4, locale: 'es' });
    assert.equal(rating.success, false);
    assert.equal(rating.userMessage, 'Confirma tu correo para publicar una review.');

    assert.equal((await harness.client.submitUsageEvent({
      eventName: 'desktop_opened',
      installationIdentifier: 'install-1',
      surface: 'desktop',
    })).technicalCode, 'usage_event_network_failed');
    assert.equal((await harness.client.submitDesktopErrorReport({
      source: 'main',
      operation: 'startup',
      message: 'Boom',
      technicalCode: 'boom',
      desktopVersion: '0.2.test',
      platform: 'darwin',
      arch: 'arm64',
    })).technicalCode, 'desktop_error_report_network_failed');

    assert.deepEqual(await harness.client.listRemoteBackups(), {
      backups: [],
      usage: { usedBytes: 0, limitBytes: 0, backupCount: 0, backupCountLimit: 0 },
    });
    const uploaded = await harness.client.createRemoteBackup({
      archivePath,
      localBackup: {
        backupId: 'local-1',
        appId: 'recipes',
        appName: 'Recipes',
        appVersion: '2.0.0',
        reason: 'sync',
        createdAt: '2026-05-21T00:00:00Z',
        fileCount: 1,
        totalBytes: 9,
        files: ['db.sqlite'],
      },
      backupType: 'sync_snapshot',
      source: 'auto_sync',
      signature: 'signed',
    });
    assert.equal(uploaded.success, true);
    assert.equal(uploaded.userMessage, 'Datos sincronizados con Forger Cloud.');
    const form = requests.find((request) => new URL(request.url).pathname === '/api/v1/me/backups' && request.init.method === 'POST').init.body;
    assert.equal(form.get('signature_key_fingerprint'), '');
    assert.equal(form.get('signature_algorithm'), 'rsa-sha256');
    assert.deepEqual(await harness.client.downloadRemoteBackup(77, join(root, 'download.zip')), { checksumSha256: undefined });
    assert.deepEqual(await harness.client.deleteRemoteBackup(77), { success: true, userMessage: 'Respaldo cloud eliminado.' });
    await assert.rejects(() => harness.client.requestDownload(88, { platform: 'darwin_arm64', deviceIdentifier: 'device' }), /download_request_failed_500/);
  } finally {
    harness.restore();
  }
});

test('Gmail OAuth backend calls trim client IDs and surface safe technical codes', async () => {
  const requests = [];
  const harness = createClient(async (url, init) => {
    requests.push({ url, init });
    if (url.endsWith('/api/v1/oauth/gmail/config')) {
      return jsonResponse(200, { client_id: '  gmail-client-id  ' });
    }
    return jsonResponse(400, {
      error: 'invalid_grant',
      error_description: 'Refresh token expired',
    });
  }, 'session-token');

  try {
    assert.equal(await harness.client.getGmailOAuthClientId(), 'gmail-client-id');
    assert.equal(requests[0].init.headers.Authorization, 'Bearer session-token');
    await assert.rejects(
      () => harness.client.refreshGmailOAuthAccessToken({
        clientId: 'gmail-client-id',
        refreshToken: 'refresh-token',
      }),
      (error) => error.message === 'Refresh token expired'
        && error.technicalCode === 'invalid_grant',
    );
    assert.equal(JSON.parse(requests[1].init.body).refresh_token, 'refresh-token');
  } finally {
    harness.restore();
  }
});

test('Google login session and device calls avoid live network and normalize cloud payloads', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forger-cloud-client-'));
  const requests = [];
  const harness = createClient(async (url, init) => {
    requests.push({ url, init });
    if (url.endsWith('/api/v1/oauth/google/config')) {
      return jsonResponse(200, { client_id: ' google-client ' });
    }
    if (url.endsWith('/api/v1/oauth/google/session')) {
      return jsonResponse(401, { error: 'access_denied' });
    }
    if (url.endsWith('/api/v1/me/devices/register')) {
      return jsonResponse(200, {
        id: '44',
        device_uid: 'device-uid',
        name: 'Work Mac',
        platform: 'darwin_arm64',
        paired: true,
        online: true,
        installed_apps: [
          { id: 'finance-os', name: 'Finance OS', status: 'running', version: '1.2.3' },
          { name: 'missing-id' },
        ],
      });
    }
    return jsonResponse(404, { error: 'not_found' });
  });

  try {
    assert.equal(await harness.client.getGoogleLoginOAuthClientId(), 'google-client');
    const login = await harness.client.createGoogleLoginSession({
      clientId: 'google-client',
      code: 'code',
      codeVerifier: 'verifier',
      redirectUri: 'http://127.0.0.1/callback',
    });
    assert.equal(login.success, false);
    assert.equal(login.technicalCode, 'google_login_failed_401');
    assert.match(login.userMessage, /Google cancelo/);

    const device = await harness.client.registerDevice({
      deviceUid: 'device-uid',
      deviceSecret: 'secret',
      name: 'Work Mac',
      platform: 'darwin_arm64',
      publicKey: 'public',
      keyFingerprint: 'fingerprint',
    });
    assert.equal(device.id, 44);
    assert.equal(device.deviceUid, 'device-uid');
    assert.equal(device.installedApps.length, 1);
    assert.equal(device.installedApps[0].id, 'finance-os');

    const registerBody = JSON.parse(requests[2].init.body);
    assert.equal(registerBody.device_secret, 'secret');
    assert.equal(registerBody.public_key, 'public');
  } finally {
    harness.restore();
    await rm(root, { recursive: true, force: true });
  }
});

test('backend client rejects malformed OAuth, friendship, message, and backup payloads with safe fallbacks', async () => {
  const requests = [];
  const harness = createClient(async (url, init) => {
    requests.push({ url, init });
    const parsed = new URL(url);
    if (parsed.pathname === '/api/v1/oauth/gmail/config') {
      return jsonResponse(requests.filter((request) => String(request.url).endsWith('/api/v1/oauth/gmail/config')).length === 1 ? 503 : 200, {});
    }
    if (parsed.pathname === '/api/v1/oauth/gmail/token') {
      return new Response('not-json', { status: 200 });
    }
    if (parsed.pathname === '/api/v1/oauth/google/config') {
      return jsonResponse(requests.filter((request) => String(request.url).endsWith('/api/v1/oauth/google/config')).length === 1 ? 500 : 200, {});
    }
    if (parsed.pathname === '/api/v1/me/devices') {
      return jsonResponse(503, { error: 'down' });
    }
    if (parsed.pathname === '/api/v1/me/friends') {
      return jsonResponse(init.method === 'GET' ? 401 : 200, {});
    }
    if (parsed.pathname === '/api/v1/me/friends/search') {
      return jsonResponse(200, { users: [] });
    }
    if (parsed.pathname === '/api/v1/me/friend_requests') {
      return jsonResponse(200, {});
    }
    if (parsed.pathname === '/api/v1/me/friend_requests/10/accept') {
      return jsonResponse(200, {});
    }
    if (parsed.pathname === '/api/v1/me/friends/12/read_receipt') {
      return jsonResponse(200, {});
    }
    if (parsed.pathname === '/api/v1/me/cloud_messages' && init.method === 'GET') {
      return jsonResponse(200, { messages: [] });
    }
    if (parsed.pathname === '/api/v1/me/cloud_messages') {
      return jsonResponse(200, {});
    }
    if (parsed.pathname === '/api/v1/me/app_message_permission') {
      return jsonResponse(
        requests.filter((request) => String(request.url).endsWith('/api/v1/me/app_message_permission')).length === 1 ? 500 : 200,
        {},
      );
    }
    if (parsed.pathname === '/api/v1/me/backups') {
      return jsonResponse(200, 'not-an-object');
    }
    if (parsed.pathname === '/api/v1/me/backups/77/download') {
      return jsonResponse(404, { error: 'missing' });
    }
    if (parsed.pathname === '/api/v1/me/backups/77') {
      return jsonResponse(500, { error: 'down' });
    }
    if (parsed.pathname === '/api/v1/app_versions/99/download') {
      return jsonResponse(200, { download_url: 'https://downloads.test/app.zip', version: {} });
    }
    return jsonResponse(404, { error: 'not_found' });
  });

  try {
    await assert.rejects(
      () => harness.client.getGmailOAuthClientId(),
      (error) => error.technicalCode === 'gmail_oauth_config_failed_503',
    );
    await assert.rejects(
      () => harness.client.getGmailOAuthClientId(),
      (error) => error.technicalCode === 'gmail_oauth_client_missing',
    );
    await assert.rejects(
      () => harness.client.exchangeGmailOAuthCode({
        clientId: 'gmail-client',
        code: 'code',
        codeVerifier: 'verifier',
        redirectUri: 'http://127.0.0.1/callback',
      }),
      (error) => error.technicalCode === 'gmail_oauth_backend_response_invalid',
    );

    await assert.rejects(
      () => harness.client.getGoogleLoginOAuthClientId(),
      (error) => error.technicalCode === 'google_login_config_failed_500',
    );
    await assert.rejects(
      () => harness.client.getGoogleLoginOAuthClientId(),
      (error) => error.technicalCode === 'google_login_client_missing',
    );
    await assert.rejects(
      () => harness.client.listDevices(),
      (error) => error.technicalCode === 'devices_list_failed_503',
    );

    await assert.rejects(
      () => harness.client.listFriends(),
      (error) => error.technicalCode === 'friends_list_failed_401',
    );
    assert.deepEqual(await harness.client.searchFriends('nobody'), []);
    await assert.rejects(
      () => harness.client.sendFriendRequest('friend'),
      (error) => error.technicalCode === 'friend_request_response_invalid',
    );
    await assert.rejects(
      () => harness.client.acceptFriendRequest(10),
      (error) => error.technicalCode === 'friend_request_accept_response_invalid',
    );
    await assert.rejects(
      () => harness.client.markFriendChatRead(12),
      (error) => error.technicalCode === 'friend_read_receipt_response_invalid',
    );
    assert.deepEqual(await harness.client.listCloudMessages(12), []);
    await assert.rejects(
      () => harness.client.sendCloudMessage({ recipientUsername: 'friend', envelopes: [] }),
      (error) => error.technicalCode === 'cloud_message_response_invalid',
    );
    await assert.rejects(
      () => harness.client.decideAppMessagePermission(88, 'allow'),
      (error) => error.technicalCode === 'app_message_permission_failed_500',
    );
    await assert.rejects(
      () => harness.client.decideAppMessagePermission(88, 'allow'),
      (error) => error.technicalCode === 'app_message_permission_response_invalid',
    );
    assert.equal(harness.client.normalizeCloudMessagePayload({}), undefined);
    assert.equal(harness.client.normalizeFriendshipPayload({ id: 1 }), undefined);

    assert.deepEqual(await harness.client.listRemoteBackups('finance-os'), {
      backups: [],
      usage: { usedBytes: 0, limitBytes: 0, backupCount: 0, backupCountLimit: 0 },
    });
    await assert.rejects(() => harness.client.downloadRemoteBackup(77, '/tmp/unused.zip'), /remote_backup_download_failed_404/);
    assert.deepEqual(await harness.client.deleteRemoteBackup(77), {
      success: false,
      userMessage: 'No pudimos eliminar el respaldo cloud.',
      technicalCode: 'remote_backup_delete_failed_500',
    });
    await assert.rejects(
      () => harness.client.requestDownload(99, { platform: 'darwin_arm64', deviceIdentifier: 'device' }),
      /download_payload_invalid/,
    );
  } finally {
    harness.restore();
  }
});

test('account and profile calls normalize failed sessions without leaking backend payloads', async () => {
  const requests = [];
  const harness = createClient(async (url, init) => {
    requests.push({ url, init });
    const parsed = new URL(url);
    if (parsed.pathname === '/api/v1/users') {
      return jsonResponse(422, { errors: { password: ['too short'] } });
    }
    if (parsed.pathname === '/api/v1/session' && init.method === 'POST') {
      return jsonResponse(403, { error: 'confirmation_required' });
    }
    if (parsed.pathname === '/api/v1/session' && init.method === 'DELETE') {
      return jsonResponse(204, {});
    }
    if (parsed.pathname === '/api/v1/me/profile') {
      return jsonResponse(422, {
        error: 'username_change_cooldown',
        username_change_available_at: '2026-06-20T00:00:00Z',
      });
    }
    return jsonResponse(404, { error: 'not_found' });
  }, 'session-token');

  try {
    const registered = await harness.client.registerAccount({
      firstName: 'Test',
      lastName: 'User',
      username: 'test',
      email: 'test@example.com',
      password: 'secret',
      country: 'CL',
      age: 30,
      gender: 'other',
      locale: 'es',
    });
    assert.equal(registered.success, false);
    assert.equal(registered.technicalCode, 'register_failed_422');

    const login = await harness.client.loginAccount({
      email: 'test@example.com',
      password: 'secret',
      locale: 'es',
    });
    assert.equal(login.success, false);
    assert.equal(login.confirmationRequired, true);
    assert.equal(login.technicalCode, 'login_failed_403');

    await harness.client.logoutAccount();
    const profile = await harness.client.updateAccountProfile({ username: 'next' });
    assert.equal(profile.success, false);
    assert.equal(profile.authenticated, true);
    assert.equal(profile.technicalCode, 'profile_update_failed_422');
    assert.match(profile.userMessage, /Podras cambiar tu username/);

    assert.equal(requests.some((request) => new URL(request.url).pathname === '/api/v1/session' && request.init.method === 'DELETE'), true);
  } finally {
    harness.restore();
  }
});

test('account, rating, feedback, usage, and error report success paths serialize safe payloads', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'forger-cloud-success-'));
  const logPath = join(root, 'logs', 'reporting.log');
  const requests = [];
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const harness = createClient(async (url, init) => {
    requests.push({ url, init });
    const parsed = new URL(url);
    if (parsed.pathname === '/api/v1/users') {
      return jsonResponse(201, {
        authenticated: true,
        token: 'registered-token',
        user: { id: 7, email: 'new@example.com', username: 'new-user' },
      });
    }
    if (parsed.pathname === '/api/v1/session') {
      return jsonResponse(200, {
        authenticated: true,
        token: 'login-token',
        user: { id: 8, email: 'login@example.com', username: 'login-user' },
      });
    }
    if (parsed.pathname === '/api/v1/me/profile') {
      return jsonResponse(200, {
        authenticated: true,
        user: { id: 8, email: 'login@example.com', username: 'renamed' },
      });
    }
    if (parsed.pathname === '/api/v1/catalog/apps/finance-os/rating') {
      return jsonResponse(200, { id: 3, score: 5, comment: 'Great' });
    }
    if (parsed.pathname === '/api/v1/feedbacks') {
      return jsonResponse(201, {}, { 'x-request-id': 'feedback-request' });
    }
    if (parsed.pathname === '/api/v1/usage_events') {
      return jsonResponse(201, {}, { 'x-request-id': 'usage-request' });
    }
    if (parsed.pathname === '/api/v1/desktop_error_reports') {
      return jsonResponse(201, {}, { 'x-request-id': 'report-request' });
    }
    return jsonResponse(404, { error: 'not_found' });
  }, 'session-token', { reportingLogPath: () => logPath });

  try {
    const registered = await harness.client.registerAccount({
      firstName: 'New',
      lastName: 'User',
      username: 'new-user',
      email: 'new@example.com',
      password: 'secret',
      country: 'CL',
      age: 28,
      gender: 'other',
      locale: 'es',
    });
    assert.equal(registered.success, true);
    assert.equal(registered.confirmationRequired, true);

    const login = await harness.client.loginAccount({ email: 'login@example.com', password: 'secret', locale: 'es' });
    assert.equal(login.success, true);
    assert.equal(login.token, 'login-token');
    assert.equal((await harness.client.updateAccountProfile({ username: 'renamed' })).success, true);

    const rating = await harness.client.submitAppRating({ appId: 'finance-os', score: 5, comment: 'Great', locale: 'es' });
    assert.equal(rating.success, true);
    assert.equal(rating.rating.score, 5);

    assert.equal((await harness.client.submitProductFeedback({
      target: 'desktop',
      kind: 'idea',
      body: 'Better onboarding',
      surface: 'settings',
      locale: 'es',
    })).success, true);
    assert.deepEqual(await harness.client.submitUsageEvent({
      eventName: 'desktop_opened',
      installationIdentifier: 'install-1',
      surface: 'desktop',
      locale: 'es',
      occurredAt: '2026-05-21T00:00:00Z',
    }), { success: true });
    assert.equal((await harness.client.submitDesktopErrorReport({
      source: 'main',
      operation: 'startup',
      message: 'Boom',
      technicalCode: 'startup_failed',
      desktopVersion: '0.2.test',
      platform: 'darwin',
      arch: 'arm64',
      details: { safe: true },
      sensitiveDetails: { stack: 'private' },
    })).success, true);

    const feedbackBody = JSON.parse(requests.find((request) => new URL(request.url).pathname === '/api/v1/feedbacks').init.body);
    assert.equal(feedbackBody.platform, 'darwin_arm64');
    const logEntries = (await readFile(logPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(logEntries.some((entry) => entry.event === 'feedback:submit_success' && entry.requestId === 'feedback-request'), true);
    assert.equal(logEntries.some((entry) => entry.event === 'desktop_error_report:submit_success' && entry.requestId === 'report-request'), true);
  } finally {
    harness.restore();
  }
});

test('backend client handles empty local catalogs, network logging failures, and invalid OAuth payloads', async () => {
  const originalFetch = globalThis.fetch;
  const noCatalog = createClient(async () => jsonResponse(500, { error: 'down' }), undefined, {
    localCatalogJsonUrl: () => undefined,
  });
  try {
    assert.deepEqual(await noCatalog.client.listCatalogApps(), []);
    await noCatalog.client.logoutAccount();
  } finally {
    noCatalog.restore();
  }

  const requests = [];
  const harness = createClient(async (url, init) => {
    requests.push({ url, init });
    const parsed = new URL(url);
    if (parsed.pathname === '/local-catalog.json') {
      return jsonResponse(503, { error: 'local_down' });
    }
    if (parsed.pathname === '/api/v1/oauth/gmail/token') {
      return new Response('', { status: 200 });
    }
    if (parsed.pathname === '/api/v1/oauth/google/config') {
      return jsonResponse(200, { client_id: '   ' });
    }
    if (parsed.pathname === '/api/v1/feedbacks') {
      throw new Error('network down');
    }
    if (parsed.pathname === '/api/v1/usage_events') {
      return jsonResponse(422, { errors: { event_name: ['blank'] } }, { 'x-request-id': 'usage-422' });
    }
    if (parsed.pathname === '/api/v1/desktop_error_reports') {
      return jsonResponse(500, { error: 'down' }, { 'x-request-id': 'report-500' });
    }
    if (parsed.pathname === '/api/v1/catalog/apps') {
      return jsonResponse(200, []);
    }
    return jsonResponse(404, { error: 'not_found' });
  }, 'session-token', {
    localCatalogJsonUrl: () => 'https://platform.test/local-catalog.json',
    reportingLogPath: () => '',
  });

  try {
    assert.deepEqual(await harness.client.listCatalogApps(), []);
    await assert.rejects(
      () => harness.client.exchangeGmailOAuthCode({
        clientId: 'gmail',
        code: 'code',
        codeVerifier: 'verifier',
        redirectUri: 'http://127.0.0.1/callback',
      }),
      (error) => error.technicalCode === 'gmail_oauth_backend_response_invalid',
    );
    await assert.rejects(
      () => harness.client.getGoogleLoginOAuthClientId(),
      (error) => error.technicalCode === 'google_login_client_missing',
    );
    assert.equal((await harness.client.submitProductFeedback({
      target: 'desktop',
      kind: 'bug',
      body: 'Failed',
      surface: 'settings',
    })).technicalCode, 'feedback_network_failed');
    const usage = await harness.client.submitUsageEvent({
      eventName: 'bad',
      installationIdentifier: 'install-1',
      surface: 'desktop',
    });
    assert.equal(usage.technicalCode, 'usage_event_failed_422');
    assert.equal(usage.details.requestId, 'usage-422');
    assert.deepEqual(usage.details.validationErrors, { event_name: ['blank'] });
    const report = await harness.client.submitDesktopErrorReport({
      source: 'renderer',
      operation: 'render',
      message: 'Failed',
      technicalCode: 'render_failed',
      desktopVersion: '0.2.test',
      platform: 'darwin',
      arch: 'arm64',
    });
    assert.equal(report.technicalCode, 'desktop_error_report_failed_500');
    assert.equal(requests.some((request) => new URL(request.url).pathname === '/local-catalog.json'), true);
  } finally {
    harness.restore();
    globalThis.fetch = originalFetch;
  }
});

test('device, social, and backup client methods normalize malformed backend responses', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'forger-cloud-failures-'));
  const archivePath = join(root, 'backup.zip');
  await writeFile(archivePath, 'zip');
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const requests = [];
  const harness = createClient(async (url, init) => {
    requests.push({ url, init });
    const parsed = new URL(url);
    if (parsed.pathname === '/api/v1/oauth/gmail/config') {
      return jsonResponse(200, { client_id: '   ' });
    }
    if (parsed.pathname === '/api/v1/oauth/google/config') {
      return jsonResponse(500, { error: 'missing' });
    }
    if (parsed.pathname === '/api/v1/me/devices') {
      return jsonResponse(200, [{ id: 'bad' }, { id: '10', device_uid: 'device-10' }]);
    }
    if (parsed.pathname === '/api/v1/me/devices/10/pairing_codes') {
      return jsonResponse(500, { error: 'nope' });
    }
    if (parsed.pathname === '/api/v1/me/friends') {
      return jsonResponse(200, { friends: [] });
    }
    if (parsed.pathname === '/api/v1/me/friend_requests/7/accept') {
      return jsonResponse(200, { id: 'bad' });
    }
    if (parsed.pathname === '/api/v1/me/friend_requests/8/decline') {
      return jsonResponse(409, { error: 'already_handled' });
    }
    if (parsed.pathname === '/api/v1/me/friend_requests/9/cancel') {
      return jsonResponse(200, {
        id: '9',
        status: 'canceled',
        friend: { id: '3', username: 'friend' },
      });
    }
    if (parsed.pathname === '/api/v1/me/cloud_messages' && init.method === 'GET') {
      return jsonResponse(200, { messages: [] });
    }
    if (parsed.pathname === '/api/v1/me/cloud_messages' && init.method === 'POST') {
      return jsonResponse(200, { sender: null });
    }
    if (parsed.pathname === '/api/v1/me/app_message_permission') {
      return jsonResponse(200, { sender: null });
    }
    if (parsed.pathname === '/api/v1/me/backups' && init.method === 'GET') {
      return jsonResponse(200, {
        backups: [
          { id: '20', app_id: 'finance-os', app_name: 'Finance OS', backup_type: 'sync_snapshot', source: 'auto_sync' },
          { id: 'bad', app_id: 'finance-os', app_name: 'Finance OS' },
        ],
        usage: { used_bytes: '100', limit_bytes: '1000', backup_count: '1', backup_count_limit: '5' },
      });
    }
    if (parsed.pathname === '/api/v1/me/backups' && init.method === 'POST') {
      return jsonResponse(422, { error: 'backup_count_limit_exceeded' });
    }
    if (parsed.pathname === '/api/v1/me/backups/20/download') {
      return new Response('archive-bytes', { status: 200, headers: { 'X-Forger-Backup-Sha256': 'abc' } });
    }
    if (parsed.pathname === '/api/v1/me/backups/20' && init.method === 'DELETE') {
      return jsonResponse(500, { error: 'busy' });
    }
    if (parsed.pathname === '/api/v1/app_versions/99/download') {
      return jsonResponse(200, { version: {} });
    }
    return jsonResponse(404, { error: 'not_found' });
  }, 'session-token');

  try {
    await assert.rejects(
      () => harness.client.getGmailOAuthClientId(),
      (error) => error.technicalCode === 'gmail_oauth_client_missing',
    );
    await assert.rejects(
      () => harness.client.getGoogleLoginOAuthClientId(),
      (error) => error.technicalCode === 'google_login_config_failed_500',
    );

    const devices = await harness.client.listDevices();
    assert.deepEqual(devices.map((device) => device.id), [10]);
    await assert.rejects(
      () => harness.client.createDevicePairingCode({ deviceId: 10, codeDigest: 'digest', expiresAt: '2026-05-21T00:00:00Z' }),
      (error) => error.technicalCode === 'pairing_code_failed_500',
    );
    assert.deepEqual(await harness.client.listFriends(), []);
    assert.deepEqual(await harness.client.listCloudMessages(3), []);
    await assert.rejects(() => harness.client.acceptFriendRequest(7), (error) => error.technicalCode === 'friend_request_accept_response_invalid');
    await assert.rejects(() => harness.client.declineFriendRequest(8), (error) => error.technicalCode === 'friend_request_decline_failed_409');
    assert.equal((await harness.client.cancelFriendRequest(9)).status, 'canceled');
    await assert.rejects(() => harness.client.sendCloudMessage({
      recipientUsername: 'friend',
      text: 'hello',
      envelopes: [{ ciphertext: 'ciphertext' }],
    }), (error) => error.technicalCode === 'cloud_message_response_invalid');
    await assert.rejects(() => harness.client.decideAppMessagePermission(20, 'deny'), (error) => error.technicalCode === 'app_message_permission_response_invalid');

    const backups = await harness.client.listRemoteBackups('finance-os');
    assert.equal(backups.backups.length, 1);
    assert.equal(backups.backups[0].backupType, 'sync_snapshot');
    assert.equal(backups.usage.backupCountLimit, 5);
    const created = await harness.client.createRemoteBackup({
      archivePath,
      localBackup: {
        backupId: 'local-1',
        appId: 'finance-os',
        appName: 'Finance OS',
        appVersion: '1.0.0',
        reason: 'manual',
        createdAt: '2026-05-21T00:00:00Z',
        fileCount: 1,
        totalBytes: 3,
        files: ['db.sqlite'],
      },
      backupType: 'backup',
      source: 'manual',
    });
    assert.equal(created.success, false);
    assert.equal(created.technicalCode, 'remote_backup_create_failed_422');
    assert.match(created.userMessage, /maximo/);

    const downloadPath = join(root, 'downloaded.zip');
    assert.deepEqual(await harness.client.downloadRemoteBackup(20, downloadPath), { checksumSha256: 'abc' });
    assert.equal((await harness.client.deleteRemoteBackup(20)).technicalCode, 'remote_backup_delete_failed_500');
    await assert.rejects(() => harness.client.requestDownload(99, { platform: 'darwin_arm64', deviceIdentifier: 'device' }), /download_payload_invalid/);
    assert.equal(requests.some((request) => new URL(request.url).searchParams.get('app_id') === 'finance-os'), true);
  } finally {
    harness.restore();
  }
});

test('cloud friendship and message normalizers reject malformed social relay payloads', () => {
  const friendship = normalizeFriendship({
    id: '9',
    status: 'accepted',
    requester_id: '1',
    addressee_id: '2',
    unread_count: '4',
    friend: {
      id: '2',
      username: 'friend',
      devices: [
        { id: '8', device_uid: 'device-8', public_key: 'key', online: true },
        { id: 'bad' },
      ],
    },
    created_at: '2026-05-20T00:00:00Z',
    updated_at: '2026-05-20T00:01:00Z',
  });
  assert.equal(friendship.id, 9);
  assert.equal(friendship.friend.devices.length, 1);
  assert.equal(friendship.unreadCount, 4);
  assert.equal(normalizeFriendship({ id: 1, friend: { id: 2 } }), undefined);

  const message = normalizeCloudMessage({
    id: '13',
    sender: { id: 1, username: 'sender' },
    recipient: { id: 2, username: 'recipient' },
    delivery_mode: 'ephemeral',
    source: 'app',
    source_app_id: 'finance-os',
    status: 'pending_permission',
    envelopes: [
      { id: '99', device_uid: 'device-2', ciphertext: 'ciphertext', metadata: { alg: 'test' } },
      { device_uid: 'device-3' },
    ],
    metadata: ['invalid'],
  });
  assert.equal(message.deliveryMode, 'ephemeral');
  assert.equal(message.source, 'app');
  assert.equal(message.status, 'pending_permission');
  assert.deepEqual(message.metadata, {});
  assert.equal(message.envelopes.length, 1);
  assert.equal(message.envelopes[0].id, 99);
  assert.equal(normalizeCloudDevice({ id: 'bad' }), undefined);
  assert.deepEqual(normalizeCloudDevice({ id: 5 }), {
    id: 5,
    deviceUid: '',
    name: 'Forger Desktop',
    platform: undefined,
    publicKey: undefined,
    keyFingerprint: undefined,
    paired: false,
    online: false,
    lastSeenAt: undefined,
    installedApps: [],
  });
  assert.equal(normalizeCloudMessage(null), undefined);
  assert.equal(normalizeCloudMessage({ sender: { id: 1, username: 'sender' } }), undefined);
  for (const status of ['delivered', 'not_delivered', 'blocked']) {
    assert.equal(normalizeCloudMessage({
      sender: { id: 1, username: 'sender' },
      recipient: { id: 2, username: 'recipient' },
      status,
      envelopes: [{ ciphertext: 'ciphertext', metadata: [] }],
    }).status, status);
  }
  assert.deepEqual(normalizeCloudMessage({
    sender: { id: 1, username: 'sender' },
    recipient: { id: 2, username: 'recipient' },
    envelopes: null,
  }).envelopes, []);
  const appShareMessage = normalizeCloudMessage({
    id: '44',
    type: 'CloudAppShareMessage',
    sender: { id: 1, username: 'sender' },
    recipient: { id: 2, username: 'recipient' },
    metadata: { ignored: true },
    app_share: {
      id: '55',
      user_app_id: '66',
      user_app_share_id: null,
      share_kind: 'public_app',
      app_visibility_at_send: 'public',
      app_name_snapshot: 'Shared App',
      app_slug_snapshot: 'shared-app',
      app_owner_username_snapshot: 'sender',
      app: {
        id: '66',
        status: 'published',
        visibility: 'public',
        available: true,
      },
      share: null,
    },
  });
  assert.equal(appShareMessage.type, 'CloudAppShareMessage');
  assert.equal(appShareMessage.appShare.userAppId, 66);
  assert.equal(appShareMessage.appShare.shareKind, 'public_app');
  assert.equal(appShareMessage.appShare.app.available, true);
  assert.equal(appShareMessage.appShare.share, undefined);
  assert.equal(normalizeCloudMessage({
    type: 'CloudAppShareMessage',
    sender: { id: 1, username: 'sender' },
    recipient: { id: 2, username: 'recipient' },
  }), undefined);
});

test('cloud social client methods encode requests and normalize response payloads', async () => {
  const requests = [];
  const harness = createClient(async (url, init) => {
    requests.push({ url, init });
    const parsed = new URL(url);
    if (parsed.pathname === '/api/v1/me/friends/search') {
      assert.equal(parsed.searchParams.get('username'), 'friend name');
      return jsonResponse(200, [{ id: '4', username: 'friend', display_name: 'Friend' }]);
    }
    if (parsed.pathname === '/api/v1/me/friend_requests') {
      return jsonResponse(201, {
        id: '7',
        status: 'pending',
        requester_id: '1',
        addressee_id: '4',
        friend: { id: '4', username: 'friend' },
        created_at: '2026-05-21T00:00:00Z',
        updated_at: '2026-05-21T00:00:00Z',
      });
    }
    if (parsed.pathname === '/api/v1/me/friends/4/read_receipt') {
      return jsonResponse(200, {
        id: '8',
        status: 'accepted',
        requester_id: '1',
        addressee_id: '4',
        unread_count: 0,
        friend: { id: '4', username: 'friend' },
        created_at: '2026-05-21T00:00:00Z',
        updated_at: '2026-05-21T00:01:00Z',
      });
    }
    if (parsed.pathname === '/api/v1/me/cloud_messages') {
      return jsonResponse(201, {
        id: '11',
        sender: { id: 1, username: 'me' },
        recipient: { id: 4, username: 'friend' },
        delivery_mode: 'persistent',
        source: 'app',
        source_app_id: 'finance-os',
        status: 'sent',
        envelopes: [
          { id: '22', device_uid: 'device-4', ciphertext: 'ciphertext', metadata: { alg: 'v1' } },
        ],
        metadata: { kind: 'handoff' },
      });
    }
    if (parsed.pathname === '/api/v1/me/cloud_messages/app_share') {
      return jsonResponse(201, {
        id: '12',
        type: 'CloudAppShareMessage',
        sender: { id: 1, username: 'me' },
        recipient: { id: 4, username: 'friend' },
        delivery_mode: 'persistent',
        source: 'user',
        status: 'stored',
        metadata: {},
        envelopes: [],
        app_share: {
          id: '13',
          user_app_id: '21',
          user_app_share_id: '34',
          share_kind: 'friends_link',
          app_visibility_at_send: 'friends',
          app_name_snapshot: 'Shared App',
          app_slug_snapshot: 'shared-app',
          app_owner_username_snapshot: 'me',
          app: {
            id: '21',
            status: 'published',
            visibility: 'friends',
            available: true,
          },
          share: {
            id: '34',
            scope: 'private_link',
            code: 'SHARE-CODE',
            deep_link: 'forger://social/app?code=SHARE-CODE',
            revoked_at: '2026-05-21T00:03:00Z',
            used_count: 2,
          },
        },
      });
    }
    if (parsed.pathname === '/api/v1/me/app_message_permission') {
      return jsonResponse(200, {
        id: '11',
        sender: { id: 1, username: 'me' },
        recipient: { id: 4, username: 'friend' },
        delivery_mode: 'persistent',
        source: 'app',
        status: 'approved',
        envelopes: [],
      });
    }
    return jsonResponse(404, { error: 'not_found' });
  }, 'session-token');

  try {
    const users = await harness.client.searchFriends('friend name');
    assert.deepEqual(users, [{ id: 4, username: 'friend', firstName: undefined, lastName: undefined, online: undefined, devices: [] }]);

    const friendship = await harness.client.sendFriendRequest('friend');
    assert.equal(friendship.id, 7);
    assert.equal(friendship.friend.username, 'friend');

    const read = await harness.client.markFriendChatRead(4);
    assert.equal(read.unreadCount, 0);

    const message = await harness.client.sendCloudMessage({
      recipientUsername: 'friend',
      delivery: 'persistent',
      source: 'app',
      sourceAppId: 'finance-os',
      sourceAppName: 'Finance OS',
      clientMessageId: 'client-1',
      envelopes: [{
        recipientUserId: 4,
        cloudDeviceId: 10,
        deviceUid: 'device-4',
        keyFingerprint: 'fingerprint',
        ciphertext: 'ciphertext',
        metadata: { alg: 'v1' },
      }],
    });
    assert.equal(message.id, 11);
    assert.equal(message.envelopes[0].cloudDeviceId, undefined);
    assert.equal(message.envelopes[0].deviceUid, 'device-4');

    const appShareMessage = await harness.client.sendCloudAppShareMessage({
      recipientUserId: 4,
      userAppId: 21,
      clientMessageId: 'share-client-1',
      envelopes: [{
        recipientUserId: 4,
        cloudDeviceId: 10,
        deviceUid: 'device-4',
        keyFingerprint: 'fingerprint',
        ciphertext: 'share-ciphertext',
        metadata: { alg: 'v1' },
      }],
    });
    assert.equal(appShareMessage.type, 'CloudAppShareMessage');
    assert.equal(appShareMessage.appShare.shareKind, 'friends_link');
    assert.equal(appShareMessage.appShare.share.revokedAt, '2026-05-21T00:03:00Z');

    const decision = await harness.client.decideAppMessagePermission(11, 'allow_once');
    assert.equal(decision.status, 'stored');

    assert.equal(requests.every((request) => request.init.headers.Authorization === 'Bearer session-token'), true);
    assert.deepEqual(JSON.parse(requests[1].init.body), { username: 'friend' });
    assert.deepEqual(JSON.parse(requests[3].init.body), {
      recipient_username: 'friend',
      delivery_mode: 'persistent',
      source: 'app',
      source_app_id: 'finance-os',
      source_app_name: 'Finance OS',
      client_message_id: 'client-1',
      envelopes: [{
        recipient_user_id: 4,
        cloud_device_id: 10,
        device_uid: 'device-4',
        key_fingerprint: 'fingerprint',
        ciphertext: 'ciphertext',
        metadata: { alg: 'v1' },
      }],
    });
    assert.deepEqual(JSON.parse(requests[4].init.body), {
      recipient_user_id: 4,
      user_app_id: 21,
      client_message_id: 'share-client-1',
      envelopes: [{
        recipient_user_id: 4,
        cloud_device_id: 10,
        device_uid: 'device-4',
        key_fingerprint: 'fingerprint',
        ciphertext: 'share-ciphertext',
        metadata: { alg: 'v1' },
      }],
    });
    assert.deepEqual(JSON.parse(requests[5].init.body), {
      cloud_message_id: 11,
      decision: 'allow_once',
    });
  } finally {
    harness.restore();
  }
});
