import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { AgentPermissionMode, ClaudeEffort } from '../../../shared/types';
import { assertAllowedMcpServers } from '../../codex-run-isolation';
import { claudePermissionArgs } from '../../agent-permission-mode';
import type {
  LlmCommandResult,
  LlmMcpServerConfig,
  LlmRunCommandCapture,
  LlmRunOutputStream,
  LlmRunResult,
  LlmTokenUsage,
} from '../types';
import { createProviderQuotaError, detectProviderQuotaError } from '../provider-errors';

type ClaudeCommandResult = LlmCommandResult & { code: number };

export interface ClaudeParsedOutput {
  assistantText: string;
  threadId?: string;
  usageDelta?: Partial<LlmTokenUsage>;
  toolEvents: number;
}

interface ClaudeBaseRunInput {
  cliPath: string;
  pathEntries: string[];
  environment: Record<string, string>;
  mcpServers?: LlmMcpServerConfig[];
  workingDir: string;
  configWorkspaceRoot?: string;
  sharedRoots?: string[];
  addDirs?: string[];
  prompt: string;
  model: string;
  effort: ClaudeEffort;
  permissionMode?: AgentPermissionMode;
  timeoutMs: number;
  inactivityTimeoutMs?: number;
  threadId?: string | null;
  imagePaths?: string[];
  throwOnNonZero?: boolean;
  alwaysIncludeMcpConfig?: boolean;
  onChild?: (child: ChildProcessWithoutNullStreams) => void;
  onOutput?: (stream: LlmRunOutputStream, text: string) => void;
  runCommandCapture: LlmRunCommandCapture;
}

export interface ClaudeRunResult extends LlmRunResult {
  threadId?: string;
  code: number;
}

export class ClaudeCliAdapter {
  public async run(input: ClaudeBaseRunInput): Promise<ClaudeRunResult> {
    const mcpServers = input.mcpServers ?? [];
    const mcpConfigPath = input.alwaysIncludeMcpConfig || mcpServers.length > 0
      ? await writeClaudeMcpConfig(input.configWorkspaceRoot ?? input.workingDir, mcpServers)
      : null;
    const args = [
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--model',
      input.model,
      '--effort',
      input.effort,
      ...claudePermissionArgs(input.permissionMode),
      ...claudeAllowedToolsArgs(mcpServers),
      ...(input.addDirs ?? []).flatMap((dir) => ['--add-dir', dir]),
      ...(mcpConfigPath ? ['--mcp-config', mcpConfigPath] : []),
      ...(input.threadId ? ['--resume', input.threadId] : []),
      ...(input.imagePaths ?? []).flatMap((filePath) => ['--image', filePath]),
    ];

    input.onOutput?.(
      'meta',
      [
        `Claude Code workingDir=${input.workingDir}`,
        `allowedMcpServers=${mcpServers.map((server) => server.name).join(',') || '(none)'}`,
        `model=${input.model}`,
        `effort=${input.effort}`,
      ].join(' '),
    );

    try {
      const result = await input.runCommandCapture(input.cliPath, args, {
        cwd: input.workingDir,
        env: {
          FORGER_ALLOWED_ROOTS: [input.workingDir, ...(input.sharedRoots ?? [])].join(path.delimiter),
          ...Object.fromEntries(mcpServers.map((server) => [server.tokenEnvVar, server.token])),
          ...input.environment,
          PATH: [path.dirname(input.cliPath), ...input.pathEntries, process.env.PATH ?? ''].filter(Boolean).join(path.delimiter),
        },
        timeoutMs: input.timeoutMs,
        inactivityTimeoutMs: input.inactivityTimeoutMs ?? input.timeoutMs,
        stdinText: input.prompt,
        onChild: input.onChild,
        onStdout: (text) => input.onOutput?.('stdout', text),
        onStderr: (text) => input.onOutput?.('stderr', text),
      }) as ClaudeCommandResult;
      assertAllowedMcpServers(result.stdout, result.stderr, new Set(mcpServers.map((server) => server.name)));
      if (result.code !== 0 && input.throwOnNonZero !== false) {
        const quotaFailure = detectProviderQuotaError('claude', result.stdout, result.stderr);
        if (quotaFailure) {
          throw createProviderQuotaError(quotaFailure);
        }
        throw new Error((result.stderr || result.stdout || 'claude_exec_failed').trim());
      }
      const parsed = parseClaudeJsonl(result.stdout, result.stderr);
      return {
        code: result.code,
        stdout: result.stdout,
        stderr: result.stderr,
        assistantText: parsed.assistantText,
        conversationId: parsed.threadId ?? input.threadId,
        threadId: parsed.threadId ?? input.threadId ?? undefined,
        usageDelta: parsed.usageDelta,
        toolEvents: parsed.toolEvents,
      };
    } finally {
      await fs.rm(mcpConfigPath ?? '', { force: true }).catch(() => undefined);
    }
  }
}

export const writeClaudeMcpConfig = async (
  workingDir: string,
  mcpServers: LlmMcpServerConfig[],
): Promise<string> => {
  const configPath = path.join(workingDir, '.forger', 'tmp', `claude-mcp-${randomUUID()}.json`);
  const mcpServersConfig = Object.fromEntries(mcpServers.map((server) => [
    server.name,
    {
      type: 'http',
      url: server.url,
      headers: {
        Authorization: `Bearer \${${server.tokenEnvVar}}`,
      },
    },
  ]));
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, JSON.stringify({ mcpServers: mcpServersConfig }, null, 2), 'utf8');
  return configPath;
};

export const claudeAllowedToolsArgs = (mcpServers: LlmMcpServerConfig[]): string[] => {
  const allowedTools = [...new Set(
    mcpServers
      .map((server) => server.name)
      .filter((name) => /^[a-zA-Z0-9_-]+$/.test(name))
      .map((name) => `mcp__${name}__*`),
  )];
  return allowedTools.length > 0 ? ['--allowedTools', allowedTools.join(',')] : [];
};

export const parseClaudeJsonl = (stdout: string, stderr: string): ClaudeParsedOutput => {
  const raw = stdout.trim() || stderr.trim();
  if (!raw) {
    return { assistantText: '', toolEvents: 0 };
  }

  let assistantText = '';
  let threadId: string | undefined;
  let usageDelta: Partial<LlmTokenUsage> | undefined;
  let toolEvents = 0;
  for (const line of raw.split('\n').map((entry) => entry.trim()).filter(Boolean)) {
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      assistantText = [assistantText, line].filter(Boolean).join('\n');
      continue;
    }
    const type = typeof entry.type === 'string' ? entry.type : '';
    if (!threadId) {
      const sessionId = entry.session_id ?? entry.sessionId ?? entry.conversation_id;
      if (typeof sessionId === 'string' && sessionId.trim()) {
        threadId = sessionId.trim();
      }
    }
    if (type.includes('tool')) {
      toolEvents += 1;
    }
    const usage = readClaudeUsage(entry);
    if (usage) {
      usageDelta = usage;
    }
    const text = extractClaudeText(entry);
    if (text) {
      assistantText = text;
    }
  }
  return { assistantText: assistantText.trim(), threadId, usageDelta, toolEvents };
};

const readClaudeUsage = (entry: Record<string, unknown>): Partial<LlmTokenUsage> | undefined => {
  const message = entry.message && typeof entry.message === 'object'
    ? entry.message as Record<string, unknown>
    : undefined;
  const usage = entry.usage && typeof entry.usage === 'object'
    ? entry.usage as Record<string, unknown>
    : message?.usage && typeof message.usage === 'object'
      ? message.usage as Record<string, unknown>
      : undefined;
  if (!usage) {
    return undefined;
  }
  const inputTokens = toNumber(usage.input_tokens ?? usage.inputTokens);
  const cacheRead = toNumber(usage.cache_read_input_tokens ?? usage.cacheReadInputTokens ?? usage.cached_input_tokens);
  const cacheCreation = toNumber(usage.cache_creation_input_tokens ?? usage.cacheCreationInputTokens);
  const outputTokens = toNumber(usage.output_tokens ?? usage.outputTokens);
  if (inputTokens <= 0 && cacheRead <= 0 && cacheCreation <= 0 && outputTokens <= 0) {
    return undefined;
  }
  return {
    inputTokens: inputTokens + cacheCreation,
    cachedInputTokens: cacheRead,
    outputTokens,
    reasoningOutputTokens: 0,
    turns: 1,
  };
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

const toNumber = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0;

export const claudeCliAdapter = new ClaudeCliAdapter();
