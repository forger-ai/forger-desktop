import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { mergePathEntry, spawnProcess } from './runtime/process-spawn';

export interface RemoteFrontendAsset {
  path: string;
  data: Buffer;
  type: string;
}

export const buildRemoteFrontend = async (input: {
  frontendDir: string;
  sessionId: string;
  handshakeUrl: string;
  nodePath: string;
  npmPath: string;
}): Promise<{ assets: RemoteFrontendAsset[]; hash: string }> => {
  await run(input.npmPath, ['run', 'build', '--', '--base=./'], {
    cwd: input.frontendDir,
    env: mergePathEntry({
      ...process.env,
      VITE_FORGER_REMOTE_TUNNEL: 'true',
      VITE_FORGER_REMOTE_SESSION_ID: input.sessionId,
      VITE_FORGER_CLOUD_HANDSHAKE_URL: input.handshakeUrl,
    }, path.dirname(input.nodePath), path.delimiter),
  }, 180_000);
  const distDir = path.join(input.frontendDir, 'dist');
  const assets = await readAssets(distDir);
  const hash = createHash('sha256');
  for (const asset of assets) {
    hash.update(asset.path);
    hash.update(asset.data);
  }
  return { assets, hash: hash.digest('hex') };
};

const readAssets = async (root: string, prefix = ''): Promise<RemoteFrontendAsset[]> => {
  const entries = await fs.readdir(path.join(root, prefix), { withFileTypes: true });
  const result: RemoteFrontendAsset[] = [];
  for (const entry of entries) {
    const relative = path.posix.join(prefix, entry.name);
    const absolute = path.join(root, relative);
    if (entry.isDirectory()) {
      result.push(...await readAssets(root, relative));
    } else if (entry.isFile()) {
      result.push({ path: relative, data: await fs.readFile(absolute), type: contentType(relative) });
    }
  }
  return result;
};

const contentType = (filePath: string): string => {
  if (filePath.endsWith('.html')) return 'text/html; charset=utf-8';
  if (filePath.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (filePath.endsWith('.css')) return 'text/css; charset=utf-8';
  if (filePath.endsWith('.json')) return 'application/json';
  if (filePath.endsWith('.png')) return 'image/png';
  if (filePath.endsWith('.svg')) return 'image/svg+xml';
  return 'application/octet-stream';
};

const run = async (command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }, timeoutMs: number): Promise<void> =>
  await new Promise((resolve, reject) => {
    const child = spawnProcess(command, args, { cwd: options.cwd, env: options.env, stdio: 'pipe' });
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill('SIGTERM');
      reject(new Error(`remote_frontend_build_timeout_${timeoutMs}ms`));
    }, timeoutMs);
    const finish = (callback: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      callback();
    };
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('close', (code) => {
      if (code === 0) {
        finish(resolve);
      } else {
        finish(() => reject(new Error(`remote_frontend_build_failed_${code}: ${stderr.slice(-1000)}`)));
      }
    });
    child.on('error', (error) => finish(() => reject(error)));
  });
