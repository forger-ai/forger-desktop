import path from 'node:path';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { AgentPermissionMode, ChatErrorCode, CodexReasoningEffort } from '../../../shared/types';
import {
  assertAllowedMcpServers,
  codexWorkspaceNetworkConfigArgs,
  createIsolatedCodexHome,
  DisallowedMcpServerError,
  removeIsolatedCodexHome,
} from '../../codex-run-isolation';
import { codexUnsafeArgs, codexWorkspaceArgs } from '../../agent-permission-mode';
import { classifyCodexAuthOutput } from '../../codex-auth-helpers';
import { detectProviderModelUnsupportedError, detectProviderQuotaError } from '../provider-errors';
import type {
  LlmCommandResult,
  LlmMcpServerConfig,
  LlmRunCommandCapture,
  LlmRunOutputStream,
  LlmRunResult,
  LlmTokenUsage,
} from '../types';

const CODEX_ATTEMPT_INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000;
const CODEX_CHATGPT_COMPATIBLE_FALLBACK_MODEL = 'gpt-5.2';

const codexReasoningConfigArg = (reasoningEffort: CodexReasoningEffort | string): string =>
  `model_reasoning_effort="${reasoningEffort}"`;

interface ResolvedLlmCommand {
  command: string;
  prefixArgs: string[];
  pathEntries: string[];
}

export interface CodexParsedOutput {
  assistantText: string;
  threadId?: string;
  usageDelta?: Partial<LlmTokenUsage>;
  toolEvents: number;
}

export type { LlmTokenUsage };

type CodexCommandResult = LlmCommandResult & { code: number };

interface CodexBaseRunInput {
  cliPath: string;
  pathEntries: string[];
  environment: Record<string, string>;
  mcpServers?: LlmMcpServerConfig[];
  workingDir: string;
  sharedRoots?: string[];
  addDirs?: string[];
  prompt: string;
  model: string;
  reasoningEffort: CodexReasoningEffort;
  permissionMode?: AgentPermissionMode;
  networkAccess?: boolean;
  timeoutMs: number;
  inactivityTimeoutMs?: number;
  codexHome?: string;
  onChild?: (child: ChildProcessWithoutNullStreams) => void;
  onOutput?: (stream: LlmRunOutputStream, text: string) => void;
  runCommandCapture: LlmRunCommandCapture;
}

export interface CodexChatRunInput extends CodexBaseRunInput {
  rootCodexHome: string;
  threadId?: string;
}

export interface CodexTaskRunInput extends CodexBaseRunInput {
  imagePaths?: string[];
}

export interface CodexConversationRunInput extends CodexBaseRunInput {
  threadId?: string | null;
  imagePaths?: string[];
}

export interface CodexAutomationRunInput extends Omit<CodexBaseRunInput, 'reasoningEffort'> {
  reasoningEffort?: CodexReasoningEffort | string;
  resolvedCommand?: ResolvedLlmCommand;
}

export interface CodexRunResult extends LlmRunResult {
  threadId?: string;
  usageDelta?: Partial<LlmTokenUsage>;
  code: number;
}

export class CodexCliAdapter {
  public async resolveCommand(cliPath: string, pathEntries: string[]): Promise<ResolvedLlmCommand> {
    if (process.platform !== 'win32' || !/\.(cmd|bat)$/i.test(cliPath)) {
      return {
        command: cliPath,
        prefixArgs: [],
        pathEntries: [path.dirname(cliPath), ...pathEntries],
      };
    }

    const nodePath = await findExecutableInPathEntries(pathEntries, ['node.exe', 'node']);
    const nodeModulesRoot = path.resolve(path.dirname(cliPath), '..');
    const codexEntrypoint = path.join(nodeModulesRoot, '@openai', 'codex', 'bin', 'codex.js');
    if (!nodePath || !(await existsFile(codexEntrypoint))) {
      throw new Error('codex_js_entrypoint_missing');
    }

    return {
      command: nodePath,
      prefixArgs: [codexEntrypoint],
      pathEntries: [path.dirname(nodePath), path.dirname(cliPath), ...pathEntries],
    };
  }

  public async runChat(input: CodexChatRunInput): Promise<CodexRunResult> {
    const mcpServers = input.mcpServers ?? [];
    const command = await this.resolveCommand(input.cliPath, input.pathEntries);
    const isolatedCodexHome = input.codexHome ?? await createIsolatedCodexHome(input.rootCodexHome, {
      prefix: 'forger-chat-codex-home',
      trustedRoots: [input.workingDir, ...(input.sharedRoots ?? [])],
      networkAccess: input.networkAccess === true,
    });
    const attemptGroups = buildChatAttemptGroups(input, mcpServers);
    const topLevelArgs = mcpServers.length > 0 ? ['--ask-for-approval', 'never'] : [];
    const allowedMcpServers = new Set(mcpServers.map((server) => server.name));
    let lastResult: CodexCommandResult | null = null;
    let lastErrorMessage = '';

    try {
      input.onOutput?.(
        'meta',
        [
          `Codex isolated CODEX_HOME=${isolatedCodexHome}`,
          `workingDir=${input.workingDir}`,
          `allowedMcpServers=${mcpServers.map((server) => server.name).join(',') || '(none)'}`,
          'askForApproval=never',
          'mcpDefaultToolsApprovalMode=forger:auto app:approve',
        ].join(' '),
      );
      for (const group of attemptGroups) {
        let skipToNextGroup = false;
        for (const [index, args] of group.attempts.entries()) {
          try {
            const mode = args.includes('resume') ? 'resume' : 'new';
            const json = args.includes('--json') ? 'json' : 'plain';
            input.onOutput?.('meta', `Intento ${index + 1}/${group.attempts.length} (${mode}, ${json}, model=${group.model})`);
            const result = await input.runCommandCapture(command.command, [...command.prefixArgs, ...topLevelArgs, ...args], {
              cwd: input.workingDir,
              env: this.buildEnv(input, command, isolatedCodexHome),
              inactivityTimeoutMs: input.inactivityTimeoutMs ?? CODEX_ATTEMPT_INACTIVITY_TIMEOUT_MS,
              stdinText: input.prompt,
              onChild: input.onChild,
              onStdout: (text) => input.onOutput?.('stdout', text),
              onStderr: (text) => input.onOutput?.('stderr', text),
            }) as CodexCommandResult;
            assertAllowedMcpServers(result.stdout, result.stderr, allowedMcpServers);
            lastResult = result;
            if (result.code === 0) {
              return this.toRunResult(result, parseCodexJsonl(result.stdout, result.stderr));
            }
            lastErrorMessage = (result.stderr || result.stdout || '').trim();
            if (group.fallbackModel && detectProviderModelUnsupportedError('codex', result.stdout, result.stderr, lastErrorMessage)) {
              input.onOutput?.('meta', `El modelo ${group.model} no es compatible con esta cuenta. Reintentando con ${group.fallbackModel}.`);
              skipToNextGroup = true;
              break;
            }
          } catch (error) {
            if (error instanceof DisallowedMcpServerError) {
              throw error;
            }
            if (error instanceof Error) {
              lastErrorMessage = error.message;
              input.onOutput?.('meta', `Intento ${index + 1} falló: ${error.message}`);
              if (group.fallbackModel && detectProviderModelUnsupportedError('codex', error.message)) {
                input.onOutput?.('meta', `El modelo ${group.model} no es compatible con esta cuenta. Reintentando con ${group.fallbackModel}.`);
                skipToNextGroup = true;
                break;
              }
            }
          }
        }
        if (group.fallbackModel && skipToNextGroup) {
          continue;
        }
        break;
      }
    } finally {
      if (!input.codexHome) {
        await removeIsolatedCodexHome(isolatedCodexHome);
      }
    }

    throw this.buildChatError(lastResult, lastErrorMessage);
  }

  public async runTask(input: CodexTaskRunInput): Promise<CodexRunResult> {
    const mcpServers = input.mcpServers ?? [];
    const command = await this.resolveCommand(input.cliPath, input.pathEntries);
    const args = [
      ...command.prefixArgs,
      '--ask-for-approval',
      'never',
      'exec',
      '--json',
      '--model',
      input.model,
      '--config',
      codexReasoningConfigArg(input.reasoningEffort),
      ...codexWorkspaceNetworkConfigArgs(input.networkAccess === true),
      ...codexUnsafeArgs(input.permissionMode),
      ...codexWorkspaceArgs(input.permissionMode),
      '--skip-git-repo-check',
      ...buildCodexMcpArgs(mcpServers),
      ...(input.addDirs ?? []).flatMap((dir) => ['--add-dir', dir]),
      '-C',
      input.workingDir,
      ...(input.imagePaths ?? []).flatMap((filePath) => ['--image', filePath]),
      '--',
      '-',
    ];
    return await this.runOnce(input, command, args, input.codexHome ?? '', input.prompt);
  }

  public async runConversation(input: CodexConversationRunInput): Promise<CodexRunResult> {
    const mcpServers = input.mcpServers ?? [];
    const command = await this.resolveCommand(input.cliPath, input.pathEntries);
    const common = [
      'exec',
      ...(input.threadId ? ['resume'] : []),
      '--json',
      '--model',
      input.model,
      '--config',
      codexReasoningConfigArg(input.reasoningEffort),
      ...codexWorkspaceNetworkConfigArgs(input.networkAccess === true),
      ...codexUnsafeArgs(input.permissionMode),
      ...(input.threadId ? [] : codexWorkspaceArgs(input.permissionMode)),
      '--skip-git-repo-check',
      ...buildCodexMcpArgs(mcpServers),
    ];
    const args = input.threadId
      ? [
          ...command.prefixArgs,
          ...common,
          ...(input.imagePaths ?? []).flatMap((filePath) => ['--image', filePath]),
          '--',
          input.threadId,
          '-',
        ]
      : [
          ...command.prefixArgs,
          ...(mcpServers.length > 0 ? ['--ask-for-approval', 'never'] : []),
          ...common,
          ...(input.addDirs ?? []).flatMap((dir) => ['--add-dir', dir]),
          '-C',
          input.workingDir,
          ...(input.imagePaths ?? []).flatMap((filePath) => ['--image', filePath]),
          '--',
          '-',
        ];
    return await this.runOnce(input, command, args, input.codexHome ?? '', input.prompt);
  }

  public async runAutomation(input: CodexAutomationRunInput): Promise<CodexRunResult> {
    const mcpServers = input.mcpServers ?? [];
    const command = input.resolvedCommand ?? await this.resolveCommand(input.cliPath, input.pathEntries);
    const args = [
      ...command.prefixArgs,
      '--ask-for-approval',
      'never',
      'exec',
      '--json',
      '--model',
      input.model || CODEX_CHATGPT_COMPATIBLE_FALLBACK_MODEL,
      '--config',
      codexReasoningConfigArg(input.reasoningEffort || 'low'),
      ...codexWorkspaceNetworkConfigArgs(input.networkAccess === true),
      ...codexUnsafeArgs(input.permissionMode),
      ...codexWorkspaceArgs(input.permissionMode),
      '--skip-git-repo-check',
      ...buildCodexMcpArgs(mcpServers),
      '-C',
      input.workingDir,
      '--',
      '-',
    ];
    return await this.runOnce(input as CodexBaseRunInput, command, args, input.codexHome ?? '', input.prompt);
  }

  private async runOnce(
    input: CodexBaseRunInput,
    command: ResolvedLlmCommand,
    args: string[],
    codexHome: string,
    stdinText?: string,
  ): Promise<CodexRunResult> {
    const mcpServers = input.mcpServers ?? [];
    const result = await input.runCommandCapture(command.command, args, {
      cwd: input.workingDir,
      env: this.buildEnv(input, command, codexHome),
      timeoutMs: input.timeoutMs,
      inactivityTimeoutMs: input.inactivityTimeoutMs,
      stdinText,
      onChild: input.onChild,
      onStdout: (text) => input.onOutput?.('stdout', text),
      onStderr: (text) => input.onOutput?.('stderr', text),
    }) as CodexCommandResult;
    assertAllowedMcpServers(result.stdout, result.stderr, new Set(mcpServers.map((server) => server.name)));
    return this.toRunResult(result, parseCodexJsonl(result.stdout, result.stderr));
  }

  private buildEnv(
    input: Pick<CodexBaseRunInput, 'workingDir' | 'sharedRoots' | 'mcpServers' | 'environment'>,
    command: ResolvedLlmCommand,
    codexHome: string,
  ): NodeJS.ProcessEnv {
    const mcpServers = input.mcpServers ?? [];
    return {
      ...(codexHome ? { CODEX_HOME: codexHome } : {}),
      FORGER_ALLOWED_ROOTS: [input.workingDir, ...(input.sharedRoots ?? [])].join(path.delimiter),
      ...Object.fromEntries(mcpServers.map((server) => [server.tokenEnvVar, server.token])),
      ...input.environment,
      PATH: [...command.pathEntries, process.env.PATH ?? ''].filter(Boolean).join(path.delimiter),
    };
  }

  private toRunResult(result: CodexCommandResult, parsed: CodexParsedOutput): CodexRunResult {
    return {
      code: result.code,
      stdout: result.stdout,
      stderr: result.stderr,
      assistantText: parsed.assistantText,
      conversationId: parsed.threadId,
      threadId: parsed.threadId,
      usageDelta: parsed.usageDelta,
      toolEvents: parsed.toolEvents,
    };
  }

  private buildChatError(lastResult: CodexCommandResult | null, lastErrorMessage: string): Error {
    const resultMessage = (lastResult?.stderr || lastResult?.stdout || '').trim();
    const message = (lastErrorMessage || resultMessage || 'codex_exec_failed').trim();
    const parsed = parseCodexJsonl(lastResult?.stdout ?? '', lastResult?.stderr ?? '');
    const authFailure = classifyCodexAuthOutput(
      [lastResult?.stdout, lastErrorMessage].filter(Boolean).join('\n'),
      lastResult?.stderr ?? '',
    );
    const timeoutFailure = /\btimed out(?:\s+due to inactivity)?\s+after\b|codex_timeout_after_/i.test(message);
    const quotaFailure = detectProviderQuotaError('codex', lastResult?.stdout, lastResult?.stderr, lastErrorMessage, message);
    const modelUnsupportedFailure = detectProviderModelUnsupportedError('codex', lastResult?.stdout, lastResult?.stderr, lastErrorMessage, message);
    const chatCode: ChatErrorCode = authFailure === 'codex_auth_expired'
      ? 'codex_auth_expired'
      : timeoutFailure
        ? 'timeout'
        : modelUnsupportedFailure
          ? 'model_unsupported'
          : quotaFailure
            ? 'quota_exceeded'
            : 'capability_unavailable';
    const error = new Error(
      chatCode === 'model_unsupported'
        ? modelUnsupportedFailure?.message ?? message
        : chatCode === 'quota_exceeded'
          ? quotaFailure?.message ?? message
          : message,
    );
    (error as Error & { chatCode?: ChatErrorCode }).chatCode = chatCode;
    (error as Error & { parsedRun?: CodexParsedOutput }).parsedRun = parsed;
    throw error;
  }
}

export const buildCodexMcpArgs = (mcpServers: LlmMcpServerConfig[]): string[] =>
  mcpServers.flatMap((server) => [
    '--config',
    `mcp_servers.${server.name}.url=${JSON.stringify(server.url)}`,
    '--config',
    `mcp_servers.${server.name}.bearer_token_env_var=${JSON.stringify(server.tokenEnvVar)}`,
    '--config',
    `mcp_servers.${server.name}.enabled=true`,
    '--config',
    `mcp_servers.${server.name}.tool_timeout_sec=${server.toolTimeoutSec ?? 600}`,
    '--config',
    `mcp_servers.${server.name}.default_tools_approval_mode="${getMcpApprovalMode(server)}"`,
    ...(server.name === 'forger'
      ? [
          '--config',
          'apps.forger.enabled=true',
          '--config',
          'apps.forger.default_tools_enabled=true',
          '--config',
          'apps.forger.default_tools_approval_mode="auto"',
          '--config',
          'apps.forger.destructive_enabled=true',
          '--config',
          'apps.forger.open_world_enabled=true',
        ]
      : []),
  ]);

export const getMcpApprovalMode = (server: LlmMcpServerConfig): 'auto' | 'approve' =>
  server.name === 'forger' ? 'auto' : 'approve';

export const parseCodexJsonl = (stdout: string, stderr: string): CodexParsedOutput => {
  const raw = stdout.trim() || stderr.trim();
  if (!raw) {
    return { assistantText: '', toolEvents: 0 };
  }

  let threadId: string | undefined;
  let assistantText = '';
  let usageDelta: Partial<LlmTokenUsage> | undefined;
  let toolEvents = 0;

  for (const line of raw.split('\n').map((entry) => entry.trim()).filter(Boolean)) {
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      assistantText = assistantText ? `${assistantText}\n${line}` : line;
      continue;
    }

    const type = typeof entry.type === 'string' ? entry.type : '';
    if (type === 'thread.started' && typeof entry.thread_id === 'string') {
      threadId = entry.thread_id;
      continue;
    }
    if (type === 'item.completed' && entry.item && typeof entry.item === 'object') {
      const item = entry.item as Record<string, unknown>;
      const itemType = typeof item.type === 'string' ? item.type : '';
      if (itemType.includes('tool')) {
        toolEvents += 1;
      }
      if (itemType === 'agent_message' && typeof item.text === 'string') {
        assistantText = item.text;
      }
      continue;
    }
    if (type === 'turn.completed' && entry.usage && typeof entry.usage === 'object') {
      const usage = entry.usage as Record<string, unknown>;
      usageDelta = {
        inputTokens: toNumber(usage.input_tokens),
        cachedInputTokens: toNumber(usage.cached_input_tokens),
        outputTokens: toNumber(usage.output_tokens),
        reasoningOutputTokens: toNumber(usage.reasoning_output_tokens),
        turns: 1,
      };
      continue;
    }
    if (type.includes('tool')) {
      toolEvents += 1;
    }
  }

  return { assistantText: assistantText.trim(), threadId, usageDelta, toolEvents };
};

const buildChatAttempts = (input: CodexChatRunInput, mcpServers: LlmMcpServerConfig[]): string[][] => {
  const modelArgs = ['--model', input.model];
  const reasoningArgs = ['--config', codexReasoningConfigArg(input.reasoningEffort)];
  const networkArgs = codexWorkspaceNetworkConfigArgs(input.networkAccess === true);
  const mcpArgs = buildCodexMcpArgs(mcpServers);
  const commonArgs = ['--skip-git-repo-check', '-C', input.workingDir];
  return input.threadId
    ? [
        ['exec', 'resume', '--json', ...modelArgs, ...reasoningArgs, ...networkArgs, ...mcpArgs, '--skip-git-repo-check', '--', input.threadId, '-'],
        ['exec', 'resume', '--json', ...modelArgs, ...reasoningArgs, ...networkArgs, ...mcpArgs, '--skip-git-repo-check', '--', input.threadId, '-'],
        ['exec', 'resume', '--json', ...modelArgs, ...mcpArgs, '--skip-git-repo-check', '--', input.threadId, '-'],
        ['exec', 'resume', ...modelArgs, ...mcpArgs, '--skip-git-repo-check', '--', input.threadId, '-'],
      ]
    : [
        ['exec', '--json', ...modelArgs, ...reasoningArgs, ...networkArgs, ...mcpArgs, ...codexUnsafeArgs(input.permissionMode), ...codexWorkspaceArgs(input.permissionMode), ...commonArgs, '--', '-'],
        ['exec', '--json', ...modelArgs, ...reasoningArgs, ...networkArgs, ...mcpArgs, ...codexUnsafeArgs(input.permissionMode), ...codexWorkspaceArgs(input.permissionMode), ...commonArgs, '--', '-'],
        ['exec', '--json', ...modelArgs, ...networkArgs, ...mcpArgs, ...codexUnsafeArgs(input.permissionMode), ...codexWorkspaceArgs(input.permissionMode), ...commonArgs, '--', '-'],
        ['exec', '--json', ...modelArgs, ...networkArgs, ...mcpArgs, ...commonArgs, '--', '-'],
        ['exec', ...modelArgs, ...networkArgs, ...mcpArgs, ...commonArgs, '--', '-'],
      ];
};

const buildChatAttemptGroups = (
  input: CodexChatRunInput,
  mcpServers: LlmMcpServerConfig[],
): Array<{ model: string; attempts: string[][]; fallbackModel?: string }> => {
  if (input.model === CODEX_CHATGPT_COMPATIBLE_FALLBACK_MODEL) {
    return [{ model: input.model, attempts: buildChatAttempts(input, mcpServers) }];
  }
  const fallbackInput = { ...input, model: CODEX_CHATGPT_COMPATIBLE_FALLBACK_MODEL };
  return [
    {
      model: input.model,
      attempts: buildChatAttempts(input, mcpServers),
      fallbackModel: CODEX_CHATGPT_COMPATIBLE_FALLBACK_MODEL,
    },
    {
      model: CODEX_CHATGPT_COMPATIBLE_FALLBACK_MODEL,
      attempts: buildChatAttempts(fallbackInput, mcpServers),
    },
  ];
};

const toNumber = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0;

const existsFile = async (filePath: string): Promise<boolean> => {
  const fs = await import('node:fs/promises');
  try {
    return (await fs.stat(filePath)).isFile();
  } catch {
    return false;
  }
};

const findExecutableInPathEntries = async (entries: string[], executableNames: string[]): Promise<string | null> => {
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

export const codexCliAdapter = new CodexCliAdapter();
