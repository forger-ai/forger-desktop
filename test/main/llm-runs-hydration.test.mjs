import assert from 'node:assert/strict';
import test from 'node:test';

import { hydratePersistedPersonalAgentRuns } from '../../dist-electron/main/llm-runs-hydration.js';
import { LlmRunsStore } from '../../dist-electron/main/llm-runs-store.js';

test('LLM runs hydration rebuilds recent personal-agent runs from the authoritative store', async () => {
  const store = new LlmRunsStore({ getMainWindow: () => null });
  const conversation = (id, updatedAt, status = 'completed') => ({
    id,
    agentId: 'agent-1',
    title: id,
    status: 'active',
    origin: 'sidekick',
    readOnly: true,
    createdAt: updatedAt,
    updatedAt,
    messages: [],
    activeRun: {
      id: `run-${id}`,
      agentId: 'agent-1',
      conversationId: id,
      status,
      progress: [],
      createdAt: updatedAt,
      updatedAt,
    },
  });
  const agentStore = {
    listAgents: async () => [{ id: 'agent-1', name: 'ESP' }],
    listConversations: async () => [
      conversation('older', '2026-07-12T10:00:00.000Z'),
      conversation('newer', '2026-07-12T11:00:00.000Z'),
      { ...conversation('no-run', '2026-07-12T12:00:00.000Z'), activeRun: undefined },
    ],
  };

  await hydratePersistedPersonalAgentRuns({ agentStore, llmRunsStore: store, limit: 1 });

  const snapshot = store.snapshot();
  assert.equal(snapshot.items.length, 1);
  assert.equal(snapshot.items[0].sourceId, 'run-newer');
  assert.equal(snapshot.items[0].appName, 'ESP');
  assert.equal(snapshot.items[0].status, 'completed');
});
