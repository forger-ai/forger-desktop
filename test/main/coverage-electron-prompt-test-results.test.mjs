import assert from 'node:assert/strict';
import test from 'node:test';

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  promptTestErrorMessage,
  promptTestFailure,
  promptTestSuccess,
  promptTestTechnicalCode,
  renderPromptTemplateForTest,
} = require('../../dist-electron/main/apps/prompt-test-results.js');

test('prompt test rendering replaces strings, structured values, nulls, and missing variables', () => {
  const rendered = renderPromptTemplateForTest(
    'Name={{ name }} Data={{data}} Null={{nil}} Missing={{ missing }}',
    { name: 'Forger', data: { enabled: true }, nil: null },
  );
  assert.equal(rendered, 'Name=Forger Data={\n  "enabled": true\n} Null= Missing=');
  assert.equal(renderPromptTemplateForTest('Undefined={{value}}', { value: undefined }), 'Undefined=');
  assert.equal(renderPromptTemplateForTest('No placeholders', {}), 'No placeholders');
});

test('prompt test result builders preserve diagnostics and bound rendered output size', () => {
  assert.deepEqual(promptTestSuccess('Ready', {
    declaredVariables: ['name'],
    usedVariables: ['name'],
  }), {
    success: true,
    valid: true,
    errors: [],
    renderedPrompt: 'Ready',
    declaredVariables: ['name'],
    usedVariables: ['name'],
    missingVariables: [],
    extraVariables: [],
  });

  const longResult = promptTestSuccess('x'.repeat(20_001), {
    declaredVariables: [],
    usedVariables: [],
  });
  assert.equal(longResult.renderedPrompt, `${'x'.repeat(20_000)}\n[truncated]`);

  assert.deepEqual(promptTestFailure('invalid_prompt', ['Broken']), {
    success: false,
    valid: false,
    technicalCode: 'invalid_prompt',
    errors: ['Broken'],
    declaredVariables: [],
    usedVariables: [],
    missingVariables: [],
    extraVariables: [],
  });
  assert.deepEqual(promptTestFailure('invalid_variables', ['Missing name'], {
    declaredVariables: ['name'],
    usedVariables: ['unknown'],
    missingVariables: ['name'],
    extraVariables: ['unknown'],
  }), {
    success: false,
    valid: false,
    technicalCode: 'invalid_variables',
    errors: ['Missing name'],
    declaredVariables: ['name'],
    usedVariables: ['unknown'],
    missingVariables: ['name'],
    extraVariables: ['unknown'],
  });
});

test('prompt test errors prefer provider codes, then safe Error messages, then stable fallbacks', () => {
  assert.equal(promptTestTechnicalCode({ code: 'provider_timeout' }), 'provider_timeout');
  assert.equal(promptTestTechnicalCode({ code: 408 }), 'app_prompt_test_failed');
  assert.equal(promptTestTechnicalCode(new Error('network_timeout: provider unavailable')), 'network_timeout');
  assert.equal(promptTestTechnicalCode(new Error(': provider unavailable')), 'app_prompt_test_failed');
  assert.equal(promptTestTechnicalCode(new Error('   ')), 'app_prompt_test_failed');
  assert.equal(promptTestTechnicalCode('raw failure'), 'app_prompt_test_failed');
  assert.equal(promptTestTechnicalCode(null), 'app_prompt_test_failed');

  assert.equal(promptTestErrorMessage(new Error('Visible failure')), 'Visible failure');
  assert.equal(promptTestErrorMessage({ message: 'unsafe object message' }), 'No se pudo probar el prompt.');
});
