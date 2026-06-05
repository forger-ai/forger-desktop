import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const docsRoot = resolve(repoRoot, '.forger-docs');
const packagePath = resolve(docsRoot, 'package.json');
const outputPath = resolve(repoRoot, 'src/renderer/docs/forger-docs.generated.ts');

if (!existsSync(packagePath)) {
  console.error(`Forger docs repo not found at ${docsRoot}. Check out forger-ai/forger-docs into .forger-docs before building.`);
  process.exit(1);
}

const run = (args) => {
  const result = spawnSync('npm', args, { cwd: docsRoot, stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
};

run(['run', 'build']);
run(['run', 'export', '--', '--out', outputPath]);
