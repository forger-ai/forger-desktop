/* eslint-disable max-lines */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createAgentAuthController } = require('../../dist-electron/main/runtime/agent-auth.js');
const { createCommandGitController } = require('../../dist-electron/main/runtime/command-git.js');
const { createRuntimeInstallController } = require('../../dist-electron/main/runtime/runtime-install.js');
const { createInstalledAppRuntimeController } = require('../../dist-electron/main/runtime/installed-app-runtime.js');

const tmpRoot = async (name) => await fs.mkdtemp(path.join(os.tmpdir(), `forger-${name}-`));
const pythonDarwinReadyMetadata = (archiveSha256 = 'python-archive-sha') => JSON.stringify({
  installedAt: '2026-06-02T00:00:00.000Z',
  desktopVersion: '0.0.0-test',
  runtimeRevision: 'python-darwin-disable-library-validation-2026-06-02',
  archiveSha256,
});

const waitForCondition = async (predicate, timeoutMs = 10_000) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(predicate(), true);
};

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
  for (const key of Object.keys(patch)) {
    previous[key] = process.env[key];
    if (patch[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = patch[key];
    }
  }
  try {
    return await operation();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
};

class FakeChildProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killed = false;
  pid = Math.floor(Math.random() * 10000) + 1000;

  kill(signal) {
    this.killed = true;
    this.signal = signal;
    queueMicrotask(() => this.emit('exit', null, signal));
    return true;
  }
}

const makeAgentAuthHarness = async (overrides = {}) => {
  const root = await tmpRoot('agent-auth');
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
    buildMacTerminalLoginScript: () => '',
    buildMacTerminalScriptLaunchCommand: (scriptPath) => `/bin/bash ${scriptPath}`,
    canRunCommand: async () => false,
    classifyCodexAuthOutput: (_stdout, stderr) => stderr.includes('expired') ? 'codex_auth_expired' : undefined,
    ensureRuntimeInstalled: async (type) => {
      calls.push(['runtime', type]);
      return type === 'node'
        ? { node: path.join(root, 'node'), npm: path.join(root, 'npm') }
        : { python: path.join(root, 'python') };
    },
    extractAllowedCodexAuthUrls: () => [],
    failureDiagnostic: (error, fallbackCode) => ({ technicalCode: error instanceof Error ? error.message : fallbackCode }),
    findExistingFile: async (baseDir, candidates) => {
      for (const candidate of candidates) {
        const attempt = path.join(baseDir, candidate);
        if ((await fs.stat(attempt).catch(() => null))?.isFile()) {
          return attempt;
        }
      }
      return null;
    },
    findManifestService: () => null,
    fs,
    getClaudeRoot: () => path.join(root, 'claude-root'),
    getCodexHome: () => path.join(root, 'codex-home'),
    getCodexRoot: () => path.join(root, 'codex-root'),
    getForgerMetadataRoot: () => path.join(root, 'metadata'),
    getLogsRoot: () => path.join(root, 'logs'),
    getTempRoot: () => path.join(root, 'tmp'),
    markProviderConnected: async (provider) => calls.push(['connected', provider]),
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
  return { root, calls, controller: createAgentAuthController(deps), deps };
};

test('agent auth status reports installed authenticated Codex and marks provider connected without credentials', async (t) => {
  const { root, calls, controller } = await makeAgentAuthHarness();
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  await fs.mkdir(path.join(root, 'codex-root', 'node_modules', '.bin'), { recursive: true });
  await fs.mkdir(path.join(root, 'codex-home'), { recursive: true });
  await fs.writeFile(path.join(root, 'codex-root', 'node_modules', '.bin', 'codex'), '', 'utf8');
  await fs.writeFile(path.join(root, 'codex-home', 'auth.json'), '{}', 'utf8');

  const status = await controller.getCodexAuthStatus();

  assert.equal(status.installed, true);
  assert.equal(status.authenticated, true);
  assert.equal(status.authFilePath, path.join(root, 'codex-home', 'auth.json'));
  assert.ok(calls.some((call) => call[0] === 'capture' && call[2].join(' ') === 'login status'));
  assert.ok(calls.some((call) => call[0] === 'connected' && call[1] === 'codex'));
});

test('agent auth handles missing Codex CLI and disconnect removes only the managed auth file', async (t) => {
  const { root, calls, controller } = await makeAgentAuthHarness();
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  await fs.mkdir(path.join(root, 'codex-home'), { recursive: true });
  await fs.writeFile(path.join(root, 'codex-home', 'auth.json'), '{}', 'utf8');

  const status = await controller.getCodexAuthStatus();
  const disconnect = await controller.disconnectCodexAuth();

  assert.equal(status.installed, false);
  assert.equal(status.authenticated, false);
  assert.equal(disconnect.success, true);
  assert.equal(await fs.stat(path.join(root, 'codex-home', 'auth.json')).catch(() => null), null);
  assert.equal(calls.some((call) => call[0] === 'capture'), false);
});

test('agent auth surfaces managed Claude status and does not mark disconnected sessions connected', async (t) => {
  const { root, calls, controller } = await makeAgentAuthHarness({
    canRunCommand: async (command) => command.endsWith('claude'),
    runCommandCapture: async (_command, args) => {
      if (args[0] === '--version') {
        return { code: 0, stdout: '1.2.3\n', stderr: '' };
      }
      return { code: 0, stdout: 'not authenticated\n', stderr: '' };
    },
  });
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  await fs.mkdir(path.join(root, 'claude-root', 'node_modules', '.bin'), { recursive: true });
  await fs.writeFile(path.join(root, 'claude-root', 'node_modules', '.bin', 'claude'), '', 'utf8');

  const status = await controller.getClaudeAuthStatus();

  assert.equal(status.installed, true);
  assert.equal(status.authenticated, false);
  assert.equal(status.source, 'managed');
  assert.equal(status.version, '1.2.3');
  assert.equal(calls.some((call) => call[0] === 'connected' && call[1] === 'claude'), false);
});

test('agent auth builds app-scoped Codex tool caches and manifest backend environment', async (t) => {
  const { root, controller, deps } = await makeAgentAuthHarness({
    findManifestService: (manifest, name) => manifest?.services?.find((service) => service.name === name) ?? null,
    resolveInstalledManifest: async () => ({
      services: [{
        name: 'backend',
        environment: {
          DATABASE_URL: 'sqlite:////app/data/app.sqlite3',
          CUSTOM_PATH: '{backend}/custom',
        },
      }],
    }),
    translateManifestEnvironment: (environment, backendDir) => Object.fromEntries(
      Object.entries(environment).map(([key, value]) => [key, value.replace('{backend}', backendDir)]),
    ),
  });
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  deps.registry.apps['demo app!*'] = { installDir: path.join(root, 'installed', 'demo') };

  const env = await controller.getCodexToolEnvironment('demo app!*', { python: path.join(root, 'python') });

  const cacheRoot = path.join(root, 'metadata', 'tool-cache', 'demo_app__');
  assert.equal(env.UV_CACHE_DIR, path.join(cacheRoot, 'uv'));
  assert.equal(env.PIP_CACHE_DIR, path.join(cacheRoot, 'pip'));
  assert.equal(env.NPM_CONFIG_CACHE, path.join(cacheRoot, 'npm'));
  assert.equal(env.UV_PYTHON, path.join(root, 'python'));
  assert.equal(env.UV_PROJECT_ENVIRONMENT, path.join(root, 'installed', 'demo', 'backend', '.venv'));
  assert.equal(env.CUSTOM_PATH, path.join(root, 'installed', 'demo', 'backend', 'custom'));
  assert.equal((await fs.stat(env.UV_CACHE_DIR)).isDirectory(), true);
});

test('agent auth covers unmanaged status fallbacks and non-Windows local tool paths', async (t) => {
  const localTools = await makeAgentAuthHarness();
  t.after(async () => {
    await fs.rm(localTools.root, { recursive: true, force: true });
  });
  const installDir = path.join(localTools.root, 'installed-app');
  await fs.mkdir(path.join(installDir, 'backend', '.venv', 'bin'), { recursive: true });
  const entries = await withPlatform('darwin', async () => (
    await localTools.controller.getAppLocalToolPathEntries({ installDir })
  ));
  assert.deepEqual(entries, [path.join(installDir, 'backend', '.venv', 'bin')]);

  const codex = await makeAgentAuthHarness({
    classifyCodexAuthOutput: () => 'codex_auth_expired',
    runCommandCapture: async () => ({ code: 1, stdout: 'Not logged in', stderr: 'expired' }),
  });
  t.after(async () => {
    await fs.rm(codex.root, { recursive: true, force: true });
  });
  await fs.mkdir(path.join(codex.root, 'codex-root', 'node_modules', '.bin'), { recursive: true });
  await fs.writeFile(path.join(codex.root, 'codex-root', 'node_modules', '.bin', 'codex'), '', 'utf8');

  const codexStatus = await codex.controller.getCodexAuthStatus();

  assert.equal(codexStatus.installed, true);
  assert.equal(codexStatus.authenticated, false);
  assert.equal(
    codex.calls.some((call) => call[0] === 'log' && call[1] === 'codex_auth:status_checked' && call[2].technicalCode === 'codex_auth_expired'),
    true,
  );
  assert.equal(codex.calls.some((call) => call[0] === 'connected' && call[1] === 'codex'), false);

  const emptyWhich = await makeAgentAuthHarness({
    runCommandCapture: async () => ({ code: 0, stdout: '\n  \n', stderr: '' }),
  });
  t.after(async () => {
    await fs.rm(emptyWhich.root, { recursive: true, force: true });
  });
  assert.equal((await emptyWhich.controller.getClaudeAuthStatus()).source, 'missing');

  const failedWhich = await makeAgentAuthHarness({
    runCommandCapture: async () => {
      throw new Error('which_failed');
    },
  });
  t.after(async () => {
    await fs.rm(failedWhich.root, { recursive: true, force: true });
  });
  assert.equal((await failedWhich.controller.getClaudeAuthStatus()).source, 'missing');
});

test('agent auth launches macOS Codex login directly and opens only unique auth URLs', async (t) => {
  const spawned = [];
  const { root, calls, controller } = await makeAgentAuthHarness({
    extractAllowedCodexAuthUrls: (text) => text.includes('auth.openai.com') ? ['https://auth.openai.com/oauth/authorize?state=1'] : [],
    spawn: (command, args, options) => {
      const child = new FakeChildProcess();
      spawned.push([command, args, options]);
      queueMicrotask(() => {
        child.stdout.emit('data', Buffer.from('open https://auth.openai.com/oauth/authorize?state=1\n'));
        child.stderr.emit('data', Buffer.from('again https://auth.openai.com/oauth/authorize?state=1\n'));
        child.emit('exit', 0, null);
      });
      return child;
    },
  });
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  await fs.mkdir(path.join(root, 'codex-root', 'node_modules', '.bin'), { recursive: true });
  await fs.mkdir(path.join(root, 'codex-root', 'node_modules', '@openai', 'codex'), { recursive: true });
  await fs.writeFile(path.join(root, 'codex-root', 'node_modules', '.bin', 'codex'), '', 'utf8');
  await fs.writeFile(
    path.join(root, 'codex-root', 'node_modules', '@openai', 'codex', 'package.json'),
    JSON.stringify({ version: '0.99.0' }),
    'utf8',
  );

  const result = await withPlatform('darwin', async () => await controller.connectCodexAuth());
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(result.success, true);
  assert.equal(spawned.length, 1);
  assert.deepEqual(spawned[0][1], ['login']);
  assert.equal(spawned[0][2].shell, false);
  assert.equal(calls.filter((call) => call[0] === 'openExternal').length, 1);
  assert.equal(calls.some((call) => call[0] === 'log' && call[1] === 'codex_auth:login_process_exit'), true);
});

test('agent auth records browser-open failures from macOS Codex login output', async (t) => {
  const { root, controller } = await makeAgentAuthHarness({
    extractAllowedCodexAuthUrls: (text) => text.includes('auth.openai.com')
      ? ['https://auth.openai.com/oauth/authorize?state=blocked']
      : [],
    serializeErrorForInstallLog: () => ({ message: 123 }),
    shell: {
      openExternal: async () => {
        throw new Error('browser_blocked');
      },
    },
    spawn: () => {
      const child = new FakeChildProcess();
      queueMicrotask(() => {
        child.stdout.emit('data', Buffer.from('open https://auth.openai.com/oauth/authorize?state=blocked\n'));
      });
      return child;
    },
  });
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  await fs.mkdir(path.join(root, 'codex-root', 'node_modules', '.bin'), { recursive: true });
  await fs.mkdir(path.join(root, 'codex-root', 'node_modules', '@openai', 'codex'), { recursive: true });
  await fs.writeFile(path.join(root, 'codex-root', 'node_modules', '.bin', 'codex'), '', 'utf8');
  await fs.writeFile(
    path.join(root, 'codex-root', 'node_modules', '@openai', 'codex', 'package.json'),
    JSON.stringify({ version: '0.99.0' }),
    'utf8',
  );

  const result = await withPlatform('darwin', async () => await controller.connectCodexAuth());
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const log = await fs.readFile(path.join(root, 'logs', 'codex-login.log'), 'utf8').catch(() => '');
    if (log.includes('open_external_error') && log.includes('browser_blocked')) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const log = await fs.readFile(path.join(root, 'logs', 'codex-login.log'), 'utf8');

  assert.equal(result.success, true);
  assert.match(log, /open_external_error/);
  assert.match(log, /browser_blocked/);
});

test('agent auth records late macOS Codex spawn errors after launch resolution', async (t) => {
  const { root, controller } = await makeAgentAuthHarness({
    spawn: () => {
      const child = new FakeChildProcess();
      setTimeout(() => child.emit('error', new Error('late_spawn_error')), 5);
      return child;
    },
  });
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  await fs.mkdir(path.join(root, 'codex-root', 'node_modules', '.bin'), { recursive: true });
  await fs.mkdir(path.join(root, 'codex-root', 'node_modules', '@openai', 'codex'), { recursive: true });
  await fs.writeFile(path.join(root, 'codex-root', 'node_modules', '.bin', 'codex'), '', 'utf8');
  await fs.writeFile(
    path.join(root, 'codex-root', 'node_modules', '@openai', 'codex', 'package.json'),
    JSON.stringify({ version: '0.99.0' }),
    'utf8',
  );

  const result = await withPlatform('darwin', async () => await controller.connectCodexAuth());
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const log = await fs.readFile(path.join(root, 'logs', 'codex-login.log'), 'utf8').catch(() => '');
    if (log.includes('late_spawn_error')) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const log = await fs.readFile(path.join(root, 'logs', 'codex-login.log'), 'utf8');

  assert.equal(result.success, true);
  assert.match(log, /late_spawn_error/);
});

test('agent auth reinstalls Codex and reports fallback status when reinstall fails', async (t) => {
  const success = await makeAgentAuthHarness({
    runCommand: async (command, args, options) => {
      await fs.mkdir(path.join(options.cwd, 'node_modules', '.bin'), { recursive: true });
      await fs.mkdir(path.join(options.cwd, 'node_modules', '@openai', 'codex'), { recursive: true });
      await fs.writeFile(path.join(options.cwd, 'node_modules', '.bin', 'codex'), '', 'utf8');
      await fs.writeFile(
        path.join(options.cwd, 'node_modules', '@openai', 'codex', 'package.json'),
        JSON.stringify({ version: '0.99.0' }),
        'utf8',
      );
    },
  });
  t.after(async () => {
    await fs.rm(success.root, { recursive: true, force: true });
  });
  await fs.mkdir(path.join(success.root, 'codex-root', 'old'), { recursive: true });
  await fs.writeFile(path.join(success.root, 'codex-home', 'auth.json'), '{}', 'utf8').catch(async () => {
    await fs.mkdir(path.join(success.root, 'codex-home'), { recursive: true });
    await fs.writeFile(path.join(success.root, 'codex-home', 'auth.json'), '{}', 'utf8');
  });

  const reinstalled = await success.controller.reinstallCodex();

  assert.equal(reinstalled.success, true);
  assert.equal(reinstalled.status.installed, true);
  assert.equal(await fs.stat(path.join(success.root, 'codex-root', 'old')).catch(() => null), null);

  const failure = await makeAgentAuthHarness({
    runCommand: async () => {
      throw new Error('npm_failed');
    },
  });
  t.after(async () => {
    await fs.rm(failure.root, { recursive: true, force: true });
  });

  const failed = await failure.controller.reinstallCodex();

  assert.equal(failed.success, false);
  assert.equal(failed.technicalCode, 'npm_failed');
  assert.equal(failed.status.installed, false);
  assert.equal(failure.calls.some((call) => call[0] === 'log' && call[1] === 'codex_auth:reinstall_failed'), true);
});

test('agent auth installs Claude CLI when npm is available and rejects runtimes without npm', async (t) => {
  const installed = await makeAgentAuthHarness({
    canRunCommand: async (command) => command.endsWith('claude'),
    runCommand: async (command, args, options) => {
      await fs.mkdir(path.join(options.cwd, 'node_modules', '.bin'), { recursive: true });
      await fs.writeFile(path.join(options.cwd, 'node_modules', '.bin', 'claude'), '', 'utf8');
    },
    runCommandCapture: async (_command, args) => args[0] === '--version'
      ? { code: 0, stdout: '1.0.0\n', stderr: '' }
      : { code: 0, stdout: 'authenticated\n', stderr: '' },
  });
  t.after(async () => {
    await fs.rm(installed.root, { recursive: true, force: true });
  });

  const result = await installed.controller.reinstallClaude();

  assert.equal(result.success, true);
  assert.equal(result.status.installed, true);
  assert.equal(result.status.authenticated, true);
  assert.equal(installed.calls.some((call) => call[0] === 'connected' && call[1] === 'claude'), true);

  const missingNpm = await makeAgentAuthHarness({
    ensureRuntimeInstalled: async () => ({ node: path.join(os.tmpdir(), 'node-without-npm') }),
  });
  t.after(async () => {
    await fs.rm(missingNpm.root, { recursive: true, force: true });
  });

  const failed = await missingNpm.controller.reinstallClaude();

  assert.equal(failed.success, false);
  assert.equal(failed.technicalCode, 'runtime_npm_executable_not_found');
  assert.equal(missingNpm.calls.some((call) => call[0] === 'log' && call[1] === 'claude_auth:reinstall_failed'), true);
});

test('agent auth connects system Claude through Terminal and records authenticated status', async (t) => {
  const { root, calls, controller } = await makeAgentAuthHarness({
    buildMacTerminalLoginScript: ({ providerName, logPath, command }) => `${providerName}\n${logPath}\n${command.join(' ')}`,
    buildMacTerminalScriptLaunchCommand: (scriptPath) => `/bin/bash ${scriptPath}`,
    canRunCommand: async (command, args) => command === '/usr/local/bin/claude' && args[0] === '--version',
    runCommand: async (command, args, options) => calls.push(['run', command, args, options]),
    runCommandCapture: async (command, args) => {
      calls.push(['capture', command, args]);
      if (command === 'which') {
        return { code: 0, stdout: '/usr/local/bin/claude\n', stderr: '' };
      }
      if (args[0] === '--version') {
        return { code: 0, stdout: '2.0.0\n', stderr: '' };
      }
      return { code: 0, stdout: 'authenticated\n', stderr: '' };
    },
  });
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const result = await withPlatform('darwin', async () => await controller.connectClaudeAuth());

  assert.equal(result.success, true);
  assert.equal(result.status?.source, 'system');
  assert.equal(result.status?.authenticated, true);
  assert.equal(result.status?.version, '2.0.0');
  assert.ok(calls.some((call) => call[0] === 'run' && call[1] === '/usr/bin/osascript'));
  assert.ok(calls.some((call) => call[0] === 'log' && call[1] === 'claude_auth:terminal_opened'));
  assert.ok(calls.some((call) => call[0] === 'connected' && call[1] === 'claude'));
});

test('agent auth reports Claude connect failures with missing status fallback', async (t) => {
  const { root, calls, controller } = await makeAgentAuthHarness({
    canRunCommand: async () => false,
    runCommand: async () => {
      throw new Error('npm_install_failed');
    },
    runCommandCapture: async (command, args) => {
      calls.push(['capture', command, args]);
      if (command === 'which') {
        return { code: 1, stdout: '', stderr: 'missing' };
      }
      return { code: 1, stdout: '', stderr: '' };
    },
  });
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const result = await controller.connectClaudeAuth();

  assert.equal(result.success, false);
  assert.equal(result.technicalCode, 'npm_install_failed');
  assert.equal(result.status?.installed, false);
  assert.equal(result.status?.source, 'missing');
  assert.ok(calls.some((call) => call[0] === 'log' && call[1] === 'claude_auth:failed'));
});

test('agent auth runs direct provider login on non-macOS platforms', async (t) => {
  const codex = await makeAgentAuthHarness({
    runCommand: async (command, args, options) => codex.calls.push(['run', command, args, options]),
  });
  t.after(async () => {
    await fs.rm(codex.root, { recursive: true, force: true });
  });
  await fs.mkdir(path.join(codex.root, 'codex-root', 'node_modules', '.bin'), { recursive: true });
  await fs.mkdir(path.join(codex.root, 'codex-root', 'node_modules', '@openai', 'codex'), { recursive: true });
  await fs.writeFile(path.join(codex.root, 'codex-root', 'node_modules', '.bin', 'codex'), '', 'utf8');
  await fs.writeFile(
    path.join(codex.root, 'codex-root', 'node_modules', '@openai', 'codex', 'package.json'),
    JSON.stringify({ version: '0.99.0' }),
    'utf8',
  );

  const codexResult = await withPlatform('linux', async () => await codex.controller.connectCodexAuth());

  assert.equal(codexResult.success, true);
  assert.ok(codex.calls.some((call) => call[0] === 'run' && call[2].join(' ') === 'login'));

  const claude = await makeAgentAuthHarness({
    canRunCommand: async (command, args) => command.endsWith('claude') && args[0] === '--version',
    runCommand: async (command, args, options) => claude.calls.push(['run', command, args, options]),
    runCommandCapture: async (_command, args) => {
      if (args[0] === '--version') {
        return { code: 0, stdout: '3.0.0\n', stderr: '' };
      }
      return { code: 0, stdout: 'authenticated\n', stderr: '' };
    },
  });
  t.after(async () => {
    await fs.rm(claude.root, { recursive: true, force: true });
  });
  await fs.mkdir(path.join(claude.root, 'claude-root', 'node_modules', '.bin'), { recursive: true });
  await fs.writeFile(path.join(claude.root, 'claude-root', 'node_modules', '.bin', 'claude'), '', 'utf8');

  const claudeResult = await withPlatform('linux', async () => await claude.controller.connectClaudeAuth());

  assert.equal(claudeResult.success, true);
  assert.equal(claudeResult.status?.authenticated, true);
  assert.ok(claude.calls.some((call) => call[0] === 'run' && call[2].join(' ') === 'auth login'));
});

test('agent auth resolves platform-specific local tools and Codex install edge cases', async (t) => {
  const { root, calls, controller } = await makeAgentAuthHarness({
    runCommand: async () => undefined,
  });
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  const installDir = path.join(root, 'installed-app');
  await fs.mkdir(path.join(installDir, 'backend', '.venv', 'Scripts'), { recursive: true });
  await fs.mkdir(path.join(installDir, 'frontend', 'node_modules', '.bin'), { recursive: true });
  const windowsEntries = await withPlatform('win32', async () => (
    await controller.getAppLocalToolPathEntries({ installDir })
  ));

  assert.deepEqual(windowsEntries, [
    path.join(installDir, 'backend', '.venv', 'Scripts'),
    path.join(installDir, 'frontend', 'node_modules', '.bin'),
  ]);

  await fs.mkdir(path.join(root, 'codex-root', 'node_modules', '.bin'), { recursive: true });
  await fs.mkdir(path.join(root, 'codex-root', 'node_modules', '@openai', 'codex'), { recursive: true });
  await fs.writeFile(path.join(root, 'codex-root', 'node_modules', '.bin', 'codex.cmd'), '', 'utf8');
  await fs.writeFile(
    path.join(root, 'codex-root', 'node_modules', '@openai', 'codex', 'package.json'),
    JSON.stringify({ version: '0.1.0' }),
    'utf8',
  );

  assert.equal(
    await withPlatform('win32', async () => await controller.resolveCodexCliPath(path.join(root, 'codex-root'))),
    path.join(root, 'codex-root', 'node_modules', '.bin', 'codex.cmd'),
  );
  assert.equal(await controller.ensureCodexCliInstalled(), path.join(root, 'codex-root', 'node_modules', '.bin', 'codex.cmd'));
  assert.ok(calls.some((call) => call[0] === 'log' && call[1] === 'codex_auth:version_mismatch'));

  const failed = await makeAgentAuthHarness({
    runCommand: async () => undefined,
  });
  t.after(async () => {
    await fs.rm(failed.root, { recursive: true, force: true });
  });
  await assert.rejects(failed.controller.ensureCodexCliInstalled(), /codex_cli_install_failed/);
  assert.equal(await failed.controller.getInstalledCodexCliVersion(failed.root), null);
});

test('agent auth reuses existing provider package roots during install fallbacks', async (t) => {
  const codex = await makeAgentAuthHarness({
    runCommand: async (command, args, options) => {
      codex.calls.push(['run', command, args, options]);
      await fs.mkdir(path.join(options.cwd, 'node_modules', '.bin'), { recursive: true });
      await fs.mkdir(path.join(options.cwd, 'node_modules', '@openai', 'codex'), { recursive: true });
      await fs.writeFile(path.join(options.cwd, 'node_modules', '.bin', 'codex'), '', 'utf8');
      await fs.writeFile(
        path.join(options.cwd, 'node_modules', '@openai', 'codex', 'package.json'),
        JSON.stringify({ version: '0.99.0' }),
        'utf8',
      );
    },
  });
  t.after(async () => {
    await fs.rm(codex.root, { recursive: true, force: true });
  });
  await fs.mkdir(path.join(codex.root, 'codex-root'), { recursive: true });
  await fs.writeFile(path.join(codex.root, 'codex-root', 'package.json'), '{"private":true}', 'utf8');

  const codexPath = await codex.controller.ensureCodexCliInstalled();

  assert.equal(codexPath, path.join(codex.root, 'codex-root', 'node_modules', '.bin', 'codex'));
  assert.equal(codex.calls.some((call) => call[0] === 'run'), true);

  const claude = await makeAgentAuthHarness({
    canRunCommand: async (command) => command.endsWith('claude'),
  });
  t.after(async () => {
    await fs.rm(claude.root, { recursive: true, force: true });
  });
  await fs.mkdir(path.join(claude.root, 'claude-root', 'node_modules', '.bin'), { recursive: true });
  await fs.writeFile(path.join(claude.root, 'claude-root', 'node_modules', '.bin', 'claude'), '', 'utf8');

  const result = await withPlatform('linux', async () => await claude.controller.connectClaudeAuth());

  assert.equal(result.success, true);
  assert.equal(result.status?.installed, true);
  assert.equal(claude.calls.some((call) => call[0] === 'run' && call[2].join(' ') === 'auth login'), true);

  let canRunCalls = 0;
  const deferredExisting = await makeAgentAuthHarness({
    canRunCommand: async (command) => {
      canRunCalls += 1;
      return command.endsWith('claude') && canRunCalls > 1;
    },
    runCommand: async (command, args, options) => deferredExisting.calls.push(['run', command, args, options]),
  });
  t.after(async () => {
    await fs.rm(deferredExisting.root, { recursive: true, force: true });
  });
  await fs.mkdir(path.join(deferredExisting.root, 'claude-root', 'node_modules', '.bin'), { recursive: true });
  await fs.mkdir(path.join(deferredExisting.root, 'claude-root', 'node_modules', '@anthropic-ai', 'claude-code'), { recursive: true });
  await fs.writeFile(path.join(deferredExisting.root, 'claude-root', 'node_modules', '.bin', 'claude'), '', 'utf8');
  await fs.writeFile(
    path.join(deferredExisting.root, 'claude-root', 'node_modules', '@anthropic-ai', 'claude-code', 'package.json'),
    JSON.stringify({ version: '1.0.0' }),
    'utf8',
  );

  const deferredResult = await withPlatform('linux', async () => await deferredExisting.controller.connectClaudeAuth());

  assert.equal(deferredResult.success, true);
  assert.equal(deferredExisting.calls.some((call) => call[0] === 'runtime'), false);

  const existingPackage = await makeAgentAuthHarness({
    canRunCommand: async (command) => Boolean(await fs.stat(command).catch(() => null)),
    runCommand: async (_command, _args, options) => {
      await fs.mkdir(path.join(options.cwd, 'node_modules', '.bin'), { recursive: true });
      await fs.writeFile(path.join(options.cwd, 'node_modules', '.bin', 'claude'), '', 'utf8');
    },
  });
  t.after(async () => {
    await fs.rm(existingPackage.root, { recursive: true, force: true });
  });
  await fs.mkdir(path.join(existingPackage.root, 'claude-root'), { recursive: true });
  await fs.writeFile(path.join(existingPackage.root, 'claude-root', 'package.json'), '{"private":true}', 'utf8');

  const existingPackageResult = await withPlatform('linux', async () => await existingPackage.controller.connectClaudeAuth());

  assert.equal(existingPackageResult.success, true);
  assert.equal(existingPackage.calls.some((call) => call[0] === 'runtime' && call[1] === 'node'), true);
});

test('agent auth records failed Codex status checks and disconnect diagnostics', async (t) => {
  const { root, calls, controller } = await makeAgentAuthHarness({
    runCommandCapture: async () => {
      throw new Error('status_crashed');
    },
  });
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  await fs.mkdir(path.join(root, 'codex-root', 'node_modules', '.bin'), { recursive: true });
  await fs.writeFile(path.join(root, 'codex-root', 'node_modules', '.bin', 'codex'), '', 'utf8');
  await fs.mkdir(path.join(root, 'codex-home'), { recursive: true });
  await fs.writeFile(path.join(root, 'codex-home', 'auth.json'), '{}', 'utf8');

  const status = await controller.getCodexAuthStatus();

  assert.equal(status.installed, true);
  assert.equal(status.authenticated, false);
  assert.ok(calls.some((call) => call[0] === 'log' && call[1] === 'codex_auth:status_failed'));

  const disconnect = await makeAgentAuthHarness({
    fs: {
      ...fs,
      rm: async () => {
        throw new Error('rm_denied');
      },
    },
  });
  t.after(async () => {
    await fs.rm(disconnect.root, { recursive: true, force: true });
  });

  const result = await disconnect.controller.disconnectCodexAuth();

  assert.equal(result.success, false);
  assert.equal(result.technicalCode, 'rm_denied');
});

test('agent auth launches Windows provider consoles without real auth', async (t) => {
  const codexSpawns = [];
  const codex = await makeAgentAuthHarness({
    spawn: (command, args, options) => {
      const child = new FakeChildProcess();
      codexSpawns.push([command, args, options]);
      queueMicrotask(() => child.emit('exit', 0, null));
      return child;
    },
  });
  t.after(async () => {
    await fs.rm(codex.root, { recursive: true, force: true });
  });
  await fs.mkdir(path.join(codex.root, 'codex-root', 'node_modules', '.bin'), { recursive: true });
  await fs.mkdir(path.join(codex.root, 'codex-root', 'node_modules', '@openai', 'codex'), { recursive: true });
  await fs.writeFile(path.join(codex.root, 'codex-root', 'node_modules', '.bin', 'codex.cmd'), '', 'utf8');
  await fs.writeFile(
    path.join(codex.root, 'codex-root', 'node_modules', '@openai', 'codex', 'package.json'),
    JSON.stringify({ version: '0.99.0' }),
    'utf8',
  );

  const codexResult = await withPlatform('win32', async () => await codex.controller.connectCodexAuth());

  assert.equal(codexResult.success, true);
  assert.equal(codexSpawns[0][0], 'powershell.exe');
  assert.equal(codexSpawns[0][2].windowsHide, true);
  assert.match(await fs.readFile(path.join(codex.root, 'tmp', 'codex-login.cmd'), 'utf8'), /codex\.cmd" login/);
  assert.ok(codex.calls.some((call) => call[0] === 'log' && call[1] === 'codex_auth:terminal_opened'));

  const claudeSpawns = [];
  const claude = await makeAgentAuthHarness({
    canRunCommand: async (command) => command.endsWith('claude.cmd'),
    runCommandCapture: async (_command, args) => args[0] === '--version'
      ? { code: 0, stdout: '1.0.0\n', stderr: '' }
      : { code: 0, stdout: 'authenticated\n', stderr: '' },
    spawn: (command, args, options) => {
      const child = new FakeChildProcess();
      claudeSpawns.push([command, args, options]);
      queueMicrotask(() => child.emit('exit', 0, null));
      return child;
    },
  });
  t.after(async () => {
    await fs.rm(claude.root, { recursive: true, force: true });
  });
  await fs.mkdir(path.join(claude.root, 'claude-root', 'node_modules', '.bin'), { recursive: true });

  const claudeResult = await withPlatform('win32', async () => await claude.controller.connectClaudeAuth());

  assert.equal(claudeResult.success, true);
  assert.equal(claudeResult.status?.authenticated, true);
  assert.equal(claudeSpawns[0][0], 'powershell.exe');
  assert.match(await fs.readFile(path.join(claude.root, 'tmp', 'claude-login.cmd'), 'utf8'), /auth login/);
});

test('agent auth reports provider launch and managed Claude install failures', async (t) => {
  const codex = await makeAgentAuthHarness({
    spawn: () => {
      const child = new FakeChildProcess();
      queueMicrotask(() => child.emit('error', new Error('spawn_failed')));
      return child;
    },
  });
  t.after(async () => {
    await fs.rm(codex.root, { recursive: true, force: true });
  });
  await fs.mkdir(path.join(codex.root, 'codex-root', 'node_modules', '.bin'), { recursive: true });
  await fs.mkdir(path.join(codex.root, 'codex-root', 'node_modules', '@openai', 'codex'), { recursive: true });
  await fs.writeFile(path.join(codex.root, 'codex-root', 'node_modules', '.bin', 'codex'), '', 'utf8');
  await fs.writeFile(
    path.join(codex.root, 'codex-root', 'node_modules', '@openai', 'codex', 'package.json'),
    JSON.stringify({ version: '0.99.0' }),
    'utf8',
  );

  const codexResult = await withPlatform('darwin', async () => await codex.controller.connectCodexAuth());

  assert.equal(codexResult.success, false);
  assert.equal(codexResult.technicalCode, 'spawn_failed');
  assert.ok(codex.calls.some((call) => call[0] === 'log' && call[1] === 'codex_auth:failed'));

  const claude = await makeAgentAuthHarness({
    canRunCommand: async () => false,
    runCommand: async () => undefined,
  });
  t.after(async () => {
    await fs.rm(claude.root, { recursive: true, force: true });
  });

  const result = await claude.controller.reinstallClaude();
  assert.equal(result.success, false);
  assert.equal(result.technicalCode, 'claude_cli_install_failed');
});

const makeCommandGitHarness = (overrides = {}) => {
  const calls = [];
  const root = overrides.root ?? path.join(os.tmpdir(), 'forger-command-git');
  const deps = {
    BUNDLED_GIT_VERSION: '2.50.0',
    appendInstallLog: async (event, payload = {}) => calls.push(['log', event, payload]),
    app: { getPath: () => root },
    createHash,
    findRuntimeArchive: async () => null,
    findRuntimeChecksumFile: async () => null,
    fs,
    getBundledResourcesRoot: () => path.join(root, 'resources'),
    getRuntimesRoot: () => path.join(root, 'runtimes'),
    getTempRoot: () => path.join(root, 'tmp'),
    normalizeVersionForFolder: (value) => value,
    path,
    resolvePlatformAlias: () => 'darwin_arm64',
    runtimePlatformTokens: () => ['darwin_arm64'],
    serializeErrorForInstallLog: (error) => ({ message: error instanceof Error ? error.message : String(error) }),
    spawn: () => {
      throw new Error('spawn not configured');
    },
    stripArchiveExtension: (archiveName) => archiveName.replace(/\.(zip|tar\.gz|tgz)$/i, ''),
    syncDirectory: async () => undefined,
    truncateForInstallLog: (value) => value,
    yauzl: { open: () => undefined },
    ...overrides,
  };
  return { calls, controller: createCommandGitController(deps), deps };
};

test('git command controller captures stdout/stderr, logs command lifecycle, and rejects failed commands', async () => {
  const child = new FakeChildProcess();
  const { calls, controller } = makeCommandGitHarness({
    spawn: (command, args, options) => {
      calls.push(['spawn', command, args, options.cwd, options.shell]);
      queueMicrotask(() => {
        child.stdout.emit('data', Buffer.from('out'));
        child.stderr.emit('data', Buffer.from('err'));
        child.emit('exit', 7, null);
      });
      return child;
    },
  });

  await assert.rejects(
    controller.runCommand('git', ['status'], {
      cwd: '/tmp/app',
      log: { appId: 'demo-app', phase: 'git', label: 'status' },
    }),
    /Command failed: git status/,
  );

  assert.deepEqual(calls[0].slice(0, 4), ['log', 'command:start', {
    appId: 'demo-app',
    phase: 'git',
    label: 'status',
    command: 'git',
    args: ['status'],
    cwd: '/tmp/app',
    shell: false,
  }]);
  assert.equal(calls.some((call) => call[0] === 'log' && call[1] === 'command:exit' && call[2].code === 7), true);
});

test('git command controller wraps Windows cmd shims with quoted paths', async () => {
  const calls = [];
  const { controller } = makeCommandGitHarness({
    appendInstallLog: async (event, payload = {}) => calls.push(['log', event, payload]),
    spawn: (command, args, options) => {
      calls.push(['spawn', command, args, options.cwd, options.shell]);
      const child = new FakeChildProcess();
      queueMicrotask(() => child.emit('exit', 0, null));
      return child;
    },
  });
  const npmCommand = 'C:\\Forger Test\\runtime root\\runtimes\\node\\22\\win32_x64\\npm.cmd';
  await withPlatform('win32', async () => {
    await controller.runCommand(
      npmCommand,
      ['install', '--no-audit', '--no-fund', '@anthropic-ai/claude-code@2.1.158'],
      {
        cwd: 'C:\\Forger Test\\runtime root\\claude-code-cli',
        log: { phase: 'claude_auth', label: 'install claude code cli' },
      },
    );
  });

  const spawnCall = calls.find((call) => call[0] === 'spawn');
  assert.equal(spawnCall[1].toLowerCase().endsWith('cmd.exe'), true);
  assert.deepEqual(spawnCall[2].slice(0, 3), ['/d', '/s', '/c']);
  assert.match(spawnCall[2][3], /^""C:\\Forger Test\\runtime root\\runtimes\\node\\22\\win32_x64\\npm\.cmd" "install"/);
  assert.match(spawnCall[2][3], /"@anthropic-ai\/claude-code@2\.1\.158""$/);
  assert.equal(spawnCall[2][3].includes('\\"'), false);
  assert.equal(spawnCall[4], false);
  assert.equal(calls.some((call) => call[0] === 'log' && call[1] === 'command:start' && call[2].shellStrategy === 'cmd-wrapper'), true);
});

test('git command controller handles spawn errors, captures timeouts, and selects archive commands', async (t) => {
  const root = await tmpRoot('command-git-command-edges');
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  const errorCalls = [];
  const errorHarness = makeCommandGitHarness({
    appendInstallLog: async (event, payload = {}) => errorCalls.push(['log', event, payload]),
    spawn: () => {
      const child = new FakeChildProcess();
      queueMicrotask(() => {
        child.stdout.emit('data', Buffer.from('partial out'));
        child.stderr.emit('data', Buffer.from('partial err'));
        child.emit('error', new Error('spawn_missing'));
      });
      return child;
    },
    truncateForInstallLog: (value) => value.slice(0, 7),
  });

  await assert.rejects(
    errorHarness.controller.runCommand('missing', [], {
      cwd: root,
      log: { phase: 'probe', label: 'missing' },
    }),
    /spawn_missing/,
  );
  assert.ok(errorCalls.some((call) => call[0] === 'log' && call[1] === 'command:error' && call[2].stdout === 'partial'));

  const timeoutHarness = makeCommandGitHarness({
    spawn: () => new FakeChildProcess(),
  });
  await assert.rejects(
    timeoutHarness.controller.runCommandCapture('sleepy', [], { cwd: root, timeoutMs: 1 }),
    /command_timeout/,
  );

  const archiveCalls = [];
  const archiveHarness = makeCommandGitHarness({
    spawn: (command, args, options) => {
      archiveCalls.push([command, args, options.cwd, options.shell]);
      const child = new FakeChildProcess();
      queueMicrotask(() => child.emit('exit', 0, null));
      return child;
    },
  });
  await withPlatform('win32', async () => {
    assert.equal(archiveHarness.controller.requiresWindowsShell('npm.cmd'), true);
    await archiveHarness.controller.zipDirectory(path.join(root, 'src'), path.join(root, 'out.zip'));
  });
  await withPlatform('darwin', async () => {
    await archiveHarness.controller.zipDirectory(path.join(root, 'src'), path.join(root, 'out2.zip'));
  });

  assert.equal(archiveCalls[0][0], 'powershell');
  assert.equal(archiveCalls[0][3], false);
  assert.equal(archiveCalls[1][0], 'zip');
});

test('git command capture rejects spawn errors and direct helpers cover file/path branches', async (t) => {
  const root = await tmpRoot('command-git-helper-edges');
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  const sourceFile = path.join(root, 'source.txt');
  await fs.writeFile(sourceFile, 'abc', 'utf8');
  const nested = path.join(root, 'nested');
  await fs.mkdir(path.join(nested, 'only', 'child'), { recursive: true });
  await fs.writeFile(path.join(nested, 'only', 'child', 'file.txt'), 'value', 'utf8');

  const controller = makeCommandGitHarness({
    spawn: () => {
      const child = new FakeChildProcess();
      queueMicrotask(() => child.emit('error', new Error('capture_spawn_failed')));
      return child;
    },
  }).controller;

  await assert.rejects(controller.runCommandCapture('missing', [], { cwd: root, timeoutMs: 100 }), /capture_spawn_failed/);
  assert.equal(await controller.hashFileSha256(sourceFile), createHash('sha256').update('abc').digest('hex'));
  assert.equal(await controller.existsFile(path.join(root, 'missing.txt')), false);
  assert.equal(await controller.canRunCommand('missing', []), false);
  assert.equal((await fs.stat(path.join(nested, 'only'))).isDirectory(), true);
  assert.equal(controller.normalizeRelativeInstallPath('./'), null);
  assert.equal(controller.normalizeRelativeInstallPath('nested\\path/'), 'nested/path');
});

test('git helpers filter runtime artifacts from user-visible status and preserve rename targets', async () => {
  const { controller } = makeCommandGitHarness({
    spawn: () => {
      const child = new FakeChildProcess();
      queueMicrotask(() => {
        child.stdout.emit('data', Buffer.from([
          ' M frontend/node_modules/pkg/index.js',
          ' M backend/data/app.sqlite3',
          'R  old.txt -> frontend/src/App.tsx',
          '?? docs/notes.md',
        ].join('\n')));
        child.emit('exit', 0, null);
      });
      return child;
    },
  });

  assert.deepEqual(await controller.getUserVisibleGitStatusLines('/tmp/app'), [
    'R  old.txt -> frontend/src/App.tsx',
    '?? docs/notes.md',
  ]);

  const failed = makeCommandGitHarness({
    spawn: () => {
      const child = new FakeChildProcess();
      queueMicrotask(() => {
        child.stderr.emit('data', Buffer.from('status failed'));
        child.emit('exit', 1, null);
      });
      return child;
    },
  });
  await assert.rejects(failed.controller.getGitStatusLines('/tmp/app'), /status failed/);
});

test('git helpers resolve HEAD fallbacks, platform package attempts, and quarantine no-ops', async (t) => {
  const root = await tmpRoot('command-git-fallbacks');
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  const calls = [];
  const fallback = makeCommandGitHarness({
    spawn: (command, args, options) => {
      calls.push([command, args, options.cwd]);
      const child = new FakeChildProcess();
      queueMicrotask(() => {
        const text = args.join(' ');
        if (text === 'rev-list --max-parents=0 HEAD') {
          child.emit('exit', 1, null);
          return;
        }
        if (text === 'rev-parse HEAD') {
          child.stdout.emit('data', Buffer.from('fallback-head\n'));
          child.emit('exit', 0, null);
          return;
        }
        if (text === '--version') {
          child.emit('exit', command === 'git' || command.endsWith('/git') || command.endsWith('\\git.exe') ? 1 : 0, null);
          return;
        }
        child.emit('exit', 0, null);
      });
      return child;
    },
    resolvePlatformAlias: () => 'linux_x64',
  });

  assert.equal(await fallback.controller.getOriginalCommitSha(root), 'fallback-head');
  await withPlatform('linux', async () => {
    await assert.rejects(fallback.controller.ensureGitAvailable(), /git_unavailable/);
  });
  assert.ok(calls.some(([command, args]) => command === 'apt-get' && args[0] === 'update'));
  await withPlatform('linux', async () => await fallback.controller.clearMacQuarantine(root));
  await withPlatform('darwin', async () => await fallback.controller.clearMacQuarantine(path.join(root, 'missing')));
});

test('git controller writes local excludes and initializes repositories with fallback main checkout', async (t) => {
  const root = await tmpRoot('command-git-repo');
  const cwd = path.join(root, 'app');
  const excludePath = path.join(cwd, '.git', 'info', 'exclude');
  const calls = [];
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  await fs.mkdir(path.dirname(excludePath), { recursive: true });
  await fs.writeFile(excludePath, 'existing-rule', 'utf8');
  const { controller } = makeCommandGitHarness({
    root,
    appendInstallLog: async (event, payload = {}) => calls.push(['log', event, payload]),
    spawn: (command, args, options) => {
      calls.push(['spawn', command, args, options.cwd]);
      const child = new FakeChildProcess();
      queueMicrotask(() => {
        const text = args.join(' ');
        if (text === '--version') {
          child.stdout.emit('data', Buffer.from('git version 2.50.0\n'));
          child.emit('exit', 0, null);
        } else if (text === 'rev-parse --git-path info/exclude') {
          child.stdout.emit('data', Buffer.from('.git/info/exclude\n'));
          child.emit('exit', 0, null);
        } else if (text === 'rev-parse HEAD') {
          child.stdout.emit('data', Buffer.from('abc123\n'));
          child.emit('exit', 0, null);
        } else if (text === 'rev-parse --is-inside-work-tree' || text === 'init -b main' || text === 'checkout main') {
          child.stderr.emit('data', Buffer.from('failed\n'));
          child.emit('exit', 1, null);
        } else {
          child.emit('exit', 0, null);
        }
      });
      return child;
    },
  });

  await controller.ensureAppGitRepository(cwd);

  const exclude = await fs.readFile(excludePath, 'utf8');
  assert.match(exclude, /existing-rule\n# Forger runtime artifacts\nbackend\/\.venv\//);
  assert.ok(calls.some((call) => call[0] === 'spawn' && call[2].join(' ') === 'init -b main'));
  assert.ok(calls.some((call) => call[0] === 'spawn' && call[2].join(' ') === 'init'));
  assert.ok(calls.some((call) => call[0] === 'spawn' && call[2].join(' ') === 'checkout -B main'));
  assert.ok(calls.some((call) => call[0] === 'spawn' && call[2].join(' ') === 'commit --allow-empty -m forger: initial state'));
});

test('git archive validation blocks unsafe tar entries and persistent paths ignore traversal', async () => {
  const calls = [];
  const { controller } = makeCommandGitHarness({
    spawn: (command, args, options) => {
      calls.push([command, args, options.cwd]);
      const child = new FakeChildProcess();
      queueMicrotask(() => {
        if (args[0] === '-tzf') {
          child.stdout.emit('data', Buffer.from('app/manifest.json\napp/backend/data/app.sqlite3\n'));
        } else {
          child.stdout.emit('data', Buffer.from('head\n'));
        }
        child.emit('exit', 0, null);
      });
      return child;
    },
  });

  await controller.validateArchiveEntries('/tmp/app.tar.gz');
  assert.deepEqual(calls[0], ['tar', ['-tzf', '/tmp/app.tar.gz'], '/tmp']);
  assert.deepEqual(controller.collectPersistentInstallPaths({
    services: [{
      name: 'backend',
      volumes: [
        { source: './backend/uploads/', persist: true },
        { source: '../outside', persist: true },
        { source: 'backend/cache', persist: false },
      ],
    }],
  }), [
    'backend/.venv',
    'backend/data',
    'backend/uploads',
    'frontend/.vite',
    'frontend/dist',
    'frontend/node_modules',
  ]);

  const unsafe = makeCommandGitHarness({
    spawn: () => {
      const child = new FakeChildProcess();
      queueMicrotask(() => {
        child.stdout.emit('data', Buffer.from('app/.git/config\n../escape\n'));
        child.emit('exit', 0, null);
      });
      return child;
    },
  });
  await assert.rejects(unsafe.controller.validateArchiveEntries('/tmp/app.tgz'), /unsafe_archive_entry_app\/\.git\/config/);
  await assert.rejects(controller.validateArchiveEntries('/tmp/app.rar'), /unsupported_archive_format/);
});

test('git update sync preserves data paths and removes tracked files missing from staged release', async (t) => {
  const root = await tmpRoot('command-git-sync');
  const stageDir = path.join(root, 'stage');
  const installDir = path.join(root, 'installed');
  const calls = [];
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  await fs.mkdir(path.join(stageDir, 'frontend', 'src'), { recursive: true });
  await fs.mkdir(path.join(installDir, 'frontend', 'src'), { recursive: true });
  await fs.mkdir(path.join(installDir, 'backend', 'data'), { recursive: true });
  await fs.writeFile(path.join(stageDir, 'frontend', 'src', 'App.tsx'), 'new', 'utf8');
  await fs.writeFile(path.join(installDir, 'frontend', 'src', 'Old.tsx'), 'old', 'utf8');
  await fs.writeFile(path.join(installDir, 'backend', 'data', 'app.sqlite3'), 'db', 'utf8');
  const { controller } = makeCommandGitHarness({
    spawn: (command, args, options) => {
      calls.push([command, args, options.cwd]);
      const child = new FakeChildProcess();
      queueMicrotask(() => {
        if (args[0] === 'ls-files') {
          child.stdout.emit('data', Buffer.from(
            ['frontend/src/App.tsx', 'frontend/src/Old.tsx', 'backend/data/app.sqlite3'].join('\0'),
          ));
        } else {
          child.stdout.emit('data', Buffer.from('head\n'));
        }
        child.emit('exit', 0, null);
      });
      return child;
    },
  });

  await controller.syncReleaseIntoInstalledApp(stageDir, installDir, ['backend/data']);

  assert.equal(await fs.readFile(path.join(installDir, 'frontend', 'src', 'App.tsx'), 'utf8'), 'new');
  assert.equal(await fs.stat(path.join(installDir, 'frontend', 'src', 'Old.tsx')).catch(() => null), null);
  assert.equal(await fs.readFile(path.join(installDir, 'backend', 'data', 'app.sqlite3'), 'utf8'), 'db');
  assert.deepEqual(calls, [['git', ['ls-files', '-z'], installDir]]);
});

test('git commit helper excludes safe paths and fails when HEAD cannot be resolved', async () => {
  const successCalls = [];
  const success = makeCommandGitHarness({
    spawn: (command, args, options) => {
      successCalls.push([command, args, options.cwd]);
      const child = new FakeChildProcess();
      queueMicrotask(() => {
        if (args.join(' ') === 'rev-parse HEAD') {
          child.stdout.emit('data', Buffer.from('new-head\n'));
        }
        child.emit('exit', 0, null);
      });
      return child;
    },
  });

  const head = await success.controller.gitCommitAllExcept('/tmp/app', 'save version', [
    'backend/data',
    '../escape',
    './frontend/dist/',
  ]);

  assert.equal(head, 'new-head');
  assert.deepEqual(successCalls.map((call) => call[1]), [
    ['add', '-A'],
    ['reset', '--', 'backend/data', 'frontend/dist'],
    ['commit', '--allow-empty', '-m', 'save version'],
    ['rev-parse', 'HEAD'],
  ]);

  const failure = makeCommandGitHarness({
    spawn: (_command, args) => {
      const child = new FakeChildProcess();
      queueMicrotask(() => child.emit('exit', args.join(' ') === 'rev-parse HEAD' ? 1 : 0, null));
      return child;
    },
  });

  await assert.rejects(
    failure.controller.gitCommitAllExcept('/tmp/app', 'save version', []),
    /missing_git_head_after_commit/,
  );
});

test('git release copy rejects staged git metadata and replaces file-directory collisions', async (t) => {
  const root = await tmpRoot('command-git-copy');
  const sourceDir = path.join(root, 'source');
  const targetDir = path.join(root, 'target');
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  await fs.mkdir(path.join(sourceDir, 'frontend'), { recursive: true });
  await fs.mkdir(path.join(targetDir, 'frontend', 'dist'), { recursive: true });
  await fs.writeFile(path.join(sourceDir, 'frontend', 'dist'), 'fresh build', 'utf8');
  await fs.writeFile(path.join(sourceDir, 'frontend', 'keep.txt'), 'fresh source', 'utf8');
  await fs.mkdir(path.join(sourceDir, 'backend', 'data'), { recursive: true });
  await fs.writeFile(path.join(sourceDir, 'backend', 'data', 'app.sqlite3'), 'new db', 'utf8');
  await fs.mkdir(path.join(targetDir, 'backend', 'data'), { recursive: true });
  await fs.writeFile(path.join(targetDir, 'backend', 'data', 'app.sqlite3'), 'existing db', 'utf8');
  const { controller } = makeCommandGitHarness();

  await controller.copyReleaseContentsForUpdate(sourceDir, targetDir, ['backend/data']);

  assert.equal(await fs.readFile(path.join(targetDir, 'frontend', 'dist'), 'utf8'), 'fresh build');
  assert.equal(await fs.readFile(path.join(targetDir, 'frontend', 'keep.txt'), 'utf8'), 'fresh source');
  assert.equal(await fs.readFile(path.join(targetDir, 'backend', 'data', 'app.sqlite3'), 'utf8'), 'existing db');

  await fs.mkdir(path.join(sourceDir, '.git'), { recursive: true });
  await assert.rejects(
    controller.copyReleaseContentsForUpdate(sourceDir, targetDir, []),
    /unsafe_staged_git_entry/,
  );
});

test('git zip entry reader closes archives on success and error', async () => {
  const makeZipFile = ({ failAfterFirstEntry = false } = {}) => {
    const zipFile = new EventEmitter();
    const entries = ['app/manifest.json', 'app/frontend/src/App.tsx'];
    let index = 0;
    zipFile.closed = false;
    zipFile.close = () => {
      zipFile.closed = true;
    };
    zipFile.readEntry = () => {
      queueMicrotask(() => {
        if (failAfterFirstEntry && index === 1) {
          zipFile.emit('error', new Error('zip_read_failed'));
          return;
        }
        const fileName = entries[index++];
        if (fileName) {
          zipFile.emit('entry', { fileName });
          return;
        }
        zipFile.emit('end');
      });
    };
    return zipFile;
  };

  const opened = [];
  const success = makeCommandGitHarness({
    yauzl: {
      open: (_archivePath, _options, callback) => {
        const zipFile = makeZipFile();
        opened.push(zipFile);
        callback(null, zipFile);
      },
    },
  });

  assert.deepEqual(await success.controller.listZipEntries('/tmp/app.zip'), [
    'app/manifest.json',
    'app/frontend/src/App.tsx',
  ]);
  assert.equal(opened[0].closed, true);

  const failureOpened = [];
  const failure = makeCommandGitHarness({
    yauzl: {
      open: (_archivePath, _options, callback) => {
        const zipFile = makeZipFile({ failAfterFirstEntry: true });
        failureOpened.push(zipFile);
        callback(null, zipFile);
      },
    },
  });

  await assert.rejects(failure.controller.listZipEntries('/tmp/app.zip'), /zip_read_failed/);
  assert.equal(failureOpened[0].closed, true);
});

test('git bundled runtime availability uses prepared runtimes and zip validation rejects unsafe entries', async (t) => {
  const root = await tmpRoot('command-git-bundled');
  const previousPath = process.env.PATH;
  const previousExecPath = process.env.GIT_EXEC_PATH;
  const previousTemplateDir = process.env.GIT_TEMPLATE_DIR;
  t.after(async () => {
    process.env.PATH = previousPath;
    if (previousExecPath === undefined) {
      delete process.env.GIT_EXEC_PATH;
    } else {
      process.env.GIT_EXEC_PATH = previousExecPath;
    }
    if (previousTemplateDir === undefined) {
      delete process.env.GIT_TEMPLATE_DIR;
    } else {
      process.env.GIT_TEMPLATE_DIR = previousTemplateDir;
    }
    await fs.rm(root, { recursive: true, force: true });
  });
  const gitRoot = path.join(root, 'runtimes', 'git', '2.50.0', 'darwin_arm64');
  await fs.mkdir(path.join(gitRoot, 'bin'), { recursive: true });
  await fs.mkdir(path.join(gitRoot, 'libexec', 'git-core'), { recursive: true });
  await fs.mkdir(path.join(gitRoot, 'share', 'git-core', 'templates'), { recursive: true });
  await fs.writeFile(path.join(gitRoot, '.ready'), 'ready', 'utf8');
  await fs.writeFile(path.join(gitRoot, 'bin', 'git'), '', 'utf8');
  const archiveEntries = ['app/manifest.json', '/absolute/path'];
  const { controller } = makeCommandGitHarness({
    root,
    spawn: (command, args) => {
      const child = new FakeChildProcess();
      queueMicrotask(() => {
        if (command === 'git' || command.endsWith('/git') || args.join(' ') === '--version') {
          child.stdout.emit('data', Buffer.from('git version 2.50.0\n'));
        }
        child.emit('exit', 0, null);
      });
      return child;
    },
    yauzl: {
      open: (_archivePath, _options, callback) => {
        const zipFile = new EventEmitter();
        let index = 0;
        zipFile.close = () => undefined;
        zipFile.readEntry = () => {
          queueMicrotask(() => {
            const fileName = archiveEntries[index++];
            if (fileName) {
              zipFile.emit('entry', { fileName });
              return;
            }
            zipFile.emit('end');
          });
        };
        callback(null, zipFile);
      },
    },
  });

  assert.equal(await withPlatform('darwin', async () => await controller.ensureBundledGitAvailable()), true);
  assert.equal(process.env.GIT_EXEC_PATH, path.join(gitRoot, 'libexec', 'git-core'));
  await assert.rejects(controller.validateArchiveEntries('/tmp/app.zip'), /unsafe_archive_entry_\/absolute\/path/);

  const noArchiveRoot = await tmpRoot('command-git-no-archive');
  t.after(async () => {
    await fs.rm(noArchiveRoot, { recursive: true, force: true });
  });
  const noArchive = makeCommandGitHarness({
    root: noArchiveRoot,
    resolvePlatformAlias: () => 'darwin_arm64',
    findRuntimeArchive: async () => null,
  }).controller;
  assert.equal(await withPlatform('darwin', async () => await noArchive.ensureBundledGitAvailable()), false);
});

test('git bundled runtime extraction verifies checksums and clears locks after failures', async (t) => {
  const root = await tmpRoot('command-git-bundled-extract');
  const previousPath = process.env.PATH;
  const previousExecPath = process.env.GIT_EXEC_PATH;
  const previousTemplateDir = process.env.GIT_TEMPLATE_DIR;
  t.after(async () => {
    process.env.PATH = previousPath;
    if (previousExecPath === undefined) {
      delete process.env.GIT_EXEC_PATH;
    } else {
      process.env.GIT_EXEC_PATH = previousExecPath;
    }
    if (previousTemplateDir === undefined) {
      delete process.env.GIT_TEMPLATE_DIR;
    } else {
      process.env.GIT_TEMPLATE_DIR = previousTemplateDir;
    }
    await fs.rm(root, { recursive: true, force: true });
  });
  const archivePath = path.join(root, 'resources', 'git', '2.50.0', 'git.tgz');
  const checksumPath = `${archivePath}.sha256`;
  await fs.mkdir(path.dirname(archivePath), { recursive: true });
  await fs.writeFile(archivePath, 'archive', 'utf8');
  await fs.writeFile(checksumPath, `${createHash('sha256').update('archive').digest('hex')}  git.tgz\n`, 'utf8');
  const extracted = makeCommandGitHarness({
    root,
    findRuntimeArchive: async () => archivePath,
    findRuntimeChecksumFile: async () => checksumPath,
    hashFileSha256: async () => 'expected-sha',
    spawn: (command, args) => {
      const child = new FakeChildProcess();
      queueMicrotask(async () => {
        if (command === 'tar') {
          const destination = args[args.indexOf('-C') + 1];
          await fs.mkdir(path.join(destination, 'git-2.50.0', 'bin'), { recursive: true });
          await fs.mkdir(path.join(destination, 'git-2.50.0', 'libexec', 'git-core'), { recursive: true });
          await fs.mkdir(path.join(destination, 'git-2.50.0', 'share', 'git-core', 'templates'), { recursive: true });
          await fs.writeFile(path.join(destination, 'git-2.50.0', 'bin', 'git'), '', 'utf8');
          child.emit('exit', 0, null);
          return;
        }
        child.stdout.emit('data', Buffer.from('git version 2.50.0\n'));
        child.emit('exit', 0, null);
      });
      return child;
    },
  });

  assert.equal(await extracted.controller.ensureBundledGitAvailable(), true);
  assert.equal(process.env.GIT_EXEC_PATH, path.join(root, 'runtimes', 'git', '2.50.0', 'darwin_arm64', 'libexec', 'git-core'));

  const mismatch = makeCommandGitHarness({
    root: path.join(root, 'mismatch'),
    findRuntimeArchive: async () => archivePath,
    findRuntimeChecksumFile: async () => {
      const badChecksumPath = path.join(root, 'bad.sha256');
      await fs.writeFile(badChecksumPath, 'not-the-current-sha\n', 'utf8');
      return badChecksumPath;
    },
  });

  await assert.rejects(
    mismatch.controller.ensureBundledGitAvailable(),
    /git_checksum_mismatch_2\.50\.0_darwin_arm64/,
  );
  assert.equal(await mismatch.controller.ensureBundledGitAvailable().catch(() => 'failed-again'), 'failed-again');
});

test('git discovery and installer fallbacks stay inside fake process boundaries', async (t) => {
  const root = await tmpRoot('command-git-discovery');
  const previousPath = process.env.PATH;
  t.after(async () => {
    process.env.PATH = previousPath;
    await fs.rm(root, { recursive: true, force: true });
  });
  const discoveredGit = path.join(root, 'git');
  await fs.writeFile(discoveredGit, '', 'utf8');
  const discovery = makeCommandGitHarness({
    root,
    spawn: (command, _args) => {
      const child = new FakeChildProcess();
      queueMicrotask(() => {
        child.emit('exit', command === discoveredGit || command === 'git' ? 0 : 1, null);
      });
      return child;
    },
  });
  assert.equal(await discovery.controller.findGitExecutableOutsidePath(), null);
  discovery.controller.appendProcessPathEntry(path.join(root, 'bin'));
  discovery.controller.appendProcessPathEntry(path.join(root, 'bin'));
  assert.equal(process.env.PATH.split(path.delimiter).filter((entry) => entry === path.join(root, 'bin')).length, 1);

  const installCalls = [];
  const linux = makeCommandGitHarness({
    resolvePlatformAlias: () => 'linux_x64',
    spawn: (command, args) => {
      installCalls.push([command, args]);
      const child = new FakeChildProcess();
      queueMicrotask(() => {
        if (command === 'apt-get' && args[0] === '--version') {
          child.emit('exit', 0, null);
          return;
        }
        child.emit('exit', command === 'apt-get' ? 0 : 1, null);
      });
      return child;
    },
  });

  await withPlatform('linux', async () => {
    await assert.rejects(linux.controller.ensureGitAvailable(), /git_unavailable/);
  });
  assert.ok(installCalls.some((call) => call[0] === 'apt-get' && call[1].join(' ') === 'install -y git'));
});

test('git discovery covers Windows candidates, bundled early returns, and branch fallbacks', async (t) => {
  const root = await tmpRoot('command-git-windows-discovery');
  const previousPath = process.env.PATH;
  const previousExecPath = process.env.GIT_EXEC_PATH;
  const previousTemplateDir = process.env.GIT_TEMPLATE_DIR;
  t.after(async () => {
    process.env.PATH = previousPath;
    if (previousExecPath === undefined) {
      delete process.env.GIT_EXEC_PATH;
    } else {
      process.env.GIT_EXEC_PATH = previousExecPath;
    }
    if (previousTemplateDir === undefined) {
      delete process.env.GIT_TEMPLATE_DIR;
    } else {
      process.env.GIT_TEMPLATE_DIR = previousTemplateDir;
    }
    await fs.rm(root, { recursive: true, force: true });
  });
  const programFilesGit = path.join(root, 'Git', 'cmd', 'git.exe');
  const bundledRoot = path.join(root, 'runtimes', 'git', '2.50.0', 'darwin_arm64');
  await fs.mkdir(path.dirname(programFilesGit), { recursive: true });
  await fs.writeFile(programFilesGit, '', 'utf8');
  await fs.mkdir(path.join(bundledRoot, 'bin'), { recursive: true });
  await fs.mkdir(path.join(bundledRoot, 'libexec', 'git-core'), { recursive: true });
  await fs.mkdir(path.join(bundledRoot, 'share', 'git-core', 'templates'), { recursive: true });
  await fs.writeFile(path.join(bundledRoot, '.ready'), 'ready', 'utf8');
  await fs.writeFile(path.join(bundledRoot, 'bin', 'git'), '', 'utf8');
  const calls = [];
  const harness = makeCommandGitHarness({
    root,
    spawn: (command, args) => {
      calls.push([command, args]);
      const child = new FakeChildProcess();
      queueMicrotask(() => {
        const ok = command === programFilesGit || command === 'git' || command.endsWith('/git');
        child.emit('exit', ok ? 0 : 1, null);
      });
      return child;
    },
  });

  await withPlatform('win32', async () => await withEnv({
    ProgramFiles: root,
    'ProgramFiles(x86)': undefined,
    LocalAppData: undefined,
  }, async () => {
    assert.equal(await harness.controller.findGitExecutableOutsidePath(), programFilesGit);
    process.env.PATH = '';
    assert.equal(await harness.controller.makeDiscoveredGitAvailable(), true);
    assert.equal(await harness.controller.resolveGitExecutableInRoot(path.join(root, 'Git')), programFilesGit);
  }));

  await withPlatform('darwin', async () => {
    await harness.controller.ensureGitAvailable();
  });
  assert.equal(process.env.GIT_EXEC_PATH, path.join(bundledRoot, 'libexec', 'git-core'));
});

test('git repository helpers cover existing repos, fallback branches, and status failures', async (t) => {
  const root = await tmpRoot('command-git-repo-edges');
  const cwd = path.join(root, 'app');
  const excludePath = path.join(cwd, '.git', 'info', 'exclude');
  const calls = [];
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  await fs.mkdir(path.dirname(excludePath), { recursive: true });
  await fs.writeFile(excludePath, '# Forger runtime artifacts\nbackend/.venv/\nbackend/__pycache__/\nbackend/**/__pycache__/\nbackend/**/*.pyc\nbackend/.ruff_cache/\nbackend/.pytest_cache/\nbackend/data/\nfrontend/node_modules/\nfrontend/dist/\nfrontend/.vite/\nfrontend/tsconfig.tsbuildinfo\n.DS_Store\n', 'utf8');
  const controller = makeCommandGitHarness({
    spawn: (command, args, options) => {
      calls.push([command, args, options.cwd]);
      const child = new FakeChildProcess();
      queueMicrotask(() => {
        const text = args.join(' ');
        if (text === 'rev-parse --git-path info/exclude') {
          child.stdout.emit('data', Buffer.from('.git/info/exclude\n'));
        } else if (text === 'rev-list --max-parents=0 HEAD') {
          child.stdout.emit('data', Buffer.from('root-head\n'));
        } else if (text === 'rev-parse HEAD') {
          child.stdout.emit('data', Buffer.from('fallback-head\n'));
        }
        if (text === 'checkout user-modified' || text === 'rev-parse --is-inside-work-tree' || text === '--version') {
          child.emit('exit', text === 'checkout user-modified' ? 1 : 0, null);
          return;
        }
        child.emit('exit', 0, null);
      });
      return child;
    },
  }).controller;

  await controller.ensureAppGitRepository(cwd);
  await controller.ensureUserModifiedBranch(cwd);
  assert.equal(await controller.getOriginalCommitSha(cwd), 'root-head');
  assert.ok(calls.some((call) => call[1].join(' ') === 'checkout -b user-modified'));
  assert.ok(calls.some((call) => call[1].join(' ') === 'checkout main'));
  assert.equal((await fs.readFile(excludePath, 'utf8')).split('# Forger runtime artifacts').length, 2);

  const failing = makeCommandGitHarness({
    spawn: (_command, args) => {
      const child = new FakeChildProcess();
      queueMicrotask(() => {
        child.stderr.emit('data', Buffer.from('status failed'));
        child.emit('exit', args[0] === 'status' || args[0] === 'rev-list' ? 1 : 0, null);
      });
      return child;
    },
  }).controller;

  await assert.rejects(failing.getGitStatusLines(cwd), /status failed/);
  assert.equal(await failing.getOriginalCommitSha(cwd), undefined);
});

test('git archive and quarantine helpers cover platform-specific command branches', async (t) => {
  const root = await tmpRoot('command-git-archive-edges');
  const calls = [];
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  const controller = makeCommandGitHarness({
    spawn: (command, args, options) => {
      calls.push([command, args, options.cwd]);
      const child = new FakeChildProcess();
      queueMicrotask(() => child.emit('exit', command === '/usr/bin/xattr' ? 1 : 0, null));
      return child;
    },
  }).controller;
  const target = path.join(root, 'target');
  await fs.mkdir(target, { recursive: true });

  await withPlatform('linux', async () => {
    await controller.clearMacQuarantine(target);
  });
  await withPlatform('darwin', async () => {
    await controller.clearMacQuarantine(path.join(root, 'missing'));
    await controller.clearMacQuarantine(target);
  });
  await withPlatform('win32', async () => {
    await controller.extractArchive(path.join(root, 'app.zip'), path.join(root, 'zip-win'));
  });
  await withPlatform('darwin', async () => {
    await controller.extractArchive(path.join(root, 'app.zip'), path.join(root, 'zip-mac'));
  });
  await assert.rejects(
    controller.extractArchive(path.join(root, 'app.rar'), path.join(root, 'rar')),
    /unsupported_archive_format/,
  );

  assert.ok(calls.some((call) => call[0] === '/usr/bin/xattr'));
  assert.ok(calls.some((call) => call[0] === 'powershell' && call[1].join(' ').includes('Expand-Archive')));
  assert.ok(calls.some((call) => call[0] === 'unzip'));
});

test('git sync reports tracked-file listing failures', async (t) => {
  const root = await tmpRoot('command-git-sync-failure');
  const stageDir = path.join(root, 'stage');
  const installDir = path.join(root, 'installed');
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  await fs.mkdir(stageDir, { recursive: true });
  await fs.mkdir(installDir, { recursive: true });
  const controller = makeCommandGitHarness({
    spawn: () => {
      const child = new FakeChildProcess();
      queueMicrotask(() => {
        child.stderr.emit('data', Buffer.from('ls-files failed'));
        child.emit('exit', 1, null);
      });
      return child;
    },
  }).controller;

  await assert.rejects(
    controller.syncReleaseIntoInstalledApp(stageDir, installDir, []),
    /ls-files failed/,
  );
});

test('git archive validation surfaces list and zip open failures', async () => {
  const tarFailure = makeCommandGitHarness({
    spawn: () => {
      const child = new FakeChildProcess();
      queueMicrotask(() => {
        child.stderr.emit('data', Buffer.from('tar list failed'));
        child.emit('exit', 2, null);
      });
      return child;
    },
  });

  await assert.rejects(tarFailure.controller.validateArchiveEntries('/tmp/app.tar.gz'), /tar list failed/);

  const zipFailure = makeCommandGitHarness({
    yauzl: {
      open: (_archivePath, _options, callback) => callback(new Error('zip_open_failed')),
    },
  });

  await assert.rejects(zipFailure.controller.listZipEntries('/tmp/app.zip'), /zip_open_failed/);
});

test('git bundled extraction preserves flat archives and reports missing executables', async (t) => {
  const root = await tmpRoot('command-git-flat-bundled');
  const previousPath = process.env.PATH;
  const previousExecPath = process.env.GIT_EXEC_PATH;
  const previousTemplateDir = process.env.GIT_TEMPLATE_DIR;
  t.after(async () => {
    process.env.PATH = previousPath;
    if (previousExecPath === undefined) {
      delete process.env.GIT_EXEC_PATH;
    } else {
      process.env.GIT_EXEC_PATH = previousExecPath;
    }
    if (previousTemplateDir === undefined) {
      delete process.env.GIT_TEMPLATE_DIR;
    } else {
      process.env.GIT_TEMPLATE_DIR = previousTemplateDir;
    }
    await fs.rm(root, { recursive: true, force: true });
  });
  const archivePath = path.join(root, 'resources', 'git', '2.50.0', 'flat.tgz');
  await fs.mkdir(path.dirname(archivePath), { recursive: true });
  await fs.writeFile(archivePath, 'archive', 'utf8');
  const calls = [];
  const controller = makeCommandGitHarness({
    root,
    findRuntimeArchive: async () => archivePath,
    spawn: (command, args) => {
      calls.push([command, args]);
      const child = new FakeChildProcess();
      queueMicrotask(async () => {
        if (command === 'tar') {
          const destination = args[args.indexOf('-C') + 1];
          await fs.mkdir(path.join(destination, 'bin'), { recursive: true });
          await fs.mkdir(path.join(destination, 'cmd'), { recursive: true });
          await fs.mkdir(path.join(destination, 'libexec', 'git-core'), { recursive: true });
          await fs.mkdir(path.join(destination, 'share', 'git-core', 'templates'), { recursive: true });
          await fs.writeFile(path.join(destination, 'bin', 'git'), '', 'utf8');
        }
        child.emit('exit', 0, null);
      });
      return child;
    },
  }).controller;

  assert.equal(await controller.ensureBundledGitAvailable(), true);
  assert.ok(calls.some((call) => call[0] === 'tar'));

  const missingExecutable = makeCommandGitHarness({ root: path.join(root, 'missing-executable') }).controller;
  assert.equal(await missingExecutable.resolveGitExecutableInRoot(path.join(root, 'missing-executable')), null);
});

test('git discovery covers LocalAppData candidates and installer fallback variants', async (t) => {
  const root = await tmpRoot('command-git-installers');
  const previousPath = process.env.PATH;
  t.after(async () => {
    process.env.PATH = previousPath;
    await fs.rm(root, { recursive: true, force: true });
  });
  const localGit = path.join(root, 'Programs', 'Git', 'cmd', 'git.exe');
  await fs.mkdir(path.dirname(localGit), { recursive: true });
  await fs.writeFile(localGit, '', 'utf8');
  const localDiscovery = makeCommandGitHarness({
    spawn: (command) => {
      const child = new FakeChildProcess();
      queueMicrotask(() => child.emit('exit', command === localGit ? 0 : 1, null));
      return child;
    },
  }).controller;

  await withPlatform('win32', async () => await withEnv({
    ProgramFiles: path.join(root, 'missing-program-files'),
    'ProgramFiles(x86)': path.join(root, 'missing-program-files-x86'),
    LocalAppData: root,
  }, async () => {
    assert.equal(await localDiscovery.findGitExecutableOutsidePath(), localGit);
  }));

  const runInstallerCase = async (platform, availableManager, expectedInstallArgs) => {
    const calls = [];
    let installed = false;
    const controller = makeCommandGitHarness({
      resolvePlatformAlias: () => 'linux_x64',
      spawn: (command, args) => {
        calls.push([command, args]);
        const child = new FakeChildProcess();
        queueMicrotask(() => {
          const text = args.join(' ');
          if (command === 'git' && text === '--version') {
            child.emit('exit', installed ? 0 : 1, null);
            return;
          }
          if (text === '--version') {
            child.emit('exit', command === availableManager ? 0 : 1, null);
            return;
          }
          if (expectedInstallArgs(command, args)) {
            installed = true;
            child.emit('exit', 0, null);
            return;
          }
          child.emit('exit', 1, null);
        });
        return child;
      },
    }).controller;
    await withPlatform(platform, async () => {
      await controller.ensureGitAvailable();
    });
    assert.ok(calls.some((call) => expectedInstallArgs(call[0], call[1])));
  };

  await runInstallerCase('darwin', 'brew', (command, args) => command === 'brew' && args.join(' ') === 'install git');
  await runInstallerCase('win32', 'winget', (command, args) => command === 'winget' && args.includes('Git.Git'));
  await runInstallerCase('linux', 'dnf', (command, args) => command === 'dnf' && args.join(' ') === 'install -y git');
  await runInstallerCase('linux', 'yum', (command, args) => command === 'yum' && args.join(' ') === 'install -y git');
  await runInstallerCase('linux', 'apk', (command, args) => command === 'apk' && args.join(' ') === 'add git');

  const discoveredRoot = path.join(root, 'discovered');
  const discoveredGit = path.join(discoveredRoot, 'Programs', 'Git', 'cmd', 'git.exe');
  await fs.mkdir(path.dirname(discoveredGit), { recursive: true });
  await fs.writeFile(discoveredGit, '', 'utf8');
  let pathUpdated = false;
  const discovered = makeCommandGitHarness({
    resolvePlatformAlias: () => 'linux_x64',
    spawn: (command, _args) => {
      const child = new FakeChildProcess();
      queueMicrotask(() => {
        if (command === discoveredGit) {
          pathUpdated = true;
          child.emit('exit', 0, null);
          return;
        }
        if (command === 'git' && pathUpdated) {
          child.emit('exit', 0, null);
          return;
        }
        child.emit('exit', 1, null);
      });
      return child;
    },
  }).controller;
  await withPlatform('win32', async () => await withEnv({
    ProgramFiles: path.join(discoveredRoot, 'GitRoot'),
    'ProgramFiles(x86)': path.join(discoveredRoot, 'missing-program-files-x86'),
    LocalAppData: discoveredRoot,
  }, async () => {
    await discovered.ensureGitAvailable();
  }));
});

test('git availability returns after bundled fallback and local excludes surface git-path failures', async (t) => {
  const root = await tmpRoot('command-git-bundled-fallback');
  const previousPath = process.env.PATH;
  const previousExecPath = process.env.GIT_EXEC_PATH;
  const previousTemplateDir = process.env.GIT_TEMPLATE_DIR;
  t.after(async () => {
    process.env.PATH = previousPath;
    if (previousExecPath === undefined) {
      delete process.env.GIT_EXEC_PATH;
    } else {
      process.env.GIT_EXEC_PATH = previousExecPath;
    }
    if (previousTemplateDir === undefined) {
      delete process.env.GIT_TEMPLATE_DIR;
    } else {
      process.env.GIT_TEMPLATE_DIR = previousTemplateDir;
    }
    await fs.rm(root, { recursive: true, force: true });
  });
  const gitRoot = path.join(root, 'runtimes', 'git', '2.50.0', 'darwin_arm64');
  await fs.mkdir(path.join(gitRoot, 'bin'), { recursive: true });
  await fs.mkdir(path.join(gitRoot, 'libexec', 'git-core'), { recursive: true });
  await fs.mkdir(path.join(gitRoot, 'share', 'git-core', 'templates'), { recursive: true });
  await fs.writeFile(path.join(gitRoot, '.ready'), 'ready', 'utf8');
  await fs.writeFile(path.join(gitRoot, 'bin', 'git'), '', 'utf8');
  const controller = makeCommandGitHarness({
    root,
    spawn: (command) => {
      const child = new FakeChildProcess();
      queueMicrotask(() => {
        if (command === 'git') {
          child.emit('exit', process.env.GIT_EXEC_PATH ? 0 : 1, null);
          return;
        }
        child.emit('exit', command.endsWith('/git') ? 0 : 1, null);
      });
      return child;
    },
  }).controller;

  await withPlatform('linux', async () => {
    await controller.ensureGitAvailable();
  });
  assert.equal(process.env.GIT_EXEC_PATH, path.join(gitRoot, 'libexec', 'git-core'));

  const failingExcludes = makeCommandGitHarness({
    spawn: () => {
      const child = new FakeChildProcess();
      queueMicrotask(() => {
        child.stderr.emit('data', Buffer.from('git path failed'));
        child.emit('exit', 1, null);
      });
      return child;
    },
  }).controller;
  await assert.rejects(failingExcludes.ensureForgerLocalGitExcludes(root), /git path failed/);
});

test('git zip entry reader ignores duplicate terminal events after settling', async () => {
  const controller = makeCommandGitHarness({
    yauzl: {
      open: (_archivePath, _options, callback) => {
        const zipFile = new EventEmitter();
        zipFile.close = () => undefined;
        zipFile.once = (event, handler) => {
          zipFile.on(event, handler);
          return zipFile;
        };
        zipFile.readEntry = () => {
          queueMicrotask(() => {
            zipFile.emit('error', new Error('zip_read_failed'));
            zipFile.emit('error', new Error('zip_read_failed_again'));
            zipFile.emit('end');
          });
        };
        callback(null, zipFile);
      },
    },
  }).controller;

  await assert.rejects(controller.listZipEntries('/tmp/app.zip'), /zip_read_failed/);
});

test('runtime install returns ready runtimes without extracting and normalizes npm install mode', async (t) => {
  const root = await tmpRoot('runtime-install-ready');
  const calls = [];
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  const target = path.join(root, 'runtimes', 'node', '22.1.0', 'darwin_arm64');
  await fs.mkdir(path.join(target, 'bin'), { recursive: true });
  await fs.writeFile(path.join(target, '.ready'), 'ready', 'utf8');
  await fs.writeFile(path.join(target, 'bin', 'node'), '', 'utf8');
  await fs.writeFile(path.join(target, 'bin', 'npm'), '', 'utf8');
  const controller = createRuntimeInstallController({
    DEFAULT_NODE_VERSION: '22.1.0',
    DEFAULT_PYTHON_VERSION: '3.12.0',
    app: { getPath: () => root },
    clearMacQuarantine: async (targetPath) => calls.push(['quarantine', targetPath]),
    extractArchive: async () => {
      throw new Error('extract_should_not_run');
    },
    findRuntimeArchive: async () => {
      throw new Error('archive_lookup_should_not_run');
    },
    findRuntimeChecksumFile: async () => null,
    fs,
    getBundledResourcesRoot: () => path.join(root, 'resources'),
    getRuntimesRoot: () => path.join(root, 'runtimes'),
    getTempRoot: () => path.join(root, 'tmp'),
    hashFileSha256: async () => '',
    installBackendDependenciesWithUv: async () => undefined,
    normalizeNodeRuntimeVersion: (value) => value,
    normalizeVersionForFolder: (value) => value,
    path,
    resolvePlatformAlias: () => 'darwin_arm64',
    runCommand: async (command, args, options) => calls.push(['run', command, args, options]),
    runtimeLocks: new Map(),
  });
  const frontendDir = path.join(root, 'frontend');
  await fs.mkdir(frontendDir, { recursive: true });

  const runtime = await controller.ensureRuntimeInstalled('node', '22.1.0');
  await controller.installFrontendDependenciesWithNpm(runtime.node, runtime.npm, frontendDir, 'demo-app');

  assert.equal(runtime.node, path.join(target, 'bin', 'node'));
  assert.equal(runtime.npm, path.join(target, 'bin', 'npm'));
  assert.deepEqual(calls[0], ['quarantine', target]);
  const npmInstall = calls.find((call) => call[0] === 'run' && call[2][0] === 'install');
  assert.ok(npmInstall);
  assert.deepEqual(npmInstall[2], ['install', '--package-lock=false']);
  assert.equal(npmInstall[2].some((arg) => arg.includes('production') || arg.includes('omit')), false);
});

test('runtime flatten replaces stale children, retries blocked renames, and falls back to copy', async (t) => {
  const root = await tmpRoot('runtime-flatten-robust');
  const target = path.join(root, 'target');
  const top = path.join(target, 'finance-os');
  const calls = [];
  const renameAttempts = new Map();
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  await fs.mkdir(path.join(top, 'backend'), { recursive: true });
  await fs.mkdir(path.join(top, 'frontend'), { recursive: true });
  await fs.mkdir(path.join(target, 'backend'), { recursive: true });
  await fs.writeFile(path.join(top, 'backend', 'server.py'), 'new-backend', 'utf8');
  await fs.writeFile(path.join(top, 'frontend', 'package.json'), 'new-frontend', 'utf8');
  await fs.writeFile(path.join(target, 'backend', 'stale.py'), 'stale', 'utf8');

  const fsWithBlockedRename = {
    ...fs,
    rename: async (source, destination) => {
      const name = path.basename(source);
      const attempts = renameAttempts.get(name) ?? 0;
      renameAttempts.set(name, attempts + 1);
      if (name === 'backend' && attempts === 0) {
        const error = new Error('EPERM: operation not permitted, rename');
        error.code = 'EPERM';
        throw error;
      }
      if (name === 'frontend') {
        const error = new Error('EPERM: operation not permitted, rename');
        error.code = 'EPERM';
        throw error;
      }
      await fs.rename(source, destination);
    },
  };

  const controller = createRuntimeInstallController({
    DEFAULT_NODE_VERSION: '22.1.0',
    DEFAULT_PYTHON_VERSION: '3.12.0',
    appendInstallLog: async (event, payload = {}) => calls.push(['log', event, payload]),
    app: { getPath: () => root, getVersion: () => '0.2.35' },
    clearMacQuarantine: async () => undefined,
    extractArchive: async () => undefined,
    findRuntimeArchive: async () => null,
    findRuntimeChecksumFile: async () => null,
    fs: fsWithBlockedRename,
    getBundledResourcesRoot: () => path.join(root, 'resources'),
    getRuntimesRoot: () => path.join(root, 'runtimes'),
    getTempRoot: () => path.join(root, 'tmp'),
    hashFileSha256: async () => 'sha',
    installBackendDependenciesWithUv: async () => undefined,
    normalizeNodeRuntimeVersion: (value) => value,
    normalizeVersionForFolder: (value) => value,
    path,
    resolvePlatformAlias: () => 'darwin_arm64',
    runCommand: async () => undefined,
    runtimeLocks: new Map(),
  });

  await controller.flattenSingleTopLevelDirectory(target);

  assert.equal(await fs.readFile(path.join(target, 'backend', 'server.py'), 'utf8'), 'new-backend');
  assert.equal(await fs.stat(path.join(target, 'backend', 'stale.py')).catch(() => null), null);
  assert.equal(await fs.readFile(path.join(target, 'frontend', 'package.json'), 'utf8'), 'new-frontend');
  assert.equal(await fs.stat(top).catch(() => null), null);
  assert.equal(renameAttempts.get('backend'), 2);
  assert.equal(renameAttempts.get('frontend'), 3);
  assert.ok(calls.some((call) => call[1] === 'flatten:move_retry' && call[2].sourceName === 'backend'));
  assert.ok(calls.some((call) => call[1] === 'flatten:move_fallback' && call[2].sourceName === 'frontend'));
});

test('runtime install refreshes legacy Python runtimes on macOS', async (t) => {
  const root = await tmpRoot('runtime-install-python-legacy');
  const calls = [];
  const target = path.join(root, 'runtimes', 'python', '3.12.0', 'darwin_arm64');
  const archivePath = path.join(root, 'resources', 'python', '3.12.0', 'python.tgz');
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  await fs.mkdir(path.join(target, 'bin'), { recursive: true });
  await fs.mkdir(path.dirname(archivePath), { recursive: true });
  await fs.writeFile(path.join(target, '.ready'), 'ready', 'utf8');
  await fs.writeFile(path.join(target, 'bin', 'python3'), 'old', 'utf8');
  await fs.writeFile(archivePath, 'archive', 'utf8');

  const controller = createRuntimeInstallController({
    DEFAULT_NODE_VERSION: '22.1.0',
    DEFAULT_PYTHON_VERSION: '3.12.0',
    app: { getPath: () => root, getVersion: () => '0.2.35' },
    clearMacQuarantine: async (targetPath) => calls.push(['quarantine', targetPath]),
    extractArchive: async (_archive, destination) => {
      calls.push(['extract', destination]);
      await fs.mkdir(path.join(destination, 'python-runtime', 'bin'), { recursive: true });
      await fs.writeFile(path.join(destination, 'python-runtime', 'bin', 'python3'), 'new', 'utf8');
    },
    findRuntimeArchive: async () => archivePath,
    findRuntimeChecksumFile: async () => null,
    fs,
    getBundledResourcesRoot: () => path.join(root, 'resources'),
    getRuntimesRoot: () => path.join(root, 'runtimes'),
    getTempRoot: () => path.join(root, 'tmp'),
    hashFileSha256: async () => 'new-python-sha',
    installBackendDependenciesWithUv: async () => undefined,
    normalizeNodeRuntimeVersion: (value) => value,
    normalizeVersionForFolder: (value) => value,
    path,
    resolvePlatformAlias: () => 'darwin_arm64',
    runCommand: async () => undefined,
    runtimeLocks: new Map(),
  });

  const runtime = await controller.ensureRuntimeInstalled('python', '3.12.0');
  const ready = JSON.parse(await fs.readFile(path.join(target, '.ready'), 'utf8'));

  assert.equal(runtime.python, path.join(target, 'bin', 'python3'));
  assert.equal(await fs.readFile(runtime.python, 'utf8'), 'new');
  assert.equal(calls.filter((call) => call[0] === 'extract').length, 1);
  assert.equal(ready.desktopVersion, '0.2.35');
  assert.equal(ready.runtimeRevision, 'python-darwin-disable-library-validation-2026-06-02');
  assert.equal(ready.archiveSha256, 'new-python-sha');
});

test('runtime install reuses current Python runtime metadata on macOS', async (t) => {
  const root = await tmpRoot('runtime-install-python-current');
  const calls = [];
  const target = path.join(root, 'runtimes', 'python', '3.12.0', 'darwin_arm64');
  const archivePath = path.join(root, 'resources', 'python', '3.12.0', 'python.tgz');
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  await fs.mkdir(path.join(target, 'bin'), { recursive: true });
  await fs.mkdir(path.dirname(archivePath), { recursive: true });
  await fs.writeFile(path.join(target, '.ready'), pythonDarwinReadyMetadata('current-sha'), 'utf8');
  await fs.writeFile(path.join(target, 'bin', 'python3'), 'current', 'utf8');
  await fs.writeFile(archivePath, 'archive', 'utf8');

  const controller = createRuntimeInstallController({
    DEFAULT_NODE_VERSION: '22.1.0',
    DEFAULT_PYTHON_VERSION: '3.12.0',
    app: { getPath: () => root, getVersion: () => '0.2.35' },
    clearMacQuarantine: async (targetPath) => calls.push(['quarantine', targetPath]),
    extractArchive: async () => {
      throw new Error('extract_should_not_run');
    },
    findRuntimeArchive: async () => archivePath,
    findRuntimeChecksumFile: async () => null,
    fs,
    getBundledResourcesRoot: () => path.join(root, 'resources'),
    getRuntimesRoot: () => path.join(root, 'runtimes'),
    getTempRoot: () => path.join(root, 'tmp'),
    hashFileSha256: async () => 'current-sha',
    installBackendDependenciesWithUv: async () => undefined,
    normalizeNodeRuntimeVersion: (value) => value,
    normalizeVersionForFolder: (value) => value,
    path,
    resolvePlatformAlias: () => 'darwin_arm64',
    runCommand: async () => undefined,
    runtimeLocks: new Map(),
  });

  const runtime = await controller.ensureRuntimeInstalled('python', '3.12.0');

  assert.equal(runtime.python, path.join(target, 'bin', 'python3'));
  assert.deepEqual(calls, [['quarantine', target]]);
});

test('runtime install refreshes stale Python runtime metadata on macOS', async (t) => {
  const scenarios = [
    {
      name: 'revision',
      metadata: { ...JSON.parse(pythonDarwinReadyMetadata('stale-sha')), runtimeRevision: 'old-revision' },
    },
    {
      name: 'archive-sha',
      metadata: JSON.parse(pythonDarwinReadyMetadata('old-sha')),
    },
  ];

  for (const scenario of scenarios) {
    const root = await tmpRoot(`runtime-install-python-stale-${scenario.name}`);
    const calls = [];
    const target = path.join(root, 'runtimes', 'python', '3.12.0', 'darwin_arm64');
    const archivePath = path.join(root, 'resources', 'python', '3.12.0', 'python.tgz');
    t.after(async () => {
      await fs.rm(root, { recursive: true, force: true });
    });
    await fs.mkdir(path.join(target, 'bin'), { recursive: true });
    await fs.mkdir(path.dirname(archivePath), { recursive: true });
    await fs.writeFile(path.join(target, '.ready'), `${JSON.stringify(scenario.metadata)}\n`, 'utf8');
    await fs.writeFile(path.join(target, 'bin', 'python3'), 'old', 'utf8');
    await fs.writeFile(archivePath, 'archive', 'utf8');

    const controller = createRuntimeInstallController({
      DEFAULT_NODE_VERSION: '22.1.0',
      DEFAULT_PYTHON_VERSION: '3.12.0',
      app: { getPath: () => root, getVersion: () => '0.2.35' },
      clearMacQuarantine: async (targetPath) => calls.push(['quarantine', targetPath]),
      extractArchive: async (_archive, destination) => {
        calls.push(['extract', destination]);
        await fs.mkdir(path.join(destination, 'python-runtime', 'bin'), { recursive: true });
        await fs.writeFile(path.join(destination, 'python-runtime', 'bin', 'python3'), 'new', 'utf8');
      },
      findRuntimeArchive: async () => archivePath,
      findRuntimeChecksumFile: async () => null,
      fs,
      getBundledResourcesRoot: () => path.join(root, 'resources'),
      getRuntimesRoot: () => path.join(root, 'runtimes'),
      getTempRoot: () => path.join(root, 'tmp'),
      hashFileSha256: async () => 'stale-sha',
      installBackendDependenciesWithUv: async () => undefined,
      normalizeNodeRuntimeVersion: (value) => value,
      normalizeVersionForFolder: (value) => value,
      path,
      resolvePlatformAlias: () => 'darwin_arm64',
      runCommand: async () => undefined,
      runtimeLocks: new Map(),
    });

    await controller.ensureRuntimeInstalled('python', '3.12.0');

    assert.equal(calls.filter((call) => call[0] === 'extract').length, 1);
    assert.equal(await fs.readFile(path.join(target, 'bin', 'python3'), 'utf8'), 'new');
  }
});

test('runtime install installs full app dependencies with progress messages and package-lock npm mode', async (t) => {
  const root = await tmpRoot('runtime-install-app-deps');
  const calls = [];
  const pythonArchivePath = path.join(root, 'resources', 'python', '3.12.0', 'python.tgz');
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  const nodeTarget = path.join(root, 'runtimes', 'node', '22.1.0', 'darwin_arm64');
  const pythonTarget = path.join(root, 'runtimes', 'python', '3.12.0', 'darwin_arm64');
  await fs.mkdir(path.join(nodeTarget, 'bin'), { recursive: true });
  await fs.mkdir(path.join(pythonTarget, 'bin'), { recursive: true });
  await fs.mkdir(path.dirname(pythonArchivePath), { recursive: true });
  await fs.writeFile(pythonArchivePath, 'python archive', 'utf8');
  await fs.writeFile(path.join(nodeTarget, '.ready'), 'ready', 'utf8');
  await fs.writeFile(path.join(pythonTarget, '.ready'), pythonDarwinReadyMetadata(), 'utf8');
  await fs.writeFile(path.join(nodeTarget, 'bin', 'node'), '', 'utf8');
  await fs.writeFile(path.join(nodeTarget, 'bin', 'npm'), '', 'utf8');
  await fs.writeFile(path.join(pythonTarget, 'bin', 'python3'), '', 'utf8');
  const installDir = path.join(root, 'app');
  await fs.mkdir(path.join(installDir, 'frontend'), { recursive: true });
  await fs.mkdir(path.join(installDir, 'backend'), { recursive: true });
  await fs.writeFile(path.join(installDir, 'frontend', 'package-lock.json'), '{}', 'utf8');
  const controller = createRuntimeInstallController({
    DEFAULT_NODE_VERSION: '22.1.0',
    DEFAULT_PYTHON_VERSION: '3.12.0',
    app: { getPath: () => root },
    clearMacQuarantine: async (targetPath) => calls.push(['quarantine', targetPath]),
    extractArchive: async () => {
      throw new Error('extract_should_not_run');
    },
    findRuntimeArchive: async (baseDir) => baseDir.includes(path.join('python', '3.12.0')) ? pythonArchivePath : null,
    findRuntimeChecksumFile: async () => null,
    fs,
    getBundledResourcesRoot: () => path.join(root, 'resources'),
    getRuntimesRoot: () => path.join(root, 'runtimes'),
    getTempRoot: () => path.join(root, 'tmp'),
    hashFileSha256: async () => 'python-archive-sha',
    installBackendDependenciesWithUv: async (pythonPath, backendDir, appId) => calls.push(['uv', pythonPath, backendDir, appId]),
    normalizeNodeRuntimeVersion: (value) => value,
    normalizeVersionForFolder: (value) => value,
    path,
    resolvePlatformAlias: () => 'darwin_arm64',
    runCommand: async (command, args, options) => calls.push(['run', command, args, options]),
    runtimeLocks: new Map(),
  });
  const progress = [];

  await controller.installAppDependencies(
    'demo-app',
    installDir,
    '22.1.0',
    '3.12.0',
    async (phase, message) => progress.push([phase, message]),
    {
      preparingRuntime: 'prepare',
      installingBackend: 'backend',
      installingFrontend: 'frontend',
    },
  );

  assert.deepEqual(progress, [
    ['preparing_runtime', 'prepare'],
    ['installing_backend', 'backend'],
    ['installing_frontend', 'frontend'],
  ]);
  assert.deepEqual(calls.find((call) => call[0] === 'uv'), [
    'uv',
    path.join(pythonTarget, 'bin', 'python3'),
    path.join(installDir, 'backend'),
    'demo-app',
  ]);
  const npmCi = calls.find((call) => call[0] === 'run' && call[2][0] === 'ci' && call[3].log.label === 'npm ci');
  assert.ok(npmCi);
  assert.deepEqual(npmCi[2], ['ci']);
});

test('runtime install supports experimental x64 aliases but keeps unsupported architectures blocked', async (t) => {
  const root = await tmpRoot('runtime-install-failure');
  const archiveLookups = [];
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  const makeController = (platformAlias) => createRuntimeInstallController({
    DEFAULT_NODE_VERSION: '22.0.0',
    DEFAULT_PYTHON_VERSION: '3.12.0',
    app: { getPath: () => root },
    clearMacQuarantine: async () => undefined,
    extractArchive: async () => undefined,
    findRuntimeArchive: async (baseDir, alias) => {
      archiveLookups.push([baseDir, alias]);
      return null;
    },
    findRuntimeChecksumFile: async () => null,
    fs,
    getBundledResourcesRoot: () => path.join(root, 'resources'),
    getRuntimesRoot: () => path.join(root, 'runtimes'),
    getTempRoot: () => path.join(root, 'tmp'),
    hashFileSha256: async () => '',
    installBackendDependenciesWithUv: async () => undefined,
    normalizeNodeRuntimeVersion: (value) => value,
    normalizeVersionForFolder: (value) => value,
    path,
    resolvePlatformAlias: () => platformAlias,
    runCommand: async () => undefined,
    runtimeLocks: new Map(),
  });

  await assert.rejects(
    makeController('win32_arm64').ensureRuntimeInstalled('node', '22.0.0'),
    /unsupported_platform_win32_arm64/,
  );
  await assert.rejects(
    makeController('linux_x64').ensureRuntimeInstalled('node', '22.0.0'),
    /runtime_archive_missing_node_22.0.0_linux_x64/,
  );
  await assert.rejects(
    makeController('darwin_x64').ensureRuntimeInstalled('python', '3.12.0'),
    /runtime_archive_missing_python_3.12.0_darwin_x64/,
  );
  await assert.rejects(
    makeController('darwin_arm64').ensureRuntimeInstalled('python', '3.12.0'),
    /runtime_archive_missing_python_3.12.0_darwin_arm64/,
  );
  assert.equal(archiveLookups.length, 3);
});

test('runtime install extracts checked archives once and resolves flattened Python executables', async (t) => {
  const root = await tmpRoot('runtime-install-extract');
  const archivePath = path.join(root, 'resources', 'python', '3.12.0', 'python.tgz');
  const checksumPath = `${archivePath}.sha256`;
  const calls = [];
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  await fs.mkdir(path.dirname(archivePath), { recursive: true });
  await fs.writeFile(archivePath, 'archive', 'utf8');
  await fs.writeFile(checksumPath, 'expected-sha  python.tgz\n', 'utf8');
  const controller = createRuntimeInstallController({
    DEFAULT_NODE_VERSION: '22.0.0',
    DEFAULT_PYTHON_VERSION: '3.12.0',
    app: { getPath: () => root },
    clearMacQuarantine: async (targetPath) => calls.push(['quarantine', targetPath]),
    extractArchive: async (_archive, destination) => {
      calls.push(['extract', destination]);
      await fs.mkdir(path.join(destination, 'python-3.12.0', 'bin'), { recursive: true });
      await fs.writeFile(path.join(destination, 'python-3.12.0', 'bin', 'python3'), '', 'utf8');
      await fs.writeFile(path.join(destination, 'python-3.12.0', 'bin', 'pip3'), '', 'utf8');
    },
    findRuntimeArchive: async (baseDir, alias) => {
      calls.push(['archive', baseDir, alias]);
      return archivePath;
    },
    findRuntimeChecksumFile: async () => checksumPath,
    fs,
    getBundledResourcesRoot: () => path.join(root, 'resources'),
    getRuntimesRoot: () => path.join(root, 'runtimes'),
    getTempRoot: () => path.join(root, 'tmp'),
    hashFileSha256: async () => 'expected-sha',
    installBackendDependenciesWithUv: async () => undefined,
    normalizeNodeRuntimeVersion: (value) => value,
    normalizeVersionForFolder: (value) => value,
    path,
    resolvePlatformAlias: () => 'darwin_arm64',
    runCommand: async () => undefined,
    runtimeLocks: new Map(),
  });

  const [first, second] = await Promise.all([
    controller.ensureRuntimeInstalled('python', '3.12.0'),
    controller.ensureRuntimeInstalled('python', '3.12.0'),
  ]);

  assert.equal(first.python, path.join(root, 'runtimes', 'python', '3.12.0', 'darwin_arm64', 'bin', 'python3'));
  assert.equal(first.pip, path.join(root, 'runtimes', 'python', '3.12.0', 'darwin_arm64', 'bin', 'pip3'));
  assert.deepEqual(second, first);
  assert.equal(calls.filter((call) => call[0] === 'extract').length, 1);
  assert.equal(calls.some((call) => call[0] === 'quarantine'), true);
});

test('runtime install rejects checksum mismatches and missing runtime executables', async (t) => {
  const root = await tmpRoot('runtime-install-mismatch');
  const archivePath = path.join(root, 'resources', 'node', '22.0.0', 'node.tgz');
  const checksumPath = `${archivePath}.sha256`;
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  await fs.mkdir(path.dirname(archivePath), { recursive: true });
  await fs.writeFile(archivePath, 'archive', 'utf8');
  await fs.writeFile(checksumPath, 'expected-sha\n', 'utf8');
  const controller = createRuntimeInstallController({
    DEFAULT_NODE_VERSION: '22.0.0',
    DEFAULT_PYTHON_VERSION: '3.12.0',
    app: { getPath: () => root },
    clearMacQuarantine: async () => undefined,
    extractArchive: async (_archive, destination) => {
      await fs.mkdir(destination, { recursive: true });
    },
    findRuntimeArchive: async () => archivePath,
    findRuntimeChecksumFile: async () => checksumPath,
    fs,
    getBundledResourcesRoot: () => path.join(root, 'resources'),
    getRuntimesRoot: () => path.join(root, 'runtimes'),
    getTempRoot: () => path.join(root, 'tmp'),
    hashFileSha256: async () => 'actual-sha',
    installBackendDependenciesWithUv: async () => undefined,
    normalizeNodeRuntimeVersion: (value) => value,
    normalizeVersionForFolder: (value) => value,
    path,
    resolvePlatformAlias: () => 'darwin_arm64',
    runCommand: async () => undefined,
    runtimeLocks: new Map(),
  });

  await assert.rejects(
    controller.ensureRuntimeInstalled('node', '22.0.0'),
    /runtime_checksum_mismatch_node_22.0.0_darwin_arm64/,
  );

  await fs.rm(checksumPath, { force: true });
  await assert.rejects(
    controller.ensureRuntimeInstalled('node', '22.0.0'),
    /runtime_node_executable_not_found/,
  );

  const pythonMissing = createRuntimeInstallController({
    DEFAULT_NODE_VERSION: '22.0.0',
    DEFAULT_PYTHON_VERSION: '3.12.0',
    app: { getPath: () => root },
    clearMacQuarantine: async () => undefined,
    extractArchive: async (_archive, destination) => {
      await fs.mkdir(destination, { recursive: true });
    },
    findRuntimeArchive: async () => archivePath,
    findRuntimeChecksumFile: async () => null,
    fs,
    getBundledResourcesRoot: () => path.join(root, 'resources'),
    getRuntimesRoot: () => path.join(root, 'runtimes-python-missing'),
    getTempRoot: () => path.join(root, 'tmp-python-missing'),
    hashFileSha256: async () => '',
    installBackendDependenciesWithUv: async () => undefined,
    normalizeNodeRuntimeVersion: (value) => value,
    normalizeVersionForFolder: (value) => value,
    path,
    resolvePlatformAlias: () => 'darwin_arm64',
    runCommand: async () => undefined,
    runtimeLocks: new Map(),
  });

  await assert.rejects(
    pythonMissing.ensureRuntimeInstalled('python', '22.0.0'),
    /runtime_python_executable_not_found/,
  );
});

const makeInstalledRuntimeHarness = (overrides = {}) => {
  const calls = [];
  const registry = {
    apps: {
      'demo-app': {
        appId: 'demo-app',
        name: 'Demo App',
        version: '1.0.0',
        installDir: '/tmp/forger-demo-app',
        requiredNodeVersion: '22.0.0',
        requiredPythonVersion: '3.12.0',
        status: 'installed',
        userMessage: 'Ready',
        installedAt: new Date().toISOString(),
      },
    },
  };
  const deps = {
    FORGER_PROTOCOL: 'forger',
    app: { getPath: () => '/tmp', getAppPath: () => '/tmp' },
    appAgentConversationManager: null,
    appAgentTaskManager: null,
    appFolderGrantSecret: 'grant',
    appWindows: new Map(),
    appendInstallLog: async (event, payload = {}) => calls.push(['log', event, payload]),
    desktopRuntimeBridge: null,
    dispatchDeepLink: () => undefined,
    emitRuntimeStatus: (payload) => calls.push(['runtimeStatus', payload]),
    ensureBackendPythonEnvironment: async () => undefined,
    ensureCatalogStatuses: () => calls.push(['catalogStatuses']),
    ensureRuntimeInstalled: async (type) => type === 'node'
      ? { node: '/tmp/node', npm: '/tmp/npm' }
      : { python: '/tmp/python', pip: '/tmp/pip' },
    failureDiagnostic: (error, fallbackCode) => ({ technicalCode: error instanceof Error ? error.message : fallbackCode }),
    formatProcessOutputForInstallLog: (text) => text,
    friendChatWindows: new Map(),
    fs,
    getBackendPathEntries: async () => ['/tmp/developer-bin'],
    getInstallLogPath: () => '/tmp/install.log',
    getManifestAppSecretsValidationError: () => null,
    getSecretsStore: () => ({ resolveAppEnv: async () => ({ env: {}, missingRequired: [], secretValues: [] }) }),
    getVenvExecutables: () => ({ python: '/tmp/venv/python', pip: '/tmp/venv/pip' }),
    http,
    isDev: false,
    isSecretsVaultUnavailableError: (error) => error instanceof Error && error.message === 'vault_unavailable',
    net,
    normalizeManifestAppSecrets: () => [],
    normalizeNodeRuntimeVersion: (value) => value,
    parseForgerUrl: () => null,
    path,
    registry,
    requiresWindowsShell: () => false,
    resolveInstalledManifest: async () => ({ services: [] }),
    runCommand: async (command, args) => calls.push(['run', command, args]),
    runningApps: new Map(),
    serializeErrorForInstallLog: (error) => ({ message: error instanceof Error ? error.message : String(error) }),
    shell: { openExternal: async () => undefined },
    stoppingApps: new Set(),
    syncAppToCloudIfEnabled: async (appId) => calls.push(['syncCloud', appId]),
    truncateForInstallLog: (value) => value,
    upsertInstalledRecord: async (record) => {
      registry.apps[record.appId] = { ...record };
      calls.push(['upsert', record]);
    },
    wait: async () => undefined,
    withAppLifecycleLock: async (_appId, operation) => await operation(),
    ...overrides,
  };
  return { calls, registry, controller: createInstalledAppRuntimeController(deps), deps };
};

const makeExecutableNodeScript = async (filePath, source) => {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `#!/usr/bin/env node\n${source}`, 'utf8');
  await fs.chmod(filePath, 0o755);
};

const requestLocalHttp = async (baseUrl, requestPath, options = {}) => await new Promise((resolve, reject) => {
  const url = new URL(requestPath, baseUrl);
  const request = http.request(url, {
    method: options.method ?? 'GET',
    headers: options.headers ?? {},
  }, (response) => {
    const chunks = [];
    response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    response.on('end', () => resolve({
      statusCode: response.statusCode,
      headers: response.headers,
      body: Buffer.concat(chunks).toString('utf8'),
    }));
  });
  request.on('error', reject);
  if (options.body) {
    request.end(options.body);
  } else {
    request.end();
  }
});

const loadInstalledRuntimeControllerWithFakeElectron = (BrowserWindowClass) => {
  const runtimePath = require.resolve('../../dist-electron/main/runtime/installed-app-runtime.js');
  const electronPath = require.resolve('electron');
  const originalRuntime = require.cache[runtimePath];
  const originalElectron = require.cache[electronPath];
  delete require.cache[runtimePath];
  require.cache[electronPath] = {
    id: electronPath,
    filename: electronPath,
    loaded: true,
    exports: { BrowserWindow: BrowserWindowClass },
  };
  try {
    return require(runtimePath).createInstalledAppRuntimeController;
  } finally {
    delete require.cache[runtimePath];
    if (originalRuntime) {
      require.cache[runtimePath] = originalRuntime;
    }
    if (originalElectron) {
      require.cache[electronPath] = originalElectron;
    } else {
      delete require.cache[electronPath];
    }
  }
};

test('installed app runtime reports not installed and update-conflict gaps before resolving services', async () => {
  const { controller, registry } = makeInstalledRuntimeHarness();

  assert.deepEqual(await controller.openInstalledAppUnlocked('missing-app'), {
    success: false,
    userMessage: 'Primero instala esta app.',
    technicalCode: 'app_not_installed',
  });

  registry.apps['demo-app'].status = 'conflict';
  const result = await controller.openInstalledAppUnlocked('demo-app');
  assert.equal(result.success, false);
  assert.equal(result.technicalCode, 'app_update_conflict');
});

test('installed app runtime returns existing running URLs without restarting services', async () => {
  const { calls, controller, deps } = makeInstalledRuntimeHarness();
  deps.runningApps.set('demo-app', {
    appId: 'demo-app',
    backendUrl: 'http://127.0.0.1:4100',
    frontendUrl: 'http://127.0.0.1:4200',
  });

  const result = await controller.openInstalledAppUnlocked('demo-app', 'es-CL', { openWindow: false });

  assert.deepEqual(result, {
    success: true,
    userMessage: 'La app ya esta en ejecucion.',
    backendUrl: 'http://127.0.0.1:4100',
    frontendUrl: 'http://127.0.0.1:4200',
  });
  assert.equal(calls.some((call) => call[0] === 'log' && call[1] === 'open:start'), false);
});

test('installed app runtime blocks invalid and missing secrets before spawning local app services', async () => {
  const invalid = makeInstalledRuntimeHarness({
    getManifestAppSecretsValidationError: () => 'Secret manifest is invalid.',
  });
  const invalidResult = await invalid.controller.openInstalledAppUnlocked('demo-app');
  assert.equal(invalidResult.success, false);
  assert.equal(invalidResult.technicalCode, 'invalid_app_secrets_manifest');
  assert.equal(invalid.calls.some((call) => call[0] === 'runtimeStatus'), false);

  const missing = makeInstalledRuntimeHarness({
    normalizeManifestAppSecrets: () => [{ name: 'OPENAI_API_KEY', label: 'OpenAI API key', required: true }],
    getSecretsStore: () => ({
      resolveAppEnv: async () => ({
        env: {},
        missingRequired: [{ name: 'OPENAI_API_KEY', label: 'OpenAI API key', required: true }],
        secretValues: [],
      }),
    }),
  });
  const missingResult = await missing.controller.openInstalledAppUnlocked('demo-app');
  assert.equal(missingResult.success, false);
  assert.equal(missingResult.technicalCode, 'required_app_secrets_missing');
  assert.match(missingResult.userMessage, /OpenAI API key/);
  assert.equal(missing.calls.some((call) => call[0] === 'runtimeStatus'), false);

  const unexpected = makeInstalledRuntimeHarness({
    getSecretsStore: () => ({ resolveAppEnv: async () => {
      throw new Error('secrets_store_unexpected');
    } }),
  });
  await assert.rejects(
    unexpected.controller.openInstalledAppUnlocked('demo-app'),
    /secrets_store_unexpected/,
  );
});

test('installed app runtime translates manifest commands, sqlite paths, and service fallbacks', async (t) => {
  const root = await tmpRoot('installed-runtime-helpers');
  const backendDir = path.join(root, 'apps', 'demo-app', 'backend');
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  const { controller } = makeInstalledRuntimeHarness({ isDev: true });

  assert.equal(controller.findManifestService({
    services: [{ name: 'api', context: './backend' }],
  }, 'backend', './backend')?.name, 'api');
  assert.deepEqual(controller.splitManifestCommand('  fastapi   dev src/server/main.py --host 0.0.0.0  '), [
    'fastapi',
    'dev',
    'src/server/main.py',
    '--host',
    '0.0.0.0',
  ]);

  const translated = controller.translateManifestEnvironment({
    DATABASE_URL: 'sqlite:////app/data/app.sqlite3',
    ROOT: '{app_root}',
    BACKEND: '{backend}',
    DATA: '{app_data}',
  }, backendDir);
  assert.equal(translated.DATABASE_URL, `sqlite:///${path.join(backendDir, 'data', 'app.sqlite3')}`);
  assert.equal(translated.ROOT, path.dirname(backendDir));
  assert.equal(translated.BACKEND, backendDir);
  assert.equal(translated.DATA, path.join(backendDir, 'data'));

  await controller.ensureSqliteDatabaseParent({ DATABASE_URL: translated.DATABASE_URL });
  assert.equal((await fs.stat(path.dirname(translated.DATABASE_URL.slice('sqlite:///'.length)))).isDirectory(), true);
  assert.equal(await controller.ensureSqliteDatabaseParent({ DATABASE_URL: 'postgres://db' }), undefined);
  assert.equal(await controller.ensureSqliteDatabaseParent({ DATABASE_URL: 'sqlite:///relative.db' }), undefined);
});

test('installed app runtime reports vault failures, restart fallback status, and direct status snapshots', async () => {
  const vault = makeInstalledRuntimeHarness({
    getSecretsStore: () => ({ resolveAppEnv: async () => {
      throw new Error('vault_unavailable');
    } }),
  });
  const vaultResult = await vault.controller.openInstalledAppUnlocked('demo-app');
  assert.equal(vaultResult.success, false);
  assert.equal(vaultResult.technicalCode, 'secrets_vault_unavailable');

  const encrypted = makeInstalledRuntimeHarness({
    getSecretsStore: () => ({ resolveAppEnv: async () => {
      throw new Error('secrets_encryption_unavailable');
    } }),
  });
  const encryptedResult = await encrypted.controller.openInstalledAppUnlocked('demo-app');
  assert.equal(encryptedResult.success, false);
  assert.equal(encryptedResult.technicalCode, 'secrets_encryption_unavailable');

  const restart = makeInstalledRuntimeHarness({
    getManifestAppSecretsValidationError: () => 'invalid secrets',
  });
  restart.registry.apps['demo-app'].status = 'running';
  restart.registry.apps['demo-app'].userMessage = 'running';
  restart.deps.runningApps.set('demo-app', {
    appId: 'demo-app',
    backend: new FakeChildProcess(),
    frontend: new FakeChildProcess(),
    backendUrl: 'http://127.0.0.1:1',
    frontendUrl: 'http://127.0.0.1:2',
    rawFrontendUrl: 'http://127.0.0.1:3',
    proxyServer: { close: (callback) => callback?.() },
  });
  const progress = [];
  const result = await restart.controller.restartInstalledApp('demo-app', { onProgress: (message) => progress.push(message) });
  assert.equal(result.success, false);
  assert.equal(result.technicalCode, 'invalid_app_secrets_manifest');
  assert.equal(restart.registry.apps['demo-app'].status, 'installed');
  assert.ok(progress.some((message) => message.includes('Deteniendo')));
  assert.equal(restart.controller.getRuntimeStatus('missing').status, 'not_installed');
  assert.equal(restart.controller.getRuntimeStatus('demo-app').status, 'installed');
});

test('installed app runtime stops running apps, records sync errors, and exposes running status', async () => {
  const backend = new FakeChildProcess();
  const frontend = new FakeChildProcess();
  let proxyClosed = false;
  const runtime = makeInstalledRuntimeHarness({
    syncAppToCloudIfEnabled: async () => {
      throw new Error('cloud_sync_failed');
    },
  });
  runtime.deps.runningApps.set('demo-app', {
    appId: 'demo-app',
    backend,
    frontend,
    backendUrl: 'http://127.0.0.1:3001',
    frontendUrl: 'http://127.0.0.1:3002',
    rawFrontendUrl: 'http://127.0.0.1:3003',
    proxyServer: { close: (callback) => {
      proxyClosed = true;
      callback?.();
    } },
  });

  assert.deepEqual(runtime.controller.getRuntimeStatus('demo-app'), {
    appId: 'demo-app',
    status: 'running',
    userMessage: 'App en ejecucion.',
    backendUrl: 'http://127.0.0.1:3001',
    frontendUrl: 'http://127.0.0.1:3002',
  });

  const result = await runtime.controller.stopInstalledApp('demo-app');

  assert.equal(result.success, true);
  assert.equal(backend.killed, true);
  assert.equal(frontend.killed, true);
  assert.equal(proxyClosed, true);
  assert.equal(runtime.deps.runningApps.has('demo-app'), false);
  assert.equal(runtime.registry.apps['demo-app'].status, 'installed');
  assert.ok(runtime.calls.some((call) => call[0] === 'runtimeStatus' && call[1].status === 'installed'));
  assert.ok(runtime.calls.some((call) => call[0] === 'log' && call[1] === 'cloud_sync:auto_error'));
});

test('installed app runtime treats missing running processes as already stopped', async () => {
  const alreadyStopped = makeInstalledRuntimeHarness();
  assert.deepEqual(await alreadyStopped.controller.stopInstalledApp('demo-app'), {
    success: true,
    userMessage: 'La app ya estaba detenida.',
  });
});

test('installed app runtime helper probes HTTP readiness, request bodies, free ports, and server close', async () => {
  const runtime = makeInstalledRuntimeHarness();
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url, options) => ({
      ok: url === 'http://127.0.0.1/health' && options.method === 'GET',
    });
    await runtime.controller.waitForHttpOk('http://127.0.0.1/health', 10);

    globalThis.fetch = async () => {
      throw new Error('offline');
    };
    await assert.rejects(
      runtime.controller.waitForHttpOk('http://127.0.0.1/missing', 1),
      /startup_timeout_http:\/\/127\.0\.0\.1\/missing/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  const body = Buffer.from('hello');
  assert.deepEqual(Buffer.from(runtime.controller.fetchBodyFromBuffer(body)), body);
  const port = await runtime.controller.getFreePort();
  assert.equal(Number.isInteger(port) && port > 0, true);

  const server = http.createServer((_request, response) => response.end('ok'));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  await runtime.controller.closeServer(server);
});

test('installed app runtime surfaces proxy port allocation failures before spawning services', async () => {
  const runtime = makeInstalledRuntimeHarness({
    http: {
      createServer: () => ({
        listen: (_port, _host, callback) => callback(),
        address: () => null,
        close: (callback) => callback?.(),
        on: () => undefined,
      }),
    },
  });

  await assert.rejects(
    runtime.controller.openInstalledAppUnlocked('demo-app', undefined, { openWindow: false }),
    /proxy_port_not_available/,
  );
});

test('installed app runtime termination covers forced kills, taskkill failures, and missing records', async () => {
  const runtime = makeInstalledRuntimeHarness({
    runCommand: async (command, args) => {
      runtime.calls.push(['run', command, args]);
      throw new Error('taskkill_failed');
    },
  });
  await withPlatform('win32', async () => {
    const child = new FakeChildProcess();
    await runtime.controller.terminateProcess(child);
    assert.ok(runtime.calls.some((call) => call[0] === 'run' && call[1] === 'taskkill'));
  });

  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const signals = [];
  try {
    globalThis.setTimeout = (callback) => {
      callback();
      return 1;
    };
    globalThis.clearTimeout = () => undefined;
    await runtime.controller.terminateProcess({
      killed: false,
      kill: (signal) => {
        signals.push(signal);
        return true;
      },
      once: () => undefined,
    });
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);

  const ghostBackend = new FakeChildProcess();
  const ghostFrontend = new FakeChildProcess();
  runtime.deps.runningApps.set('ghost-app', {
    appId: 'ghost-app',
    backend: ghostBackend,
    frontend: ghostFrontend,
    backendUrl: 'http://127.0.0.1:1',
    frontendUrl: 'http://127.0.0.1:2',
    rawFrontendUrl: 'http://127.0.0.1:3',
    proxyServer: { close: (callback) => callback?.() },
  });

  const stop = await runtime.controller.stopInstalledApp('ghost-app');
  assert.equal(stop.success, true);
  assert.equal(runtime.calls.some((call) => call[0] === 'upsert' && call[1].appId === 'ghost-app'), false);
});

test('installed app runtime restart reports stop failures instead of throwing', async () => {
  const runtime = makeInstalledRuntimeHarness();
  const backend = new FakeChildProcess();
  backend.kill = () => {
    throw new Error('kill_failed');
  };
  const frontend = new FakeChildProcess();
  runtime.deps.runningApps.set('demo-app', {
    appId: 'demo-app',
    backend,
    frontend,
    backendUrl: 'http://127.0.0.1:1',
    frontendUrl: 'http://127.0.0.1:2',
    rawFrontendUrl: 'http://127.0.0.1:3',
    proxyServer: { close: (callback) => callback?.() },
  });
  const progress = [];

  const result = await runtime.controller.restartInstalledApp('demo-app', { onProgress: (message) => progress.push(message) });

  assert.equal(result.success, false);
  assert.equal(result.technicalCode, 'kill_failed');
  assert.ok(progress.includes('No pude detener la app.'));
  assert.ok(runtime.calls.some((call) => call[0] === 'log' && call[1] === 'stop:failed'));
  assert.ok(runtime.calls.some((call) => call[0] === 'log' && call[1] === 'restart:failed' && call[2].phase === 'stop'));
});

test('installed app runtime restart success covers dev command defaults and uvicorn reloads', async (t) => {
  const root = await tmpRoot('installed-runtime-restart-success');
  const originalFetch = globalThis.fetch;
  const scriptPath = path.join(root, 'bin', 'service.js');
  const defaultInstallDir = path.join(root, 'apps', 'default-app');
  const uvicornInstallDir = path.join(root, 'apps', 'uvicorn-app');
  const fastapiInstallDir = path.join(root, 'apps', 'fastapi-app');
  let defaultRuntime;
  let defaultController;
  let uvicornRuntime;
  let fastapiRuntime;
  const orphanProcesses = [];
  t.after(async () => {
    if (defaultRuntime?.deps.runningApps.has('demo-app')) {
      await defaultController.stopInstalledApp('demo-app').catch(() => undefined);
    }
    if (uvicornRuntime?.deps.runningApps.has('demo-app')) {
      await uvicornRuntime.controller.stopInstalledApp('demo-app').catch(() => undefined);
    }
    if (fastapiRuntime?.deps.runningApps.has('demo-app')) {
      await fastapiRuntime.controller.stopInstalledApp('demo-app').catch(() => undefined);
    }
    for (const child of orphanProcesses) {
      child.kill?.('SIGTERM');
    }
    globalThis.fetch = originalFetch;
    await fs.rm(root, { recursive: true, force: true });
  });
  await makeExecutableNodeScript(scriptPath, 'setInterval(() => {}, 1000);\n');
  await fs.mkdir(path.join(defaultInstallDir, 'backend'), { recursive: true });
  await fs.mkdir(path.join(defaultInstallDir, 'frontend'), { recursive: true });
  await fs.mkdir(path.join(uvicornInstallDir, 'backend'), { recursive: true });
  await fs.mkdir(path.join(uvicornInstallDir, 'frontend'), { recursive: true });
  await fs.mkdir(path.join(fastapiInstallDir, 'backend'), { recursive: true });
  await fs.mkdir(path.join(fastapiInstallDir, 'frontend'), { recursive: true });
  globalThis.fetch = async () => new Response('ready', { status: 200 });

  class RestartBrowserWindow extends EventEmitter {
    constructor() {
      super();
      this.webContents = new EventEmitter();
      this.webContents.getURL = () => '';
      this.webContents.setWindowOpenHandler = () => undefined;
    }

    async loadURL() {}

    isDestroyed() {
      return false;
    }

    isMinimized() {
      return false;
    }

    show() {}

    focus() {}

    moveTop() {}

    close() {
      this.emit('closed');
    }
  }
  const createWithFakeElectron = loadInstalledRuntimeControllerWithFakeElectron(RestartBrowserWindow);
  defaultRuntime = makeInstalledRuntimeHarness({
    ensureRuntimeInstalled: async () => ({ node: scriptPath, npm: scriptPath, python: scriptPath, pip: scriptPath }),
    getVenvExecutables: () => ({ python: scriptPath, pip: scriptPath }),
    isDev: true,
  });
  defaultController = createWithFakeElectron(defaultRuntime.deps);
  defaultRuntime.registry.apps['demo-app'].installDir = defaultInstallDir;
  const progress = [];
  const restart = await defaultController.restartInstalledApp('demo-app', { onProgress: (message) => progress.push(message) });
  assert.equal(restart.success, true);
  assert.equal(restart.userMessage, 'App reiniciada correctamente.');
  assert.ok(progress.includes('App reiniciada correctamente.'));
  assert.ok(defaultRuntime.calls.some((call) => call[0] === 'log' && call[1] === 'restart:ready'));
  await defaultController.stopInstalledApp('demo-app');

  uvicornRuntime = makeInstalledRuntimeHarness({
    ensureRuntimeInstalled: async () => ({ node: scriptPath, npm: scriptPath, python: scriptPath, pip: scriptPath }),
    getVenvExecutables: () => ({ python: scriptPath, pip: scriptPath }),
    isDev: true,
    resolveInstalledManifest: async () => ({
      services: [
        { name: 'backend', command: 'uvicorn package.api:app --host 0.0.0.0 --port 9000 --log-level debug' },
      ],
    }),
  });
  uvicornRuntime.registry.apps['demo-app'].installDir = uvicornInstallDir;
  const uvicornOpen = await uvicornRuntime.controller.openInstalledAppUnlocked('demo-app', undefined, { openWindow: false });
  assert.equal(uvicornOpen.success, true);
  const running = uvicornRuntime.deps.runningApps.get('demo-app');
  orphanProcesses.push(running.backend, running.frontend);
  uvicornRuntime.deps.runningApps.delete('demo-app');
  running.backend.emit('exit', 0, null);
  await waitForCondition(() => uvicornRuntime.calls.some((call) => call[0] === 'log' && call[1] === 'open:backend:exit'));
  assert.equal(uvicornRuntime.calls.some((call) => call[0] === 'runtimeStatus' && call[1].status === 'error'), false);
  running.backend.kill('SIGTERM');
  running.frontend.kill('SIGTERM');
  await uvicornRuntime.controller.closeServer(running.proxyServer);

  fastapiRuntime = makeInstalledRuntimeHarness({
    ensureRuntimeInstalled: async () => ({ node: scriptPath, npm: scriptPath, python: scriptPath, pip: scriptPath }),
    getVenvExecutables: () => ({ python: scriptPath, pip: scriptPath }),
    resolveInstalledManifest: async () => ({
      services: [
        {
          name: 'backend',
          command: 'fastapi dev src/server/main.py --log-level info',
          environment: { PYTHONPATH: '{backend}/custom' },
        },
      ],
    }),
  });
  fastapiRuntime.registry.apps['demo-app'].installDir = fastapiInstallDir;
  const fastapiOpen = await fastapiRuntime.controller.openInstalledAppUnlocked('demo-app', undefined, { openWindow: false });
  assert.equal(fastapiOpen.success, true);
  await fastapiRuntime.controller.stopInstalledApp('demo-app');

  const defaultSpawn = defaultRuntime.calls.find((call) => call[0] === 'log' && call[1] === 'open:spawn');
  const uvicornSpawn = uvicornRuntime.calls.find((call) => call[0] === 'log' && call[1] === 'open:spawn');
  const fastapiSpawn = fastapiRuntime.calls.find((call) => call[0] === 'log' && call[1] === 'open:spawn');
  assert.ok(defaultSpawn[2].backend.args.includes('app.main:app'));
  assert.ok(defaultSpawn[2].backend.args.includes('--reload'));
  assert.ok(uvicornSpawn[2].backend.args.includes('package.api:app'));
  assert.ok(uvicornSpawn[2].backend.args.includes('--reload'));
  assert.equal(uvicornSpawn[2].backend.args[uvicornSpawn[2].backend.args.indexOf('--host') + 1], '127.0.0.1');
  assert.notEqual(uvicornSpawn[2].backend.args[uvicornSpawn[2].backend.args.indexOf('--port') + 1], '9000');
  assert.equal(uvicornSpawn[2].backend.args[uvicornSpawn[2].backend.args.indexOf('--log-level') + 1], 'debug');
  assert.ok(fastapiSpawn[2].backend.args.includes('server.main:app'));
  assert.equal(fastapiSpawn[2].backend.args.filter((arg) => arg === '--reload').length, 1);
  assert.equal(fastapiSpawn[2].backend.args[fastapiSpawn[2].backend.args.indexOf('--host') + 1], '127.0.0.1');
  assert.match(fastapiSpawn[2].backend.args[fastapiSpawn[2].backend.args.indexOf('--port') + 1], /^\d+$/);
  assert.equal(fastapiSpawn[2].backend.args[fastapiSpawn[2].backend.args.indexOf('--log-level') + 1], 'info');
  assert.match(fastapiSpawn[2].backend.environment.PYTHONPATH, /backend\/src/);
  assert.match(fastapiSpawn[2].backend.environment.PYTHONPATH, /backend\/custom/);
});

test('installed app runtime opens temp services, waits for URLs, proxies requests, and stops cleanly', async (t) => {
  const root = await tmpRoot('installed-runtime-open');
  const originalFetch = globalThis.fetch;
  const scriptPath = path.join(root, 'bin', 'service.js');
  const installDir = path.join(root, 'apps', 'demo-app');
  const capturePath = path.join(root, 'spawn-capture.jsonl');
  const fetchCalls = [];
  const originalCapturePath = process.env.CAPTURE_PATH;
  let runtime;
  process.env.CAPTURE_PATH = capturePath;
  t.after(async () => {
    if (runtime?.deps.runningApps.has('demo-app')) {
      await runtime.controller.stopInstalledApp('demo-app').catch(() => undefined);
    }
    if (originalCapturePath === undefined) {
      delete process.env.CAPTURE_PATH;
    } else {
      process.env.CAPTURE_PATH = originalCapturePath;
    }
    globalThis.fetch = originalFetch;
    await fs.rm(root, { recursive: true, force: true });
  });
  await makeExecutableNodeScript(scriptPath, `
const fs = require('node:fs');
fs.appendFileSync(process.env.CAPTURE_PATH, JSON.stringify({
  argv: process.argv.slice(2),
  appId: process.env.FORGER_APP_ID,
  hasGrant: Boolean(process.env.FORGER_APP_GRANT_SECRET),
  cors: process.env.CORS_ORIGINS,
  apiBase: process.env.VITE_API_BASE_URL,
  secret: process.env.API_KEY,
}) + '\\n');
setTimeout(() => {
  console.log('stdout secret-value');
  console.error('stderr secret-value');
}, 20);
setInterval(() => {}, 1000);
`);
  await fs.mkdir(path.join(installDir, 'backend'), { recursive: true });
  await fs.mkdir(path.join(installDir, 'frontend'), { recursive: true });

  globalThis.fetch = async (url, init = {}) => {
    const href = String(url);
    const body = init.body
      ? Buffer.from(await new Response(init.body).arrayBuffer()).toString('utf8')
      : undefined;
    fetchCalls.push({ href, method: init.method, headers: init.headers, body });
    if (href.endsWith('/fail-proxy')) {
      throw new Error('proxy_failed');
    }
    return new Response(`proxied:${href}`, {
      status: href.includes('/created') ? 201 : 200,
      headers: {
        'content-type': 'text/plain',
        'cache-control': 'no-store',
        'x-internal': 'not-forwarded',
      },
    });
  };

  runtime = makeInstalledRuntimeHarness({
    desktopRuntimeBridge: { environmentForApp: () => ({ BRIDGE_ENV: '1' }) },
    ensureRuntimeInstalled: async (type) => type === 'node'
      ? { node: scriptPath, npm: scriptPath }
      : { python: scriptPath, pip: scriptPath },
    formatProcessOutputForInstallLog: (text, secrets) => secrets.reduce(
      (current, secret) => current.split(secret).join('[secret]'),
      text,
    ),
    getSecretsStore: () => ({ resolveAppEnv: async () => ({
      env: { API_KEY: 'secret-value' },
      missingRequired: [],
      secretValues: ['secret-value'],
    }) }),
    getVenvExecutables: () => ({ python: scriptPath, pip: scriptPath }),
    resolveInstalledManifest: async () => ({
      services: [
        {
          name: 'backend',
          context: './backend',
          command: 'uvicorn custom.api:app --host 0.0.0.0 --port',
          healthcheck: 'ready',
          environment: {
            DATABASE_URL: 'sqlite:////app/data/app.sqlite3',
            CUSTOM_ROOT: '{app_root}',
          },
        },
        {
          name: 'frontend',
          context: './frontend',
          environment: { VITE_FLAG: '1' },
        },
      ],
    }),
    truncateForInstallLog: (value) => value.trim(),
  });
  runtime.registry.apps['demo-app'].installDir = installDir;

  const result = await runtime.controller.openInstalledAppUnlocked('demo-app', 'es-CL', { openWindow: false });
  await waitForCondition(() => runtime.calls.some((call) => call[0] === 'log' && call[1] === 'open:backend:stdout'));
  await waitForCondition(() => runtime.calls.some((call) => call[0] === 'log' && call[1] === 'open:backend:stderr'));
  await waitForCondition(() => runtime.calls.some((call) => call[0] === 'log' && call[1] === 'open:frontend:stdout'));
  await waitForCondition(() => runtime.calls.some((call) => call[0] === 'log' && call[1] === 'open:frontend:stderr'));

  assert.equal(result.success, true);
  assert.match(result.backendUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.match(result.frontendUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(runtime.controller.getRuntimeStatus('demo-app').status, 'running');
  assert.equal(runtime.registry.apps['demo-app'].status, 'installed');
  assert.ok(fetchCalls.some((call) => call.href === `${result.backendUrl}/ready`));
  assert.ok(fetchCalls.some((call) => call.href === runtime.deps.runningApps.get('demo-app').rawFrontendUrl));
  assert.ok(fetchCalls.some((call) => call.href === result.frontendUrl));
  assert.ok(runtime.calls.some((call) => call[0] === 'runtimeStatus' && call[1].status === 'running'));
  assert.ok(runtime.calls.some((call) => call[0] === 'log' && call[1] === 'open:backend:stdout' && call[2].text.includes('[secret]')));
  const runningProcesses = runtime.deps.runningApps.get('demo-app');
  runningProcesses.backend.emit('error', new Error('backend_error'));
  runningProcesses.frontend.emit('error', new Error('frontend_error'));
  await waitForCondition(() => runtime.calls.some((call) => call[0] === 'log' && call[1] === 'open:backend:error'));
  await waitForCondition(() => runtime.calls.some((call) => call[0] === 'log' && call[1] === 'open:frontend:error'));

  const proxyPost = await requestLocalHttp(result.frontendUrl, '/__forger_api/created?via=proxy', {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      cookie: 'private=1',
    },
    body: '{"ok":true}',
  });
  const postTarget = fetchCalls.find((call) => call.href === `${result.backendUrl}/created?via=proxy`);
  assert.equal(proxyPost.statusCode, 201);
  assert.equal(proxyPost.headers['content-type'], 'text/plain');
  assert.equal(proxyPost.headers['x-internal'], undefined);
  assert.equal(postTarget.method, 'POST');
  assert.deepEqual(postTarget.headers, {
    accept: 'application/json',
    'content-type': 'application/json',
  });
  assert.equal(postTarget.body, '{"ok":true}');

  const proxyGet = await requestLocalHttp(result.frontendUrl, '/dashboard');
  assert.equal(proxyGet.statusCode, 200);
  assert.ok(fetchCalls.some((call) => call.href === `${runningProcesses.rawFrontendUrl}/dashboard`));

  const proxyFailure = await requestLocalHttp(result.frontendUrl, '/fail-proxy');
  assert.equal(proxyFailure.statusCode, 502);
  assert.equal(proxyFailure.body, 'Forger app proxy failed.');

  const stop = await runtime.controller.stopInstalledApp('demo-app');
  assert.equal(stop.success, true);
  assert.equal(runtime.deps.runningApps.has('demo-app'), false);
  assert.ok(runtime.calls.some((call) => call[0] === 'syncCloud' && call[1] === 'demo-app'));

  const spawnCaptures = (await fs.readFile(capturePath, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.equal(spawnCaptures.length, 2);
  assert.ok(spawnCaptures.some((capture) => capture.argv.includes('custom.api:app') && capture.appId === 'demo-app'));
  assert.ok(spawnCaptures.some((capture) => capture.apiBase === `${result.frontendUrl}/__forger_api`));
  assert.ok(spawnCaptures.every((capture) => capture.secret === 'secret-value'));
});

test('installed app runtime reports open startup failures and cleans processes and proxy state', async (t) => {
  const root = await tmpRoot('installed-runtime-open-fail');
  const originalFetch = globalThis.fetch;
  const scriptPath = path.join(root, 'bin', 'service.js');
  const installDir = path.join(root, 'apps', 'demo-app');
  let runtime;
  t.after(async () => {
    if (runtime?.deps.runningApps.has('demo-app')) {
      await runtime.controller.stopInstalledApp('demo-app').catch(() => undefined);
    }
    globalThis.fetch = originalFetch;
    await fs.rm(root, { recursive: true, force: true });
  });
  await makeExecutableNodeScript(scriptPath, 'setInterval(() => {}, 1000);\n');
  await fs.mkdir(path.join(installDir, 'backend'), { recursive: true });
  await fs.mkdir(path.join(installDir, 'frontend'), { recursive: true });
  globalThis.fetch = async () => new Response('ready', { status: 200 });

  class ThrowingBrowserWindow extends EventEmitter {
    constructor() {
      super();
      this.webContents = new EventEmitter();
      this.webContents.getURL = () => '';
      this.webContents.setWindowOpenHandler = () => undefined;
    }

    async loadURL() {
      throw new Error('window_load_failed');
    }

    isDestroyed() {
      return false;
    }

    isMinimized() {
      return false;
    }

    close() {
      this.emit('closed');
    }
  }
  const createWithFakeElectron = loadInstalledRuntimeControllerWithFakeElectron(ThrowingBrowserWindow);
  runtime = makeInstalledRuntimeHarness({
    appAgentConversationManager: { rejectPendingPermissionsForApp: () => undefined },
    appAgentTaskManager: { rejectPendingPermissionsForApp: () => undefined },
    ensureRuntimeInstalled: async () => ({ node: scriptPath, npm: scriptPath, python: scriptPath, pip: scriptPath }),
    failureDiagnostic: (error, fallbackCode) => ({
      technicalCode: error instanceof Error ? error.message : fallbackCode,
      details: { phase: 'window' },
    }),
    getVenvExecutables: () => ({ python: scriptPath, pip: scriptPath }),
    resolveInstalledManifest: async () => ({ services: [{ name: 'backend', healthcheck: '/healthz' }] }),
  });
  const controller = createWithFakeElectron(runtime.deps);
  runtime.registry.apps['demo-app'].installDir = installDir;

  const result = await controller.openInstalledAppUnlocked('demo-app');

  assert.equal(result.success, false);
  assert.equal(result.technicalCode, 'window_load_failed');
  assert.equal(result.details.phase, 'window');
  assert.equal(runtime.deps.runningApps.has('demo-app'), false);
  assert.equal(runtime.registry.apps['demo-app'].status, 'error');
  assert.ok(runtime.calls.some((call) => call[0] === 'log' && call[1] === 'open:failed'));
});

test('installed app runtime records process crashes and closes the proxy without user stop state', async (t) => {
  const root = await tmpRoot('installed-runtime-crash');
  const originalFetch = globalThis.fetch;
  const scriptPath = path.join(root, 'bin', 'service.js');
  const installDir = path.join(root, 'apps', 'demo-app');
  let runtime;
  t.after(async () => {
    if (runtime?.deps.runningApps.has('demo-app')) {
      await runtime.controller.stopInstalledApp('demo-app').catch(() => undefined);
    }
    globalThis.fetch = originalFetch;
    await fs.rm(root, { recursive: true, force: true });
  });
  await makeExecutableNodeScript(scriptPath, 'setInterval(() => {}, 1000);\n');
  await fs.mkdir(path.join(installDir, 'backend'), { recursive: true });
  await fs.mkdir(path.join(installDir, 'frontend'), { recursive: true });
  globalThis.fetch = async () => new Response('ready', { status: 200 });

  runtime = makeInstalledRuntimeHarness({
    ensureRuntimeInstalled: async () => ({ node: scriptPath, npm: scriptPath, python: scriptPath, pip: scriptPath }),
    getVenvExecutables: () => ({ python: scriptPath, pip: scriptPath }),
  });
  runtime.registry.apps['demo-app'].installDir = installDir;

  const result = await runtime.controller.openInstalledAppUnlocked('demo-app', undefined, { openWindow: false });
  assert.equal(result.success, true);
  const running = runtime.deps.runningApps.get('demo-app');
  running.backend.kill('SIGTERM');
  await waitForCondition(() => !runtime.deps.runningApps.has('demo-app'));

  assert.equal(runtime.registry.apps['demo-app'].status, 'error');
  assert.ok(runtime.calls.some((call) => call[0] === 'runtimeStatus' && call[1].status === 'error'));
  running.frontend.kill('SIGTERM');
});

test('installed app runtime handles process termination, port, and window helper branches', async (t) => {
  const runtime = makeInstalledRuntimeHarness();
  const killed = new FakeChildProcess();
  killed.killed = true;
  await runtime.controller.terminateProcess(killed);
  assert.equal(runtime.calls.some((call) => call[0] === 'run'), false);

  await withPlatform('win32', async () => {
    const child = new FakeChildProcess();
    await runtime.controller.terminateProcess(child);
    assert.ok(runtime.calls.some((call) => call[0] === 'run' && call[1] === 'taskkill'));
  });

  const noAddressRuntime = makeInstalledRuntimeHarness({
    net: {
      createServer: () => ({
        listen: (_port, _host, callback) => callback(),
        address: () => null,
        close: () => undefined,
        on: () => undefined,
      }),
    },
  });
  await assert.rejects(noAddressRuntime.controller.getFreePort(), /port_not_available/);

  const closed = [];
  runtime.deps.appWindows.set('destroyed', {
    isDestroyed: () => true,
    close: () => closed.push('destroyed'),
  });
  runtime.deps.appWindows.set('active', {
    isDestroyed: () => false,
    close: () => closed.push('active'),
  });
  runtime.controller.closeAppWindow('destroyed');
  runtime.controller.closeAppWindow('active');
  assert.deepEqual(closed, ['active']);

  const prodWindow = { loadFile: async (file, options) => {
    closed.push(['loadFile', file, options]);
  } };
  await runtime.controller.loadDesktopWindow(prodWindow, { socialChat: '1' });
  assert.equal(closed.at(-1)[2].query.socialChat, '1');

  const originalDevServer = process.env.VITE_DEV_SERVER_URL;
  process.env.VITE_DEV_SERVER_URL = 'http://127.0.0.1:5173/';
  t.after(() => {
    if (originalDevServer === undefined) {
      delete process.env.VITE_DEV_SERVER_URL;
    } else {
      process.env.VITE_DEV_SERVER_URL = originalDevServer;
    }
  });
  const devUrls = [];
  const devRuntime = makeInstalledRuntimeHarness({ isDev: true });
  await devRuntime.controller.loadDesktopWindow({ loadURL: async (url) => devUrls.push(url) }, { friendUserId: '7' });
  assert.equal(devUrls[0], 'http://127.0.0.1:5173/?friendUserId=7');
});

test('installed app runtime BrowserWindow helpers keep app and friend windows constrained', async () => {
  class FakeBrowserWindow extends EventEmitter {
    static instances = [];

    constructor(options) {
      super();
      this.options = options;
      this.loadedUrls = [];
      this.loadedFiles = [];
      this.closed = false;
      this.destroyed = false;
      this.minimized = false;
      this.focused = true;
      this.flashStates = [];
      this.webContents = new EventEmitter();
      this.webContents.getURL = () => this.currentUrl ?? '';
      this.webContents.setWindowOpenHandler = (handler) => {
        this.openHandler = handler;
      };
      FakeBrowserWindow.instances.push(this);
    }

    async loadURL(url) {
      this.currentUrl = url;
      this.loadedUrls.push(url);
    }

    async loadFile(file, options) {
      this.loadedFiles.push([file, options]);
    }

    isDestroyed() {
      return this.destroyed;
    }

    isMinimized() {
      return this.minimized;
    }

    restore() {
      this.minimized = false;
    }

    show() {
      this.shown = true;
    }

    focus() {
      this.focusCalls = (this.focusCalls ?? 0) + 1;
    }

    moveTop() {
      this.movedTop = true;
    }

    isFocused() {
      return this.focused;
    }

    flashFrame(value) {
      this.flashStates.push(value);
    }

    close() {
      this.closed = true;
      this.emit('closed');
    }
  }
  const createWithFakeElectron = loadInstalledRuntimeControllerWithFakeElectron(FakeBrowserWindow);
  const calls = [];
  const runtime = makeInstalledRuntimeHarness({
    app: { getPath: () => '/tmp', getAppPath: () => '/tmp/app', focus: (options) => calls.push(['appFocus', options]) },
    appAgentConversationManager: { rejectPendingPermissionsForApp: (appId) => calls.push(['rejectConversation', appId]) },
    appAgentTaskManager: { rejectPendingPermissionsForApp: (appId) => calls.push(['rejectTask', appId]) },
    dispatchDeepLink: (link) => calls.push(['deepLink', link]),
    parseForgerUrl: (url) => ({ kind: 'open-app', url }),
    shell: { openExternal: async (url) => calls.push(['external', url]) },
    wait: async () => undefined,
  });
  const controller = createWithFakeElectron(runtime.deps);

  await controller.openOrFocusAppWindow('demo-app', 'Demo App', 'http://127.0.0.1:3000/app', 'es-CL');
  const appWindow = FakeBrowserWindow.instances[0];
  assert.equal(appWindow.options.webPreferences.nodeIntegration, false);
  assert.equal(appWindow.options.webPreferences.contextIsolation, true);
  assert.equal(appWindow.options.webPreferences.sandbox, true);
  assert.equal(appWindow.loadedUrls[0], 'http://127.0.0.1:3000/app?forgerLocale=es-CL');

  const blockedNavigation = { prevented: false, preventDefault() { this.prevented = true; } };
  appWindow.webContents.emit('will-navigate', blockedNavigation, 'https://example.com/docs');
  assert.equal(blockedNavigation.prevented, true);
  assert.deepEqual(calls.at(-1), ['external', 'https://example.com/docs']);

  appWindow.webContents.emit('will-navigate', { preventDefault() {} }, 'forger://open/demo-app');
  assert.equal(calls.some((call) => call[0] === 'deepLink'), true);
  appWindow.webContents.emit('will-navigate', { preventDefault() {} }, 'not a url');

  assert.deepEqual(appWindow.openHandler({ url: 'http://127.0.0.1:3000/settings' }), { action: 'deny' });
  assert.equal(appWindow.loadedUrls.at(-1), 'http://127.0.0.1:3000/settings');
  assert.deepEqual(appWindow.openHandler({ url: 'mailto:hello@example.com' }), { action: 'deny' });
  assert.deepEqual(calls.at(-1), ['external', 'mailto:hello@example.com']);
  assert.deepEqual(appWindow.openHandler({ url: 'also not a url' }), { action: 'deny' });

  appWindow.minimized = true;
  await controller.openOrFocusAppWindow('demo-app', 'Demo App', 'http://127.0.0.1:3000/other');
  assert.equal(appWindow.loadedUrls.at(-1), 'http://127.0.0.1:3000/other');
  assert.equal(appWindow.shown, true);
  appWindow.loadURL = async () => {
    throw new Error('reload_failed');
  };
  await controller.openOrFocusAppWindow('demo-app', 'Demo App', 'http://127.0.0.1:3000/reload-fails');
  runtime.deps.runningApps.set('demo-app', {
    appId: 'demo-app',
    backend: new FakeChildProcess(),
    frontend: new FakeChildProcess(),
    backendUrl: 'http://127.0.0.1:4100',
    frontendUrl: 'http://127.0.0.1:3000/running',
    rawFrontendUrl: 'http://127.0.0.1:3000/running',
    proxyServer: { close: (callback) => callback?.() },
  });
  const runningResult = await controller.openInstalledAppUnlocked('demo-app', 'es-CL');
  assert.equal(runningResult.success, true);

  appWindow.close();
  assert.equal(runtime.deps.appWindows.has('demo-app'), false);
  assert.ok(calls.some((call) => call[0] === 'rejectTask' && call[1] === 'demo-app'));
  assert.ok(calls.some((call) => call[0] === 'rejectConversation' && call[1] === 'demo-app'));

  const openedFriend = await controller.openOrFocusFriendChatWindowForFriend({
    id: 42,
    username: 'ana',
    firstName: ' Ana ',
  });
  assert.equal(openedFriend.action, 'opened');
  const friendWindow = FakeBrowserWindow.instances[1];
  assert.equal(friendWindow.options.title, 'Ana · Social');
  assert.equal(friendWindow.loadedFiles[0][1].query.friendUsername, 'ana');

  friendWindow.minimized = true;
  friendWindow.focused = false;
  const existingFriend = await withPlatform('darwin', async () => await controller.openOrFocusFriendChatWindow({
    friend: { id: 42, username: 'ana' },
  }));
  assert.equal(existingFriend.action, 'already-open');
  assert.equal(friendWindow.movedTop, true);
  assert.deepEqual(friendWindow.flashStates, [true]);
  assert.ok(calls.some((call) => call[0] === 'appFocus'));
  friendWindow.focused = true;
  const focusedFriend = await controller.openOrFocusFriendChatWindowForFriend({
    id: 42,
    username: 'ana',
  });
  assert.equal(focusedFriend.action, 'focused-existing');
  friendWindow.emit('closed');
  assert.equal(runtime.deps.friendChatWindows.has(42), false);
});
