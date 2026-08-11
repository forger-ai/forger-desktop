import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import Module, { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);
const nativeHostPath = require.resolve('../../dist-electron/main/tools/chrome-extension/native-host.js');

const frame = (message) => {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.byteLength, 0);
  return Buffer.concat([header, body]);
};

const frameRaw = (value) => {
  const body = Buffer.from(value, 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.byteLength, 0);
  return Buffer.concat([header, body]);
};

test('native host validates config and bridges framed messages across its WebSocket lifecycle', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forger-b28-native-host-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const originalArg = process.argv[2];
  const originalLoad = Module._load;
  const originalStdoutWrite = process.stdout.write;
  const originalStderrWrite = process.stderr.write;
  const originalExit = process.exit;
  const initialDataListeners = new Set(process.stdin.listeners('data'));

  const requireFresh = () => {
    delete require.cache[nativeHostPath];
    return require(nativeHostPath);
  };

  try {
    delete process.argv[2];
    assert.throws(requireFresh, /bridge_config_missing/);

    for (const [name, config] of [
      ['port', { port: '3000', token: 'token' }],
      ['token-type', { port: 3000, token: 7 }],
      ['token-empty', { port: 3000, token: '' }],
    ]) {
      const configPath = path.join(root, `${name}.json`);
      await fs.writeFile(configPath, JSON.stringify(config), 'utf8');
      process.argv[2] = configPath;
      assert.throws(requireFresh, /bridge_config_invalid/, name);
    }

    const sockets = [];
    class FakeWebSocket {
      static OPEN = 1;

      constructor(url) {
        this.url = url;
        this.readyState = FakeWebSocket.OPEN;
        this.handlers = new Map();
        this.onceHandlers = new Map();
        this.sent = [];
        sockets.push(this);
      }

      on(event, handler) {
        this.handlers.set(event, handler);
      }

      once(event, handler) {
        this.onceHandlers.set(event, handler);
      }

      send(message) {
        this.sent.push(message);
      }

      emit(event, value) {
        this.handlers.get(event)?.(value);
        const once = this.onceHandlers.get(event);
        if (once) {
          this.onceHandlers.delete(event);
          once(value);
        }
      }
    }

    const output = [];
    const errors = [];
    const exits = [];
    process.stdout.write = (chunk) => {
      output.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      return true;
    };
    process.stderr.write = (chunk) => {
      errors.push(String(chunk));
      return true;
    };
    process.exit = (code) => {
      exits.push(code);
    };
    Module._load = function loadWithFakeSocket(request, parent, isMain) {
      if (request === 'ws') return { WebSocket: FakeWebSocket };
      return originalLoad.call(this, request, parent, isMain);
    };

    const validConfig = path.join(root, 'valid.json');
    await fs.writeFile(validConfig, JSON.stringify({ port: 34123, token: 'token with spaces' }), 'utf8');
    process.argv[2] = validConfig;
    requireFresh();

    assert.equal(sockets.length, 1);
    const socket = sockets[0];
    assert.equal(socket.url, 'ws://127.0.0.1:34123/chrome-extension-native-host?token=token%20with%20spaces');

    socket.emit('message', JSON.stringify({ type: 'bridge_ready' }));
    assert.equal(output.length, 1);
    const framedOutput = output[0];
    const outputLength = framedOutput.readUInt32LE(0);
    assert.equal(outputLength, framedOutput.byteLength - 4);
    assert.deepEqual(JSON.parse(framedOutput.subarray(4).toString('utf8')), { type: 'bridge_ready' });

    socket.emit('message', '{');
    socket.emit('message', { [Symbol.toPrimitive]: () => { throw 'opaque bridge payload'; } });
    assert.equal(errors.some((entry) => entry.includes('bridge_message_parse_failed')), true);

    const readyMessage = frame({ id: 1, method: 'ping' });
    process.stdin.emit('data', readyMessage.subarray(0, 4));
    assert.equal(socket.sent.length, 0);
    process.stdin.emit('data', readyMessage.subarray(4));
    assert.deepEqual(JSON.parse(socket.sent[0]), { id: 1, method: 'ping' });

    socket.readyState = 0;
    process.stdin.emit('data', frame({ id: 2, method: 'wait' }));
    assert.equal(socket.sent.length, 1);
    socket.emit('open');
    assert.deepEqual(JSON.parse(socket.sent[1]), { id: 2, method: 'wait' });

    process.stdin.emit('data', frameRaw('{'));
    const originalJsonParse = JSON.parse;
    JSON.parse = () => { throw 'opaque native payload'; };
    try {
      process.stdin.emit('data', frame({ id: 3 }));
    } finally {
      JSON.parse = originalJsonParse;
    }
    assert.equal(errors.some((entry) => entry.includes('native_message_parse_failed')), true);

    socket.emit('close');
    socket.emit('error', new Error('socket failed'));
    assert.deepEqual(exits, [0, 1]);
    assert.equal(errors.some((entry) => entry.includes('socket failed')), true);
  } finally {
    Module._load = originalLoad;
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
    process.exit = originalExit;
    if (originalArg === undefined) delete process.argv[2];
    else process.argv[2] = originalArg;
    for (const listener of process.stdin.listeners('data')) {
      if (!initialDataListeners.has(listener)) process.stdin.removeListener('data', listener);
    }
    process.stdin.pause();
    delete require.cache[nativeHostPath];
  }
});
