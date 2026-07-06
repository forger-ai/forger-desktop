import fs from 'node:fs/promises';
import path from 'node:path';

interface StoredCallbackPort {
  port?: number;
  previousPort?: number;
  rotatedAt?: string;
}

const isPort = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value > 0 && value < 65536;

const filePath = (metadataRoot: string): string =>
  path.join(metadataRoot, 'oauth-callback.json');

export const readCallbackPort = async (metadataRoot: string): Promise<StoredCallbackPort> => {
  try {
    const parsed = JSON.parse(await fs.readFile(filePath(metadataRoot), 'utf8')) as Record<string, unknown>;
    return {
      ...(isPort(parsed.port) ? { port: parsed.port } : {}),
      ...(isPort(parsed.previousPort) ? { previousPort: parsed.previousPort } : {}),
      ...(typeof parsed.rotatedAt === 'string' ? { rotatedAt: parsed.rotatedAt } : {}),
    };
  } catch {
    return {};
  }
};

export const writeCallbackPort = async (
  metadataRoot: string,
  value: StoredCallbackPort,
): Promise<void> => {
  const target = filePath(metadataRoot);
  const temp = `${target}.tmp`;
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(temp, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 });
  await fs.rename(temp, target);
  await fs.chmod(target, 0o600).catch(() => undefined);
};
