import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

const CLAUDE_KEYCHAIN_SERVICE = 'Claude Code-credentials';
const MACOS_SECURITY_PATH = '/usr/bin/security';
const KEYCHAIN_READ_TIMEOUT_MS = 5_000;

interface ClaudeOAuthTokenDeps {
  execFile?: typeof execFile;
  fs?: typeof fs;
  homeDir?: () => string;
  platform?: NodeJS.Platform;
  securityPath?: string;
}

const parseAccessToken = (raw: string): string | null => {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }
    const oauth = (parsed as Record<string, unknown>).claudeAiOauth;
    if (!oauth || typeof oauth !== 'object') {
      return null;
    }
    const token = (oauth as Record<string, unknown>).accessToken;
    return typeof token === 'string' && token.length > 0 ? token : null;
  } catch {
    return null;
  }
};

const runExecFile = async (
  execFileImpl: typeof execFile,
  command: string,
  args: string[],
  options: { timeout: number },
): Promise<{ stdout: string; stderr: string }> => await new Promise((resolve, reject) => {
  execFileImpl(command, args, options, (error, stdout, stderr) => {
    if (error) {
      reject(error);
      return;
    }
    resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
  });
});

export const readClaudeOAuthToken = async (deps: ClaudeOAuthTokenDeps = {}): Promise<string | null> => {
  const platform = deps.platform ?? process.platform;
  const fsModule = deps.fs ?? fs;
  const execFileImpl = deps.execFile ?? execFile;
  if (platform === 'darwin') {
    const securityCommands = [
      deps.securityPath ?? MACOS_SECURITY_PATH,
      ...(deps.securityPath ? [] : ['security']),
    ];
    for (const command of securityCommands) {
      try {
        const { stdout } = await runExecFile(
          execFileImpl,
          command,
          ['find-generic-password', '-s', CLAUDE_KEYCHAIN_SERVICE, '-w'],
          { timeout: KEYCHAIN_READ_TIMEOUT_MS },
        );
        const token = parseAccessToken(stdout.trim());
        if (token) {
          return token;
        }
      } catch {
        // Keychain entry missing, denied, or binary unavailable: try the next source.
      }
    }
  }
  try {
    const raw = await fsModule.readFile(path.join(deps.homeDir?.() ?? os.homedir(), '.claude', '.credentials.json'), 'utf8');
    return parseAccessToken(raw);
  } catch {
    return null;
  }
};
