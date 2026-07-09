import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

import { createIpcMainRecorder } from './electron-test-helpers.mjs';

const require = createRequire(import.meta.url);
const { IPC_CHANNELS } = require('../../dist-electron/shared/ipc.js');
const { registerPersonalAgentIpcHandlers } = require('../../dist-electron/main/ipc/personal-agent-handlers.js');

const connectionDefinition = (overrides = {}) => ({
  type: 'gmail',
  displayName: 'Gmail',
  description: 'Correo',
  setupKind: 'oauth',
  supportsMultiple: true,
  actions: [
    { id: 'gmail.search_messages', name: 'Search', description: 'Busca correos', risk: 'medium' },
  ],
  secretsSchema: [],
  statusActionId: 'gmail.connection.status',
  ...overrides,
});

const connectionInstance = (overrides = {}) => ({
  id: 'gmail-1',
  type: 'gmail',
  label: 'Personal',
  status: 'connected',
  isDefault: true,
  createdAt: '2026-07-05T00:00:00.000Z',
  updatedAt: '2026-07-05T00:00:00.000Z',
  ...overrides,
});

const createHarness = ({ connectedProviders = ['codex'], officialTools, connections, installedApps, existingAgent } = {}) => {
  const { handlers, ipcMain } = createIpcMainRecorder();
  const storeCalls = [];
  const managerCalls = [];
  const agentRecord = existingAgent ?? {
    id: 'agent-1',
    name: 'Ops',
    appIds: [],
    toolIds: [],
    connectionGrants: [],
    peerAgentGrants: [],
  };
  const store = {
    listAgents: async () => {
      storeCalls.push(['listAgents']);
      return [{ id: 'agent-1', name: 'Ops' }];
    },
    requireAgent: async (agentId) => ({ ...agentRecord, id: agentId }),
    createAgent: async (input) => {
      storeCalls.push(['createAgent', input]);
      return { id: 'agent-2', ...input };
    },
    updateAgentPermissions: async (input) => {
      storeCalls.push(['updateAgentPermissions', input]);
      return { id: input.agentId, ...input };
    },
    deleteAgent: async (agentId) => {
      storeCalls.push(['deleteAgent', agentId]);
      return { success: true, agentId };
    },
    listConversations: async (agentId) => {
      storeCalls.push(['listConversations', agentId]);
      return [{ id: 'conv-1', agentId }];
    },
    listWorkspace: async (agentId) => {
      storeCalls.push(['listWorkspace', agentId]);
      return [{ path: 'notes.md', agentId }];
    },
    readWorkspaceTextFile: async (input) => {
      storeCalls.push(['readWorkspaceTextFile', input]);
      return { text: 'hola', path: input.path };
    },
    writeWorkspaceTextFile: async (input) => {
      storeCalls.push(['writeWorkspaceTextFile', input]);
      return { success: true, path: input.path };
    },
  };
  const conversationManager = {
    startConversation: async (input) => {
      managerCalls.push(['startConversation', input]);
      return { conversationId: 'conv-9', agentId: input.agentId };
    },
    sendMessage: async (input) => {
      managerCalls.push(['sendMessage', input]);
      return { conversationId: input.conversationId, accepted: true };
    },
    getConversation: async (input) => {
      managerCalls.push(['getConversation', input]);
      return { conversationId: input.conversationId, messages: [] };
    },
  };

  registerPersonalAgentIpcHandlers({
    IPC_CHANNELS,
    ipcMain,
    getPersonalAgentStore: () => store,
    getPersonalAgentConversationManager: () => conversationManager,
    listInstalledApps: () =>
      installedApps ?? [
        { id: 'finance-os', name: 'Finance OS', description: 'Finanzas', status: 'installed' },
        { id: 'notes', description: undefined, status: 'installed' },
      ],
    listOfficialTools: async () =>
      officialTools ?? {
        tools: [
          {
            id: 'forger_chrome_extension',
            name: 'Chrome',
            description: 'Controla Chrome',
            configured: true,
            status: 'configured',
            actions: [
              { id: 'forger_chrome_extension.navigate', name: 'Navigate', description: 'Navega', risk: 'medium' },
            ],
          },
          { id: 'no-actions-tool', name: 'Empty', description: '', configured: false, status: 'needs_setup', actions: [] },
        ],
      },
    listConnections: async () =>
      connections ?? {
        types: [
          connectionDefinition(),
        ],
        instances: [
          connectionInstance(),
        ],
      },
    isAgentProviderConnected: async (provider) => connectedProviders.includes(provider),
  });

  return { handlers, storeCalls, managerCalls };
};

test('personal agent IPC lists agents and delegates deletion, conversations, and workspace reads/writes', async () => {
  const { handlers, storeCalls } = createHarness();

  assert.deepEqual(await handlers.get(IPC_CHANNELS.personalAgentsList)(), [{ id: 'agent-1', name: 'Ops' }]);
  assert.deepEqual(await handlers.get(IPC_CHANNELS.personalAgentsDelete)(null, { agentId: 'agent-1' }), {
    success: true,
    agentId: 'agent-1',
  });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.personalAgentConversationsList)(null, { agentId: 'agent-1' }), [
    { id: 'conv-1', agentId: 'agent-1' },
  ]);
  assert.deepEqual(await handlers.get(IPC_CHANNELS.personalAgentWorkspaceList)(null, { agentId: 'agent-1' }), [
    { path: 'notes.md', agentId: 'agent-1' },
  ]);
  assert.deepEqual(
    await handlers.get(IPC_CHANNELS.personalAgentWorkspaceFileRead)(null, { agentId: 'agent-1', path: 'notes.md' }),
    { text: 'hola', path: 'notes.md' },
  );
  assert.deepEqual(
    await handlers.get(IPC_CHANNELS.personalAgentWorkspaceFileWrite)(null, {
      agentId: 'agent-1',
      path: 'notes.md',
      text: 'nuevo',
    }),
    { success: true, path: 'notes.md' },
  );

  assert.deepEqual(storeCalls, [
    ['listAgents'],
    ['deleteAgent', 'agent-1'],
    ['listConversations', 'agent-1'],
    ['listWorkspace', 'agent-1'],
    ['readWorkspaceTextFile', { agentId: 'agent-1', path: 'notes.md' }],
    ['writeWorkspaceTextFile', { agentId: 'agent-1', path: 'notes.md', text: 'nuevo' }],
  ]);
});

test('personal agent IPC create separates Forger Tool grants from explicit connection grants', async () => {
  const { handlers, storeCalls } = createHarness();

  const created = await handlers.get(IPC_CHANNELS.personalAgentsCreate)(null, {
    name: 'Ops',
    appIds: ['finance-os', 'uninstalled-app'],
    toolIds: ['gmail.search_messages', 'forger_chrome_extension.navigate', 'unknown.action'],
    connectionGrants: [{ type: 'gmail', actions: ['gmail.search_messages'], multiple: true }],
  });

  assert.equal(created.id, 'agent-2');
  assert.deepEqual(storeCalls[0], [
    'createAgent',
    {
      name: 'Ops',
      appIds: ['finance-os'],
      toolIds: ['forger_chrome_extension.navigate'],
      connectionGrants: [{ type: 'gmail', actions: ['gmail.search_messages'], multiple: true }],
    },
  ]);
});

test('personal agent IPC create keeps input untouched when no grant lists are provided', async () => {
  const { handlers, storeCalls } = createHarness();

  await handlers.get(IPC_CHANNELS.personalAgentsCreate)(null, { name: 'Sin permisos' });

  assert.deepEqual(storeCalls[0], ['createAgent', { name: 'Sin permisos' }]);
});

test('personal agent IPC rejects create/update when the requested runtime provider is not connected', async () => {
  const { handlers, storeCalls } = createHarness({ connectedProviders: ['claude'] });

  await assert.rejects(
    handlers.get(IPC_CHANNELS.personalAgentsCreate)(null, { name: 'Ops', runtime: { provider: 'codex' } }),
    /personal_agent_runtime_provider_not_connected/,
  );
  await assert.rejects(
    handlers.get(IPC_CHANNELS.personalAgentUpdatePermissions)(null, {
      agentId: 'agent-1',
      runtime: { provider: 'codex' },
    }),
    /personal_agent_runtime_provider_not_connected/,
  );
  assert.deepEqual(storeCalls, []);

  const connected = await handlers.get(IPC_CHANNELS.personalAgentsCreate)(null, {
    name: 'Ops',
    runtime: { provider: 'claude' },
  });
  assert.equal(connected.id, 'agent-2');
});

test('personal agent IPC update permissions filters grants before persisting', async () => {
  const { handlers, storeCalls } = createHarness();

  const updated = await handlers.get(IPC_CHANNELS.personalAgentUpdatePermissions)(null, {
    agentId: 'agent-1',
    appIds: ['uninstalled-app', 'notes'],
    toolIds: ['unknown.action', 'gmail.search_messages', 'forger_chrome_extension.navigate'],
    connectionGrants: [{ type: 'gmail', actions: ['gmail.search_messages'], multiple: true }],
  });

  assert.equal(updated.id, 'agent-1');
  assert.deepEqual(storeCalls[0], [
    'updateAgentPermissions',
    {
      agentId: 'agent-1',
      appIds: ['notes'],
      toolIds: ['forger_chrome_extension.navigate'],
      connectionGrants: [{ type: 'gmail', actions: ['gmail.search_messages'], multiple: true }],
    },
  ]);
});

test('personal agent IPC update preserves existing grants when option catalogs are temporarily unavailable', async () => {
  const existingAgent = {
    id: 'agent-1',
    name: 'Ops',
    appIds: ['finance-os'],
    toolIds: ['forger_chrome_extension.navigate'],
    connectionGrants: [
      {
        type: 'gmail',
        actions: ['gmail.search_messages'],
        multiple: true,
        connectionIds: ['gmail-1'],
      },
    ],
    peerAgentGrants: [],
  };
  const { handlers, storeCalls } = createHarness({
    existingAgent,
    installedApps: [],
    officialTools: { tools: [] },
    connections: { types: [], instances: [] },
  });

  await handlers.get(IPC_CHANNELS.personalAgentUpdatePermissions)(null, {
    agentId: 'agent-1',
    appIds: ['finance-os', 'unknown-app'],
    toolIds: ['forger_chrome_extension.navigate', 'unknown.action'],
    connectionGrants: [
      {
        type: 'gmail',
        actions: ['gmail.search_messages'],
        multiple: true,
        connectionIds: ['gmail-1'],
      },
      {
        type: 'slack',
        actions: ['slack.send_message'],
        multiple: false,
      },
    ],
  });
  assert.deepEqual(storeCalls[0], [
    'updateAgentPermissions',
    {
      agentId: 'agent-1',
      appIds: ['finance-os'],
      toolIds: ['forger_chrome_extension.navigate'],
      connectionGrants: [
        {
          type: 'gmail',
          actions: ['gmail.search_messages'],
          multiple: true,
          connectionIds: ['gmail-1'],
        },
      ],
    },
  ]);

  await handlers.get(IPC_CHANNELS.personalAgentUpdatePermissions)(null, {
    agentId: 'agent-1',
    appIds: [],
    toolIds: [],
    connectionGrants: [],
  });
  assert.deepEqual(storeCalls[1], [
    'updateAgentPermissions',
    {
      agentId: 'agent-1',
      appIds: [],
      toolIds: [],
      connectionGrants: [],
    },
  ]);
});

test('personal agent IPC grant options expose installed apps and only tools with actions', async () => {
  const { handlers } = createHarness();

  assert.deepEqual(await handlers.get(IPC_CHANNELS.personalAgentGrantOptionsList)(), {
    apps: [
      { appId: 'finance-os', name: 'Finance OS', description: 'Finanzas', status: 'installed' },
      { appId: 'notes', name: 'notes', description: undefined, status: 'installed' },
    ],
    tools: [
      {
        id: 'forger_chrome_extension',
        name: 'Chrome',
        description: 'Controla Chrome',
        configured: true,
        status: 'configured',
        actions: [
          {
            id: 'forger_chrome_extension.navigate',
            toolId: 'forger_chrome_extension',
            name: 'Navigate',
            description: 'Navega',
            risk: 'medium',
          },
        ],
      },
    ],
    connections: [
      {
        type: 'gmail',
        displayName: 'Gmail',
        description: 'Correo',
        configured: true,
        supportsMultiple: true,
        definition: {
          type: 'gmail',
          displayName: 'Gmail',
          description: 'Correo',
          setupKind: 'oauth',
          supportsMultiple: true,
          actions: [
            { id: 'gmail.search_messages', name: 'Search', description: 'Busca correos', risk: 'medium' },
          ],
          secretsSchema: [],
          statusActionId: 'gmail.connection.status',
        },
        instances: [
          {
            id: 'gmail-1',
            type: 'gmail',
            label: 'Personal',
            status: 'connected',
            isDefault: true,
            createdAt: '2026-07-05T00:00:00.000Z',
            updatedAt: '2026-07-05T00:00:00.000Z',
          },
        ],
        actions: [
          { id: 'gmail.search_messages', name: 'Search', description: 'Busca correos', risk: 'medium' },
        ],
      },
    ],
    peerAgents: [
      { agentId: 'agent-1', name: 'Ops', description: undefined },
    ],
  });
});

test('personal agent IPC grant options fall back to app id for blank app names', async () => {
  const { handlers } = createHarness({
    installedApps: [
      { id: 'recipes', name: '   ', description: '   ', shortDescription: 'Recetas', status: 'running' },
      { id: 'journal', name: 'Diario', description: 'Notas personales', status: 'installed' },
    ],
  });

  const options = await handlers.get(IPC_CHANNELS.personalAgentGrantOptionsList)();

  assert.deepEqual(options.apps, [
    { appId: 'recipes', name: 'recipes', description: 'Recetas', status: 'running' },
    { appId: 'journal', name: 'Diario', description: 'Notas personales', status: 'installed' },
  ]);
});

test('personal agent IPC grant options expose only connected connection accounts by instance', async () => {
  const { handlers } = createHarness({
    connections: {
      types: [
        connectionDefinition(),
        connectionDefinition({
          type: 'trello',
          displayName: 'Trello',
          description: 'Tableros',
          statusActionId: 'trello.connection.status',
          actions: [
            { id: 'trello.create_card', name: 'Create card', description: 'Crea tarjetas', risk: 'medium' },
          ],
        }),
        connectionDefinition({
          type: 'slack',
          displayName: 'Slack',
          description: 'Mensajes',
          statusActionId: 'slack.connection.status',
          actions: [
            { id: 'slack.send_message', name: 'Send message', description: 'Envia mensajes', risk: 'high' },
          ],
        }),
      ],
      instances: [
        connectionInstance({ id: 'gmail-connected', label: 'Gmail connected', accountIdentity: { email: 'ok@example.com' } }),
        connectionInstance({ id: 'gmail-disabled', label: 'Gmail disabled', status: 'disabled', isDefault: false }),
        connectionInstance({ id: 'trello-a', type: 'trello', label: 'Trello A', accountIdentity: { username: 'user-a' } }),
        connectionInstance({ id: 'trello-b', type: 'trello', label: 'Trello B', accountIdentity: { username: 'user-b' }, isDefault: false }),
        connectionInstance({ id: 'slack-needs-setup', type: 'slack', label: 'Slack pending', status: 'needs_setup' }),
      ],
    },
  });

  const options = await handlers.get(IPC_CHANNELS.personalAgentGrantOptionsList)();
  assert.deepEqual(options.connections.map((connection) => ({
    type: connection.type,
    configured: connection.configured,
    instanceIds: connection.instances.map((instance) => instance.id),
  })), [
    { type: 'gmail', configured: true, instanceIds: ['gmail-connected'] },
    { type: 'trello', configured: true, instanceIds: ['trello-a', 'trello-b'] },
  ]);
});

test('personal agent IPC create and update keep only connected connection grant instances', async () => {
  const connections = {
    types: [connectionDefinition()],
    instances: [
      connectionInstance({ id: 'gmail-connected' }),
      connectionInstance({ id: 'gmail-disabled', status: 'disabled', isDefault: false }),
    ],
  };
  const { handlers, storeCalls } = createHarness({ connections });

  await handlers.get(IPC_CHANNELS.personalAgentsCreate)(null, {
    name: 'Ops',
    connectionGrants: [
      {
        type: 'gmail',
        actions: ['gmail.search_messages'],
        multiple: true,
        connectionIds: ['gmail-connected', 'gmail-disabled', 'missing'],
      },
    ],
  });
  assert.deepEqual(storeCalls[0], [
    'createAgent',
    {
      name: 'Ops',
      connectionGrants: [
        {
          type: 'gmail',
          actions: ['gmail.search_messages'],
          multiple: true,
          connectionIds: ['gmail-connected'],
        },
      ],
    },
  ]);

  await handlers.get(IPC_CHANNELS.personalAgentUpdatePermissions)(null, {
    agentId: 'agent-1',
    connectionGrants: [
      {
        type: 'gmail',
        actions: ['gmail.search_messages'],
        multiple: true,
        connectionIds: ['gmail-disabled'],
      },
    ],
  });
  assert.deepEqual(storeCalls[1], [
    'updateAgentPermissions',
    {
      agentId: 'agent-1',
      connectionGrants: [],
    },
  ]);
});

test('personal agent IPC conversation channels delegate to the conversation manager with the renderer input', async () => {
  const { handlers, managerCalls } = createHarness();

  assert.deepEqual(
    await handlers.get(IPC_CHANNELS.personalAgentStartConversation)(null, { agentId: 'agent-1', prompt: 'hola' }),
    { conversationId: 'conv-9', agentId: 'agent-1' },
  );
  assert.deepEqual(
    await handlers.get(IPC_CHANNELS.personalAgentSendMessage)(null, { conversationId: 'conv-9', message: 'sigue' }),
    { conversationId: 'conv-9', accepted: true },
  );
  assert.deepEqual(
    await handlers.get(IPC_CHANNELS.personalAgentGetConversation)(null, { conversationId: 'conv-9' }),
    { conversationId: 'conv-9', messages: [] },
  );
  assert.deepEqual(managerCalls, [
    ['startConversation', { agentId: 'agent-1', prompt: 'hola' }],
    ['sendMessage', { conversationId: 'conv-9', message: 'sigue' }],
    ['getConversation', { conversationId: 'conv-9' }],
  ]);
});
