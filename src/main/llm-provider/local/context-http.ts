import http from 'node:http';

const MAX_BYTES = 128 * 1024;

/** Fixed local endpoint, no redirects, credentials, proxy, tools or automatic retries. */
export function readContextResponse(endpoint: string, body: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('local_cancelled')); return; }
    if (Buffer.byteLength(body) > MAX_BYTES) { reject(new Error('local_context_request_too_large')); return; }
    let settled = false;
    const request = http.request(`${endpoint}/api/chat`, {
      method: 'POST', agent: false,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    });
    const finish = (error?: Error, result?: Record<string, unknown>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (error) { request.destroy(); reject(error); }
      else resolve(result!);
    };
    const abort = (): void => finish(new Error('local_cancelled'));
    const timer = setTimeout(() => finish(new Error('local_context_timeout')), 30000);
    signal?.addEventListener('abort', abort, { once: true });
    request.on('error', () => finish(new Error('local_context_unavailable')));
    request.on('response', (response) => {
      if (response.statusCode !== 200) { finish(new Error('local_context_http')); return; }
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > MAX_BYTES) finish(new Error('local_context_response_too_large'));
        else chunks.push(chunk);
      });
      response.on('error', () => finish(new Error('local_context_invalid_response')));
      response.on('end', () => {
        try {
          const data: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (!data || typeof data !== 'object' || Array.isArray(data) || (data as Record<string, unknown>).done !== true) throw new Error();
          finish(undefined, data as Record<string, unknown>);
        } catch { finish(new Error('local_context_invalid_response')); }
      });
    });
    request.end(body);
  });
}
