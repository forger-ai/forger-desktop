import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  placeholdersFor,
  renderManifestAgentPrompt,
  resolvePromptTemplate,
} = require('../../dist-electron/main/manifest-agent-prompts.js');

const appRoot = path.resolve('/tmp/forger-app');

const agent = {
  id: 'advisor',
  title: 'Advisor',
  prompts: {
    initial: {
      body: [
        'Open {{ safePath }}',
        'Title: {{ title }}',
        'Notes: {{ notes }}',
        'Payload: {{ payload }}',
        'Optional: {{ optional }}',
      ].join('\n'),
      variables: {
        safePath: { type: 'path', required: true },
        title: { type: 'string', required: true },
        notes: { type: 'text', required: true },
        payload: { type: 'json', required: true },
        optional: { type: 'text', required: false },
      },
    },
    resume: {
      body: 'Resume {{ title }}',
      variables: {
        title: { type: 'string', required: true },
      },
    },
  },
};

test('manifest agent prompt rendering validates variables and renders typed values', () => {
  const rendered = renderManifestAgentPrompt({
    agent,
    kind: 'initial',
    appRoot,
    variables: {
      safePath: 'data/input.csv',
      title: 'Monthly close',
      notes: 'Line one\nLine two',
      payload: { z: 1, a: true },
    },
  });

  assert.match(rendered, new RegExp(`Open ${appRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/data/input\\.csv`));
  assert.match(rendered, /Title: Monthly close/);
  assert.match(rendered, /Notes: Line one\nLine two/);
  assert.match(rendered, /Payload: \{\n {2}"a": true,\n {2}"z": 1\n\}/);
  assert.match(rendered, /Optional:\s*$/);
});

test('manifest agent prompt resolution falls back from steer to resume', () => {
  assert.equal(resolvePromptTemplate(agent, 'steer').body, 'Resume {{ title }}');
  assert.deepEqual([...placeholdersFor('A {{one}} B {{ two }} C {{one}}')], ['one', 'two']);
});

test('manifest agent prompt rendering rejects undeclared, missing, unsafe, and mistyped variables', () => {
  assert.throws(() => renderManifestAgentPrompt({
    agent: {
      id: 'bad',
      prompts: {
        initial: {
          body: 'Hello {{ missing }}',
          variables: {},
        },
      },
    },
    kind: 'initial',
    appRoot,
  }), /agent_prompt_placeholder_not_declared:missing/);

  assert.throws(() => renderManifestAgentPrompt({
    agent,
    kind: 'initial',
    appRoot,
    variables: {
      safePath: 'data/input.csv',
      title: 'Monthly close',
      notes: 'notes',
      payload: {},
      extra: 'nope',
    },
  }), /agent_prompt_variable_not_declared:extra/);

  assert.throws(() => renderManifestAgentPrompt({
    agent,
    kind: 'initial',
    appRoot,
    variables: {
      safePath: 'data/input.csv',
      title: 'Monthly close',
      payload: {},
    },
  }), /agent_prompt_variable_required:notes/);

  assert.throws(() => renderManifestAgentPrompt({
    agent,
    kind: 'initial',
    appRoot,
    variables: {
      safePath: '../outside.csv',
      title: 'Monthly close',
      notes: 'notes',
      payload: {},
    },
  }), /agent_prompt_variable_path_outside_app:safePath/);

  assert.throws(() => renderManifestAgentPrompt({
    agent,
    kind: 'initial',
    appRoot,
    variables: {
      safePath: 'data/input.csv',
      title: 'Bad\nTitle',
      notes: 'notes',
      payload: {},
    },
  }), /agent_prompt_variable_multiline_string:title/);

  assert.throws(() => renderManifestAgentPrompt({
    agent,
    kind: 'initial',
    appRoot,
    variables: {
      safePath: 'data/input.csv',
      title: 'Monthly close',
      notes: { nested: true },
      payload: {},
    },
  }), /agent_prompt_variable_type:notes/);

  assert.throws(() => renderManifestAgentPrompt({
    agent: {
      id: 'unsupported',
      prompts: {
        initial: {
          body: 'Value {{ value }}',
          variables: {
            value: { type: 'number', required: true },
          },
        },
      },
    },
    kind: 'initial',
    appRoot,
    variables: {
      value: '42',
    },
  }), /agent_prompt_variable_type:value/);
});

test('manifest agent prompt resolution reports missing templates by agent and kind', () => {
  assert.throws(() => resolvePromptTemplate({ id: 'empty', prompts: {} }, 'initial'), /agent_prompt_template_missing:empty:initial/);
});
