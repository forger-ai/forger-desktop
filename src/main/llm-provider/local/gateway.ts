import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { LocalToolContract } from './types';

interface GatewayInput {
  endpoint: string;
  model: string;
  timeoutMs: number;
  onToolInventory?: (inventory: LocalToolContract[]) => void;
}

const MAX_TOOL_CONTRACTS = 128;
const identifier = (value: unknown): value is string => typeof value === 'string'
  && /^[A-Za-z0-9_.:-]{1,128}$/.test(value);

/** Validate without rewriting schemas, namespaces, descriptions or conversation content. */
function inspectToolContracts(data: Record<string, unknown>, observed: Map<string, LocalToolContract>): void {
  let declarations = 0;
  const visit = (tools: unknown, namespace = '', depth = 0): void => {
    if (!Array.isArray(tools) || depth > 8) throw new Error('local_tool_contract_unsupported');
    for (const value of tools) {
      if (++declarations > MAX_TOOL_CONTRACTS || !value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('local_tool_contract_unsupported');
      }
      const tool = value as Record<string, unknown>;
      if (!identifier(tool.type) || !identifier(tool.name)) throw new Error('local_tool_contract_unsupported');
      const contract = { type: tool.type, name: tool.name, namespace };
      const key = JSON.stringify(contract);
      if (!observed.has(key) && observed.size >= MAX_TOOL_CONTRACTS) throw new Error('local_tool_contract_unsupported');
      observed.set(key, contract);
      if (tool.type === 'namespace') {
        const scope = namespace ? `${namespace}.${tool.name}` : tool.name;
        if (scope.length > 128) throw new Error('local_tool_contract_unsupported');
        visit(tool.tools, scope, depth + 1);
      } else if (tool.type !== 'function' || tool.tools !== undefined) {
        throw new Error('local_tool_contract_unsupported');
      }
    }
  };
  if (data.tools !== undefined) visit(data.tools);
  if (Array.isArray(data.input)) {
    for (const item of data.input) {
      if (item && typeof item === 'object'
        && ['custom_tool_call', 'custom_tool_call_output'].includes(item.type)) {
        throw new Error('local_tool_contract_unsupported');
      }
    }
  }
}

export interface LocalInferenceGateway {
  baseUrl: string;
  token: string;
  close: () => Promise<void>;
}

/** A single-run authenticated relay. Never follows redirects or inherits proxy configuration. */
export async function createLocalInferenceGateway(input: GatewayInput): Promise<LocalInferenceGateway> {
  if (!/^http:\/\/127\.0\.0\.1(?::[1-9][0-9]{0,4})?$/.test(input.endpoint)) throw new Error('local_endpoint_invalid');
  const target = new URL('/v1/responses', input.endpoint);
  const token = randomBytes(32).toString('hex');
  const authorization = Buffer.from(`Bearer ${token}`);
  const pending = new Set<http.ClientRequest>();
  const observed = new Map<string, LocalToolContract>();
  const server = http.createServer((request, response) => {
    const reject = (status: number, error = 'local_gateway_rejected'): void => {
      response.writeHead(status, { 'Content-Type': 'application/json', Connection: 'close' });
      response.end(JSON.stringify({ error }));
      request.resume();
    };
    const supplied = Buffer.from(request.headers.authorization ?? '');
    if (supplied.length !== authorization.length || !timingSafeEqual(supplied, authorization)) { reject(401); return; }
    if (request.url !== '/v1/responses') { reject(404); return; }
    if (request.method !== 'POST') { reject(405); return; }
    const chunks: Buffer[] = [];
    let bytes = 0;
    let rejected = false;
    request.on('error', () => response.destroy());
    request.on('data', (chunk: Buffer) => {
      if (rejected) return;
      bytes += chunk.length;
      if (bytes > 2 * 1024 * 1024) { rejected = true; reject(413); return; }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (rejected) return;
      const body = Buffer.concat(chunks);
      let data: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(body.toString('utf8'));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
          || (parsed as Record<string, unknown>).model !== input.model) throw new Error();
        data = parsed as Record<string, unknown>;
      } catch { reject(400); return; }
      try {
        inspectToolContracts(data, observed);
      } catch {
        reject(400, 'local_tool_contract_unsupported');
        return;
      } finally {
        input.onToolInventory?.([...observed.values()].map((contract) => ({ ...contract })));
      }
      const upstream = http.request(target, {
        method: 'POST',
        agent: false,
        headers: { 'Content-Type': 'application/json', 'Content-Length': body.length },
      });
      pending.add(upstream);
      const deadline = setTimeout(() => upstream.destroy(new Error('local_gateway_timeout')), input.timeoutMs);
      const finish = (): void => { clearTimeout(deadline); pending.delete(upstream); };
      upstream.once('close', finish);
      response.once('close', () => { if (!response.writableEnded) upstream.destroy(); });
      upstream.on('error', () => {
        if (!response.headersSent) reject(502);
        else response.destroy();
      });
      upstream.on('response', (incoming) => {
        // Returning the Location header would let the Codex HTTP client follow it.
        if (incoming.statusCode !== 200) {
          incoming.resume();
          reject(502);
          upstream.destroy();
          return;
        }
        response.writeHead(200, { 'Content-Type': incoming.headers['content-type'] ?? 'application/json' });
        let responseBytes = 0;
        incoming.on('data', (chunk: Buffer) => {
          responseBytes += chunk.length;
          if (responseBytes > 8 * 1024 * 1024) { response.destroy(); upstream.destroy(); }
        });
        incoming.on('error', () => response.destroy());
        incoming.pipe(response);
      });
      upstream.end(body);
    });
  });
  server.headersTimeout = Math.min(input.timeoutMs, 10000);
  server.requestTimeout = input.timeoutMs;
  server.setTimeout(input.timeoutMs, (socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('local_gateway_start_failed');
  let closing: Promise<void> | undefined;
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    token,
    close: () => {
      closing ??= new Promise<void>((resolve) => {
        for (const request of pending) request.destroy();
        server.closeAllConnections();
        server.close(() => resolve());
      });
      return closing;
    },
  };
}
