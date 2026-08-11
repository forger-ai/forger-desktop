import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ConnectionsService } = require('../../dist-electron/main/connections-service.js');

const definition = {
  type: 'demo',
  displayName: 'Demo Connection',
  description: 'Demo',
  setupKind: 'oauth',
  supportsMultiple: true,
  statusActionId: 'demo.status',
  oauth: { callbackPath: '/oauth/demo/callback' },
  secretsSchema: [],
  actions: [
    { id: 'demo.status', name: 'Status', description: 'Status', risk: 'low' },
    { id: 'demo.use', name: 'Use', description: 'Use', risk: 'medium' },
    { id: 'demo.other', name: 'Other', description: 'Other', risk: 'high' },
  ],
};

const createSecretsStore = (overrides = {}) => {
  const values = new Map();
  return {
    values,
    async setConnectionSecret(id, name, value) { values.set(`${id}:${name}`, value); return { success: true }; },
    async getConnectionSecret(id, name) { return values.get(`${id}:${name}`) ?? null; },
    async hasConnectionSecret(id, name) { return values.has(`${id}:${name}`); },
    async deleteConnectionSecrets(id) {
      for (const key of values.keys()) if (key.startsWith(`${id}:`)) values.delete(key);
      return { success: true };
    },
    ...overrides,
  };
};

const makeModule = (overrides = {}) => ({
  definition,
  async configure(context, input) {
    const instance = await context.createInstance({
      type: 'demo',
      label: input.label,
      accountIdentity: input.accountIdentity,
      status: input.status,
      secrets: input.secrets,
    });
    return { success: true, userMessage: 'configured', instance };
  },
  async disconnect(context, input) {
    await context.deleteInstance(input.connectionId, input.options);
    return { success: true, userMessage: 'disconnected' };
  },
  async listInstances(context) { return await context.listPersistedInstances('demo'); },
  async status(_context, input) { return { connected: Boolean(input.connectionId), status: input.connectionId ? 'connected' : 'needs_setup' }; },
  async execute(context, input) {
    if (input.actionId === 'demo.status') return { success: true, data: await this.status(context, input) };
    return { success: true, data: input };
  },
  ...overrides,
});

const createHarness = async (overrides = {}) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forger-connections-b17-'));
  const secretsStore = overrides.secretsStore ?? createSecretsStore();
  const service = new ConnectionsService({
    metadataRoot: root,
    secretsStore,
    modules: overrides.modules ?? [makeModule()],
    locale: overrides.locale,
    getAppConnectionDeclarations: overrides.getAppConnectionDeclarations,
    getFreePort: overrides.getFreePort,
    openExternalUrl: overrides.openExternalUrl,
    isForgerAccountAuthenticated: overrides.isForgerAccountAuthenticated,
    getGmailOAuthClientId: overrides.getGmailOAuthClientId,
    exchangeGmailOAuthCode: overrides.exchangeGmailOAuthCode,
    refreshGmailOAuthAccessToken: overrides.refreshGmailOAuthAccessToken,
    selfOAuthCallbackService: overrides.selfOAuthCallbackService,
    appendLog: overrides.appendLog,
    emitEvent: overrides.emitEvent,
  });
  return { root, service, secretsStore, cleanup: async () => await fs.rm(root, { recursive: true, force: true }) };
};

const declarations = {
  appName: 'Demo App',
  required: [{ type: 'demo', actions: ['demo.use'], multiple: true }],
  optional: [{ type: 'demo', actions: ['demo.other'], multiple: true }],
};

test('given service lifecycle and unknown types, load is idempotent and state/configure/disconnect errors are explicit', async () => {
  const harness = await createHarness();
  try {
    await harness.service.load();
    await harness.service.load();
    const state = await harness.service.listState('es');
    assert.equal(state.types[0].type, 'demo');
    assert.deepEqual(state.instances, []);
    assert.equal((await harness.service.configure({ type: 'missing' })).technicalCode, 'connection_type_not_found');
    assert.equal((await harness.service.disconnect({ type: 'missing', connectionId: 'none' })).technicalCode, 'connection_type_not_found');
    await assert.rejects(() => harness.service.createInstance({ type: 'missing' }), /connection_type_not_found/);
  } finally {
    await harness.cleanup();
  }
});

test('given account identities and secrets, labels sanitize, defaults persist, updates merge, and deletion advances or clears default', async () => {
  const harness = await createHarness();
  try {
    const identities = [
      { input: { label: ' Explicit ' }, label: 'Explicit' },
      { input: { accountIdentity: { email: ' mail@example.com ', ignored: 'secret' } }, label: 'mail@example.com' },
      { input: { accountIdentity: { workspace: ' Workspace ' } }, label: 'Workspace' },
      { input: { accountIdentity: { username: ' handle ' } }, label: 'handle' },
      { input: { accountIdentity: { phoneNumber: ' +123 ' } }, label: 'Demo Connection' },
      { input: { accountIdentity: [] }, label: 'Demo Connection' },
    ];
    const created = [];
    for (const item of identities) {
      created.push(await harness.service.createInstance({
        type: 'demo',
        ...item.input,
        secrets: { ' token ': 'value', ' ': 'ignored', empty: '' },
      }));
      assert.equal(created.at(-1).label, item.label);
    }
    assert.equal(created[0].isDefault, true);
    assert.equal(created.slice(1).every((instance) => !instance.isDefault), true);
    assert.equal(await harness.service.getSecretForTest(created[0].id, 'token'), 'value');
    assert.equal(await harness.service.updateInstance('missing', {}), null);
    const updated = await harness.service.updateInstance(created[0].id, {
      label: ' Updated ',
      accountIdentity: { subject: ' sub ', phoneNumber: ' 555 ' },
      status: 'needs_setup',
      lastCheckedAt: '2026-08-10T01:00:00.000Z',
    });
    assert.equal(updated.label, 'Updated');
    assert.deepEqual(updated.accountIdentity, { subject: 'sub', phoneNumber: '555' });

    assert.equal((await harness.service.setDefaultConnection({ type: 'demo', connectionId: 'missing' })).technicalCode, 'connection_instance_not_found');
    assert.equal((await harness.service.setDefaultConnection({ type: 'other', connectionId: created[1].id })).technicalCode, 'connection_instance_not_found');
    assert.equal((await harness.service.setDefaultConnection({ type: 'demo', connectionId: created[1].id })).success, true);
    await assert.rejects(() => harness.service.setDefault('other', created[1].id), /connection_instance_not_found/);

    await harness.service.deleteInstance('missing');
    await harness.service.deleteInstance(created[1].id, { keepSecrets: true });
    assert.equal((await harness.service.listInstances('demo')).some((item) => item.id === created[1].id), false);
    for (const instance of created.filter((item) => item.id !== created[1].id)) await harness.service.deleteInstance(instance.id);
    assert.deepEqual(await harness.service.listInstances(), []);
  } finally {
    await harness.cleanup();
  }
});

test('given default context fallbacks and explicit integrations, every connection module bridge delegates safely', async () => {
  const harness = await createHarness();
  try {
    const context = harness.service.getContext();
    assert.equal(await context.getFreePort(), 0);
    assert.equal(await context.openExternalUrl('https://example.com'), undefined);
    assert.equal(context.isForgerAccountAuthenticated(), true);
    assert.equal(await context.getGmailOAuthClientId(), '');
    assert.deepEqual(await context.exchangeGmailOAuthCode({}), {});
    assert.deepEqual(await context.refreshGmailOAuthAccessToken({}), {});
    const instance = await context.createInstance({ type: 'demo', label: 'Bridge' });
    await context.setSecret(instance.id, 'token', 'secret');
    assert.equal(await context.getSecret(instance.id, 'token'), 'secret');
    assert.equal((await context.listPersistedInstances('demo')).length, 1);
    await context.setDefault('demo', instance.id);
    await context.deleteInstance(instance.id);
  } finally {
    await harness.cleanup();
  }

  const calls = [];
  const integrated = await createHarness({
    getFreePort: async () => 4321,
    openExternalUrl: async (url) => calls.push(url),
    isForgerAccountAuthenticated: () => false,
    getGmailOAuthClientId: async () => 'client',
    exchangeGmailOAuthCode: async () => ({ access_token: 'access' }),
    refreshGmailOAuthAccessToken: async () => ({ access_token: 'refresh' }),
    selfOAuthCallbackService: { getState: () => null, callbackUrl: () => null },
  });
  try {
    const context = integrated.service.getContext();
    assert.equal(await context.getFreePort(), 4321);
    await context.openExternalUrl('https://forger.test');
    assert.deepEqual(calls, ['https://forger.test']);
    assert.equal(context.isForgerAccountAuthenticated(), false);
    assert.equal(await context.getGmailOAuthClientId(), 'client');
    assert.equal((await context.exchangeGmailOAuthCode({})).access_token, 'access');
    assert.equal((await context.refreshGmailOAuthAccessToken({})).access_token, 'refresh');
    assert.equal(context.selfOAuthCallbackService !== undefined, true);
  } finally {
    await integrated.cleanup();
  }
});

test('given action calls, missing types/actions/grants/configuration and status normalization use stable result contracts', async () => {
  const harness = await createHarness();
  try {
    assert.equal((await harness.service.call({ type: 'missing', actionId: 'x' })).technicalCode, 'connection_type_not_found');
    assert.equal((await harness.service.call({ type: 'demo', actionId: 'missing' })).technicalCode, 'connection_action_not_found');
    assert.equal((await harness.service.call({ type: 'demo', actionId: 'demo.use', grant: { type: 'other', actions: ['demo.use'], multiple: true } })).technicalCode, 'connection_action_not_granted');
    assert.equal((await harness.service.call({ type: 'demo', actionId: 'demo.use', grant: { type: 'demo', actions: [], multiple: true } })).technicalCode, 'connection_action_not_granted');
    assert.equal((await harness.service.call({ type: 'demo', actionId: 'demo.use' })).technicalCode, 'connection_not_configured');
    const status = await harness.service.call({ type: 'demo', actionId: 'demo.status' });
    assert.equal(status.data.status, 'needs_setup');

    const disconnected = await harness.service.createInstance({ type: 'demo', label: 'Offline', status: 'needs_setup' });
    assert.equal((await harness.service.call({ type: 'demo', actionId: 'demo.use', connectionId: disconnected.id })).technicalCode, 'connection_not_connected');
    assert.equal((await harness.service.call({ type: 'demo', actionId: 'demo.use', connectionId: 'missing' })).technicalCode, 'connection_not_granted');
    const setup = await harness.service.resolveConnectionId('demo', disconnected.id, undefined, { requireConnected: false });
    assert.equal(setup, disconnected.id);
  } finally {
    await harness.cleanup();
  }
});

test('given app configuration declarations, absent apps/types/modules and non-OAuth setup cannot bypass the manifest', async () => {
  const noDeclarations = await createHarness();
  try {
    assert.equal((await noDeclarations.service.configureFromApp('app', { type: 'demo' })).technicalCode, 'app_connections_not_declared');
  } finally {
    await noDeclarations.cleanup();
  }

  for (const mode of ['missing-declaration', 'missing-module', 'not-oauth', 'success']) {
    const module = makeModule(mode === 'not-oauth' ? { definition: { ...definition, setupKind: 'api_key' } } : {});
    const harness = await createHarness({
      modules: mode === 'missing-module' ? [] : [module],
      getAppConnectionDeclarations: async () => mode === 'missing-declaration'
        ? { appName: 'App', required: [], optional: [] }
        : declarations,
    });
    try {
      const result = await harness.service.configureFromApp('app', { type: 'demo', label: mode === 'success' ? ' App label ' : '', connectionId: ' existing ' });
      const expected = {
        'missing-declaration': 'app_connection_not_declared',
        'missing-module': 'connection_type_not_found',
        'not-oauth': 'connection_setup_not_oauth',
      }[mode];
      if (expected) assert.equal(result.technicalCode, expected);
      else {
        assert.equal(result.instance.label, 'App label');
        const unlabeled = await harness.service.configureFromApp('app', { type: 'demo' });
        assert.equal(unlabeled.instance.label, 'Demo Connection');
      }
    } finally {
      await harness.cleanup();
    }
  }
});

test('given session grants, ungranted calls fail and connected account filtering honors type and id scopes', async () => {
  const harness = await createHarness();
  try {
    const connected = await harness.service.createInstance({ type: 'demo', label: 'Connected' });
    const offline = await harness.service.createInstance({ type: 'demo', label: 'Offline', status: 'needs_setup' });
    assert.equal((await harness.service.callFromSession({ type: 'demo', actionId: 'demo.use' }, [])).technicalCode, 'connection_action_not_granted');
    const grant = { type: 'demo', actions: ['demo.use'], multiple: true, connectionIds: [connected.id, offline.id] };
    const result = await harness.service.callFromSession({ type: 'demo', actionId: 'demo.use', connectionId: connected.id, input: { value: 1 } }, [grant]);
    assert.equal(result.success, true);
    const listed = await harness.service.listConnectionsForSession([
      grant,
      { type: 'missing', actions: ['x'], multiple: false },
    ]);
    assert.deepEqual(listed.instances.map((instance) => instance.id), [connected.id]);
    assert.deepEqual(listed.types.map((type) => type.type), ['demo']);
  } finally {
    await harness.cleanup();
  }
});

test('given malformed registry JSON and partial object fields, reads recover with safe empty maps', async () => {
  for (const value of ['bad-json', '[]', JSON.stringify({ instances: [], defaults: null, appGrants: 'bad', agentGrants: 1 })]) {
    const harness = await createHarness();
    try {
      await fs.writeFile(path.join(harness.root, 'connections.json'), value);
      harness.service.loaded = false;
      await harness.service.load();
      assert.deepEqual(await harness.service.listInstances(), []);
      assert.deepEqual(harness.service.registry.defaults, {});
      assert.deepEqual(harness.service.registry.appGrants, {});
      assert.deepEqual(harness.service.registry.agentGrants, {});
    } finally {
      await harness.cleanup();
    }
  }
});

test('given OAuth callback state, current and previous callback URLs expose port-change metadata without secrets', async () => {
  for (const mode of ['full', 'empty']) {
    const harness = await createHarness({
      selfOAuthCallbackService: {
        getState: () => mode === 'full' ? { previousPort: 4100, portChanged: true } : null,
        callbackUrl: (callbackPath) => mode === 'full' ? `http://127.0.0.1:4200${callbackPath}` : null,
      },
    });
    try {
      const [type] = await harness.service.listTypes();
      if (mode === 'full') {
        assert.equal(type.oauth.callbackUrl, 'http://127.0.0.1:4200/oauth/demo/callback');
        assert.equal(type.oauth.previousCallbackUrl, 'http://127.0.0.1:4100/oauth/demo/callback');
        assert.equal(type.oauth.callbackPortChanged, true);
      } else {
        assert.equal(type.oauth.callbackUrl, undefined);
      }
    } finally {
      await harness.cleanup();
    }
  }
});

test('given an app without connection declarations, every app-facing read, grant, and call stays empty or denied', async () => {
  const harness = await createHarness();
  try {
    assert.deepEqual(await harness.service.listConnectionsForApp('missing-app'), {
      types: [],
      instances: [],
      requirements: [],
    });
    assert.deepEqual(await harness.service.listSessionGrantsForApp('missing-app'), []);
    assert.equal(await harness.service.setAppConnectionGrant({
      appId: 'missing-app',
      type: 'demo',
      granted: true,
    }), null);
    assert.equal((await harness.service.callFromApp('missing-app', {
      type: 'demo',
      actionId: 'demo.use',
    })).technicalCode, 'app_connections_not_declared');
  } finally {
    await harness.cleanup();
  }
});

test('given required and optional declarations, app permissions expose defaults, denial, persistence, review, and merged sessions', async () => {
  const declared = {
    appName: 'Permission App',
    required: [{ type: 'demo', actions: ['demo.use'], multiple: false }],
    optional: [{ type: 'demo', actions: ['demo.other'], multiple: true }],
  };
  const harness = await createHarness({ getAppConnectionDeclarations: async () => declared });
  try {
    assert.equal((await harness.service.callFromApp('app', {
      type: 'missing',
      actionId: 'missing.use',
    })).technicalCode, 'app_connection_not_declared');
    assert.equal((await harness.service.callFromApp('app', {
      type: 'demo',
      actionId: 'demo.status',
    })).technicalCode, 'app_connection_action_not_declared');
    assert.equal((await harness.service.callFromApp('app', {
      type: 'demo',
      actionId: 'demo.other',
    })).technicalCode, 'app_connection_permission_denied');
    assert.equal(await harness.service.setAppConnectionGrant({
      appId: 'app',
      type: 'missing',
      granted: true,
    }), null);

    const defaulted = await harness.service.listConnectionsForApp('app', { defaultOptionalGrants: true });
    assert.equal(defaulted.requirements.length, 2);
    assert.equal(defaulted.requirements.every((item) => item.granted), true);
    assert.equal(defaulted.requirements.every((item) => !item.configured), true);

    const connected = await harness.service.createInstance({ type: 'demo', label: 'Scoped' });
    const optional = await harness.service.setAppConnectionGrant({
      appId: 'app',
      type: 'demo',
      granted: true,
      connectionIds: [connected.id],
    });
    assert.equal(optional.hasStoredGrant, true);
    assert.deepEqual(optional.instances.map((item) => item.id), [connected.id]);
    assert.equal((await harness.service.callFromApp('app', {
      type: 'demo',
      actionId: 'demo.other',
    })).success, true);

    const sessions = await harness.service.listSessionGrantsForApp('app');
    assert.deepEqual(sessions, [{
      type: 'demo',
      actions: ['demo.use', 'demo.other'],
      multiple: true,
      connectionIds: [connected.id],
    }]);

    harness.service.registry.appGrants.app.demo = {
      ...harness.service.registry.appGrants.app.demo,
      requestedActions: ['demo.other'],
      resolvedActions: [],
      actionCatalogHash: 'stale',
    };
    const reviewed = await harness.service.listConnectionsForApp('app');
    assert.equal(reviewed.requirements.find((item) => !item.required).reviewNeeded, true);
  } finally {
    await harness.cleanup();
  }
});

test('given missing connection definitions and wildcard grant history, requirements remain safe and stale approvals do not expand', async () => {
  const wildcard = { type: 'missing', actions: ['*'], multiple: false };
  const harness = await createHarness({
    getAppConnectionDeclarations: async () => ({ appName: 'Unknown', required: [wildcard], optional: [] }),
  });
  try {
    const result = await harness.service.listConnectionsForApp('app');
    assert.equal(result.requirements[0].definition, undefined);
    assert.deepEqual(result.requirements[0].resolvedActions, []);
    assert.equal(result.requirements[0].allActions, true);

    const stored = {
      type: 'demo',
      granted: true,
      multiple: false,
      connectionIds: [],
      requestedActions: ['demo.use'],
      resolvedActions: ['demo.use'],
      actionCatalogHash: 'old',
    };
    harness.service.registry.appGrants.app = { demo: stored };
    assert.equal(harness.service.getStoredGrantForDeclaration('app', {
      type: 'demo', actions: ['*'], multiple: false,
    }), undefined);
    stored.requestedActions = ['*'];
    assert.equal(harness.service.getStoredGrantForDeclaration('app', {
      type: 'demo', actions: ['*'], multiple: false,
    }), stored);
    assert.equal(harness.service.storedGrantNeedsReview(stored, {
      type: 'demo', actions: ['*'], multiple: false,
    }), false);

    stored.requestedActions = ['not-declared'];
    stored.resolvedActions = ['demo.other'];
    assert.equal(harness.service.getStoredGrantForDeclaration('app', {
      type: 'demo', actions: ['demo.other'], multiple: false,
    }), stored);
    stored.resolvedActions = ['not-declared'];
    assert.equal(harness.service.getStoredGrantForDeclaration('app', {
      type: 'demo', actions: ['demo.other'], multiple: false,
    }), undefined);
  } finally {
    await harness.cleanup();
  }
});

test('given required-only and optional-only declarations, effective app grants do not invent the missing half', async () => {
  for (const bucket of ['required', 'optional']) {
    const harness = await createHarness({
      getAppConnectionDeclarations: async () => ({
        appName: 'Single Grant',
        required: bucket === 'required' ? [{ type: 'demo', actions: ['demo.use'], multiple: false }] : [],
        optional: bucket === 'optional' ? [{ type: 'demo', actions: ['demo.other'], multiple: false }] : [],
      }),
    });
    try {
      const actionId = bucket === 'required' ? 'demo.use' : 'demo.other';
      const result = await harness.service.callFromApp('app', { type: 'demo', actionId });
      assert.equal(result.technicalCode, bucket === 'required'
        ? 'connection_not_configured'
        : 'app_connection_permission_denied');
    } finally {
      await harness.cleanup();
    }
  }
});

test('given mixed connection types and incomplete defaults, session views and resolution distinguish scope from connectivity', async () => {
  const otherDefinition = {
    ...definition,
    type: 'other',
    displayName: 'Other',
    statusActionId: 'other.status',
    actions: [{ id: 'other.status', name: 'Status', description: 'Status', risk: 'low' }],
  };
  const harness = await createHarness({
    modules: [makeModule(), makeModule({ definition: otherDefinition })],
  });
  try {
    const connected = await harness.service.createInstance({ type: 'demo', label: 'Connected' });
    await harness.service.createInstance({ type: 'other', label: 'Other account' });
    const offline = await harness.service.createInstance({ type: 'demo', label: 'Offline', status: 'needs_setup' });
    const listed = await harness.service.listConnectionsForSession([
      { type: 'demo', actions: ['demo.use'], multiple: true },
    ]);
    assert.deepEqual(listed.instances.map((item) => item.id), [connected.id]);

    await harness.service.clearDefaultForTest('demo');
    assert.equal((await harness.service.resolveConnectionId('demo')).technicalCode, 'connection_default_missing');
    await harness.service.deleteInstance(connected.id);
    assert.equal((await harness.service.resolveConnectionId('demo')).technicalCode, 'connection_not_connected');
    assert.equal(await harness.service.resolveConnectionId('missing'), null);

    const unchanged = await harness.service.updateInstance(offline.id, {});
    assert.equal(unchanged.id, offline.id);
  } finally {
    await harness.cleanup();
  }
});

test('given duplicate session grants, merging handles unscoped, left-scoped, and right-scoped accounts without duplicates', () => {
  const service = Object.create(ConnectionsService.prototype);
  assert.deepEqual(service.mergeSessionGrants([
    { type: 'plain', actions: ['read'], multiple: false },
    { type: 'plain', actions: ['write'], multiple: false },
  ]), [{ type: 'plain', actions: ['read', 'write'], multiple: false }]);
  assert.deepEqual(service.mergeSessionGrants([
    { type: 'left', actions: ['read'], multiple: false, connectionIds: ['a'] },
    { type: 'left', actions: ['read'], multiple: true },
    { type: 'right', actions: ['read'], multiple: false },
    { type: 'right', actions: ['write'], multiple: false, connectionIds: ['b'] },
  ]), [
    { type: 'left', actions: ['read'], multiple: true, connectionIds: ['a'] },
    { type: 'right', actions: ['read', 'write'], multiple: false, connectionIds: ['b'] },
  ]);
});
