import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { gitlabToolModule } = require('../../dist-electron/main/connections/modules/token-service-connectors/gitlab.js');

const createContext = (baseUrl = 'https://gitlab.example.com/api/v4///') => ({
  metadataRoot: '/tmp/forger-gitlab-b8',
  secretsStore: {
    getToolSecret: async (_toolId, name) => {
      if (name === 'api_token') return 'gitlab-token';
      if (name === 'base_url') return baseUrl;
      return null;
    },
    hasToolSecret: async () => true,
    setToolSecret: async () => ({ success: true }),
    deleteToolSecrets: async () => undefined,
  },
});

const execute = (actionId, input = {}, context = createContext()) => gitlabToolModule.execute({
  toolId: 'gitlab', actionId, input,
}, context);
const response = (payload, status = 200) => new Response(JSON.stringify(payload), { status });
const withFetch = async (handler, operation) => {
  const previous = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  };
  try {
    return await operation(calls);
  } finally {
    globalThis.fetch = previous;
  }
};

test('Given GitLab credentials, project, issue, merge request and pipeline flows issue one scoped request each', async () => {
  await withFetch(
    (rawUrl, init) => {
      const url = new URL(rawUrl);
      if (url.pathname.endsWith('/user')) return response({ id: 10, username: 'developer', email: 'dev@example.com' });
      if (init.method === 'POST' || init.method === 'PUT') return response({ id: 20, iid: 2 });
      if (/\/(issues|merge_requests|pipelines|projects)$/.test(url.pathname)) return response([{ id: 20 }]);
      return response({ id: 20, iid: 2 });
    },
    async (calls) => {
      assert.deepEqual((await execute('gitlab.connection.status')).data, {
        connected: true, subject: '10', email: 'dev@example.com', username: 'developer',
      });

      const lists = [
        ['gitlab.list_projects', { limit: 5, state: ' active ' }, '/api/v4/projects'],
        ['gitlab.list_issues', { projectId: 'group/project', limit: 6, state: 'opened' }, '/api/v4/projects/group%2Fproject/issues'],
        ['gitlab.list_merge_requests', { projectId: 'group/project' }, '/api/v4/projects/group%2Fproject/merge_requests'],
        ['gitlab.list_pipelines', { projectId: 'group/project' }, '/api/v4/projects/group%2Fproject/pipelines'],
      ];
      for (const [actionId, input, expectedPath] of lists) {
        const before = calls.length;
        const result = await execute(actionId, input);
        assert.equal(result.success, true);
        assert.equal(calls.length - before, 1, `${actionId} must make exactly one remote request`);
        const call = calls.at(-1);
        const url = new URL(call.url);
        assert.equal(url.pathname, expectedPath);
        assert.equal(call.init.headers.get('private-token'), 'gitlab-token');
      }
      assert.equal(new URL(calls[1].url).searchParams.get('state'), 'active');
      assert.equal(new URL(calls[1].url).searchParams.get('per_page'), '5');

      assert.equal((await execute('gitlab.get_project', { projectId: 'group/project' })).data.project.id, 20);
      assert.equal((await execute('gitlab.get_issue', { projectId: 'group/project', issueIid: '2' })).data.issue.iid, 2);

      let result = await execute('gitlab.create_issue', {
        projectId: 'group/project', title: ' Issue ', description: ' Details ',
      });
      assert.equal(result.success, true);
      assert.deepEqual(JSON.parse(calls.at(-1).init.body), { title: 'Issue', description: 'Details' });

      result = await execute('gitlab.update_issue', {
        projectId: 'group/project', issueIid: 2, title: 'Updated', stateEvent: 'close',
      });
      assert.equal(result.success, true);
      assert.deepEqual(JSON.parse(calls.at(-1).init.body), { title: 'Updated', state_event: 'close' });
      await execute('gitlab.update_issue', { projectId: 'group/project', issueIid: 2 });
      assert.deepEqual(JSON.parse(calls.at(-1).init.body), {});

      assert.equal((await execute('gitlab.create_issue_note', {
        projectId: 'group/project', issueIid: 2, body: 'Note',
      })).data.note.id, 20);
      assert.equal((await execute('gitlab.get_merge_request', {
        projectId: 'group/project', mergeRequestIid: 2,
      })).data.mergeRequest.iid, 2);
      assert.equal((await execute('gitlab.create_merge_request_note', {
        projectId: 'group/project', mergeRequestIid: 2, body: 'Review',
      })).data.note.id, 20);
    },
  );
});

test('Given GitLab defaults and sparse payloads, lists normalize once and use gitlab.com safely', async () => {
  await withFetch(
    (rawUrl) => new URL(rawUrl).pathname.endsWith('/user') ? response({}) : response({ items: [] }),
    async (calls) => {
      const defaultContext = createContext(null);
      const status = await execute('gitlab.connection.status', {}, defaultContext);
      assert.equal(status.data.subject, '');
      const projects = await execute('gitlab.list_projects', {}, defaultContext);
      assert.deepEqual(projects.data.projects, []);
      assert.equal(calls.filter((call) => new URL(call.url).pathname.endsWith('/projects')).length, 1);
      assert.equal(new URL(calls.at(-1).url).origin, 'https://gitlab.com');
      assert.equal(new URL(calls.at(-1).url).searchParams.get('per_page'), '25');
    },
  );
});

test('Given malformed GitLab inputs, each scoped action reports the first missing identifier', async () => {
  const cases = [
    ['gitlab.list_issues', {}, 'gitlab_project_required'],
    ['gitlab.list_merge_requests', {}, 'gitlab_project_required'],
    ['gitlab.list_pipelines', {}, 'gitlab_project_required'],
    ['gitlab.get_project', {}, 'gitlab_project_required'],
    ['gitlab.get_issue', { issueIid: 2 }, 'gitlab_project_required'],
    ['gitlab.get_issue', { projectId: 'project' }, 'gitlab_issue_required'],
    ['gitlab.create_issue', { title: 'Issue' }, 'gitlab_project_required'],
    ['gitlab.create_issue', { projectId: 'project' }, 'gitlab_title_required'],
    ['gitlab.update_issue', { issueIid: 2 }, 'gitlab_project_required'],
    ['gitlab.update_issue', { projectId: 'project' }, 'gitlab_issue_required'],
    ['gitlab.create_issue_note', { issueIid: 2, body: 'Note' }, 'gitlab_project_required'],
    ['gitlab.create_issue_note', { projectId: 'project', body: 'Note' }, 'gitlab_issue_required'],
    ['gitlab.create_issue_note', { projectId: 'project', issueIid: 2 }, 'gitlab_body_required'],
    ['gitlab.get_merge_request', { mergeRequestIid: 2 }, 'gitlab_project_required'],
    ['gitlab.get_merge_request', { projectId: 'project' }, 'gitlab_mr_required'],
    ['gitlab.create_merge_request_note', { mergeRequestIid: 2, body: 'Note' }, 'gitlab_project_required'],
    ['gitlab.create_merge_request_note', { projectId: 'project', body: 'Note' }, 'gitlab_mr_required'],
    ['gitlab.create_merge_request_note', { projectId: 'project', mergeRequestIid: 2 }, 'gitlab_body_required'],
  ];
  const previous = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('Network must not be reached'); };
  try {
    for (const [actionId, input, technicalCode] of cases) {
      assert.equal((await execute(actionId, input)).technicalCode, technicalCode, actionId);
    }
  } finally {
    globalThis.fetch = previous;
  }
});
