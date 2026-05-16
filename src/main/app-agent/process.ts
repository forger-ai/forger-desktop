import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { CommandCaptureOptions, CommandResult, ResolvedCodexCommand } from './types';

export const runCommandCapture = async (
  command: string,
  args: string[],
  options: CommandCaptureOptions,
): Promise<CommandResult> =>
  await new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...(options.env ?? {}) },
      shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(command),
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    options.onChild?.(child);
    child.stdin.end(options.stdinText ?? '');

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timeout: NodeJS.Timeout | null = null;
    const clearCommandTimeout = (): void => {
      if (timeout) {
        clearTimeout(timeout);
        timeout = null;
      }
    };
    const refreshCommandTimeout = (): void => {
      if (!options.timeoutMs || settled) {
        return;
      }
      clearCommandTimeout();
      timeout = setTimeout(() => {
        killProcessTree(child);
        if (!settled) {
          settled = true;
          reject(new Error(`codex_timeout_after_${options.timeoutMs}ms`));
        }
      }, options.timeoutMs);
    };
    refreshCommandTimeout();

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      stdout += text;
      options.onStdout?.(text);
      refreshCommandTimeout();
    });
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      options.onStderr?.(text);
      refreshCommandTimeout();
    });
    child.on('error', (error) => {
      clearCommandTimeout();
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    child.on('exit', (code) => {
      clearCommandTimeout();
      if (!settled) {
        settled = true;
        resolve({ code: typeof code === 'number' ? code : 1, stdout, stderr });
      }
    });
  });

export const killProcessTree = (child: ChildProcessWithoutNullStreams | undefined): void => {
  if (!child || child.killed) {
    return;
  }
  try {
    if (process.platform !== 'win32' && typeof child.pid === 'number') {
      process.kill(-child.pid, 'SIGKILL');
    } else {
      child.kill('SIGKILL');
    }
  } catch {
    child.kill('SIGKILL');
  }
};

export const resolveCodexCommand = async (
  codexCliPath: string,
  pathEntries: string[],
): Promise<ResolvedCodexCommand> => {
  if (process.platform !== 'win32' || !/\.(cmd|bat)$/i.test(codexCliPath)) {
    return {
      command: codexCliPath,
      prefixArgs: [],
      pathEntries: [path.dirname(codexCliPath), ...pathEntries],
    };
  }
  const nodePath = await findExecutableInPathEntries(pathEntries, ['node.exe', 'node']);
  const codexEntrypoint = path.join(path.resolve(path.dirname(codexCliPath), '..'), '@openai', 'codex', 'bin', 'codex.js');
  if (!nodePath || !(await existsFile(codexEntrypoint))) {
    throw new Error('codex_js_entrypoint_missing');
  }
  return {
    command: nodePath,
    prefixArgs: [codexEntrypoint],
    pathEntries: [path.dirname(nodePath), path.dirname(codexCliPath), ...pathEntries],
  };
};

export const findExecutableInPathEntries = async (entries: string[], executableNames: string[]): Promise<string | null> => {
  for (const entry of entries) {
    for (const executableName of executableNames) {
      const candidate = path.join(entry, executableName);
      if (await existsFile(candidate)) {
        return candidate;
      }
    }
  }
  return null;
};

export const existsFile = async (filePath: string): Promise<boolean> => {
  try {
    return (await fs.stat(filePath)).isFile();
  } catch {
    return false;
  }
};

export const existsDirectory = async (dirPath: string): Promise<boolean> => {
  try {
    return (await fs.stat(dirPath)).isDirectory();
  } catch {
    return false;
  }
};

export const isPathInside = (target: string, root: string): boolean => {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};
