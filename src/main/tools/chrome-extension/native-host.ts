import fs from 'node:fs';
import { WebSocket } from 'ws';
import type { ChromeExtensionNativeMessage } from './types';

interface BridgeConfig {
  port: number;
  token: string;
}

const configPath = process.argv[2];

const log = (message: string): void => {
  process.stderr.write(`[forger-chrome-extension-host] ${message}\n`);
};

const readConfig = (): BridgeConfig => {
  if (!configPath) {
    throw new Error('bridge_config_missing');
  }
  const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Partial<BridgeConfig>;
  if (!Number.isFinite(parsed.port) || typeof parsed.token !== 'string' || !parsed.token) {
    throw new Error('bridge_config_invalid');
  }
  return { port: parsed.port as number, token: parsed.token };
};

const writeNativeMessage = (message: ChromeExtensionNativeMessage): void => {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.byteLength, 0);
  process.stdout.write(Buffer.concat([header, body]));
};

const readNativeMessages = (onMessage: (message: ChromeExtensionNativeMessage) => void): void => {
  let buffer = Buffer.alloc(0);
  process.stdin.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.byteLength >= 4) {
      const length = buffer.readUInt32LE(0);
      if (buffer.byteLength < 4 + length) {
        return;
      }
      const body = buffer.subarray(4, 4 + length);
      buffer = buffer.subarray(4 + length);
      try {
        onMessage(JSON.parse(body.toString('utf8')) as ChromeExtensionNativeMessage);
      } catch (error) {
        log(error instanceof Error ? error.message : 'native_message_parse_failed');
      }
    }
  });
};

const main = (): void => {
  const config = readConfig();
  const socket = new WebSocket(`ws://127.0.0.1:${config.port}/chrome-extension-native-host?token=${encodeURIComponent(config.token)}`);

  socket.on('message', (raw) => {
    try {
      writeNativeMessage(JSON.parse(String(raw)) as ChromeExtensionNativeMessage);
    } catch (error) {
      log(error instanceof Error ? error.message : 'bridge_message_parse_failed');
    }
  });

  socket.on('close', () => process.exit(0));
  socket.on('error', (error) => {
    log(error.message);
    process.exit(1);
  });

  readNativeMessages((message) => {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
    } else {
      const sendWhenOpen = (): void => {
        socket.send(JSON.stringify(message));
      };
      socket.once('open', sendWhenOpen);
    }
  });
};

main();
