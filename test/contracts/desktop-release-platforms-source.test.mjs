import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..', '..');

test('desktop release config builds stable macOS/Windows artifacts and experimental x64 artifacts only', async () => {
  const pkg = JSON.parse(await fs.readFile(path.join(rootDir, 'package.json'), 'utf8'));
  const releaseLocalSource = await fs.readFile(path.join(rootDir, 'scripts', 'release-local.mjs'), 'utf8');
  const releaseWorkflow = await fs.readFile(path.join(rootDir, '.github', 'workflows', 'release.yml'), 'utf8');

  assert.match(pkg.scripts['dist:mac'], /electron-builder --mac dmg --arm64 --x64 --publish never/);
  assert.match(pkg.scripts['dist:win'], /electron-builder --win nsis --x64 --publish never/);
  assert.doesNotMatch(pkg.scripts['dist:win'], /--arm64/);
  assert.match(pkg.scripts['dist:linux'], /electron-builder --linux deb --x64 --publish never/);

  assert.deepEqual(pkg.build.mac.target[0].arch, ['arm64', 'x64']);
  assert.deepEqual(pkg.build.win.target[0].arch, ['x64']);
  assert.deepEqual(pkg.build.linux.target[0].arch, ['x64']);
  assert.match(pkg.build.linux.maintainer, /@/);
  assert.equal(pkg.build.dmg.artifactName, 'forger-desktop-macos-${arch}.${ext}');
  assert.equal(pkg.build.nsis.artifactName, 'forger-desktop-windows-x64.${ext}');
  assert.equal(pkg.build.deb.artifactName, 'forger-desktop-linux-x64.${ext}');

  assert.match(releaseLocalSource, /forger-desktop-macos-arm64\.dmg/);
  assert.match(releaseLocalSource, /forger-desktop-macos-x64\.dmg/);
  assert.match(releaseLocalSource, /forger-desktop-linux-x64\.deb/);
  assert.match(releaseLocalSource, /forger-desktop-windows-x64\.exe/);
  assert.doesNotMatch(releaseLocalSource, /windows-arm64|win32_arm64/);

  assert.match(releaseWorkflow, /forger-desktop-macos-arm64\.dmg/);
  assert.match(releaseWorkflow, /forger-desktop-macos-x64\.dmg/);
  assert.match(releaseWorkflow, /forger-desktop-linux-x64\.deb/);
  assert.match(releaseWorkflow, /forger-desktop-windows-x64\.exe/);
});
