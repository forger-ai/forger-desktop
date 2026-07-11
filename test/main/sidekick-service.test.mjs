import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { WebSocket } from 'ws';

import { clearDistModule, withMockedElectron } from './electron-test-helpers.mjs';

const createSafeStorage = () => ({
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(`sealed:${value}`, 'utf8'),
  decryptString: (buffer) => buffer.toString('utf8').replace(/^sealed:/, ''),
});

const tmpRoot = async (name) => await fs.mkdtemp(path.join(os.tmpdir(), `forger-${name}-`));

const openWebSocket = async (url) => await new Promise((resolve, reject) => {
  const socket = new WebSocket(url);
  socket.once('open', () => resolve(socket));
  socket.once('error', reject);
});

const waitForSocketClose = async (socket) => await new Promise((resolve) => {
  if (socket.readyState === WebSocket.CLOSED) {
    resolve();
    return;
  }
  socket.once('close', () => resolve());
});

const waitForState = async (readState, predicate) => {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const state = await readState();
    if (predicate(state)) {
      return state;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return await readState();
};

const SIDEKICK_ID = 'sidekick-001';
const DESKTOP_ID = 'desktop-fingerprint';

const writePairedSidekickStore = async (root, pairingSecret, capabilities = ['display.text', 'wifi.websocket']) => {
  await fs.writeFile(path.join(root, 'sidekicks.json'), JSON.stringify({
    version: 1,
    desktopId: DESKTOP_ID,
    records: [{
      sidekickId: SIDEKICK_ID,
      name: 'Desk Sidekick',
      hostname: 'desk-sidekick-test',
      pairedAt: new Date('2026-07-09T10:00:00.000Z').toISOString(),
      updatedAt: new Date('2026-07-09T10:00:00.000Z').toISOString(),
      firmwareVersion: '0.3.0',
      capabilities,
      encryptedPairingSecret: Buffer.from(`sealed:${pairingSecret}`, 'utf8').toString('base64'),
    }],
  }), 'utf8');
};

const createSidekickService = (SidekickService, root, options = {}) => {
  class FakeSerialPort extends EventEmitter {
    static async list() {
      return [];
    }
  }

  return new SidekickService({
    metadataRoot: root,
    serialPortClass: FakeSerialPort,
    bonjourFactory: () => ({
      publish: () => ({ stop: (callback) => callback?.() }),
      destroy: (callback) => callback?.(),
    }),
    safeStorageAdapter: createSafeStorage(),
    getCloudIdentity: async () => ({ publicKey: 'public-key', keyFingerprint: DESKTOP_ID }),
    ...options,
  });
};

const connectPairedSidekick = async ({
  service,
  internals,
  pairingSecret,
  capabilities = ['display.text', 'wifi.websocket', 'microphone.record'],
  battery,
}) => {
  const initial = await service.getState();
  const socket = await openWebSocket(`ws://127.0.0.1:${initial.servicePort}/sidekick`);
  const sessionId = `session-${randomBytes(4).toString('hex')}`;
  let seq = 1;
  const sendPayload = (payload) => {
    socket.send(JSON.stringify(internals.encryptSidekickPayload({
      sidekickId: SIDEKICK_ID,
      ...payload,
    }, {
      pairingSecretBase64: pairingSecret,
      sidekickId: SIDEKICK_ID,
      desktopId: DESKTOP_ID,
      sessionId,
      seq,
    })));
    seq += 1;
  };
  const timeSyncPromise = capabilities.includes('system.time.sync')
    ? readDesktopCommand(socket, internals, pairingSecret)
    : null;
  sendPayload({
    v: 1,
    type: 'network.hello',
    fw: '0.4.0',
    capabilities,
    ip: '192.168.4.12',
    battery,
  });
  await waitForState(
    () => service.getState(),
    (state) => state.sidekicks[0]?.status === 'online',
  );
  const timeSyncCommand = timeSyncPromise ? await timeSyncPromise : undefined;
  if (timeSyncCommand) {
    assert.equal(timeSyncCommand.cmd, 'system.time.sync');
    assert.equal(typeof timeSyncCommand.epochMs, 'number');
    assert.equal(typeof timeSyncCommand.timeZone, 'string');
    assert.equal(Number.isInteger(timeSyncCommand.utcOffsetMinutes), true);
    sendPayload({
      v: 1,
      type: 'system.time.synced',
      requestId: timeSyncCommand.id,
      timeZone: timeSyncCommand.timeZone,
      utcOffsetMinutes: timeSyncCommand.utcOffsetMinutes,
      deviceEpochMs: timeSyncCommand.epochMs,
      driftMs: 0,
      clockAdjusted: false,
    });
  }
  return { socket, sendPayload, timeSyncCommand };
};

// Buffer por socket: el desktop puede emitir varios comandos seguidos (ventana
// de chunks en vuelo, stop tras abortar una grabacion) y un socket.once armado
// despues de que el mensaje llego lo perderia. El listener unico encola todo y
// cada lectura consume en orden.
const desktopCommandQueue = (socket) => {
  if (!socket.__desktopCommandQueue) {
    const queue = { messages: [], waiters: [] };
    socket.__desktopCommandQueue = queue;
    socket.on('message', (raw) => {
      const waiter = queue.waiters.shift();
      if (waiter) {
        waiter(raw);
      } else {
        queue.messages.push(raw);
      }
    });
  }
  return socket.__desktopCommandQueue;
};

const readDesktopCommand = async (socket, internals, pairingSecret, { includeCustomization = false } = {}) => {
  const queue = desktopCommandQueue(socket);
  for (;;) {
    const raw = queue.messages.length > 0
      ? queue.messages.shift()
      : await new Promise((resolve, reject) => {
        const waiter = (message) => {
          clearTimeout(timeout);
          resolve(message);
        };
        const timeout = setTimeout(() => {
          const index = queue.waiters.indexOf(waiter);
          if (index >= 0) {
            queue.waiters.splice(index, 1);
          }
          reject(new Error('desktop_command_timeout'));
        }, 1000);
        queue.waiters.push(waiter);
      });
    const command = internals.decryptSidekickEnvelope(JSON.parse(raw.toString()), pairingSecret);
    // Tras el hello, Desktop empuja la personalizacion idle en segundo plano;
    // los tests que esperan comandos puntuales la ignoran salvo que la pidan.
    const isCustomization = typeof command.cmd === 'string' &&
      (command.cmd.startsWith('idle.') || command.cmd === 'limits.update');
    if (isCustomization && !includeCustomization) {
      continue;
    }
    return command;
  }
};

test('Sidekick crypto helpers derive and decrypt AES-GCM envelopes with the pairing secret', async () => {
  await withMockedElectron({ safeStorage: createSafeStorage() }, async (require) => {
    clearDistModule('main/sidekick-service.js');
    const { __testSidekickInternals } = require('../../dist-electron/main/sidekick-service.js');
    const pairingSecretBase64 = randomBytes(32).toString('base64');
    const params = {
      pairingSecretBase64,
      sidekickId: 'sidekick-test',
      desktopId: 'desktop-test',
      sessionId: 'session-test',
      seq: 1,
    };

    const envelope = __testSidekickInternals.encryptSidekickPayload({ v: 1, type: 'heartbeat' }, params);
    const decrypted = __testSidekickInternals.decryptSidekickEnvelope(envelope, pairingSecretBase64);

    assert.deepEqual(decrypted, { v: 1, type: 'heartbeat' });
    assert.throws(() => __testSidekickInternals.decryptSidekickEnvelope(envelope, randomBytes(32).toString('base64')));
  });
});

test('normalizeSidekickUsbDevice identifies ESP32-style serial ports across platforms', async () => {
  await withMockedElectron({ safeStorage: createSafeStorage() }, async (require) => {
    clearDistModule('main/sidekick-service.js');
    const { normalizeSidekickUsbDevice } = require('../../dist-electron/main/sidekick-service.js');

    assert.equal(normalizeSidekickUsbDevice(null), null);
    assert.equal(normalizeSidekickUsbDevice({ manufacturer: 'Espressif' }), null);
    assert.deepEqual(normalizeSidekickUsbDevice({
      path: '/dev/cu.usbmodem101',
      manufacturer: 'Espressif',
      vendorId: '303a',
      productId: '1001',
    }), {
      path: '/dev/cu.usbmodem101',
      manufacturer: 'Espressif',
      serialNumber: undefined,
      vendorId: '303A',
      productId: '1001',
      friendlyName: undefined,
      likelySidekick: true,
    });
    assert.equal(normalizeSidekickUsbDevice({ path: 'COM5' }).likelySidekick, true);
  });
});

test('Sidekick hostname is safe, stable, unique per device, and bounded for mDNS labels', async () => {
  await withMockedElectron({ safeStorage: createSafeStorage() }, async (require) => {
    clearDistModule('main/sidekick-service.js');
    const { __testSidekickInternals } = require('../../dist-electron/main/sidekick-service.js');

    const first = __testSidekickInternals.buildSidekickHostname('Café María / Taller #1', 'sidekick-001');
    const second = __testSidekickInternals.buildSidekickHostname('Café María / Taller #1', 'sidekick-002');
    const repeated = __testSidekickInternals.buildSidekickHostname('Café María / Taller #1', 'sidekick-001');
    const invalidOnly = __testSidekickInternals.buildSidekickHostname('🚀 / ★', 'sidekick-003');
    const long = __testSidekickInternals.buildSidekickHostname('a'.repeat(120), 'sidekick-004');

    assert.match(first, /^cafe-maria-taller-1-[a-f0-9]{10}$/);
    assert.equal(first, repeated);
    assert.notEqual(first, second);
    assert.match(invalidOnly, /^sidekick-[a-f0-9]{10}$/);
    assert.equal(long.length, 63);
    for (const hostname of [first, second, invalidOnly, long]) {
      assert.match(hostname, /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])$/);
      assert.ok(hostname.length <= 63);
    }
  });
});

test('SidekickService validates the visible name before pairing over USB', async (t) => {
  const root = await tmpRoot('sidekick-service-validation');
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  await withMockedElectron({ safeStorage: createSafeStorage() }, async (require) => {
    clearDistModule('main/sidekick-service.js');
    const { SidekickService } = require('../../dist-electron/main/sidekick-service.js');

    class FakeSerialPort extends EventEmitter {
      static listCalls = 0;

      static async list() {
        FakeSerialPort.listCalls += 1;
        return [];
      }
    }

    const service = new SidekickService({
      metadataRoot: root,
      serialPortClass: FakeSerialPort,
      bonjourFactory: () => ({
        publish: () => ({ stop: (callback) => callback?.() }),
        destroy: (callback) => callback?.(),
      }),
      safeStorageAdapter: createSafeStorage(),
      getCloudIdentity: async () => ({ publicKey: 'public-key', keyFingerprint: 'desktop-fingerprint' }),
    });

    const empty = await service.configureUsb({ ssid: 'Office Wi-Fi', password: 'wifi-pass', name: '   ' });
    const tooLong = await service.configureUsb({ ssid: 'Office Wi-Fi', password: 'wifi-pass', name: 'a'.repeat(41) });
    await service.dispose();

    assert.equal(empty.success, false);
    assert.equal(empty.technicalCode, 'sidekick_name_required');
    assert.equal(tooLong.success, false);
    assert.equal(tooLong.technicalCode, 'sidekick_name_too_long');
    assert.equal(FakeSerialPort.listCalls, 0);
  });
});

test('SidekickService configures over USB only after matching pair.configured ACK and ignores unrelated serial messages', async (t) => {
  const root = await tmpRoot('sidekick-service');
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  await withMockedElectron({ safeStorage: createSafeStorage() }, async (require) => {
    clearDistModule('main/sidekick-service.js');
    const { SidekickService, __testSidekickInternals } = require('../../dist-electron/main/sidekick-service.js');
    const writes = [];
    let mdnsPublishedBeforeConfigure = false;
    const hello = {
      v: 1,
      type: 'hello',
      transport: 'usb',
      requestId: 'filled-by-fake-port',
      sidekickId: 'sidekick-001',
      fw: '0.2.0',
      capabilities: ['display.text', 'wifi.websocket'],
      paired: false,
    };

    class FakeSerialPort extends EventEmitter {
      static async list() {
        return [{ path: '/dev/cu.usbmodem101', manufacturer: 'Espressif', vendorId: '303A', productId: '1001' }];
      }

      constructor(_options) {
        super();
        this.isOpen = false;
        this.parser = null;
      }

      pipe(parser) {
        this.parser = parser;
        return parser;
      }

      open(callback) {
        this.isOpen = true;
        callback();
      }

      write(line, callback) {
        const parsed = JSON.parse(String(line).trim());
        writes.push(parsed);
        if (parsed.cmd === 'pair.configure') {
          mdnsPublishedBeforeConfigure = Boolean(published);
        }
        if (parsed.cmd === 'hello.request') {
          setImmediate(() => {
            this.parser?.emit('data', `${JSON.stringify({
              ...hello,
              requestId: undefined,
              sidekickId: 'sidekick-periodic',
            })}\n`);
            this.parser?.emit('data', `${JSON.stringify({
              ...hello,
              requestId: 'wrong-request',
              sidekickId: 'sidekick-wrong-request',
            })}\n`);
            this.parser?.emit('data', `${JSON.stringify({ ...hello, requestId: parsed.id })}\n`);
          });
        }
        if (parsed.cmd === 'pair.configure') {
          setImmediate(() => {
            this.parser?.emit('data', `${JSON.stringify({ ...hello, requestId: parsed.id })}\n`);
            this.parser?.emit('data', `${JSON.stringify({
              v: 1,
              type: 'pair.configured',
              requestId: 'wrong-request',
              sidekickId: hello.sidekickId,
              hostname: parsed.hostname,
              paired: true,
            })}\n`);
            this.parser?.emit('data', `${JSON.stringify({
              v: 1,
              type: 'pair.configured',
              requestId: parsed.id,
              sidekickId: 'sidekick-other',
              hostname: parsed.hostname,
              paired: true,
            })}\n`);
            this.parser?.emit('data', `${JSON.stringify({
              v: 1,
              type: 'pair.configured',
              requestId: parsed.id,
              sidekickId: hello.sidekickId,
              hostname: 'wrong-hostname',
              paired: true,
            })}\n`);
            this.parser?.emit('data', `${JSON.stringify({
              v: 1,
              type: 'pair.configured',
              requestId: parsed.id,
              sidekickId: hello.sidekickId,
              hostname: parsed.hostname,
              paired: false,
            })}\n`);
            this.parser?.emit('data', `${JSON.stringify({
              v: 1,
              type: 'pair.configured',
              requestId: parsed.id,
              sidekickId: hello.sidekickId,
              hostname: parsed.hostname,
              paired: true,
            })}\n`);
          });
        }
        callback();
      }

      drain(callback) {
        callback();
      }

      close(callback) {
        this.isOpen = false;
        callback();
      }
    }

    let published = null;
    class FakeBonjour {
      publish(options) {
        published = options;
        return { stop: (callback) => callback?.() };
      }

      destroy(callback) {
        callback?.();
      }
    }

    const service = new SidekickService({
      metadataRoot: root,
      serialPortClass: FakeSerialPort,
      bonjourFactory: () => new FakeBonjour(),
      safeStorageAdapter: createSafeStorage(),
      getCloudIdentity: async () => ({ publicKey: 'public-key', keyFingerprint: 'desktop-fingerprint' }),
    });

    const result = await service.configureUsb({ ssid: 'Office Wi-Fi', password: 'wifi-pass', name: 'Desk Sidekick' });

    assert.equal(result.success, true);
    assert.equal(result.sidekicks[0].sidekickId, 'sidekick-001');
    assert.equal(result.sidekicks[0].hostname, writes[1].hostname);
    assert.equal(result.sidekicks[0].status, 'wifi_pending');
    assert.equal(mdnsPublishedBeforeConfigure, true);
    assert.equal(writes[0].cmd, 'hello.request');
    assert.equal(typeof writes[0].id, 'string');
    assert.ok(writes[0].id.length > 0);
    assert.equal(writes[1].cmd, 'pair.configure');
    assert.equal(writes[1].desktopId, 'desktop-fingerprint');
    assert.equal(writes[1].name, 'Desk Sidekick');
    assert.match(writes[1].hostname, /^desk-sidekick-[a-f0-9]{10}$/);
    assert.ok(writes[1].hostname.length <= 63);
    assert.equal(writes[1].mdnsService, '_forger-sidekick._tcp');
    assert.equal(published.type, 'forger-sidekick');
    assert.equal(published.name, `Forger Sidekick desktop- ${published.port}`);
    assert.equal(published.txt.desktopId, 'desktop-fingerprint');
    assert.equal(published.txt.proto, 'forger-sidekick-v1');

    const rawStore = await fs.readFile(path.join(root, 'sidekicks.json'), 'utf8');
    assert.equal(rawStore.includes('wifi-pass'), false);
    assert.equal(rawStore.includes(writes[1].pairingSecret), false);
    const stored = JSON.parse(rawStore);
    assert.equal(stored.records[0].hostname, writes[1].hostname);
    assert.equal(stored.records[0].encryptedPairingSecret, Buffer.from(`sealed:${writes[1].pairingSecret}`, 'utf8').toString('base64'));

    const invalidSocket = await openWebSocket(`ws://127.0.0.1:${result.servicePort}/sidekick`);
    invalidSocket.send(JSON.stringify(__testSidekickInternals.encryptSidekickPayload({
      v: 1,
      type: 'heartbeat',
      sidekickId: 'sidekick-001',
    }, {
      pairingSecretBase64: writes[1].pairingSecret,
      sidekickId: 'sidekick-001',
      desktopId: 'desktop-fingerprint',
      sessionId: 'session-invalid-first-message',
      seq: 1,
    })));
    await waitForSocketClose(invalidSocket);
    const pendingAfterInvalidHello = await service.getState();
    assert.equal(pendingAfterInvalidHello.sidekicks[0].status, 'wifi_pending');

    const wrongSecretSocket = await openWebSocket(`ws://127.0.0.1:${result.servicePort}/sidekick`);
    wrongSecretSocket.send(JSON.stringify(__testSidekickInternals.encryptSidekickPayload({
      v: 1,
      type: 'network.hello',
      sidekickId: 'sidekick-001',
    }, {
      pairingSecretBase64: randomBytes(32).toString('base64'),
      sidekickId: 'sidekick-001',
      desktopId: 'desktop-fingerprint',
      sessionId: 'session-wrong-secret',
      seq: 1,
    })));
    await waitForSocketClose(wrongSecretSocket);
    const pendingAfterWrongSecret = await service.getState();
    assert.equal(pendingAfterWrongSecret.sidekicks[0].status, 'wifi_pending');

    const wrongDesktopSocket = await openWebSocket(`ws://127.0.0.1:${result.servicePort}/sidekick`);
    wrongDesktopSocket.send(JSON.stringify(__testSidekickInternals.encryptSidekickPayload({
      v: 1,
      type: 'network.hello',
      sidekickId: 'sidekick-001',
    }, {
      pairingSecretBase64: writes[1].pairingSecret,
      sidekickId: 'sidekick-001',
      desktopId: 'wrong-desktop',
      sessionId: 'session-wrong-desktop',
      seq: 1,
    })));
    await waitForSocketClose(wrongDesktopSocket);
    const pendingAfterWrongDesktop = await service.getState();
    assert.equal(pendingAfterWrongDesktop.sidekicks[0].status, 'wifi_pending');

    const onlineSocket = await openWebSocket(`ws://127.0.0.1:${result.servicePort}/sidekick`);
    onlineSocket.send(JSON.stringify(__testSidekickInternals.encryptSidekickPayload({
      v: 1,
      type: 'network.hello',
      sidekickId: 'sidekick-001',
      fw: '0.3.0',
      capabilities: ['display.text', 'wifi.websocket', 'display.clear'],
      ip: '192.168.4.12',
    }, {
      pairingSecretBase64: writes[1].pairingSecret,
      sidekickId: 'sidekick-001',
      desktopId: 'desktop-fingerprint',
      sessionId: 'session-online',
      seq: 1,
    })));
    const online = await waitForState(
      () => service.getState(),
      (state) => state.sidekicks[0]?.status === 'online',
    );
    assert.equal(online.sidekicks[0].status, 'online');
    assert.equal(online.sidekicks[0].lastSeenAt.length > 0, true);
    assert.equal(online.sidekicks[0].firmwareVersion, '0.3.0');
    assert.deepEqual(online.sidekicks[0].capabilities, ['display.text', 'wifi.websocket', 'display.clear']);
    assert.equal(online.sidekicks[0].ipAddress, '192.168.4.12');

    const superseded = waitForSocketClose(onlineSocket);
    const replacementSocket = await openWebSocket(`ws://127.0.0.1:${result.servicePort}/sidekick`);
    replacementSocket.send(JSON.stringify(__testSidekickInternals.encryptSidekickPayload({
      v: 1,
      type: 'network.hello',
      sidekickId: 'sidekick-001',
      fw: '0.3.0',
      capabilities: ['display.text', 'wifi.websocket', 'display.clear'],
      ip: '192.168.4.12',
    }, {
      pairingSecretBase64: writes[1].pairingSecret,
      sidekickId: 'sidekick-001',
      desktopId: 'desktop-fingerprint',
      sessionId: 'session-replacement',
      seq: 1,
    })));
    await superseded;
    const replaced = await waitForState(
      () => service.getState(),
      (state) => state.sidekicks[0]?.status === 'online',
    );
    assert.equal(replaced.sidekicks[0].status, 'online');
    replacementSocket.close();
    await service.dispose();
  });
});

test('SidekickService fails pairing with a correlated pair.error code and does not persist a local record', async (t) => {
  const root = await tmpRoot('sidekick-service-pair-error');
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  await withMockedElectron({ safeStorage: createSafeStorage() }, async (require) => {
    clearDistModule('main/sidekick-service.js');
    const { SidekickService } = require('../../dist-electron/main/sidekick-service.js');
    const hello = {
      v: 1,
      type: 'hello',
      transport: 'usb',
      requestId: 'filled-by-fake-port',
      sidekickId: 'sidekick-001',
      fw: '0.2.0',
      capabilities: ['display.text', 'wifi.websocket'],
      paired: false,
    };

    class FakeSerialPort extends EventEmitter {
      static async list() {
        return [{ path: '/dev/cu.usbmodem101', manufacturer: 'Espressif', vendorId: '303A', productId: '1001' }];
      }

      constructor(_options) {
        super();
        this.isOpen = false;
        this.parser = null;
      }

      pipe(parser) {
        this.parser = parser;
        return parser;
      }

      open(callback) {
        this.isOpen = true;
        callback();
      }

      write(line, callback) {
        const parsed = JSON.parse(String(line).trim());
        if (parsed.cmd === 'hello.request') {
          setImmediate(() => {
            this.parser?.emit('data', `${JSON.stringify({ ...hello, requestId: parsed.id })}\n`);
          });
        }
        if (parsed.cmd === 'pair.configure') {
          setImmediate(() => {
            this.parser?.emit('data', `${JSON.stringify({
              v: 1,
              type: 'pair.error',
              requestId: parsed.id,
              sidekickId: 'sidekick-other',
              code: 'wrong-device-error',
            })}\n`);
            this.parser?.emit('data', `${JSON.stringify({
              v: 1,
              type: 'pair.error',
              requestId: 'wrong-request',
              sidekickId: hello.sidekickId,
              code: 'wrong-request-error',
            })}\n`);
            this.parser?.emit('data', `${JSON.stringify({
              v: 1,
              type: 'pair.error',
              requestId: parsed.id,
              sidekickId: hello.sidekickId,
              code: 'wifi_join_failed',
            })}\n`);
          });
        }
        callback();
      }

      drain(callback) {
        callback();
      }

      close(callback) {
        this.isOpen = false;
        callback();
      }
    }

    const service = new SidekickService({
      metadataRoot: root,
      serialPortClass: FakeSerialPort,
      bonjourFactory: () => ({
        publish: () => ({ stop: (callback) => callback?.() }),
        destroy: (callback) => callback?.(),
      }),
      safeStorageAdapter: createSafeStorage(),
      getCloudIdentity: async () => ({ publicKey: 'public-key', keyFingerprint: 'desktop-fingerprint' }),
    });

    const result = await service.configureUsb({ ssid: 'Office Wi-Fi', password: 'wifi-pass', name: 'Desk Sidekick' });
    await service.dispose();

    assert.equal(result.success, false);
    assert.equal(result.technicalCode, 'sidekick_usb_pair_error_wifi_join_failed');
    await assert.rejects(fs.readFile(path.join(root, 'sidekicks.json'), 'utf8'), { code: 'ENOENT' });
  });
});

test('SidekickService times out and does not persist when pair.configure is not acknowledged', async (t) => {
  const root = await tmpRoot('sidekick-service-pair-timeout');
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  await withMockedElectron({ safeStorage: createSafeStorage() }, async (require) => {
    clearDistModule('main/sidekick-service.js');
    const { SidekickService } = require('../../dist-electron/main/sidekick-service.js');
    const hello = {
      v: 1,
      type: 'hello',
      transport: 'usb',
      requestId: 'filled-by-fake-port',
      sidekickId: 'sidekick-001',
      fw: '0.2.0',
      capabilities: ['display.text', 'wifi.websocket'],
      paired: false,
    };

    class FakeSerialPort extends EventEmitter {
      static async list() {
        return [{ path: '/dev/cu.usbmodem101', manufacturer: 'Espressif', vendorId: '303A', productId: '1001' }];
      }

      constructor(_options) {
        super();
        this.isOpen = false;
        this.parser = null;
      }

      pipe(parser) {
        this.parser = parser;
        return parser;
      }

      open(callback) {
        this.isOpen = true;
        callback();
      }

      write(line, callback) {
        const parsed = JSON.parse(String(line).trim());
        if (parsed.cmd === 'hello.request') {
          setImmediate(() => {
            this.parser?.emit('data', `${JSON.stringify({ ...hello, requestId: parsed.id })}\n`);
          });
        }
        if (parsed.cmd === 'pair.configure') {
          setImmediate(() => {
            this.parser?.emit('data', `${JSON.stringify({
              v: 1,
              type: 'pair.configured',
              requestId: 'wrong-request',
              sidekickId: hello.sidekickId,
              hostname: parsed.hostname,
              paired: true,
            })}\n`);
            this.parser?.emit('data', `${JSON.stringify({
              v: 1,
              type: 'pair.configured',
              requestId: parsed.id,
              sidekickId: 'sidekick-other',
              hostname: parsed.hostname,
              paired: true,
            })}\n`);
          });
        }
        callback();
      }

      drain(callback) {
        callback();
      }

      close(callback) {
        this.isOpen = false;
        callback();
      }
    }

    const service = new SidekickService({
      metadataRoot: root,
      serialPortClass: FakeSerialPort,
      safeStorageAdapter: createSafeStorage(),
      getCloudIdentity: async () => ({ publicKey: 'public-key', keyFingerprint: 'desktop-fingerprint' }),
    });

    const result = await service.configureUsb({ ssid: 'Office Wi-Fi', password: 'wifi-pass', name: 'Desk Sidekick' });
    await service.dispose();

    assert.equal(result.success, false);
    assert.equal(result.technicalCode, 'sidekick_usb_pair_configure_timeout');
    await assert.rejects(fs.readFile(path.join(root, 'sidekicks.json'), 'utf8'), { code: 'ENOENT' });
  });
});

test('SidekickService normalizes battery telemetry from hello and heartbeat payloads', async (t) => {
  const root = await tmpRoot('sidekick-service-battery');
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  await withMockedElectron({ safeStorage: createSafeStorage() }, async (require) => {
    clearDistModule('main/sidekick-service.js');
    const { SidekickService, __testSidekickInternals } = require('../../dist-electron/main/sidekick-service.js');
    const pairingSecret = randomBytes(32).toString('base64');
    await writePairedSidekickStore(root, pairingSecret);
    const service = createSidekickService(SidekickService, root);

    const { socket, sendPayload } = await connectPairedSidekick({
      service,
      internals: __testSidekickInternals,
      pairingSecret,
      battery: { levelPercent: 78, charging: true, voltageMv: 4110 },
    });
    let state = await service.getState();
    assert.deepEqual(state.sidekicks[0].battery, { levelPercent: 78, charging: true, voltageMv: 4110 });

    sendPayload({ v: 1, type: 'heartbeat', battery: { levelPercent: 20, charging: false } });
    state = await waitForState(
      () => service.getState(),
      (candidate) => candidate.sidekicks[0]?.battery?.levelPercent === 20,
    );
    assert.deepEqual(state.sidekicks[0].battery, { levelPercent: 20, charging: false, voltageMv: undefined });

    sendPayload({ v: 1, type: 'battery.status', battery: { levelPercent: 120, charging: false } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    state = await service.getState();
    assert.equal(state.sidekicks[0].battery.levelPercent, 20);

    socket.close();
    await service.dispose();
  });
});

test('SidekickService persists an explicit personal-agent binding per device and can clear it', async (t) => {
  const root = await tmpRoot('sidekick-service-agent-binding');
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  await withMockedElectron({ safeStorage: createSafeStorage() }, async (require) => {
    clearDistModule('main/sidekick-service.js');
    const { SidekickService } = require('../../dist-electron/main/sidekick-service.js');
    const pairingSecret = randomBytes(32).toString('base64');
    await writePairedSidekickStore(root, pairingSecret);
    const service = createSidekickService(SidekickService, root);

    const assigned = await service.setPersonalAgent({ sidekickId: SIDEKICK_ID, personalAgentId: 'agent-voice-001' });
    assert.equal(assigned.success, true);
    assert.equal(assigned.sidekicks[0].personalAgentId, 'agent-voice-001');
    const persisted = JSON.parse(await fs.readFile(path.join(root, 'sidekicks.json'), 'utf8'));
    assert.equal(persisted.records[0].personalAgentId, 'agent-voice-001');

    const invalid = await service.setPersonalAgent({ sidekickId: SIDEKICK_ID, personalAgentId: '../agent' });
    assert.equal(invalid.success, false);
    assert.equal(invalid.technicalCode, 'sidekick_personal_agent_id_invalid');
    assert.equal((await service.getState()).sidekicks[0].personalAgentId, 'agent-voice-001');

    const reloaded = createSidekickService(SidekickService, root);
    assert.equal((await reloaded.getState()).sidekicks[0].personalAgentId, 'agent-voice-001');
    const cleared = await reloaded.setPersonalAgent({ sidekickId: SIDEKICK_ID });
    assert.equal(cleared.success, true);
    assert.equal(cleared.sidekicks[0].personalAgentId, undefined);
    await service.dispose();
    await reloaded.dispose();
  });
});

test('SidekickService rejects remote microphone start when offline or capability is missing', async (t) => {
  const root = await tmpRoot('sidekick-service-mic-rejections');
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  await withMockedElectron({ safeStorage: createSafeStorage() }, async (require) => {
    clearDistModule('main/sidekick-service.js');
    const { SidekickService, __testSidekickInternals } = require('../../dist-electron/main/sidekick-service.js');
    const pairingSecret = randomBytes(32).toString('base64');
    await writePairedSidekickStore(root, pairingSecret, ['display.text', 'wifi.websocket', 'microphone.record']);
    const service = createSidekickService(SidekickService, root);

    const offline = await service.startMicrophoneRecording({ sidekickId: SIDEKICK_ID });
    assert.equal(offline.success, false);
    assert.equal(offline.technicalCode, 'sidekick_offline');

    const { socket } = await connectPairedSidekick({
      service,
      internals: __testSidekickInternals,
      pairingSecret,
      capabilities: ['display.text', 'wifi.websocket'],
    });
    const missingCapability = await service.startMicrophoneRecording({ sidekickId: SIDEKICK_ID });
    assert.equal(missingCapability.success, false);
    assert.equal(missingCapability.technicalCode, 'sidekick_microphone_capability_missing');

    socket.close();
    await service.dispose();
  });
});

test('SidekickService records canonical PCM chunks and finalizes a playable WAV with protected playback', async (t) => {
  const root = await tmpRoot('sidekick-service-mic-success');
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  await withMockedElectron({ safeStorage: createSafeStorage() }, async (require) => {
    clearDistModule('main/sidekick-service.js');
    const { SidekickService, __testSidekickInternals } = require('../../dist-electron/main/sidekick-service.js');
    const pairingSecret = randomBytes(32).toString('base64');
    await writePairedSidekickStore(root, pairingSecret, ['display.text', 'wifi.websocket', 'microphone.record']);
    const service = createSidekickService(SidekickService, root, { maxRecordingBytes: 512 });
    const { socket, sendPayload } = await connectPairedSidekick({ service, internals: __testSidekickInternals, pairingSecret });

    const startPromise = service.startMicrophoneRecording({ sidekickId: SIDEKICK_ID });
    const startCommand = await readDesktopCommand(socket, __testSidekickInternals, pairingSecret);
    assert.equal(startCommand.cmd, 'microphone.record.start');
    assert.equal(startCommand.sampleRate, 16000);
    assert.equal(startCommand.channels, 1);
    assert.equal(startCommand.format, 'pcm_s16le');
    assert.equal(typeof startCommand.recordingId, 'string');

    sendPayload({
      v: 1,
      type: 'microphone.recording.started',
      recordingId: startCommand.recordingId,
      sampleRate: 16000,
      channels: 1,
      format: 'pcm_s16le',
    });
    const started = await startPromise;
    assert.equal(started.success, true);
    assert.equal(started.sidekicks[0].microphoneRecording.status, 'recording');

    sendPayload({
      v: 1,
      type: 'microphone.recording.chunk',
      recordingId: startCommand.recordingId,
      data: Buffer.from([0x00, 0x00, 0xff, 0x7f]).toString('base64'),
    });
    await waitForState(
      () => service.getState(),
      (candidate) => candidate.sidekicks[0]?.microphoneRecording?.bytes === 4,
    );

    const stopPromise = service.stopMicrophoneRecording({ sidekickId: SIDEKICK_ID });
    const stopCommand = await readDesktopCommand(socket, __testSidekickInternals, pairingSecret);
    assert.equal(stopCommand.cmd, 'microphone.record.stop');
    assert.equal(stopCommand.recordingId, startCommand.recordingId);
    sendPayload({
      v: 1,
      type: 'microphone.recording.chunk',
      recordingId: startCommand.recordingId,
      data: Buffer.from([0x01, 0x00]).toString('base64'),
    });
    sendPayload({
      v: 1,
      type: 'microphone.recording.stopped',
      recordingId: startCommand.recordingId,
      sampleCount: 3,
    });
    const stopped = await stopPromise;
    assert.equal(stopped.success, true);
    assert.equal(stopped.sidekicks[0].microphoneRecording.status, 'idle');
    assert.equal(stopped.sidekicks[0].microphoneRecordings.length, 1);
    assert.equal(stopped.sidekicks[0].microphoneRecordings[0].recordingId, startCommand.recordingId);
    assert.equal(stopped.sidekicks[0].microphoneRecordings[0].sampleCount, 3);
    assert.equal(stopped.sidekicks[0].microphoneRecordings[0].sizeBytes, 50);

    const playback = await service.readMicrophoneRecording({
      sidekickId: SIDEKICK_ID,
      recordingId: startCommand.recordingId,
    });
    assert.equal(playback.success, true);
    assert.equal(playback.mimeType, 'audio/wav');
    const wav = Buffer.from(playback.bytes);
    assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
    assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
    assert.equal(wav.readUInt32LE(24), 16000);
    assert.equal(wav.readUInt16LE(22), 1);
    assert.equal(wav.readUInt16LE(34), 16);
    assert.equal(wav.readUInt32LE(40), 6);

    await fs.writeFile(path.join(root, 'sidekick-recordings', 'files', `${startCommand.recordingId}.wav`), Buffer.alloc(1024));
    const tooLargePlayback = await service.readMicrophoneRecording({
      sidekickId: SIDEKICK_ID,
      recordingId: startCommand.recordingId,
    });
    assert.equal(tooLargePlayback.success, false);
    assert.equal(tooLargePlayback.technicalCode, 'sidekick_microphone_recording_size_invalid');

    socket.close();
    await service.dispose();
  });
});

test('SidekickService discards an incomplete microphone capture when stopped sample count does not match', async (t) => {
  const root = await tmpRoot('sidekick-service-mic-sample-mismatch');
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  await withMockedElectron({ safeStorage: createSafeStorage() }, async (require) => {
    clearDistModule('main/sidekick-service.js');
    const { SidekickService, __testSidekickInternals } = require('../../dist-electron/main/sidekick-service.js');
    const pairingSecret = randomBytes(32).toString('base64');
    await writePairedSidekickStore(root, pairingSecret, ['display.text', 'wifi.websocket', 'microphone.record']);
    const service = createSidekickService(SidekickService, root);
    const { socket, sendPayload } = await connectPairedSidekick({ service, internals: __testSidekickInternals, pairingSecret });

    const startPromise = service.startMicrophoneRecording({ sidekickId: SIDEKICK_ID });
    const startCommand = await readDesktopCommand(socket, __testSidekickInternals, pairingSecret);
    sendPayload({
      v: 1,
      type: 'microphone.recording.started',
      recordingId: startCommand.recordingId,
      sampleRate: 16000,
      channels: 1,
      format: 'pcm_s16le',
    });
    await startPromise;
    sendPayload({
      v: 1,
      type: 'microphone.recording.chunk',
      recordingId: startCommand.recordingId,
      data: Buffer.from([0x00, 0x00]).toString('base64'),
    });
    await waitForState(
      () => service.getState(),
      (candidate) => candidate.sidekicks[0]?.microphoneRecording?.bytes === 2,
    );

    const stopPromise = service.stopMicrophoneRecording({ sidekickId: SIDEKICK_ID });
    await readDesktopCommand(socket, __testSidekickInternals, pairingSecret);
    sendPayload({
      v: 1,
      type: 'microphone.recording.stopped',
      recordingId: startCommand.recordingId,
      sampleCount: 2,
    });
    const stopped = await stopPromise;
    assert.equal(stopped.success, false);
    assert.equal(stopped.technicalCode, 'sidekick_microphone_sample_count_mismatch');

    const state = await waitForState(
      () => service.getState(),
      (candidate) => candidate.sidekicks[0]?.microphoneRecording?.status === 'error',
    );
    assert.equal(state.sidekicks[0].status, 'online');
    assert.equal(state.sidekicks[0].microphoneRecording.technicalCode, 'sidekick_microphone_sample_count_mismatch');
    assert.equal(state.sidekicks[0].microphoneRecordings.length, 0);
    await assert.rejects(
      fs.stat(path.join(root, 'sidekick-recordings', 'tmp', `${startCommand.recordingId}.pcm`)),
      { code: 'ENOENT' },
    );

    socket.close();
    await service.dispose();
  });
});

test('SidekickService ignores out-of-session microphone chunks without closing the socket', async (t) => {
  const root = await tmpRoot('sidekick-service-mic-invalid');
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  await withMockedElectron({ safeStorage: createSafeStorage() }, async (require) => {
    clearDistModule('main/sidekick-service.js');
    const { SidekickService, __testSidekickInternals } = require('../../dist-electron/main/sidekick-service.js');
    const pairingSecret = randomBytes(32).toString('base64');
    await writePairedSidekickStore(root, pairingSecret, ['display.text', 'wifi.websocket', 'microphone.record']);
    const service = createSidekickService(SidekickService, root);
    const { socket, sendPayload } = await connectPairedSidekick({ service, internals: __testSidekickInternals, pairingSecret });

    sendPayload({
      v: 1,
      type: 'microphone.recording.chunk',
      recordingId: 'wrong-recording',
      data: Buffer.from([0x00, 0x00]).toString('base64'),
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(socket.readyState, WebSocket.OPEN);
    const state = await service.getState();
    assert.equal(state.sidekicks[0].status, 'online');

    await service.dispose();
  });
});

test('SidekickService fails oversized or noncanonical microphone chunks and asks the device to stop', async (t) => {
  const root = await tmpRoot('sidekick-service-mic-size');
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  await withMockedElectron({ safeStorage: createSafeStorage() }, async (require) => {
    clearDistModule('main/sidekick-service.js');
    const { SidekickService, __testSidekickInternals } = require('../../dist-electron/main/sidekick-service.js');
    const pairingSecret = randomBytes(32).toString('base64');
    await writePairedSidekickStore(root, pairingSecret, ['display.text', 'wifi.websocket', 'microphone.record']);
    const service = createSidekickService(SidekickService, root, { maxRecordingBytes: 64 });
    const { socket, sendPayload } = await connectPairedSidekick({ service, internals: __testSidekickInternals, pairingSecret });

    const startPromise = service.startMicrophoneRecording({ sidekickId: SIDEKICK_ID });
    const startCommand = await readDesktopCommand(socket, __testSidekickInternals, pairingSecret);
    sendPayload({
      v: 1,
      type: 'microphone.recording.started',
      recordingId: startCommand.recordingId,
      sampleRate: 16000,
      channels: 1,
      format: 'pcm_s16le',
    });
    await startPromise;
    // El comando de stop se emite apenas el chunk invalido se procesa, asi
    // que el listener debe quedar armado antes de enviar el chunk.
    const firstStopPromise = readDesktopCommand(socket, __testSidekickInternals, pairingSecret);
    sendPayload({
      v: 1,
      type: 'microphone.recording.chunk',
      recordingId: startCommand.recordingId,
      data: Buffer.alloc(22).toString('base64'),
    });
    const firstStop = await firstStopPromise;
    let state = await waitForState(
      () => service.getState(),
      (candidate) => candidate.sidekicks[0]?.microphoneRecording?.status === 'error',
    );
    assert.equal(state.sidekicks[0].microphoneRecording.technicalCode, 'sidekick_microphone_recording_too_large');
    assert.equal(firstStop.cmd, 'microphone.record.stop');
    assert.equal(firstStop.recordingId, startCommand.recordingId);
    assert.equal(socket.readyState, WebSocket.OPEN);

    const secondStartPromise = service.startMicrophoneRecording({ sidekickId: SIDEKICK_ID });
    const secondStartCommand = await readDesktopCommand(socket, __testSidekickInternals, pairingSecret);
    sendPayload({
      v: 1,
      type: 'microphone.recording.started',
      recordingId: secondStartCommand.recordingId,
      sampleRate: 16000,
      channels: 1,
      format: 'pcm_s16le',
    });
    await secondStartPromise;
    const secondStopPromise = readDesktopCommand(socket, __testSidekickInternals, pairingSecret);
    sendPayload({
      v: 1,
      type: 'microphone.recording.chunk',
      recordingId: secondStartCommand.recordingId,
      data: 'AA',
    });
    const secondStop = await secondStopPromise;
    state = await waitForState(
      () => service.getState(),
      (candidate) => candidate.sidekicks[0]?.microphoneRecording?.technicalCode === 'sidekick_microphone_chunk_invalid',
    );
    assert.equal(state.sidekicks[0].microphoneRecording.status, 'error');
    assert.equal(secondStop.cmd, 'microphone.record.stop');
    assert.equal(secondStop.recordingId, secondStartCommand.recordingId);
    assert.equal(socket.readyState, WebSocket.OPEN);

    await service.dispose();
  });
});

test('SidekickService cleans up active staged microphone recordings when the socket closes', async (t) => {
  const root = await tmpRoot('sidekick-service-mic-close-cleanup');
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  await withMockedElectron({ safeStorage: createSafeStorage() }, async (require) => {
    clearDistModule('main/sidekick-service.js');
    const { SidekickService, __testSidekickInternals } = require('../../dist-electron/main/sidekick-service.js');
    const pairingSecret = randomBytes(32).toString('base64');
    await writePairedSidekickStore(root, pairingSecret, ['display.text', 'wifi.websocket', 'microphone.record']);
    const service = createSidekickService(SidekickService, root);
    const { socket, sendPayload } = await connectPairedSidekick({ service, internals: __testSidekickInternals, pairingSecret });

    const startPromise = service.startMicrophoneRecording({ sidekickId: SIDEKICK_ID });
    const startCommand = await readDesktopCommand(socket, __testSidekickInternals, pairingSecret);
    sendPayload({
      v: 1,
      type: 'microphone.recording.started',
      recordingId: startCommand.recordingId,
      sampleRate: 16000,
      channels: 1,
      format: 'pcm_s16le',
    });
    await startPromise;
    sendPayload({
      v: 1,
      type: 'microphone.recording.chunk',
      recordingId: startCommand.recordingId,
      data: Buffer.from([0x00, 0x00]).toString('base64'),
    });
    socket.close();
    await waitForSocketClose(socket);
    const state = await waitForState(
      () => service.getState(),
      (candidate) => candidate.sidekicks[0]?.microphoneRecording?.status === 'error',
    );
    assert.equal(state.sidekicks[0].microphoneRecording.status, 'error');
    assert.equal(state.sidekicks[0].microphoneRecording.technicalCode, 'sidekick_socket_closed');
    await assert.rejects(fs.stat(path.join(root, 'sidekick-recordings', 'tmp', `${startCommand.recordingId}.pcm`)), { code: 'ENOENT' });

    await service.dispose();
  });
});

test('SidekickService localizes and corrects time immediately after the encrypted hello', async (t) => {
  const root = await tmpRoot('sidekick-service-time-sync');
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  await withMockedElectron({ safeStorage: createSafeStorage() }, async (require) => {
    clearDistModule('main/sidekick-service.js');
    const { SidekickService, __testSidekickInternals } = require('../../dist-electron/main/sidekick-service.js');
    const pairingSecret = randomBytes(32).toString('base64');
    await writePairedSidekickStore(root, pairingSecret, ['display.text', 'wifi.websocket', 'system.time.sync']);
    const service = createSidekickService(SidekickService, root, {
      getTimeSync: () => ({
        epochMs: 1_784_201_400_123,
        timeZone: 'America/Santiago',
        utcOffsetMinutes: -180,
      }),
    });
    const { socket, timeSyncCommand } = await connectPairedSidekick({
      service,
      internals: __testSidekickInternals,
      pairingSecret,
      capabilities: ['display.text', 'wifi.websocket', 'system.time.sync'],
    });

    assert.deepEqual(timeSyncCommand, {
      v: 1,
      id: timeSyncCommand.id,
      cmd: 'system.time.sync',
      epochMs: 1_784_201_400_123,
      timeZone: 'America/Santiago',
      utcOffsetMinutes: -180,
    });
    socket.close();
    await service.dispose();
  });
});

test('SidekickService streams PCM chunks within the firmware credit window and drains playback', async (t) => {
  const root = await tmpRoot('sidekick-service-speaker');
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  await withMockedElectron({ safeStorage: createSafeStorage() }, async (require) => {
    clearDistModule('main/sidekick-service.js');
    const { SidekickService, __testSidekickInternals } = require('../../dist-electron/main/sidekick-service.js');
    const pairingSecret = randomBytes(32).toString('base64');
    await writePairedSidekickStore(root, pairingSecret, ['wifi.websocket', 'speaker.playback', 'microphone.record', 'system.time.sync']);
    const service = createSidekickService(SidekickService, root);
    const { socket, sendPayload } = await connectPairedSidekick({
      service,
      internals: __testSidekickInternals,
      pairingSecret,
      capabilities: ['wifi.websocket', 'speaker.playback', 'microphone.record', 'system.time.sync'],
    });
    const samples = Int16Array.from({ length: 1026 }, (_, index) => index - 513);
    const playbackPromise = service.playSpeakerPcm({ sidekickId: SIDEKICK_ID, samples });

    const start = await readDesktopCommand(socket, __testSidekickInternals, pairingSecret);
    assert.equal(start.cmd, 'speaker.play.start');
    assert.equal(start.sampleRate, 16000);
    assert.equal(start.channels, 1);
    assert.equal(start.format, 'pcm_s16le');
    const microphoneWhilePlaying = await service.startMicrophoneRecording({ sidekickId: SIDEKICK_ID, transient: true });
    assert.equal(microphoneWhilePlaying.success, false);
    assert.equal(microphoneWhilePlaying.technicalCode, 'sidekick_audio_busy');
    sendPayload({
      v: 1,
      type: 'speaker.playback.started',
      playbackId: start.playbackId,
      maxChunkSamples: 1024,
      queueDepth: 8,
    });

    const first = await readDesktopCommand(socket, __testSidekickInternals, pairingSecret);
    assert.equal(first.cmd, 'speaker.play.chunk');
    assert.equal(first.chunkSequence, 0);
    assert.equal(first.sampleCount, 1024);
    assert.equal(Buffer.from(first.pcmBase64, 'base64').length, 2048);

    sendPayload({
      v: 1,
      type: 'speaker.playback.progress',
      playbackId: start.playbackId,
      lastChunkSequence: 0,
      bufferedSamples: 0,
      underruns: 0,
    });

    const second = await readDesktopCommand(socket, __testSidekickInternals, pairingSecret);
    assert.equal(second.chunkSequence, 1);
    assert.equal(second.sampleCount, 2);
    sendPayload({
      v: 1,
      type: 'speaker.playback.progress',
      playbackId: start.playbackId,
      lastChunkSequence: 1,
      bufferedSamples: 0,
      underruns: 0,
    });

    const stop = await readDesktopCommand(socket, __testSidekickInternals, pairingSecret);
    assert.equal(stop.cmd, 'speaker.play.stop');
    sendPayload({
      v: 1,
      type: 'speaker.playback.stopped',
      playbackId: start.playbackId,
      samplesPlayed: 1026,
      underruns: 0,
      droppedChunks: 0,
    });
    const played = await playbackPromise;
    assert.equal(played.success, true);
    assert.equal(played.playbackId, start.playbackId);
    assert.equal(played.samplesPlayed, 1026);

    socket.close();
    await service.dispose();
  });
});

test('SidekickService drains a cancelled speaker session without closing the socket', async (t) => {
  const root = await tmpRoot('sidekick-service-speaker-cancel');
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  await withMockedElectron({ safeStorage: createSafeStorage() }, async (require) => {
    clearDistModule('main/sidekick-service.js');
    const { SidekickService, __testSidekickInternals } = require('../../dist-electron/main/sidekick-service.js');
    const pairingSecret = randomBytes(32).toString('base64');
    await writePairedSidekickStore(root, pairingSecret, ['wifi.websocket', 'speaker.playback']);
    const service = createSidekickService(SidekickService, root);
    const { socket, sendPayload } = await connectPairedSidekick({
      service,
      internals: __testSidekickInternals,
      pairingSecret,
      capabilities: ['wifi.websocket', 'speaker.playback'],
    });
    const playbackPromise = service.playSpeakerPcm({
      sidekickId: SIDEKICK_ID,
      samples: Int16Array.from({ length: 1024 }, (_, index) => index),
    });
    const start = await readDesktopCommand(socket, __testSidekickInternals, pairingSecret);
    sendPayload({
      v: 1,
      type: 'speaker.playback.started',
      playbackId: start.playbackId,
      maxChunkSamples: 1024,
      queueDepth: 8,
    });
    await readDesktopCommand(socket, __testSidekickInternals, pairingSecret);
    sendPayload({
      v: 1,
      type: 'speaker.playback.error',
      playbackId: start.playbackId,
      code: 'playback_backpressure',
    });

    const cancel = await readDesktopCommand(socket, __testSidekickInternals, pairingSecret);
    assert.equal(cancel.cmd, 'speaker.play.cancel');
    sendPayload({
      v: 1,
      type: 'speaker.playback.stopped',
      playbackId: start.playbackId,
      samplesPlayed: 0,
      underruns: 0,
      droppedChunks: 0,
      cancelled: true,
    });
    const result = await playbackPromise;
    assert.equal(result.success, false);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(socket.readyState, WebSocket.OPEN);

    socket.close();
    await service.dispose();
  });
});
