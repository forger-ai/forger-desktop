#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = resolve(__dirname, '..');
const dryRun = process.argv.includes('--dry-run');
const noLaunch = process.argv.includes('--no-launch');

const devStatePaths = [
  join(homedir(), 'Library', 'Application Support', 'forger-desktop-dev'),
  join(homedir(), 'Forger-dev'),
];

const sleep = (ms) => new Promise((resolveSleep) => {
  setTimeout(resolveSleep, ms);
});

const listProcesses = async () => await new Promise((resolveList) => {
  const child = spawn('ps', ['-axo', 'pid=,command='], {
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk.toString();
  });
  child.on('exit', () => {
    resolveList(
      output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const match = line.match(/^(\d+)\s+(.+)$/);
          if (!match) {
            return null;
          }
          return { pid: Number(match[1]), command: match[2] };
        })
        .filter(Boolean),
    );
  });
});

const matchesForgerDesktopDevProcess = (command) => {
  if (command.includes('forger-desktop-dev')) {
    return true;
  }
  if (command.includes(rootDir) && command.includes('Electron.app')) {
    return true;
  }
  if (command.includes('node ./scripts/dev.mjs') || command.includes('node scripts/dev.mjs')) {
    return true;
  }
  return false;
};

const stopExistingDev = async () => {
  const currentPid = process.pid;
  const processes = await listProcesses();
  const targets = processes
    .filter((entry) => entry.pid !== currentPid && matchesForgerDesktopDevProcess(entry.command))
    .map((entry) => entry.pid);

  if (targets.length === 0) {
    console.log('No running Forger Desktop dev process found.');
    return;
  }

  console.log(`Stopping ${targets.length} Forger Desktop dev process${targets.length === 1 ? '' : 'es'}...`);
  if (dryRun) {
    for (const pid of targets) {
      console.log(`- would stop pid ${pid}`);
    }
    return;
  }

  for (const pid of targets) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // Process may have already exited.
    }
  }

  await sleep(1_000);

  const remaining = (await listProcesses())
    .filter((entry) => targets.includes(entry.pid))
    .map((entry) => entry.pid);
  for (const pid of remaining) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Process may have already exited.
    }
  }
};

const resetDevState = async () => {
  console.log('Resetting Forger Desktop dev state.');
  console.log('This removes only local dev runtime state. Source repositories are not touched.');
  for (const target of devStatePaths) {
    console.log(`- ${target}`);
  }

  if (dryRun) {
    console.log('Dry run only. No files were removed.');
    return;
  }

  for (const target of devStatePaths) {
    await rm(target, { recursive: true, force: true });
    console.log(`Removed ${target}`);
  }
};

const launchDev = async () => {
  if (noLaunch) {
    console.log('Skipping dev launch because --no-launch was provided.');
    return;
  }

  console.log('Launching Forger Desktop dev from a fresh state...');
  await import('./dev.mjs');
};

await stopExistingDev();
await resetDevState();
await launchDev();
