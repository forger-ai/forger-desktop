import type { ChildProcessWithoutNullStreams } from 'node:child_process';

export interface CodexMcpServerConfig {
  name: string;
  url: string;
  token: string;
  tokenEnvVar: string;
  toolTimeoutSec?: number;
}

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface CommandCaptureOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  stdinText?: string;
  onChild?: (child: ChildProcessWithoutNullStreams) => void;
  onStdout?: (text: string) => void;
  onStderr?: (text: string) => void;
}

export interface ResolvedCodexCommand {
  command: string;
  prefixArgs: string[];
  pathEntries: string[];
}
