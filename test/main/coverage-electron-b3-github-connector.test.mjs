import assert from 'node:assert/strict';
import test from 'node:test';

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const selfOAuth = require('../../dist-electron/main/tools/self-oauth.js');
const githubDeviceOAuth = require('../../dist-electron/main/tools/self-oauth/github-device.js');
const {
  GITHUB_TOOL_ID,
  githubToolModule,
} = require('../../dist-electron/main/connections/modules/github/index.js');

const jsonResponse = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { 'content-type': 'application/json' },
});

const createContext = (initialSecrets = {}) => {
  const secrets = new Map(Object.entries(initialSecrets));
  const calls = [];
  return {
    calls,
    secrets,
    context: {
      metadataRoot: '/tmp/forger-github-coverage',
      secretsStore: {
        getToolSecret: async (toolId, key) => {
          calls.push(['get', toolId, key]);
          return secrets.get(key);
        },
        hasToolSecret: async (toolId, key) => {
          calls.push(['has', toolId, key]);
          return secrets.has(key);
        },
        setToolSecret: async (toolId, key, value) => {
          calls.push(['set', toolId, key, value]);
          secrets.set(key, value);
          return { success: true, userMessage: 'saved' };
        },
      },
    },
  };
};

const execute = async (context, actionId, input) => await githubToolModule.execute({ actionId, input }, context);

const withFetchQueue = async (responses, callback) => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, init = {}) => {
    requests.push({ url: String(url), init });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    if (next?.throwValue !== undefined) throw next.throwValue;
    return next;
  };
  try {
    return await callback(requests);
  } finally {
    globalThis.fetch = originalFetch;
  }
};

test('GitHub configuration validates client identity and supports direct token or device-flow setup', async () => {
  const missing = createContext();
  assert.equal((await githubToolModule.configure(missing.context)).technicalCode, 'github_oauth_client_id_required');

  const direct = createContext();
  assert.deepEqual(await githubToolModule.configure(direct.context, {
    secrets: {
      [selfOAuth.OAUTH_CLIENT_ID_SECRET]: ' client-id ',
      [selfOAuth.OAUTH_ACCESS_TOKEN_SECRET]: ' direct-token ',
    },
  }), { success: true, userMessage: 'GitHub connected.' });
  assert.equal(direct.secrets.get(selfOAuth.OAUTH_CLIENT_ID_SECRET), 'client-id');
  assert.equal(direct.secrets.get(selfOAuth.OAUTH_ACCESS_TOKEN_SECRET), 'direct-token');

  const device = createContext({ [selfOAuth.OAUTH_CLIENT_ID_SECRET]: 'stored-client' });
  const originalDeviceFlow = githubDeviceOAuth.runGitHubDeviceOAuthFlow;
  const deviceCalls = [];
  githubDeviceOAuth.runGitHubDeviceOAuthFlow = async (context, options) => {
    deviceCalls.push([context, options]);
  };
  try {
    assert.deepEqual(await githubToolModule.configure(device.context, { secrets: {} }), {
      success: true,
      userMessage: 'GitHub connected.',
    });
  } finally {
    githubDeviceOAuth.runGitHubDeviceOAuthFlow = originalDeviceFlow;
  }
  assert.deepEqual(deviceCalls, [[device.context, {
    toolId: GITHUB_TOOL_ID,
    clientId: 'stored-client',
    scopes: ['repo', 'read:user', 'user:email'],
  }]]);
});

test('GitHub status and read actions normalize identities, limits, filters, and malformed API payloads', async () => {
  const disconnected = createContext();
  assert.deepEqual(await execute(disconnected.context, 'github.connection.status'), {
    success: true,
    data: { connected: false },
  });

  const connected = createContext({ [selfOAuth.OAUTH_ACCESS_TOKEN_SECRET]: 'token' });
  await withFetchQueue([
    jsonResponse({ id: 42, login: ' octocat ', name: 'Ignored' }),
    jsonResponse({ id: null, login: ' ', name: ' Mona ' }),
    jsonResponse([]),
    jsonResponse([{ id: 1 }]),
    jsonResponse({ repositories: 'malformed' }),
    jsonResponse({ items: [{ id: 2 }] }),
    jsonResponse({ items: 'malformed' }),
    jsonResponse([]),
    jsonResponse({ id: 3, title: 'Issue' }),
  ], async (requests) => {
    assert.deepEqual((await execute(connected.context, 'github.connection.status')).data, {
      connected: true,
      subject: '42',
      username: 'octocat',
    });
    assert.deepEqual((await execute(connected.context, 'github.connection.status')).data, {
      connected: true,
      subject: '',
      username: 'Mona',
    });
    assert.deepEqual((await execute(connected.context, 'github.connection.status')).data, {
      connected: true,
      subject: undefined,
      username: undefined,
    });

    assert.deepEqual((await execute(connected.context, 'github.list_repositories', {
      visibility: 'private', limit: 999,
    })).data.repositories, [{ id: 1 }]);
    assert.deepEqual((await execute(connected.context, 'github.list_repositories', {
      visibility: 'internal', limit: -5,
    })).data.repositories, []);
    assert.equal(requests[3].url, 'https://api.github.com/user/repos?per_page=100&sort=updated&visibility=private');
    assert.equal(requests[4].url, 'https://api.github.com/user/repos?per_page=1&sort=updated');

    assert.equal((await execute(connected.context, 'github.search_issues', {})).technicalCode, 'github_query_required');
    assert.deepEqual((await execute(connected.context, 'github.search_issues', {
      query: ' is:issue label:bug ', limit: Number.NaN,
    })).data.items, [{ id: 2 }]);
    assert.deepEqual((await execute(connected.context, 'github.search_issues', {
      query: 'is:pr', limit: 3.6,
    })).data.items, []);
    assert.deepEqual((await execute(connected.context, 'github.search_issues', {
      query: 'is:open', limit: 10,
    })).data.items, []);

    assert.equal((await execute(connected.context, 'github.get_issue', {})).technicalCode, 'github_owner_required');
    assert.equal((await execute(connected.context, 'github.get_issue', { owner: 'owner' })).technicalCode, 'github_repo_required');
    assert.equal((await execute(connected.context, 'github.get_issue', { owner: 'owner', repo: 'repo', number: 0 })).technicalCode, 'github_number_required');
    assert.deepEqual((await execute(connected.context, 'github.get_issue', {
      owner: 'owner/name', repo: 'repo name', number: 2.6,
    })).data, { id: 3, title: 'Issue' });
    assert.equal(requests.at(-1).url, 'https://api.github.com/repos/owner%2Fname/repo%20name/issues/3');
  });
});

test('GitHub mutations enforce required fields, sanitized labels, JSON headers, and safe defaults', async () => {
  const harness = createContext({ [selfOAuth.OAUTH_ACCESS_TOKEN_SECRET]: 'token' });
  await withFetchQueue([
    jsonResponse({ id: 10 }),
    jsonResponse({ id: 11 }),
    jsonResponse({ id: 12 }),
    jsonResponse({ id: 13 }),
  ], async (requests) => {
    assert.equal((await execute(harness.context, 'github.create_issue', {})).technicalCode, 'github_owner_required');
    assert.equal((await execute(harness.context, 'github.create_issue', { owner: 'o' })).technicalCode, 'github_repo_required');
    assert.equal((await execute(harness.context, 'github.create_issue', { owner: 'o', repo: 'r' })).technicalCode, 'github_title_required');

    assert.equal((await execute(harness.context, 'github.create_issue', {
      owner: 'o', repo: 'r', title: ' Title ', body: null, labels: [' bug ', '', 42],
    })).success, true);
    assert.deepEqual(JSON.parse(requests[0].init.body), { title: 'Title', body: '', labels: ['bug'] });
    assert.equal(new Headers(requests[0].init.headers).get('content-type'), 'application/json; charset=utf-8');

    assert.equal((await execute(harness.context, 'github.create_issue', {
      owner: 'o', repo: 'r', title: 'No labels', labels: [],
    })).success, true);
    assert.deepEqual(JSON.parse(requests[1].init.body), { title: 'No labels', body: '' });
    assert.equal((await execute(harness.context, 'github.create_issue', {
      owner: 'o', repo: 'r', title: 'Non-array labels', labels: 'bug',
    })).success, true);

    assert.equal((await execute(harness.context, 'github.create_comment', {})).technicalCode, 'github_owner_required');
    assert.equal((await execute(harness.context, 'github.create_comment', { owner: 'o' })).technicalCode, 'github_repo_required');
    assert.equal((await execute(harness.context, 'github.create_comment', { owner: 'o', repo: 'r' })).technicalCode, 'github_number_required');
    assert.equal((await execute(harness.context, 'github.create_comment', { owner: 'o', repo: 'r', number: 1 })).technicalCode, 'github_body_required');
    assert.equal((await execute(harness.context, 'github.create_comment', {
      owner: 'o', repo: 'r', number: 1, body: ' Comment ',
    })).success, true);
    assert.deepEqual(JSON.parse(requests[3].init.body), { body: 'Comment' });

    assert.equal((await execute(harness.context, 'github.unknown', [])).technicalCode, 'github_action_unknown');
  });
});

test('GitHub actions convert OAuth, HTTP, JSON, Error, and non-Error failures into stable results', async () => {
  const missingToken = createContext();
  const oauth = await execute(missingToken.context, 'github.list_repositories');
  assert.equal(oauth.technicalCode, 'github_oauth_not_connected');
  assert.equal(oauth.userMessage, 'GitHub is not connected.');

  const harness = createContext({ [selfOAuth.OAUTH_ACCESS_TOKEN_SECRET]: 'token' });
  await withFetchQueue([
    jsonResponse({ message: ' Access denied ' }, 403),
    jsonResponse({ message: ' ' }, 429),
    new Response(null, { status: 204 }),
    jsonResponse([], 500),
    new Response('not-json', { status: 200 }),
    { throwValue: 'raw-network-failure' },
    new Error('network_unavailable'),
  ], async (requests) => {
    const denied = await execute(harness.context, 'github.list_repositories');
    assert.deepEqual(denied, { success: false, userMessage: 'Access denied', technicalCode: 'github_http_403' });

    const emptyMessage = await execute(harness.context, 'github.list_repositories');
    assert.deepEqual(emptyMessage, {
      success: false,
      userMessage: 'Could not complete the GitHub action.',
      technicalCode: 'github_http_429',
    });

    assert.deepEqual((await execute(harness.context, 'github.list_repositories')).data.repositories, []);
    assert.deepEqual(await execute(harness.context, 'github.list_repositories'), {
      success: false,
      userMessage: 'github_http_500',
      technicalCode: 'github_http_500',
    });
    assert.deepEqual((await execute(harness.context, 'github.list_repositories')).data.repositories, []);
    assert.equal((await execute(harness.context, 'github.list_repositories')).technicalCode, 'github_action_failed');
    assert.equal((await execute(harness.context, 'github.list_repositories')).technicalCode, 'network_unavailable');

    const headers = new Headers(requests[0].init.headers);
    assert.equal(headers.get('authorization'), 'Bearer token');
    assert.equal(headers.get('accept'), 'application/vnd.github+json');
    assert.equal(headers.get('x-github-api-version'), '2022-11-28');
  });
});
