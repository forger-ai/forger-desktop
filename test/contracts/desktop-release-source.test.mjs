import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

test('desktop release script knows every published installer artifact', async () => {
  const source = await readFile(new URL('../../scripts/release-local.mjs', import.meta.url), 'utf8');

  assert.match(source, /forger-desktop-macos-arm64\.dmg/);
  assert.match(source, /forger-desktop-macos-x64\.dmg/);
  assert.match(source, /forger-desktop-linux-x64\.deb/);
  assert.match(source, /forger-desktop-windows-x64\.exe/);
  assert.match(source, /return \['mac', 'linux', 'win'\]/);
  assert.doesNotMatch(source, /forger-desktop-windows-arm64\.exe/);
});
