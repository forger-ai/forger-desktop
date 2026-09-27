import net from 'node:net';
import dgram from 'node:dgram';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const safeErrorCode = (error) => /^[A-Z_]+$/.test(error?.code ?? '') ? error.code : 'UNKNOWN';
const validPort = (port) => Number.isInteger(port) && port >= 1 && port <= 65535;

export function buildNetworkProfile(allowedPort) {
  if (!validPort(allowedPort)) throw new Error('invalid_allowed_port');
  return `(version 1)\n(allow default)\n(deny network*)\n(allow network-outbound (remote tcp "localhost:${allowedPort}"))\n`;
}

export function classifyNetworkCase({ mode, allowed = false, received, attempt }) {
  if (mode === 'baseline' || allowed) return received && attempt?.acknowledged ? 'reachable' : 'blocked';
  if (received) return 'leaked';
  if (['EPERM', 'EACCES'].includes(attempt?.errorCode)) return 'denied';
  if (attempt?.connected) return 'inconclusive';
  return 'blocked';
}

function validateTarget(target) {
  if (target.kind === 'unix') {
    if (!/^\/tmp\/forger-net-[a-zA-Z0-9]+\/canary\.sock$/.test(target.path ?? '')) throw new Error('invalid_unix_target');
  } else if (!['tcp4', 'tcp6', 'udp4', 'udp6'].includes(target.kind)
    || !['127.0.0.1', '::1'].includes(target.address) || !validPort(target.port)) throw new Error('invalid_loopback_target');
}

async function attemptConnection(target, nonce, timeoutMs) {
  validateTarget(target);
  if (!/^[a-f0-9]{32}$/.test(nonce) || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2000) throw new Error('invalid_probe_arguments');
  const started = performance.now();
  return await new Promise((resolve) => {
    let settled = false;
    let connected = false;
    let client;
    const finish = (errorCode, acknowledged = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (target.kind.startsWith('udp')) { try { client.close(); } catch { /* Socket may not have bound. */ } }
      else client.destroy();
      resolve({ connected, acknowledged, errorCode, wallMs: performance.now() - started });
    };
    const timer = setTimeout(() => finish('ETIMEDOUT'), timeoutMs);
    if (target.kind.startsWith('udp')) {
      client = dgram.createSocket(target.kind);
      client.on('error', (error) => finish(safeErrorCode(error)));
      client.on('message', (message) => { if (message.toString() === `ACK:${nonce}`) finish(null, true); });
      client.send(nonce, target.port, target.address, (error) => {
        if (error) finish(safeErrorCode(error));
        else connected = true;
      });
    } else {
      client = net.createConnection(target.kind === 'unix' ? { path: target.path } : { host: target.address, port: target.port });
      client.on('error', (error) => finish(safeErrorCode(error)));
      client.on('connect', () => { connected = true; client.write(`${nonce}\n`); });
      let reply = '';
      client.on('data', (chunk) => { reply += chunk.toString(); if (reply === `ACK:${nonce}`) finish(null, true); });
      client.on('end', () => { if (!settled) finish('ACK_MISSING'); });
    }
  });
}

async function executeProbe({ target, nonce, timeoutMs, depth, profile }) {
  const payload = Buffer.from(JSON.stringify({ target, nonce, timeoutMs, depth })).toString('base64');
  const command = profile ? '/usr/bin/sandbox-exec' : process.execPath;
  const args = profile ? ['-f', profile, process.execPath, scriptPath, '--child', payload] : [scriptPath, '--child', payload];
  return await new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32',
      env: { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin` },
    });
    let stdout = '';
    let diagnosticBytes = 0;
    let settled = false;
    const stop = () => {
      try { if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch { child.kill('SIGKILL'); }
    };
    const timer = setTimeout(() => { stop(); finish({ errorCode: 'PROBE_DEADLINE' }); }, timeoutMs + 2000 + depth * 500);
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      if (stdout.length > 32768) { stop(); finish({ errorCode: 'PROBE_OUTPUT_LIMIT' }); }
    });
    child.stderr.on('data', (chunk) => { diagnosticBytes += chunk.length; if (diagnosticBytes > 32768) stop(); });
    child.on('error', (error) => finish({ errorCode: safeErrorCode(error), launchFailed: true }));
    child.on('close', (exitCode) => {
      if (exitCode !== 0) { finish({ errorCode: 'PROBE_PROCESS_FAILED', exitCode, diagnosticBytes }); return; }
      try { finish(JSON.parse(stdout)); } catch { finish({ errorCode: 'PROBE_INVALID_OUTPUT', exitCode, diagnosticBytes }); }
    });
  });
}

async function openReceiver(kind, directory, receipts) {
  const address = kind.endsWith('6') ? '::1' : '127.0.0.1';
  const isUdp = kind.startsWith('udp');
  const target = kind === 'unix' ? { kind, path: path.join(directory, 'canary.sock') } : { kind, address, port: 0 };
  const sockets = new Set();
  const receiver = isUdp ? dgram.createSocket(kind) : net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    let data = '';
    socket.on('data', (chunk) => {
      data += chunk.toString();
      const nonce = data.trim();
      if (/^[a-f0-9]{32}$/.test(nonce)) { receipts.add(nonce); socket.end(`ACK:${nonce}`); }
      else if (data.length > 100) socket.destroy();
    });
  });
  if (isUdp) receiver.on('message', (message, sender) => {
    const nonce = message.toString();
    if (/^[a-f0-9]{32}$/.test(nonce)) { receipts.add(nonce); receiver.send(`ACK:${nonce}`, sender.port, sender.address); }
  });
  try {
    await new Promise((resolve, reject) => {
      receiver.once('error', reject);
      if (isUdp) receiver.bind(0, address, resolve);
      else receiver.listen(kind === 'unix' ? target.path : { host: address, port: 0 }, resolve);
    });
  } catch (error) {
    try { receiver.close(); } catch { /* Failed bind has no socket to close. */ }
    return { target, unavailable: safeErrorCode(error), close: async () => {} };
  }
  if (kind !== 'unix') target.port = receiver.address().port;
  return {
    target,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => receiver.close(resolve));
    },
  };
}

export async function runNetworkCanary({ baselineOnly = false, timeoutMs = 1000, depths = [0, 1, 2] } = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2000 || depths.some((depth) => ![0, 1, 2].includes(depth))) throw new Error('invalid_canary_configuration');
  const record = {
    schemaVersion: 1, kind: 'synthetic-subprocess-network-canary', observedAt: new Date().toISOString(), platform: process.platform,
    osRelease: os.release(), osVersion: os.version(), nodeVersion: process.version,
    scriptSha256: createHash('sha256').update(await fs.readFile(scriptPath)).digest('hex'),
    externalTrafficAttempted: false, dnsLookupAttempted: false, codexProcessTested: false, ollamaProcessTested: false,
    sandboxExecutable: process.platform === 'darwin' ? '/usr/bin/sandbox-exec' : null,
    profileSha256: null, profileText: null, cases: [],
    limitations: [
      'This measures controlled Node subprocesses and descendants only; it does not establish the network behavior of Codex, Ollama, Forger or arbitrary applications.',
      'No external destination or DNS resolution is attempted. Loopback/Unix nonce receipt is the observable canary.',
      'The allowed gateway rule matches TCP at one loopback port for both IPv4 and IPv6; UDP is not included.',
      'Already-open network file descriptors, privileged services and IPC-mediated access are outside this probe.',
      'The profile denies network operations while allowing other operations by default; it is not a filesystem or general process sandbox.',
      'Runtime/GPU isolation and resistance to a compromised operating system are not claimed.',
    ],
  };
  const directory = await fs.mkdtemp('/tmp/forger-net-');
  const receipts = new Set();
  const receivers = [];
  try {
    for (const kind of ['tcp4', 'tcp6', 'udp4', 'udp6', 'unix', 'tcp4']) receivers.push(await openReceiver(kind, directory, receipts));
    const permitted = receivers.at(-1);
    let profilePath;
    if (!permitted.unavailable && process.platform === 'darwin' && !baselineOnly) {
      record.profileText = buildNetworkProfile(permitted.target.port);
      record.profileSha256 = createHash('sha256').update(record.profileText).digest('hex');
      profilePath = path.join(directory, 'network.sb');
      await fs.writeFile(profilePath, record.profileText);
    }
    const baselines = new Map();
    for (const [index, receiver] of receivers.entries()) {
      const allowed = index === receivers.length - 1;
      for (const depth of depths) {
        for (const mode of baselineOnly ? ['baseline'] : ['baseline', 'restricted']) {
          const nonce = randomBytes(16).toString('hex');
          let attempt;
          if (receiver.unavailable) attempt = { errorCode: receiver.unavailable, receiverUnavailable: true };
          else if (mode === 'restricted' && !profilePath) attempt = { errorCode: 'SANDBOX_UNAVAILABLE', launchFailed: true };
          else attempt = await executeProbe({ target: receiver.target, nonce, timeoutMs, depth, profile: mode === 'restricted' ? profilePath : undefined });
          const received = receipts.has(nonce);
          let outcome = attempt.receiverUnavailable || attempt.launchFailed
            ? 'blocked' : classifyNetworkCase({ mode, allowed, received, attempt });
          const baselineKey = `${index}:${depth}`;
          if (mode === 'baseline') baselines.set(baselineKey, outcome);
          const baselineVerified = baselines.get(baselineKey) === 'reachable';
          if (mode === 'restricted' && outcome === 'denied' && !baselineVerified) outcome = 'blocked';
          record.cases.push({ transport: receiver.target.kind, depth, mode, routeExplicitlyAllowed: allowed, receiverObservedNonce: received, baselineVerified, outcome, attempt });
        }
      }
    }
    record.summary = Object.fromEntries(['reachable', 'denied', 'leaked', 'blocked', 'inconclusive'].map((state) => [state, record.cases.filter((entry) => entry.outcome === state).length]));
  } finally {
    await Promise.all(receivers.map((receiver) => receiver.close()));
    await fs.rm(directory, { recursive: true, force: true });
  }
  return record;
}

async function main(args) {
  if (args[0] === '--child') {
    const data = JSON.parse(Buffer.from(args[1], 'base64').toString('utf8'));
    if (!Number.isInteger(data.depth) || data.depth < 0 || data.depth > 2) throw new Error('invalid_depth');
    const result = data.depth === 0
      ? await attemptConnection(data.target, data.nonce, data.timeoutMs)
      : await executeProbe({ ...data, depth: data.depth - 1 });
    process.stdout.write(JSON.stringify(result));
    return;
  }
  const options = { baselineOnly: false, timeoutMs: 1000 };
  let output;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--baseline-only') options.baselineOnly = true;
    else if (args[index] === '--output') output = args[++index];
    else if (args[index] === '--timeout-ms') options.timeoutMs = Number(args[++index]);
    else throw new Error('Usage: network-canary.mjs [--baseline-only] [--timeout-ms 1000] [--output evidence.json]');
  }
  const result = await runNetworkCanary(options);
  const json = `${JSON.stringify(result, null, 2)}\n`;
  if (output) { await fs.mkdir(path.dirname(path.resolve(output)), { recursive: true }); await fs.writeFile(output, json, { flag: 'wx' }); }
  else process.stdout.write(json);
  if (result.summary.leaked || result.summary.blocked || result.summary.inconclusive) process.exitCode = 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  await main(process.argv.slice(2)).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
