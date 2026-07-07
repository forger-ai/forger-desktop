import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  BUILT_IN_CONNECTION_MODULES,
} = require('../../dist-electron/main/connections/index.js');
const {
  ConnectionsService,
} = require('../../dist-electron/main/connections-service.js');
const {
  OfficialToolsService,
} = require('../../dist-electron/main/official-tools-service.js');
const {
  INTERNAL_TOOL_MODULES,
} = require('../../dist-electron/main/tools/index.js');

const createSecretsStore = () => {
  const values = new Map();
  return {
    values,
    async setConnectionSecret(connectionId, name, value) {
      values.set(`${connectionId}:${name}`, value);
      return { success: true, userMessage: 'ok' };
    },
    async getConnectionSecret(connectionId, name) {
      return values.get(`${connectionId}:${name}`) ?? null;
    },
    async hasConnectionSecret(connectionId, name) {
      return values.has(`${connectionId}:${name}`);
    },
    async deleteConnectionSecrets(connectionId) {
      for (const key of [...values.keys()]) {
        if (key.startsWith(`${connectionId}:`)) {
          values.delete(key);
        }
      }
      return { success: true, userMessage: 'ok' };
    },
  };
};

const fakeConnectionModule = {
  definition: {
    type: 'gmail',
    displayName: 'Gmail',
    description: 'Gmail accounts',
    setupKind: 'oauth',
    supportsMultiple: true,
    statusActionId: 'gmail.connection.status',
    secretsSchema: [
      { name: 'refresh_token', label: 'Refresh token', required: true, usage: 'Gmail OAuth refresh token.' },
    ],
    actions: [
      { id: 'gmail.connection.status', name: 'Status', description: 'Status', risk: 'low' },
      { id: 'gmail.search_messages', name: 'Search', description: 'Search messages', risk: 'medium' },
      { id: 'gmail.send_email', name: 'Send', description: 'Send email', risk: 'high' },
    ],
  },
  async configure(context, input) {
    const instance = await context.createInstance({
      type: 'gmail',
      label: input.label,
      accountIdentity: { email: input.email, subject: input.subject },
      secrets: { refresh_token: input.refreshToken },
    });
    return { success: true, userMessage: 'connected', instance };
  },
  async disconnect(context, input) {
    await context.deleteInstance(input.connectionId);
    return { success: true, userMessage: 'disconnected' };
  },
  async listInstances(context) {
    return context.listPersistedInstances('gmail');
  },
  async status(_context, input) {
    return {
      connected: Boolean(input.connectionId),
      status: input.connectionId ? 'connected' : 'needs_setup',
      accountIdentity: input.connectionId ? { email: 'safe@example.com' } : undefined,
    };
  },
  async execute(context, input) {
    if (input.actionId === 'gmail.connection.status') {
      return { success: true, data: await this.status(context, input) };
    }
    return { success: true, data: { connectionId: input.connectionId, actionId: input.actionId } };
  },
};

const createService = async (modules = [fakeConnectionModule]) => {
  const metadataRoot = await mkdtemp(join(tmpdir(), 'forger-connections-'));
  const service = new ConnectionsService({
    metadataRoot,
    secretsStore: createSecretsStore(),
    modules,
  });
  await service.load();
  return {
    service,
    metadataRoot,
    cleanup: async () => {
      await rm(metadataRoot, { recursive: true, force: true });
    },
  };
};

const createAppAwareService = async (declarations, modules = [fakeConnectionModule]) => {
  const metadataRoot = await mkdtemp(join(tmpdir(), 'forger-connections-'));
  const service = new ConnectionsService({
    metadataRoot,
    secretsStore: createSecretsStore(),
    modules,
    getAppConnectionDeclarations: async (appId) => (
      appId === 'finance-os'
        ? { appName: 'Finance OS', ...declarations }
        : null
    ),
  });
  await service.load();
  return {
    service,
    metadataRoot,
    cleanup: async () => {
      await rm(metadataRoot, { recursive: true, force: true });
    },
  };
};

test('built-in connection registry exposes external services but not Forger Chrome as a connection', () => {
  const types = BUILT_IN_CONNECTION_MODULES.map((module) => module.definition.type).sort();
  assert.deepEqual(types, [
    'calendar',
    'calendly',
    'discord',
    'docs',
    'drive',
    'figma',
    'github',
    'gitlab',
    'gmail',
    'meta_ads',
    'notion',
    'postmark',
    'sendgrid',
    'sheets',
    'shopify',
    'slack',
    'telegram',
    'trello',
    'twilio',
    'whatsapp',
    'whatsapp_business',
    'zendesk',
  ]);
  for (const module of BUILT_IN_CONNECTION_MODULES) {
    assert.equal(typeof module.definition.statusActionId, 'string');
    assert.ok(module.definition.actions.some((action) => action.id === module.definition.statusActionId));
    assert.ok(module.definition.setupKind);
    assert.ok(module.definition.actions.every((action) => action.risk));
  }
  assert.equal(types.includes('forger_chrome_extension'), false);
});

test('official tool registry keeps external services out of Forger Tools', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forger-official-tools-external-'));
  const service = new OfficialToolsService({
    metadataRoot: root,
    secretsStore: {
      ...createSecretsStore(),
      hasToolSecret: async () => false,
      getToolSecret: async () => null,
      setToolSecret: async () => ({ success: true, userMessage: 'ok' }),
      deleteToolSecrets: async () => ({ success: true, userMessage: 'ok' }),
    },
    getFreePort: async () => 1234,
    openExternalUrl: async () => undefined,
    isForgerAccountAuthenticated: () => true,
    getGmailOAuthClientId: async () => 'gmail-client-id',
    exchangeGmailOAuthCode: async () => ({ refresh_token: 'refresh-token' }),
    refreshGmailOAuthAccessToken: async () => ({ access_token: 'access-token' }),
    getAppToolDeclarations: async () => null,
  });
  try {
    const toolIds = INTERNAL_TOOL_MODULES.map((module) => module.definition.id);
    assert.equal(toolIds.includes('forger_chrome_extension'), true);
    assert.equal(toolIds.includes('gmail'), false);
    assert.equal(toolIds.includes('whatsapp'), false);
    assert.equal(toolIds.includes('slack'), false);
    assert.equal(toolIds.includes('trello'), false);

    const activated = await service.activate('gmail', 'en');
    assert.equal(activated.success, false);
    assert.equal(activated.technicalCode, 'tool_not_found');
    assert.equal(await service.getTool('gmail', 'en'), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('connection service stores multiple instances with safe identity and one default', async () => {
  const harness = await createService();
  try {
    const first = await harness.service.configure({
      type: 'gmail',
      label: 'Personal',
      email: 'person@example.com',
      subject: 'sub-1',
      refreshToken: 'refresh-1',
    });
    assert.equal(first.success, true);

    const second = await harness.service.configure({
      type: 'gmail',
      label: 'Work',
      email: 'work@example.com',
      subject: 'sub-2',
      refreshToken: 'refresh-2',
    });
    assert.equal(second.success, true);

    const instances = await harness.service.listInstances('gmail');
    assert.equal(instances.length, 2);
    assert.equal(instances.filter((instance) => instance.isDefault).length, 1);
    assert.deepEqual(
      instances.map((instance) => instance.accountIdentity.email).sort(),
      ['person@example.com', 'work@example.com'],
    );
    assert.equal(JSON.stringify(instances).includes('refresh-'), false);
  } finally {
    await harness.cleanup();
  }
});

test('connection status is safe without configured credentials', async () => {
  const harness = await createService();
  try {
    const result = await harness.service.call({
      type: 'gmail',
      actionId: 'gmail.connection.status',
      input: {},
    });
    assert.equal(result.success, true);
    assert.equal(result.data.connected, false);
    assert.equal(result.data.status, 'needs_setup');
    assert.equal(JSON.stringify(result).includes('refresh_token'), false);
  } finally {
    await harness.cleanup();
  }
});

test('connection secrets are isolated by connection instance and disconnect deletes only one instance', async () => {
  const harness = await createService();
  try {
    const first = await harness.service.configure({
      type: 'gmail',
      label: 'A',
      email: 'a@example.com',
      subject: 'sub-a',
      refreshToken: 'refresh-a',
    });
    const second = await harness.service.configure({
      type: 'gmail',
      label: 'B',
      email: 'b@example.com',
      subject: 'sub-b',
      refreshToken: 'refresh-b',
    });
    const firstId = first.instance.id;
    const secondId = second.instance.id;

    assert.equal(await harness.service.getSecretForTest(firstId, 'refresh_token'), 'refresh-a');
    assert.equal(await harness.service.getSecretForTest(secondId, 'refresh_token'), 'refresh-b');

    const disconnected = await harness.service.disconnect({ type: 'gmail', connectionId: firstId });
    assert.equal(disconnected.success, true);
    assert.equal(await harness.service.getSecretForTest(firstId, 'refresh_token'), null);
    assert.equal(await harness.service.getSecretForTest(secondId, 'refresh_token'), 'refresh-b');
    assert.deepEqual((await harness.service.listInstances('gmail')).map((instance) => instance.id), [secondId]);
  } finally {
    await harness.cleanup();
  }
});

test('multi-account calls without connection id use default and fail when no default is available', async () => {
  const harness = await createService();
  try {
    const first = await harness.service.configure({
      type: 'gmail',
      label: 'A',
      email: 'a@example.com',
      subject: 'sub-a',
      refreshToken: 'refresh-a',
    });
    const second = await harness.service.configure({
      type: 'gmail',
      label: 'B',
      email: 'b@example.com',
      subject: 'sub-b',
      refreshToken: 'refresh-b',
    });
    const defaulted = await harness.service.call({
      type: 'gmail',
      actionId: 'gmail.search_messages',
      input: { query: 'from:example.com' },
      grant: {
        type: 'gmail',
        actions: ['gmail.search_messages'],
        multiple: true,
        connectionIds: [first.instance.id, second.instance.id],
      },
    });
    assert.equal(defaulted.success, true);
    assert.equal(defaulted.data.connectionId, first.instance.id);

    await harness.service.clearDefaultForTest('gmail');

    const result = await harness.service.call({
      type: 'gmail',
      actionId: 'gmail.search_messages',
      input: { query: 'from:example.com' },
      grant: {
        type: 'gmail',
        actions: ['gmail.search_messages'],
        multiple: true,
        connectionIds: [first.instance.id, second.instance.id],
      },
    });
    assert.equal(result.success, false);
    assert.equal(result.technicalCode, 'connection_default_missing');
    assert.deepEqual(result.data.connections.map((connection) => connection.label).sort(), ['A', 'B']);
    assert.equal(JSON.stringify(result).includes('refresh-'), false);
  } finally {
    await harness.cleanup();
  }
});

test('app connection calls enforce required and optional manifest grants', async () => {
  const harness = await createAppAwareService({
    required: [
      {
        type: 'gmail',
        reason: 'Read customer messages.',
        actions: ['gmail.search_messages'],
        multiple: false,
      },
    ],
    optional: [
      {
        type: 'gmail',
        reason: 'Send approved replies.',
        actions: ['gmail.send_email'],
        multiple: false,
      },
    ],
  });
  try {
    const configured = await harness.service.configure({
      type: 'gmail',
      label: 'Work',
      email: 'work@example.com',
      subject: 'sub-work',
      refreshToken: 'refresh-work',
    });
    assert.equal(configured.success, true);

    const allowed = await harness.service.callFromApp('finance-os', {
      type: 'gmail',
      actionId: 'gmail.search_messages',
      input: { query: 'from:client@example.com' },
    });
    assert.equal(allowed.success, true);

    const denied = await harness.service.callFromApp('finance-os', {
      type: 'gmail',
      actionId: 'gmail.send_email',
      input: { to: 'client@example.com' },
    });
    assert.equal(denied.success, false);
    assert.equal(denied.technicalCode, 'app_connection_action_not_declared');
  } finally {
    await harness.cleanup();
  }
});

test('optional app connection grants freeze resolved actions at approval time', async () => {
  const harness = await createAppAwareService({
    required: [],
    optional: [
      {
        type: 'gmail',
        reason: 'Use selected mail actions.',
        actions: ['*'],
        multiple: true,
      },
    ],
  });
  try {
    const configured = await harness.service.configure({
      type: 'gmail',
      label: 'Work',
      email: 'work@example.com',
      subject: 'sub-work',
      refreshToken: 'refresh-work',
    });
    assert.equal(configured.success, true);

    const beforeGrant = await harness.service.callFromApp('finance-os', {
      type: 'gmail',
      actionId: 'gmail.search_messages',
      input: {},
    });
    assert.equal(beforeGrant.success, false);
    assert.equal(beforeGrant.technicalCode, 'app_connection_permission_denied');

    const grant = await harness.service.setAppConnectionGrant({
      appId: 'finance-os',
      type: 'gmail',
      granted: true,
      connectionIds: [configured.instance.id],
    });
    assert.equal(grant.granted, true);

    const afterGrant = await harness.service.callFromApp('finance-os', {
      type: 'gmail',
      actionId: 'gmail.search_messages',
      input: {},
    });
    assert.equal(afterGrant.success, true);

    const unknownFutureAction = await harness.service.callFromApp('finance-os', {
      type: 'gmail',
      actionId: 'gmail.delete_message',
      input: {},
    });
    assert.equal(unknownFutureAction.success, false);
    assert.equal(unknownFutureAction.technicalCode, 'app_connection_action_not_declared');
  } finally {
    await harness.cleanup();
  }
});
