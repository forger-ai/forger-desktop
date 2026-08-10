import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createAgentAuthController } = require('../../dist-electron/main/runtime/agent-auth.js');

const tmpRoot = async (name) => await fs.mkdtemp(path.join(os.tmpdir(), `forger-${name}-`));

const withPlatform = async (platform, operation) => {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: platform });
  try {
    return await operation();
  } finally {
    Object.defineProperty(process, 'platform', descriptor);
  }
};

const withEnv = async (patch, operation) => {
  const previous = {};
  for (const [key, value] of Object.entries(patch)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await operation();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

class FakeChildProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin = { destroyed: false, on() {}, write() { return true; } };
  killed = false;
  pid = 12012;

  kill(signal) {
    this.killed = true;
    this.signal = signal;
    queueMicrotask(() => this.emit('exit', null, signal));
    return true;
  }

  unref() { this.unreferenced = true; }
}

const makeHarness = async (overrides = {}) => {
  const root = await tmpRoot('agent-auth-b12');
  const calls = [];
  const registry = { apps: {} };
  const deps = {
    CLAUDE_CODE_VERSION: '1.0.0',
    CODEX_CLI_VERSION: '0.99.0',
    DEFAULT_NODE_VERSION: '22.0.0',
    appendInstallLog: async (event, payload = {}) => calls.push(['log', event, payload]),
    app: { getPath: () => root },
    buildCodexAuthEnvironment: ({ codexHome, codexCliPath, nodePathEntries }) => ({
      CODEX_HOME: codexHome,
      PATH: [...nodePathEntries, path.dirname(codexCliPath), '/usr/bin'].join(path.delimiter),
    }),
    buildMacTerminalLoginScript: ({ command }) => command.join(' '),
    buildMacTerminalScriptLaunchCommand: (scriptPath) => `/bin/bash ${scriptPath}`,
    canRunCommand: async () => false,
    classifyCodexAuthOutput: () => undefined,
    ensureRuntimeInstalled: async (type) => type === 'node'
      ? { node: path.join(root, 'node'), npm: path.join(root, 'npm') }
      : { python: path.join(root, 'python') },
    extractAllowedCodexAuthUrls: () => [],
    failureDiagnostic: (error, fallbackCode) => ({ technicalCode: error instanceof Error ? error.message : fallbackCode }),
    findExistingFile: async (baseDir, candidates) => {
      for (const candidate of candidates) {
        const attempt = path.join(baseDir, candidate);
        if ((await fs.stat(attempt).catch(() => null))?.isFile()) return attempt;
      }
      return null;
    },
    findManifestService: () => null,
    fs,
    getClaudeRoot: () => path.join(root, 'claude-root'),
    getAntigravityRoot: () => path.join(root, 'antigravity-root'),
    getCodexHome: () => path.join(root, 'codex-home'),
    getCodexRoot: () => path.join(root, 'codex-root'),
    getForgerMetadataRoot: () => path.join(root, 'metadata'),
    getLogsRoot: () => path.join(root, 'logs'),
    getTempRoot: () => path.join(root, 'tmp'),
    markProviderConnected: async (provider) => calls.push(['connected', provider]),
    markProviderDisconnected: async (provider) => calls.push(['disconnected', provider]),
    path,
    registry,
    resolveInstalledManifest: async () => null,
    runCommand: async (command, args, options) => calls.push(['run', command, args, options]),
    runCommandCapture: async (command, args) => {
      calls.push(['capture', command, args]);
      return { code: 0, stdout: 'Logged in using ChatGPT\n', stderr: '' };
    },
    serializeErrorForInstallLog: (error) => ({ message: error instanceof Error ? error.message : String(error) }),
    shell: { openExternal: async (url) => calls.push(['openExternal', url]) },
    spawn: () => new FakeChildProcess(),
    translateManifestEnvironment: (environment) => environment,
    truncateForInstallLog: (value) => value,
    ...overrides,
  };
  return {
    root,
    calls,
    deps,
    controller: createAgentAuthController(deps),
    cleanup: async () => fs.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 }),
  };
};

const installCodexFixture = async (root, version = '0.99.0') => {
  await fs.mkdir(path.join(root, 'codex-root', 'node_modules', '.bin'), { recursive: true });
  await fs.mkdir(path.join(root, 'codex-root', 'node_modules', '@openai', 'codex'), { recursive: true });
  await fs.mkdir(path.join(root, 'codex-home'), { recursive: true });
  await fs.writeFile(path.join(root, 'codex-root', 'node_modules', '.bin', 'codex'), '');
  await fs.writeFile(path.join(root, 'codex-root', 'node_modules', '@openai', 'codex', 'package.json'), JSON.stringify({ version }));
  await fs.writeFile(path.join(root, 'codex-home', 'auth.json'), '{}');
};

const installClaudeFixture = async (root, version = '1.0.0') => {
  await fs.mkdir(path.join(root, 'claude-root', 'node_modules', '.bin'), { recursive: true });
  await fs.mkdir(path.join(root, 'claude-root', 'node_modules', '@anthropic-ai', 'claude-code'), { recursive: true });
  await fs.writeFile(path.join(root, 'claude-root', 'node_modules', '.bin', 'claude'), '');
  await fs.writeFile(path.join(root, 'claude-root', 'node_modules', '@anthropic-ai', 'claude-code', 'package.json'), JSON.stringify({ version }));
};

const installAntigravityFixture = async (root) => {
  await fs.mkdir(path.join(root, 'antigravity-root', 'bin'), { recursive: true });
  await fs.writeFile(path.join(root, 'antigravity-root', 'bin', 'agy'), '');
};

test('given malformed Codex app-server replies, status contains no unsafe or partial rate-limit state', async () => {
  const children = [];
  const harness = await makeHarness({
    app: { getPath: () => harness.root, getVersion: () => '12.0.0' },
    spawn: () => {
      const child = new FakeChildProcess();
      children.push(child);
      child.stdin.write = (text) => {
        const message = JSON.parse(text);
        if (message.id === 2) queueMicrotask(() => child.stdout.emit('data', '\nnot-json\n{"id":1}\n{"id":2,"error":{"code":1}}\n'));
        return true;
      };
      return child;
    },
  });
  try {
    await installCodexFixture(harness.root);
    const status = await harness.controller.getCodexAuthStatus();
    assert.equal(status.authenticated, true);
    assert.equal(status.rateLimits, undefined);
    assert.equal(children[0].killed, true);
    assert.equal(harness.calls.some((call) => call[1] === 'codex_auth:rate_limits_failed'), true);
  } finally {
    await harness.cleanup();
  }
});

test('given Codex app-server exit, missing stdin, and timeout, status remains authenticated and records diagnostics', async () => {
  for (const mode of ['exit', 'exit-empty', 'stdin', 'timeout']) {
    let child;
    const harness = await makeHarness({
      spawn: () => {
        child = new FakeChildProcess();
        if (mode === 'stdin') child.stdin = undefined;
        if (mode === 'exit' || mode === 'exit-empty') queueMicrotask(() => {
          if (mode === 'exit') child.stderr.emit('data', 'server stderr');
          child.emit('exit', mode === 'exit' ? null : 2);
        });
        return child;
      },
    });
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    try {
      await installCodexFixture(harness.root);
      if (mode === 'timeout') {
        globalThis.setTimeout = (callback) => { queueMicrotask(callback); return 1; };
        globalThis.clearTimeout = () => undefined;
      }
      const status = await harness.controller.getCodexAuthStatus();
      assert.equal(status.authenticated, true);
      assert.equal(status.rateLimits, undefined);
      assert.equal(harness.calls.some((call) => call[1] === 'codex_auth:rate_limits_failed'), true);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
      await harness.cleanup();
    }
  }
});

test('given irregular rate-limit payloads, status normalizes bounds and rejects malformed buckets', async () => {
  const harness = await makeHarness({
    spawn: () => {
      const child = new FakeChildProcess();
      child.stdin.write = (text) => {
        const message = JSON.parse(text);
        if (message.id === 2) queueMicrotask(() => child.stdout.emit('data', `${JSON.stringify({
          id: 2,
          result: {
            rateLimits: { limitId: ' main ', limitName: 4, planType: 5, primary: { usedPercent: 120, windowDurationMins: -2, resetsAt: Number.NaN }, secondary: null, credits: [] },
            rateLimitsByLimitId: {
              absent: null,
              blank: { limitId: ' ' },
              secondary: { limitId: 'secondary', primary: { usedPercent: 'bad', windowDurationMins: Number.NaN }, secondary: { usedPercent: -5, resetsAt: 10 }, rateLimitReachedType: 'hard', credits: { balance: 1 } },
            },
          },
        })}\n`));
        return true;
      };
      return child;
    },
  });
  try {
    await installCodexFixture(harness.root);
    const status = await harness.controller.getCodexAuthStatus();
    assert.equal(status.rateLimits.primary.primary.usedPercent, 100);
    assert.equal(status.rateLimits.primary.primary.remainingPercent, 0);
    assert.equal(status.rateLimits.primary.primary.windowDurationMins, 0);
    assert.equal(status.rateLimits.primary.secondary, null);
    assert.equal(status.rateLimits.buckets.length, 2);
    assert.equal(status.rateLimits.buckets[1].secondary.usedPercent, 0);
  } finally {
    await harness.cleanup();
  }
});

test('given an empty Codex rate-limit result, status treats it as unavailable', async () => {
  const harness = await makeHarness({
    spawn: () => {
      const child = new FakeChildProcess();
      child.stdin.write = (text) => {
        if (JSON.parse(text).id === 2) queueMicrotask(() => child.stdout.emit('data', '{"id":2,"result":null}\n'));
        return true;
      };
      return child;
    },
  });
  try {
    await installCodexFixture(harness.root);
    assert.equal((await harness.controller.getCodexAuthStatus()).rateLimits, undefined);
  } finally {
    await harness.cleanup();
  }
});

test('given runtime and disk probes fail, provider installs return stable recovery messages', async () => {
  const diskFs = Object.assign(Object.create(fs), { statfs: async () => { throw new Error('statfs unavailable'); } });
  const disk = await makeHarness({ fs: diskFs, runCommand: async () => undefined });
  try {
    await assert.rejects(() => disk.controller.ensureCodexCliInstalled(), /codex_cli_install_failed/);
  } finally {
    await disk.cleanup();
  }

  const runtime = await makeHarness({
    ensureRuntimeInstalled: async () => { throw new Error('runtime_node_executable_not_found'); },
  });
  try {
    const result = await runtime.controller.connectCodexAuth();
    assert.equal(result.success, false);
    assert.match(result.userMessage, /runtime local de Node/);
  } finally {
    await runtime.cleanup();
  }
});

test('given an empty host PATH, managed Codex and Claude installers construct a local executable path', async () => {
  const codex = await makeHarness({
    runCommand: async (_command, _args, options) => {
      await fs.mkdir(path.join(options.cwd, 'node_modules', '.bin'), { recursive: true });
      await fs.writeFile(path.join(options.cwd, 'node_modules', '.bin', 'codex'), '');
    },
  });
  try {
    assert.match(await withEnv({ PATH: undefined }, () => codex.controller.ensureCodexCliInstalled()), /codex$/);
  } finally {
    await codex.cleanup();
  }

  let probes = 0;
  const claude = await makeHarness({
    canRunCommand: async (command) => {
      if (!command.endsWith('claude')) return false;
      probes += 1;
      return probes > 1;
    },
    runCommand: async () => undefined,
  });
  try {
    await fs.mkdir(path.join(claude.root, 'claude-root', 'node_modules', '.bin'), { recursive: true });
    await fs.mkdir(path.join(claude.root, 'claude-root', 'node_modules', '@anthropic-ai', 'claude-code'), { recursive: true });
    await fs.writeFile(path.join(claude.root, 'claude-root', 'node_modules', '.bin', 'claude'), '');
    await fs.writeFile(path.join(claude.root, 'claude-root', 'node_modules', '@anthropic-ai', 'claude-code', 'package.json'), '{"version":12}');
    const result = await withEnv({ PATH: undefined }, () => withPlatform('linux', () => claude.controller.connectClaudeAuth()));
    assert.equal(result.success, true);
  } finally {
    await claude.cleanup();
  }
});

test('given global and app-scoped tool environments, optional metadata and package versions normalize safely', async () => {
  const harness = await makeHarness({
    resolveInstalledManifest: async () => ({ services: [] }),
    findManifestService: () => ({ name: 'backend' }),
  });
  try {
    const globalEnv = await harness.controller.getCodexToolEnvironment();
    assert.match(globalEnv.UV_CACHE_DIR, /tool-cache[/\\]global/);
    harness.deps.registry.apps['unsafe app/id'] = { installDir: path.join(harness.root, 'app') };
    const appEnv = await harness.controller.getCodexToolEnvironment('unsafe app/id');
    assert.match(appEnv.UV_CACHE_DIR, /unsafe_app_id/);

    await fs.mkdir(path.join(harness.root, 'codex-root', 'node_modules', '@openai', 'codex'), { recursive: true });
    await fs.writeFile(path.join(harness.root, 'codex-root', 'node_modules', '@openai', 'codex', 'package.json'), '{"version":12}');
    assert.equal(await harness.controller.getInstalledCodexCliVersion(path.join(harness.root, 'codex-root')), null);
  } finally {
    await harness.cleanup();
  }
});

test('given duplicate and partial Codex RPC responses, settlement and bucket selection are idempotent', async () => {
  for (const mode of ['buckets-only', 'empty-object', 'double-error', 'double-success']) {
    const harness = await makeHarness({
      spawn: () => {
        const child = new FakeChildProcess();
        child.stdin.write = (text) => {
          if (JSON.parse(text).id !== 2) return true;
          const payload = mode === 'buckets-only'
            ? [{ id: 2, result: { rateLimitsByLimitId: { bucket: { limitId: 'bucket', planType: 'pro', primary: null } } } }]
            : mode === 'empty-object'
              ? [{ id: 2, result: {} }]
              : mode === 'double-error'
                ? [{ id: 2, error: { message: 'rate failed' } }, { id: 2, error: { message: 'ignored' } }]
                : [{ id: 2, result: { rateLimits: { limitId: 'one' } } }, { id: 2, result: { rateLimits: { limitId: 'two' } } }];
          queueMicrotask(() => child.stdout.emit('data', `${payload.map(JSON.stringify).join('\n')}\n`));
          return true;
        };
        return child;
      },
    });
    try {
      await installCodexFixture(harness.root);
      const status = await harness.controller.getCodexAuthStatus();
      if (mode === 'buckets-only') assert.equal(status.rateLimits.buckets[0].planType, 'pro');
      if (mode === 'empty-object' || mode === 'double-error') assert.equal(status.rateLimits, undefined);
      if (mode === 'double-success') assert.equal(status.rateLimits.primary.limitId, 'one');
    } finally {
      await harness.cleanup();
    }
  }
});

test('given a deferred managed Claude candidate, version mismatch and install failures stay observable', async () => {
  let probes = 0;
  const harness = await makeHarness({
    canRunCommand: async (command) => {
      if (!command.endsWith('claude')) return false;
      probes += 1;
      return probes > 1;
    },
    runCommand: async (command, args, options) => harness.calls.push(['run', command, args, options]),
  });
  try {
    await installClaudeFixture(harness.root, '0.1.0');
    const result = await withPlatform('linux', () => harness.controller.connectClaudeAuth());
    assert.equal(result.success, true);
    assert.equal(harness.calls.some((call) => call[1] === 'claude_auth:version_mismatch'), true);
  } finally {
    await harness.cleanup();
  }
});

test('given an unreadable Claude package version, managed installation repairs the CLI metadata', async () => {
  let probes = 0;
  const harness = await makeHarness({
    canRunCommand: async (command) => {
      if (!command.endsWith('claude')) return false;
      probes += 1;
      return probes > 1;
    },
    runCommand: async (command, args, options) => harness.calls.push(['run', command, args, options]),
  });
  try {
    await fs.mkdir(path.join(harness.root, 'claude-root', 'node_modules', '.bin'), { recursive: true });
    await fs.writeFile(path.join(harness.root, 'claude-root', 'node_modules', '.bin', 'claude'), '');
    const result = await withPlatform('linux', () => harness.controller.connectClaudeAuth());
    assert.equal(result.success, true);
    assert.equal(harness.calls.some((call) => call[1] === 'claude_auth:version_mismatch'), true);
  } finally {
    await harness.cleanup();
  }
});

test('given Claude status variants, stderr versions, empty status, and installed unauthenticated state stay distinct', async () => {
  const harness = await makeHarness({
    canRunCommand: async (command) => command.endsWith('claude'),
    runCommandCapture: async (_command, args) => args[0] === '--version'
      ? { code: 0, stdout: '', stderr: 'Claude stderr version' }
      : { code: 1, stdout: '', stderr: '' },
    runCommand: async () => undefined,
  });
  try {
    await installClaudeFixture(harness.root);
    const status = await harness.controller.getClaudeAuthStatus();
    assert.equal(status.version, 'Claude stderr version');
    assert.equal(status.statusText, undefined);
    assert.equal((await harness.controller.confirmClaudeAuthConnection()).technicalCode, 'claude_auth_not_confirmed');
    const connected = await withPlatform('linux', () => harness.controller.connectClaudeAuth());
    assert.match(connected.userMessage, /verificando/);
    const disconnected = await harness.controller.disconnectClaudeAuth();
    assert.match(disconnected.userMessage, /desconectado/);
  } finally {
    await harness.cleanup();
  }

  const signedIn = await makeHarness({
    canRunCommand: async (command) => command.endsWith('claude'),
    runCommandCapture: async (_command, args) => args[0] === '--version'
      ? { code: 0, stdout: '', stderr: '' }
      : { code: 0, stdout: 'authenticated', stderr: '' },
  });
  try {
    await installClaudeFixture(signedIn.root);
    const result = await signedIn.controller.signOutClaudeAuth();
    assert.equal(result.success, false);
    assert.equal(result.technicalCode, 'claude_logout_still_authenticated');
  } finally {
    await signedIn.cleanup();
  }
});

test('given system Claude lookup and provider PATH fallbacks, platform resolution remains portable', async () => {
  const lookups = [];
  const harness = await makeHarness({
    runCommandCapture: async (command) => {
      lookups.push(command);
      return { code: 0, stdout: '', stderr: '' };
    },
  });
  try {
    await withPlatform('win32', () => harness.controller.getClaudeAuthStatus());
    assert.equal(lookups[0], 'where');
  } finally {
    await harness.cleanup();
  }
});

test('given Claude disconnect, logout, and confirmation failures, each boundary returns its distinct contract', async () => {
  const disconnect = await makeHarness({ markProviderDisconnected: async () => { throw new Error('registry unavailable'); } });
  try {
    const result = await disconnect.controller.disconnectClaudeAuth();
    assert.equal(result.technicalCode, 'registry unavailable');
  } finally {
    await disconnect.cleanup();
  }

  const missing = await makeHarness({ runCommandCapture: async () => ({ code: 1, stdout: '', stderr: '' }) });
  try {
    assert.equal((await missing.controller.confirmClaudeAuthConnection()).technicalCode, 'claude_cli_missing');
    assert.equal((await missing.controller.signOutClaudeAuth()).success, true);
  } finally {
    await missing.cleanup();
  }

  const logout = await makeHarness({
    canRunCommand: async (command) => command.endsWith('claude'),
    runCommand: async () => { throw new Error('logout unavailable'); },
  });
  try {
    await installClaudeFixture(logout.root);
    const result = await logout.controller.signOutClaudeAuth();
    assert.equal(result.success, false);
    assert.equal(result.technicalCode, 'logout unavailable');
  } finally {
    await logout.cleanup();
  }
});

test('given macOS Claude output, malformed URLs, browser failures, and late process errors are logged safely', async () => {
  let child;
  const harness = await makeHarness({
    canRunCommand: async (command) => command.endsWith('claude'),
    shell: { openExternal: async () => { throw new Error('browser unavailable'); } },
    spawn: () => { child = new FakeChildProcess(); return child; },
  });
  try {
    await installClaudeFixture(harness.root);
    const result = await withEnv({ PATH: undefined }, () => withPlatform('darwin', () => harness.controller.connectClaudeAuth()));
    assert.equal(result.success, true);
    child.stdout.emit('data', 'https://claude.ai:invalid/path https://claude.ai/login https://evil.example/login');
    child.stdout.emit('data', 'plain output without a URL');
    child.stderr.emit('data', 'https://anthropic.com/auth');
    child.emit('error', new Error('late claude error'));
    child.emit('exit', null, 'SIGTERM');
    let log = '';
    for (let attempt = 0; attempt < 6 && !log.includes('open_external_error'); attempt += 1) {
      await new Promise((resolve) => setImmediate(resolve));
      log = await fs.readFile(path.join(harness.root, 'logs', 'claude-login.log'), 'utf8');
    }
    assert.match(log, /open_external_error/);
    assert.match(log, /late claude error/);
  } finally {
    await harness.cleanup();
  }
});

test('given macOS Codex has no inherited PATH, login logging and nullable exit metadata remain safe', async () => {
  let child;
  const harness = await makeHarness({
    buildCodexAuthEnvironment: () => ({}),
    spawn: () => { child = new FakeChildProcess(); return child; },
  });
  try {
    await installCodexFixture(harness.root);
    const result = await withPlatform('darwin', () => harness.controller.connectCodexAuth());
    assert.equal(result.success, true);
    child.emit('exit', 0, null);
    await new Promise((resolve) => setImmediate(resolve));
    assert.match(await fs.readFile(path.join(harness.root, 'logs', 'codex-login.log'), 'utf8'), /pathPrefix=/);
  } finally {
    await harness.cleanup();
  }

  let nullableChild;
  let exitLogWrite;
  const observedFs = Object.assign(Object.create(fs), {
    appendFile: (...args) => {
      const write = fs.appendFile(...args);
      if (String(args[1]).includes('code=null signal=SIGTERM')) {
        exitLogWrite = write;
      }
      return write;
    },
  });
  const nullable = await makeHarness({
    fs: observedFs,
    spawn: () => { nullableChild = new FakeChildProcess(); return nullableChild; },
  });
  try {
    await installCodexFixture(nullable.root);
    assert.equal((await withPlatform('darwin', () => nullable.controller.connectCodexAuth())).success, true);
    nullableChild.emit('exit', null, 'SIGTERM');
    assert.ok(exitLogWrite, 'Codex exit listener must schedule its diagnostic write');
    await exitLogWrite;
    assert.match(await fs.readFile(path.join(nullable.root, 'logs', 'codex-login.log'), 'utf8'), /code=null signal=SIGTERM/);
  } finally {
    await nullable.cleanup();
  }
});

test('given a system Claude CLI without inherited PATH, macOS direct login still starts safely', async () => {
  let child;
  const harness = await makeHarness({
    canRunCommand: async (command) => command === '/system/claude',
    runCommandCapture: async (command, args) => command === 'which'
      ? { code: 0, stdout: '/system/claude\n', stderr: '' }
      : args[0] === '--version'
        ? { code: 0, stdout: '', stderr: '' }
        : { code: 1, stdout: '', stderr: '' },
    spawn: () => { child = new FakeChildProcess(); return child; },
  });
  try {
    const result = await withEnv({ PATH: undefined }, () => withPlatform('darwin', () => harness.controller.connectClaudeAuth()));
    assert.equal(result.success, true);
    child.emit('exit', 0, null);
  } finally {
    await harness.cleanup();
  }
});

test('given Linux terminal variants, Antigravity uses the platform-specific argument contract without a shell', async () => {
  for (const terminal of ['/usr/bin/gnome-terminal', '/usr/bin/konsole', '/usr/bin/xfce4-terminal']) {
    const spawns = [];
    const harness = await makeHarness({
      canRunCommand: async (command) => command.endsWith('agy'),
      runCommandCapture: async (_command, args) => args[0] === '--version'
        ? { code: 0, stdout: '1.0.0', stderr: '' }
        : { code: 1, stdout: '', stderr: '' },
      spawn: (command, args, options) => {
        const child = new FakeChildProcess();
        spawns.push([command, args, options]);
        if (terminal.includes('gnome')) {
          child.removeAllListeners = () => child;
          queueMicrotask(() => {
            child.emit('spawn');
            child.emit('error', new Error('late ignored terminal error'));
          });
        } else {
          queueMicrotask(() => child.emit('spawn'));
        }
        return child;
      },
    });
    try {
      await installAntigravityFixture(harness.root);
      const result = await withPlatform('linux', () => withEnv({ TERMINAL: terminal }, () => harness.controller.connectAntigravityAuth()));
      assert.equal(result.success, true);
      assert.equal(spawns[0][0], terminal);
      assert.equal(spawns[0][2].detached, true);
      if (terminal.includes('gnome')) assert.equal(spawns[0][1][0], '--');
      if (terminal.includes('konsole')) assert.deepEqual(spawns[0][1].slice(0, 2), ['--noclose', '-e']);
      if (terminal.includes('xfce')) assert.equal(spawns[0][1][0], '-e');
    } finally {
      await harness.cleanup();
    }
  }
});

test('given Windows console launch failures, each provider preserves the launcher exit code', async () => {
  for (const provider of ['codex', 'claude', 'antigravity']) {
    const harness = await makeHarness({
      canRunCommand: async (command) => command.endsWith(provider === 'antigravity' ? 'agy.exe' : provider === 'claude' ? 'claude.exe' : 'codex.cmd'),
      runCommandCapture: async (_command, args) => args[0] === '--version'
        ? { code: 0, stdout: '1.0.0', stderr: '' }
        : { code: 1, stdout: '', stderr: '' },
      spawn: () => {
        const child = new FakeChildProcess();
        queueMicrotask(() => child.emit('exit', null));
        return child;
      },
    });
    try {
      if (provider === 'codex') await installCodexFixture(harness.root);
      if (provider === 'claude') {
        await fs.mkdir(path.join(harness.root, 'claude-root', 'node_modules', '@anthropic-ai', 'claude-code', 'bin'), { recursive: true });
        await fs.writeFile(path.join(harness.root, 'claude-root', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'), '');
      }
      if (provider === 'antigravity') {
        await fs.mkdir(path.join(harness.root, 'antigravity-root', 'bin'), { recursive: true });
        await fs.writeFile(path.join(harness.root, 'antigravity-root', 'bin', 'agy.exe'), '');
      }
      const result = await withPlatform('win32', () => provider === 'codex'
        ? harness.controller.connectCodexAuth()
        : provider === 'claude'
          ? harness.controller.connectClaudeAuth()
          : harness.controller.connectAntigravityAuth());
      assert.equal(result.success, false);
      assert.match(result.technicalCode, /unknown/);
    } finally {
      await harness.cleanup();
    }
  }
});

test('given no Linux terminal or a detached spawn error, Antigravity returns a deterministic failure', async () => {
  for (const mode of ['missing', 'spawn-error']) {
    const harness = await makeHarness({
      canRunCommand: async (command) => command.endsWith('agy'),
      runCommandCapture: async (_command, args) => args[0] === '--version'
        ? { code: 0, stdout: '1.0.0', stderr: '' }
        : { code: 1, stdout: '', stderr: '' },
      spawn: () => {
        const child = new FakeChildProcess();
        queueMicrotask(() => child.emit('error', new Error('terminal spawn failed')));
        return child;
      },
    });
    try {
      await installAntigravityFixture(harness.root);
      const env = mode === 'missing' ? { TERMINAL: undefined } : { TERMINAL: '/usr/bin/xterm' };
      const result = await withPlatform('linux', () => withEnv(env, () => harness.controller.connectAntigravityAuth()));
      assert.equal(result.success, false);
      assert.equal(result.technicalCode, mode === 'missing' ? 'linux_terminal_unavailable' : 'terminal spawn failed');
    } finally {
      await harness.cleanup();
    }
  }
});

test('given Windows and macOS credential cleanup, local state deletion is best-effort and auditable', async () => {
  const windows = await makeHarness({
    canRunCommand: async (command) => command.endsWith('agy.exe'),
    runCommandCapture: async (command, args) => {
      if (command === 'cmdkey.exe') return { code: 0, stdout: '', stderr: '' };
      if (args[0] === '--version') return { code: 0, stdout: '1.0.0', stderr: '' };
      return { code: 1, stdout: '', stderr: '' };
    },
    runCommand: async (_command, args) => {
      if (args[0].includes('gemini:antigravity')) throw new Error('credential locked');
    },
  });
  try {
    const result = await withPlatform('win32', () => windows.controller.disconnectAntigravityAuth());
    assert.equal(result.success, true);
    assert.equal(windows.calls.some((call) => call[1] === 'antigravity_auth:windows_credential_delete_failed'), true);
  } finally {
    await windows.cleanup();
  }

  const darwin = await makeHarness({
    runCommand: async () => { throw new Error('keychain locked'); },
    runCommandCapture: async () => ({ code: 1, stdout: '', stderr: '' }),
  });
  try {
    const result = await withPlatform('darwin', () => darwin.controller.disconnectAntigravityAuth());
    assert.equal(result.success, true);
    assert.equal(darwin.calls.some((call) => call[1] === 'antigravity_auth:mac_keychain_delete_failed'), true);
  } finally {
    await darwin.cleanup();
  }
});

test('given corrupt OAuth logs and undeletable local files, Antigravity logs failures without leaking state', async () => {
  let failOpen = true;
  const customFs = Object.assign(Object.create(fs), {
    open: async (...args) => {
      if (failOpen && String(args[0]).endsWith('.log')) throw new Error('log unreadable');
      return await fs.open(...args);
    },
    rm: async (target, options) => {
      if (String(target).endsWith('antigravity_state.pbtxt')) throw new Error('state locked');
      return await fs.rm(target, options);
    },
  });
  const harness = await makeHarness({
    fs: customFs,
    canRunCommand: async (command) => command.endsWith('agy'),
    runCommandCapture: async (_command, args) => args[0] === '--version'
      ? { code: 0, stdout: '1.0.0', stderr: '' }
      : { code: 1, stdout: '', stderr: '' },
  });
  try {
    await installAntigravityFixture(harness.root);
    const logDir = path.join(harness.root, '.gemini', 'antigravity-cli', 'log');
    const stateDir = path.join(harness.root, '.gemini', 'antigravity');
    await fs.mkdir(logDir, { recursive: true });
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(path.join(logDir, 'cli-b12.log'), 'OAuth: authenticated successfully');
    assert.equal((await harness.controller.getAntigravityAuthStatus()).authenticated, false);
    assert.equal(harness.calls.some((call) => call[1] === 'antigravity_auth:oauth_success_log_read_failed'), true);
    await fs.writeFile(path.join(stateDir, 'antigravity_state.pbtxt'), 'state');
    failOpen = false;
    const result = await harness.controller.disconnectAntigravityAuth();
    assert.equal(result.success, true);
    assert.equal(harness.calls.some((call) => call[1] === 'antigravity_auth:local_state_delete_failed'), true);
  } finally {
    await harness.cleanup();
  }
});

const startSessionHarness = async ({ platform = 'linux', terminalFails = false, browserFails = false } = {}) => {
  let child;
  let silenceCallback;
  const events = [];
  const eventWaiters = [];
  const harness = await makeHarness({
    canRunCommand: async (command) => command.endsWith('agy'),
    runCommandCapture: async (_command, args) => args[0] === '--version'
      ? { code: 0, stdout: '1.0.0', stderr: '' }
      : { code: 1, stdout: '', stderr: '' },
    runCommand: async (...args) => {
      if (terminalFails) throw new Error('terminal fallback failed');
      harness.calls.push(['run', ...args]);
    },
    shell: { openExternal: async (url) => {
      if (browserFails) throw new Error('browser failed');
      harness.calls.push(['openExternal', url]);
    } },
    spawn: () => { child = new FakeChildProcess(); return child; },
  });
  await installAntigravityFixture(harness.root);
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  globalThis.setTimeout = (callback) => { silenceCallback = callback; return 12; };
  globalThis.clearTimeout = () => undefined;
  const onEvent = (event) => {
    events.push(event);
    for (const waiter of [...eventWaiters]) {
      if (waiter.predicate(event)) {
        eventWaiters.splice(eventWaiters.indexOf(waiter), 1);
        waiter.resolve(event);
      }
    }
  };
  const result = await withPlatform(platform, () => harness.controller.startAntigravityAuthSession(onEvent));
  return {
    ...harness,
    child,
    events,
    result,
    silenceCallback,
    waitForEvent: (predicate) => {
      const existing = events.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve) => eventWaiters.push({ predicate, resolve }));
    },
    restoreTimers: () => {
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
    },
  };
};

test('given embedded-session silence, non-macOS warns while macOS opens a fallback terminal', async () => {
  for (const platform of ['linux', 'darwin']) {
    const harness = await startSessionHarness({ platform });
    try {
      await withPlatform(platform, async () => {
        const expectedEvent = harness.waitForEvent((event) => event.type === (platform === 'darwin' ? 'completed' : 'output'));
        harness.silenceCallback();
        await expectedEvent;
      });
      assert.equal(harness.events.some((event) => event.type === 'output'), true, `${platform}: ${JSON.stringify(harness.events)}`);
      if (platform === 'darwin') assert.equal(harness.events.some((event) => event.type === 'completed'), true);
    } finally {
      await harness.controller.cancelAntigravityAuthSession(harness.result.sessionId);
      harness.restoreTimers();
      await harness.cleanup();
    }
  }

  const failed = await startSessionHarness({ platform: 'darwin', terminalFails: true });
  try {
    await withPlatform('darwin', async () => {
      const failedEvent = failed.waitForEvent((event) => event.type === 'failed');
      failed.silenceCallback();
      await failedEvent;
    });
    assert.equal(failed.events.some((event) => event.type === 'failed'), true);
  } finally {
    await failed.controller.cancelAntigravityAuthSession(failed.result.sessionId);
    failed.restoreTimers();
    await failed.cleanup();
  }
});

test('given embedded-session output and process failures, URLs dedupe, redact, and failures settle once', async () => {
  const harness = await startSessionHarness({ browserFails: true });
  try {
    const url = 'https://accounts.google.com/o/oauth2/auth?client_id=b12';
    harness.child.stdout.emit('data', `${url}\n${url}`);
    harness.child.stderr.emit('data', 'diagnostic');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(harness.events.filter((event) => event.type === 'output').length, 2);
    assert.equal(harness.calls.filter((call) => call[0] === 'openExternal').length, 0);
    assert.equal(harness.calls.some((call) => call[1] === 'antigravity_auth:open_external_failed'), true);
    harness.child.emit('error', new Error('session child failed'));
    harness.child.emit('exit', 2);
    assert.equal(harness.events.some((event) => event.type === 'failed' && event.text === 'session child failed'), true);
  } finally {
    harness.restoreTimers();
    await harness.cleanup();
  }
});

test('given session cancellation, inactive writes and repeated cancel are idempotent with no false failure event', async () => {
  const harness = await startSessionHarness();
  try {
    assert.equal((await harness.controller.writeAntigravityAuthSession('missing', 'value')).technicalCode, 'antigravity_auth_session_not_active');
    harness.child.stdin.destroyed = true;
    assert.equal((await harness.controller.writeAntigravityAuthSession(harness.result.sessionId, 'value')).success, false);
    harness.child.stdin.destroyed = false;
    assert.equal((await harness.controller.cancelAntigravityAuthSession(harness.result.sessionId)).success, true);
    await Promise.resolve();
    assert.equal(harness.events.some((event) => event.type === 'failed'), false);
    assert.equal((await harness.controller.cancelAntigravityAuthSession(harness.result.sessionId)).success, true);
  } finally {
    harness.restoreTimers();
    await harness.cleanup();
  }
});

test('given a failed embedded process or post-output silence, the session emits one terminal outcome', async () => {
  const failed = await startSessionHarness();
  try {
    failed.child.emit('exit', 2);
    assert.equal(failed.events.some((event) => event.type === 'failed' && event.exitCode === 2), true);
  } finally {
    failed.restoreTimers();
    await failed.cleanup();
  }

  const output = await startSessionHarness({ platform: 'darwin' });
  try {
    output.child.stdout.emit('data', 'diagnostic output');
    await withPlatform('darwin', async () => {
      output.silenceCallback();
      await new Promise((resolve) => setImmediate(resolve));
    });
    assert.equal(output.events.some((event) => event.type === 'completed'), false);
    await output.controller.cancelAntigravityAuthSession(output.result.sessionId);
    await withPlatform('darwin', async () => {
      output.silenceCallback();
      await new Promise((resolve) => setImmediate(resolve));
    });
  } finally {
    output.restoreTimers();
    await output.cleanup();
  }
});

test('given authenticated or failed session startup, Antigravity avoids duplicate processes and returns diagnostics', async () => {
  const authenticated = await makeHarness({
    canRunCommand: async (command) => command.endsWith('agy'),
    runCommandCapture: async (_command, args) => args[0] === '--version'
      ? { code: 0, stdout: '1.0.0', stderr: '' }
      : { code: 1, stdout: '', stderr: '' },
  });
  try {
    await installAntigravityFixture(authenticated.root);
    await fs.mkdir(path.join(authenticated.root, '.gemini', 'antigravity'), { recursive: true });
    await fs.writeFile(path.join(authenticated.root, '.gemini', 'antigravity', 'antigravity_state.pbtxt'), 'state');
    const result = await authenticated.controller.startAntigravityAuthSession(() => assert.fail('no events expected'));
    assert.equal(result.status.authenticated, true);
    assert.equal(authenticated.calls.some((call) => call[0] === 'connected'), true);
  } finally {
    await authenticated.cleanup();
  }

  const failed = await makeHarness({
    canRunCommand: async (command) => command.endsWith('agy'),
    runCommandCapture: async (_command, args) => args[0] === '--version'
      ? { code: 0, stdout: '1.0.0', stderr: '' }
      : { code: 1, stdout: '', stderr: '' },
    spawn: () => { throw new Error('session spawn failed'); },
  });
  try {
    await installAntigravityFixture(failed.root);
    const result = await failed.controller.startAntigravityAuthSession(() => undefined);
    assert.equal(result.success, false);
    assert.equal(result.technicalCode, 'session spawn failed');
  } finally {
    await failed.cleanup();
  }
});

test('given nonstandard platform login, reinstall, and disconnect errors, Antigravity preserves explicit outcomes', async () => {
  const direct = await makeHarness({
    canRunCommand: async (command) => command.endsWith('agy'),
    runCommandCapture: async (_command, args) => args[0] === '--version'
      ? { code: 0, stdout: '1.0.0', stderr: '' }
      : { code: 1, stdout: '', stderr: '' },
    runCommand: async (command, args, options) => direct.calls.push(['run', command, args, options]),
  });
  try {
    await installAntigravityFixture(direct.root);
    const result = await withPlatform('freebsd', () => direct.controller.connectAntigravityAuth());
    assert.equal(result.success, true);
    assert.equal(direct.calls.some((call) => call[0] === 'run'), true);
  } finally {
    await direct.cleanup();
  }

  const reinstall = await makeHarness({
    canRunCommand: async (command) => command.endsWith('agy'),
    runCommand: async (command, args) => {
      if (command === 'curl') {
        await fs.writeFile(args[args.indexOf('-o') + 1], 'installer');
      }
      if (command === 'bash') {
        const binDir = args[args.indexOf('--dir') + 1];
        await fs.mkdir(binDir, { recursive: true });
        await fs.writeFile(path.join(binDir, 'agy'), '');
      }
    },
  });
  try {
    const result = await withPlatform('darwin', () => reinstall.controller.reinstallAntigravity());
    assert.equal(result.success, true);
  } finally {
    await reinstall.cleanup();
  }

  const disconnect = await makeHarness({ markProviderDisconnected: async () => { throw new Error('disconnect registry failed'); } });
  try {
    const result = await disconnect.controller.disconnectAntigravityAuth();
    assert.equal(result.success, false);
    assert.equal(result.technicalCode, 'disconnect registry failed');
  } finally {
    await disconnect.cleanup();
  }
});

test('given managed Antigravity install invariants, existing, post-reset, and unsupported platforms are explicit', async () => {
  const existing = await makeHarness({ canRunCommand: async (command) => command.endsWith('agy') });
  try {
    await installAntigravityFixture(existing.root);
    assert.match(await existing.controller.ensureAntigravityCliInstalled(), /agy$/);
  } finally {
    await existing.cleanup();
  }

  const root = await tmpRoot('agent-auth-reset-b12');
  const resetFs = Object.assign(Object.create(fs), {
    rm: async (target, options) => {
      await fs.rm(target, options);
      if (target === path.join(root, 'antigravity-root')) {
        await installAntigravityFixture(root);
      }
    },
  });
  const reset = await makeHarness({
    fs: resetFs,
    getAntigravityRoot: () => path.join(root, 'antigravity-root'),
    getTempRoot: () => path.join(root, 'tmp'),
    canRunCommand: async (command) => command.endsWith('agy'),
  });
  try {
    assert.equal((await reset.controller.reinstallAntigravity()).success, true);
  } finally {
    await reset.cleanup();
    await fs.rm(root, { recursive: true, force: true });
  }

  const unsupported = await makeHarness();
  try {
    await assert.rejects(
      () => withPlatform('freebsd', () => unsupported.controller.ensureAntigravityCliInstalled()),
      /antigravity_unsupported_platform/,
    );
  } finally {
    await unsupported.cleanup();
  }
});

test('given Antigravity resolution and local-log variants, managed and system candidates remain verified', async () => {
  const managedRejected = await makeHarness({ canRunCommand: async () => false });
  try {
    await installAntigravityFixture(managedRejected.root);
    assert.equal(await managedRejected.controller.resolveAntigravityCli(), null);
  } finally {
    await managedRejected.cleanup();
  }

  const system = await makeHarness({
    canRunCommand: async (command) => command === '/usr/local/bin/agy',
    runCommandCapture: async () => ({ code: 0, stdout: '/usr/local/bin/agy\n', stderr: '' }),
  });
  try {
    assert.deepEqual(await system.controller.resolveAntigravityCli(), { path: '/usr/local/bin/agy', source: 'system' });
  } finally {
    await system.cleanup();
  }

  let emptyVersion = false;
  const logFs = Object.assign(Object.create(fs), {
    stat: async (target) => {
      if (String(target).endsWith('cli-missing.log')) throw new Error('log disappeared');
      return await fs.stat(target);
    },
  });
  const noPattern = await makeHarness({
    fs: logFs,
    canRunCommand: async (command) => command.endsWith('agy'),
    runCommandCapture: async (_command, args) => args[0] === '--version'
      ? { code: 0, stdout: '', stderr: emptyVersion ? '' : 'Antigravity stderr version' }
      : { code: 1, stdout: '', stderr: '' },
  });
  try {
    await installAntigravityFixture(noPattern.root);
    const logDir = path.join(noPattern.root, '.gemini', 'antigravity-cli', 'log');
    await fs.mkdir(logDir, { recursive: true });
    await fs.writeFile(path.join(logDir, 'cli-no-auth.log'), 'ordinary diagnostic');
    await fs.writeFile(path.join(logDir, 'cli-missing.log'), 'disappeared');
    const status = await noPattern.controller.getAntigravityAuthStatus();
    assert.equal(status.authenticated, false);
    assert.equal(status.version, 'Antigravity stderr version');
    emptyVersion = true;
    assert.equal((await noPattern.controller.getAntigravityAuthStatus()).version, undefined);
  } finally {
    await noPattern.cleanup();
  }
});

test('given a freshly installed embedded Antigravity CLI, session source and missing pid fallbacks are stable', async () => {
  let child;
  const harness = await makeHarness({
    canRunCommand: async (command) => command.endsWith('agy'),
    runCommand: async (command, args) => {
      if (command === 'curl') await fs.writeFile(args[args.indexOf('-o') + 1], 'installer');
      if (command === 'bash') {
        const binDir = args[args.indexOf('--dir') + 1];
        await fs.mkdir(binDir, { recursive: true });
        await fs.writeFile(path.join(binDir, 'agy'), '');
      }
    },
    spawn: () => {
      child = new FakeChildProcess();
      child.pid = undefined;
      return child;
    },
  });
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  globalThis.setTimeout = () => 1;
  globalThis.clearTimeout = () => undefined;
  try {
    const events = [];
    const result = await withPlatform('darwin', () => harness.controller.startAntigravityAuthSession((event) => events.push(event)));
    assert.equal(result.success, true);
    assert.equal(result.status.source, 'managed');
    assert.match(events[0].text, /pid=unknown/);
    await harness.controller.cancelAntigravityAuthSession(result.sessionId);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
    await harness.cleanup();
  }
});

test('given active sessions, disconnect terminates children and direct status fallback remains useful', async () => {
  const active = await startSessionHarness();
  try {
    const result = await active.controller.disconnectAntigravityAuth();
    assert.equal(result.success, true);
    assert.equal(active.child.killed, true);
  } finally {
    active.restoreTimers();
    await active.cleanup();
  }

  const fallback = await makeHarness({
    canRunCommand: async (command) => command.endsWith('agy'),
    appendInstallLog: async (event, payload = {}) => {
      fallback.calls.push(['log', event, payload]);
      if (event === 'antigravity_auth:oauth_success_log_checked') throw new Error('status unavailable');
    },
    runCommand: async () => undefined,
    runCommandCapture: async (_command, args) => args[0] === '--version'
      ? { code: 0, stdout: '1.0.0', stderr: '' }
      : { code: 1, stdout: '', stderr: '' },
  });
  try {
    await installAntigravityFixture(fallback.root);
    const result = await withPlatform('freebsd', () => fallback.controller.connectAntigravityAuth());
    assert.equal(result.success, true);
    assert.equal(result.status.installed, true);
    assert.equal(result.status.authenticated, false);
  } finally {
    await fallback.cleanup();
  }
});
