import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  OfficialToolsService,
  normalizeAppToolDeclarations,
} = require('../../dist-electron/main/official-tools-service.js');
const { getSharedCopy } = require('../../dist-electron/shared/i18n.js');

const definition = (id, overrides = {}) => ({
  id,
  name: `Tool ${id}`,
  description: `Description ${id}`,
  version: '1.2.3',
  runtime: 'builtin',
  official: true,
  secrets: [],
  actions: [
    { id: `${id}.connection.status`, name: 'Status', description: 'Status', risk: 'low' },
    { id: `${id}.run`, name: 'Run', description: 'Run', risk: 'medium' },
  ],
  changelog: ['Ready'],
  ...overrides,
});

const installedRecord = (id, overrides = {}) => ({
  id,
  version: '1.2.3',
  status: 'installed',
  configured: false,
  installedAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

const appDeclarations = (required = [], optional = []) => ({
  appName: 'BDD App',
  required,
  optional,
  agents: [{ id: 'helper', title: 'Helper', initialPrompt: 'Help' }],
  promptTemplates: [{ id: 'review', title: 'Review', prompt: 'Review' }],
  platformCapabilities: {},
});

const createHarness = async (declarations = new Map()) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forger-official-b11-'));
  const logs = [];
  const deletedSecrets = [];
  const storedSecrets = new Set();
  const service = new OfficialToolsService({
    metadataRoot: root,
    secretsStore: {
      hasToolSecret: async (toolId, secretName) => storedSecrets.has(`${toolId}:${secretName}`),
      deleteToolSecrets: async (toolId) => deletedSecrets.push(toolId),
    },
    getFreePort: async () => 41991,
    openExternalUrl: async () => undefined,
    isForgerAccountAuthenticated: () => true,
    getGmailOAuthClientId: async () => 'client',
    exchangeGmailOAuthCode: async () => ({ access_token: 'access' }),
    refreshGmailOAuthAccessToken: async () => ({ access_token: 'refreshed' }),
    appendLog: async (event, payload) => logs.push({ event, payload }),
    getAppToolDeclarations: async (appId) => declarations.get(appId) ?? null,
  });
  return {
    root,
    service,
    logs,
    deletedSecrets,
    storedSecrets,
    cleanup: async () => fs.rm(root, { recursive: true, force: true }),
  };
};

test('given noisy declarations, when normalized, then only unique complete tool contracts survive', () => {
  assert.deepEqual(normalizeAppToolDeclarations('not-an-object'), { required: [], optional: [] });
  assert.deepEqual(normalizeAppToolDeclarations({ required: {}, optional: [] }), { required: [], optional: [] });
  assert.deepEqual(normalizeAppToolDeclarations({
    required: [
      null,
      [],
      { toolId: 7, reason: 'reason', actions: ['run'] },
      { toolId: ' tool ', reason: 7, actions: ['run'] },
      { toolId: ' tool ', reason: ' reason ', actions: 'run' },
      { toolId: ' tool ', reason: ' reason ', actions: [null, ' ', 'run', 'run', 'status'] },
      { toolId: 'tool', reason: 'duplicate', actions: ['other'] },
    ],
  }), {
    required: [{ toolId: 'tool', reason: 'reason', actions: ['run', 'status'] }],
    optional: [],
  });
});

test('given installed modules, lifecycle starts and stops every injected module while isolating failures', async () => {
  const harness = await createHarness();
  const calls = [];
  const startError = new Error('start exploded');
  const stopError = new Error('stop exploded');
  stopError.stack = undefined;
  const modules = [
    {
      definition: definition('healthy'),
      configure: async () => ({ success: true, userMessage: 'ok' }),
      execute: async () => ({ success: true, userMessage: 'ok' }),
      start: async (context) => calls.push(['start', context.locale, context.metadataRoot]),
      stop: async (context) => calls.push(['stop', context.locale, context.metadataRoot]),
    },
    {
      definition: definition('broken'),
      configure: async () => ({ success: true, userMessage: 'ok' }),
      execute: async () => ({ success: true, userMessage: 'ok' }),
      start: async () => { throw startError; },
      stop: async () => { throw 'stop exploded'; },
    },
    {
      definition: definition('passive'),
      configure: async () => ({ success: true, userMessage: 'ok' }),
      execute: async () => ({ success: true, userMessage: 'ok' }),
    },
    {
      definition: definition('different-failures'),
      configure: async () => ({ success: true, userMessage: 'ok' }),
      execute: async () => ({ success: true, userMessage: 'ok' }),
      start: async () => { throw 'start without error'; },
      stop: async () => { throw stopError; },
    },
    {
      definition: definition('stop-stack'),
      configure: async () => ({ success: true, userMessage: 'ok' }),
      execute: async () => ({ success: true, userMessage: 'ok' }),
      stop: async () => { throw new Error('stop with stack'); },
    },
  ];
  harness.service.modulesById = new Map(modules.map((module) => [module.definition.id, module]));
  harness.service.registry = {
    version: 1,
    installed: Object.fromEntries(modules.map((module) => [module.definition.id, installedRecord(module.definition.id)])),
    appGrants: {},
  };
  harness.service.loaded = true;

  try {
    await harness.service.load();
    await harness.service.startActiveTools('en-US');
    await harness.service.stopActiveTools('es-CL');

    assert.deepEqual(calls, [
      ['start', 'en-US', harness.root],
      ['stop', 'es-CL', harness.root],
    ]);
    assert.equal(harness.logs.length, 5);
    assert.equal(harness.logs[0].event, 'official_tools:start_failed');
    assert.equal(harness.logs[0].payload.message, 'start exploded');
    assert.equal(typeof harness.logs[0].payload.stack, 'string');
    assert.deepEqual(harness.logs[1], {
      event: 'official_tools:start_failed',
      payload: { toolId: 'different-failures', message: 'unknown_error' },
    });
    assert.deepEqual(harness.logs[2], {
      event: 'official_tools:stop_failed',
      payload: { toolId: 'broken', message: 'unknown_error' },
    });
    assert.deepEqual(harness.logs[3], {
      event: 'official_tools:stop_failed',
      payload: { toolId: 'different-failures', message: 'stop exploded' },
    });
    assert.equal(harness.logs[4].event, 'official_tools:stop_failed');
    assert.equal(harness.logs[4].payload.toolId, 'stop-stack');
    assert.equal(typeof harness.logs[4].payload.stack, 'string');
  } finally {
    await harness.cleanup();
  }
});

test('given an official module, activation, configuration, errors, and deactivation persist a recoverable registry', async () => {
  const harness = await createHarness();
  const toolDefinition = definition('vault', {
    secrets: [
      { name: 'token', label: 'Token', usage: 'Authenticate', required: true },
      { name: 'optional', label: 'Optional', usage: 'Optional', required: false },
    ],
  });
  let configureResult = { success: true, userMessage: 'configured' };
  let deactivations = 0;
  const toolModule = {
    definition: toolDefinition,
    configure: async (_context, input) => ({ ...configureResult, observedLocale: input.locale }),
    execute: async (input, context) => ({ success: true, userMessage: `${input.actionId}:${context.locale}` }),
    deactivate: async () => { deactivations += 1; },
  };
  harness.service.modulesById = new Map([['vault', toolModule]]);

  try {
    assert.equal((await harness.service.activate('missing')).technicalCode, 'tool_not_found');
    assert.equal((await harness.service.configure({ toolId: 'missing', locale: 'en' })).technicalCode, 'tool_not_found');
    assert.equal((await harness.service.deactivate('missing')).technicalCode, 'tool_not_found');

    const first = await harness.service.activate('vault', 'en');
    assert.equal(first.success, true);
    assert.equal(first.tool.status, 'installed');
    const firstInstalledAt = harness.service.registry.installed.vault.installedAt;

    harness.storedSecrets.add('vault:token');
    const second = await harness.service.activate('vault', 'en');
    assert.equal(second.tool.status, 'configured');
    assert.equal(harness.service.registry.installed.vault.installedAt, firstInstalledAt);

    configureResult = { success: false, userMessage: 'failed' };
    const failed = await harness.service.configure({ toolId: 'vault', locale: 'es' });
    assert.equal(failed.success, false);
    assert.equal(failed.tool.status, 'error');
    assert.equal(failed.tool.error, 'tool_configuration_failed');

    configureResult = { success: true, userMessage: 'configured' };
    const recovered = await harness.service.configure({ toolId: 'vault', locale: 'en' });
    assert.equal(recovered.tool.status, 'configured');

    harness.service.registry.appGrants = { one: { vault: true }, two: { vault: false } };
    const kept = await harness.service.deactivate('vault', { keepSecrets: true, locale: 'en' });
    assert.equal(kept.success, true);
    assert.equal(deactivations, 1);
    assert.deepEqual(harness.deletedSecrets, []);
    assert.deepEqual(harness.service.registry.appGrants, { one: {}, two: {} });

    await harness.service.activate('vault');
    harness.service.options.secretsStore.deleteToolSecrets = async () => { throw new Error('keychain unavailable'); };
    const removed = await harness.service.deactivate('vault');
    assert.equal(removed.success, true);
    assert.equal(deactivations, 2);
    assert.equal((JSON.parse(await fs.readFile(path.join(harness.root, 'official-tools.json'), 'utf8'))).installed.vault, undefined);
  } finally {
    await harness.cleanup();
  }
});

test('given required and optional declarations, grants expose only declared actions and enforce runtime readiness', async () => {
  const declarations = new Map([
    ['app', appDeclarations(
      [{ toolId: 'alpha', reason: 'Required', actions: ['*'] }],
      [{ toolId: 'beta', reason: 'Optional', actions: ['beta.run'] }],
    )],
    ['required-only', appDeclarations([{ toolId: 'beta', reason: 'Required', actions: ['beta.run'] }])],
  ]);
  const harness = await createHarness(declarations);
  const executed = [];
  const configured = new Map([['alpha', true], ['beta', false]]);
  const modules = ['alpha', 'beta'].map((id) => ({
    definition: definition(id),
    configure: async () => ({ success: true, userMessage: 'ok' }),
    execute: async (input, context) => {
      executed.push({ input, locale: context.locale });
      return { success: true, userMessage: 'executed' };
    },
    isConfigured: async () => configured.get(id),
  }));
  harness.service.modulesById = new Map(modules.map((module) => [module.definition.id, module]));

  try {
    assert.equal((await harness.service.previewOptionalAppToolGrant({ appId: 'missing', toolId: 'beta' })).technicalCode, 'app_tools_not_declared');
    assert.equal((await harness.service.previewOptionalAppToolGrant({ appId: 'required-only', toolId: 'beta' })).technicalCode, 'app_tool_not_optional');
    assert.equal((await harness.service.previewOptionalAppToolGrant({ appId: 'app', toolId: 'alpha' })).technicalCode, 'app_tool_not_optional');
    assert.equal((await harness.service.previewOptionalAppToolGrant({ appId: 'app', toolId: 'unknown' })).technicalCode, 'app_tool_not_declared');

    const available = await harness.service.previewOptionalAppToolGrant({ appId: 'app', toolId: 'beta' }, 'en');
    assert.equal(available.success, true);
    assert.match(available.warning, /not active yet/);
    const defaultDenied = await harness.service.getInstallGate('app');
    const defaultGranted = await harness.service.getInstallGate('app', undefined, { defaultOptionalGrants: true });
    assert.equal(defaultDenied.optional[0].granted, false);
    assert.equal(defaultGranted.optional[0].granted, true);

    await harness.service.activate('beta');
    const installed = await harness.service.previewOptionalAppToolGrant({ appId: 'app', toolId: 'beta' });
    assert.match(installed.warning, /todavia no esta configurada/);

    harness.service.registry.installed.beta.error = 'bad config';
    const errored = await harness.service.previewOptionalAppToolGrant({ appId: 'app', toolId: 'beta' }, 'en');
    assert.match(errored.warning, /Detail: bad config/);
    harness.service.registry.installed.beta.error = undefined;
    configured.set('beta', true);

    const granted = await harness.service.setOptionalAppToolGrant({ appId: 'app', toolId: 'beta', granted: true }, 'en');
    assert.equal(granted.success, true);
    assert.match(granted.userMessage, /is allowed/);
    assert.equal(granted.gate.optional[0].granted, true);
    assert.equal(granted.gate.optional[0].hasStoredGrant, true);
    assert.deepEqual(granted.gate.optional[0].resolvedActions.map((action) => action.id), ['beta.run']);
    assert.equal(await harness.service.validateAgentCall({ toolId: 'beta', actionId: 'beta.run' }, { appId: 'app', requireAppGrant: true }), null);

    const actionIds = await harness.service.listAgentActionIdsForApp('app');
    assert.deepEqual(actionIds, new Set(['alpha.connection.status', 'alpha.run', 'beta.run']));

    await harness.service.activate('alpha');
    const visible = await harness.service.listToolsForApp('app');
    assert.deepEqual(visible.map((tool) => tool.id).sort(), ['alpha', 'beta']);

    assert.equal((await harness.service.callFromApp('missing', { toolId: 'alpha', actionId: 'alpha.run' })).technicalCode, 'app_tools_not_declared');
    assert.equal((await harness.service.callFromApp('app', { toolId: 'unknown', actionId: 'unknown.run' })).technicalCode, 'app_tool_not_declared');
    assert.equal((await harness.service.callFromApp('app', { toolId: 'beta', actionId: 'beta.connection.status' })).technicalCode, 'app_tool_action_not_declared');
    assert.equal((await harness.service.callFromApp('app', { toolId: 'beta', actionId: 'beta.run' })).success, true);
    assert.equal((await harness.service.callFromApp('app', { toolId: 'alpha', actionId: 'alpha.run' })).success, true);

    const revoked = await harness.service.setOptionalAppToolGrant({ appId: 'app', toolId: 'beta', granted: false });
    assert.match(revoked.userMessage, /dejo de estar permitido/);
    assert.equal((await harness.service.callFromApp('app', { toolId: 'beta', actionId: 'beta.run' })).technicalCode, 'app_tool_permission_denied');
    assert.equal((await harness.service.validateAgentCall({ toolId: 'beta', actionId: 'beta.run' }, { appId: 'app', requireAppGrant: true })).technicalCode, 'app_tool_permission_denied');
    assert.equal((await harness.service.validateAgentCall({ toolId: 'alpha', actionId: 'not-declared' }, { appId: 'app', requireAppGrant: true })).technicalCode, 'app_tool_action_not_declared');
    assert.deepEqual(await harness.service.listAgentActionIdsForApp('app'), new Set(['alpha.connection.status', 'alpha.run']));

    assert.equal((await harness.service.callFromAgent({ toolId: 'alpha', actionId: 'alpha.run' }, { locale: 'en' })).success, true);
    assert.equal(executed.length, 3);
  } finally {
    await harness.cleanup();
  }
});

test('given stale grants and damaged registry files, the service removes stale access and recovers safely', async () => {
  const declarations = new Map([['app', appDeclarations([], [])]]);
  const harness = await createHarness(declarations);
  harness.service.modulesById = new Map([['known', {
    definition: definition('known'),
    configure: async () => ({ success: true, userMessage: 'ok' }),
    execute: async () => ({ success: true, userMessage: 'ok' }),
  }]]);
  harness.service.registry = { version: 1, installed: {}, appGrants: { app: { stale: true } } };
  harness.service.loaded = true;

  try {
    const gate = await harness.service.setAppToolGrant({ appId: 'app', toolId: 'stale', granted: false });
    assert.equal(gate.canInstall, true);
    assert.deepEqual(harness.service.registry.appGrants.app, {});

    harness.service.getTool = async () => null;
    declarations.set('app', appDeclarations([], [{ toolId: 'known', reason: 'Optional', actions: ['known.run'] }]));
    assert.equal((await harness.service.previewOptionalAppToolGrant({ appId: 'app', toolId: 'known' })).technicalCode, 'tool_not_found');

    const damagedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'forger-official-b11-damaged-'));
    try {
      await fs.writeFile(path.join(damagedRoot, 'official-tools.json'), JSON.stringify({ version: 1, installed: [], appGrants: [] }));
      const damaged = await createHarness();
      damaged.service.options.metadataRoot = damagedRoot;
      await damaged.service.load();
      assert.deepEqual(damaged.service.registry, { version: 1, installed: {}, appGrants: {} });

      await fs.writeFile(path.join(damagedRoot, 'official-tools.json'), JSON.stringify({
        version: 1,
        installed: { known: installedRecord('known') },
        appGrants: { app: { known: true } },
      }));
      damaged.service.loaded = false;
      await damaged.service.load();
      assert.equal(damaged.service.registry.installed.known.id, 'known');
      assert.equal(damaged.service.registry.appGrants.app.known, true);
      await damaged.cleanup();
    } finally {
      await fs.rm(damagedRoot, { recursive: true, force: true });
    }
  } finally {
    await harness.cleanup();
  }
});

test('given every readiness state, app and agent calls explain the exact unavailable condition', async () => {
  const declarations = new Map([['app', appDeclarations([{ toolId: 'stateful', reason: 'Needed', actions: ['stateful.run', 'stateful.connection.status'] }])]]);
  const harness = await createHarness(declarations);
  let configured = false;
  const toolModule = {
    definition: definition('stateful'),
    configure: async () => ({ success: true, userMessage: 'ok' }),
    execute: async () => ({ success: true, userMessage: 'status works' }),
    isConfigured: async () => configured,
  };
  harness.service.modulesById = new Map([['stateful', toolModule]]);

  try {
    const availableAgent = await harness.service.callFromAgent({ toolId: 'stateful', actionId: 'stateful.run' }, { locale: 'en' });
    assert.equal(availableAgent.technicalCode, 'tool_not_active');
    assert.match(availableAgent.userMessage, /inactive/i);
    const availableApp = await harness.service.callFromApp('app', { toolId: 'stateful', actionId: 'stateful.run' });
    assert.equal(availableApp.technicalCode, 'tool_not_active');
    assert.notEqual(availableApp.userMessage, availableAgent.userMessage);

    await harness.service.activate('stateful');
    const installedAgent = await harness.service.callFromAgent({ toolId: 'stateful', actionId: 'stateful.run' });
    assert.equal(installedAgent.technicalCode, 'tool_not_configured');
    const installedApp = await harness.service.callFromApp('app', { toolId: 'stateful', actionId: 'stateful.run' });
    assert.equal(installedApp.technicalCode, 'tool_not_configured');
    assert.equal((await harness.service.callFromAgent({ toolId: 'stateful', actionId: 'stateful.connection.status' })).success, true);

    harness.service.registry.installed.stateful.error = 'broken';
    const errored = await harness.service.callFromAgent({ toolId: 'stateful', actionId: 'stateful.run' });
    assert.equal(errored.technicalCode, 'tool_configuration_error');
    configured = true;
    harness.service.registry.installed.stateful.error = undefined;
    assert.equal(await harness.service.validateAgentCall({ toolId: 'stateful', actionId: 'stateful.run' }), null);

    assert.deepEqual(await harness.service.toRequirement('app', { toolId: 'missing', reason: 'Missing', actions: ['*'] }, false), {
      declaration: { toolId: 'missing', reason: 'Missing', actions: ['*'] },
      required: false,
      tool: undefined,
      resolvedActions: [],
      allActions: true,
      granted: false,
      hasStoredGrant: false,
      available: false,
      configured: false,
    });
  } finally {
    await harness.cleanup();
  }
});

test('given partial translations, summaries localize known fields and preserve unknown metadata', async () => {
  const harness = await createHarness();
  const gmail = definition('gmail', {
    secrets: [
      { name: 'gmail_refresh_token', label: 'Original token', usage: 'Original usage', required: true },
      { name: 'custom', label: 'Custom', usage: 'Custom usage', required: false },
    ],
    actions: [
      { id: 'gmail.connection.status', name: 'Original status', description: 'Original status description', risk: 'low' },
      { id: 'gmail.custom', name: 'Custom', description: 'Custom action', risk: 'low', inputSchema: { type: 'object' } },
    ],
  });
  harness.service.modulesById = new Map([['gmail', {
    definition: gmail,
    configure: async () => ({ success: true, userMessage: 'ok' }),
    execute: async () => ({ success: true, userMessage: 'ok' }),
  }]]);

  try {
    const localized = await harness.service.getTool('gmail', 'en');
    assert.equal(localized.name, 'Gmail');
    assert.equal(localized.secrets[0].label, 'Gmail OAuth connection');
    assert.equal(localized.secrets[1].label, 'Custom');
    assert.equal(localized.actions[0].name, 'Connection status');
    assert.equal(localized.actions[1].name, 'Custom');
    assert.deepEqual(localized.actions[1].inputSchema, { type: 'object' });

    const english = harness.service.getGrantCopy('EN-us');
    assert.match(english.granted('Gmail', 'Mail'), /is allowed/);
    assert.match(english.revoked('Gmail', 'Mail'), /no longer allowed/);
    assert.match(english.unconfigured('Gmail'), /not configured/);
    assert.doesNotMatch(english.error('Gmail'), /Detail:/);
    const spanish = harness.service.getGrantCopy();
    assert.match(spanish.granted('Gmail', 'Correo'), /quedo permitido/);
    assert.match(spanish.inactive('Gmail'), /todavia no esta activa/);
    assert.match(spanish.error('Gmail'), /error de configuracion/);
    assert.match(spanish.error('Gmail', 'detalle'), /Detalle: detalle/);

    const sharedGmailCopy = getSharedCopy('en').officialTools.gmail;
    const originalChangelog = sharedGmailCopy.changelog;
    sharedGmailCopy.changelog = undefined;
    try {
      assert.deepEqual((await harness.service.getTool('gmail', 'en')).changelog, ['Ready']);
    } finally {
      sharedGmailCopy.changelog = originalChangelog;
    }

    harness.service.registry.installed.gmail = installedRecord('gmail', { configured: false });
    await harness.service.recordError('gmail', undefined);
    assert.equal(harness.service.registry.installed.gmail.status, 'installed');
  } finally {
    await harness.cleanup();
  }
});
