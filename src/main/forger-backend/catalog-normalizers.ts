import { normalizeAppCapabilities } from '../../shared/capabilities';
import { normalizeAgentRuntime } from '../../shared/agent-runtime-registry';
import type {
  AppAgent,
  AppAgentPromptSet,
  AppAgentPromptTemplate,
  AppAgentPromptVariable,
  AppAgentPromptVariableType,
  AppCategory,
  AppPromptTemplate,
  AppRatingSummary,
  AppStatus,
  AppToolDeclaration,
  CatalogApp,
  CatalogPublicationStatus,
  CodexReasoningEffort,
} from '../../shared/types';

const CODEX_REASONING_VALUES = new Set<CodexReasoningEffort>(['none', 'low', 'medium', 'high', 'xhigh']);

export interface PublicCatalogResponseItem {
  slug: string;
  name: string;
  short_description?: string | null;
  description?: string | null;
  category: string;
  icon_url?: string | null;
  status?: string | null;
  agents?: unknown;
  prompt_templates?: unknown;
  promptTemplates?: unknown;
  tools?: unknown;
  latest_version?: CatalogVersionPayload;
}

export interface CatalogResponseItem extends PublicCatalogResponseItem {
  short_description: string | null;
  description: string | null;
  average_rating?: number | string | null;
  ratings_count?: number | string | null;
  recent_ratings?: unknown[];
  current_user_rating?: unknown;
  latest_version?: CatalogVersionPayload & { id: number };
}

export interface CatalogVersionPayload {
  version?: string;
  required_python_version?: string | null;
  required_node_version?: string | null;
  checksum_sha256?: string | null;
  download_url?: string | null;
  changelog?: unknown;
  capabilities?: unknown;
  permissions?: unknown;
  localNetworkShare?: unknown;
  local_network_share?: unknown;
  remoteTunnel?: unknown;
  remote_tunnel?: unknown;
  agents?: unknown;
  prompt_templates?: unknown;
  promptTemplates?: unknown;
  tools?: unknown;
}

export interface CatalogNormalizerOptions {
  backendBaseUrl: string;
  mapBackendCategory: (backendCategory: string) => AppCategory;
  toCatalogStatus: (slug: string) => AppStatus;
  getUserMessage: (slug: string) => string | undefined;
}

export const mapCatalogItem = (
  appEntry: CatalogResponseItem | PublicCatalogResponseItem,
  includeDirectDownloadUrl: boolean,
  options: CatalogNormalizerOptions,
): CatalogApp => {
  const latestVersion = appEntry.latest_version;
  const backendEntry = appEntry as CatalogResponseItem;
  const catalogStatus = normalizeCatalogPublicationStatus(appEntry.status);
  const recentRatings = Array.isArray(backendEntry.recent_ratings)
    ? backendEntry.recent_ratings.map((rating) => normalizeRating(rating)).filter((rating): rating is AppRatingSummary => Boolean(rating))
    : [];

  return {
    id: appEntry.slug,
    category: options.mapBackendCategory(appEntry.category),
    status: options.toCatalogStatus(appEntry.slug),
    name: appEntry.name,
    description: appEntry.short_description ?? appEntry.description ?? '',
    iconUrl: absoluteBackendUrl(appEntry.icon_url, options.backendBaseUrl),
    catalogStatus,
    beta: catalogStatus === 'beta',
    latestVersionId: 'id' in (latestVersion ?? {}) ? (latestVersion as CatalogResponseItem['latest_version'])?.id : undefined,
    latestVersion: latestVersion?.version,
    requiredPythonVersion: latestVersion?.required_python_version ?? undefined,
    requiredNodeVersion: latestVersion?.required_node_version ?? undefined,
    checksumSha256: latestVersion?.checksum_sha256 ?? undefined,
    downloadUrl: includeDirectDownloadUrl ? latestVersion?.download_url ?? undefined : undefined,
    changelog: normalizeChangelog(latestVersion?.changelog, latestVersion?.version),
    capabilities: normalizeAppCapabilities(latestVersion?.capabilities ?? latestVersion?.permissions),
    localNetworkShareSupported: latestVersion?.localNetworkShare === true
      || latestVersion?.local_network_share === true,
    remoteTunnelSupported: latestVersion?.remoteTunnel === true
      || latestVersion?.remote_tunnel === true,
    tools: normalizeCatalogTools(latestVersion?.tools ?? appEntry.tools),
    agents: normalizeCatalogAgents(latestVersion?.agents ?? appEntry.agents),
    promptTemplates: normalizeCatalogPromptTemplates(
      latestVersion?.prompt_templates
        ?? latestVersion?.promptTemplates
        ?? appEntry.prompt_templates
        ?? appEntry.promptTemplates,
    ),
    version: latestVersion?.version,
    userMessage: options.getUserMessage(appEntry.slug),
    averageRating: normalizeNumber(backendEntry.average_rating),
    ratingsCount: normalizeNumber(backendEntry.ratings_count),
    recentRatings,
    currentUserRating: normalizeRating(backendEntry.current_user_rating),
  };
};

export const normalizeRating = (value: unknown): AppRatingSummary | undefined => {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const id = normalizeNumber(record.id);
  const score = normalizeNumber(record.score);
  if (id === undefined || score === undefined) {
    return undefined;
  }
  const user = record.user && typeof record.user === 'object' ? record.user as Record<string, unknown> : undefined;
  return {
    id,
    score,
    comment: typeof record.comment === 'string' ? record.comment : null,
    forgerResponse: typeof record.forger_response === 'string' ? record.forger_response : null,
    createdAt: typeof record.created_at === 'string' ? record.created_at : undefined,
    updatedAt: typeof record.updated_at === 'string' ? record.updated_at : undefined,
    user: user
      ? {
          firstName: typeof user.first_name === 'string' ? user.first_name : undefined,
          lastInitial: typeof user.last_initial === 'string' ? user.last_initial : null,
        }
      : undefined,
  };
};

const normalizeCatalogTools = (value: unknown): CatalogApp['tools'] | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const normalizeList = (items: unknown): AppToolDeclaration[] =>
    Array.isArray(items)
      ? items.flatMap((item) => {
          if (!item || typeof item !== 'object' || Array.isArray(item)) {
            return [];
          }
          const candidate = item as Record<string, unknown>;
          const toolId = typeof candidate.toolId === 'string' ? candidate.toolId.trim() : '';
          const actions = Array.isArray(candidate.actions)
            ? candidate.actions.filter((action): action is string => typeof action === 'string' && action.trim().length > 0)
            : [];
          if (!toolId || actions.length === 0) {
            return [];
          }
          const reason =
            typeof candidate.reason === 'string' && candidate.reason.trim()
              ? candidate.reason.trim()
              : undefined;
          if (!reason) {
            return [];
          }
          return [{ toolId, actions, reason }];
        })
      : [];
  const required = normalizeList(record.required);
  const optional = normalizeList(record.optional);
  return required.length > 0 || optional.length > 0 ? { required, optional } : undefined;
};

const normalizeCatalogAgents = (value: unknown): AppAgent[] | undefined => {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const agents = value.flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return [];
    }
    const candidate = item as Record<string, unknown>;
    const id = typeof candidate.id === 'string' ? candidate.id.trim() : '';
    const title = typeof candidate.title === 'string' ? candidate.title.trim() : '';
    const prompts = normalizeCatalogAgentPrompts(candidate.prompts);
    const initialPrompt =
      typeof candidate.initialPrompt === 'string' && candidate.initialPrompt.trim()
        ? candidate.initialPrompt.trim()
        : prompts?.initial?.body ?? '';
    if (!id || !title || (!initialPrompt && !prompts?.initial)) {
      return [];
    }
    const description =
      typeof candidate.description === 'string' && candidate.description.trim()
        ? candidate.description.trim()
        : undefined;
    const model = typeof candidate.model === 'string' && candidate.model.trim() ? candidate.model.trim() : undefined;
    const reasoningEffort = normalizeReasoningEffort(candidate.reasoningEffort);
    const runtime = normalizeAgentRuntime(candidate.runtime ?? candidate, {
      model,
      reasoningEffort,
      provider: candidate.provider,
      effort: candidate.effort,
    });
    const runtimeRecommendations = normalizeCatalogRuntimeRecommendations(candidate.runtimeRecommendations);
    const kind = normalizeCatalogAgentKind(candidate.kind);
    const initialPromptTemplate =
      typeof candidate.initialPromptTemplate === 'string' && candidate.initialPromptTemplate.trim()
        ? candidate.initialPromptTemplate.trim()
        : undefined;
    return [{
      id,
      title,
      initialPrompt,
      ...(description ? { description } : {}),
      ...(kind ? { kind } : {}),
      ...(initialPromptTemplate ? { initialPromptTemplate } : {}),
      ...(prompts ? { prompts } : {}),
      ...(model ? { model } : {}),
      ...(reasoningEffort ? { reasoningEffort } : {}),
      ...(runtime ? { runtime } : {}),
      ...(runtimeRecommendations ? { runtimeRecommendations } : {}),
    }];
  });
  return agents.length > 0 ? agents : undefined;
};

const normalizeCatalogPromptTemplates = (value: unknown): AppPromptTemplate[] | undefined => {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const templates = value.flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return [];
    }
    const candidate = item as Record<string, unknown>;
    const id = typeof candidate.id === 'string' ? candidate.id.trim() : '';
    const title = typeof candidate.title === 'string' ? candidate.title.trim() : '';
    const prompt = typeof candidate.prompt === 'string' ? candidate.prompt.trim() : '';
    if (!id || !title || !prompt) {
      return [];
    }
    const description =
      typeof candidate.description === 'string' && candidate.description.trim()
        ? candidate.description.trim()
        : undefined;
    const model = typeof candidate.model === 'string' && candidate.model.trim() ? candidate.model.trim() : undefined;
    const reasoningEffort = normalizeReasoningEffort(candidate.reasoningEffort);
    const runtime = normalizeAgentRuntime(candidate.runtime ?? candidate, {
      model,
      reasoningEffort,
      provider: candidate.provider,
      effort: candidate.effort,
    });
    const runtimeRecommendations = normalizeCatalogRuntimeRecommendations(candidate.runtimeRecommendations);
    return [{
      id,
      title,
      prompt,
      ...(description ? { description } : {}),
      ...(model ? { model } : {}),
      ...(reasoningEffort ? { reasoningEffort } : {}),
      ...(runtime ? { runtime } : {}),
      ...(runtimeRecommendations ? { runtimeRecommendations } : {}),
    }];
  });
  return templates.length > 0 ? templates : undefined;
};

const normalizeCatalogRuntimeRecommendations = (value: unknown) =>
  value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;

const normalizeReasoningEffort = (value: unknown): CodexReasoningEffort | undefined =>
  CODEX_REASONING_VALUES.has(value as CodexReasoningEffort) ? value as CodexReasoningEffort : undefined;

const normalizeCatalogAgentKind = (value: unknown): AppAgent['kind'] =>
  value === 'classic' || value === 'thread_interface' || value === 'orchestrator' || value === 'agent_invocation'
    ? value
    : undefined;

const normalizeCatalogAgentPrompts = (value: unknown): AppAgentPromptSet | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  const output: AppAgentPromptSet = {};
  for (const key of ['initial', 'resume', 'steer'] as const) {
    const template = normalizeCatalogAgentPromptTemplate(raw[key]);
    if (template) {
      output[key] = template;
    }
  }
  return Object.keys(output).length > 0 ? output : undefined;
};

const normalizeCatalogAgentPromptTemplate = (value: unknown): AppAgentPromptTemplate | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  const body = typeof raw.body === 'string' ? raw.body.trim() : '';
  if (!body) {
    return undefined;
  }
  const variables = normalizeCatalogAgentPromptVariables(raw.variables);
  return {
    body,
    ...(Object.keys(variables).length > 0 ? { variables } : {}),
  };
};

const normalizeCatalogAgentPromptVariables = (value: unknown): Record<string, AppAgentPromptVariable> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  const output: Record<string, AppAgentPromptVariable> = {};
  for (const [name, rawDeclaration] of Object.entries(value as Record<string, unknown>)) {
    if (!/^[a-zA-Z0-9_.-]+$/.test(name) || !rawDeclaration || typeof rawDeclaration !== 'object' || Array.isArray(rawDeclaration)) {
      continue;
    }
    const declaration = rawDeclaration as Record<string, unknown>;
    if (!isCatalogAgentPromptVariableType(declaration.type)) {
      continue;
    }
    output[name] = {
      type: declaration.type,
      ...(typeof declaration.required === 'boolean' ? { required: declaration.required } : {}),
    };
  }
  return output;
};

const isCatalogAgentPromptVariableType = (value: unknown): value is AppAgentPromptVariableType =>
  value === 'text' || value === 'string' || value === 'json' || value === 'path';

const normalizeCatalogPublicationStatus = (value: unknown): CatalogPublicationStatus | undefined =>
  value === 'draft' || value === 'coming' || value === 'beta' || value === 'production' ? value : undefined;

const absoluteBackendUrl = (value: string | null | undefined, backendBaseUrl: string): string | undefined => {
  if (!value) {
    return undefined;
  }
  try {
    return new URL(value, backendBaseUrl).toString();
  } catch {
    return undefined;
  }
};

const normalizeNumber = (value: unknown): number | undefined => {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
};

const normalizeChangelog = (value: unknown, version?: string): CatalogApp['changelog'] => {
  if (!value || typeof value !== 'object' || !version) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const changes = Array.isArray(record.changes) ? record.changes.filter((entry): entry is string => typeof entry === 'string') : [];
  return {
    version,
    summary: typeof record.summary === 'string' ? record.summary : undefined,
    changes,
  };
};
