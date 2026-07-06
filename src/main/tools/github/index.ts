import type {
  CallOfficialToolInput,
  CallOfficialToolResult,
  ConfigureOfficialToolInput,
  OfficialToolDefinition,
  ToolMutationResult,
} from '../../../shared/types';
import type { InternalToolContext, InternalToolModule } from '../types';
import {
  OAuthConnectionError,
  OAUTH_ACCESS_TOKEN_SECRET,
  OAUTH_CLIENT_ID_SECRET,
  runGitHubDeviceOAuthFlow,
} from '../self-oauth';

export const GITHUB_TOOL_ID = 'github';

const GITHUB_API_BASE = 'https://api.github.com';
const GITHUB_SCOPES = ['repo', 'read:user', 'user:email'];

const cleanString = (value: unknown): string =>
  typeof value === 'string' ? value.trim() : '';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const clampLimit = (value: unknown, fallback: number, max: number): number => {
  const numeric = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback;
  return Math.min(max, Math.max(1, numeric));
};

class GitHubApiError extends Error {
  constructor(public readonly technicalCode: string, message?: string) {
    super(message ?? technicalCode);
    this.name = 'GitHubApiError';
  }
}

const definition: OfficialToolDefinition = {
  id: GITHUB_TOOL_ID,
  name: 'GitHub',
  description: 'Reads repositories and manages issues through a self-managed GitHub OAuth app using device flow.',
  version: '0.1.0',
  runtime: 'builtin',
  official: true,
  secrets: [
    {
      name: OAUTH_CLIENT_ID_SECRET,
      label: 'OAuth client ID',
      required: true,
      usage: 'Client ID from your GitHub OAuth app with Device Flow enabled. Stored locally on this device.',
      manual: true,
    },
  ],
  actions: [
    {
      id: 'github.connection.status',
      name: 'Connection status',
      description: 'Checks whether GitHub is connected.',
      risk: 'low',
    },
    {
      id: 'github.list_repositories',
      name: 'List repositories',
      description: 'Lists repositories visible to the connected GitHub account.',
      risk: 'low',
      inputSchema: {
        type: 'object',
        properties: {
          visibility: { type: 'string', description: 'all, public, or private.' },
          limit: { type: 'number' },
        },
      },
    },
    {
      id: 'github.search_issues',
      name: 'Search issues and pull requests',
      description: 'Searches GitHub issues and pull requests.',
      risk: 'medium',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          limit: { type: 'number' },
        },
        required: ['query'],
      },
    },
    {
      id: 'github.get_issue',
      name: 'Get issue or pull request',
      description: 'Gets one GitHub issue or pull request by repository and number.',
      risk: 'medium',
      inputSchema: {
        type: 'object',
        properties: {
          owner: { type: 'string' },
          repo: { type: 'string' },
          number: { type: 'number' },
        },
        required: ['owner', 'repo', 'number'],
      },
    },
    {
      id: 'github.create_issue',
      name: 'Create issue',
      description: 'Creates a GitHub issue.',
      risk: 'high',
      inputSchema: {
        type: 'object',
        properties: {
          owner: { type: 'string' },
          repo: { type: 'string' },
          title: { type: 'string' },
          body: { type: 'string' },
          labels: { type: 'array', items: { type: 'string' } },
        },
        required: ['owner', 'repo', 'title'],
      },
    },
    {
      id: 'github.create_comment',
      name: 'Create comment',
      description: 'Creates a comment on a GitHub issue or pull request.',
      risk: 'high',
      inputSchema: {
        type: 'object',
        properties: {
          owner: { type: 'string' },
          repo: { type: 'string' },
          number: { type: 'number' },
          body: { type: 'string' },
        },
        required: ['owner', 'repo', 'number', 'body'],
      },
    },
  ],
  changelog: ['Self-managed GitHub OAuth device-flow connector.'],
};

const getAccessToken = async (context: InternalToolContext): Promise<string> => {
  const accessToken = await context.secretsStore.getToolSecret(GITHUB_TOOL_ID, OAUTH_ACCESS_TOKEN_SECRET);
  if (!accessToken) {
    throw new OAuthConnectionError('GitHub is not connected.', 'github_oauth_not_connected');
  }
  return accessToken;
};

const githubFetch = async (
  context: InternalToolContext,
  path: string,
  init: RequestInit = {},
): Promise<unknown> => {
  const token = await getAccessToken(context);
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${token}`);
  headers.set('Accept', 'application/vnd.github+json');
  headers.set('X-GitHub-Api-Version', '2022-11-28');
  if (init.body && !headers.has('content-type')) {
    headers.set('content-type', 'application/json; charset=utf-8');
  }
  const response = await fetch(`${GITHUB_API_BASE}${path}`, { ...init, headers });
  const data = response.status === 204 ? {} : await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new GitHubApiError(`github_http_${response.status}`, isRecord(data) ? cleanString(data.message) : undefined);
  }
  return data;
};

const configure = async (
  context: InternalToolContext,
  input?: ConfigureOfficialToolInput,
): Promise<ToolMutationResult> => {
  const clientId = cleanString(input?.secrets?.[OAUTH_CLIENT_ID_SECRET])
    || cleanString(await context.secretsStore.getToolSecret(GITHUB_TOOL_ID, OAUTH_CLIENT_ID_SECRET));
  const providedAccessToken = cleanString(input?.secrets?.[OAUTH_ACCESS_TOKEN_SECRET]);
  if (!clientId) {
    return {
      success: false,
      userMessage: 'GitHub needs an OAuth client ID from your GitHub OAuth app.',
      technicalCode: 'github_oauth_client_id_required',
    };
  }
  if (providedAccessToken) {
    await context.secretsStore.setToolSecret(GITHUB_TOOL_ID, OAUTH_CLIENT_ID_SECRET, clientId);
    await context.secretsStore.setToolSecret(GITHUB_TOOL_ID, OAUTH_ACCESS_TOKEN_SECRET, providedAccessToken);
    return { success: true, userMessage: 'GitHub connected.' };
  }
  await runGitHubDeviceOAuthFlow(context, {
    toolId: GITHUB_TOOL_ID,
    clientId,
    scopes: GITHUB_SCOPES,
  });
  return { success: true, userMessage: 'GitHub connected.' };
};

const requiredString = (
  input: Record<string, unknown>,
  key: string,
  code: string,
): string | CallOfficialToolResult => {
  const value = cleanString(input[key]);
  return value || { success: false, userMessage: `Missing ${key}.`, technicalCode: code };
};

const requiredNumber = (
  input: Record<string, unknown>,
  key: string,
  code: string,
): number | CallOfficialToolResult => {
  const value = typeof input[key] === 'number' && Number.isFinite(input[key]) ? Math.round(input[key] as number) : 0;
  return value > 0 ? value : { success: false, userMessage: `Missing ${key}.`, technicalCode: code };
};

const toResult = (error: unknown): CallOfficialToolResult => {
  if (error instanceof OAuthConnectionError) {
    return { success: false, userMessage: error.message, technicalCode: error.technicalCode };
  }
  if (error instanceof GitHubApiError) {
    return {
      success: false,
      userMessage: error.message || 'Could not complete the GitHub action.',
      technicalCode: error.technicalCode,
    };
  }
  return {
    success: false,
    userMessage: 'Could not complete the GitHub action.',
    technicalCode: error instanceof Error ? error.message : 'github_action_failed',
  };
};

export const githubToolModule: InternalToolModule = {
  definition,
  configure,
  execute: async (input: CallOfficialToolInput, context: InternalToolContext): Promise<CallOfficialToolResult> => {
    try {
      const actionInput = input.input && typeof input.input === 'object' && !Array.isArray(input.input)
        ? input.input as Record<string, unknown>
        : {};
      if (input.actionId === 'github.connection.status') {
        const hasToken = await context.secretsStore.hasToolSecret(GITHUB_TOOL_ID, OAUTH_ACCESS_TOKEN_SECRET);
        if (!hasToken) {
          return { success: true, data: { connected: false } };
        }
        const user = await githubFetch(context, '/user');
        return {
          success: true,
          data: {
            connected: true,
            subject: isRecord(user) ? String(user.id ?? '') : undefined,
            username: isRecord(user) ? cleanString(user.login) || cleanString(user.name) : undefined,
          },
        };
      }
      if (input.actionId === 'github.list_repositories') {
        const url = new URL(`${GITHUB_API_BASE}/user/repos`);
        url.searchParams.set('per_page', String(clampLimit(actionInput.limit, 50, 100)));
        url.searchParams.set('sort', 'updated');
        const visibility = cleanString(actionInput.visibility);
        if (['all', 'public', 'private'].includes(visibility)) {
          url.searchParams.set('visibility', visibility);
        }
        const data = await githubFetch(context, `${url.pathname}${url.search}`);
        return { success: true, data: { repositories: Array.isArray(data) ? data : [] } };
      }
      if (input.actionId === 'github.search_issues') {
        const query = requiredString(actionInput, 'query', 'github_query_required');
        if (typeof query !== 'string') return query;
        const url = new URL(`${GITHUB_API_BASE}/search/issues`);
        url.searchParams.set('q', query);
        url.searchParams.set('per_page', String(clampLimit(actionInput.limit, 20, 100)));
        const data = await githubFetch(context, `${url.pathname}${url.search}`);
        return { success: true, data: { items: isRecord(data) && Array.isArray(data.items) ? data.items : [] } };
      }
      if (input.actionId === 'github.get_issue') {
        const owner = requiredString(actionInput, 'owner', 'github_owner_required');
        const repo = requiredString(actionInput, 'repo', 'github_repo_required');
        const number = requiredNumber(actionInput, 'number', 'github_number_required');
        if (typeof owner !== 'string') return owner;
        if (typeof repo !== 'string') return repo;
        if (typeof number !== 'number') return number;
        const data = await githubFetch(context, `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${number}`);
        return { success: true, data };
      }
      if (input.actionId === 'github.create_issue') {
        const owner = requiredString(actionInput, 'owner', 'github_owner_required');
        const repo = requiredString(actionInput, 'repo', 'github_repo_required');
        const title = requiredString(actionInput, 'title', 'github_title_required');
        if (typeof owner !== 'string') return owner;
        if (typeof repo !== 'string') return repo;
        if (typeof title !== 'string') return title;
        const labels = Array.isArray(actionInput.labels)
          ? actionInput.labels.map(cleanString).filter(Boolean)
          : undefined;
        const data = await githubFetch(context, `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues`, {
          method: 'POST',
          body: JSON.stringify({
            title,
            body: cleanString(actionInput.body),
            ...(labels?.length ? { labels } : {}),
          }),
        });
        return { success: true, userMessage: 'GitHub issue created.', data };
      }
      if (input.actionId === 'github.create_comment') {
        const owner = requiredString(actionInput, 'owner', 'github_owner_required');
        const repo = requiredString(actionInput, 'repo', 'github_repo_required');
        const number = requiredNumber(actionInput, 'number', 'github_number_required');
        const body = requiredString(actionInput, 'body', 'github_body_required');
        if (typeof owner !== 'string') return owner;
        if (typeof repo !== 'string') return repo;
        if (typeof number !== 'number') return number;
        if (typeof body !== 'string') return body;
        const data = await githubFetch(context, `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${number}/comments`, {
          method: 'POST',
          body: JSON.stringify({ body }),
        });
        return { success: true, userMessage: 'GitHub comment created.', data };
      }
      return { success: false, userMessage: 'GitHub action is not available.', technicalCode: 'github_action_unknown' };
    } catch (error) {
      return toResult(error);
    }
  },
};
