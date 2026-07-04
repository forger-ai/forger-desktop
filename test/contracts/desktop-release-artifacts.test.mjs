import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

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
