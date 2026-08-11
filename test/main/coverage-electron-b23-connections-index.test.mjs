import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { BUILT_IN_CONNECTION_MODULES } = require('../../dist-electron/main/connections/index.js');
const { gmailToolModule } = require('../../dist-electron/main/connections/modules/gmail/index.js');

const createContext = (seed = []) => {
  const instances = [...seed];
  const secrets = new Map();
  const calls = [];
  let nextId = 1;
  const context = {
    metadataRoot: '/private/metadata',
    locale: 'es',
    calls,
    instances,
    secretsStore: {
      setConnectionSecret: async (connectionId, name, value) => {
        calls.push(['secret:set', connectionId, name, value]);
        secrets.set(`${connectionId}:${name}`, value);
        return { success: true, userMessage: 'stored' };
      },
      getConnectionSecret: async (connectionId, name) => {
        calls.push(['secret:get', connectionId, name]);
        return secrets.get(`${connectionId}:${name}`) ?? null;
      },
      hasConnectionSecret: async (connectionId, name) => {
        calls.push(['secret:has', connectionId, name]);
        return secrets.has(`${connectionId}:${name}`);
      },
      deleteConnectionSecrets: async (connectionId) => {
        calls.push(['secret:delete', connectionId]);
        return { success: true, userMessage: 'deleted' };
      },
    },
    listPersistedInstances: async (type) => {
      calls.push(['instances:list', type]);
      return instances.filter((instance) => instance.type === type);
    },
    createInstance: async (input) => {
      const instance = {
        id: `connection-${nextId++}`,
        type: input.type,
        label: input.label,
        status: input.status,
        isDefault: instances.every((candidate) => candidate.type !== input.type),
        ...(input.accountIdentity ? { accountIdentity: input.accountIdentity } : {}),
      };
      calls.push(['instance:create', input]);
      instances.push(instance);
      return instance;
    },
    updateInstance: async (id, patch) => {
      calls.push(['instance:update', id, patch]);
      const index = instances.findIndex((instance) => instance.id === id);
      if (index < 0) return null;
      instances[index] = { ...instances[index], ...patch };
      return instances[index];
    },
    deleteInstance: async (id, options) => {
      calls.push(['instance:delete', id, options]);
      const index = instances.findIndex((instance) => instance.id === id);
      if (index >= 0) instances.splice(index, 1);
      return true;
    },
    setSecret: async (connectionId, name, value) => {
      calls.push(['setSecret', connectionId, name, value]);
      secrets.set(`${connectionId}:${name}`, value);
    },
    getFreePort: async () => 43123,
    openExternalUrl: async (url) => calls.push(['external', url]),
    isForgerAccountAuthenticated: () => true,
    getGmailOAuthClientId: () => 'client-id',
    exchangeGmailOAuthCode: async () => ({}),
    refreshGmailOAuthAccessToken: async () => ({}),
    appendLog: async (...args) => calls.push(['log', ...args]),
    emitEvent: (...args) => calls.push(['event', ...args]),
  };
  return context;
};

test('Given the built-in connection adapter, when accounts are configured, checked, called, started, and removed, then aliases and lifecycle boundaries remain safe', async () => {
  const gmail = BUILT_IN_CONNECTION_MODULES.find(({ definition }) => definition.type === 'gmail');
  assert.ok(gmail);
  assert.equal(gmail.definition.statusActionId, 'gmail.connection.status');
  assert.equal(gmail.definition.oauth.callbackPath, '/oauth/gmail/callback');

  const originals = {
    configure: gmailToolModule.configure,
    execute: gmailToolModule.execute,
    deactivate: gmailToolModule.deactivate,
    start: gmailToolModule.start,
    stop: gmailToolModule.stop,
  };
  const statusResults = [];
  let configureResult = { success: true, userMessage: 'connected' };
  gmailToolModule.configure = async (toolContext) => {
    await toolContext.secretsStore.setToolSecret('ignored', 'configured', 'yes');
    assert.equal(await toolContext.secretsStore.getToolSecret('ignored', 'configured'), 'yes');
    assert.equal(await toolContext.secretsStore.hasToolSecret('ignored', 'configured'), true);
    return configureResult;
  };
  gmailToolModule.execute = async (input, toolContext) => {
    if (input.actionId === 'gmail.connection.status') {
      return statusResults.shift() ?? { success: true, data: { connected: true } };
    }
    return { success: true, data: { actionId: input.actionId, metadataRoot: toolContext.metadataRoot } };
  };
  gmailToolModule.deactivate = async (toolContext) => {
    await toolContext.secretsStore.deleteToolSecrets('ignored');
  };
  gmailToolModule.start = async (toolContext) => {
    assert.match(toolContext.metadataRoot, /connections\/gmail/);
  };
  gmailToolModule.stop = async (toolContext) => {
    assert.match(toolContext.metadataRoot, /connections\/gmail/);
  };

  try {
    const context = createContext();
    context.selfOAuthCallbackService = { callbackUrl: () => 'http://127.0.0.1/callback' };

    statusResults.push({ success: true, data: { connected: true, email: 'owner@example.com', workspace: 'Team', username: 'User' } });
    const created = await gmail.configure(context, {
      type: 'gmail',
      label: '',
      accountIdentity: { subject: ' subject ', email: ' owner@example.com ', phoneNumber: ' +1 ', team: ' Team ', user: ' User ' },
      secrets: { token: 'initial' },
    });
    assert.equal(created.success, true);
    assert.equal(created.instance.label, 'owner@example.com');
    assert.equal(created.instance.accountIdentity.workspace, 'Team');
    assert.equal(created.instance.accountIdentity.username, 'User');
    assert.deepEqual(await gmail.listInstances(context), context.instances);

    statusResults.push({ success: false, userMessage: 'expired', technicalCode: 'token_expired' });
    const failedStatus = await gmail.status(context, { type: 'gmail', connectionId: created.instance.id });
    assert.deepEqual(failedStatus, {
      connected: false,
      status: 'error',
      message: 'expired',
      technicalCode: 'token_expired',
      accountIdentity: created.instance.accountIdentity,
    });

    statusResults.push({ success: true, data: { connected: false, qrAvailable: true, phoneNumber: '+2' } });
    assert.equal((await gmail.status(context, { type: 'gmail' })).status, 'connecting');
    statusResults.push({ success: true, data: { connected: false, needsReconnect: true, workspace: 'Workspace' } });
    assert.equal((await gmail.status(context, { type: 'gmail' })).status, 'needs_reconnect');
    statusResults.push({ success: true, data: { connected: false, configured: true, technicalCode: 'refresh_needed' } });
    assert.equal((await gmail.status(context, { type: 'gmail' })).status, 'needs_reconnect');
    statusResults.push({ success: true, data: { connected: false, configured: false } });
    assert.equal((await gmail.status(context, { type: 'gmail' })).status, 'needs_setup');
    statusResults.push({ success: true, data: null });
    assert.equal((await gmail.status(context, { type: 'gmail' })).status, 'needs_setup');
    assert.deepEqual(await gmail.status(context, { type: 'gmail', connectionId: 'missing' }), {
      connected: false,
      status: 'needs_setup',
    });

    statusResults.push({ success: true, data: { connected: true, username: 'Updated User' } });
    const updated = await gmail.configure(context, {
      type: 'gmail',
      connectionId: ` ${created.instance.id} `,
      label: 'Updated account',
      accountIdentity: { teamName: 'Fallback team', fullName: 'Fallback name' },
      secrets: { ' token ': 'next', empty: '', '   ': 'ignored' },
    });
    assert.equal(updated.success, true);
    assert.ok(context.calls.some((call) => call[0] === 'setSecret' && call[2] === 'token'));

    statusResults.push({ success: true, data: { connected: true } });
    assert.equal((await gmail.configure(context, {
      type: 'gmail', connectionId: 'missing', label: 'Created after lookup', secrets: {},
    })).success, true);

    const nullUpdates = createContext([{ id: 'existing-null', type: 'gmail', label: 'Existing', status: 'connected', isDefault: true }]);
    nullUpdates.updateInstance = async () => null;
    statusResults.push({ success: true, data: { connected: true } });
    assert.equal((await gmail.configure(nullUpdates, {
      type: 'gmail', connectionId: 'existing-null', label: '', secrets: {},
    })).success, true);

    const nullStatusUpdate = createContext([{ id: 'status-null', type: 'gmail', label: 'Status', status: 'connected', isDefault: true }]);
    nullStatusUpdate.updateInstance = async () => null;
    statusResults.push({ success: true, data: { connected: true } });
    assert.equal((await gmail.status(nullStatusUpdate, { type: 'gmail' })).connected, true);

    configureResult = { success: false, userMessage: 'invalid', technicalCode: 'invalid_credentials' };
    const failedExisting = await gmail.configure(context, {
      type: 'gmail', connectionId: created.instance.id, secrets: {},
    });
    assert.equal(failedExisting.success, false);
    const failedNew = await gmail.configure(context, {
      type: 'gmail', label: 'New', accountIdentity: [], secrets: {},
    });
    assert.equal(failedNew.success, false);

    assert.deepEqual(await gmail.status(createContext(), { type: 'gmail' }), { connected: false, status: 'needs_setup' });
    assert.equal((await gmail.execute(createContext(), { type: 'gmail', actionId: 'gmail.get_profile', input: {} })).technicalCode, 'connection_not_configured');

    const action = await gmail.execute(context, {
      type: 'gmail',
      connectionId: created.instance.id,
      actionId: 'gmail.get_profile',
      input: { detail: true },
    });
    assert.equal(action.success, true);
    assert.match(action.data.metadataRoot, new RegExp(created.instance.id));

    statusResults.push({ success: true, data: { connected: true, username: 'Action status' } });
    assert.equal((await gmail.execute(context, {
      type: 'gmail', connectionId: created.instance.id, actionId: 'gmail.connection.status', input: {},
    })).data.connected, true);

    await gmail.start(context);
    await gmail.stop(context);
    const disconnected = await gmail.disconnect(context, {
      type: 'gmail', connectionId: created.instance.id, keepSecrets: true,
    });
    assert.equal(disconnected.success, true);
    assert.ok(context.calls.some((call) => call[0] === 'secret:delete'));

    delete gmailToolModule.deactivate;
    delete gmailToolModule.start;
    delete gmailToolModule.stop;
    await gmail.disconnect(createContext([{ id: 'plain', type: 'gmail', label: 'Plain', status: 'connected' }]), {
      type: 'gmail', connectionId: 'plain', keepSecrets: false,
    });
    await gmail.start(createContext());
    await gmail.stop(createContext());
  } finally {
    Object.assign(gmailToolModule, originals);
  }
});
