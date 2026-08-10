import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { figmaToolModule } = require('../../dist-electron/main/connections/modules/token-service-connectors/figma.js');

const createContext = () => ({
  metadataRoot: '/tmp/forger-figma-b8',
  secretsStore: {
    getToolSecret: async (_toolId, name) => name === 'access_token' ? 'figma-token' : null,
    hasToolSecret: async () => true,
    setToolSecret: async () => ({ success: true }),
    deleteToolSecrets: async () => undefined,
  },
});

const execute = (actionId, input = {}) => figmaToolModule.execute({ toolId: 'figma', actionId, input }, createContext());

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

const response = (payload, status = 200) => new Response(JSON.stringify(payload), { status });

test('Given a Figma token, every read and comment flow preserves encoded resource boundaries', async () => {
  await withFetch(
    (rawUrl, init) => {
      const url = new URL(rawUrl);
      if (url.pathname === '/v1/me') return response({ id: 'person', email: 'person@example.com', handle: 'Designer' });
      if (url.pathname.includes('/nodes')) return response({ nodes: { '1:2': { document: {} } } });
      if (url.pathname.startsWith('/v1/images/')) return response({ images: { '1:2': 'https://image.test/1' } });
      if (url.pathname.endsWith('/comments/comment%2F1') && init.method === 'DELETE') return response({});
      if (url.pathname.endsWith('/comments') && init.method === 'POST') return response({ id: 'comment-new' });
      if (url.pathname.endsWith('/comments')) return response({ comments: [{ id: 'comment-1' }] });
      if (url.pathname.startsWith('/v1/files/')) return response({ name: 'Design file' });
      if (url.pathname.startsWith('/v1/teams/')) return response({ projects: [{ id: 'project-1' }] });
      if (url.pathname.startsWith('/v1/projects/')) return response({ files: [{ key: 'file-1' }] });
      throw new Error(`Unexpected Figma request: ${rawUrl}`);
    },
    async (calls) => {
      const status = await execute('figma.connection.status');
      assert.equal(status.data.connected, true);

      assert.equal((await execute('figma.get_file', { fileKey: ' file/key ', depth: 3 })).success, true);
      let call = calls.at(-1);
      assert.equal(new URL(call.url).pathname, '/v1/files/file%2Fkey');
      assert.equal(new URL(call.url).searchParams.get('depth'), '3');
      assert.equal(call.init.headers.get('x-figma-token'), 'figma-token');

      await execute('figma.get_file', { fileKey: 'file' });
      assert.equal(new URL(calls.at(-1).url).search, '');

      const nodes = await execute('figma.get_file_nodes', { fileKey: 'file', nodeIds: [' 1:2 ', 9, ''] });
      assert.deepEqual(nodes.data.nodes, { '1:2': { document: {} } });
      assert.equal(new URL(calls.at(-1).url).searchParams.get('ids'), '1:2');

      assert.equal((await execute('figma.get_images', {
        fileKey: 'file', nodeIds: ['1:2'], format: ' svg ',
      })).data.images['1:2'], 'https://image.test/1');
      assert.equal(new URL(calls.at(-1).url).searchParams.get('format'), 'svg');
      await execute('figma.get_images', { fileKey: 'file', nodeIds: ['1:2'] });
      assert.equal(new URL(calls.at(-1).url).searchParams.get('format'), 'png');

      assert.equal((await execute('figma.get_comments', { fileKey: 'file' })).data.comments.length, 1);
      const created = await execute('figma.create_comment', { fileKey: 'file', message: ' Review ' });
      assert.equal(created.data.comment.id, 'comment-new');
      call = calls.at(-1);
      assert.equal(call.init.method, 'POST');
      assert.deepEqual(JSON.parse(call.init.body), { message: 'Review' });

      assert.equal((await execute('figma.delete_comment', {
        fileKey: 'file', commentId: ' comment/1 ',
      })).data.deleted, true);
      assert.equal((await execute('figma.get_team_projects', { teamId: 'team/1' })).data.projects.length, 1);
      assert.equal((await execute('figma.get_project_files', { projectId: 'project/1' })).data.files.length, 1);
    },
  );
});

test('Given malformed Figma inputs, each action rejects before network access', async () => {
  const cases = [
    ['figma.get_file', {}, 'figma_file_key_required'],
    ['figma.get_file_nodes', {}, 'figma_file_key_required'],
    ['figma.get_file_nodes', { fileKey: 'file', nodeIds: [] }, 'figma_node_ids_required'],
    ['figma.get_images', {}, 'figma_file_key_required'],
    ['figma.get_images', { fileKey: 'file', nodeIds: 'bad' }, 'figma_node_ids_required'],
    ['figma.get_comments', {}, 'figma_file_key_required'],
    ['figma.create_comment', { message: 'text' }, 'figma_file_key_required'],
    ['figma.create_comment', { fileKey: 'file' }, 'figma_message_required'],
    ['figma.delete_comment', { commentId: 'comment' }, 'figma_file_key_required'],
    ['figma.delete_comment', { fileKey: 'file' }, 'figma_comment_required'],
    ['figma.get_team_projects', {}, 'figma_team_required'],
    ['figma.get_project_files', {}, 'figma_project_required'],
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
