import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  createTokenConnectorModule,
} = require('../../dist-electron/main/connections/modules/token-connector.js');

const createContext = (token) => ({
  metadataRoot: '/tmp/forger-token-connector-b7',
  secretsStore: {
    getToolSecret: async () => token,
    hasToolSecret: async () => Boolean(token),
    setToolSecret: async () => ({ success: true }),
    deleteToolSecrets: async () => undefined,
  },
  getFreePort: async () => 0,
  openExternalUrl: async () => undefined,
  isForgerAccountAuthenticated: () => false,
  getGmailOAuthClientId: async () => '',
  exchangeGmailOAuthCode: async () => ({}),
  refreshGmailOAuthAccessToken: async () => ({}),
});

test('Given status metadata without a handler, the token factory declares and executes status exactly once', async () => {
  let validationCalls = 0;
  const module = createTokenConnectorModule({
    id: 'coverage-token',
    name: 'Coverage token',
    description: 'Exercises status metadata owned by the token connector factory.',
    version: '1.0.0',
    connectionStatusActionId: 'coverage-token.connection.status',
    connectionStatusAction: {
      name: 'Connection status',
      description: 'Reports whether the stored credential is valid.',
      risk: 'low',
      outputSchema: {
        type: 'object',
        properties: { connected: { type: 'boolean' } },
        required: ['connected'],
      },
    },
    secrets: [{ name: 'token', label: 'Token', required: true, usage: 'Test token.' }],
    actions: [],
    validate: async () => {
      validationCalls += 1;
      return { ok: true, data: { subject: 'person-1' } };
    },
  });

  assert.deepEqual(module.definition.actions.map((action) => action.id), [
    'coverage-token.connection.status',
  ]);

  const disconnected = await module.execute({
    toolId: 'coverage-token', actionId: 'coverage-token.connection.status', input: {},
  }, createContext(null));
  assert.deepEqual(disconnected, { success: true, data: { connected: false } });
  assert.equal(validationCalls, 0);

  const connected = await module.execute({
    toolId: 'coverage-token', actionId: 'coverage-token.connection.status', input: {},
  }, createContext('stored-token'));
  assert.deepEqual(connected, {
    success: true,
    data: { connected: true, subject: 'person-1' },
  });
  assert.equal(validationCalls, 1);
});

const connectorDefinition = (overrides = {}) => ({
  id: 'coverage-fallbacks',
  name: 'Coverage fallbacks',
  description: 'Exercises safe default connector behavior.',
  version: '1.0.0',
  connectionStatusActionId: 'coverage-fallbacks.connection.status',
  secrets: [{ name: 'token', label: 'Token', required: true, usage: 'Test token.' }],
  actions: [],
  validate: async () => ({ ok: true }),
  ...overrides,
});

test('When connector configuration or actions omit optional copy, factory fallbacks remain deterministic', async () => {
  const storeFailure = createTokenConnectorModule(connectorDefinition());
  const failedStoreContext = createContext('stored-token');
  failedStoreContext.secretsStore.setToolSecret = async () => ({
    success: false,
    userMessage: 'Secure storage failed.',
    technicalCode: 'secret_store_failed',
  });
  assert.deepEqual(await storeFailure.configure(failedStoreContext, {
    toolId: 'coverage-fallbacks', secrets: { token: 'new-token' },
  }), {
    success: false,
    userMessage: 'Secure storage failed.',
    technicalCode: 'secret_store_failed',
  });

  const invalid = createTokenConnectorModule(connectorDefinition({
    validate: async () => ({ ok: false }),
  }));
  const invalidResult = await invalid.configure(createContext('stored-token'));
  assert.equal(invalidResult.userMessage, 'No pudimos validar la conexion con Coverage fallbacks. Revisa las credenciales.');
  assert.equal(invalidResult.technicalCode, 'connector_validation_failed');

  const connected = createTokenConnectorModule(connectorDefinition());
  assert.deepEqual(await connected.configure(createContext('stored-token')), {
    success: true,
    userMessage: 'Coverage fallbacks quedo conectado.',
  });
  assert.deepEqual(await connected.execute({
    toolId: 'coverage-fallbacks', actionId: 'missing.action', input: {},
  }, createContext('stored-token')), {
    success: false,
    userMessage: 'La accion de Coverage fallbacks no esta disponible.',
    technicalCode: 'connector_action_unknown',
  });

  const customUnknown = createTokenConnectorModule(connectorDefinition({
    copy: { actionUnknown: 'Custom unavailable action.' },
  }));
  assert.equal((await customUnknown.execute({
    toolId: 'coverage-fallbacks', actionId: 'missing.action', input: {},
  }, createContext('stored-token'))).userMessage, 'Custom unavailable action.');

  let receivedInput;
  const actionModule = createTokenConnectorModule(connectorDefinition({
    actions: [
      {
        id: 'coverage-fallbacks.empty-input',
        name: 'Empty input',
        description: 'Normalizes malformed input.',
        risk: 'low',
        run: async ({ input }) => {
          receivedInput = input;
          return { success: true };
        },
      },
      {
        id: 'coverage-fallbacks.opaque-error',
        name: 'Opaque error',
        description: 'Maps non-Error failures.',
        risk: 'low',
        run: async () => { throw 'opaque failure'; },
      },
    ],
  }));
  assert.equal((await actionModule.execute({
    toolId: 'coverage-fallbacks', actionId: 'coverage-fallbacks.empty-input', input: [],
  }, createContext('stored-token'))).success, true);
  assert.deepEqual(receivedInput, {});
  assert.equal((await actionModule.execute({
    toolId: 'coverage-fallbacks', actionId: 'coverage-fallbacks.opaque-error', input: {},
  }, createContext('stored-token'))).technicalCode, 'connector_action_failed');
});
