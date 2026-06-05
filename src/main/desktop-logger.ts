import fs from 'node:fs/promises';
import path from 'node:path';

export type DesktopLogLevel = 'debug' | 'info' | 'warn' | 'error';

export type DesktopLogService =
  | 'desktop-main'
  | 'desktop-renderer'
  | 'mcp'
  | 'installed-app'
  | 'official-tools'
  | 'tool:whatsapp'
  | 'agent-runtime'
  | 'backend-client';

export interface DesktopLogEntryInput {
  metadataRoot: string;
  level?: DesktopLogLevel;
  service: DesktopLogService;
  event: string;
  message?: string;
  context?: Record<string, unknown>;
  error?: unknown;
}

const SENSITIVE_KEY_PATTERN = /(?:secret|token|authorization|bearer|api[_-]?key|password|passwd|credential|private[_-]?key|client[_-]?secret|refresh[_-]?token|access[_-]?token|mcp[_-]?token|cookie|auth|creds|noiseKey|signedIdentityKey|signedPreKey|advSecretKey)/i;
const MAX_FIELD_LENGTH = 120_000;

export const appendDesktopLog = async (input: DesktopLogEntryInput): Promise<void> => {
  const logPath = path.join(input.metadataRoot, 'logs', 'forger-desktop.jsonl');
  const entry = {
    timestamp: new Date().toISOString(),
    level: input.level ?? 'info',
    service: input.service,
    event: input.event,
    ...(input.message ? { message: input.message } : {}),
    ...(input.context ? { context: sanitizeLogValue(input.context) } : {}),
    ...(input.error ? { error: serializeError(input.error) } : {}),
  };
  try {
    await fs.mkdir(path.dirname(logPath), { recursive: true, mode: 0o700 });
    await fs.appendFile(logPath, `${JSON.stringify(entry)}\n`, { encoding: 'utf8', mode: 0o600 });
    await fs.chmod(logPath, 0o600).catch(() => undefined);
  } catch (error) {
    if (process.env.NODE_ENV === 'development') {
      console.warn('Failed to write Forger desktop log', error);
    }
  }
};

export const serializeError = (error: unknown): Record<string, unknown> => {
  if (error instanceof Error) {
    return sanitizeLogValue({
      name: error.name,
      message: error.message,
      stack: error.stack,
      cause: error.cause,
    }) as Record<string, unknown>;
  }
  return sanitizeLogValue({ message: String(error) }) as Record<string, unknown>;
};

const sanitizeLogValue = (value: unknown, key = ''): unknown => {
  if (SENSITIVE_KEY_PATTERN.test(key)) {
    return '[REDACTED]';
  }
  if (typeof value === 'string') {
    return value.length > MAX_FIELD_LENGTH ? `${value.slice(0, MAX_FIELD_LENGTH)}...[truncated]` : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean' || value === null || value === undefined) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeLogValue(item));
  }
  if (typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [entryKey, entryValue] of Object.entries(value as Record<string, unknown>)) {
      output[entryKey] = sanitizeLogValue(entryValue, entryKey);
    }
    return output;
  }
  return String(value);
};
