import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { runLocalCommandCapture, stopLocalProcessTree } = require('../../dist-electron/main/llm-provider/local/process.js');

async function temporaryDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'forger-local-process-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

test('local runner replaces environment and forwards stdin and streamed output', async (t) => {
  const cwd = await temporaryDirectory(t);
  const chunks = [];
  const result = await runLocalCommandCapture(process.execPath, ['-e', `
    process.stdin.on('data', chunk => process.stdout.write(chunk));
    process.stdin.on('end', () => process.stdout.write(JSON.stringify(Object.keys(process.env))));
  `], {
    cwd,
    env: { FORGER_TEST_ONLY: 'yes' },
    timeoutMs: 3000,
    stdinText: 'synthetic prompt',
    onStdout: (text) => chunks.push(text),
  });
  assert.equal(result.code, 0);
  assert.ok(result.stdout.startsWith('synthetic prompt'));
  const names = JSON.parse(result.stdout.slice('synthetic prompt'.length));
  assert.ok(names.includes('FORGER_TEST_ONLY'));
  assert.deepEqual(names.filter((name) => name !== 'FORGER_TEST_ONLY' && name !== '__CF_USER_TEXT_ENCODING' && name !== 'NODE_V8_COVERAGE'), []);
  assert.equal(chunks.join(''), result.stdout);
});

test('local runner imposes absolute deadline despite continuous output', { timeout: 10000 }, async (t) => {
  const cwd = await temporaryDirectory(t);
  const chunks = [];
  await assert.rejects(runLocalCommandCapture(process.execPath, ['-e', `
    setInterval(() => process.stdout.write('still running'), 10);
  `], { cwd, timeoutMs: 1000, inactivityTimeoutMs: 3000, onStdout: text => chunks.push(text) }), /local_timeout/);
  assert.ok(chunks.length > 0, 'the provider streams before its absolute deadline');
});

test('local runner distinguishes inactivity and bounds captured bytes', async (t) => {
  const cwd = await temporaryDirectory(t);
  await assert.rejects(runLocalCommandCapture(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    cwd, timeoutMs: 2000, inactivityTimeoutMs: 80,
  }), /local_inactivity_timeout/);
  await assert.rejects(runLocalCommandCapture(process.execPath, ['-e', "process.stdout.write('x'.repeat(5 * 1024 * 1024))"], {
    cwd, timeoutMs: 3000,
  }), /local_output_limit/);
});

test('cancelling local runner kills the child and its subprocess group', {
  skip: process.platform === 'win32' ? 'Windows tree termination needs Windows CI' : false,
}, async (t) => {
  const cwd = await temporaryDirectory(t);
  let child;
  let descendant;
  const result = await runLocalCommandCapture(process.execPath, ['-e', `
    const { spawn } = require('node:child_process');
    const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    process.stdout.write(String(descendant.pid));
    setInterval(() => {}, 1000);
  `], {
    cwd,
    timeoutMs: 3000,
    onChild: (value) => { child = value; },
    onStdout: (text) => {
      descendant = Number(text);
      stopLocalProcessTree(child);
    },
  });
  assert.notEqual(result.code, 0);
  assert.ok(descendant > 0);
  const deadline = Date.now() + 1500;
  while (Date.now() < deadline) {
    try { process.kill(descendant, 0); } catch (error) {
      if (error.code === 'ESRCH') return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail('descendant process survived cancellation');
});

test('missing CLI fails without revealing command paths', async (t) => {
  const cwd = await temporaryDirectory(t);
  await assert.rejects(runLocalCommandCapture(path.join(cwd, 'missing'), [], { cwd }), /local_cli_unavailable/);
});
