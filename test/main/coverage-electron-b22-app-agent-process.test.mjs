import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const childProcess = require('node:child_process');
const processSpawn = require('../../dist-electron/main/runtime/process-spawn.js');
const {
  killProcessTree,
  killServiceProcessesForMetadataRoot,
  runCommandCapture,
} = require('../../dist-electron/main/app-agent/process.js');

const withProcessDoubles = async ({ platform = process.platform, spawnSync, kill }, action) => {
  const originalPlatform = process.platform;
  const originalSpawnSync = childProcess.spawnSync;
  const originalKill = process.kill;
  try {
    Object.defineProperty(process, 'platform', { configurable: true, value: platform });
    if (spawnSync) {
      childProcess.spawnSync = spawnSync;
    }
    if (kill) {
      process.kill = kill;
    }
    return await action();
  } finally {
    Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform });
    childProcess.spawnSync = originalSpawnSync;
    process.kill = originalKill;
  }
};

const createChild = ({ onEnd }) => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = new EventEmitter();
  child.stdin.end = (text) => onEnd({ child, text });
  child.killed = false;
  return child;
};

test('command capture rejects a fatal stdin failure and ignores later child events', async () => {
  const originalSpawnProcess = processSpawn.spawnProcess;
  const fatalError = Object.assign(new Error('stdin unavailable'), { code: 'EIO' });
  try {
    processSpawn.spawnProcess = () => createChild({
      onEnd: ({ child, text }) => {
        assert.equal(text, 'request');
        child.stdin.emit('error', fatalError);
        child.emit('error', new Error('late process failure'));
        child.emit('exit', 0);
      },
    });

    await assert.rejects(() => runCommandCapture('fake-agent', [], {
      cwd: process.cwd(),
      stdinText: 'request',
      timeoutMs: 1_000,
    }), fatalError);
  } finally {
    processSpawn.spawnProcess = originalSpawnProcess;
  }
});

test('command capture preserves streams and maps a signal-only exit to failure', async () => {
  const originalSpawnProcess = processSpawn.spawnProcess;
  const streamed = [];
  try {
    processSpawn.spawnProcess = () => createChild({
      onEnd: ({ child, text }) => {
        assert.equal(text, '');
        child.stdout.emit('data', Buffer.from('partial output'));
        child.stderr.emit('data', Buffer.from('warning'));
        child.emit('exit', null);
      },
    });

    assert.deepEqual(await runCommandCapture('fake-agent', [], {
      cwd: process.cwd(),
      onStdout: (text) => streamed.push(['stdout', text]),
      onStderr: (text) => streamed.push(['stderr', text]),
    }), {
      code: 1,
      stdout: 'partial output',
      stderr: 'warning',
    });
    assert.deepEqual(streamed, [['stdout', 'partial output'], ['stderr', 'warning']]);
  } finally {
    processSpawn.spawnProcess = originalSpawnProcess;
  }
});

test('process-tree termination uses the process group, direct child, and fallback paths', async () => {
  const groupSignals = [];
  await withProcessDoubles({
    platform: 'linux',
    kill: (pid, signal) => groupSignals.push([pid, signal]),
  }, async () => {
    killProcessTree({ killed: false, pid: 42, kill: () => assert.fail('group kill should be used') });
  });
  assert.deepEqual(groupSignals, [[-42, 'SIGKILL']]);

  let directSignal = null;
  await withProcessDoubles({ platform: 'win32' }, async () => {
    killProcessTree({ killed: false, pid: 42, kill: (signal) => { directSignal = signal; } });
  });
  assert.equal(directSignal, 'SIGKILL');

  let fallbackSignal = null;
  await withProcessDoubles({
    platform: 'linux',
    kill: () => { throw new Error('missing process group'); },
  }, async () => {
    killProcessTree({ killed: false, pid: 42, kill: (signal) => { fallbackSignal = signal; } });
  });
  assert.equal(fallbackSignal, 'SIGKILL');
});

test('service cleanup selects only matching live processes and tolerates races', async () => {
  let psCalls = 0;
  const signals = [];
  await withProcessDoubles({
    platform: 'linux',
    spawnSync: () => {
      psCalls += 1;
      return {
        stdout: [
          'not a process',
          `${process.pid} node /srv/voice --metadata-root /metadata`,
          '321 node /srv/other --metadata-root /metadata',
          '322 node /srv/voice --different-option /metadata',
          '323 node /srv/voice --metadata-root /elsewhere',
          '324 node /srv/voice --metadata-root /metadata',
          '325 node /srv/voice --metadata-root /metadata',
        ].join('\n'),
      };
    },
    kill: (pid, signal) => {
      signals.push([pid, signal]);
      if (pid === 325) {
        throw new Error('already exited');
      }
    },
  }, async () => {
    killServiceProcessesForMetadataRoot('/srv/voice', '/metadata');
  });
  assert.equal(psCalls, 1);
  assert.deepEqual(signals, [[324, 'SIGTERM'], [325, 'SIGTERM']]);

  await withProcessDoubles({ platform: 'win32' }, async () => {
    killServiceProcessesForMetadataRoot('/srv/voice', '/metadata');
  });

  for (const failedPs of [{ error: new Error('ps unavailable') }, { stdout: '' }]) {
    await withProcessDoubles({
      platform: 'linux',
      spawnSync: () => failedPs,
    }, async () => {
      killServiceProcessesForMetadataRoot('/srv/voice', '/metadata');
    });
  }
});
