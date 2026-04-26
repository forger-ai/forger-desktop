import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import { createServer } from 'vite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const binName = (name) => {
  if (process.platform === 'win32') {
    return `${name}.cmd`;
  }

  return name;
};

const resolveBin = (name) => path.join(rootDir, 'node_modules', '.bin', binName(name));

const sleep = (ms) => new Promise((resolve) => {
  setTimeout(resolve, ms);
});

const waitForElectronBuild = async () => {
  const expectedFiles = [
    path.join(rootDir, 'dist-electron', 'main', 'index.js'),
    path.join(rootDir, 'dist-electron', 'preload', 'index.js'),
  ];

  for (let attempt = 0; attempt < 100; attempt += 1) {
    const fileStates = await Promise.all(
      expectedFiles.map(async (filePath) => {
        try {
          await fs.access(filePath);
          return true;
        } catch {
          return false;
        }
      }),
    );

    if (fileStates.every(Boolean)) {
      return;
    }

    await sleep(150);
  }

  throw new Error('Electron main/preload build did not complete in time.');
};

const childProcesses = [];

const registerChild = (child) => {
  childProcesses.push(child);
  return child;
};

const stopChildren = () => {
  for (const child of childProcesses) {
    if (!child.killed) {
      child.kill('SIGTERM');
    }
  }
};

process.on('SIGINT', () => {
  stopChildren();
  process.exit(0);
});

process.on('SIGTERM', () => {
  stopChildren();
  process.exit(0);
});

process.on('exit', () => {
  stopChildren();
});

const tscWatch = registerChild(
  spawn(resolveBin('tsc'), ['-p', 'tsconfig.electron.json', '--watch', '--preserveWatchOutput'], {
    cwd: rootDir,
    stdio: 'inherit',
    env: process.env,
  }),
);

tscWatch.on('exit', (code) => {
  if (code && code !== 0) {
    process.exit(code);
  }
});

await waitForElectronBuild();

const viteServer = await createServer({
  configFile: path.join(rootDir, 'vite.config.ts'),
  server: {
    host: '127.0.0.1',
    port: 5173,
  },
});

await viteServer.listen();
viteServer.printUrls();

const devServerUrl = viteServer.resolvedUrls?.local[0];

if (!devServerUrl) {
  throw new Error('Vite dev server URL could not be resolved.');
}

const electronProcess = registerChild(
  spawn(resolveBin('electron'), ['.'], {
    cwd: rootDir,
    stdio: 'inherit',
    env: {
      ...process.env,
      VITE_DEV_SERVER_URL: devServerUrl,
    },
  }),
);

electronProcess.on('exit', async (code) => {
  await viteServer.close();

  if (code && code !== 0) {
    process.exit(code);
  }

  process.exit(0);
});
