import http from 'node:http';
import type { LocalInferenceConfig, LocalInferenceEvidence } from './types';
import { resolveLocalAgentProfile } from './profiles';

export function validateLocalConfig(config: LocalInferenceConfig): string {
  resolveLocalAgentProfile(config.agentProfile);
  if (config.contextStrategy !== undefined && config.contextStrategy !== 'direct-v1'
    && config.contextStrategy !== 'staged-v1' && config.contextStrategy !== 'staged-request-v2') {
    throw new Error('local_context_strategy_invalid');
  }
  if (config.runtime !== 'ollama' || !/^[a-zA-Z0-9][a-zA-Z0-9._/:+-]{0,199}$/.test(config.model)
    || /cloud/i.test(config.model) || !/^(?:sha256:)?[a-f0-9]{64}$/.test(config.modelDigest)
    || !Number.isInteger(config.contextWindow) || config.contextWindow < 512 || config.contextWindow > 32768) {
    throw new Error('local_configuration_invalid');
  }
  // Check raw spelling as URL normalizes integer/hex addresses to loopback.
  if (!/^http:\/\/127\.0\.0\.1(?::[1-9][0-9]{0,4})?\/?$/.test(config.endpoint)) {
    throw new Error('local_endpoint_invalid');
  }
  let url: URL;
  try { url = new URL(config.endpoint); } catch { throw new Error('local_endpoint_invalid'); }
  return url.origin;
}

/** Validate caller provenance without guessing which paragraph expresses the person's request. */
export function validateLocalContextRequest(prompt: string, request: unknown, required: boolean): number | null {
  if (request === undefined) {
    if (required) throw new Error('local_context_request_required');
    return null;
  }
  if (typeof request !== 'string' || !request.trim()) throw new Error('local_context_request_invalid');
  const offset = prompt.indexOf(request);
  if (offset < 0) throw new Error('local_context_request_not_literal');
  return offset;
}

const readJson = (url: string, body: unknown, signal?: AbortSignal): Promise<Record<string, unknown>> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('local_cancelled')); return; }
    const request = http.request(url, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      agent: false,
    });
    const timer = setTimeout(() => request.destroy(new Error('local_runtime_timeout')), 5000);
    const abort = (): void => { request.destroy(new Error('local_cancelled')); };
    signal?.addEventListener('abort', abort, { once: true });
    const cleanup = (): void => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
    request.on('error', (error) => { cleanup(); reject(error.message.startsWith('local_') ? error : new Error('local_runtime_unavailable')); });
    request.on('response', (response) => {
      if (response.statusCode !== 200) { response.resume(); request.destroy(new Error('local_runtime_http')); return; }
      let bytes = 0;
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 1024 * 1024) request.destroy(new Error('local_runtime_response_too_large'));
        else chunks.push(chunk);
      });
      response.on('error', () => { cleanup(); reject(new Error('local_runtime_invalid_response')); });
      response.on('end', () => {
        cleanup();
        try {
          const data: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
          resolve(data as Record<string, unknown>);
        } catch { reject(new Error('local_runtime_invalid_response')); }
      });
    });
    request.end(body === undefined ? undefined : JSON.stringify(body));
  });

export async function preflightLocalModel(config: LocalInferenceConfig, signal?: AbortSignal): Promise<LocalInferenceEvidence> {
  const endpoint = validateLocalConfig(config);
  const tags = await readJson(`${endpoint}/api/tags`, undefined, signal);
  const model = Array.isArray(tags.models)
    ? tags.models.find((entry: Record<string, unknown>) => entry?.name === config.model || entry?.model === config.model)
    : undefined;
  if (!model) throw new Error('local_model_missing');
  if (typeof model.digest !== 'string' || model.digest.replace(/^sha256:/, '') !== config.modelDigest.replace(/^sha256:/, '')) throw new Error('local_model_digest_mismatch');
  const details = await readJson(`${endpoint}/api/show`, { model: config.model }, signal);
  if (model.remote_model || model.remote_host || details.remote_model || details.remote_host) throw new Error('local_model_remote');
  if (!Array.isArray(details.capabilities) || !details.capabilities.includes('completion') || !details.capabilities.includes('tools')) {
    throw new Error('local_capabilities_missing');
  }
  const version = await readJson(`${endpoint}/api/version`, undefined, signal);
  if (typeof version.version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version.version) || version.version.length > 100) {
    throw new Error('local_runtime_invalid_response');
  }
  return {
    runtime: 'ollama',
    runtimeVersion: version.version,
    model: config.model,
    modelDigest: model.digest.replace(/^sha256:/, ''),
    reportedCapabilities: details.capabilities.filter((value): value is string => typeof value === 'string'),
    validatedCapabilities: [],
    requestedAgentContextWindow: config.contextWindow,
    effectiveRuntimeContext: null,
    effectiveRuntimeContextReason: 'Agent context budget does not establish effective Ollama num_ctx.',
  };
}
