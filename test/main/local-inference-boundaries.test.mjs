import assert from 'node:assert/strict';
import test from 'node:test';
import Module, { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
const require = createRequire(import.meta.url);

function load(relative, mocks) {
  const filename = require.resolve(`../../dist-electron/main/${relative}.js`);
  const original = Module._load;
  delete require.cache[filename];
  Module._load = function(request, parent, isMain) {
    if (parent?.filename === filename && request in mocks) return mocks[request];
    return original.call(this, request, parent, isMain);
  };
  try { return require(filename); } finally { Module._load = original; }
}

test('hardware probe bounds the native command and safely handles missing or failed display information', async () => {
  for (const error of [null, new Error('probe unavailable')]) {
    const { collectLocalHardware } = load('local-development/hardware', {
      'node:child_process': { execFile(command, args, options, callback) {
        assert.equal(command, '/usr/sbin/system_profiler');
        assert.deepEqual(args, ['SPDisplaysDataType', '-json']);
        assert.equal(options.timeout, 5000);
        callback(error, '{"SPDisplaysDataType":[{"sppci_model":"   "},{"sppci_model":"GPU"}]}');
      } },
    });
    const result = await collectLocalHardware('/unused', {
      system: { platform: () => 'darwin', arch: () => 'arm64', release: () => 'test', cpus: () => [], totalmem: () => 1, freemem: () => 0 },
      disk: async () => ({ bavail: 0n, bsize: 1n }),
    });
    if (error) assert.ok(result.unavailable.includes('gpu_detection_failed'));
    else assert.deepEqual(result.gpu.devices, [{ name: 'GPU', backendReported: null, usableMemoryBytes: null }]);
  }
});

test('local process cancellation handles platform termination failure without leaking the child', (t) => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  t.after(() => Object.defineProperty(process, 'platform', originalPlatform));
  let killed = 0;
  const child = { pid: 12345, kill: () => { killed++; } };
  for (const systemRoot of [undefined, 'C:\\Synthetic']) {
    const originalRoot = process.env.SystemRoot;
    if (systemRoot) process.env.SystemRoot = systemRoot; else delete process.env.SystemRoot;
    t.after(() => { if (originalRoot === undefined) delete process.env.SystemRoot; else process.env.SystemRoot = originalRoot; });
    Object.defineProperty(process, 'platform', { value: 'win32' });
    for (const result of [{ status: 0 }, { status: 1 }, { error: Error('taskkill') }]) {
      const { stopLocalProcessTree } = load('llm-provider/local/process', { 'node:child_process': { spawnSync: () => result } });
      stopLocalProcessTree(undefined);
      stopLocalProcessTree(child);
    }
  }
  assert.equal(killed, 4);
  Object.defineProperty(process, 'platform', { value: 'linux' });
  const kill = process.kill;
  t.mock.method(process, 'kill', () => { throw Error('group gone'); });
  const { stopLocalProcessTree } = load('llm-provider/local/process', {});
  stopLocalProcessTree({ pid: 1, kill: () => { throw Error('already gone'); } });
  assert.notEqual(process.kill, kill);
});

test('local capture handles callback failures, stdin errors and late output after termination', async () => {
  for (const scenario of ['stdout', 'stderr', 'child', 'stdin', 'epipe', 'normal']) {
    let child;
    const { runLocalCommandCapture } = load('llm-provider/local/process', { 'node:child_process': { spawn: (_command, _args, options) => {
      assert.deepEqual(options.env, {});
      child = new EventEmitter();
      child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = new EventEmitter();
      child.stdin.end = () => queueMicrotask(() => {
        if (scenario === 'stdin' || scenario === 'epipe') child.stdin.emit('error', { code: scenario === 'epipe' ? 'EPIPE' : 'EIO' });
        child.stdout.emit('data', Buffer.from('output'));
        child.stderr.emit('data', Buffer.from('diagnostic'));
        child.emit('close', scenario === 'normal' ? null : 0);
      });
      return child;
    } } });
    const result = runLocalCommandCapture('fixture', [], {
      cwd: '/unused',
      onChild: scenario === 'child' ? () => { throw Error('callback'); } : undefined,
      onStdout: scenario === 'stdout' ? () => { throw Error('callback'); } : undefined,
      onStderr: scenario === 'stderr' ? () => { throw Error('callback'); } : undefined,
    });
    if (['stdout', 'stderr', 'child'].includes(scenario)) await assert.rejects(result, /local_callback_failed/);
    else if (scenario === 'stdin') await assert.rejects(result, /local_cli_stdin_failed/);
    else assert.equal((await result).code, scenario === 'normal' ? 1 : 0);
  }
});

test('context discovery caps traversal and rejects raced, invalid or secret-bearing excerpts', async (t) => {
  const fs = await import('node:fs/promises'); const os = await import('node:os'); const path = await import('node:path');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forger-context-limits-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const { inventoryContextFiles, readContextExcerpt } = load('llm-provider/local/context-files', {});
  await assert.rejects(inventoryContextFiles(root, AbortSignal.abort()), /local_cancelled/);
  await assert.rejects(readContextExcerpt(root, { path: '../outside.py' }, [], 1), /file_changed/);
  await assert.rejects(readContextExcerpt(root, { path: 'missing.py' }, [], 1), /file_changed/);
  await fs.mkdir(path.join(root, ...Array(14).fill('deep')), { recursive: true });
  assert.equal((await inventoryContextFiles(root)).truncated, true);
  await fs.rm(path.join(root, 'deep'), { recursive: true });
  await Promise.all(Array.from({ length: 40 }, (_, i) => fs.writeFile(path.join(root, `${i}_${'a'.repeat(200)}.py`), 'source')));
  assert.equal((await inventoryContextFiles(root)).truncated, true);
  await fs.rm(root, { recursive: true }); await fs.mkdir(root);
  await fs.writeFile(path.join(root, 'source.py'), 'x');
  await fs.link(path.join(root, 'source.py'), path.join(root, 'linked.py'));
  assert.equal((await inventoryContextFiles(root)).files.length, 0);
  await fs.unlink(path.join(root, 'linked.py'));
  for (const content of ['\0', Buffer.from([255]), 'safe', '-----BEGIN PRIVATE KEY-----']) {
    await fs.writeFile(path.join(root, 'source.py'), content);
    const inventory = await inventoryContextFiles(root);
    const result = readContextExcerpt(inventory.root, inventory.files[0], [], 0);
    if (content === 'safe') assert.equal((await result).lines, 0);
    else await assert.rejects(result, /local_context_(file_changed|sensitive_content)/);
  }
  const stat = { isDirectory: () => true, isFile: () => true, isSymbolicLink: () => false, nlink: 1, size: 1, dev: 1, ino: 1, mtimeMs: 1 };
  const entry = { name: 'source.py', isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false };
  for (const count of [2, 2001]) {
    const mod = load('llm-provider/local/context-files', { 'node:fs/promises': {
      realpath: async (p) => p, lstat: async () => stat,
      opendir: async () => ({ async *[Symbol.asyncIterator]() { for(let i=0;i<count;i++) yield entry; } }),
    } });
    const inventory = await mod.inventoryContextFiles('/fixture');
    assert.equal(inventory.truncated, count > 80);
  }
  for (const scenario of ['realpath', 'changed', 'short']) {
    let reads = 0;
    const mod = load('llm-provider/local/context-files', { 'node:fs/promises': {
      realpath: async (p) => scenario === 'realpath' ? '/elsewhere' : p,
      lstat: async () => stat,
      open: async () => ({ stat: async () => scenario === 'changed' && reads ? { ...stat, ino: 2 } : stat,
        read: async (buffer) => { reads++; buffer.write('x'); return { bytesRead: scenario === 'short' ? 0 : 1 }; }, close: async () => {} }),
    } });
    await assert.rejects(mod.readContextExcerpt('/fixture', { ...stat, path: 'source.py' }, [], 100), /file_changed/);
  }
});

test('context HTTP refuses a cancelled request before opening a connection', async () => {
  const { readContextResponse } = load('llm-provider/local/context-http', {});
  await assert.rejects(readContextResponse('http://127.0.0.1:1', '{}', AbortSignal.abort()), /local_cancelled/);
});

test('context preprocessing sanitizes dependency failures and cancellation after reading excerpts', async () => {
  for (let failure of ['invalid', 'primitive', 'unknown', 'inventory', 'cancel']) {
    let stage = 0;
    let controller = new AbortController();
    const { prepareLocalContext } = load('llm-provider/local/context-preprocessor', {
      './context-http': { readContextResponse: async () => {
        stage++;
        if (failure === 'primitive') throw 'sensitive';
        if (failure === 'unknown') throw Error('sensitive');
        return { done: true, message: { content: JSON.stringify(failure === 'invalid' ? [] : stage === 1 ? { goal: 'fix', constraints: [], searchTerms: [] } : { fileIds: ['f1'] }) } };
      } },
      './context-files': { inventoryContextFiles: async () => { if (failure === 'inventory') throw 'private'; return { root: '/fixture', files: [{ id: 'f1', path: 'source.py' }], bytes: 1, truncated: false }; },
        readContextExcerpt: async () => { if (failure === 'cancel') controller.abort(); return { text: '', bytes: 0, lines: 0, truncated: false }; } },
    });
    await assert.rejects(prepareLocalContext({ config: { runtime: 'ollama', endpoint: 'http://127.0.0.1:1', modelDigest: 'a'.repeat(64), contextStrategy: 'staged-v1', model: 'fixture', contextWindow: 4096 }, prompt: 'fix', workingDir: '/fixture', signal: controller.signal, onEvidence: () => {} }), /local_(context_invalid_response|context_failed|cancelled)/);
    failure = 'success'; stage = 0; controller = new AbortController();
    await prepareLocalContext({ config: { runtime: 'ollama', endpoint: 'http://127.0.0.1:1', modelDigest: 'a'.repeat(64), contextStrategy: 'staged-v1', model: 'fixture', contextWindow: 4096 }, prompt: 'fix', workingDir: '/fixture', signal: controller.signal, onEvidence: () => {} });
  }
});

test('gateway rejects invalid endpoint and unusable listener addresses', async () => {
  for (const address of [null, 'unix']) {
    const server = new EventEmitter(); server.setTimeout = () => {}; server.listen = (_port, _host, callback) => callback(); server.address = () => address;
    const { createLocalInferenceGateway } = load('llm-provider/local/gateway', { 'node:http': { createServer: () => server } });
    await assert.rejects(createLocalInferenceGateway({ endpoint: 'https://remote', model: 'fixture', timeoutMs: 100 }), /local_endpoint_invalid/);
    await assert.rejects(createLocalInferenceGateway({ endpoint: 'http://127.0.0.1:1', model: 'fixture', timeoutMs: 100 }), /local_gateway_start_failed/);
  }
});

test('gateway refuses unauthenticated traffic and ignores further data after an oversized body', async () => {
  let handler;
  const server = new EventEmitter(); server.setTimeout = () => {}; server.listen = (_port, _host, callback) => callback(); server.address = () => ({ port: 123 });
  server.closeAllConnections = () => {}; server.close = (callback) => callback();
  const { createLocalInferenceGateway } = load('llm-provider/local/gateway', { 'node:http': { createServer: (callback) => { handler = callback; return server; } } });
  const gateway = await createLocalInferenceGateway({ endpoint: 'http://127.0.0.1:1', model: 'fixture', timeoutMs: 100 });
  for (const auth of [undefined, `Bearer ${gateway.token}`]) {
    const request = new EventEmitter(); Object.assign(request, { headers: auth ? { authorization: auth } : {}, url: '/v1/responses', method: 'POST', resume() {} });
    const statuses = []; const response = { writeHead: (status) => statuses.push(status), end() {}, destroy() {} };
    handler(request, response);
    if (auth) { request.emit('data', Buffer.alloc(2 * 1024 * 1024 + 1)); request.emit('data', Buffer.from('late')); request.emit('end'); }
    assert.deepEqual(statuses, [auth ? 413 : 401]);
  }
  await gateway.close();
});

test('local execution preserves failure evidence across setup, cancellation and late provider rejection', async (t) => {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  t.after(() => Object.defineProperty(process, 'platform', descriptor));
  for (let scenario of ['windows', 'profile-failure', 'resolve-failure', 'cancel-launch', 'late-failure']) {
    const controller = new AbortController();
    if (scenario === 'windows') Object.defineProperty(process, 'platform', { value: 'win32' });
    else Object.defineProperty(process, 'platform', descriptor);
    const { runLocalInference } = load('llm-provider/local/run', {
      'node:fs/promises': { realpath: async () => '/', lstat: async () => { throw Object.assign(Error(), { code: 'ENOENT' }); }, mkdtemp: async () => '/fixture', mkdir: async () => {}, rm: async () => {} },
      '../adapters/codex-cli-adapter': { codexCliAdapter: { resolveCommand: async () => { if (scenario === 'resolve-failure') throw 'private'; return { command: 'codex', prefixArgs: [], pathEntries: [] }; } }, parseCodexJsonl: () => ({ assistantText: 'done' }) },
      './preflight': { validateLocalConfig: () => 'http://127.0.0.1:1', validateLocalContextRequest: () => {}, preflightLocalModel: async () => ({}) },
      './profiles': { prepareLocalAgentProfile: async () => { if (scenario === 'profile-failure') throw 'private'; return { evidence: {}, settings: [] }; } },
      './gateway': { createLocalInferenceGateway: async () => ({ baseUrl: 'http://127.0.0.1:1', token: 'synthetic', close: async () => {} }) },
      './process': { stopLocalProcessTree: () => {} },
    });
    const input = { runtime: { provider: 'codex', model: 'fixture' }, surface: 'app_prompt_task', mode: 'task', environment: {}, prompt: 'fix', localInference: { model: 'fixture' }, workingDir: '/fixture', pathEntries: [], timeoutMs: 1000, signal: controller.signal,
      onEvent: (event) => { if (scenario === 'cancel-launch' && event.type === 'started') controller.abort(); },
      runCommandCapture: async () => { if (scenario === 'late-failure') { controller.abort(); throw Error('provider failed after cancellation'); } return { code: 0, stdout: '', stderr: '' }; },
    };
    if (scenario === 'windows') assert.equal((await runLocalInference(input, 'codex')).assistantText, 'done');
    else await assert.rejects(runLocalInference(input, 'codex'), /local_(cli_failed|cancelled)/);
    scenario = 'success';
    assert.equal((await runLocalInference({ ...input, signal: undefined }, 'codex')).assistantText, 'done');
  }
});
