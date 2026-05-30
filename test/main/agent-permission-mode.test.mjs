import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  claudeUnsafeRootArgs,
  codexUnsafeArgs,
  codexWorkspaceArgs,
} = require('../../dist-electron/main/agent-permission-mode.js');

test('agent permission mode helpers keep safe runs scoped and unsafe runs explicit', () => {
  assert.deepEqual(codexUnsafeArgs('safe'), []);
  assert.deepEqual(codexWorkspaceArgs('safe'), ['--full-auto', '--sandbox', 'workspace-write']);
  assert.deepEqual(codexUnsafeArgs('unsafe'), ['--dangerously-bypass-approvals-and-sandbox']);
  assert.deepEqual(codexWorkspaceArgs('unsafe'), []);
  assert.deepEqual(claudeUnsafeRootArgs('darwin'), ['--add-dir', '/']);
  assert.deepEqual(claudeUnsafeRootArgs('linux'), ['--add-dir', '/']);
});
