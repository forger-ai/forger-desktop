import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { AgentEffort, AgentPermissionMode, LlmProviderKey } from '../../shared/types';

export interface LlmMcpServerConfig {
  name: string;
  url: string;
  token: string;
  tokenEnvVar: string;
  toolTimeoutSec?: number;
}

export interface LlmCommandResult {
  code?: number | null;
  stdout: string;
  stderr: string;
}

export type LlmRunOutputStream = 'stdout' | 'stderr' | 'meta';

export type LlmRunEvent =
  | { type: 'started'; provider: LlmProviderKey; runId?: string }
  | { type: 'output'; provider: LlmProviderKey; runId?: string; stream: LlmRunOutputStream; text: string }
  | { type: 'conversation'; provider: LlmProviderKey; runId?: string; id: string }
  | { type: 'finished'; provider: LlmProviderKey; runId?: string; assistantText: string; conversationId?: string | null }
  | { type: 'failed'; provider: LlmProviderKey; runId?: string; error: Error };

export interface LlmRunResult {
  assistantText: string;
  conversationId?: string | null;
  toolEvents: number;
  stdout: string;
  stderr: string;
}

export interface LlmRunCommandCaptureOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  inactivityTimeoutMs?: number;
  onChild?: (child: ChildProcessWithoutNullStreams) => void;
  onStdout?: (text: string) => void;
  onStderr?: (text: string) => void;
  stdinText?: string;
}

export type LlmRunCommandCapture = (
  command: string,
  args: string[],
  options: LlmRunCommandCaptureOptions,
) => Promise<LlmCommandResult>;

export interface LlmCliRunInput {
  runId?: string;
  cliPath: string;
  pathEntries: string[];
  environment: Record<string, string>;
  mcpServers?: LlmMcpServerConfig[];
  workingDir: string;
  configWorkspaceRoot?: string;
  sharedRoots?: string[];
  addDirs?: string[];
  prompt: string;
  model?: string;
  effort?: AgentEffort;
  conversationId?: string | null;
  permissionMode?: AgentPermissionMode;
  timeoutMs: number;
  timeoutMode?: 'absolute' | 'inactivity';
  onChild?: (child: ChildProcessWithoutNullStreams) => void;
  onOutput?: (stream: LlmRunOutputStream, text: string) => void;
  onEvent?: (event: LlmRunEvent) => void;
  runCommandCapture: LlmRunCommandCapture;
}
