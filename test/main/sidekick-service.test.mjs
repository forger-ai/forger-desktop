import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { WebSocket } from 'ws';

import { clearDistModule, withMockedElectron } from './electron-test-helpers.mjs';

const require = createRequire(import.meta.url);

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
  return { socket, sendPayload };
};

const readDesktopCommand = async (socket, internals, pairingSecret) => await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => {
    socket.off('message', onMessage);
    reject(new Error('desktop_command_timeout'));
  }, 1000);
  const onMessage = (raw) => {
    clearTimeout(timeout);
    try {
      resolve(internals.decryptSidekickEnvelope(JSON.parse(raw.toString()), pairingSecret));
    } catch (error) {
      reject(error);
    }
  };
  socket.once('message', onMessage);
});

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
    onlineSocket.close();
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

test('SidekickService rejects malformed or out-of-session microphone data and closes the socket', async (t) => {
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
    await waitForSocketClose(socket);
    const state = await waitForState(
      () => service.getState(),
      (candidate) => candidate.sidekicks[0]?.status === 'offline',
    );
    assert.equal(state.sidekicks[0].status, 'offline');

    await service.dispose();
  });
});

test('SidekickService enforces microphone size bounds and rejects noncanonical base64 chunks', async (t) => {
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
    sendPayload({
      v: 1,
      type: 'microphone.recording.chunk',
      recordingId: startCommand.recordingId,
      data: Buffer.alloc(22).toString('base64'),
    });
    await waitForSocketClose(socket);
    let state = await service.getState();
    assert.equal(state.sidekicks[0].microphoneRecording.status, 'error');
    assert.equal(state.sidekicks[0].microphoneRecording.technicalCode, 'sidekick_microphone_recording_too_large');

    const second = await connectPairedSidekick({ service, internals: __testSidekickInternals, pairingSecret });
    const secondStartPromise = service.startMicrophoneRecording({ sidekickId: SIDEKICK_ID });
    const secondStartCommand = await readDesktopCommand(second.socket, __testSidekickInternals, pairingSecret);
    second.sendPayload({
      v: 1,
      type: 'microphone.recording.started',
      recordingId: secondStartCommand.recordingId,
      sampleRate: 16000,
      channels: 1,
      format: 'pcm_s16le',
    });
    await secondStartPromise;
    second.sendPayload({
      v: 1,
      type: 'microphone.recording.chunk',
      recordingId: secondStartCommand.recordingId,
      data: 'AA',
    });
    await waitForSocketClose(second.socket);
    state = await service.getState();
    assert.equal(state.sidekicks[0].microphoneRecording.status, 'error');
    assert.equal(state.sidekicks[0].microphoneRecording.technicalCode, 'sidekick_microphone_chunk_invalid');

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
