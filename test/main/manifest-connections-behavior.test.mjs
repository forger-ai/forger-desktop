import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  connectionGrantAllowsAction,
  normalizeAppConnectionDeclarations,
  resolveConnectionActionSnapshot,
} = require('../../dist-electron/main/connections/grants.js');

const actionCatalog = {
  gmail: ['gmail.connection.status', 'gmail.search_messages', 'gmail.read_thread'],
  slack: ['slack.connection.status', 'slack.list_channels', 'slack.send_message'],
  trello: ['trello.connection.status', 'trello.create_card'],
};

test('manifest connections normalize required and optional declarations', () => {
  const normalized = normalizeAppConnectionDeclarations({
    required: [
      {
        type: ' gmail ',
        reason: 'Import client emails.',
        actions: ['gmail.search_messages', 'gmail.search_messages'],
        multiple: false,
      },
    ],
    optional: [
      {
        type: 'slack',
        reason: 'Post approved reports.',
        actions: ['*'],
        multiple: true,
      },
      { type: '', reason: 'ignored', actions: ['slack.send_message'] },
    ],
  });
  assert.deepEqual(normalized.required, [
    {
      type: 'gmail',
      reason: 'Import client emails.',
      actions: ['gmail.search_messages'],
      multiple: false,
    },
  ]);
  assert.deepEqual(normalized.optional, [
    {
      type: 'slack',
      reason: 'Post approved reports.',
      actions: ['*'],
      multiple: true,
    },
  ]);
});

test('legacy external tool declarations do not normalize into connection declarations', () => {
  const normalized = normalizeAppConnectionDeclarations(undefined, {
    required: [{ toolId: 'gmail', reason: 'Read mail.', actions: ['gmail.search_messages'] }],
    optional: [
      { toolId: 'forger_chrome_extension', reason: 'Browse.', actions: ['forger_chrome_extension.navigate'] },
      { toolId: 'trello', reason: 'Create cards.', actions: ['trello.create_card'] },
    ],
  });
  assert.deepEqual(normalized.required, []);
  assert.deepEqual(normalized.optional, []);
});

test('explicit manifest connections are the only connection source when legacy tools are present', () => {
  const normalized = normalizeAppConnectionDeclarations({
    optional: [{ type: 'gmail', reason: 'Use selected mail.', actions: ['gmail.read_thread'], multiple: true }],
  }, {
    optional: [{ toolId: 'gmail', reason: 'Legacy mail.', actions: ['gmail.search_messages'] }],
  });
  assert.deepEqual(normalized.optional, [
    { type: 'gmail', reason: 'Use selected mail.', actions: ['gmail.read_thread'], multiple: true },
  ]);
});

test('wildcard connection actions resolve within one type and freeze the approval snapshot', () => {
  const grant = resolveConnectionActionSnapshot({
    type: 'slack',
    reason: 'Post approved reports.',
    actions: ['*'],
    multiple: true,
  }, actionCatalog);
  assert.deepEqual(grant.resolvedActions, [
    'slack.connection.status',
    'slack.list_channels',
    'slack.send_message',
  ]);
  assert.equal(grant.resolvedActions.includes('gmail.search_messages'), false);
  assert.equal(connectionGrantAllowsAction(grant, 'slack.send_message', actionCatalog), true);

  const futureCatalog = {
    ...actionCatalog,
    slack: [...actionCatalog.slack, 'slack.invite_user'],
  };
  assert.equal(connectionGrantAllowsAction(grant, 'slack.invite_user', futureCatalog), false);
});

test('optional connections are not callable until an explicit grant exists', () => {
  const declaration = {
    type: 'slack',
    reason: 'Post approved reports.',
    actions: ['slack.send_message'],
    multiple: false,
  };
  const ungranted = resolveConnectionActionSnapshot(declaration, actionCatalog, { granted: false });
  const granted = resolveConnectionActionSnapshot(declaration, actionCatalog, { granted: true });
  assert.equal(connectionGrantAllowsAction(ungranted, 'slack.send_message', actionCatalog), false);
  assert.equal(connectionGrantAllowsAction(granted, 'slack.send_message', actionCatalog), true);
  assert.equal(connectionGrantAllowsAction(granted, 'slack.list_channels', actionCatalog), false);
});
