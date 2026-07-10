import type { ChildProcess } from 'node:child_process';

/**
 * Writing to a child process's stdin after the child has exited (or closed its
 * input) surfaces as an asynchronous `EPIPE` (or a destroyed-stream) error on
 * the stdin stream. When nothing is listening for that error, Node escalates it
 * to an `uncaughtException` in the main process, which we then surface as a
 * spurious desktop error report. These write failures are benign: the child is
 * already gone, so there is nothing left to send.
 */
export const isBenignPipeError = (error: unknown): boolean => {
  const code = (error as NodeJS.ErrnoException | null | undefined)?.code;
  return code === 'EPIPE' || code === 'ERR_STREAM_DESTROYED' || code === 'ECONNRESET';
};

/**
 * Attach an error listener to a child's stdin so benign pipe errors are
 * swallowed instead of crashing the main process. Non-benign errors are
 * forwarded to `onFatalError` when provided so callers keep their existing
 * reject/settle behavior.
 */
export const guardChildStdin = (
  child: Pick<ChildProcess, 'stdin'>,
  onFatalError?: (error: NodeJS.ErrnoException) => void,
): void => {
  const stdin = child.stdin;
  if (!stdin) {
    return;
  }
  stdin.on('error', (error: NodeJS.ErrnoException) => {
    if (isBenignPipeError(error)) {
      return;
    }
    onFatalError?.(error);
  });
};
