import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
const require = createRequire(import.meta.url);

test('channel files are scoped to the host workspace and stop being readable after revocation', async () => {
  const { callWhatsAppChannelFileTool } = require('../../dist-electron/main/forger-mcp/whatsapp-channel-files.js');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'channel-tools-'));
  const session = { caller: 'personal-agent', runId: 'run', personalAgentId: 'agent', personalAgentConversationId: 'conversation', whatsappChannel: {}, whatsappChannelWorkspaceRoot: root };
  let granted = true;
  const reader = async () => granted ? { appIds: [], toolIds: [], connectionGrants: [], peerAgentGrants: [] } : null;
  try {
    await fs.mkdir(path.join(root, 'shared'));
    await fs.writeFile(path.join(root, 'shared', 'example.txt'), 'shared text');
    assert.deepEqual(await callWhatsAppChannelFileTool(session, 'whatsapp_channel_files_list', {}, reader), { success: true, files: [{ path: 'shared/example.txt', sizeBytes: 11 }] });
    assert.deepEqual(await callWhatsAppChannelFileTool(session, 'whatsapp_channel_files_read', { path: 'shared/example.txt' }, reader), { success: true, path: 'shared/example.txt', text: 'shared text', nextOffset: null });
    const invalid = await callWhatsAppChannelFileTool(session, 'whatsapp_channel_files_read', { path: '../private.txt' }, reader);
    assert.equal(invalid.success, false);
    granted = false;
    const revoked = await callWhatsAppChannelFileTool(session, 'whatsapp_channel_files_read', { path: 'shared/example.txt' }, reader);
    assert.equal(revoked.technicalCode, 'whatsapp_channel_unavailable');
    assert.equal('text' in revoked, false);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('file tools fail closed for invalid inputs, unbound sessions and permission changes during reads', async () => {
  const { callWhatsAppChannelFileTool } = require('../../dist-electron/main/forger-mcp/whatsapp-channel-files.js');
  const current = { appIds: [], toolIds: [], connectionGrants: [], peerAgentGrants: [] };
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'channel-tools-'));
  const session = { caller: 'personal-agent', runId: 'run', personalAgentId: 'agent', personalAgentConversationId: 'conversation', whatsappChannel: {}, whatsappChannelWorkspaceRoot: root };
  const call = (tool, args, reader = async () => current, context = session) => callWhatsAppChannelFileTool(context, tool, args, reader);
  try {
    for (const change of [{ caller: 'app-agent' }, { whatsappChannel: undefined }, { whatsappChannelWorkspaceRoot: undefined }]) assert.equal((await call('whatsapp_channel_files_list', {}, undefined, { ...session, ...change })).success, false);
    for (const args of [null, [], 'text', { unknown: 1 }]) assert.equal((await call('whatsapp_channel_files_list', args)).technicalCode, 'whatsapp_channel_file_unavailable');
    for (const args of [{}, { path: 4 }, { path: 'shared/file', extra: 4 }, { path: 'shared/file', offset: 'bad' }, { path: 'shared/file', offset: -1 }]) assert.equal((await call('whatsapp_channel_files_read', args)).success, false);
    assert.equal((await call('unexpected', {})).success, false);
    assert.equal((await call('whatsapp_channel_files_list', undefined)).success, true);
    let reads = 0;
    assert.equal((await call('whatsapp_channel_files_list', {}, async () => ++reads === 1 ? current : null)).technicalCode, 'whatsapp_channel_unavailable');
    assert.equal((await call('whatsapp_channel_files_list', {}, async () => { throw new Error('private-error'); })).technicalCode, 'whatsapp_channel_unavailable');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
