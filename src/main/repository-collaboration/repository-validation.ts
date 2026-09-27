import path from 'node:path';
import { realpath, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const executeFile = promisify(execFile);
export async function validateRepositoryRoot(root: string): Promise<string> {
  if (typeof root !== 'string' || !path.isAbsolute(root))
    throw new Error('Selecciona una carpeta de proyecto válida.');
  try {
    const canonical = await realpath(root);
    if (!(await stat(canonical)).isDirectory()) throw new Error('directory');
    // Git worktrees have a .git file; ordinary repositories have a directory.
    const git = await stat(path.join(canonical, '.git'));
    if (!git.isDirectory() && !git.isFile()) throw new Error('git');
    const { stdout } = await executeFile(
      'git',
      ['-C', canonical, 'rev-parse', '--show-toplevel'],
      {
        timeout: 5000,
        maxBuffer: 8192,
        env: {
          ...process.env,
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
