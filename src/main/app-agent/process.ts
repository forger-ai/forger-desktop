import { spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { AppAgentCommandResult, LlmCommandCaptureOptions, ResolvedLlmCommand } from './types';
import { spawnProcess } from '../runtime/process-spawn';
import { guardChildStdin } from '../child-stdio';
import { createLlmProviderRunService } from '../llm-provider/run-service';

export const runCommandCapture = async (
  command: string,
  args: string[],
  options: LlmCommandCaptureOptions,
): Promise<AppAgentCommandResult> =>
  await new Promise<AppAgentCommandResult>((resolve, reject) => {
    const child = spawnProcess(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...(options.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });

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

    guardChildStdin(child, (error) => {
      clearCommandTimeout();
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
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
    options.onChild?.(child);
    child.stdin.end(options.stdinText ?? '');
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

export const killServiceProcessesForMetadataRoot = (
  serviceSourcePath: string,
  metadataRoot: string,
): void => {
  if (process.platform === 'win32') {
    return;
  }
  const result = spawnSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' });
  if (result.error || !result.stdout) {
    return;
  }
  const currentPid = process.pid;
  for (const line of result.stdout.split('\n')) {
    const match = line.trimStart().match(/^(\d+)\s+(.+)$/);
    if (!match) {
      continue;
    }
    const pid = Number(match[1]);
    const command = match[2] ?? '';
    if (!Number.isFinite(pid) || pid === currentPid) {
      continue;
    }
    if (!command.includes(serviceSourcePath) || !command.includes('--metadata-root') || !command.includes(metadataRoot)) {
      continue;
    }
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // Process may have already exited.
    }
  }
};

export const resolveCodexCommand = async (
  codexCliPath: string,
  pathEntries: string[],
): Promise<ResolvedLlmCommand> =>
  await createLlmProviderRunService().resolveCommand('codex', codexCliPath, pathEntries);

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
