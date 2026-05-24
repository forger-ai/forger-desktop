import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { prepareAppSkeletonResource } from '../../scripts/prepare-app-skeleton-resource.mjs';

const makeRoot = async () => fs.mkdtemp(path.join(os.tmpdir(), 'forger-skeleton-resource-'));

const writeSkeleton = async (rootDir, stack = 'vite-fastapi-sqlite') => {
  const skeletonRoot = path.join(rootDir, 'skeletons', stack);
  await fs.mkdir(path.join(skeletonRoot, '.git'), { recursive: true });
  await fs.mkdir(path.join(skeletonRoot, '.idea'), { recursive: true });
  await fs.mkdir(path.join(skeletonRoot, 'frontend', 'node_modules', 'ignored'), { recursive: true });
  await fs.mkdir(path.join(skeletonRoot, 'backend', '__pycache__'), { recursive: true });
  await fs.writeFile(path.join(skeletonRoot, 'manifest.json'), '{"name":"skeleton"}\n', 'utf8');
  await fs.writeFile(path.join(skeletonRoot, '.gitmodules'), '[submodule]\n', 'utf8');
  await fs.writeFile(path.join(skeletonRoot, '.git', 'config'), '[core]\n', 'utf8');
  await fs.writeFile(path.join(skeletonRoot, '.idea', 'workspace.xml'), '<project />\n', 'utf8');
  await fs.writeFile(path.join(skeletonRoot, 'frontend', 'package.json'), '{"scripts":{}}\n', 'utf8');
  await fs.writeFile(path.join(skeletonRoot, 'frontend', 'node_modules', 'ignored', 'file'), 'ignored\n', 'utf8');
  await fs.writeFile(path.join(skeletonRoot, 'backend', '__pycache__', 'app.pyc'), 'ignored\n', 'utf8');
  return skeletonRoot;
};

test('app skeleton resource preparation copies the workspace skeleton and omits generated entries', async (t) => {
  const workspaceRoot = await makeRoot();
  const desktopRoot = path.join(workspaceRoot, 'desktop');
  t.after(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  await fs.mkdir(desktopRoot, { recursive: true });
  const sourceRoot = await writeSkeleton(workspaceRoot);

  const result = await prepareAppSkeletonResource({ rootDir: desktopRoot });

  const targetRoot = path.join(desktopRoot, 'resources', 'app-skeletons', 'vite-fastapi-sqlite');
  assert.equal(result.copied, true);
  assert.equal(result.sourceRoot, sourceRoot);
  assert.equal(result.targetRoot, targetRoot);
  assert.equal(await fs.readFile(path.join(targetRoot, 'manifest.json'), 'utf8'), '{"name":"skeleton"}\n');
  assert.equal(await fs.readFile(path.join(targetRoot, 'frontend', 'package.json'), 'utf8'), '{"scripts":{}}\n');
  await assert.rejects(fs.stat(path.join(targetRoot, '.git')), /ENOENT/);
  await assert.rejects(fs.stat(path.join(targetRoot, '.gitmodules')), /ENOENT/);
  await assert.rejects(fs.stat(path.join(targetRoot, '.idea')), /ENOENT/);
  await assert.rejects(fs.stat(path.join(targetRoot, 'frontend', 'node_modules')), /ENOENT/);
  await assert.rejects(fs.stat(path.join(targetRoot, 'backend', '__pycache__')), /ENOENT/);
});

test('app skeleton resource preparation accepts an existing checked-out resource', async (t) => {
  const desktopRoot = await makeRoot();
  t.after(async () => {
    await fs.rm(desktopRoot, { recursive: true, force: true });
  });

  const targetRoot = path.join(desktopRoot, 'resources', 'app-skeletons', 'vite-fastapi-sqlite');
  await fs.mkdir(targetRoot, { recursive: true });
  await fs.writeFile(path.join(targetRoot, 'manifest.json'), '{"name":"checked-out"}\n', 'utf8');

  const result = await prepareAppSkeletonResource({ rootDir: desktopRoot });

  assert.equal(result.copied, false);
  assert.equal(result.sourceRoot, targetRoot);
  assert.equal(result.targetRoot, targetRoot);
  assert.equal(await fs.readFile(path.join(targetRoot, 'manifest.json'), 'utf8'), '{"name":"checked-out"}\n');
});

test('app skeleton resource preparation fails before packaging when no skeleton is available', async (t) => {
  const desktopRoot = await makeRoot();
  t.after(async () => {
    await fs.rm(desktopRoot, { recursive: true, force: true });
  });

  await assert.rejects(
    prepareAppSkeletonResource({ rootDir: desktopRoot, sourceRoot: path.join(desktopRoot, 'missing') }),
    /App skeleton resource missing for vite-fastapi-sqlite/,
  );
});
