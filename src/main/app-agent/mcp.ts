import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { CodexMcpServerConfig } from './types';

export const buildMcpArgs = (mcpServers: CodexMcpServerConfig[]): string[] =>
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

export const getMcpApprovalMode = (server: CodexMcpServerConfig): 'auto' | 'approve' =>
  server.name === 'forger' ? 'auto' : 'approve';

export const writeClaudeMcpConfig = async (
  appRoot: string,
  mcpServers: CodexMcpServerConfig[],
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
