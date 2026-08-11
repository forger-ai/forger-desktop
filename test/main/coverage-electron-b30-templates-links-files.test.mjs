import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  forgerSkillRoots,
  normalizeSkillTemplateBody,
  removeUndeclaredSkillTemplates,
  writeSkillTemplates,
} = require('../../dist-electron/main/prompt-builder/skill-template-writer.js');
const { extractDeepLinkFromArgv, parseForgerUrl } = require('../../dist-electron/main/deep-links.js');
const { FileLibrary } = require('../../dist-electron/main/file-library.js');
const connectorBarrel = require('../../dist-electron/main/connections/modules/token-service-connectors/index.js');

const fixture = async (t, name) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `forger-b30-${name}-`));
  t.after(async () => await fs.rm(root, { recursive: true, force: true }));
  return root;
};

const skill = (overrides = {}) => ({
  id: 'review-files',
  description: 'Review files safely',
  body: '# Review\n\nUse the declared resources.',
  ...overrides,
});

test('Given skill bodies with and without legacy frontmatter, when normalized, then one canonical manifest is emitted', () => {
  assert.equal(normalizeSkillTemplateBody(skill()), [
    '---',
    'name: "review-files"',
    'description: "Review files safely"',
    '---',
    '# Review',
    '',
    'Use the declared resources.',
  ].join('\n'));
  assert.equal(normalizeSkillTemplateBody(skill({
    body: '---\r\nname: old\r\ndescription: old\r\n---\r\n\r\n  # Current',
  })), [
    '---',
    'name: "review-files"',
    'description: "Review files safely"',
    '---',
    '# Current',
  ].join('\n'));
});

test('Given declared templates and stale directories, when templates are written, then roots mirror declarations and nested resources exactly', async (t) => {
  const root = await fixture(t, 'skills');
  const skillsRoot = path.join(root, 'skills');
  await fs.mkdir(path.join(skillsRoot, 'stale'), { recursive: true });
  await fs.mkdir(path.join(skillsRoot, 'review-files'), { recursive: true });
  await fs.writeFile(path.join(skillsRoot, 'keep.txt'), 'ordinary file');

  await writeSkillTemplates({ fs, path }, skillsRoot, [
    skill({
      resources: [
        { path: 'references/guide.md', content: '# Guide' },
        { path: 'scripts\\inspect.txt', content: Buffer.from('inspect') },
      ],
    }),
    skill({ id: 'no-resources', description: 'No resources' }),
  ]);

  await assert.rejects(fs.access(path.join(skillsRoot, 'stale')));
  assert.equal(await fs.readFile(path.join(skillsRoot, 'keep.txt'), 'utf8'), 'ordinary file');
  assert.match(await fs.readFile(path.join(skillsRoot, 'review-files', 'SKILL.md'), 'utf8'), /name: "review-files"/);
  assert.equal(await fs.readFile(path.join(skillsRoot, 'review-files', 'README.md'), 'utf8'), 'Review files safely\n');
  assert.equal(await fs.readFile(path.join(skillsRoot, 'review-files', 'references', 'guide.md'), 'utf8'), '# Guide');
  assert.equal(await fs.readFile(path.join(skillsRoot, 'review-files', 'scripts', 'inspect.txt'), 'utf8'), 'inspect');
  assert.deepEqual(forgerSkillRoots(path, root), [
    path.join(root, '.agents', 'skills'),
    path.join(root, '.claude', 'skills'),
  ]);
});

test('Given absent roots, filesystem failures, and unsafe resource names, when skill synchronization runs, then missing roots are tolerated and unsafe paths are rejected', async (t) => {
  const root = await fixture(t, 'skill-security');
  const absent = path.join(root, 'absent');
  await removeUndeclaredSkillTemplates({ fs, path }, absent, []);

  const denied = new Error('permission denied');
  denied.code = 'EACCES';
  await assert.rejects(removeUndeclaredSkillTemplates({
    fs: { readdir: async () => { throw denied; } },
    path,
  }, absent, []), /permission denied/);

  for (const resourcePath of ['', '/absolute.txt', '.', '..', 'nested//empty.txt', 'SKILL.md', 'README.md']) {
    await assert.rejects(writeSkillTemplates({ fs, path }, path.join(root, `unsafe-${resourcePath.length}`), [skill({
      resources: [{ path: resourcePath, content: 'blocked' }],
    })]), /skill_resource_path_invalid/);
  }
});

test('Given malformed social links and mixed argv values, when deep links are parsed, then incomplete payloads remain unknown and scanning continues safely', () => {
  for (const raw of [
    'forger://social/app',
    'forger://social/app?code=%20&id=not-a-number',
    'forger://social/profile',
    'forger://social/profile?username=%20',
  ]) {
    assert.deepEqual(parseForgerUrl(raw), { kind: 'unknown', raw });
  }
  assert.equal(parseForgerUrl(42), null);
  assert.deepEqual(parseForgerUrl('forger:chat'), { kind: 'unknown', raw: 'forger:chat' });
  assert.deepEqual(extractDeepLinkFromArgv([42, 'forger://social/app?id=invalid', 'forger://chat']), {
    kind: 'unknown',
    raw: 'forger://social/app?id=invalid',
  });
});

test('Given the token connector barrel, when modules are enumerated, then every exported module appears exactly once in stable order', () => {
  const expectedNames = [
    'figmaToolModule',
    'zendeskToolModule',
    'discordToolModule',
    'calendlyToolModule',
    'gitlabToolModule',
    'shopifyToolModule',
    'whatsappBusinessToolModule',
    'telegramToolModule',
    'sendgridToolModule',
    'postmarkToolModule',
    'twilioToolModule',
    'metaAdsToolModule',
  ];
  assert.deepEqual(connectorBarrel.tokenServiceConnectorModules, expectedNames.map((name) => connectorBarrel[name]));
  assert.equal(new Set(connectorBarrel.tokenServiceConnectorModules).size, expectedNames.length);
});

test('Given non-files, nested categories, category moves, and Windows-style containment checks, when FileLibrary mutates state, then it rejects invalid sources and stays inside its roots', async (t) => {
  const root = await fixture(t, 'file-library');
  const dataRoot = path.join(root, 'data');
  const metadataRoot = path.join(root, 'metadata');
  const library = new FileLibrary(dataRoot, metadataRoot);

  await assert.rejects(library.importFiles({
    sources: [{
      fileHandle: { stat: async () => ({ isFile: () => false }) },
      name: 'directory',
    }],
  }), /file_selection_not_file/);

  await fs.mkdir(path.join(dataRoot, 'Parent', 'Child'), { recursive: true });
  const nestedRename = await library.renameCategory({ categoryPath: 'Parent/Child', newName: 'Renamed' });
  assert.equal(nestedRename.success, true);
  assert.ok(await fs.stat(path.join(dataRoot, 'Parent', 'Renamed')));

  const source = path.join(root, 'source.txt');
  await fs.writeFile(source, 'content');
  const [imported] = await library.importFiles({ sourcePaths: [source] });
  await library.createCategory({ name: 'Target' });
  const [moved] = await library.moveFiles({ fileIds: [imported.id], categoryPath: 'Target' });
  assert.equal(moved.relativePath, 'Target/source.txt');

  const staged = await library.stageFileForChat({
    name: 'Case Test',
    mimeType: 'image/png',
    dataBase64: Buffer.from('png').toString('base64'),
  });
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  try {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    await library.discardStagedFilesForChat({ sourcePaths: [staged.sourcePath] });
  } finally {
    Object.defineProperty(process, 'platform', platform);
  }
  await assert.rejects(fs.access(staged.sourcePath));
});
