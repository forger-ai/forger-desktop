import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const root = process.cwd();

test('app assistant tasks pass manifest model fields as recommendations', async () => {
  const source = await readFile(path.join(root, 'src/main/app-agent-task-manager.ts'), 'utf8');
  const executionBlock = source.slice(source.indexOf('const runtime = await this.options.getAgentRuntime(template.runtime'));

  assert.match(executionBlock, /template\.runtime\s*\?\?/);
  assert.match(executionBlock, /recommendations:\s*template\.runtimeRecommendations/);
  assert.doesNotMatch(executionBlock, /provider:\s*template\.model/);
});

test('app conversations preserve explicit overrides and otherwise pass manifest model fields as recommendations', async () => {
  const source = await readFile(path.join(root, 'src/main/app-agent-conversation-manager.ts'), 'utf8');
  const executionBlock = source.match(/const runtime = await this\.options\.getAgentRuntime\(\n[\s\S]*?\n\s{4}\);/)?.[0] ?? '';

  assert.match(executionBlock, /hasRunRuntimeInput/);
  assert.match(executionBlock, /agentRuntime\.runtime\s*\?\?/);
  assert.match(executionBlock, /model:\s*agentRuntime\.model/);
  assert.match(executionBlock, /effort:\s*agentRuntime\.reasoningEffort/);
});
