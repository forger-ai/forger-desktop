import path from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type {
  LlmRunCommandCaptureOptions,
  LlmCommandResult,
} from '../llm-provider/types';

export function buildRepositoryEnvironment(input: {
  home: string;
  codexHome: string;
  tempRoot: string;
  pathEntries: string[];
}): NodeJS.ProcessEnv {
  return {
    HOME: input.home,
    CODEX_HOME: input.codexHome,
    TMPDIR: input.tempRoot,
    PATH: [...input.pathEntries, '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(
      path.delimiter,
    ),
    LANG: 'en_US.UTF-8',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
  };
}

export function runRepositoryProcess(
  command: string,
  args: string[],
  options: LlmRunCommandCaptureOptions & {
    signal?: AbortSignal;
    maxOutputBytes?: number;
  },
): Promise<LlmCommandResult> {
  if (options.signal?.aborted)
    return Promise.reject(new Error('repository_execution_cancelled'));
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? {},
      shell: false,
      stdio: 'pipe',
      detached: process.platform !== 'win32',
    }) as ChildProcessWithoutNullStreams;
    let stdout = '';
    let stderr = '';
    let bytes = 0;
    let failure: Error | undefined;
    let settled = false;
    let inactivity: ReturnType<typeof setTimeout> | undefined;
    const kill = () => {
      try {
        if (process.platform !== 'win32' && child.pid)
          process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    };
    const fail = (code: string) => {
      failure ??= new Error(code);
      kill();
    };
    const abort = () => fail('repository_execution_cancelled');
    const absolute = setTimeout(
      () => fail('repository_execution_timeout'),
      options.timeoutMs ?? 30 * 60_000,
    );
    const resetIdle = () => {
      if (inactivity) clearTimeout(inactivity);
      inactivity = setTimeout(
        () => fail('repository_execution_inactivity_timeout'),
        options.inactivityTimeoutMs ?? 5 * 60_000,
      );
    };
    const cleanup = () => {
      clearTimeout(absolute);
      if (inactivity) clearTimeout(inactivity);
      options.signal?.removeEventListener('abort', abort);
    };
    const receive = (stream: 'stdout' | 'stderr', text: string) => {
      if (failure || settled) return;
      bytes += Buffer.byteLength(text);
      if (bytes > (options.maxOutputBytes ?? 4 * 1024 * 1024)) {
        fail('repository_execution_output_limit');
        return;
      }
      try {
        if (stream === 'stdout') {
          stdout += text;
          options.onStdout?.(text);
        } else {
          stderr += text;
          options.onStderr?.(text);
        }
      } catch {
        fail('repository_execution_callback_failed');
      }
      resetIdle();
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => receive('stdout', chunk));
    child.stderr.on('data', (chunk) => receive('stderr', chunk));
    child.stdin.on('error', () => fail('repository_execution_input_failed'));
    child.on('error', () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error('repository_execution_start_failed'));
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (failure) reject(failure);
      else resolve({ code: code ?? 1, stdout, stderr });
    });
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    resetIdle();
    try {
      options.onChild?.(child);
      child.stdin.end(options.stdinText ?? '');
    } catch {
      fail('repository_execution_callback_failed');
    }
  });
}
