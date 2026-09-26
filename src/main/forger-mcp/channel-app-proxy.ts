import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { LlmMcpServerConfig } from '../llm-provider/types';

/** A run receives a revocable token, never the app's shared upstream token. */
export const createChannelAppMcpProxy = async (
  upstream: LlmMcpServerConfig,
  authorize: () => Promise<boolean>,
): Promise<{ config: LlmMcpServerConfig; close: () => void }> => {
  const destination = new URL(upstream.url);
  if (destination.protocol !== 'http:' || destination.hostname !== '127.0.0.1') throw new Error('whatsapp_channel_app_endpoint_invalid');
  const token = randomBytes(32).toString('hex');
  const server = createServer(async (request, response) => {
    const abort = new AbortController();
    response.on('close', () => abort.abort());
    try {
      if (request.url !== '/mcp' || (request.method !== 'GET' && request.method !== 'POST' && request.method !== 'DELETE')) {
        response.writeHead(404).end();
        return;
      }
      if (request.headers.authorization !== `Bearer ${token}`) {
        response.writeHead(401).end();
        return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of request) {
        bytes += chunk.length;
        if (bytes > 1024 * 1024) {
          response.writeHead(413).end();
          return;
        }
        chunks.push(chunk);
      }
      // Recheck after reading the body, immediately before starting the action.
      if (!await authorize()) {
        response.writeHead(403).end();
        return;
      }
      const headers = new Headers({ Authorization: `Bearer ${upstream.token}` });
      for (const key of ['content-type', 'accept', 'mcp-session-id', 'mcp-protocol-version', 'last-event-id']) {
        const value = request.headers[key];
        if (typeof value === 'string') headers.set(key, value);
      }
      const result = await fetch(destination, {
        method: request.method,
        headers,
        body: request.method === 'POST' ? Buffer.concat(chunks) : undefined,
        redirect: 'error',
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout((upstream.toolTimeoutSec ?? 120) * 1000)]),
      });
      if (!await authorize()) {
        await result.body?.cancel();
        response.writeHead(403).end();
        return;
      }
      response.statusCode = result.status;
      for (const key of ['content-type', 'mcp-session-id', 'mcp-protocol-version']) {
        const value = result.headers.get(key);
        if (value) response.setHeader(key, value);
      }
      if (result.body) {
        const body = result.body;
        const authorizedChunks = async function* () {
          for await (const chunk of body) {
            if (!await authorize()) throw new Error('whatsapp_channel_revoked');
            yield chunk;
          }
        };
        await pipeline(Readable.from(authorizedChunks()), response);
      }
      else response.end();
    } catch {
      // No upstream URLs, credentials or internal errors cross the boundary.
      if (!response.headersSent) response.writeHead(502);
      response.end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = (server.address() as import('node:net').AddressInfo).port;
  return {
    config: { ...upstream, url: `http://127.0.0.1:${port}/mcp`, token },
    close: () => { server.closeAllConnections(); server.close(); },
  };
};
