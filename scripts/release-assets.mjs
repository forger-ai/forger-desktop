import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

export const INSTALLERS = Object.freeze([
  'forger-desktop-macos-arm64.dmg',
  'forger-desktop-macos-x64.dmg',
  'forger-desktop-linux-x64.deb',
  'forger-desktop-windows-x64.exe',
]);
const execute = promisify(execFile);
const runGh = async (args) => (await execute('gh', args, { maxBuffer: 8 * 1024 * 1024 })).stdout;

async function releaseMetadata({ tag, repository, gh }) {
  if (!/^forger-desktop\/v\d+\.\d+\.\d+$/.test(tag) || !/^[\w.-]+\/[\w.-]+$/.test(repository)) {
    throw new Error('A Desktop release tag and repository are required.');
  }
  // GitHub's by-tag REST endpoint omits private drafts; gh resolves drafts through its authenticated lookup.
  const release = JSON.parse(await gh(['release', 'view', tag, '--repo', repository, '--json', 'body,isDraft,assets']));
  if (!release.body?.trim() || release.body.trim() === `Forger Desktop v${tag.split('/v')[1]}` || !/^\s*[-*]\s+\S/m.test(release.body)) {
    throw new Error(`Release ${tag} must exist with changelog notes before publishing artifacts.`);
  }
  return release;
}

async function fingerprint(filename) {
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of createReadStream(filename)) {
    hash.update(chunk);
    size += chunk.length;
  }
  if (!size) throw new Error(`Empty release artifact: ${path.basename(filename)}`);
  return { digest: `sha256:${hash.digest('hex')}`, size };
}

async function verifiedFiles(directory, installers) {
  if (!installers.length || installers.some((name) => !INSTALLERS.includes(name))) {
    throw new Error('Select only the declared Desktop installers.');
  }
  const files = [];
  for (const name of new Set(installers)) {
    const installer = await fingerprint(path.join(directory, name));
    const checksum = (await fs.readFile(path.join(directory, `${name}.sha256`), 'utf8')).trim().split(/\s+/);
    if (checksum.length !== 2 || !/^[a-fA-F0-9]{64}$/.test(checksum[0]) ||
        `sha256:${checksum[0].toLowerCase()}` !== installer.digest ||
        ![name, `release/${name}`].includes(checksum[1].replace(/^\*/, ''))) {
      throw new Error(`Invalid checksum for ${name}`);
    }
    files.push({ name, ...installer }, { name: `${name}.sha256`, ...await fingerprint(path.join(directory, `${name}.sha256`)) });
    const blockmap = `${name}.blockmap`;
    try {
      files.push({ name: blockmap, ...await fingerprint(path.join(directory, blockmap)) });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return files;
}

export async function stageReleaseAssets({ tag, repository, directory, installers, gh = runGh }) {
  const release = await releaseMetadata({ tag, repository, gh });
  if (!release.isDraft) {
    throw new Error('Prepare the release as a draft with --latest=false before staging installers.');
  }
  const files = await verifiedFiles(directory, installers);
  // A retry may keep an identical completed upload; never delete or replace existing assets.
  for (const file of files) {
    const existing = release.assets.find((asset) => asset.name === file.name);
    if (existing && (existing.size !== file.size || existing.digest !== file.digest)) {
      throw new Error(`Release asset ${file.name} already exists with different or unverifiable content.`);
    }
  }
  for (const file of files) {
    if (!release.assets.some((asset) => asset.name === file.name)) {
      await gh(['release', 'upload', tag, path.join(directory, file.name)]);
    }
  }
}

export async function publishReleaseAssets({ tag, repository, directory, gh = runGh }) {
  await releaseMetadata({ tag, repository, gh });
  await gh(['release', 'download', tag, '--dir', directory,
    ...INSTALLERS.flatMap((name) => ['--pattern', name, '--pattern', `${name}.sha256`])]);
  await verifiedFiles(directory, INSTALLERS);
  await gh(['release', 'edit', tag, '--draft=false', '--prerelease=false', '--latest']);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [mode] = process.argv.slice(2);
  const options = { tag: process.env.TAG_NAME, repository: process.env.GH_REPO ?? process.env.GITHUB_REPOSITORY };
  if (mode === 'stage') {
    await stageReleaseAssets({ ...options, directory: path.resolve('release'), installers: (process.env.ARTIFACTS ?? '').split(/\r?\n/).map((name) => name.trim()).filter(Boolean) });
  } else if (mode === 'publish') {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'forger-release-verify-'));
    try {
      await publishReleaseAssets({ ...options, directory });
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  } else {
    throw new Error('Usage: node scripts/release-assets.mjs stage|publish');
  }
}
