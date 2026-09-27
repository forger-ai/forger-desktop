import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { WhatsAppConnectionManager } = require('../../dist-electron/main/connections/modules/whatsapp/manager.js');
const context = { metadataRoot: '/unused', locale: 'es', emitEvent: () => {} };
const fixture = () => {
  let cleared = 0;
  const manager = new WhatsAppConnectionManager({ clear: async () => { cleared++; }, load: async () => {}, storageStatus: async () => ({}) }, async () => ({}));
  manager.ensureStarted = async () => { manager.socket ??= {}; };
  return { manager, cleared: () => cleared };
};
test('pairing snapshot follows QR rotation without extending its deadline or leaking it into status events', async () => {
  const { manager } = fixture();
  const events = [];
  manager.handleConnectionUpdate({ qr: 'first' }, { ...context, emitEvent: e => events.push(e) });
  const first = await manager.pairingStatus();
  const same = await manager.pairingStatus();
  assert.equal(first.status, 'qr_ready');
  assert.equal(same.expiresAt, first.expiresAt);
  manager.handleConnectionUpdate({ qr: 'second' }, context);
  assert.notEqual((await manager.pairingStatus()).qrDataUrl, first.qrDataUrl);
  assert.ok(!JSON.stringify(events).includes('data:image'));
  const publicStatus = await manager.status();
  assert.equal(publicStatus.qrAvailable, true);
  assert.equal(publicStatus.qrDataUrl, undefined);
  assert.equal(publicStatus.qr, undefined);
  manager.qrExpiresAt = Date.now() - 1;
  assert.equal((await manager.pairingStatus()).status, 'expired');
  assert.equal((await manager.pairingStatus()).qrDataUrl, undefined);
});
test('closing or connecting invalidates the displayed QR; retry preserves local data and reuses active pairing', async () => {
  const { manager, cleared } = fixture();
  manager.socket = {};
  manager.handleConnectionUpdate({ qr: 'live' }, context);
  const first = await manager.startPairing(context, { method: 'qr' });
  assert.equal((await manager.startPairing(context, { method: 'qr' })).qrDataUrl, first.qrDataUrl);
  assert.equal(cleared(), 0);
  manager.handleConnectionUpdate({ connection: 'close' }, context);
  assert.equal((await manager.pairingStatus()).status, 'expired');
  assert.equal((await manager.pairingStatus()).qrDataUrl, undefined);
  manager.handleConnectionUpdate({ connection: 'open' }, context);
  assert.deepEqual(await manager.pairingStatus(), { status: 'connected' });
  assert.equal(cleared(), 0);
});

test('explicit retry after confirmed logout drains credential writes and replaces auth only, preserving observed data', async t => {
  const root = await mkdtemp(join(tmpdir(), 'wa-pairing-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const auth = join(root, 'auth');
  await mkdir(auth);
  await writeFile(join(auth, 'creds.json'), 'revoked');
  await writeFile(join(root, 'messages.db'), 'keep-messages');
  const manager = new WhatsAppConnectionManager({ authDirectory: () => auth });
  const handlers = {};
  let finishSave;
  manager.loadBaileys = async () => ({
    useMultiFileAuthState: async () => ({ state: {}, saveCreds: () => new Promise(resolve => { finishSave = async () => { await writeFile(join(auth, 'creds.json'), 'stale-save'); resolve(); }; }) }),
    default: () => ({ ev: { on: (event, handler) => { handlers[event] = handler; } }, end: () => {} }),
  });
  await manager.ensureStarted(context);
  const oldCredsHandler = handlers['creds.update'];
  oldCredsHandler({});
  handlers['connection.update']({ connection: 'close', lastDisconnect: { error: { output: { statusCode: 401 } } } });
  manager.ensureStarted = async () => { manager.socket = {}; manager.handleConnectionUpdate({ qr: 'renewed' }, context); };
  const retry = manager.startPairing(context, { method: 'qr' });
  await Promise.resolve();
  await finishSave();
  assert.equal((await retry).status, 'qr_ready');
  oldCredsHandler({});
  await assert.rejects(readFile(join(auth, 'creds.json')), { code: 'ENOENT' });
  assert.equal(await readFile(join(root, 'messages.db'), 'utf8'), 'keep-messages');
});

test('pairing status is setup-only and validates the connection instead of becoming an agent action', async t => {
  const { ConnectionsService } = require('../../dist-electron/main/connections-service.js');
  const { BUILT_IN_CONNECTION_MODULES } = require('../../dist-electron/main/connections/index.js');
  const root = await mkdtemp(join(tmpdir(), 'wa-pairing-service-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new ConnectionsService({ metadataRoot: root, secretsStore: {} });
  assert.equal((await service.pairingStatus('../escape')).technicalCode, 'connection_instance_not_found');
  const definition = BUILT_IN_CONNECTION_MODULES.find(m => m.definition.type === 'whatsapp').definition;
  assert.ok(!definition.actions.some(action => /pairing.*status/.test(action.id)));
  const configured = await service.configure({ type: 'whatsapp', label: 'Test' });
  assert.equal(configured.success, true);
  assert.equal((await service.pairingStatus(configured.instance.id)).data.status, 'expired');
  assert.equal((await service.call({ type: 'whatsapp', connectionId: configured.instance.id, actionId: 'whatsapp.pairing.status' })).technicalCode, 'connection_action_not_found');
});

test('retry replaces an expired transport without resetting storage, and snapshot waits for a fresh QR', async () => {
  const { manager, cleared } = fixture();
  let ended = false;
  manager.socket = { end: () => { ended = true; } };
  manager.handleConnectionUpdate({ qr: 'old' }, context);
  manager.qrExpiresAt = Date.now() - 1;
  manager.ensureStarted = async () => { manager.socket = {}; manager.handleConnectionUpdate({ qr: 'fresh' }, context); };
  assert.equal((await manager.startPairing(context, { method: 'qr' })).status, 'qr_ready');
  assert.equal(ended, true);
  assert.equal(cleared(), 0);
  manager.latestQr = null;
  assert.deepEqual(await manager.pairingStatus(), { status: 'connecting' });
});

test('a QR that rotates, closes or expires while encoding never escapes in a setup response', async t => {
  const QRCode = require('qrcode');
  const { manager } = fixture();
  let encoded;
  const encoder = t.mock.method(QRCode, 'toDataURL', async value => { encoded = value; return 'image'; });
  manager.handleConnectionUpdate({ qr: 'old' }, context);
  encoder.mock.mockImplementationOnce(async () => { manager.handleConnectionUpdate({ qr: 'new' }, context); return 'stale'; });
  assert.equal((await manager.pairingStatus()).qrDataUrl, 'image');
  assert.equal(encoded, 'new');
  manager.handleConnectionUpdate({ qr: 'closing' }, context);
  encoder.mock.mockImplementationOnce(async () => { manager.handleConnectionUpdate({ connection: 'close' }, context); return 'stale'; });
  assert.equal((await manager.pairingStatus()).status, 'expired');
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  manager.handleConnectionUpdate({ qr: 'expiring' }, context);
  encoder.mock.mockImplementationOnce(async () => { now += 60_001; return 'stale'; });
  assert.equal((await manager.pairingStatus()).status, 'expired');
});

test('waiting skips an expired cached QR and resolves only after the next transport QR arrives', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { manager } = fixture();
  manager.handleConnectionUpdate({ qr: 'expired' }, context);
  manager.qrExpiresAt = Date.now() - 1;
  const waiting = manager.waitForQr();
  t.mock.timers.tick(250);
  await Promise.resolve();
  manager.handleConnectionUpdate({ qr: 'fresh' }, context);
  t.mock.timers.tick(250);
  assert.equal(await waiting, 'fresh');
});
