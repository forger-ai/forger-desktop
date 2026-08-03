import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

const viewPath = new URL('../../src/renderer/views/ConnectionsView.tsx', import.meta.url);

test('WhatsApp pairing keeps the setup dialog mounted until the connection succeeds', async () => {
  const source = await fs.readFile(viewPath, 'utf8');
  const configureStart = source.indexOf('const configure = async () => {');
  const configureEnd = source.indexOf('const copyCallbackUrl = async', configureStart);
  const configureFlow = source.slice(configureStart, configureEnd);

  const pairingCall = configureFlow.indexOf("actionId: 'whatsapp.start_pairing'");
  const nonWhatsAppBranch = configureFlow.indexOf("if (setupDefinition.type !== 'whatsapp')");
  const beforeNonWhatsAppBranch = configureFlow.slice(0, nonWhatsAppBranch);

  assert.ok(pairingCall >= 0, 'the configure flow starts WhatsApp pairing');
  assert.ok(nonWhatsAppBranch >= 0, 'the configure flow handles non-WhatsApp navigation separately');
  assert.doesNotMatch(beforeNonWhatsAppBranch, /onOpenConnection\(/);
  assert.match(configureFlow, /if \(setupDefinition\.type !== 'whatsapp'\) \{[\s\S]*onOpenConnection\([\s\S]*return;[\s\S]*whatsapp\.start_pairing/);
  assert.match(source, /status === 'connected'[\s\S]*onOpenConnection\(/);
});

test('unfinished WhatsApp connections remain actionable from the detail view', async () => {
  const source = await fs.readFile(viewPath, 'utf8');

  assert.match(source, /selectedInstance\.status === 'needs_setup'[\s\S]*openSetup\(selectedDefinition\.type, selectedInstance\.id\)/);
  assert.match(source, /selectedInstance\.status === 'needs_setup' \? copy\.connect : copy\.reconnect/);
});
