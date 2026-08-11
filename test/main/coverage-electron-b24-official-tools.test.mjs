import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);
const tools = require('../../dist-electron/main/prompt-builder/official-tools.js');

const definition = (type, overrides = {}) => ({
  type, displayName: type.toUpperCase(), description: 'Connection', setupKind: 'oauth', supportsMultiple: false,
  secretsSchema: [], statusActionId: `${type}.connection.status`, actions: [], ...overrides,
});

test('official tools prompt describes empty, legacy, connected, and app-grant connection contexts', () => {
  assert.match(tools.buildForgerOfficialToolsPromptSection({ mode: 'free-chat' }), /none listed/);
  assert.match(tools.buildForgerOfficialToolsPromptSection({
    mode: 'free-chat', gmailReady: true, whatsappReady: false, allowedActions: ['memory.fetch', 'gmail.search_messages'],
  }), /Gmail/);
  const definitions = [definition('custom', { displayName: 'Custom', supportsMultiple: true }), definition('offline')];
  const now = '2026-01-01';
  const identities = [
    { email: 'a@example.com' }, { phoneNumber: '+1' }, { workspace: 'workspace' }, { username: 'user' }, { subject: 'subject' }, {},
  ];
  const instances = identities.map((accountIdentity, index) => ({
    id: `i${index}`, type: index === 5 ? 'offline' : 'custom', label: index === 0 ? 'Label' : Object.values(accountIdentity)[0] ?? 'Same',
    status: index === 5 ? 'error' : index === 4 ? '' : 'connected', isDefault: index === 1, accountIdentity,
    createdAt: now, updatedAt: now,
  }));
  const free = tools.buildForgerOfficialToolsPromptSection({ mode: 'free-chat', connectionTypes: definitions, connectionInstances: instances });
  assert.match(free, /a@example.com/);
  assert.match(free, /not connected/);

  const requirement = (overrides = {}) => ({
    declaration: { type: 'unknown-type', reason: 'Needed', multiple: false }, required: false, granted: false, configured: false,
    reviewNeeded: false, resolvedActions: [], instances: [], ...overrides,
  });
  assert.match(tools.buildForgerOfficialToolsPromptSection({ mode: 'app-agent', connectionRequirements: [] }), /not declared/);
  const app = tools.buildForgerOfficialToolsPromptSection({
    mode: 'app-agent', connectionTypes: definitions, connectionInstances: [],
    connectionRequirements: [
      requirement(),
      requirement({ declaration: { type: 'custom', reason: 'Matched fallback', multiple: false } }),
      requirement({
        definition: definitions[0], required: true, granted: true, configured: true, reviewNeeded: true,
        declaration: { type: 'custom', reason: 'Use it', multiple: true },
        resolvedActions: [{ id: 'custom.read' }], instances: [instances[0]],
      }),
    ],
  });
  assert.match(app, /grant review needed/);
  assert.match(app, /unknown-type/);
  assert.equal(tools.isForgerConnectionActionId('gmail.search_messages'), true);
  assert.equal(tools.isForgerConnectionActionId('memory.fetch'), false);
});

test('official tool skill packages load every supported scope and preserve resources', () => {
  for (const templates of [
    tools.buildGlobalSkillTemplates(),
    tools.buildPersonalAgentSkillTemplates(),
    tools.buildForgerWorkspaceSkillTemplates(),
    tools.buildInstalledAppSkillTemplates(),
    tools.buildInstalledAppSkillTemplates(['gmail.search_messages']),
    tools.buildForgerOfficialToolSkillTemplates(),
  ]) {
    assert.ok(templates.length > 0);
    assert.ok(templates.every((template) => template.id && template.description && template.body));
  }
  assert.match(tools.buildAppOfficialToolsSkillTemplate([]).body, /Forger/);
});

test('official skill packaging rejects malformed frontmatter and unsafe resource layouts', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forger-b24-skills-'));
  const promptBuilder = require('../../dist-electron/main/prompt-builder/index.js');
  const originalRoots = promptBuilder.promptTemplateRoots;
  promptBuilder.promptTemplateRoots = () => [root];
  const group = path.join(root, 'skills', 'global');
  try {
    assert.throws(() => tools.buildGlobalSkillTemplates(), /skill_group_not_found/);
    fs.mkdirSync(group, { recursive: true });
    fs.writeFileSync(path.join(group, 'bad.md'), 'missing frontmatter');
    assert.throws(() => tools.buildGlobalSkillTemplates(), /skill_frontmatter_missing/);
    fs.writeFileSync(path.join(group, 'bad.md'), '---\nname: bad\n---\nbody');
    assert.throws(() => tools.buildGlobalSkillTemplates(), /skill_frontmatter_invalid/);
    fs.writeFileSync(path.join(group, 'bad.md'), '---\nname: bad\ndescription: Bad\n---\nbody');
    fs.writeFileSync(path.join(group, 'bad'), 'not a directory');
    assert.throws(() => tools.buildGlobalSkillTemplates(), /skill_resource_path_invalid/);
    fs.rmSync(path.join(group, 'bad'));
    fs.mkdirSync(path.join(group, 'bad'));
    assert.equal(tools.buildGlobalSkillTemplates()[0].resources, undefined);
    fs.writeFileSync(path.join(group, 'bad', 'README.md'), 'unsafe');
    assert.throws(() => tools.buildGlobalSkillTemplates(), /skill_resource_path_invalid/);
    fs.rmSync(path.join(group, 'bad', 'README.md'));
    fs.symlinkSync(path.join(group, 'bad.md'), path.join(group, 'bad', 'linked'));
    assert.throws(() => tools.buildGlobalSkillTemplates(), /skill_resource_symlink/);
  } finally {
    promptBuilder.promptTemplateRoots = originalRoots;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
