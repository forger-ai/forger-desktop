import path from 'node:path';
import { realpath, stat, lstat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const executeFile = promisify(execFile);
export async function validateRepositoryRoot(root: string): Promise<string> {
  if (typeof root !== 'string' || !path.isAbsolute(root))
    throw new Error('Selecciona una carpeta de proyecto válida.');
  try {
    const canonical = await realpath(root);
    const resolved = path.resolve(root).replace(/^\/var\//, '/private/var/');
    if (canonical !== resolved || (await lstat(root)).isSymbolicLink())
      throw new Error('symlink');
    if (
      canonical === path.parse(canonical).root ||
      canonical === (await realpath(homedir())) ||
      !(await stat(canonical)).isDirectory()
    )
      throw new Error('directory');
    // The execution sandbox supports normal checkouts with local Git metadata.
    const git = await lstat(path.join(canonical, '.git'));
    if (!git.isDirectory() || git.isSymbolicLink()) throw new Error('git');
    const environment: NodeJS.ProcessEnv = {};
    for (const key of [
      'PATH',
      'SystemRoot',
      'WINDIR',
      'TEMP',
      'TMP',
      'TMPDIR',
    ]) {
      if (process.env[key]) environment[key] = process.env[key];
    }
    const { stdout } = await executeFile(
      'git',
      ['-C', canonical, 'rev-parse', '--show-toplevel'],
      {
        timeout: 5000,
        maxBuffer: 8192,
        env: {
          ...environment,
          GIT_OPTIONAL_LOCKS: '0',
          LC_ALL: 'C',
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
        },
      },
    );
    if ((await realpath(stdout.trim())) !== canonical) throw new Error('root');
    return canonical;
  } catch {
    throw new Error(
      'La carpeta seleccionada no es un repositorio Git disponible.',
    );
  }
}
export function rootsOverlap(left: string, right: string): boolean {
  const a = process.platform === 'win32' ? left.toLowerCase() : left;
  const b = process.platform === 'win32' ? right.toLowerCase() : right;
  return a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep);
}
export function validateRepositoryName(name: string): string {
  const clean = typeof name === 'string' ? name.trim() : '';
  if (!clean || clean.length > 80 || /[:+#@\r\n]/.test(clean))
    throw new Error('Usa un nombre de proyecto breve sin signos de comando.');
  return clean;
}
