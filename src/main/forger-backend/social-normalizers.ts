import type { SocialUserApp, SocialUserAppAccessReason, SocialUserAppUploadAttempt, SocialUserAppUploadAttemptStatus, SocialUserProfile, SocialUserProfileDetail } from '../../shared/types';

export const toSocialProfile = (record: Record<string, unknown>): SocialUserProfile => ({
  id: Number(record.id),
  username: typeof record.username === 'string' ? record.username : '',
  firstName: typeof record.first_name === 'string' ? record.first_name : undefined,
  lastInitial: typeof record.last_initial === 'string' ? record.last_initial : undefined,
  socialBio: typeof record.social_bio === 'string' ? record.social_bio : undefined,
});

export const toSocialVersion = (record: Record<string, unknown>) => ({
  id: Number(record.id),
  version: typeof record.version === 'string' ? record.version : '',
  runtimeStack: typeof record.runtime_stack === 'string' ? record.runtime_stack : '',
  supportedPlatforms: Array.isArray(record.supported_platforms) ? record.supported_platforms.map(String) : [],
  capabilities: Array.isArray(record.capabilities) ? record.capabilities.map(String) : [],
  tools: typeof record.tools === 'object' && record.tools !== null ? record.tools as Record<string, unknown> : undefined,
  agents: Array.isArray(record.agents) ? record.agents : undefined,
  promptTemplates: Array.isArray(record.prompt_templates) ? record.prompt_templates : undefined,
  checksumSha256: typeof record.checksum_sha256 === 'string' ? record.checksum_sha256 : '',
  fileSizeBytes: Number(record.file_size_bytes ?? 0),
  zipEntryCount: Number(record.zip_entry_count ?? 0),
  expandedSizeBytes: Number(record.expanded_size_bytes ?? 0),
  publishedAt: typeof record.published_at === 'string' ? record.published_at : undefined,
});

export const toSocialUserApp = (record: unknown): SocialUserApp | undefined => {
  if (!record || typeof record !== 'object') {
    return undefined;
  }
  const item = record as Record<string, unknown>;
  const owner = item.owner && typeof item.owner === 'object'
    ? toSocialProfile(item.owner as Record<string, unknown>)
    : undefined;
  if (!owner || !Number.isFinite(Number(item.id))) {
    return undefined;
  }
  const latest = item.latest_version && typeof item.latest_version === 'object'
    ? toSocialVersion(item.latest_version as Record<string, unknown>)
    : undefined;
  const activeUploadAttempt = item.active_upload_attempt && typeof item.active_upload_attempt === 'object'
    ? toSocialUserAppUploadAttempt(item.active_upload_attempt as Record<string, unknown>)
    : undefined;
  return {
    id: Number(item.id),
    slug: typeof item.slug === 'string' ? item.slug : '',
    name: typeof item.name === 'string' ? item.name : '',
    shortDescription: typeof item.short_description === 'string' ? item.short_description : undefined,
    description: typeof item.description === 'string' ? item.description : undefined,
    category: typeof item.category === 'string' ? item.category : undefined,
    visibility: item.visibility === 'public' || item.visibility === 'friends' || item.visibility === 'private' ? item.visibility : 'restricted',
    status: item.status === 'suspended' || item.status === 'deleted' ? item.status : 'published',
    accessReason: socialAccessReason(item.access_reason),
    owner,
    remixed: item.remixed === true,
    remixSource: toRemixSource(item.remix_source),
    averageReviewScore: typeof item.average_review_score === 'number' ? item.average_review_score : undefined,
    reviewsCount: Number(item.reviews_count ?? 0),
    commentsCount: Number(item.comments_count ?? 0),
    latestVersion: latest,
    uploadStatus: socialUploadAttemptStatus(item.upload_status),
    activeUploadAttempt,
    createdAt: typeof item.created_at === 'string' ? item.created_at : undefined,
    updatedAt: typeof item.updated_at === 'string' ? item.updated_at : undefined,
  };
};

const toRemixSource = (value: unknown): SocialUserApp['remixSource'] | undefined => {
  if (!value || typeof value !== 'object') return undefined;
  const source = value as Record<string, unknown>;
  const id = Number(source.id);
  if (!Number.isFinite(id)) return undefined;
  return {
    id,
    slug: typeof source.slug === 'string' ? source.slug : '',
    name: typeof source.name === 'string' ? source.name : '',
    ownerUsername: typeof source.owner_username === 'string'
      ? source.owner_username
      : typeof source.ownerUsername === 'string'
        ? source.ownerUsername
        : '',
  };
};

const socialAccessReason = (value: unknown): SocialUserAppAccessReason | undefined => {
  if (value === 'public' || value === 'friends' || value === 'direct_share') {
    return value;
  }
  return undefined;
};

export const toSocialUserProfileDetail = (payload: unknown): SocialUserProfileDetail | undefined => {
  if (!payload || typeof payload !== 'object') {
    return undefined;
  }
  const source = payload as Record<string, unknown>;
  const profileSource = source.profile && typeof source.profile === 'object'
    ? source.profile as Record<string, unknown>
    : undefined;
  if (!profileSource || !Number.isFinite(Number(profileSource.id))) {
    return undefined;
  }
  return {
    profile: toSocialProfile(profileSource),
    apps: Array.isArray(source.apps) ? source.apps.map(toSocialUserApp).filter(Boolean) as SocialUserApp[] : [],
  };
};

const socialUploadAttemptStatus = (value: unknown): SocialUserAppUploadAttemptStatus | undefined => {
  if (
    value === 'pending_upload' ||
    value === 'uploaded' ||
    value === 'analyzing' ||
    value === 'failed' ||
    value === 'published'
  ) {
    return value;
  }
  return undefined;
};

export const toSocialUserAppUploadAttempt = (record: unknown): SocialUserAppUploadAttempt | undefined => {
  if (!record || typeof record !== 'object') {
    return undefined;
  }
  const item = record as Record<string, unknown>;
  const status = socialUploadAttemptStatus(item.status);
  const id = Number(item.id);
  if (!Number.isFinite(id) || !status) {
    return undefined;
  }
  const app = item.app && typeof item.app === 'object' ? toSocialUserApp(item.app) : undefined;
  return {
    id,
    userAppId: Number.isFinite(Number(item.user_app_id)) ? Number(item.user_app_id) : undefined,
    slug: typeof item.slug === 'string' ? item.slug : '',
    status,
    errorCode: typeof item.error_code === 'string' ? item.error_code : undefined,
    checksumSha256: typeof item.checksum_sha256 === 'string' ? item.checksum_sha256 : undefined,
    byteSize: Number.isFinite(Number(item.byte_size)) ? Number(item.byte_size) : undefined,
    zipEntryCount: Number.isFinite(Number(item.zip_entry_count)) ? Number(item.zip_entry_count) : undefined,
    expandedSizeBytes: Number.isFinite(Number(item.expanded_size_bytes)) ? Number(item.expanded_size_bytes) : undefined,
    manifestDigest: typeof item.manifest_digest === 'string' ? item.manifest_digest : undefined,
    publishedVersion: typeof item.published_version === 'string' ? item.published_version : undefined,
    analysisStartedAt: typeof item.analysis_started_at === 'string' ? item.analysis_started_at : undefined,
    analysisFinishedAt: typeof item.analysis_finished_at === 'string' ? item.analysis_finished_at : undefined,
    publishedAt: typeof item.published_at === 'string' ? item.published_at : undefined,
    createdAt: typeof item.created_at === 'string' ? item.created_at : undefined,
    updatedAt: typeof item.updated_at === 'string' ? item.updated_at : undefined,
    app,
  };
};
