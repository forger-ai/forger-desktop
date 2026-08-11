import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);

test('BDD: path configuration exposes every storage root and rejects unknown runtime platforms', () => {
  const { createPathConfigController, resolveRuntimePlatformAlias } = require('../../dist-electron/main/core/path-config.js');
  assert.throws(() => resolveRuntimePlatformAlias('plan9', 'x64'), /unsupported_platform_plan9_x64/);
  const controller = createPathConfigController({
    app: { getPath: () => '/user-data', isPackaged: true }, forgerAccount: { authenticated: false }, isDev: false, os, path,
  });
  assert.equal(controller.getAntigravityRoot(), '/user-data/antigravity-cli');
  assert.match(controller.getSocialMessagesPath(), /social-messages\.sqlite$/);
});

test('BDD: developer path state treats absent app ids and missing registry records as having no app overrides', async () => {
  const { createDeveloperPathService } = require('../../dist-electron/main/core/developer-path-service.js');
  const service = createDeveloperPathService({
    defaultNodeVersion: '22', ensureRuntimeInstalled: async () => ({ binDir: '/runtime' }),
    fs: {}, getAppLocalToolPathEntries: async () => [], getRuntimePathEntries: () => ['/runtime/bin'],
    normalizeNodeRuntimeVersion: () => '22', normalizeSettings: () => ({ developerMode: { enabled: true, pathEntries: ['/global'] } }),
    path, registry: { apps: {} }, settings: () => ({}), systemPath: () => '', upsertInstalledRecord: async () => {},
  });
  assert.deepEqual(await service.getAgentPathEntries(), ['/runtime/bin', '/global']);
  assert.deepEqual(await service.getAgentPathEntries('missing'), ['/runtime/bin', '/global']);
  assert.deepEqual((await service.getDeveloperPathState()).appPathEntries, []);
  assert.deepEqual((await service.getDeveloperPathState('missing')).appPathEntries, []);
});

test('BDD: prompt builders describe frontend-only apps, empty grants, and app-root execution fallback', () => {
  const { buildForgerAppAgentsMarkdown } = require('../../dist-electron/main/prompt-builder/apps-base.js');
  const { buildPersonalAgentWorkspaceDocuments } = require('../../dist-electron/main/prompt-builder/personal-agents.js');
  const { buildCodexPromptWithAppContext } = require('../../dist-electron/main/prompt-builder/user-message.js');

  assert.match(buildForgerAppAgentsMarkdown('frontend', { stack: { frontend: { framework: 'React' } } }), /Frontend: framework React/);
  const documents = buildPersonalAgentWorkspaceDocuments({
    id: 'agent', name: 'Helper', description: '', purpose: '', instructions: '', permissionMode: 'safe', networkAccess: false,
    canSpawnAgents: false, appIds: [], toolIds: [], connectionGrants: [{ type: 'gmail', actions: [], multiple: false }],
    peerAgentGrants: [], createdAt: 'now', updatedAt: 'now',
  });
  const workspaceText = Object.values(documents).join('\n');
  assert.match(workspaceText, /actions none/);
  assert.match(workspaceText, /no specific account\/session binding/);
  const prompt = buildCodexPromptWithAppContext({
    appId: 'app', displayName: 'App', appRoot: '/apps/app', userPrompt: 'Work', sharedFiles: [], sharedFilesRootName: 'shared',
  });
  assert.match(prompt, /\/apps\/app/);
});

test('BDD: localized Chrome tool packages have complete action copy', () => {
  const { AGENT_TOOL_PACKAGES, getAgentToolPackages } = require('../../dist-electron/main/core/agent-tool-packages.js');
  const source = AGENT_TOOL_PACKAGES.find((item) => item.id === 'official:forger_chrome_extension');
  const localized = getAgentToolPackages('en').find((item) => item.id === 'official:forger_chrome_extension');
  assert.equal(localized.tools.length, source.tools.length);
  for (let index = 0; index < source.tools.length; index += 1) {
    assert.notEqual(localized.tools[index].name, source.tools[index].name);
    assert.notEqual(localized.tools[index].description, source.tools[index].description);
  }
});

test('BDD: Meta Ads exposes output contracts, reports configuration, and token setup omits unknown provider portals', async () => {
  const { metaAdsDefinition } = require('../../dist-electron/main/connections/modules/token-service-connectors/meta-ads/definition.js');
  const { metaAdsToolModule } = require('../../dist-electron/main/connections/modules/token-service-connectors/meta-ads/index.js');
  const { tokenSetupGuide } = require('../../dist-electron/main/connections/setup-guides/token.js');
  assert.equal(metaAdsDefinition.actions.every((action) => action.outputSchema), true);
  assert.equal(await metaAdsToolModule.isConfigured({ secretsStore: { getToolSecret: async () => null } }), false);
  assert.equal(await metaAdsToolModule.isConfigured({ secretsStore: { getToolSecret: async () => 'token' } }), true);
  const guide = tokenSetupGuide({
    locale: 'en', definition: { type: 'custom-token', displayName: 'Custom', secretsSchema: [] },
  });
  assert.equal(guide.portal, undefined);
  assert.match(guide.notes[0], /minimum permissions/);
});
