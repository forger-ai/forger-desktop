import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_STACK = 'vite-fastapi-sqlite';
const SKIPPED_ENTRIES = new Set([
  '.DS_Store',
  '.git',
  '.gitmodules',
  '.idea',
  '.pytest_cache',
  '.ruff_cache',
  '.venv',
  '__pycache__',
  'build',
  'coverage',
  'dist',
  'node_modules',
]);

const hasSkeletonManifest = async (rootDir) => {
  try {
    const stat = await fs.stat(path.join(rootDir, 'manifest.json'));
    return stat.isFile();
  } catch {
    return false;
  }
};

const isSkippableSource = (sourcePath) =>
  sourcePath.split(path.sep).some((part) => SKIPPED_ENTRIES.has(part));

export const prepareAppSkeletonResource = async ({
  rootDir = path.resolve(fileURLToPath(import.meta.url), '..', '..'),
  stack = DEFAULT_STACK,
  sourceRoot = process.env.FORGER_APP_SKELETON_ROOT,
} = {}) => {
  const targetRoot = path.join(rootDir, 'resources', 'app-skeletons', stack);
  if (await hasSkeletonManifest(targetRoot)) {
    return { copied: false, sourceRoot: targetRoot, targetRoot };
  }

  const candidates = [
    sourceRoot,
    path.resolve(rootDir, '..', 'skeletons', stack),
    path.resolve(rootDir, '..', '..', 'skeletons', stack),
  ].filter(Boolean);

  const source = await candidates.reduce(async (previous, candidate) => {
    const resolved = await previous;
    if (resolved) {
      return resolved;
    }
    const candidateRoot = path.resolve(candidate);
    return (await hasSkeletonManifest(candidateRoot)) ? candidateRoot : undefined;
  }, Promise.resolve(undefined));

  if (!source) {
    throw new Error(
      [
        `App skeleton resource missing for ${stack}.`,
        `Expected ${path.join(targetRoot, 'manifest.json')}.`,
        'Set FORGER_APP_SKELETON_ROOT or check out the skeleton into resources/app-skeletons before packaging.',
      ].join(' '),
    );
  }

  await fs.rm(targetRoot, { recursive: true, force: true });
  await fs.mkdir(path.dirname(targetRoot), { recursive: true });
  await fs.cp(source, targetRoot, {
    recursive: true,
    filter: (sourcePath) => !isSkippableSource(sourcePath),
  });

  if (!await hasSkeletonManifest(targetRoot)) {
    throw new Error(`App skeleton resource copy did not produce ${path.join(targetRoot, 'manifest.json')}.`);
  }

  return { copied: true, sourceRoot: source, targetRoot };
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = await prepareAppSkeletonResource();
  const action = result.copied ? 'Prepared' : 'Found';
  console.log(`${action} app skeleton resource at ${result.targetRoot}`);
}
