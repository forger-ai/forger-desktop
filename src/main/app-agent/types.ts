import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { LlmCommandResult, LlmMcpServerConfig } from '../llm-provider/types';

export type LlmAppMcpServerConfig = LlmMcpServerConfig;

/** @deprecated Use LlmAppMcpServerConfig. */
export type CodexMcpServerConfig = LlmAppMcpServerConfig;

export type AppAgentCommandResult = LlmCommandResult & { code: number };

/** @deprecated Use AppAgentCommandResult or LlmCommandResult. */
export type CommandResult = AppAgentCommandResult;

export interface LlmCommandCaptureOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  stdinText?: string;
  onChild?: (child: ChildProcessWithoutNullStreams) => void;
  onStdout?: (text: string) => void;
  onStderr?: (text: string) => void;
}

/** @deprecated Use LlmCommandCaptureOptions. */
export type CommandCaptureOptions = LlmCommandCaptureOptions;

export interface ResolvedLlmCommand {
  command: string;
  prefixArgs: string[];
  pathEntries: string[];
}

/** @deprecated Use ResolvedLlmCommand. */
export type ResolvedCodexCommand = ResolvedLlmCommand;
