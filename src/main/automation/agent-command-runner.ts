import { randomUUID } from 'node:crypto';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { AgentRuntime, ClaudeEffort } from '../../shared/types';
import {
  assertAllowedMcpServers,
  codexWorkspaceNetworkConfigArgs,
  createIsolatedCodexHome,
  removeIsolatedCodexHome,
} from '../codex-run-isolation';
import { spawnProcess } from '../runtime/process-spawn';

const AUTOMATION_TIMEOUT_MS = 300_000;

export interface CodexMcpServerConfig {
  name: string;
  url: string;
  token: string;
  tokenEnvVar: string;
  toolTimeoutSec?: number;
}

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

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
  if (process.platform !== 'win32' || !/\.(cmd|bat)$/i.test(codexCliPath)) {
    return {
      command: codexCliPath,
      prefixArgs: [],
      pathEntries: [path.dirname(codexCliPath), ...pathEntries],
    };
  }

  const nodePath = await findExecutableInPathEntries(pathEntries, ['node.exe', 'node']);
  const nodeModulesRoot = path.resolve(path.dirname(codexCliPath), '..');
  const codexEntrypoint = path.join(nodeModulesRoot, '@openai', 'codex', 'bin', 'codex.js');
  if (!nodePath || !(await existsFile(codexEntrypoint))) {
    throw new Error('codex_js_entrypoint_missing');
  }

  return {
    command: nodePath,
    prefixArgs: [codexEntrypoint],
    pathEntries: [path.dirname(nodePath), path.dirname(codexCliPath), ...pathEntries],
  };
};

export const runAgentCommand = async (
  codexCommand: { command: string; prefixArgs: string[]; pathEntries: string[] },
  options: {
    runtime: AgentRuntime;
    cwd: string;
    codexHome: string;
    prompt: string;
    transcriptPath: string;
    mcpServers?: CodexMcpServerConfig[];
    networkAccess?: boolean;
    onAssistantMessages?: (assistantMessages: string[]) => void;
  },
): Promise<CommandResult> => {
  const mcpServers = options.mcpServers ?? [];
  const topLevelArgs = mcpServers.length > 0 ? ['--ask-for-approval', 'never'] : [];
  const claudeMcpConfigPath = options.runtime.provider === 'claude'
    ? await writeClaudeMcpConfig(options.cwd, mcpServers)
    : null;
  const args = options.runtime.provider === 'claude'
    ? [
        '-p',
        options.prompt,
        '--output-format',
        'stream-json',
        '--verbose',
        '--model',
        options.runtime.model,
        '--effort',
        options.runtime.effort as ClaudeEffort,
        '--permission-mode',
        'bypassPermissions',
        ...(claudeMcpConfigPath ? ['--mcp-config', claudeMcpConfigPath] : []),
      ]
    : [
        ...codexCommand.prefixArgs,
        ...topLevelArgs,
        'exec',
        '--json',
        '--model',
        options.runtime.model || 'gpt-5.3-codex',
        '--config',
        `reasoning_effort="${options.runtime.effort || 'low'}"`,
        ...codexWorkspaceNetworkConfigArgs(options.networkAccess === true),
        '--full-auto',
        '--sandbox',
        'workspace-write',
        '--skip-git-repo-check',
        ...buildMcpArgs(mcpServers),
        '-C',
        options.cwd,
        options.prompt,
      ];
  await appendTranscript(options.transcriptPath, 'meta', `${codexCommand.command} ${args.slice(codexCommand.prefixArgs.length).join(' ')}`);
  let stdoutSoFar = '';
  const isolatedCodexHome = options.runtime.provider === 'codex'
    ? await createIsolatedCodexHome(options.codexHome, {
        prefix: 'forger-automation-codex-home',
        trustedRoots: [options.cwd],
        networkAccess: options.networkAccess === true,
      })
    : '';
  const allowedMcpServers = new Set(mcpServers.map((server) => server.name));
  try {
    const result = await runCommandCapture(codexCommand.command, args, {
      cwd: options.cwd,
      env: {
        ...(options.runtime.provider === 'codex' ? { CODEX_HOME: isolatedCodexHome } : {}),
        FORGER_ALLOWED_ROOTS: options.cwd,
        ...Object.fromEntries(mcpServers.map((server) => [server.tokenEnvVar, server.token])),
        PATH: [...codexCommand.pathEntries, process.env.PATH ?? ''].filter(Boolean).join(path.delimiter),
      },
      timeoutMs: AUTOMATION_TIMEOUT_MS,
      onStdout: (text) => {
        stdoutSoFar += text;
        options.onAssistantMessages?.(
          options.runtime.provider === 'claude'
            ? parseClaudeAssistantMessages(stdoutSoFar)
            : parseCodexAssistantMessages(stdoutSoFar),
        );
        void appendTranscript(options.transcriptPath, 'stdout', text);
      },
      onStderr: (text) => void appendTranscript(options.transcriptPath, 'stderr', text),
    });
    assertAllowedMcpServers(result.stdout, result.stderr, allowedMcpServers);
    return result;
  } finally {
    await removeIsolatedCodexHome(isolatedCodexHome);
    await fs.rm(claudeMcpConfigPath ?? '', { force: true }).catch(() => undefined);
  }
};

const writeClaudeMcpConfig = async (
  workingDir: string,
  mcpServers: CodexMcpServerConfig[],
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

const existsFile = async (filePath: string): Promise<boolean> => {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
};

const findExecutableInPathEntries = async (
  entries: string[],
  executableNames: string[],
): Promise<string | null> => {
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

const buildMcpArgs = (mcpServers: CodexMcpServerConfig[]): string[] =>
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

const getMcpApprovalMode = (server: CodexMcpServerConfig): 'auto' | 'approve' =>
  server.name === 'forger' ? 'auto' : 'approve';

const runCommandCapture = async (
  command: string,
  args: string[],
  options: {
    cwd: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    onStdout?: (text: string) => void;
    onStderr?: (text: string) => void;
  },
): Promise<CommandResult> => {
  return await new Promise<CommandResult>((resolve, reject) => {
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
    child.stdin.end();

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
