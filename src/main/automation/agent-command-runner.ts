import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { AgentRuntime } from '../../shared/types';
import { spawnProcess } from '../runtime/process-spawn';
import { createLlmProviderRunService } from '../llm-provider/run-service';
import type { LlmCommandResult, LlmMcpServerConfig, LlmProviderAuthProfileResolver } from '../llm-provider/types';

const AUTOMATION_TIMEOUT_MS = 300_000;

export type LlmAutomationMcpServerConfig = LlmMcpServerConfig;

/** @deprecated Use LlmAutomationMcpServerConfig. */
export type CodexMcpServerConfig = LlmAutomationMcpServerConfig;

export type LlmAutomationCommandResult = LlmCommandResult & { code: number };

export const appendTranscript = async (
  transcriptPath: string,
  stream: 'stdout' | 'stderr' | 'meta',
  text: string,
): Promise<void> => {
  await fs.mkdir(path.dirname(transcriptPath), { recursive: true });
  const line = `[${new Date().toISOString()}] [${stream}] ${text}`;
  await fs.appendFile(transcriptPath, line.endsWith('\n') ? line : `${line}\n`, 'utf8');
};

export const parseCodexAssistantMessages = (stdout: string, stderr = ''): string[] => {
  const raw = stdout.trim() || stderr.trim();
  if (!raw) {
    return [];
  }

  const assistantMessages: string[] = [];
  for (const line of raw.split('\n').map((entry) => entry.trim()).filter(Boolean)) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }

    if (parsed.type !== 'item.completed' || !parsed.item || typeof parsed.item !== 'object') {
      continue;
    }

    const item = parsed.item as Record<string, unknown>;
    if (item.type === 'agent_message' && typeof item.text === 'string') {
      const text = item.text.trim();
      if (text && assistantMessages[assistantMessages.length - 1] !== text) {
        assistantMessages.push(text);
      }
    }
  }

  return assistantMessages;
};

export const parseClaudeAssistantMessages = (stdout: string, stderr = ''): string[] => {
  const raw = stdout.trim() || stderr.trim();
  if (!raw) {
    return [];
  }
  const assistantMessages: string[] = [];
  for (const line of raw.split('\n').map((entry) => entry.trim()).filter(Boolean)) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const text = extractClaudeText(parsed).trim();
    if (text && assistantMessages[assistantMessages.length - 1] !== text) {
      assistantMessages.push(text);
    }
  }
  return assistantMessages;
};

const extractClaudeText = (entry: Record<string, unknown>): string => {
  if (typeof entry.result === 'string') {
    return entry.result;
  }
  if (typeof entry.text === 'string') {
    return entry.text;
  }
  const message = entry.message;
  if (!message || typeof message !== 'object') {
    return '';
  }
  const content = (message as Record<string, unknown>).content;
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .map((item) => {
      if (!item || typeof item !== 'object') {
        return '';
      }
      const text = (item as Record<string, unknown>).text;
      return typeof text === 'string' ? text : '';
    })
    .filter(Boolean)
    .join('\n');
};

export const resolveCodexCommand = async (
  codexCliPath: string,
  pathEntries: string[],
): Promise<{ command: string; prefixArgs: string[]; pathEntries: string[] }> => {
  return await createLlmProviderRunService().resolveCommand('codex', codexCliPath, pathEntries);
};

export const runAgentCommand = async (
  providerCommand: { cliPath?: string; command?: string; prefixArgs?: string[]; pathEntries: string[] },
  options: {
    runtime: AgentRuntime;
    cwd: string;
    codexHome: string;
    providerProfilesRoot?: string;
    resolveAuthProfile?: LlmProviderAuthProfileResolver;
    prompt: string;
    transcriptPath: string;
    mcpServers?: LlmAutomationMcpServerConfig[];
    networkAccess?: boolean;
    timeoutMs?: number;
    onChild?: (child: ChildProcessWithoutNullStreams) => void;
    onAssistantMessages?: (assistantMessages: string[]) => void;
  },
): Promise<LlmAutomationCommandResult> => {
  const mcpServers = options.mcpServers ?? [];
  const providerCliPath = providerCommand.cliPath ?? providerCommand.command;
  if (!providerCliPath) {
    throw new Error('provider_cli_missing');
  }
  await appendTranscript(
    options.transcriptPath,
    'meta',
    `${options.runtime.provider} ${providerCliPath}${options.runtime.provider === 'codex' ? ' exec' : ''} ${options.prompt}`,
  );
  let stdoutSoFar = '';
  const appendOutput = (stream: 'stdout' | 'stderr' | 'meta', text: string): void => {
    void appendTranscript(options.transcriptPath, stream, text);
  };
  const providerRunService = createLlmProviderRunService({
    codexHome: options.codexHome,
    providerProfilesRoot: options.providerProfilesRoot,
    resolveAuthProfile: options.resolveAuthProfile,
  });
  const result = await providerRunService.run({
    surface: 'automation',
    mode: 'automation',
    runtime: options.runtime,
    cliPath: providerCliPath,
    pathEntries: options.runtime.provider === 'antigravity'
      ? [path.dirname(providerCliPath), ...providerCommand.pathEntries]
      : providerCommand.pathEntries,
    environment: {},
    mcpServers,
    workingDir: options.cwd,
    configWorkspaceRoot: options.runtime.provider === 'antigravity' ? options.cwd : undefined,
    prompt: options.prompt,
    permissionMode: options.runtime.permissionMode ?? 'safe',
    networkAccess: options.networkAccess,
    timeoutMs: options.timeoutMs ?? AUTOMATION_TIMEOUT_MS,
    timeoutMode: 'absolute',
    onChild: options.onChild,
    codexHomePlan: options.runtime.provider === 'codex'
      ? {
          type: 'temporary',
          rootCodexHome: options.codexHome,
          prefix: 'forger-automation-codex-home',
          trustedRoots: [options.cwd],
          networkAccess: options.networkAccess === true,
        }
      : { type: 'none' },
    resolvedCommand: providerCommand.command
      ? {
          command: providerCommand.command,
          prefixArgs: providerCommand.prefixArgs ?? [],
          pathEntries: providerCommand.pathEntries,
        }
      : undefined,
    onOutput: (stream, text) => {
      if (stream === 'stdout') {
        stdoutSoFar += text;
        if (options.runtime.provider === 'antigravity') {
          options.onAssistantMessages?.([stdoutSoFar.trim()].filter(Boolean));
        } else if (options.runtime.provider === 'claude') {
          options.onAssistantMessages?.(parseClaudeAssistantMessages(stdoutSoFar));
        } else {
          options.onAssistantMessages?.(parseCodexAssistantMessages(stdoutSoFar));
        }
      }
      appendOutput(stream, text);
    },
    runCommandCapture,
    checkReady: false,
  });
  return {
    code: result.code,
    stdout: result.stdout,
    stderr: result.stderr,
  };
};

const runCommandCapture = async (
  command: string,
  args: string[],
  options: {
    cwd: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    onChild?: (child: ChildProcessWithoutNullStreams) => void;
    onStdout?: (text: string) => void;
    onStderr?: (text: string) => void;
    stdinText?: string;
  },
): Promise<LlmAutomationCommandResult> => {
  return await new Promise<LlmAutomationCommandResult>((resolve, reject) => {
    const child: ChildProcessWithoutNullStreams = spawnProcess(command, args, {
      cwd: options.cwd,
      env: {
        ...process.env,
        ...(options.env ?? {}),
      },
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    options.onChild?.(child);
    child.stdin.end(options.stdinText ?? '');

    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (callback: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      callback();
    };

    const killChild = (): void => {
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

    const timeout = options.timeoutMs
      ? setTimeout(() => {
          killChild();
          finish(() => reject(new Error(`codex_timeout_after_${options.timeoutMs}ms`)));
        }, options.timeoutMs)
      : null;

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      stdout += text;
      options.onStdout?.(text);
    });
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      options.onStderr?.(text);
    });
    child.on('error', (error) => {
      if (timeout) {
        clearTimeout(timeout);
      }
      finish(() => reject(error));
    });
    child.on('exit', (code) => {
      if (timeout) {
        clearTimeout(timeout);
      }
      finish(() => resolve({ code: typeof code === 'number' ? code : 1, stdout, stderr }));
    });
  });
};
