import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

const execFileAsync = promisify(execFile);

const CLAUDE_KEYCHAIN_SERVICE = 'Claude Code-credentials';
const KEYCHAIN_READ_TIMEOUT_MS = 5_000;

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

export const readClaudeOAuthToken = async (): Promise<string | null> => {
  if (process.platform === 'darwin') {
    try {
      const { stdout } = await execFileAsync(
        'security',
        ['find-generic-password', '-s', CLAUDE_KEYCHAIN_SERVICE, '-w'],
        { timeout: KEYCHAIN_READ_TIMEOUT_MS },
      );
      const token = parseAccessToken(stdout.trim());
      if (token) {
        return token;
      }
    } catch {
      // Keychain entry missing or denied: fall through to the credentials file.
    }
  }
  try {
    const raw = await fs.readFile(path.join(os.homedir(), '.claude', '.credentials.json'), 'utf8');
    return parseAccessToken(raw);
  } catch {
    return null;
  }
};
