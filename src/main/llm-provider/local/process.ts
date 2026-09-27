import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import type { LlmRunCommandCapture } from '../types';

export function stopLocalProcessTree(child: ChildProcessWithoutNullStreams | undefined): void {
  if (!child?.pid) return;
  if (process.platform === 'win32') {
    const result = spawnSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 5000 });
    if (result.error || result.status !== 0) child.kill('SIGKILL');
    return;
  }
  try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* Already exited. */ } }
}

/** Full environment replacement, no shell; always bounded including when used independently. */
export const runLocalCommandCapture: LlmRunCommandCapture = (command, args, options) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? {},
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let failure: Error | undefined;
    let inactivity: NodeJS.Timeout | undefined;
    let byteCount = 0;
    const stop = (error: Error): void => {
      failure ??= error;
      stopLocalProcessTree(child);
    };
    const deadline = setTimeout(() => stop(new Error('local_timeout')), options.timeoutMs ?? 60000);
    const refresh = (): void => {
      clearTimeout(inactivity);
      inactivity = setTimeout(() => stop(new Error('local_inactivity_timeout')), options.inactivityTimeoutMs ?? options.timeoutMs ?? 60000);
    };
    const cleanup = (): void => { clearTimeout(deadline); clearTimeout(inactivity); };
    const output = (stream: 'stdout' | 'stderr', chunk: Buffer): void => {
      if (failure) return;
      byteCount += chunk.length;
      if (byteCount > 4 * 1024 * 1024) { stop(new Error('local_output_limit')); return; }
      refresh();
      const text = chunk.toString();
      try {
        if (stream === 'stdout') { stdout += text; options.onStdout?.(text); }
        else { stderr += text; options.onStderr?.(text); }
      } catch { stop(new Error('local_callback_failed')); }
    };
    child.stdout.on('data', (chunk: Buffer) => output('stdout', chunk));
    child.stderr.on('data', (chunk: Buffer) => output('stderr', chunk));
    child.once('error', () => { cleanup(); reject(new Error('local_cli_unavailable')); });
    child.stdin.once('error', (error: NodeJS.ErrnoException) => { if (error.code !== 'EPIPE') stop(new Error('local_cli_stdin_failed')); });
    child.once('close', (code) => {
      cleanup();
      // Stop orphaned same-group descendants even when the CLI itself exited normally.
      stopLocalProcessTree(child);
      if (failure) reject(failure);
      else resolve({ code: code ?? 1, stdout, stderr });
    });
    refresh();
    try { options.onChild?.(child); } catch { stop(new Error('local_callback_failed')); }
    child.stdin.end(options.stdinText ?? '');
  });
