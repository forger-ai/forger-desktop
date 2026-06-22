import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const root = process.cwd();

const sourceBlock = (source, startNeedle, endNeedle) => {
  const startIndex = source.indexOf(startNeedle);
  assert.notEqual(startIndex, -1, `missing source block start: ${startNeedle}`);
  const endIndex = source.indexOf(endNeedle, startIndex);
  assert.notEqual(endIndex, -1, `missing source block end: ${endNeedle}`);
  return source.slice(startIndex, endIndex);
};

test('app assistant tasks pass manifest model fields as recommendations', async () => {
  const source = await readFile(path.join(root, 'src/main/app-agent-task-manager.ts'), 'utf8');
  const executionBlock = sourceBlock(
    source,
    'private async resolveRuntime(',
    '  private async writeLegacyAttachments',
  );

  assert.match(executionBlock, /hasTaskRuntimeInput\(input\.runtime\)/);
  assert.match(executionBlock, /template\.runtime\s*\?\?/);
  assert.match(executionBlock, /recommendations:\s*template\.runtimeRecommendations/);
  assert.doesNotMatch(executionBlock, /provider:\s*template\.model/);
  assert.match(executionBlock, /strict:\s*true/);
});

test('app conversations preserve explicit overrides and otherwise pass manifest model fields as recommendations', async () => {
  const source = await readFile(path.join(root, 'src/main/app-agent-conversation-manager.ts'), 'utf8');
  const executionBlock = sourceBlock(
    source,
    'private async resolveRunRuntime(',
    '  private async load(',
  );

  assert.match(executionBlock, /hasRunRuntimeInput\(input\)/);
  assert.match(executionBlock, /agentRuntime\.runtime\s*\?\?/);
  assert.match(executionBlock, /model:\s*agentRuntime\.model/);
  assert.match(executionBlock, /effort:\s*agentRuntime\.reasoningEffort/);
  assert.match(executionBlock, /strict:\s*true/);
});
