import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { buildNetworkProfile } from './network-canary.mjs';

const require = createRequire(import.meta.url);
const { runLocalCommandCapture } = require('../../dist-electron/main/llm-provider/local/process.js');

/** Reads the provider route fixed by Forger, never an arbitrary CLI URL or user config. */
export function extractGatewayPort(args) {
  const values = [];
  for (let index = 0; index < args.length; index++) {
    let setting;
    if (args[index] === '--config' || args[index] === '-c') setting = args[++index];
    else if (args[index].startsWith('--config=')) setting = args[index].slice('--config='.length);
    if (typeof setting === 'string' && /^model_providers\.forger_local\.base_url\s*=/.test(setting)) {
      values.push(setting.slice(setting.indexOf('=') + 1));
    }
  }
  if (values.length !== 1) throw new Error('evaluation_gateway_route_required');
  let value;
  try { value = JSON.parse(values[0]); } catch { throw new Error('evaluation_gateway_route_invalid'); }
  if (typeof value !== 'string' || !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/v1$/.test(value)) throw new Error('evaluation_gateway_route_invalid');
  let url;
  try { url = new URL(value); } catch { throw new Error('evaluation_gateway_route_invalid'); }
  const port = Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('evaluation_gateway_route_invalid');
  return port;
}

/** Evaluation-only outer network policy. Inner Codex sandbox compatibility must be measured. */
export function createNetworkSandboxedCapture({ platform = process.platform, capture = runLocalCommandCapture, onProfile } = {}) {
  return async (command, args, options) => {
    if (platform !== 'darwin') throw new Error('evaluation_network_sandbox_requires_macos');
    const allowedGatewayPort = extractGatewayPort(args);
    const policy = buildNetworkProfile(allowedGatewayPort);
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'forger-evaluation-network-'));
    const policyPath = path.join(directory, 'network.sb');
    try {
      await fs.writeFile(policyPath, policy, { mode: 0o600 });
      onProfile?.({
        kind: 'macos-seatbelt-evaluation', status: 'configured_not_verified',
        allowedGatewayPort, profileSha256: createHash('sha256').update(policy).digest('hex'), profileText: policy,
        limitations: ['Only the spawned Codex process tree is wrapped; the Forger host and user-owned Ollama service are not wrapped.', 'Pre-opened descriptors and privileged IPC are outside this guarantee.', 'Nested Codex sandbox compatibility and actual subprocess network behavior require live verification.'],
      });
      return await capture('/usr/bin/sandbox-exec', ['-f', policyPath, command, ...args], options);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  };
}
