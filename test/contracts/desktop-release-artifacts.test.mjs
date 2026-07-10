import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..', '..');

const PUBLISHED_ARTIFACTS = [
  'forger-desktop-macos-arm64.dmg',
  'forger-desktop-macos-x64.dmg',
  'forger-desktop-linux-x64.deb',
  'forger-desktop-windows-x64.exe',
];

test('desktop release config produces exactly the published installer artifacts', async () => {
  const pkg = JSON.parse(await fs.readFile(path.join(rootDir, 'package.json'), 'utf8'));

  assert.deepEqual(pkg.build.mac.target[0].arch, ['arm64', 'x64']);
  assert.deepEqual(pkg.build.win.target[0].arch, ['x64']);
  assert.deepEqual(pkg.build.linux.target[0].arch, ['x64']);
  assert.match(pkg.build.linux.maintainer, /@/);
  assert.equal(pkg.build.dmg.artifactName, 'forger-desktop-macos-${arch}.${ext}');
  assert.equal(pkg.build.nsis.artifactName, 'forger-desktop-windows-x64.${ext}');
  assert.equal(pkg.build.deb.artifactName, 'forger-desktop-linux-x64.${ext}');
});

test('release script and workflow know every published installer artifact', async () => {
  const releaseLocalSource = await fs.readFile(path.join(rootDir, 'scripts', 'release-local.mjs'), 'utf8');
  const releaseWorkflow = await fs.readFile(path.join(rootDir, '.github', 'workflows', 'release.yml'), 'utf8');

  for (const artifact of PUBLISHED_ARTIFACTS) {
    assert.ok(releaseLocalSource.includes(artifact), `release-local.mjs should publish ${artifact}`);
    assert.ok(releaseWorkflow.includes(artifact), `release.yml should publish ${artifact}`);
  }
});

test('release script discovers macOS runtime archives without shell find', async (t) => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'forger-release-archives-'));
  t.after(() => fs.rm(tmpDir, { recursive: true, force: true }));

  const pythonRoot = path.join(tmpDir, 'python');
  const gitRoot = path.join(tmpDir, 'git');
  await fs.mkdir(path.join(pythonRoot, '3.12'), { recursive: true });
  await fs.mkdir(path.join(gitRoot, '2.54.0'), { recursive: true });
  await fs.writeFile(
    path.join(pythonRoot, '3.12', 'cpython-3.12.13+20260414-aarch64-apple-darwin-install_only_stripped.tar.gz'),
    'python-arm64',
  );
  await fs.writeFile(
    path.join(pythonRoot, '3.12', 'cpython-3.12.13+20260414-x86_64-unknown-linux-gnu-install_only_stripped.tar.gz'),
    'python-linux',
  );
  await fs.writeFile(
    path.join(gitRoot, '2.54.0', 'git-2.54.0-aarch64-apple-darwin.tar.gz'),
    'git-arm64',
  );

  const releaseScript = await import(pathToFileURL(path.join(rootDir, 'scripts', 'release-local.mjs')).href);
  const archives = await releaseScript.collectMacRuntimeArchives([pythonRoot, gitRoot]);

  assert.deepEqual(archives.map((archive) => path.relative(tmpDir, archive)), [
    path.join('git', '2.54.0', 'git-2.54.0-aarch64-apple-darwin.tar.gz'),
    path.join('python', '3.12', 'cpython-3.12.13+20260414-aarch64-apple-darwin-install_only_stripped.tar.gz'),
  ]);
});
