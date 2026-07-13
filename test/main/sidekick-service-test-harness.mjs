import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { WebSocket } from 'ws';

export const SIDEKICK_ID = 'sidekick-001';
export const DESKTOP_ID = 'desktop-fingerprint';

export const createSafeStorage = () => ({
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(`sealed:${value}`, 'utf8'),
  decryptString: (buffer) => buffer.toString('utf8').replace(/^sealed:/, ''),
});

export const tmpRoot = async (name) => await fs.mkdtemp(path.join(os.tmpdir(), `forger-${name}-`));

export const openWebSocket = async (url) => await new Promise((resolve, reject) => {
  const socket = new WebSocket(url);
  socket.once('open', () => resolve(socket));
  socket.once('error', reject);
});

export const waitForSocketClose = async (socket) => await new Promise((resolve) => {
  if (socket.readyState === WebSocket.CLOSED) {
    resolve();
    return;
  }
  socket.once('close', () => resolve());
});

export const waitForState = async (readState, predicate) => {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const state = await readState();
    if (predicate(state)) return state;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return await readState();
};

export const writePairedSidekickStore = async (
  root,
  pairingSecret,
  capabilities = ['display.text', 'wifi.websocket'],
  recordOverrides = {},
) => {
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
      ...recordOverrides,
    }],
  }), 'utf8');
};

export const createSidekickService = (SidekickService, root, options = {}) => {
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

export const connectPairedSidekick = async ({
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
    socket.send(JSON.stringify(internals.encryptSidekickPayload({ sidekickId: SIDEKICK_ID, ...payload }, {
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
  await waitForState(() => service.getState(), (state) => state.sidekicks[0]?.status === 'online');
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

const desktopCommandQueue = (socket) => {
  if (!socket.__desktopCommandQueue) {
    const queue = { messages: [], waiters: [] };
    socket.__desktopCommandQueue = queue;
    socket.on('message', (raw) => {
      const waiter = queue.waiters.shift();
      if (waiter) waiter(raw);
      else queue.messages.push(raw);
    });
  }
  return socket.__desktopCommandQueue;
};

export const readDesktopCommand = async (socket, internals, pairingSecret, { includeCustomization = false } = {}) => {
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
          if (index >= 0) queue.waiters.splice(index, 1);
          reject(new Error('desktop_command_timeout'));
        }, 1000);
        queue.waiters.push(waiter);
      });
    const command = internals.decryptSidekickEnvelope(JSON.parse(raw.toString()), pairingSecret);
    const isCustomization = typeof command.cmd === 'string' &&
      (command.cmd.startsWith('idle.') || command.cmd === 'limits.update');
    if (!isCustomization || includeCustomization) return command;
  }
};
