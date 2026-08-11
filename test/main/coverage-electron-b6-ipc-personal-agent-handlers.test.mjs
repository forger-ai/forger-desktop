import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

import { createIpcMainRecorder } from './electron-test-helpers.mjs';

const require = createRequire(import.meta.url);
const { IPC_CHANNELS } = require('../../dist-electron/shared/ipc.js');
const { registerPersonalAgentIpcHandlers } = require('../../dist-electron/main/ipc/personal-agent-handlers.js');

const connectionDefinition = (overrides = {}) => ({
  type: 'gmail', displayName: 'Gmail', description: 'Mail', setupKind: 'oauth', supportsMultiple: true,
  actions: [{ id: 'gmail.search', name: 'Search', description: 'Search mail', risk: 'low' }],
  secretsSchema: [], statusActionId: 'gmail.connection.status', ...overrides,
});

const createHarness = async ({ connections, existingAgent } = {}) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forger-b6-agent-ipc-'));
  const privateDataRoot = path.join(root, 'private-data');
  const { handlers, ipcMain } = createIpcMainRecorder();
  const calls = [];
  const defaultExistingAgent = {
    id: 'agent-1', name: 'Agent One', appIds: [], toolIds: [], connectionGrants: [], peerAgentGrants: [],
  };
  const store = {
    listAgents: async () => [
      { id: 'agent-1', name: 'Agent One', description: 'First' },
      { id: 'peer-2', name: 'Peer Two', description: 'Second' },
    ],
    requireAgent: async () => existingAgent ?? defaultExistingAgent,
    createAgent: async (input) => { calls.push(['createAgent', input]); return input; },
    updateAgentPermissions: async (input) => { calls.push(['updatePermissions', input]); return input; },
    listGroups: async () => { calls.push(['listGroups']); return [{ id: 'group-1' }]; },
    createGroup: async (input) => { calls.push(['createGroup', input]); return { id: 'group-2', ...input }; },
    updateGroup: async (input) => { calls.push(['updateGroup', input]); return input; },
    deleteGroup: async (groupId) => { calls.push(['deleteGroup', groupId]); return { success: true }; },
    updateAgentGroup: async (input) => { calls.push(['updateAgentGroup', input]); return input; },
    deleteAgent: async () => ({ success: true }),
    listConversations: async () => [],
    listWorkspace: async () => [],
    readWorkspaceTextFile: async () => ({}),
    writeWorkspaceTextFile: async () => ({ success: true }),
    listPeerThreadsForConversation: async (input) => {
      calls.push(['listPeerThreads', input]);
      return [{ id: 'peer-thread-1', ...input }];
    },
    getPeerThread: async (threadId) => { calls.push(['getPeerThread', threadId]); return { id: threadId }; },
  };
  const conversationManager = {
    startConversation: async () => ({}),
    sendMessage: async (input) => { calls.push(['sendMessage', input]); return input; },
    getConversation: async () => ({}),
  };
  const routineManager = {
    updateDraft: async () => ({}), cancelWakeup: async () => null, list: async () => [],
    create: async () => ({}), update: async () => ({}), setEnabled: async () => ({}),
    delete: async () => ({ success: true }), runNow: async () => ({}),
  };
  const connectionState = connections ?? {
    types: [connectionDefinition()],
    instances: [
      { id: 'gmail-1', type: 'gmail', status: 'connected' },
      { id: 'gmail-disabled', type: 'gmail', status: 'disabled' },
    ],
  };
  registerPersonalAgentIpcHandlers({
    IPC_CHANNELS, fs, path, ipcMain,
    ensurePathInside: (rootPath, targetPath) => {
      const relative = path.relative(rootPath, targetPath);
      return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
    },
    getPrivateDataRoot: () => privateDataRoot,
    getPersonalAgentStore: () => store,
    getPersonalAgentConversationManager: () => conversationManager,
    getPersonalAgentRoutineManager: () => routineManager,
    listInstalledApps: () => [{ id: 'finance-os', name: 'Finance', status: 'installed' }],
    listOfficialTools: async () => ({
      tools: [{
        id: 'browser', name: 'Browser', description: 'Browse', configured: true, status: 'configured',
        actions: [{ id: 'browser.open', name: 'Open', description: 'Open URL', risk: 'low' }],
      }],
    }),
    listConnections: async () => connectionState,
    isAgentProviderConnected: async () => true,
  });
  return {
    root, privateDataRoot, handlers, calls,
    cleanup: async () => fs.rm(root, { recursive: true, force: true }),
  };
};

test('personal-agent IPC delegates group and peer-thread lifecycle without inventing missing conversations', async (t) => {
  const harness = await createHarness();
  t.after(harness.cleanup);
  const { handlers } = harness;

  assert.deepEqual(await handlers.get(IPC_CHANNELS.personalAgentGroupsList)(), [{ id: 'group-1' }]);
  assert.equal((await handlers.get(IPC_CHANNELS.personalAgentGroupsCreate)(null, { name: ' Team ' })).id, 'group-2');
  assert.deepEqual(await handlers.get(IPC_CHANNELS.personalAgentGroupsUpdate)(null, {
    groupId: 'group-1', name: 'Updated',
  }), { groupId: 'group-1', name: 'Updated' });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.personalAgentGroupsDelete)(null, { groupId: 'group-1' }), {
    success: true,
  });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.personalAgentUpdateGroup)(null, {
    agentId: 'agent-1', groupId: null,
  }), { agentId: 'agent-1', groupId: null });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.personalAgentPeerThreadsList)(null, {
    agentId: 'agent-1',
  }), []);
  assert.deepEqual(await handlers.get(IPC_CHANNELS.personalAgentPeerThreadsList)(null, {
    agentId: 'agent-1', conversationId: 'conversation-1',
  }), [{ id: 'peer-thread-1', agentId: 'agent-1', conversationId: 'conversation-1' }]);
  assert.deepEqual(await handlers.get(IPC_CHANNELS.personalAgentPeerThreadGet)(null, {
    threadId: 'peer-thread-1',
  }), { id: 'peer-thread-1' });
});

test('personal-agent IPC resolves shared files only inside private data and fills safe display metadata', async (t) => {
  const harness = await createHarness();
  t.after(harness.cleanup);

  const first = await harness.handlers.get(IPC_CHANNELS.personalAgentSendMessage)(null, {
    conversationId: 'conversation-1', message: 'No file', sharedFiles: [{ path: 'missing.txt' }],
  });
  assert.deepEqual(first.sharedFiles, [{ path: 'missing.txt' }]);

  const allowed = path.join(harness.privateDataRoot, 'allowed.txt');
  const outside = path.join(harness.root, 'outside.txt');
  await fs.writeFile(allowed, 'allowed', 'utf8');
  await fs.writeFile(outside, 'outside', 'utf8');
  const realAllowed = await fs.realpath(allowed);
  const sent = await harness.handlers.get(IPC_CHANNELS.personalAgentSendMessage)(null, {
    conversationId: 'conversation-1',
    message: 'Review files',
    sharedFiles: [
      { path: 'allowed.txt' },
      { path: allowed, relativePath: 'chosen/allowed.txt', name: 'Chosen file' },
      { path: outside },
      { path: path.join(harness.privateDataRoot, 'missing.txt') },
    ],
  });
  assert.deepEqual(sent.sharedFiles, [
    { path: realAllowed, relativePath: 'allowed.txt', name: 'allowed.txt' },
    { path: realAllowed, relativePath: 'chosen/allowed.txt', name: 'Chosen file' },
  ]);
});

test('personal-agent IPC sanitizes peer and connection authority while preserving valid existing grants', async (t) => {
  const existingAgent = {
    id: 'agent-1', name: 'Agent One', appIds: ['legacy-app'], toolIds: ['legacy.tool'],
    connectionGrants: [
      { type: 'removed', actions: ['removed.read'], multiple: false },
      { type: 'gmail', actions: ['gmail.search'], multiple: true, connectionIds: ['gmail-old'] },
    ],
    peerAgentGrants: [],
  };
  const harness = await createHarness({ existingAgent });
  t.after(harness.cleanup);

  await harness.handlers.get(IPC_CHANNELS.personalAgentsCreate)(null, {
    name: 'Created',
    peerAgentGrants: [
      { agentId: 'peer-2', criteria: 7 },
      { agentId: 'missing', criteria: 'No' },
    ],
    connectionGrants: [
      { type: 'missing', actions: ['missing.read'], multiple: false },
      { type: 'gmail', actions: ['invalid'], multiple: false },
      { type: 'gmail', actions: ['gmail.search'], multiple: false, connectionIds: ['missing'] },
      { type: 'gmail', actions: ['gmail.search'], multiple: false },
    ],
  });
  assert.deepEqual(harness.calls[0][1].peerAgentGrants, [{ agentId: 'peer-2', criteria: '' }]);
  assert.deepEqual(harness.calls[0][1].connectionGrants, [
    { type: 'gmail', actions: ['gmail.search'], multiple: false },
  ]);

  await harness.handlers.get(IPC_CHANNELS.personalAgentUpdatePermissions)(null, {
    agentId: 'agent-1',
    appIds: ['legacy-app', 'unknown'],
    toolIds: ['legacy.tool', 'unknown'],
    peerAgentGrants: [
      { agentId: 'agent-1', criteria: 'Self' },
      { agentId: 'peer-2', criteria: ' Collaborate ' },
    ],
    connectionGrants: [
      { type: 'removed', actions: ['removed.read'], multiple: false },
      { type: 'gmail', actions: ['invalid'], multiple: false },
      { type: 'gmail', actions: ['gmail.search'], multiple: true, connectionIds: ['gmail-old'] },
    ],
  });
  const update = harness.calls[1][1];
  assert.deepEqual(update.appIds, ['legacy-app']);
  assert.deepEqual(update.toolIds, ['legacy.tool']);
  assert.deepEqual(update.peerAgentGrants, [{ agentId: 'peer-2', criteria: 'Collaborate' }]);
  assert.deepEqual(update.connectionGrants, [
    { type: 'removed', actions: ['removed.read'], multiple: false },
    { type: 'gmail', actions: ['gmail.search'], multiple: true, connectionIds: ['gmail-old'] },
    { type: 'gmail', actions: ['gmail.search'], multiple: true, connectionIds: ['gmail-old'] },
  ]);

  await harness.handlers.get(IPC_CHANNELS.personalAgentUpdatePermissions)(null, {
    agentId: 'agent-1',
    connectionGrants: [
      { type: 'gmail', actions: ['gmail.search'], multiple: true, connectionIds: ['missing'] },
    ],
  });
  assert.deepEqual(harness.calls[2][1].connectionGrants, [existingAgent.connectionGrants[1]]);

  const disconnected = await createHarness({
    existingAgent,
    connections: { types: [connectionDefinition()], instances: [] },
  });
  t.after(disconnected.cleanup);
  await disconnected.handlers.get(IPC_CHANNELS.personalAgentUpdatePermissions)(null, {
    agentId: 'agent-1',
    connectionGrants: [{ type: 'gmail', actions: ['gmail.search'], multiple: true }],
  });
  assert.deepEqual(disconnected.calls[0][1].connectionGrants, [existingAgent.connectionGrants[1]]);
});
