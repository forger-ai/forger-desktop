import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { LlmAppMcpServerConfig } from './types';
import type { AgentPermissionMode } from '../../shared/types';
import { acquireWorkspaceLock } from '../llm-provider/workspace-locks';

export const buildMcpArgs = (mcpServers: LlmAppMcpServerConfig[]): string[] =>
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
  ]);

export const getMcpApprovalMode = (server: LlmAppMcpServerConfig): 'auto' | 'approve' =>
  server.name === 'forger' ? 'auto' : 'approve';

export const writeClaudeMcpConfig = async (
  appRoot: string,
  mcpServers: LlmAppMcpServerConfig[],
): Promise<string> => {
  const configPath = path.join(appRoot, '.forger', 'tmp', `claude-mcp-${randomUUID()}.json`);
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

export interface AntigravityMcpConfigHandle {
  configPath: string;
  cleanup: () => Promise<void>;
}

const parseJsonObject = (content: string): Record<string, unknown> => {
  try {
    const parsed = JSON.parse(content);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
};

export const writeAntigravityMcpConfig = async (
  workspaceRoot: string,
  mcpServers: LlmAppMcpServerConfig[],
): Promise<AntigravityMcpConfigHandle | null> => {
  if (mcpServers.length === 0) {
    return null;
  }

  const configPath = path.join(workspaceRoot, '.agents', 'mcp_config.json');
  const releaseLock = await acquireWorkspaceLock(configPath);
  try {
    const original = await fs.readFile(configPath, 'utf8')
      .then((content) => ({ existed: true, content }))
      .catch(() => ({ existed: false, content: '' }));
    const parsed = parseJsonObject(original.content);
    const existingServers = parsed.mcpServers && typeof parsed.mcpServers === 'object' && !Array.isArray(parsed.mcpServers)
      ? parsed.mcpServers as Record<string, unknown>
      : {};
    const forgerServers = Object.fromEntries(mcpServers.map((server) => [
      server.name,
      {
        serverUrl: server.url,
        headers: {
          Authorization: `Bearer ${server.token}`,
        },
      },
    ]));

    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(
      configPath,
      JSON.stringify({
        ...parsed,
        mcpServers: {
          ...existingServers,
          ...forgerServers,
        },
      }, null, 2),
      'utf8',
    );

    return {
      configPath,
      cleanup: async () => {
        try {
          if (original.existed) {
            await fs.writeFile(configPath, original.content, 'utf8');
          } else {
            await fs.rm(configPath, { force: true });
          }
        } finally {
          releaseLock();
        }
      },
    };
  } catch (error) {
    releaseLock();
    throw error;
  }
};

export const buildAntigravityArgs = ({
  prompt,
  model,
  threadId,
  addDirs = [],
  logFile,
  hasMcpServers,
  permissionMode,
  timeout = '5m',
}: {
  prompt: string;
  model?: string;
  threadId?: string | null;
  addDirs?: string[];
  logFile?: string | null;
  hasMcpServers?: boolean;
  permissionMode?: AgentPermissionMode;
  timeout?: string;
}): string[] => [
  ...(logFile ? ['--log-file', logFile] : []),
  ...(model ? ['--model', model] : []),
  ...(threadId ? ['--conversation', threadId] : []),
  ...addDirs.flatMap((dir) => ['--add-dir', dir]),
  ...(permissionMode === 'unsafe' || hasMcpServers ? ['--dangerously-skip-permissions'] : ['--sandbox']),
  '--print',
  prompt,
  '--print-timeout',
  timeout,
];

export const prepareAntigravityLogPath = async (
  workspaceRoot: string,
  label: string = randomUUID(),
): Promise<string> => {
  const logDir = path.join(workspaceRoot, '.forger', 'tmp');
  await fs.mkdir(logDir, { recursive: true });
  return path.join(logDir, `antigravity-${label.replace(/[^a-zA-Z0-9._-]+/g, '-')}.log`);
};

export const readAntigravityLog = async (logFile?: string | null): Promise<string> => {
  if (!logFile) {
    return '';
  }
  return await fs.readFile(logFile, 'utf8').catch(() => '');
};

export const parseAntigravityOutput = (
  stdout: string,
  stderr = '',
  logText = '',
): { assistantText: string; threadId?: string; toolEvents: Array<{ type: string; label: string; raw?: unknown }> } => {
  const combined = [stdout, stderr, logText].filter(Boolean).join('\n');
  const conversationMatch =
    combined.match(/Print mode:\s+conversation=([A-Za-z0-9._:-]+)/) ??
    combined.match(/Created conversation\s+([A-Za-z0-9._:-]+)/) ??
    combined.match(/Streaming conversation\s+([A-Za-z0-9._:-]+)/) ??
    combined.match(/conversationID="([A-Za-z0-9._:-]+)"/) ??
    combined.match(/(?:conversation|Conversation|CONVERSATION)[\s_-]*(?:id|ID)\s*[:=]\s*([A-Za-z0-9._:-]+)/) ??
    combined.match(/agy\s+(?:--conversation|-c)\s+([A-Za-z0-9._:-]+)/);
  const assistantText = stdout
    .split(/\r?\n/)
    .filter((line) => !line.match(/^(I will|I am|Authentication required\.|Waiting for authentication|Or, paste the authorization code|(?:conversation|Conversation|CONVERSATION)[\s_-]*(?:id|ID)\s*[:=])/))
    .join('\n')
    .trim();
  const toolEvents = [...combined.matchAll(/(?:MCP tool|Calling MCP tool|Llamando herramienta MCP)[:\s]+([A-Za-z0-9_.:-]+)/g)]
    .map((match) => ({ type: 'mcp_tool_call', label: match[1] }));

  return {
    assistantText,
    ...(conversationMatch?.[1] ? { threadId: conversationMatch[1] } : {}),
    toolEvents,
  };
};
