import assert from 'node:assert/strict';
import test from 'node:test';

const {
  toSocialProfile,
  toSocialUserApp,
  toSocialUserAppUploadAttempt,
  toSocialUserProfileDetail,
  toSocialVersion,
} = await import('../../dist-electron/main/forger-backend/social-normalizers.js');

test('social normalizers preserve a complete valid payload and normalize legacy aliases', () => {
  const profile = toSocialProfile({
    id: '7',
    username: 'ada',
    display_name: 'Ada',
    first_name: 'Ada',
    last_initial: 'L',
    social_bio: 'Builder',
  });
  assert.deepEqual(profile, {
    id: 7,
    username: 'ada',
    displayName: 'Ada',
    firstName: 'Ada',
    lastInitial: 'L',
    socialBio: 'Builder',
  });

  const version = toSocialVersion({
    id: '8',
    version: '1.2.3',
    runtime_stack: 'vite',
    supported_platforms: ['darwin', 42],
    capabilities: ['files', 7],
    platform_capabilities: { darwin: ['files'] },
    tools: { alpha: true },
    agents: [{ id: 'agent' }],
    prompt_templates: [{ id: 'prompt' }],
    checksum_sha256: 'sha',
    file_size_bytes: '10',
    zip_entry_count: '11',
    expanded_size_bytes: '12',
    published_at: 'now',
  });
  assert.deepEqual(version, {
    id: 8,
    version: '1.2.3',
    runtimeStack: 'vite',
    supportedPlatforms: ['darwin', '42'],
    capabilities: ['files', '7'],
    platformCapabilities: { darwin: ['files'] },
    tools: { alpha: true },
    agents: [{ id: 'agent' }],
    promptTemplates: [{ id: 'prompt' }],
    checksumSha256: 'sha',
    fileSizeBytes: 10,
    zipEntryCount: 11,
    expandedSizeBytes: 12,
    publishedAt: 'now',
  });
  assert.deepEqual(toSocialVersion({ platformCapabilities: { win32: true } }).platformCapabilities, { win32: true });

  const app = toSocialUserApp({
    id: '9',
    slug: 'notes',
    name: 'Notes',
    short_description: 'Short',
    description: 'Description',
    long_description: 'Long',
    category: 'productivity',
    visibility: 'friends',
    status: 'suspended',
    access_reason: 'direct_share',
    owner: { id: '7', username: 'ada' },
    remixed: true,
    remix_source: { id: '3', slug: 'base', name: 'Base', owner_username: 'grace' },
    average_review_score: 4.5,
    reviews_count: '2',
    comments_count: '3',
    latest_version: { id: 8, version: '1.2.3' },
    upload_status: 'analyzing',
    active_upload_attempt: { id: 12, status: 'uploaded', slug: 'attempt' },
    created_at: 'created',
    updated_at: 'updated',
  });
  assert.equal(app.id, 9);
  assert.equal(app.longDescription, 'Long');
  assert.equal(app.visibility, 'friends');
  assert.equal(app.status, 'suspended');
  assert.equal(app.accessReason, 'direct_share');
  assert.deepEqual(app.remixSource, { id: 3, slug: 'base', name: 'Base', ownerUsername: 'grace' });
  assert.equal(app.latestVersion.version, '1.2.3');
  assert.equal(app.activeUploadAttempt.status, 'uploaded');
});

test('social app normalization rejects malformed envelopes and applies safe defaults', () => {
  for (const value of [null, false, 'app']) assert.equal(toSocialUserApp(value), undefined);
  assert.equal(toSocialUserApp({ id: 1 }), undefined);
  assert.equal(toSocialUserApp({ id: 'not-a-number', owner: {} }), undefined);

  const fallback = toSocialUserApp({ id: 1, owner: {}, description: 'Fallback', remix_source: { id: 2, ownerUsername: 'camel' } });
  assert.deepEqual(fallback, {
    id: 1,
    slug: '',
    name: '',
    shortDescription: undefined,
    description: 'Fallback',
    longDescription: 'Fallback',
    category: undefined,
    visibility: 'restricted',
    status: 'published',
    accessReason: undefined,
    owner: { id: Number.NaN, username: '', displayName: undefined, firstName: undefined, lastInitial: undefined, socialBio: undefined },
    remixed: false,
    remixSource: { id: 2, slug: '', name: '', ownerUsername: 'camel' },
    averageReviewScore: undefined,
    reviewsCount: 0,
    commentsCount: 0,
    latestVersion: undefined,
    uploadStatus: undefined,
    activeUploadAttempt: undefined,
    createdAt: undefined,
    updatedAt: undefined,
  });
  assert.equal(toSocialUserApp({ id: 1, owner: {}, long_description: 3, description: 4 }).longDescription, undefined);
  assert.equal(toSocialUserApp({ id: 1, owner: {}, remix_source: null }).remixSource, undefined);
  assert.equal(toSocialUserApp({ id: 1, owner: {}, remix_source: { id: 'bad' } }).remixSource, undefined);
  assert.equal(toSocialUserApp({ id: 1, owner: {}, remix_source: { id: 2 } }).remixSource.ownerUsername, '');

  for (const visibility of ['public', 'private']) {
    assert.equal(toSocialUserApp({ id: 1, owner: {}, visibility }).visibility, visibility);
  }
  assert.equal(toSocialUserApp({ id: 1, owner: {}, status: 'deleted' }).status, 'deleted');
  for (const accessReason of ['public', 'friends']) {
    assert.equal(toSocialUserApp({ id: 1, owner: {}, access_reason: accessReason }).accessReason, accessReason);
  }
});

test('social profile details keep only valid applications', () => {
  for (const value of [null, 'profile', [], {}]) assert.equal(toSocialUserProfileDetail(value), undefined);
  assert.equal(toSocialUserProfileDetail({ profile: 'bad' }), undefined);
  assert.equal(toSocialUserProfileDetail({ profile: { id: 'bad' } }), undefined);
  assert.deepEqual(toSocialUserProfileDetail({ profile: { id: 1 }, apps: 'bad' }), {
    profile: { id: 1, username: '', displayName: undefined, firstName: undefined, lastInitial: undefined, socialBio: undefined },
    apps: [],
  });
  const detail = toSocialUserProfileDetail({
    profile: { id: 1, username: 'owner' },
    apps: [null, { id: 2, owner: { id: 1, username: 'owner' } }],
  });
  assert.equal(detail.apps.length, 1);
  assert.equal(detail.apps[0].id, 2);
});

test('upload attempts validate status and normalize every optional field', () => {
  for (const value of [null, 'attempt', {}, { id: 'bad', status: 'uploaded' }, { id: 1, status: 'bad' }]) {
    assert.equal(toSocialUserAppUploadAttempt(value), undefined);
  }
  for (const status of ['pending_upload', 'analyzing', 'failed', 'published']) {
    assert.equal(toSocialUserAppUploadAttempt({ id: 1, status }).status, status);
  }
  const attempt = toSocialUserAppUploadAttempt({
    id: '4',
    user_app_id: '5',
    slug: 'upload',
    status: 'uploaded',
    error_code: 'none',
    checksum_sha256: 'sha',
    byte_size: '6',
    zip_entry_count: '7',
    expanded_size_bytes: '8',
    manifest_digest: 'digest',
    published_version: '1.0.0',
    analysis_started_at: 'start',
    analysis_finished_at: 'finish',
    published_at: 'published',
    created_at: 'created',
    updated_at: 'updated',
    app: { id: 5, owner: {} },
  });
  assert.deepEqual({ ...attempt, app: undefined }, {
    id: 4,
    userAppId: 5,
    slug: 'upload',
    status: 'uploaded',
    errorCode: 'none',
    checksumSha256: 'sha',
    byteSize: 6,
    zipEntryCount: 7,
    expandedSizeBytes: 8,
    manifestDigest: 'digest',
    publishedVersion: '1.0.0',
    analysisStartedAt: 'start',
    analysisFinishedAt: 'finish',
    publishedAt: 'published',
    createdAt: 'created',
    updatedAt: 'updated',
    app: undefined,
  });
  assert.equal(attempt.app.id, 5);
});

test('upload attempts use undefined for malformed optional values', () => {
  const attempt = toSocialUserAppUploadAttempt({
    id: 1,
    status: 'uploaded',
    user_app_id: 'bad',
    slug: 1,
    error_code: 1,
    checksum_sha256: 1,
    byte_size: 'bad',
    zip_entry_count: 'bad',
    expanded_size_bytes: 'bad',
    manifest_digest: 1,
    published_version: 1,
    analysis_started_at: 1,
    analysis_finished_at: 1,
    published_at: 1,
    created_at: 1,
    updated_at: 1,
    app: 'bad',
  });
  assert.deepEqual(attempt, {
    id: 1,
    userAppId: undefined,
    slug: '',
    status: 'uploaded',
    errorCode: undefined,
    checksumSha256: undefined,
    byteSize: undefined,
    zipEntryCount: undefined,
    expandedSizeBytes: undefined,
    manifestDigest: undefined,
    publishedVersion: undefined,
    analysisStartedAt: undefined,
    analysisFinishedAt: undefined,
    publishedAt: undefined,
    createdAt: undefined,
    updatedAt: undefined,
    app: undefined,
  });
});
