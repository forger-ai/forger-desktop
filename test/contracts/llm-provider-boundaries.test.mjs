import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
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

test('every provider descriptor declares the capabilities run surfaces depend on', () => {
  const { LLM_PROVIDER_DESCRIPTORS, getLlmProviderDescriptor } = require('../../dist-electron/main/llm-provider/descriptors.js');

  const providers = Object.keys(LLM_PROVIDER_DESCRIPTORS);
  assert.ok(providers.includes('codex'));
  assert.ok(providers.includes('claude'));

  for (const provider of providers) {
    const descriptor = getLlmProviderDescriptor(provider);
    assert.equal(descriptor.key, provider);
    assert.equal(typeof descriptor.label, 'string');
    assert.equal(typeof descriptor.supportsMcp, 'boolean', `${provider} declares supportsMcp`);
    assert.equal(typeof descriptor.supportsConversations, 'boolean', `${provider} declares supportsConversations`);
  }
});
