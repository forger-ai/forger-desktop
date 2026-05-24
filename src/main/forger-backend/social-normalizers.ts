import type { SocialUserApp } from '../../shared/types';

export const toSocialProfile = (record: Record<string, unknown>) => ({
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
  return {
    id: Number(item.id),
    slug: typeof item.slug === 'string' ? item.slug : '',
    name: typeof item.name === 'string' ? item.name : '',
    shortDescription: typeof item.short_description === 'string' ? item.short_description : undefined,
    description: typeof item.description === 'string' ? item.description : undefined,
    category: typeof item.category === 'string' ? item.category : undefined,
    visibility: item.visibility === 'public' || item.visibility === 'friends' || item.visibility === 'private' ? item.visibility : 'restricted',
    status: item.status === 'suspended' || item.status === 'deleted' ? item.status : 'published',
    owner,
    averageReviewScore: typeof item.average_review_score === 'number' ? item.average_review_score : undefined,
    reviewsCount: Number(item.reviews_count ?? 0),
    commentsCount: Number(item.comments_count ?? 0),
    latestVersion: latest,
    createdAt: typeof item.created_at === 'string' ? item.created_at : undefined,
    updatedAt: typeof item.updated_at === 'string' ? item.updated_at : undefined,
  };
};
