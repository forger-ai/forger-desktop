import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import Module, { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);
const modulePath = require.resolve('../../dist-electron/main/automation/agent-command-runner.js');

const createChild = (pid = 4321) => {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { end: (value) => { child.stdinValue = value; } };
  child.killCalls = [];
  child.kill = (signal) => { child.killCalls.push(signal); };
  return child;
};

const loadRunner = (state) => {
  const originalLoad = Module._load;
  Module._load = function loadWithHarness(request, parent, isMain) {
    if (request === '../runtime/process-spawn') {
      return {
        spawnProcess: (command, args, options) => {
          state.spawns.push({ command, args, options, child: state.child });
          return state.child;
        },
      };
    }
    if (request === '../child-stdio') {
      return {
        guardChildStdin: (_child, onFatalError) => { state.stdinFatal = onFatalError; },
      };
    }
    if (request === '../llm-provider/run-service') {
      return {
        createLlmProviderRunService: (options) => ({
          resolveCommand: async (...args) => {
            state.resolveCalls.push({ options, args });
            return { command: '/resolved/codex', prefixArgs: ['entry.js'], pathEntries: ['/bin'] };
          },
          run: async (input) => {
            state.runInputs.push({ options, input });
            return await input.runCommandCapture('provider-command', ['run'], {
              cwd: input.workingDir,
              env: state.captureEnv,
              timeoutMs: state.captureTimeoutMs,
              stdinText: state.stdinText,
              onChild: state.captureOnChild,
              onStdout: (text) => input.onOutput('stdout', text),
              onStderr: (text) => input.onOutput('stderr', text),
            });
          },
        }),
      };
    }
    return originalLoad.apply(this, [request, parent, isMain]);
  };
  try {
    delete require.cache[modulePath];
    return require(modulePath);
  } finally {
    Module._load = originalLoad;
  }
};

const waitFor = async (predicate, label) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`condition_not_reached:${label}`);
};

const fixture = async (t, name) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `forger-b30-runner-${name}-`));
  t.after(async () => await fs.rm(root, { recursive: true, force: true }));
  return root;
};

const stateFor = () => ({
  child: createChild(),
  spawns: [],
  resolveCalls: [],
  runInputs: [],
  captureEnv: undefined,
  captureTimeoutMs: 0,
  stdinText: undefined,
  captureOnChild: undefined,
  stdinFatal: undefined,
});

const optionsFor = (root, overrides = {}) => ({
  runtime: { provider: 'antigravity', model: 'gemini-test', effort: 'medium' },
  cwd: root,
  codexHome: path.join(root, 'codex-home'),
  prompt: 'Run automation',
  transcriptPath: path.join(root, 'transcript.log'),
  ...overrides,
});

test('Given command resolution and an absent provider path, when the automation runner starts, then resolution delegates and missing CLIs fail before spawning', async (t) => {
  const root = await fixture(t, 'resolve');
  const state = stateFor();
  const runner = loadRunner(state);

  assert.deepEqual(await runner.resolveCodexCommand('/cli/codex', ['/custom']), {
    command: '/resolved/codex',
    prefixArgs: ['entry.js'],
    pathEntries: ['/bin'],
  });
  assert.deepEqual(state.resolveCalls[0].args, ['codex', '/cli/codex', ['/custom']]);
  await assert.rejects(
    runner.runAgentCommand({ pathEntries: [] }, optionsFor(root)),
    /provider_cli_missing/,
  );
  assert.equal(state.spawns.length, 0);
});

test('Given an Antigravity command with no optional capture settings, when stdout and a null exit arrive, then callbacks, defaults, and exit normalization remain observable', async (t) => {
  const root = await fixture(t, 'capture');
  const state = stateFor();
  const childSeen = [];
  state.captureOnChild = (child) => childSeen.push(child);
  const runner = loadRunner(state);
  const assistantUpdates = [];
  const output = [];

  const execution = runner.runAgentCommand({
    command: '/cli/agy',
    pathEntries: ['/custom'],
  }, optionsFor(root, {
    onAssistantMessages: (messages) => assistantUpdates.push(messages),
    onOutput: (stream, text) => output.push([stream, text]),
  }));
  await waitFor(() => state.spawns.length === 1, 'spawn');
  state.child.stdout.emit('data', Buffer.from(' first '));
  state.child.stdout.emit('data', Buffer.from(' second'));
  state.child.stderr.emit('data', Buffer.from('diagnostic'));
  state.child.emit('exit', null);

  assert.deepEqual(await execution, { code: 1, stdout: ' first  second', stderr: 'diagnostic' });
  assert.equal(state.child.stdinValue, '');
  assert.deepEqual(childSeen, [state.child]);
  assert.deepEqual(assistantUpdates.at(-1), ['first  second']);
  assert.deepEqual(output, [
    ['stdout', ' first '],
    ['stdout', ' second'],
    ['stderr', 'diagnostic'],
  ]);
  assert.deepEqual(state.runInputs[0].input.resolvedCommand, {
    command: '/cli/agy',
    prefixArgs: [],
    pathEntries: ['/custom'],
  });
  assert.equal(state.runInputs[0].input.timeoutMs, 300_000);
  assert.equal(state.spawns[0].options.env.PATH, process.env.PATH);
});

test('Given a fatal stdin stream error with an active timeout, when capture rejects, then the timer is cleared and no child process survives', async (t) => {
  const root = await fixture(t, 'stdin-error');
  const state = stateFor();
  state.captureTimeoutMs = 10_000;
  state.captureEnv = { FORGER_TEST: 'yes' };
  state.stdinText = 'prompt over stdin';
  const runner = loadRunner(state);

  const execution = runner.runAgentCommand({
    cliPath: '/cli/codex',
    pathEntries: [],
  }, optionsFor(root, {
    runtime: { provider: 'codex', model: 'gpt-test', effort: 'low' },
  }));
  await waitFor(() => typeof state.stdinFatal === 'function', 'stdin-guard');
  state.stdinFatal(new Error('stdin write failed'));
  await assert.rejects(execution, /stdin write failed/);
  assert.equal(state.child.stdinValue, 'prompt over stdin');
  assert.equal(state.spawns[0].options.env.FORGER_TEST, 'yes');
});
