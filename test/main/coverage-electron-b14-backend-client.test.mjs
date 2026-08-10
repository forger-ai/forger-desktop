import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ForgerBackendClient } = require('../../dist-electron/main/forger-backend-client.js');

const response = (body, status = 200, headers = {}) => new Response(
  body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  { status, headers: { 'content-type': 'application/json', ...headers } },
);

const cloudUser = (overrides = {}) => ({ id: 1, username: 'ana', ...overrides });
const cloudDevice = (overrides = {}) => ({ id: 7, device_uid: 'uid-7', name: 'Desktop', ...overrides });
const pairingRequest = (overrides = {}) => ({
  id: 21,
  mobile_device_id: 91,
  desktop_device_id: 7,
  status: 'pending',
  expires_at: '2026-08-10T12:00:00.000Z',
  mobile_device: cloudDevice({ id: 91, device_kind: 'mobile' }),
  desktop_device: cloudDevice(),
  ...overrides,
});
const delivery = (overrides = {}) => ({
  id: 41,
  sender: cloudUser(),
  recipient: cloudUser({ id: 2, username: 'bob' }),
  target_user_id: 2,
  target_cloud_device_id: 8,
  client_message_id: 'message-1',
  ciphertext: 'ciphertext',
  status: 'pending',
  ...overrides,
});
const socialApp = (overrides = {}) => ({
  id: 51,
  slug: 'notes',
  name: 'Notes',
  owner: cloudUser(),
  ...overrides,
});
const forumPost = (overrides = {}) => ({ id: 61, body: 'Hello', author: cloudUser(), ...overrides });

const createClient = (overrides = {}) => new ForgerBackendClient({
  backendBaseUrl: 'https://platform.test',
  token: () => 'token',
  localCatalogJsonUrl: () => undefined,
  mapBackendCategory: (value) => value,
  toCatalogStatus: () => 'not_installed',
  getUserMessage: () => undefined,
  platform: () => 'darwin_arm64',
  desktopVersion: () => '0.5.test',
  reportingLogPath: () => undefined,
  ...overrides,
});

test('given pairing and delivery endpoints, valid payloads normalize and malformed responses fail closed', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const client = createClient();
  let next = response({});
  globalThis.fetch = async () => next;

  assert.equal(client.socialProfileUrl(' @ana '), 'https://platform.test/social/@ana');

  next = response([pairingRequest(), {}]);
  assert.equal((await client.listMobilePairingRequests()).length, 1);
  next = response({});
  assert.deepEqual(await client.listMobilePairingRequests(), []);
  next = response({}, 401);
  await assert.rejects(client.listMobilePairingRequests(), /Forger Cloud session/);

  next = response(pairingRequest({ status: 'accepted' }));
  assert.equal((await client.acceptMobilePairingRequest(21)).status, 'accepted');
  next = response({});
  await assert.rejects(client.acceptMobilePairingRequest(21), /response was invalid/);
  next = response({}, 403);
  await assert.rejects(client.acceptMobilePairingRequest(21), /session is no longer valid/);

  next = response(pairingRequest({ status: 'rejected' }));
  assert.equal((await client.rejectMobilePairingRequest(21)).status, 'rejected');
  next = response({});
  await assert.rejects(client.rejectMobilePairingRequest(21), /response was invalid/);
  next = response({}, 500);
  await assert.rejects(client.rejectMobilePairingRequest(21), /session is no longer valid/);

  next = response({}, 500);
  await assert.rejects(client.deleteMobilePairingRequest(21), /session is no longer valid/);
  await assert.rejects(client.revokeMobileDesktopAuthorization(1), /session is no longer valid/);

  next = response([delivery(), {}]);
  assert.equal((await client.listCloudMessageDeliveries(7)).length, 1);
  next = response({});
  assert.deepEqual(await client.listCloudMessageDeliveries(7), []);

  next = response({ deliveries: [delivery(), {}] });
  assert.equal((await client.sendCloudMessageDeliveries({
    recipientUsername: 'bob',
    deliveries: [{ targetUserId: 2, cloudDeviceId: 8, deviceUid: 'uid', keyFingerprint: 'key', ciphertext: 'cipher' }],
  })).length, 1);
  next = response(null);
  assert.deepEqual(await client.sendCloudMessageDeliveries({ deliveries: [] }), []);
  next = response({ deliveries: [delivery({ app_share: { kind: 'published_app', app: socialApp() } })] });
  assert.equal((await client.sendCloudAppShareDeliveries({ userAppId: 51, deliveries: [] })).length, 1);
  next = response({});
  assert.deepEqual(await client.sendCloudAppShareDeliveries({ userAppId: 51, deliveries: [] }), []);
  next = response({ success: true });
  await client.ackCloudMessageDeliveries(7, [41]);
  assert.equal(client.normalizeCloudMessageDeliveryPayload(delivery()).id, 41);
});

test('given account, device, forum, and Social errors, backend diagnostics stay actionable', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const client = createClient();
  let next = response({});
  globalThis.fetch = async () => next;

  next = response({}, 500);
  await assert.rejects(client.getAppleLoginOAuthConfig(), /Apple login/);
  next = response({ client_id: ' ' });
  await assert.rejects(client.getAppleLoginOAuthConfig(), /Apple login/);
  next = response({}, 401);
  assert.equal((await client.createAppleLoginSession({ clientId: 'apple', code: 'code', nonce: 'nonce', redirectUri: 'uri' })).success, false);

  next = response({}, 500);
  await assert.rejects(client.updateDeviceName({ deviceId: 7, name: 'Desk' }), /session is no longer valid/);
  next = response({});
  await assert.rejects(client.updateDeviceName({ deviceId: 7, name: 'Desk' }), /response was invalid/);

  next = response(forumPost());
  assert.equal((await client.deleteForumPost(61)).id, 61);
  next = response(null);
  await assert.rejects(client.deleteForumPost(61), /No pudimos borrar/);

  next = response({ usage: { app_count: 1, app_count_limit: 3, version_size_limit_bytes: 100 }, apps: [socialApp(), {}] });
  assert.equal((await client.listMySocialApps()).apps.length, 1);
  next = response({});
  assert.deepEqual((await client.listMySocialApps()).apps, []);

  next = response({ id: 71, code: 'share', scope: 'friends', expires_at: 'later', max_uses: 2, deep_link: 'forger://share' });
  assert.equal((await client.createSocialAppShare(51)).scope, 'friends');
  next = response({ id: 72 });
  assert.equal((await client.createSocialAppShare(51)).scope, 'private_link');

  next = response({ app: socialApp(), share: { id: 1 } });
  assert.equal((await client.resolveSocialCode('code')).app.id, 51);
  next = response({ app: socialApp(), share: 'invalid' });
  assert.equal((await client.resolveSocialCode('code')).share, undefined);
  next = response({ app: null });
  await assert.rejects(client.resolveSocialCode('bad'), /No pudimos abrir/);

  next = response({}, 401);
  await assert.rejects(client.getSocialProfile('ana'), /session is no longer valid/);
  next = response({}, 500);
  await assert.rejects(client.getSocialProfile('ana'), /No pudimos abrir/);
  next = response({});
  await assert.rejects(client.getSocialProfile('ana'), /No pudimos abrir/);
  await assert.rejects(client.getSocialProfile('  '), /No pudimos abrir/);

  next = response({}, 500);
  const genericRating = await client.submitAppRating({ appId: 'notes', rating: 3 });
  assert.equal(genericRating.technicalCode, 'rating_failed_500');
  next = response({}, 500);
  const socialRating = await client.submitAppRating({ appId: 'notes', socialUserAppId: 51, rating: 3 });
  assert.equal(socialRating.technicalCode, 'social_app_review_failed_500');
});

test('given Social upload boundary failures, each stage reports the failing operation', async (t) => {
  const originalFetch = globalThis.fetch;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forger-b14-upload-'));
  const zipPath = path.join(root, 'app.zip');
  await fs.writeFile(zipPath, Buffer.from('zip'));
  t.after(async () => {
    globalThis.fetch = originalFetch;
    await fs.rm(root, { recursive: true, force: true });
  });
  const client = createClient();
  const input = {
    zipPath,
    visibility: 'private',
    name: 'Notes',
    slug: 'notes',
    description: 'Notes',
    onProgress: () => undefined,
  };

  globalThis.fetch = async () => response({ direct_upload: { url: '' }, signed_blob_id: '' });
  await assert.rejects(client.uploadSocialApp(input), /no preparo la subida directa/);

  let request = 0;
  globalThis.fetch = async () => {
    request += 1;
    return request === 1
      ? response({ direct_upload: { url: 'https://storage.test', headers: {} }, signed_blob_id: 'blob' })
      : response({}, 500);
  };
  await assert.rejects(client.uploadSocialApp(input), /subir el archivo/);

  for (const payload of [
    'bad response',
    { user_message: 'Visible failure', technical_code: 'visible_failure' },
    { userMessage: 'Camel failure', error: 'camel_failure' },
    {},
  ]) {
    request = 0;
    globalThis.fetch = async () => {
      request += 1;
      if (request === 1) return response({ direct_upload: { url: 'https://storage.test' }, signed_blob_id: 'blob' });
      if (request === 2) return response(undefined, 200);
      return response(payload, 422);
    };
    await assert.rejects(client.uploadSocialApp(input));
  }

  request = 0;
  globalThis.fetch = async () => {
    request += 1;
    if (request === 1) return response({ direct_upload: { url: 'https://storage.test' }, signed_blob_id: 'blob' });
    if (request === 2) return response(undefined, 200);
    return response({ upload_attempt: {} });
  };
  await assert.rejects(client.uploadSocialApp(input), /no preparo el analisis/);

  for (const [payload, status] of [
    ['bad response', 500],
    [{ error: 'direct_error' }, 500],
  ]) {
    globalThis.fetch = async () => response(payload, status);
    await assert.rejects(client.createSocialAppDirectUpload({ filename: 'a.zip' }));
  }
  globalThis.fetch = async () => response('invalid');
  assert.deepEqual(await client.createSocialAppDirectUpload({ filename: 'a.zip' }), {});
  globalThis.fetch = async () => response({});
  await assert.rejects(client.getSocialAppUploadAttempt(1), /estado de subida invalido/);

  request = 0;
  globalThis.fetch = async () => {
    request += 1;
    if (request === 1) return response({ direct_upload: { url: 'https://storage.test' }, signed_blob_id: 'blob' });
    if (request === 2) return response(undefined, 200);
    return response('invalid');
  };
  await assert.rejects(client.uploadSocialApp(input), /no preparo el analisis/);

  globalThis.fetch = async () => response({}, 500);
  await assert.rejects(client.createSocialAppDirectUpload({ filename: 'a.zip' }));
});

test('given malformed optional payloads, remaining client fallbacks preserve stable public shapes', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const client = createClient();
  let next = response({});
  globalThis.fetch = async () => next;

  next = response(1);
  assert.deepEqual(await client.listForumPosts(), []);
  next = response({ items: [forumPost(), null] });
  assert.equal((await client.listForumPosts()).length, 1);
  next = response([forumPost()]);
  assert.equal((await client.listForumPosts()).length, 1);
  next = response({ items: 'invalid' });
  assert.deepEqual(await client.listForumPosts(), []);

  next = response(null);
  const participation = await client.getForumParticipation();
  assert.equal(participation.status, 'opted_out');
  next = response({
    status: 'suspended',
    opted_out_at: 'out',
    suspended_at: 'suspended',
    suspension_reason: 'reason',
  });
  assert.equal((await client.updateForumParticipation('opt_out')).suspensionReason, 'reason');

  const fullComment = {
    id: undefined,
    forum_post_id: undefined,
    parent_id: 1,
    depth: undefined,
    status: 'deleted',
    author: null,
    hidden_reason: 'hidden',
    deleted_at: 'deleted',
    created_at: undefined,
    updated_at: 'updated',
    edited_at: 'edited',
    replies: undefined,
  };
  next = response(forumPost({
    id: undefined,
    author: cloudUser({ display_name: 'Ana' }),
    status: 'hidden',
    hidden_at: 'hidden',
    hidden_reason: 'reason',
    deleted_at: 'deleted',
    edited_at: 'edited',
    comments: [fullComment, null],
  }));
  const post = await client.getForumPost(61);
  assert.equal(post.comments[0].author.username, '');

  for (const [method, args] of [
    ['getForumPost', [1]],
    ['createForumPost', ['body']],
    ['createForumComment', [1, 'body']],
    ['replyForumComment', [1, 'body']],
    ['deleteForumComment', [1]],
    ['moderateForumPost', [1, 'hide', 'reason']],
    ['moderateForumComment', [1, 'hide', 'reason']],
  ]) {
    next = response(null);
    await assert.rejects(client[method](...args));
  }

  next = response({}, 500);
  await assert.rejects(client.listMobileDesktopAuthorizations());
  next = response({});
  assert.deepEqual(await client.listMobileDesktopAuthorizations(), []);
  next = response(null);
  assert.deepEqual(await client.createRemoteTunnelSession({ deviceId: 7, appId: 'app' }), {});
  next = response(null);
  assert.deepEqual(await client.uploadRemoteTunnelFrontend({
    sessionId: 'session', frontendHash: 'hash', tunnelUrl: 'https://tunnel', desktopPublicKeyJwk: {},
    assets: [{ path: '', type: 'text/plain', data: Buffer.from('asset') }],
  }), {});
  next = response({});
  assert.deepEqual(await client.listFriends(), []);
  next = response([{
    id: 1,
    status: 'accepted',
    requester_id: 1,
    addressee_id: 2,
    friend: cloudUser({ id: 2 }),
  }, null]);
  assert.equal((await client.listFriends()).length, 1);
  next = response({});
  assert.deepEqual(await client.listCloudMessages(1), []);
  next = response([{
    id: 1,
    sender: cloudUser(),
    recipient: cloudUser({ id: 2 }),
    delivery_mode: 'persistent',
    source: 'user',
    status: 'sent',
    client_message_id: 'message',
    envelopes: [],
  }, null]);
  assert.equal((await client.listCloudMessages(1)).length, 1);
  next = response({});
  await assert.rejects(client.sendCloudAppShareMessage({ userAppId: 51, envelopes: [] }));

  next = response({ deliveries: [delivery()] });
  assert.equal((await client.sendCloudAppShareDeliveries({
    userAppId: 51,
    deliveries: [{ targetUserId: 2, cloudDeviceId: 8, deviceUid: 'uid', keyFingerprint: 'key', ciphertext: 'cipher' }],
  })).length, 1);

  next = response({});
  await assert.rejects(client.updateSocialApp({ id: 51, visibility: 'private' }));
  next = response({ success: false });
  await assert.rejects(client.deleteSocialApp(51));
  next = response({});
  await assert.rejects(client.resolveSocialApp(51));

  next = response({});
  await assert.rejects(client.requestSocialAppDownload({ appSlug: 'notes' }), /descarga Social invalida/);
  next = response({
    download_url: 'https://download.test/app.zip',
    version: { id: 1 },
    app: null,
    install: null,
  });
  const download = await client.requestSocialAppDownload({ appSlug: undefined });
  assert.equal(download.app.slug, '');
  assert.equal(download.install.source, 'profile');

  next = response({}, 422);
  assert.equal((await client.updateAccountProfile({ username: 'taken' })).technicalCode, 'profile_update_failed_422');
  next = response({ user: cloudUser(), token: 'new-token' });
  assert.equal((await client.updateAccountProfile({ displayName: 'Ana' })).userMessage, 'Perfil actualizado.');

  next = response(null);
  await assert.rejects(client.getAppleLoginOAuthConfig());
  next = response({ client_id: 'apple' });
  assert.equal((await client.getAppleLoginOAuthConfig()).redirectUri, undefined);

  next = response({ backups: 'invalid' });
  assert.deepEqual((await client.listRemoteBackups()).backups, []);
});

test('given upload polling transitions, progress, fallback failures, and timeout are deterministic', async (t) => {
  const client = createClient();
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback) => {
    callback();
    return { fake: true };
  };
  t.after(() => { globalThis.setTimeout = originalSetTimeout; });
  const progress = [];
  let attempts = [
    { id: 1, status: 'uploaded' },
    { id: 1, status: 'analyzing' },
    { id: 1, status: 'published', app: socialApp() },
  ];
  client.getSocialAppUploadAttempt = async () => attempts.shift();
  assert.equal((await client.pollSocialAppUploadAttempt(1, async (message) => progress.push(message))).id, 51);
  assert.deepEqual(progress, ['Analizando app', 'Analizando app', 'App publicada']);

  client.getSocialAppUploadAttempt = async () => ({ id: 2, status: 'failed' });
  await assert.rejects(client.pollSocialAppUploadAttempt(2), /No pudimos analizar/);

  const originalDateNow = Date.now;
  let nowCalls = 0;
  Date.now = () => (nowCalls += 1) === 1 ? 0 : nowCalls === 2 ? 1 : 1_000_000;
  client.getSocialAppUploadAttempt = async () => ({ id: 3, status: 'pending_upload' });
  try {
    await assert.rejects(client.pollSocialAppUploadAttempt(3), /sigue pendiente/);
  } finally {
    Date.now = originalDateNow;
  }
});

test('given missing optional environment reporters, feedback network failures use safe defaults', async (t) => {
  const originalFetch = globalThis.fetch;
  const client = createClient({ platform: undefined, desktopVersion: undefined });
  globalThis.fetch = async () => { throw 'offline'; };
  t.after(() => { globalThis.fetch = originalFetch; });
  const result = await client.submitProductFeedback({ target: 'desktop', kind: 'problem', message: 'Help' });
  assert.equal(result.technicalCode, 'feedback_network_failed');
  const usage = await client.submitUsageEvent({ eventName: 'opened', installationIdentifier: 'install' });
  assert.equal(usage.success, false);
});
