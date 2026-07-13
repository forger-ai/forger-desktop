import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { AgentStore } = require('../../dist-electron/main/personal-agents/agent-store.js');
const { AgentConversationManager } = require('../../dist-electron/main/personal-agents/agent-conversation-manager.js');

const waitForConversation = async (manager, conversationId, predicate) => {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const conversation = await manager.getConversation(conversationId);
    if (conversation && predicate(conversation)) return conversation;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for conversation ${conversationId}`);
};

const countOccurrences = (text, fragment) => text.split(fragment).length - 1;

test('BDD: a personal-agent conversation receives bootstrap only on its first run', async () => {
  const metadataRoot = await mkdtemp(path.join(tmpdir(), 'forger-personal-agent-prompts-meta-'));
  const forgerHomeRoot = await mkdtemp(path.join(tmpdir(), 'forger-personal-agent-prompts-home-'));
  const store = new AgentStore({ metadataRoot, forgerHomeRoot });
  const prompts = [];
  const manager = new AgentConversationManager({
    store,
    runner: async ({ prompt }) => {
      prompts.push(prompt);
      return { assistantText: prompts.length === 1 ? 'First answer.' : 'Second answer.' };
    },
  });
  const agent = await store.createAgent({ name: 'Prompt keeper', purpose: 'Keep turns concise.' });

  const started = await manager.startConversation({
    agentId: agent.id,
    initialMessage: 'First request.',
  });
  await waitForConversation(manager, started.id, (conversation) => conversation.activeRun?.status === 'completed');

  await manager.sendMessage({ conversationId: started.id, content: 'Second request.' });
  await waitForConversation(manager, started.id, (conversation) =>
    conversation.activeRun?.status === 'completed' && conversation.messages.at(-1)?.content === 'Second answer.');

  assert.equal(prompts.length, 2);
  assert.match(prompts[0], /You are waking up as `Prompt keeper`/);
  assert.doesNotMatch(prompts[1], /You are waking up as `Prompt keeper`/);
  assert.match(prompts[1], /user \(Human\): First request\./);
  assert.match(prompts[1], /assistant \(Prompt keeper\): First answer\./);
  assert.equal(countOccurrences(prompts[1], 'user (Human): Second request.'), 1);
});

test('BDD: every Sidekick turn keeps its voice contract without repeating conversation bootstrap', async () => {
  const metadataRoot = await mkdtemp(path.join(tmpdir(), 'forger-sidekick-prompts-meta-'));
  const forgerHomeRoot = await mkdtemp(path.join(tmpdir(), 'forger-sidekick-prompts-home-'));
  const store = new AgentStore({ metadataRoot, forgerHomeRoot });
  const prompts = [];
  const manager = new AgentConversationManager({
    store,
    runner: async ({ prompt }) => {
      prompts.push(prompt);
      return { assistantText: prompts.length === 1 ? 'Primera respuesta.' : 'Segunda respuesta.' };
    },
  });
  const agent = await store.createAgent({ name: 'Voice helper' });
  const conversation = await manager.createSidekickConversation({
    agentId: agent.id,
    sidekickId: 'desk-sidekick',
  });

  await manager.sendSidekickMessage({
    conversationId: conversation.id,
    sidekickId: 'desk-sidekick',
    content: 'Primera pregunta.',
    locale: 'es-CL',
  });
  await waitForConversation(manager, conversation.id, (item) => item.activeRun?.status === 'completed');

  await manager.sendSidekickMessage({
    conversationId: conversation.id,
    sidekickId: 'desk-sidekick',
    content: 'Segunda pregunta.',
    locale: 'es-CL',
  });
  await waitForConversation(manager, conversation.id, (item) =>
    item.activeRun?.status === 'completed' && item.messages.at(-1)?.content === 'Segunda respuesta.');

  assert.match(prompts[0], /You are waking up as `Voice helper`/);
  assert.doesNotMatch(prompts[1], /You are waking up as `Voice helper`/);
  assert.match(prompts[0], /Sidekick voice response contract/);
  assert.match(prompts[1], /Sidekick voice response contract/);
  assert.match(prompts[1], /Mandatory Sidekick final action/);
  assert.equal(countOccurrences(prompts[1], 'user (Human): Segunda pregunta.'), 1);
});
