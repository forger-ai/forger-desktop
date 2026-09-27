import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { AgentConversationManager } = require('../../dist-electron/main/personal-agents/agent-conversation-manager.js');
const providers = require('../../dist-electron/main/llm-provider/run-service.js');
const activity = require('../../dist-electron/main/chat/agent-run-activity.js');
const pixels = Buffer.from('SYNTHETIC_PRIVATE_PIXEL_DATA_'.repeat(12000)).toString('base64');

const runFixture = async (t, provider, failure, channel = true) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forger-channel-output-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const originalProvider = providers.createLlmProviderRunService;
  const originalPersist = activity.persistAgentRunActivity;
  const persisted = [], progress = [];
  activity.persistAgentRunActivity = async (_root, value) => { persisted.push(JSON.stringify(value)); };
  const event = provider === 'codex'
    ? { type: 'item.completed', item: { type: 'mcp_tool_call', name: 'whatsapp_channel_current_images', result: { content: [{ type: 'image', data: pixels, mimeType: 'image/png' }] } } }
    : { type: 'user', message: { content: [{ type: 'tool_result', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: pixels } }] }] } };
  providers.createLlmProviderRunService = () => ({ run: async ({ onOutput }) => {
    const raw = JSON.stringify(event) + '\n';
    onOutput('stdout', raw); // Complete native tool event.
    for (let offset = 0; offset < raw.length; offset += 4096) onOutput('stdout', raw.slice(offset, offset + 4096));
    onOutput('stderr', `provider debug ${pixels}`);
    onOutput('meta', JSON.stringify(event));
    onOutput('stdout', JSON.stringify(provider === 'codex'
      ? { type: 'item.completed', item: { type: 'agent_message', text: 'Veo un triángulo verde.' } }
      : { type: 'assistant', message: { content: [{ type: 'text', text: 'Veo un triángulo verde.' }] } }) + '\n');
    if (failure === 'throws') throw new Error(raw);
    return { code: failure ? 1 : 0, stdout: raw, stderr: failure === 'stderr' ? pixels : '', assistantText: 'TRIÁNGULO VERDE' };
  } });
  const manager = new AgentConversationManager({ store: { getRun: async () => null }, metadataRoot: root, codexHome: root, getAgentRuntime: async () => ({ provider }) });
  let result, error;
  try {
    result = await manager.runWithConfiguredProvider({
      agent: { id: 'agent', name: 'Kupita', appIds: [], networkAccess: false },
      conversation: { id: 'conversation' }, run: { id: 'run', agentId: 'agent', conversationId: 'conversation', status: 'running', createdAt: '2026-01-01', updatedAt: '2026-01-01' },
      runtime: { provider }, workspaceRoot: root, sharedRoots: [], trustedRoots: [], prompt: 'Qué opinas?',
      mcpContext: { conversationId: 'conversation', ...(channel ? { channel: { kind: 'whatsapp' } } : {}) },
      onProgress: message => progress.push(message),
    });
  } catch (caught) { error = caught.message; }
  finally { providers.createLlmProviderRunService = originalProvider; activity.persistAgentRunActivity = originalPersist; }
  const log = await fs.readFile(path.join(root, 'personal-agents', 'runs', 'run.log'), 'utf8').catch(() => '');
  return { result, error, progress, log, persisted, activities: [...manager.activities.values()] };
};

test('WhatsApp provider image events never reach logs, activity or progress, including fragmented chunks', async t => {
  for (const provider of ['codex', 'claude']) {
    const output = await runFixture(t, provider);
    assert.equal(output.result.assistantText, 'TRIÁNGULO VERDE');
    assert.ok(output.progress.includes('Veo un triángulo verde.'));
    assert.match(output.log, /Veo un triángulo verde/);
    assert.ok(!JSON.stringify(output).includes(pixels.slice(0, 100)), provider);
    assert.ok(!output.log.includes('mcp_tool_call'));
  }
});

test('WhatsApp provider failures cannot persist raw image events as task errors', async t => {
  for (const mode of ['stdout', 'stderr', 'throws']) {
    const output = await runFixture(t, 'codex', mode);
    assert.equal(output.error, 'whatsapp_agent_provider_failed');
    assert.ok(!JSON.stringify(output).includes(pixels.slice(0, 100)), mode);
  }
});

test('ordinary personal agent provider diagnostics keep their existing behavior', async t => {
  const output = await runFixture(t, 'codex', undefined, false);
  assert.equal(output.result.assistantText, 'TRIÁNGULO VERDE');
  assert.ok(output.log.includes('mcp_tool_call'));
});

test('ordinary personal agent provider failures preserve their original diagnostic error', async t => {
  for (const mode of ['stdout', 'throws']) {
    const output = await runFixture(t, 'codex', mode, false);
    assert.equal(output.result, undefined);
    assert.ok(output.error.includes('mcp_tool_call'));
    assert.ok(output.error.includes(pixels));
  }
});
