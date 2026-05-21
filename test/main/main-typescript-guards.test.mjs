import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const root = process.cwd();
const mainRoot = path.join(root, 'src/main');

const listTypeScriptFiles = async (directory) => {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return listTypeScriptFiles(fullPath);
    }
    return entry.isFile() && entry.name.endsWith('.ts') ? [fullPath] : [];
  }));
  return files.flat();
};

test('main process sources stay under TypeScript checking', async () => {
  const offenders = [];
  for (const file of await listTypeScriptFiles(mainRoot)) {
    const source = await readFile(file, 'utf8');
    if (source.includes('@ts-nocheck')) {
      offenders.push(path.relative(root, file));
    }
  }

  assert.deepEqual(offenders, []);
});

test('main process dependency contracts are explicit', async () => {
  const offenders = [];
  const looseDepsPattern = /\btype\s+\w*Deps\s*=\s*Record\s*<\s*string\s*,\s*any\s*>/;
  for (const file of await listTypeScriptFiles(mainRoot)) {
    const source = await readFile(file, 'utf8');
    if (looseDepsPattern.test(source)) {
      offenders.push(path.relative(root, file));
    }
  }

  assert.deepEqual(offenders, []);
});
