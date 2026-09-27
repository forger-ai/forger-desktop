import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
const require = createRequire(import.meta.url);
const load = (name) => require(`../../dist-electron/main/repository-collaboration/${name}.js`);
async function directory(t) {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'repo-boundary-')));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    return root;
}
test('runtime registers intake before startup, is idempotent, drains both services and releases its database', async (t) => {
    const runtime = load('runtime');
    await runtime.stopRepositoryCollaborationRuntime();
    assert.throws(runtime.getRepositoryCollaborationService, /unavailable/);
    const root = await directory(t);
    let handler;
    let stops = 0;
    const connections = { setWhatsAppMessageHandler: (next) => { handler = next; }, stop: async () => { stops++; throw Error('offline'); } };
    const options = { metadataRoot: root, connections, sourceCodexHome: () => root, resolveRuntime: async () => { throw Error('not needed'); } };
    await runtime.startRepositoryCollaborationRuntime(options);
    const service = runtime.getRepositoryCollaborationService();
    assert.ok(handler);
    await handler({ live: false });
    await runtime.startRepositoryCollaborationRuntime(options);
    assert.equal(runtime.getRepositoryCollaborationService(), service);
    await runtime.stopRepositoryCollaborationRuntime();
    assert.equal(stops, 1);
    assert.equal(handler, undefined);
    assert.throws(runtime.getRepositoryCollaborationService, /unavailable/);
    await runtime.stopRepositoryCollaborationRuntime();
    const mock = t.mock.method(load('service').RepositoryCollaborationService.prototype, 'start', () => { throw Error('startup failure'); });
    await assert.rejects(runtime.startRepositoryCollaborationRuntime(options), /startup failure/);
    assert.equal(handler, undefined);
    assert.throws(runtime.getRepositoryCollaborationService, /unavailable/);
    mock.mock.restore();
    await runtime.startRepositoryCollaborationRuntime(options);
    await runtime.stopRepositoryCollaborationRuntime();
});
test('composition resolves only an authenticated supported runtime lazily and starts connections after collaboration', async (t) => {
    const runtime = load('runtime');
    let options;
    let authenticated = false;
    let cli = null;
    let profile;
    t.mock.method(runtime, 'startRepositoryCollaborationRuntime', async (input) => { options = input; });
    const { createRepositoryCollaborationHooks, startRepositoryConnections } = load('composition');
    let downloaded = 0;
    const hooks = createRepositoryCollaborationHooks({
        getForgerMetadataRoot: () => '/meta', getConnectionsService: () => ({}), getCodexHome: () => '/auth',
        getCodexRoot: () => '/codex', resolvePlatformAlias: () => 'macos-arm64', getRuntimesRoot: () => '/runtime',
        getCodexAuthStatus: async () => ({ authenticated }), resolveCodexCliPath: async () => cli,
        chooseAgentRuntime: async () => ({ authProfileId: profile, model: 'test-model', effort: 'high' }),
        ensureRuntimeInstalled: async () => { downloaded++; return 'node'; }, getRuntimePathEntries: () => ['/node/bin'],
    });
    await hooks.startRepositoryCollaboration();
    assert.equal(downloaded, 0);
    assert.equal(options.sourceCodexHome(), '/auth');
    await assert.rejects(options.resolveRuntime(), /auth_required/);
    authenticated = true;
    await assert.rejects(options.resolveRuntime(), /runtime_missing/);
    cli = '/codex/cli';
    profile = 'other-profile';
    await assert.rejects(options.resolveRuntime(), /auth_required/);
    for (profile of [undefined, 'codex:system', 'codex:local-active']) {
        const result = await options.resolveRuntime();
        assert.equal(result.authenticated, true);
        assert.deepEqual(result.pathEntries, ['/node/bin']);
    }
    const events = [];
    const logger = { step: async (name, fn) => { events.push(name); await fn(); } };
    const base = { state: {}, startupLogger: logger, appendInstallLog: async (name) => events.push(name), getConnectionsService: () => ({ load: async () => events.push('load'), start: async () => events.push('listen') }) };
    await startRepositoryConnections({ ...base, startRepositoryCollaboration: async () => { events.push('intake'); } });
    assert.ok(events.indexOf('intake') < events.indexOf('listen'));
    await startRepositoryConnections({ ...base, startRepositoryCollaboration: async () => { throw Error('unavailable'); } });
    assert.ok(events.includes('repository_collaboration:start_failed'));
    await startRepositoryConnections({ ...base, getConnectionsService: () => undefined });
    await startRepositoryConnections({ ...base, getConnectionsService: () => ({ load: async () => { } }) });
});
test('selection rejects empty and ambiguous work while preserving single-project and repeated-alias intent', () => {
    const { selectRepositories } = load('commands');
    const repos = [{ id: 'a', name: 'Web' }, { id: 'b', name: 'Web app' }];
    assert.equal(selectRepositories('Web:  ', repos), null);
    assert.equal(selectRepositories('in Web app fix', repos), null);
    assert.equal(selectRepositories('in Missing fix', repos), null);
    assert.equal(selectRepositories(' ', [repos[0]]), null);
    assert.deepEqual(selectRepositories('fix this', [repos[0]]), { repositoryIds: ['a'], prompt: 'fix this' });
    assert.deepEqual(selectRepositories('Web + Web: fix', repos), { repositoryIds: ['a'], prompt: 'fix' });
});
test('store removes only linked grants and persists atomic completion, nullable results and filtered snapshots', async (t) => {
    const store = new (load('store').RepositoryCollaborationStore)(path.join(await directory(t), 'db.sqlite'));
    t.after(() => store.close());
    const group = store.configureGroup({ connectionId: 'c', chatId: 'g', title: 'Group', enabled: true }, 1);
    const repository = store.addRepository(group.id, 'Repo', '/tmp/repo');
    store.setAccess({ groupId: group.id, participantId: 'p', displayName: 'P', repositoryIds: [repository.id] });
    const task = store.createTask({ groupId: group.id, participantId: 'p', participantName: 'P', repositoryIds: [repository.id], prompt: 'work', sourceMessageId: 'm', conversationId: 'existing' }, 2);
    store.completeTaskWithOutput(task.id, { status: 'completed', result: null, conversationId: 'next' }, { groupId: group.id, taskId: task.id, participantId: 'p', text: 'done' }, 3);
    assert.equal(store.task(task.id).conversationId, 'next');
    assert.equal(store.outbox().length, 1);
    store.removeRepository(group.id, repository.id);
    assert.deepEqual(store.repositories(group.id), []);
    assert.deepEqual(store.allowedRepositoryIds(group.id, 'p'), []);
    assert.deepEqual(store.snapshot('other').tasks, []);
});
test('transport rejects unverified rosters and malformed receipts, preserves pagination and exact participant identities', async () => {
    const { WhatsAppRepositoryTransport } = load('whatsapp-transport');
    let response;
    const calls = [];
    let now = 0;
    const transport = new WhatsAppRepositoryTransport({ call: async (input) => { calls.push(input); return typeof response === 'function' ? response(input) : response; } }, { now: () => now, sleep: async (ms) => { now += ms; } });
    response = { success: false };
    await assert.rejects(transport.listGroups('c'), /unavailable/);
    response = { success: true, data: null };
    assert.deepEqual(await transport.listGroups('c'), []);
    let page = 0;
    response = () => ({ success: true, data: { chats: [null, [], { chatId: 3 }, { chatId: 'private@s.whatsapp.net' }, { chatId: 'g@g.us' }], nextCursor: ++page ? 'same' : 'unused' } });
    assert.deepEqual(await transport.listGroups('c'), [{ chatId: 'g@g.us', title: 'g@g.us' }, { chatId: 'g@g.us', title: 'g@g.us' }]);
    assert.equal(calls.at(-1).input.cursor, 'same');
    await assert.rejects(transport.listParticipants('c', 'private'), /group_required/);
    for (const bad of [undefined, [], {}, { type: 'group' }, { type: 'group', metadata: { id: 'wrong' } }, { type: 'group', metadata: { id: 'g@g.us', participants: [] } }]) {
        response = { success: bad?.metadata?.id === 'g@g.us' ? false : true, data: bad };
        await assert.rejects(transport.listParticipants('c', 'g@g.us'), /membership_unavailable/);
    }
    response = { success: true, data: { type: 'group', metadata: { id: 'g@g.us', participants: [{ id: 'invalid' }] } } };
    await assert.rejects(transport.listParticipants('c', 'g@g.us'), /identity_unverified/);
    response = { success: true, data: { type: 'group', selfIds: ['p@lid'], metadata: { id: 'g@g.us', participants: [{ id: 'p@lid', name: 'Self' }] } } };
    assert.deepEqual(await transport.listParticipants('c', 'g@g.us'), [{ participantId: 'p@lid', displayName: 'Self', isSelf: true }]);
    const send = (extra = {}) => transport.sendMessage({ connectionId: 'c', chatId: 'g@g.us', text: 'Result', ...extra });
    await assert.rejects(send({ chatId: 'private' }), /message_invalid/);
    await assert.rejects(send({ text: ' ' }), /message_invalid/);
    for (response of [{ success: false }, { success: true, data: { sent: false } }, { success: true, data: { sent: true } }, { success: true, data: { sent: true, stableMessageRef: 'bad' } }, { success: true, data: { sent: true, stableMessageRef: Buffer.from(JSON.stringify({ remoteJid: 'other@g.us', id: 'x', fromMe: true })).toString('base64url') } }])
        await assert.rejects(send(), /send_failed/);
    response = { success: false, technicalCode: 'whatsapp_send_rate_limited' };
    const before = calls.length;
    await assert.rejects(send(), /send_failed/);
    assert.equal(calls.length - before, 3);
    response = { success: true, data: { sent: true, stableMessageRef: Buffer.from(JSON.stringify({ remoteJid: 'g@g.us', id: 'sent', fromMe: true })).toString('base64url') } };
    assert.deepEqual(await send({ replyToMessageId: 'source' }), { messageId: 'sent' });
    assert.equal(calls.at(-1).input.replyToMessageId, 'source');
});
test('process reports stderr, spawn failure, inactivity and callback failure without leaking child errors', async () => {
    const { runRepositoryProcess } = load('process');
    let stderr = '';
    const result = await runRepositoryProcess(process.execPath, ['-e', 'process.stderr.write("warning")'], { cwd: os.tmpdir(), onStderr: (text) => { stderr += text; } });
    assert.equal(result.stderr, 'warning');
    assert.equal(stderr, 'warning');
    await assert.rejects(runRepositoryProcess('/definitely-missing-forger-fixture', [], { cwd: os.tmpdir() }), /start_failed/);
    await assert.rejects(runRepositoryProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { cwd: os.tmpdir(), inactivityTimeoutMs: 20 }), /inactivity_timeout/);
    await assert.rejects(runRepositoryProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { cwd: os.tmpdir(), onChild: () => { throw Error('private'); } }), /callback_failed/);
    const killed = await runRepositoryProcess(process.execPath, ['-e', 'process.kill(process.pid,"SIGTERM")'], { cwd: os.tmpdir() });
    assert.equal(killed.code, 1);
});
test('executor rejects unsafe roots, unavailable authentication, mismatched runtimes and incomplete results before accepting work', async (t) => {
    const { RepositoryCodexExecutor, validateRepositoryRoots, resolveRepositoryDeveloperTools } = load('codex-executor');
    const root = await directory(t), repo = path.join(root, 'repo'), auth = path.join(root, 'auth'), runtimeRoot = path.join(root, 'runtime');
    await fs.mkdir(path.join(repo, '.git'), { recursive: true });
    await fs.mkdir(auth);
    for (const roots of [[], Array(11).fill(repo), ['relative'], [path.parse(root).root], [os.homedir()]])
        await assert.rejects(validateRepositoryRoots(roots), /roots_invalid/);
    const file = path.join(root, 'file');
    await fs.writeFile(file, 'fixture');
    await assert.rejects(validateRepositoryRoots([file]), /roots_invalid/);
    const noGit = path.join(root, 'no-git');
    await fs.mkdir(noGit);
    await assert.rejects(validateRepositoryRoots([noGit]), /git_metadata/);
    const tools = path.join(root, 'git-runtime');
    await fs.mkdir(path.join(tools, 'bin'), { recursive: true });
    await fs.writeFile(path.join(tools, 'bin', 'git'), 'fixture');
    const discovered = await resolveRepositoryDeveloperTools({ cwd: root, env: {}, gitRoot: tools });
    assert.deepEqual(discovered.pathEntries, [path.join(tools, 'bin')]);
    const runtime = { cliPath: '/usr/bin/true', pathEntries: [root], model: 'test', effort: 'medium', authenticated: true };
    let version = { code: 0, stdout: 'codex-cli 0.144.1', stderr: '' };
    let output = { code: 0, stdout: '', stderr: '' };
    const options = { root: runtimeRoot, platform: 'darwin', sourceCodexHome: () => auth, resolveRuntime: async () => runtime, resolveDeveloperTools: async () => ({ pathEntries: [], readRoots: [tools], environment: {} }), runProcess: async (_cmd, args) => args.includes('--version') ? version : output };
    const input = { task: { id: 't', groupId: 'g', participantId: 'p' }, repositories: [{ id: 'r', groupId: 'g', name: 'Repo', root: repo }], prompt: 'work', signal: new AbortController().signal };
    const run = (extra = {}, overrides = {}) => new RepositoryCodexExecutor({ ...options, ...overrides }).run({ ...input, ...extra });
    await assert.rejects(run({}, { platform: 'linux' }), /platform_unsupported/);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(run({ signal: controller.signal }), /cancelled/);
    runtime.authenticated = false;
    await assert.rejects(run(), /auth_required/);
    runtime.authenticated = true;
    runtime.cliPath = '';
    await assert.rejects(run(), /runtime_missing/);
    runtime.cliPath = '/usr/bin/true';
    await assert.rejects(run(), /auth_required/);
    await fs.symlink(file, path.join(auth, 'auth.json'));
    await assert.rejects(run(), /auth_required/);
    await fs.unlink(path.join(auth, 'auth.json'));
    await fs.writeFile(path.join(auth, 'auth.json'), JSON.stringify({ tokens: { account_id: 'fixture-account' } }));
    await assert.rejects(run({}, { root: path.join(repo, 'runtime') }), /roots_invalid/);
    for (version of [{ code: 1, stdout: '', stderr: '' }, { code: 0, stdout: 'codex-cli wrong', stderr: '' }])
        await assert.rejects(run(), /runtime_unsupported/);
    version = { code: 0, stdout: 'codex-cli 0.144.1', stderr: '' };
    await assert.rejects(run(), /result_missing/);
    output = { code: 0, stdout: JSON.stringify({ type: 'thread.started', thread_id: 'session' }), stderr: '' };
    await assert.rejects(run(), /result_missing/);
    output = { code: 0, stdout: [{ type: 'thread.started', thread_id: 'session' }, { type: 'item.completed', item: { type: 'agent_message', text: 'Done' } }].map(JSON.stringify).join('\n'), stderr: '' };
    const progress = [];
    assert.equal((await run({ onProgress: (text) => progress.push(text) })).conversationId, 'session');
    assert.equal(progress.length, 1);
    output.stdout = JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Continued' } });
    assert.equal((await run({ conversationId: 'session' })).text, 'Continued');
    const sessionFile = (await fs.readdir(path.join(runtimeRoot, 'sessions')))[0];
    const sessionPath = path.join(runtimeRoot, 'sessions', sessionFile);
    const session = JSON.parse(await fs.readFile(sessionPath, 'utf8'));
    await fs.writeFile(sessionPath, JSON.stringify({ ...session, conversationId: 'other' }));
    await assert.rejects(run({ conversationId: 'session' }), /conversation_invalid/);
    await fs.writeFile(sessionPath, JSON.stringify({ ...session, directory: root }));
    await assert.rejects(run({ conversationId: 'session' }), /conversation_invalid/);
    await fs.writeFile(sessionPath, JSON.stringify(session));
    const copied = path.join(session.directory, 'codex', 'auth.json');
    await fs.unlink(copied);
    await fs.symlink(path.join(auth, 'auth.json'), copied);
    await assert.rejects(run({ conversationId: 'session' }), /symlink_root/);
    await fs.unlink(copied);
    const home = path.join(session.directory, 'work', 'home');
    await fs.rmdir(home);
    await fs.symlink(root, home);
    await assert.rejects(run({ conversationId: 'session' }), /symlink_root/);
    await fs.writeFile(path.join(auth, 'auth.json'), '{}');
    await assert.rejects(run(), /result_missing/);
});
test('developer tools discovery fails closed on invalid xcode selection and escaped Git runtime paths', async (t) => {
    const { resolveRepositoryDeveloperTools, RepositoryCodexExecutor } = load('codex-executor');
    const root = await directory(t);
    let result = { code: 1, stdout: '', stderr: '' };
    t.mock.method(load('process'), 'runRepositoryProcess', async () => result);
    const resolve = (gitRoot) => resolveRepositoryDeveloperTools({ cwd: root, env: {}, gitRoot });
    await assert.rejects(resolve(path.join(root, 'missing')), /runtime_missing/);
    result = { code: 0, stdout: 'relative', stderr: '' };
    await assert.rejects(resolve(), /runtime_missing/);
    result.stdout = path.parse(root).root;
    await assert.rejects(resolve(), /runtime_unsupported/);
    result.stdout = os.homedir();
    await assert.rejects(resolve(), /runtime_unsupported/);
    const developer = path.join(root, 'developer');
    await fs.mkdir(path.join(developer, 'usr', 'bin'), { recursive: true });
    await fs.writeFile(path.join(developer, 'usr', 'bin', 'git'), 'fixture');
    result.stdout = developer;
    const valid = await resolve();
    assert.deepEqual(valid.readRoots, [developer]);
    await fs.unlink(path.join(developer, 'usr', 'bin', 'git'));
    await fs.symlink(process.execPath, path.join(developer, 'usr', 'bin', 'git'));
    await assert.rejects(resolve(), /runtime_unsupported/);
    await fs.unlink(path.join(developer, 'usr', 'bin', 'git'));
    await fs.mkdir(path.join(developer, 'usr', 'bin', 'git'));
    await assert.rejects(resolve(), /runtime_unsupported/);
    await fs.rmdir(path.join(developer, 'usr', 'bin', 'git'));
    await fs.rmdir(path.join(developer, 'usr', 'bin'));
    await fs.symlink('/usr/bin', path.join(developer, 'usr', 'bin'));
    await assert.rejects(resolve(), /runtime_unsupported/);
    const repo = path.join(root, 'repo'), auth = path.join(root, 'auth'), git = path.join(root, 'git');
    await fs.mkdir(path.join(repo, '.git'), { recursive: true });
    await fs.mkdir(auth);
    await fs.writeFile(path.join(auth, 'auth.json'), '{}');
    await fs.mkdir(path.join(git, 'bin'), { recursive: true });
    await fs.writeFile(path.join(git, 'bin', 'git'), 'fixture');
    const executor = new RepositoryCodexExecutor({ root: path.join(root, 'run'), sourceCodexHome: () => auth, resolveRuntime: async () => ({ authenticated: true, cliPath: '/usr/bin/true', pathEntries: [], gitRoot: git, model: 'test', effort: 'low' }) });
    result = { code: 1, stdout: '', stderr: '' };
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    try {
        await assert.rejects(executor.run({ task: { groupId: 'g' }, repositories: [{ root: repo }], prompt: 'work', signal: new AbortController().signal }), /runtime_unsupported/);
    } finally {
        Object.defineProperty(process, 'platform', platformDescriptor);
    }
});
test('process handles input pipe failure, abort during registration and repeated terminal events exactly once', async (t) => {
    const { EventEmitter } = await import('node:events');
    const cp = require('node:child_process');
    const { runRepositoryProcess } = load('process');
    let child;
    let start;
    let kills = 0;
    t.mock.method(cp, 'spawn', () => { child = new EventEmitter(); child.pid = 1234567; child.kill = () => { kills++; }; child.stdout = new EventEmitter(); child.stdout.setEncoding = () => { }; child.stderr = new EventEmitter(); child.stderr.setEncoding = () => { }; child.stdin = new EventEmitter(); child.stdin.end = () => { queueMicrotask(() => start(child)); }; return child; });
    t.mock.method(process, 'kill', () => { throw Error('already exited'); });
    start = (c) => { c.stdin.emit('error', Error('private')); c.stdout.emit('data', 'ignored after failure'); c.emit('close', 0); c.emit('close', 0); c.emit('error', Error('late')); };
    await assert.rejects(runRepositoryProcess('fixture', [], { cwd: os.tmpdir() }), /input_failed/);
    assert.equal(kills, 1);
    let reads = 0;
    start = (c) => c.emit('close', null);
    const signal = { get aborted() { return ++reads > 1; }, addEventListener() { }, removeEventListener() { } };
    await assert.rejects(runRepositoryProcess('fixture', [], { cwd: os.tmpdir(), signal }), /cancelled/);
    start = (c) => { c.pid = undefined; c.stdin.emit('error', Error('pipe')); c.emit('close', null); };
    await assert.rejects(runRepositoryProcess('fixture', [], { cwd: os.tmpdir() }), /input_failed/);
});
test('repository validation rejects non-roots and supports Windows case-insensitive overlap', async (t) => {
    const { validateRepositoryRoot, validateRepositoryName, rootsOverlap } = load('repository-validation');
    const root = await directory(t);
    const cp = require('node:child_process');
    cp.execFileSync('git', ['init', '--quiet', root]);
    const nested = path.join(root, 'nested');
    await fs.mkdir(nested);
    await fs.mkdir(path.join(nested, '.git'));
    await assert.rejects(validateRepositoryRoot(nested), /repositorio Git/);
    await assert.rejects(validateRepositoryRoot(42), /válida/);
    assert.throws(() => validateRepositoryName(42), /nombre/);
    assert.throws(() => validateRepositoryName('x'.repeat(81)), /nombre/);
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    try {
        assert.equal(rootsOverlap('/CASE', '/case/child'), true);
        assert.equal(rootsOverlap('/case/child', '/CASE'), true);
        assert.equal(rootsOverlap('/case', '/different'), false);
        await validateRepositoryRoot(root);
    }
    finally {
        Object.defineProperty(process, 'platform', descriptor);
    }
});
test('store fails closed when SQLite is unavailable and preserves activation when updating an active group', async (t) => {
    const module = require('../../dist-electron/main/personal-agents/sqlite.js');
    const filename = path.join(await directory(t), 'db');
    const mock = t.mock.method(module, 'openPersonalAgentSqliteDatabase', () => null);
    assert.throws(() => new (load('store').RepositoryCollaborationStore)(filename), /almacenamiento/);
    mock.mock.restore();
    const store = new (load('store').RepositoryCollaborationStore)(filename);
    t.after(() => store.close());
    const input = { connectionId: 'c', chatId: 'g', title: 'first', enabled: true };
    const first = store.configureGroup(input, 1);
    assert.equal(store.configureGroup({ ...input, title: 'renamed' }, 5).activatedAt, first.activatedAt);
    assert.equal(store.taskFromReply(first.id, 'missing'), undefined);
    const transaction = store.transaction.bind(store);
    assert.throws(() => transaction(() => { throw Error('rollback-test'); }), /rollback-test/);
    assert.equal(transaction(() => 42), 42);
});
test('SQLite transaction depth recovers even when the database rejects rollback', async (t) => {
    const store = new (load('store').RepositoryCollaborationStore)(path.join(await directory(t), 'db'));
    t.after(() => store.close());
    const execute = store.db.exec.bind(store.db);
    const mock = t.mock.method(store.db, 'exec', (sql) => { if (sql === 'ROLLBACK')
        throw Error('storage disconnected'); return execute(sql); });
    assert.throws(() => store.transaction(() => { throw Error('write failed'); }), /storage disconnected/);
    assert.equal(store.transactionDepth, 0);
    mock.mock.restore();
    execute('ROLLBACK');
});
test('failed commit rolls back the complete transaction and permits a subsequent write', async (t) => {
    const store = new (load('store').RepositoryCollaborationStore)(path.join(await directory(t), 'db'));
    t.after(() => store.close());
    const execute = store.db.exec.bind(store.db);
    const mock = t.mock.method(store.db, 'exec', (sql) => { if (sql === 'COMMIT')
        throw Error('commit failed'); return execute(sql); });
    assert.throws(() => store.transaction(() => store.configureGroup({ connectionId: 'c', chatId: 'g', title: 'G', enabled: false }, 1)), /commit failed/);
    assert.equal(store.findGroup('c', 'g'), undefined);
    mock.mock.restore();
    assert.equal(store.transactionDepth, 0);
    assert.ok(store.transaction(() => store.configureGroup({ connectionId: 'c', chatId: 'g', title: 'G', enabled: false }, 2)));
});
