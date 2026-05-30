import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  configureDesktopUserDataPath,
  createPathConfigController,
  getDesktopUserDataName,
} = require('../../dist-electron/main/core/path-config.js');
const {
  AGENT_TOOL_DEFINITIONS,
  AGENT_TOOL_IDS,
  AGENT_TOOL_PACKAGES,
  FORGER_TOOL_PACKAGE_ID,
  createInitialAgentToolSettings,
} = require('../../dist-electron/main/core/agent-tool-packages.js');

const createPathController = (overrides = {}) => createPathConfigController({
  app: {
    getPath: (name) => `/user-data/${name}`,
  },
  forgerAccount: { authenticated: true, user: { id: 42 } },
  isDev: true,
  os: {
    homedir: () => '/home/test-user',
  },
  path,
  ...overrides,
});

test('path config normalizes runtime values and resolves private desktop roots', () => {
  const controller = createPathController();

  assert.equal(controller.normalizeVersionForFolder(' v1.2.3 beta+4 '), '1.2.3-beta-4');
  assert.equal(controller.normalizeVersionForFolder(' !!! '), '---');
  assert.equal(controller.normalizeVersionForFolder('   '), 'unknown');
  assert.equal(controller.normalizeNodeRuntimeVersion(undefined), '22');
  assert.equal(controller.normalizeNodeRuntimeVersion('node-v20.11.1'), '20');
  assert.equal(controller.normalizeNodeRuntimeVersion('node'), '22');
  assert.match(controller.resolvePlatformAlias(), new RegExp(`_${process.arch}$`));

  assert.equal(controller.getRegistryPath(), '/user-data/userData/app_registry.json');
  assert.equal(controller.getRegistryBackupPath(), '/user-data/userData/app_registry.json.bak');
  assert.equal(controller.getRuntimesRoot(), '/user-data/userData/runtimes');
  assert.equal(controller.getTempRoot(), '/user-data/userData/tmp');
  assert.equal(controller.getLogsRoot(), '/user-data/userData/logs');
  assert.equal(controller.getInstallLogPath(), '/user-data/userData/logs/install.log');
  assert.equal(controller.getForgerHomeRoot(), '/home/test-user/Forger-dev');
  assert.equal(controller.getPrivateAppsRoot(), '/home/test-user/Forger-dev/apps');
  assert.equal(controller.getPrivateDataRoot(), '/home/test-user/Forger-dev/data');
  assert.equal(controller.getBackupsRoot(), '/home/test-user/Forger-dev/backups');
  assert.equal(controller.getForgerMetadataRoot(), '/home/test-user/Forger-dev/.forger');
  assert.equal(controller.getLegacyForgerMetadataRoot(), '/home/test-user/Forger-dev/apps/.forger');
  assert.equal(controller.getCodexRoot(), '/user-data/userData/codex-cli');
  assert.equal(controller.getCodexHome(), '/user-data/userData/codex-home');
  assert.equal(controller.getClaudeRoot(), '/user-data/userData/claude-code-cli');
  assert.equal(controller.getAgentToolSettingsPath(), '/home/test-user/Forger-dev/.forger/agent-tools.json');
  assert.equal(controller.getSettingsPath(), '/home/test-user/Forger-dev/.forger/settings.json');
  assert.equal(controller.getPromptOverridesPath(), '/home/test-user/Forger-dev/.forger/prompt-overrides.json');
  assert.equal(controller.getForgerAccountPath(), '/home/test-user/Forger-dev/.forger/account.json');
  assert.equal(controller.getCloudDevicePath(), '/home/test-user/Forger-dev/.forger/cloud-device.json');
  assert.equal(controller.getCloudIdentityPath(), '/home/test-user/Forger-dev/.forger/cloud-identity.json');
  assert.equal(controller.getCloudSyncSettingsPath(), '/home/test-user/Forger-dev/.forger/cloud-sync.json');
  assert.equal(controller.getCloudDeviceAccountStorageKey(), 'user-42');
});

test('path config isolates dev userData before runtime paths are resolved', () => {
  const setPathCalls = [];
  const devPath = configureDesktopUserDataPath({
    app: {
      getPath: (name) => {
        assert.equal(name, 'appData');
        return '/user-data/appData';
      },
      setPath: (name, value) => {
        setPathCalls.push([name, value]);
      },
    },
    isDev: true,
    path,
  });

  assert.equal(getDesktopUserDataName(false), 'forger-desktop');
  assert.equal(getDesktopUserDataName(true), 'forger-desktop-dev');
  assert.equal(devPath, '/user-data/appData/forger-desktop-dev');
  assert.deepEqual(setPathCalls, [['userData', '/user-data/appData/forger-desktop-dev']]);

  const productionPath = configureDesktopUserDataPath({
    app: {
      getPath: () => {
        throw new Error('prod_should_not_resolve_app_data');
      },
      setPath: () => {
        throw new Error('prod_should_not_set_user_data');
      },
    },
    isDev: false,
    path,
  });
  assert.equal(productionPath, null);
});

test('path config uses production home and omits account storage key without a cloud user', () => {
  const controller = createPathController({
    forgerAccount: { authenticated: false },
    isDev: false,
  });

  assert.equal(controller.getForgerHomeRoot(), '/home/test-user/Forger');
  assert.equal(controller.getCloudDeviceAccountStorageKey(), undefined);

  const accountWithoutId = createPathController({
    forgerAccount: { authenticated: true, user: { email: 'user@example.com' } },
  });
  assert.equal(accountWithoutId.getCloudDeviceAccountStorageKey(), undefined);
});

test('agent tool package definitions are unique and initialize approval defaults', () => {
  const packageIds = AGENT_TOOL_PACKAGES.map((toolPackage) => toolPackage.id);
  assert.ok(packageIds.includes(FORGER_TOOL_PACKAGE_ID));
  assert.equal(new Set(packageIds).size, packageIds.length);

  const toolIds = AGENT_TOOL_DEFINITIONS.map((tool) => tool.id);
  assert.equal(new Set(toolIds).size, toolIds.length);
  assert.equal(AGENT_TOOL_IDS.size, toolIds.length);

  const settings = createInitialAgentToolSettings();
  for (const tool of AGENT_TOOL_DEFINITIONS) {
    assert.equal(settings.approvals[tool.id], tool.defaultRequiresApproval, tool.id);
  }
  assert.equal(settings.approvals.forger_open_app, true);
  assert.equal(settings.approvals.forger_list_catalog, false);
  assert.equal(settings.approvals.forger_create_app, false);
  assert.equal(Object.hasOwn(settings.approvals, 'forger_ask_question'), false);
});
