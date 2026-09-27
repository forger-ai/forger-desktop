import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { AgentStore } = require('../../dist-electron/main/personal-agents/agent-store.js');
const { AgentConversationManager } = require('../../dist-electron/main/personal-agents/agent-conversation-manager.js');
const wait = async (manager, id) => {
  for (let i = 0; i < 500; i++) {
    const c = await manager.getConversation(id);
    if (c.activeRun?.status === 'completed') return c;
    if (c.activeRun?.status === 'failed') throw new Error(c.activeRun.error);
    await new Promise(r => setTimeout(r, 10));
  }
  throw new Error('run timeout');
};

test('WhatsApp uses explicit memories and a separate workspace, even with legacy full capabilities enabled', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'forger-channel-privacy-'));
  const store = new AgentStore({ metadataRoot: path.join(root, 'metadata'), forgerHomeRoot: path.join(root, 'home') });
  try {
    const agent = await store.createAgent({ name: 'Ana', instructions: 'Be concise.', permissionMode: 'unsafe', networkAccess: true });
    const privateWorkspace = await store.workspaceRootForAgent(agent.id);
    await writeFile(path.join(privateWorkspace, 'private.txt'), 'PRIVATE_FILE_CANARY');
    await store.createMemory({ agentId: agent.id, title: 'Private', content: 'PRIVATE_MEMORY_CANARY' });
    const shared = await store.createMemory({ agentId: agent.id, title: 'Shared', content: 'SHARED_MEMORY_CANARY' });
    const inputs = [];
    const manager = new AgentConversationManager({ store, metadataRoot: path.join(root, 'metadata'), runner: async input => { inputs.push(input); return { assistantText: 'Visible response' }; } });
    const conversation = await manager.createWhatsAppConversation({ agentId: agent.id });
    const channel = { kind: 'whatsapp', connectionId: 'account', chatId: 'chat', bindingId: 'binding', revision: 1, allowAgentCapabilities: true,
      policy: { appIds: [], toolIds: [], connectionGrants: [], peerAgentIds: [], networkAccess: false, sharedMemoryIds: [shared.id] } };
    await manager.sendWhatsAppMessage({ conversationId: conversation.id, content: 'Summarize', channel });
    await wait(manager, conversation.id);
    assert.equal(inputs.length, 1);
    assert.doesNotMatch(inputs[0].prompt, /PRIVATE_MEMORY_CANARY|PRIVATE_FILE_CANARY/);
    assert.match(inputs[0].prompt, /SHARED_MEMORY_CANARY/);
    assert.notEqual(inputs[0].workspaceRoot, privateWorkspace);
    assert.ok(!inputs[0].workspaceRoot.startsWith(privateWorkspace + path.sep));
    assert.deepEqual(inputs[0].sharedRoots, []);
    assert.equal(inputs[0].agent.permissionMode, 'safe');
    assert.equal(inputs[0].agent.networkAccess, false);
    assert.equal(inputs[0].conversation.providerThreadId ?? null, null);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('effective selections intersect current permissions and never restore revoked access', () => {
  const { effectiveAgentForWhatsAppChannel } = require('../../dist-electron/main/personal-agents/whatsapp-channel-policy.js');
  const agent = { id: 'agent', permissionMode: 'unsafe', runtime: { permissionMode: 'unsafe' }, networkAccess: false, canSpawnAgents: true, appIds: ['allowed'], toolIds: ['tool'], peerAgentGrants: [{ agentId: 'peer' }], connectionGrants: [{ type: 'gmail', actions: ['read', 'send'], multiple: false, connectionIds: ['account'] }] };
  const policy = { appIds: ['allowed', 'revoked'], toolIds: [], networkAccess: true, peerAgentIds: ['revoked'], sharedMemoryIds: [], connectionGrants: [{ type: 'gmail', actions: ['read', 'delete'], multiple: true, connectionIds: ['account', 'revoked'] }] };
  const effective = effectiveAgentForWhatsAppChannel(agent, policy);
  assert.deepEqual(effective.appIds, ['allowed']);
  assert.deepEqual(effective.toolIds, []);
  assert.deepEqual(effective.peerAgentGrants, []);
  assert.deepEqual(effective.connectionGrants, [{ type: 'gmail', actions: ['read'], multiple: false, connectionIds: ['account'] }]);
  assert.equal(effective.networkAccess, false);
  assert.equal(effective.runtime.permissionMode, 'safe');
  assert.equal(effective.canSpawnAgents, false);
  assert.deepEqual(effectiveAgentForWhatsAppChannel(agent).appIds, []);
  assert.deepEqual(effectiveAgentForWhatsAppChannel(agent).connectionGrants, []);
});

test('channel file access permits shared documents and rejects traversal, symlinks, and binary data', async () => {
  const { stageWhatsAppChannelFiles, listWhatsAppChannelFiles, readWhatsAppChannelFile } = require('../../dist-electron/main/personal-agents/whatsapp-channel-context.js');
  const { mkdir, symlink } = await import('node:fs/promises');
  const root = await mkdtemp(path.join(tmpdir(), 'forger-channel-files-'));
  try {
    const workspace = path.join(root, 'workspace');
    await mkdir(workspace);
    const source = path.join(root, 'source.txt');
    await writeFile(source, 'Explicitly selected document');
    await stageWhatsAppChannelFiles(workspace, [{ id: 'shared-id', name: 'notes.txt', absolutePath: source }]);
    const files = await listWhatsAppChannelFiles(workspace);
    assert.equal(files.length, 1);
    assert.equal((await readWhatsAppChannelFile(workspace, files[0].path)).text, 'Explicitly selected document');
    await assert.rejects(readWhatsAppChannelFile(workspace, '../source.txt'), /file_invalid/);
    await assert.rejects(readWhatsAppChannelFile(workspace, source), /file_invalid/);
    await symlink(source, path.join(workspace, 'private-link'));
    await assert.rejects(readWhatsAppChannelFile(workspace, 'private-link'), /file_invalid/);
    await writeFile(path.join(workspace, 'shared', 'binary'), Buffer.from([0, 1, 2]));
    await assert.rejects(readWhatsAppChannelFile(workspace, 'shared/binary'), /binary_requires_app/);
    await assert.rejects(readWhatsAppChannelFile(workspace, files[0].path, -1), /offset_invalid/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('connection selections preserve default-account semantics without widening explicit accounts', () => {
  const { intersectConnectionGrants } = require('../../dist-electron/main/personal-agents/whatsapp-channel-policy.js');
  const grant = { type: 'gmail', actions: ['read'], multiple: true };
  assert.deepEqual(intersectConnectionGrants([grant], [{ ...grant, actions: ['send'] }]), []);
  assert.deepEqual(intersectConnectionGrants([{ ...grant, connectionIds: ['private'] }], [{ ...grant, connectionIds: ['other'] }]), []);
  assert.deepEqual(intersectConnectionGrants([grant], [grant]), [grant]);
  assert.deepEqual(intersectConnectionGrants([grant], [{ ...grant, connectionIds: ['selected'] }]), [{ ...grant, connectionIds: ['selected'] }]);
  assert.deepEqual(intersectConnectionGrants([{ ...grant, connectionIds: ['current'] }], [grant]), [{ ...grant, connectionIds: ['current'] }]);
});

test('file sharing is idempotent, paginated, and rejects directories, symlink targets and invalid paths', async () => {
  const context = require('../../dist-electron/main/personal-agents/whatsapp-channel-context.js');
  const { mkdir, symlink } = await import('node:fs/promises');
  const root = await mkdtemp(path.join(tmpdir(), 'forger-channel-file-boundaries-'));
  try {
    const workspace = await context.prepareWhatsAppChannelWorkspace(root, 'binding', 1);
    assert.notEqual(workspace, await context.prepareWhatsAppChannelWorkspace(root, 'binding', 2));
    const source = path.join(root, 'selected.txt');
    await writeFile(source, 'A'.repeat(65537));
    const selected = [{ id: 'selected', name: 'notes.txt', absolutePath: source }];
    await context.stageWhatsAppChannelFiles(workspace, selected);
    await context.stageWhatsAppChannelFiles(workspace, selected);
    const files = await context.listWhatsAppChannelFiles(workspace);
    assert.equal(files.length, 1);
    const first = await context.readWhatsAppChannelFile(workspace, files[0].path);
    assert.equal(first.text.length, 65536);
    assert.equal(first.nextOffset, 65536);
    const second = await context.readWhatsAppChannelFile(workspace, files[0].path, first.nextOffset);
    assert.equal(second.text, 'A');
    assert.equal(second.nextOffset, null);
    await assert.rejects(context.stageWhatsAppChannelFiles(workspace, [{ id: 'dir', name: '', absolutePath: root }]), /shared_file_too_large/);
    for (const candidate of ['', '../private', '/etc/passwd', 'shared/../private', 'shared/./notes', 'shared//notes', 'shared\\notes', '.forger/config']) {
      await assert.rejects(context.readWhatsAppChannelFile(workspace, candidate), /file_invalid/);
    }
    await assert.rejects(context.readWhatsAppChannelFile(workspace, 'shared'), /file_invalid/);
    await symlink(source, path.join(workspace, 'shared', 'symlink'));
    await assert.rejects(context.readWhatsAppChannelFile(workspace, 'shared/symlink'), /file_invalid/);
    await mkdir(path.join(workspace, '.forger'));
    await writeFile(path.join(workspace, '.forger', 'private-config'), 'not shared');
    assert.equal((await context.listWhatsAppChannelFiles(workspace)).length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a fresh channel prompt does not replay answers or memory from a previous policy generation', () => {
  const { buildWhatsAppChannelPrompt } = require('../../dist-electron/main/personal-agents/whatsapp-channel-context.js');
  const agent = { id: 'agent', name: 'Ana', description: '', purpose: '', instructions: '' };
  const conversation = { messages: [{ runId: 'old', role: 'assistant', content: 'REVOKED_ANSWER' }, { runId: 'current', role: 'user', content: 'Current task' }] };
  const prompt = buildWhatsAppChannelPrompt(agent, conversation, { id: 'current' }, [{ id: 'memory', agentId: 'other', title: 'Other agent', content: 'OTHER_PRIVATE' }], { sharedMemoryIds: ['memory'] });
  assert.doesNotMatch(prompt, /REVOKED_ANSWER|OTHER_PRIVATE/);
  assert.match(prompt, /Current task/);
  const empty = buildWhatsAppChannelPrompt(agent, { messages: [] }, { id: 'none' }, []);
  assert.doesNotMatch(empty, /undefined/);
});

test('channel files preserve UTF-8 pages and bound deep or very large listings', async () => {
  const context = require('../../dist-electron/main/personal-agents/whatsapp-channel-context.js');
  const { mkdir } = await import('node:fs/promises');
  const root = await mkdtemp(path.join(tmpdir(), 'forger-channel-list-limits-'));
  let fallback;
  try {
    fallback = await context.prepareWhatsAppChannelWorkspace(undefined, root, 1);
    const shared = path.join(root, 'shared');
    await mkdir(shared);
    const content = 'a'.repeat(65535) + '😀último';
    await writeFile(path.join(shared, 'unicode'), content);
    const first = await context.readWhatsAppChannelFile(root, 'shared/unicode');
    const second = await context.readWhatsAppChannelFile(root, 'shared/unicode', first.nextOffset);
    assert.equal(first.text + second.text, content);
    assert.equal((await context.readWhatsAppChannelFile(root, 'shared/unicode', 1_000_000)).text, '');
    const deep = path.join(shared, ...Array.from({ length: 13 }, (_, i) => `d${i}`));
    await mkdir(deep, { recursive: true });
    await writeFile(path.join(deep, 'hidden'), 'too deep');
    assert.equal((await context.listWhatsAppChannelFiles(root)).length, 1);
    await Promise.all(Array.from({ length: 101 }, (_, i) => writeFile(path.join(shared, `file-${i}`), 'selected')));
    assert.equal((await context.listWhatsAppChannelFiles(root)).length, 100);
  } finally {
    await rm(root, { recursive: true, force: true });
    if (fallback) await rm(fallback, { recursive: true, force: true });
  }
});

test('channel files reject a directory replaced by a symlink during validation and surface failed copies', async () => {
  const context = require('../../dist-electron/main/personal-agents/whatsapp-channel-context.js');
  const fs = require('node:fs/promises');
  const root = await mkdtemp(path.join(tmpdir(), 'forger-channel-file-race-'));
  const originalRealpath = fs.realpath;
  const originalOpen = fs.open;
  const originalReaddir = fs.readdir;
  try {
    await fs.mkdir(path.join(root, 'shared'));
    const source = path.join(root, 'selected');
    await writeFile(source, 'selected');
    await writeFile(path.join(root, 'shared', 'candidate'), 'shared');
    fs.realpath = async value => String(value).endsWith('/shared/candidate') ? path.join(tmpdir(), 'outside-channel') : originalRealpath(value);
    await assert.rejects(context.resolveWhatsAppChannelFile(root, 'shared/candidate'), /file_invalid/);
    fs.realpath = originalRealpath;
    fs.open = async (value, flags, mode) => {
      if (flags === 'wx') throw Object.assign(new Error('copy denied'), { code: 'EACCES' });
      return originalOpen(value, flags, mode);
    };
    await assert.rejects(context.stageWhatsAppChannelFiles(root, [{ id: 'file', name: 'copy', absolutePath: source }]), /copy denied/);
    fs.open = originalOpen;
    // Special filesystem entries (for example named pipes) are never documents.
    fs.readdir = async (value, options) => String(value).endsWith('/shared')
      ? [{ name: 'pipe', isSymbolicLink: () => false, isDirectory: () => false, isFile: () => false }]
      : originalReaddir(value, options);
    assert.deepEqual(await context.listWhatsAppChannelFiles(root), []);
  } finally {
    fs.realpath = originalRealpath;
    fs.open = originalOpen;
    fs.readdir = originalReaddir;
    await rm(root, { recursive: true, force: true });
  }
});
