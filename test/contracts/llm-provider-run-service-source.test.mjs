import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = async (path) => await readFile(new URL(path, import.meta.url), 'utf8');

test('LLM execution surfaces route through LlmProviderRunService instead of adapters', async () => {
  const files = [
    '../../src/main/chat/orchestrator-helpers.ts',
    '../../src/main/app-agent-task-manager.ts',
    '../../src/main/app-agent-conversation-manager.ts',
    '../../src/main/automation/agent-command-runner.ts',
    '../../src/main/personal-agents/agent-conversation-manager.ts',
    '../../src/main/app-agent/process.ts',
  ];

  for (const file of files) {
    const text = await source(file);
    assert.match(text, /createLlmProviderRunService|providerRunService\.resolveCommand/, `${file} should use the provider run service`);
    assert.doesNotMatch(text, /llm-provider\/adapters/, `${file} should not import provider adapters directly`);
    assert.doesNotMatch(text, /\b(?:codexCliAdapter|claudeCliAdapter|antigravityCliAdapter)\b/, `${file} should not call provider adapters directly`);
  }
});

test('provider descriptors are the only main-process adapter boundary', async () => {
  const descriptorSource = await source('../../src/main/llm-provider/descriptors.ts');
  assert.match(descriptorSource, /llm-provider\/descriptors|\.\/adapters\/codex-cli-adapter/);
  assert.match(descriptorSource, /getLlmProviderDescriptor/);
  assert.match(descriptorSource, /supportsMcp/);
  assert.match(descriptorSource, /supportsConversations/);
});
