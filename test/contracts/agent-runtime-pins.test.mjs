import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const defaults = require('../../dist-electron/main/core/agent-runtime-defaults.js');

const EXACT_VERSION = /^\d+\.\d+\.\d+$/;

test('desktop pins exact runtime and agent CLI versions instead of floating ranges', () => {
  assert.match(defaults.CODEX_CLI_VERSION, EXACT_VERSION);
  assert.equal(defaults.CODEX_CLI_VERSION, '0.144.1');
  assert.match(defaults.CLAUDE_CODE_VERSION, EXACT_VERSION);
  assert.match(defaults.DEFAULT_NODE_VERSION, /^\d+(\.\d+){0,2}$/);
  assert.match(defaults.DEFAULT_PYTHON_VERSION, /^\d+(\.\d+){0,2}$/);
  assert.match(defaults.BUNDLED_GIT_VERSION, /^\d+(\.\d+){0,2}$/);
});

test('desktop ships built-in model defaults for every supported provider', () => {
  assert.equal(defaults.BUILT_IN_CODEX_MODEL, 'gpt-5.4');
  assert.equal(defaults.BUILT_IN_CODEX_REASONING, 'medium');
  assert.equal(typeof defaults.BUILT_IN_CLAUDE_MODEL, 'string');
  assert.ok(defaults.BUILT_IN_CLAUDE_MODEL.length > 0);
  assert.ok(Array.isArray(defaults.APP_CODEX_MODEL_OPTIONS) && defaults.APP_CODEX_MODEL_OPTIONS.length > 0);
  assert.ok(Array.isArray(defaults.APP_CLAUDE_MODEL_OPTIONS) && defaults.APP_CLAUDE_MODEL_OPTIONS.length > 0);
  assert.deepEqual(
    defaults.APP_CODEX_MODEL_OPTIONS.slice(0, 3).map((option) => ({
      model: option.realModelName,
      effort: option.defaultReasoningEffort,
      supported: option.supportedReasoningEfforts,
    })),
    [
      { model: 'gpt-5.6-sol', effort: 'low', supported: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] },
      { model: 'gpt-5.6-terra', effort: 'medium', supported: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] },
      { model: 'gpt-5.6-luna', effort: 'medium', supported: ['low', 'medium', 'high', 'xhigh', 'max'] },
    ],
  );
});
