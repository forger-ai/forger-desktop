import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const {
  parseCollaborationCommand,
  selectRepositories,
} = require('../../dist-electron/main/repository-collaboration/commands.js');
const repos = [
  { id: 'a', name: 'Backend' },
  { id: 'b', name: 'Desktop' },
];
test('only explicit addressing triggers collaboration, with scoped tasks and lifecycle commands', () => {
  assert.equal(parseCollaborationCommand('conversemos de Forger'), null);
  assert.equal(parseCollaborationCommand('🤖 Forger tarea lista'), null);
  assert.equal(parseCollaborationCommand('Forger, estado #abc').kind, 'status');
  assert.equal(parseCollaborationCommand('@Forger cancel #abc').kind, 'cancel');
  assert.deepEqual(
    selectRepositories('Backend + Desktop: cambia ambos', repos),
    { repositoryIds: ['a', 'b'], prompt: 'cambia ambos' },
  );
  assert.deepEqual(selectRepositories('en Backend agrega filtro', repos), {
    repositoryIds: ['a'],
    prompt: 'agrega filtro',
  });
  assert.equal(selectRepositories('hazlo', repos), null);
  assert.equal(selectRepositories('Backend + Missing: hazlo', repos), null);
});
