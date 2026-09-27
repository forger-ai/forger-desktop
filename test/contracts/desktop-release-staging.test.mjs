import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { stageReleaseAssets, publishReleaseAssets, INSTALLERS } from '../../scripts/release-assets.mjs';

const tag = 'forger-desktop/v0.5.20';
const repository = 'forger-ai/forger-desktop';
const notes = 'WhatsApp collaboration is available.\n\n- Configure groups and access.';
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'forger-release-staging-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  for (const name of INSTALLERS) {
    const bytes = Buffer.from(`synthetic installer ${name}`);
    await fs.writeFile(path.join(directory, name), bytes);
    await fs.writeFile(path.join(directory, `${name}.sha256`), `${createHash('sha256').update(bytes).digest('hex')}  release/${name}\n`);
  }
  return directory;
}
const metadata = () => ({ body: notes, draft: false, prerelease: true, assets: [] });

test('staging uploads only verified platform installers and keeps the release unrecommended', async (t) => {
  const directory = await fixture(t); const calls = [];
  await stageReleaseAssets({ tag, repository, directory, installers: INSTALLERS.slice(0, 2), gh: async (args) => { calls.push(args); return JSON.stringify(metadata()); } });
  assert.equal(calls.filter((args) => args[1] === 'upload').length, 4);
  assert.ok(calls.every((args) => !args.includes('--latest') && !args.includes('--clobber') && args[1] !== 'edit'));
});

test('staging fails before upload for stable releases, missing changelog, or corrupted installer', async (t) => {
  const directory = await fixture(t);
  for (const release of [{ ...metadata(), prerelease: false }, { ...metadata(), body: '' }, { ...metadata(), body: 'Forger Desktop v0.5.20' }]) {
    const calls = [];
    await assert.rejects(stageReleaseAssets({ tag, repository, directory, installers: [INSTALLERS[0]], gh: async (args) => { calls.push(args); return JSON.stringify(release); } }));
    assert.equal(calls.length, 1);
  }
  await fs.appendFile(path.join(directory, INSTALLERS[0]), 'corrupt');
  await assert.rejects(stageReleaseAssets({ tag, repository, directory, installers: [INSTALLERS[0]], gh: async () => JSON.stringify(metadata()) }), /checksum/);
});

test('staging retries reuse identical assets and refuse replacing a different existing file', async (t) => {
  const directory = await fixture(t); const name = INSTALLERS[0];
  const bytes = await fs.readFile(path.join(directory, name));
  const asset = { name, size: bytes.length, digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}` };
  const calls = [];
  await stageReleaseAssets({ tag, repository, directory, installers: [name], gh: async (args) => { calls.push(args); return JSON.stringify({ ...metadata(), assets: [asset] }); } });
  assert.equal(calls.filter((args) => args[1] === 'upload').length, 1);
  await assert.rejects(stageReleaseAssets({ tag, repository, directory, installers: [name], gh: async () => JSON.stringify({ ...metadata(), assets: [{ ...asset, digest: 'sha256:wrong' }] }) }), /already exists/);
});

test('publication verifies every downloaded installer checksum before marking the release latest', async (t) => {
  const directory = await fixture(t); const calls = [];
  await publishReleaseAssets({ tag, repository, directory, gh: async (args) => { calls.push(args); return JSON.stringify(metadata()); } });
  assert.equal(calls[1][1], 'download');
  assert.deepEqual(calls.at(-1), ['release', 'edit', tag, '--draft=false', '--prerelease=false', '--latest']);
  await fs.unlink(path.join(directory, INSTALLERS[3])); calls.length = 0;
  await assert.rejects(publishReleaseAssets({ tag, repository, directory, gh: async (args) => { calls.push(args); return JSON.stringify(metadata()); } }));
  assert.ok(calls.every((args) => args[1] !== 'edit'));
});

test('workflow avoids Actions artifact storage and preserves validation, notarization and all-build publication gates', async () => {
  const workflow = await fs.readFile(new URL('../../.github/workflows/release.yml', import.meta.url), 'utf8');
  assert.doesNotMatch(workflow, /actions\/(?:upload|download)-artifact/);
  assert.match(workflow, /needs: \[validate, build\]/);
  assert.match(workflow, /release:ci:mac/);
  assert.match(workflow, /test:coverage:electron:strict/);
  assert.match(workflow, /test:coverage:renderer/);
  assert.match(workflow, /release-assets\.mjs stage/);
  assert.match(workflow, /release-assets\.mjs publish/);
});

test('invalid checksum names, missing sidecars and unexpected artifact selection never upload', async (t) => {
  const directory = await fixture(t); const calls = [];
  const gh = async (args) => { calls.push(args); return JSON.stringify(metadata()); };
  const options = { tag, repository, directory, gh };
  for (const installers of [[], ['../private'], ['unknown.exe']]) await assert.rejects(stageReleaseAssets({ ...options, installers }));
  const name = INSTALLERS[0]; const sidecar = path.join(directory, `${name}.sha256`);
  await fs.writeFile(sidecar, (await fs.readFile(sidecar, 'utf8')).replace(name, 'different.dmg'));
  await assert.rejects(stageReleaseAssets({ ...options, installers: [name] }), /checksum/);
  await fs.unlink(sidecar);
  await assert.rejects(stageReleaseAssets({ ...options, installers: [name] }));
  assert.ok(calls.every((args) => args[1] !== 'upload'));
});

test('failed download or mismatched published bytes never promotes a partial release', async (t) => {
  const directory = await fixture(t); const calls = [];
  const gh = async (args) => { calls.push(args); if (args[1] === 'download') throw new Error('download incomplete'); return JSON.stringify(metadata()); };
  await assert.rejects(publishReleaseAssets({ tag, repository, directory, gh }), /download incomplete/);
  assert.ok(calls.every((args) => args[1] !== 'edit'));
  await fs.writeFile(path.join(directory, INSTALLERS[2]), 'tampered'); calls.length = 0;
  await assert.rejects(publishReleaseAssets({ tag, repository, directory, gh: async (args) => { calls.push(args); return JSON.stringify(metadata()); } }), /checksum/);
  assert.ok(calls.every((args) => args[1] !== 'edit'));
});

test('optional blockmaps are preserved and a failed upload cannot publish or replace files', async (t) => {
  const directory = await fixture(t); const calls = [];
  await fs.writeFile(path.join(directory, `${INSTALLERS[0]}.blockmap`), 'blockmap');
  await stageReleaseAssets({ tag, repository, directory, installers: [INSTALLERS[0]], gh: async (args) => { calls.push(args); return JSON.stringify({ ...metadata(), draft: true, prerelease: false }); } });
  assert.equal(calls.filter((args) => args[1] === 'upload').length, 3);
  calls.length = 0;
  await assert.rejects(stageReleaseAssets({ tag, repository, directory, installers: [INSTALLERS[0]], gh: async (args) => { calls.push(args); if (args[1] === 'upload') throw new Error('network failed'); return JSON.stringify(metadata()); } }), /network failed/);
  assert.ok(calls.every((args) => args[1] !== 'edit' && !args.includes('--clobber')));
});
