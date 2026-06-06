import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createAppContextSupportController } = require('../../dist-electron/main/apps/context-support.js');
const { FORGER_AGENT_CONTRACT_MARKER_PREFIX } = require('../../dist-electron/main/prompt-builder/forger-base.js');

const tmpRoot = async (name) => await fs.mkdtemp(path.join(os.tmpdir(), `forger-${name}-`));

const createController = (root, overrides = {}) => createAppContextSupportController({
  fs,
  path,
  catalogApps: overrides.catalogApps ?? [{ id: 'catalog-app', name: 'Catalog App' }],
  registry: overrides.registry ?? {
    apps: {
      installed: { appId: 'installed', name: ' Installed App ', status: 'installed', version: '1.0.0' },
    },
  },
  fileLibraryState: overrides.fileLibraryState ?? { current: null },
  getPrivateDataRoot: () => path.join(root, 'data'),
  getForgerMetadataRoot: () => path.join(root, 'metadata'),
  appLifecycleLocks: overrides.appLifecycleLocks ?? new Map(),
  forgerBackendClient: overrides.forgerBackendClient ?? null,
});

test('context support writes global AGENTS and official tool skills into metadata root', async (t) => {
  const root = await tmpRoot('context-global');
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  const controller = createController(root);
  const homeRoot = path.join(root, 'home');

  await controller.ensureGlobalAgentsContext(homeRoot);

  const agentsMarkdown = await fs.readFile(path.join(homeRoot, 'AGENTS.md'), 'utf8');
  const skillDirs = await fs.readdir(path.join(homeRoot, '.agents', 'skills'));
  assert.match(agentsMarkdown, /Forger/);
  assert.ok(skillDirs.includes('forger-context'));
  assert.ok(skillDirs.includes('forger-app-agents-authoring'));
  assert.ok(skillDirs.includes('forger-app-mcp-data-tools'));
  assert.ok(skillDirs.includes('forger-gmail'));
  assert.ok(skillDirs.includes('forger-manifest-authoring'));
  assert.ok(skillDirs.includes('forger-dev-in-app-agents'));
  assert.ok(skillDirs.includes('forger-localization'));
  assert.ok(skillDirs.includes('forger-frontend-patterns'));
  assert.ok(skillDirs.includes('forger-dev-backend-development'));
  assert.ok(skillDirs.includes('forger-installed-app-change'));
  assert.ok(skillDirs.includes('forger-memory'));
  assert.ok(skillDirs.includes('forger-remote-tunnel-wiring'));
  assert.equal(skillDirs.includes('forger-agents'), false);
  assert.equal(skillDirs.includes('forger-tasks'), false);
  assert.equal(skillDirs.includes('forger-desktop-runtime-bridge'), false);
  assert.equal(skillDirs.includes('forger-fastapi-contracts'), false);
  assert.equal(skillDirs.includes('forger-python-backend'), false);
  assert.equal(skillDirs.includes('forger-tanstack-query-patterns'), false);
  assert.equal(skillDirs.includes('forger-frontend-product-patterns'), false);
  assert.equal(skillDirs.includes('forger-web-interface-review'), false);
  assert.equal(skillDirs.includes('forger-app-shell-layout'), false);
  assert.equal(skillDirs.includes('forger-tailwind-shadcn-patterns'), false);
  assert.equal(skillDirs.includes('forger-mui-design-patterns'), false);
});

test('context support preserves user AGENTS files and upgrades older Forger contract markers', async (t) => {
  const root = await tmpRoot('context-agents');
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  const controller = createController(root);
  const userAgents = path.join(root, 'user', 'AGENTS.md');
  const oldForgerAgents = path.join(root, 'old', 'AGENTS.md');
  await fs.mkdir(path.dirname(userAgents), { recursive: true });
  await fs.mkdir(path.dirname(oldForgerAgents), { recursive: true });
  await fs.writeFile(userAgents, 'custom user instructions', 'utf8');
  await fs.writeFile(oldForgerAgents, `${FORGER_AGENT_CONTRACT_MARKER_PREFIX} old generated contract`, 'utf8');

  assert.equal(await controller.shouldWriteAppAgentsMarkdown(path.join(root, 'missing', 'AGENTS.md')), true);
  assert.equal(await controller.shouldWriteAppAgentsMarkdown(userAgents), false);
  assert.equal(await controller.shouldWriteAppAgentsMarkdown(oldForgerAgents), true);
});

test('context support normalizes installed app context for invalid, MCP-only, and skill edge manifests', async (t) => {
  const root = await tmpRoot('context-installed');
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  const controller = createController(root);
  const invalidDir = path.join(root, 'invalid-app');
  const arrayDir = path.join(root, 'array-app');
  const mcpOnlyDir = path.join(root, 'mcp-only-app');
  const skillsDir = path.join(root, 'skills-app');
  await fs.mkdir(invalidDir, { recursive: true });
  await fs.mkdir(arrayDir, { recursive: true });
  await fs.mkdir(mcpOnlyDir, { recursive: true });
  await fs.mkdir(path.join(skillsDir, 'skills', 'inside'), { recursive: true });
  await fs.writeFile(path.join(invalidDir, 'manifest.json'), '{bad json', 'utf8');
  await fs.writeFile(path.join(arrayDir, 'manifest.json'), JSON.stringify([{ stack: { backend: { language: 'python' } } }]), 'utf8');
  await fs.writeFile(path.join(mcpOnlyDir, 'manifest.json'), JSON.stringify({
    mcp: { command: 'python -m app.mcp' },
  }), 'utf8');
  await fs.writeFile(path.join(skillsDir, 'manifest.json'), JSON.stringify({
    stack: { backend: { language: 'ruby' } },
    skills: ['./skills/inside', './skills/missing', './manifest.json', '', 42],
  }), 'utf8');
  await fs.writeFile(path.join(skillsDir, 'skills', 'inside', 'SKILL.md'), 'inside', 'utf8');

  await controller.normalizeInstalledAgentContext(invalidDir, 'invalid');
  assert.match(await fs.readFile(path.join(invalidDir, 'AGENTS.md'), 'utf8'), /invalid/);
  assert.deepEqual(await fs.readdir(path.join(invalidDir, '.agents', 'skills')), [
    'forger-app-agents-authoring',
    'forger-app-mcp-data-tools',
    'forger-app-official-tools',
    'forger-context',
  ]);

  await controller.normalizeInstalledAgentContext(arrayDir, 'array');
  assert.match(await fs.readFile(path.join(arrayDir, 'AGENTS.md'), 'utf8'), /array/);
  assert.deepEqual(await fs.readdir(path.join(arrayDir, '.agents', 'skills')), [
    'forger-app-agents-authoring',
    'forger-app-mcp-data-tools',
    'forger-app-official-tools',
    'forger-context',
  ]);

  await controller.normalizeInstalledAgentContext(mcpOnlyDir, 'mcp-only');
  assert.deepEqual(await fs.readdir(path.join(mcpOnlyDir, '.agents', 'skills')), [
    'forger-app-agents-authoring',
    'forger-app-mcp-data-tools',
    'forger-app-official-tools',
    'forger-context',
  ]);

  await controller.normalizeInstalledAgentContext(skillsDir, 'skills');
  assert.deepEqual(await fs.readdir(path.join(skillsDir, '.agents', 'skills')), [
    'forger-app-agents-authoring',
    'forger-app-mcp-data-tools',
    'forger-app-official-tools',
    'forger-context',
    'inside',
  ]);
});

test('context support normalizes installed app templates without stack-dependent development skills', async (t) => {
  const root = await tmpRoot('context-stack');
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  const controller = createController(root);
  const appDir = path.join(root, 'stack-app');
  await fs.mkdir(appDir, { recursive: true });
  await fs.writeFile(path.join(appDir, 'manifest.json'), JSON.stringify({
    stack: {
      backend: { language: ' Python ', framework: ' FastAPI ' },
      frontend: { framework: ' React ', ui: ' MUI ' },
    },
    tools: {
      optional: [{ toolId: 'gmail', reason: 'Search mail', actions: ['gmail.search_messages', 'gmail.read_thread'] }],
    },
    mcp: { type: 'http', command: 'python -m app.mcp' },
  }), 'utf8');

  assert.equal(controller.hasValidManifestStack(null), false);
  assert.equal(controller.hasValidManifestStack({ stack: [] }), false);
  assert.equal(controller.hasValidManifestStack({ stack: { backend: [], frontend: null } }), false);
  assert.deepEqual(controller.buildStackSkillTemplates({
    backend: { language: ' Python ', framework: ' FastAPI ' },
    frontend: { framework: ' React ', ui: ' MUI ' },
  }, true, ['gmail.search_messages']).map((template) => template.id), [
    'forger-app-agents-authoring',
    'forger-app-mcp-data-tools',
    'forger-context',
    'forger-app-official-tools',
  ]);
  const stackSkillsRoot = path.join(root, 'stack-skills');
  await controller.writeStackSkills(stackSkillsRoot, {
    backend: { language: ' Python ', framework: ' FastAPI ' },
  }, true, ['gmail.read_thread']);
  assert.match(
    await fs.readFile(path.join(stackSkillsRoot, 'forger-app-official-tools', 'SKILL.md'), 'utf8'),
    /`gmail\.read_thread`/,
  );

  assert.deepEqual(controller.buildInstalledAppContextSkillTemplates([
    'gmail.search_messages',
  ]).map((template) => template.id), [
    'forger-app-agents-authoring',
    'forger-app-mcp-data-tools',
    'forger-context',
    'forger-app-official-tools',
  ]);

  await controller.normalizeInstalledAgentContext(appDir, 'stack');
  assert.deepEqual(await fs.readdir(path.join(appDir, '.agents', 'skills')), [
    'forger-app-agents-authoring',
    'forger-app-mcp-data-tools',
    'forger-app-official-tools',
    'forger-context',
  ]);
  const officialToolSkill = await fs.readFile(path.join(appDir, '.agents', 'skills', 'forger-app-official-tools', 'SKILL.md'), 'utf8');
  assert.match(officialToolSkill, /`gmail\.search_messages`/);
  assert.match(officialToolSkill, /`gmail\.read_thread`/);
  assert.doesNotMatch(officialToolSkill, /gmail\.send_email/);
  const agentsSkill = await fs.readFile(path.join(appDir, '.agents', 'skills', 'forger-app-agents-authoring', 'SKILL.md'), 'utf8');
  assert.match(agentsSkill, /current app facts/);
  assert.match(agentsSkill, /turn-specific tone/);

  const edgeToolsDir = path.join(root, 'edge-tools-app');
  await fs.mkdir(edgeToolsDir, { recursive: true });
  await fs.writeFile(path.join(edgeToolsDir, 'manifest.json'), JSON.stringify({
    tools: {
      required: [
        null,
        [],
        { actions: 'not-array' },
        { actions: [false, ' gmail.search_messages ', ''] },
      ],
    },
  }), 'utf8');
  await controller.normalizeInstalledAgentContext(edgeToolsDir, 'edge-tools');
  assert.match(
    await fs.readFile(path.join(edgeToolsDir, '.agents', 'skills', 'forger-app-official-tools', 'SKILL.md'), 'utf8'),
    /`gmail\.search_messages`/,
  );
});

test('context support serializes lifecycle locks after failures and releases lock state', async () => {
  const root = await tmpRoot('context-locks');
  const locks = new Map();
  const controller = createController(root, { appLifecycleLocks: locks });
  const events = [];
  const first = controller.withAppLifecycleLock('demo', async () => {
    events.push('first:start');
    await new Promise((resolve) => setTimeout(resolve, 25));
    events.push('first:fail');
    throw new Error('first failed');
  });
  const second = controller.withAppLifecycleLock('demo', async () => {
    events.push('second:start');
    return 'ok';
  });

  await assert.rejects(first, /first failed/);
  assert.equal(await second, 'ok');
  assert.deepEqual(events, ['first:start', 'first:fail', 'second:start']);
  assert.equal(locks.has('demo'), false);
  await fs.rm(root, { recursive: true, force: true });
});

test('context support resolves app display names, creates file library once, and delegates catalog listing', async (t) => {
  const root = await tmpRoot('context-misc');
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  let catalogCalls = 0;
  const fileLibraryState = { current: null };
  const controller = createController(root, {
    fileLibraryState,
    forgerBackendClient: {
      listCatalogApps: async () => {
        catalogCalls += 1;
        return [{ id: 'remote', name: 'Remote' }];
      },
    },
  });

  assert.equal(controller.resolveSelectedAppDisplayName('installed'), 'Installed App');
  assert.equal(controller.resolveSelectedAppDisplayName('catalog-app'), 'Catalog App');
  assert.equal(controller.resolveSelectedAppDisplayName('missing'), 'missing');

  const firstLibrary = controller.getFileLibrary();
  assert.equal(controller.getFileLibrary(), firstLibrary);
  assert.equal(fileLibraryState.current, firstLibrary);

  assert.deepEqual(await controller.listCatalogFromBackend(), [{ id: 'remote', name: 'Remote' }]);
  assert.equal(catalogCalls, 1);

  const noBackend = createController(root, { forgerBackendClient: null });
  assert.deepEqual(await noBackend.listCatalogFromBackend(), []);
});
