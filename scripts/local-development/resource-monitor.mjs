import { execFile } from 'node:child_process';
import os from 'node:os';
import { promisify } from 'node:util';
const execute = promisify(execFile);

const unknownVm = () => ({ pageSizeBytes: null, freeBytes: null, inactiveBytes: null, speculativeBytes: null, wiredBytes: null, compressorBytes: null, pageouts: null, swapins: null, swapouts: null });
export function parseVmStat(text) {
  const values = unknownVm();
  const pageSize = Number(text.match(/page size of (\d+) bytes/)?.[1]);
  if (!(pageSize > 0)) return values;
  values.pageSizeBytes = pageSize;
  for (const [name, key] of [['Pages free', 'freeBytes'], ['Pages inactive', 'inactiveBytes'], ['Pages speculative', 'speculativeBytes'], ['Pages wired down', 'wiredBytes'], ['Pages occupied by compressor', 'compressorBytes'], ['Pageouts', 'pageouts'], ['Swapins', 'swapins'], ['Swapouts', 'swapouts']]) {
    const match = text.match(new RegExp(`^${name}:\\s*(\\d+)\\.?$`, 'm'));
    if (match) values[key] = Number(match[1]) * (key.endsWith('Bytes') ? pageSize : 1);
  }
  return values;
}

export function parseSwapUsage(text) {
  const values = { totalBytes: null, usedBytes: null, freeBytes: null };
  for (const key of ['total', 'used', 'free']) {
    const match = text.match(new RegExp(`${key}\\s*=\\s*([0-9.]+)([KMG])`));
    if (match) values[`${key}Bytes`] = Number(match[1]) * 1024 ** ({ K: 1, M: 2, G: 3 }[match[2]]);
  }
  return values;
}

export function processTreeRss(text, rootPid) {
  const rows = text.split('\n').flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)$/);
    return match ? [{ pid: Number(match[1]), parent: Number(match[2]), rss: Number(match[3]) * 1024 }] : [];
  });
  if (!rows.some(({ pid }) => pid === rootPid)) return { processCount: 0, rssBytes: null };
  const members = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) if (!members.has(row.pid) && members.has(row.parent)) { members.add(row.pid); changed = true; }
  }
  return { processCount: members.size, rssBytes: rows.filter(({ pid }) => members.has(pid)).reduce((sum, row) => sum + row.rss, 0) };
}

async function readCommand(command, args) {
  const result = await execute(command, args, {
    timeout: 750, maxBuffer: 2 * 1024 * 1024, windowsHide: true,
    env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LC_ALL: 'C' },
  });
  return result.stdout;
}

export async function sampleResources({ runtimePid, platform = process.platform, command = readCommand } = {}) {
  const sample = {
    observedAt: new Date().toISOString(),
    systemTotalMemoryBytes: os.totalmem(), systemFreeMemoryBytes: os.freemem(),
    runtimeProcessCount: null, runtimeTreeRssBytes: null,
    vm: unknownVm(), swap: { totalBytes: null, usedBytes: null, freeBytes: null }, unavailable: [],
  };
  const work = [];
  if (runtimePid && platform !== 'win32') {
    work.push(command('/bin/ps', ['-axo', 'pid=,ppid=,rss=']).then((text) => {
      const result = processTreeRss(text, runtimePid);
      sample.runtimeProcessCount = result.processCount;
      sample.runtimeTreeRssBytes = result.rssBytes;
      if (result.rssBytes === null) sample.unavailable.push('runtime_pid_not_observed');
    }).catch(() => sample.unavailable.push('process_rss_unavailable')));
  } else sample.unavailable.push(runtimePid ? 'process_rss_platform_not_implemented' : 'runtime_pid_not_supplied');
  if (platform === 'darwin') {
    work.push(command('/usr/bin/vm_stat', []).then((text) => { sample.vm = parseVmStat(text); }).catch(() => sample.unavailable.push('vm_stat_unavailable')));
    work.push(command('/usr/sbin/sysctl', ['-n', 'vm.swapusage']).then((text) => { sample.swap = parseSwapUsage(text); }).catch(() => sample.unavailable.push('swap_usage_unavailable')));
  } else sample.unavailable.push('vm_and_swap_platform_not_implemented');
  await Promise.all(work);
  return sample;
}

export async function createResourceMonitor({ runtimePid, sampleIntervalMs = 1000, sample = sampleResources } = {}) {
  if (runtimePid !== undefined && (!Number.isInteger(runtimePid) || runtimePid <= 0)) throw new Error('invalid_runtime_pid');
  if (!Number.isInteger(sampleIntervalMs) || sampleIntervalMs < 250) throw new Error('invalid_resource_sample_interval');
  const samples = [];
  let stopping = false;
  let timer;
  let current;
  const observe = async () => {
    const entry = await sample({ runtimePid });
    samples.push(entry);
    if (!stopping) timer = setTimeout(() => { current = observe(); }, sampleIntervalMs);
  };
  current = observe();
  await current;
  let result;
  return {
    stop: async () => {
      if (result) return result;
      stopping = true;
      clearTimeout(timer);
      await current;
      samples.push(await sample({ runtimePid }));
      const known = (key) => samples.map((entry) => entry[key]).filter((value) => typeof value === 'number');
      const rss = known('runtimeTreeRssBytes');
      const free = known('systemFreeMemoryBytes');
      const swap = samples.map((entry) => entry.swap.usedBytes).filter((value) => typeof value === 'number');
      result = {
        sampleIntervalMs, sampleCount: samples.length, samples,
        peakSampledRuntimeTreeRssBytes: rss.length ? Math.max(...rss) : null,
        minimumSampledSystemFreeBytes: free.length ? Math.min(...free) : null,
        peakSampledSwapUsedBytes: swap.length ? Math.max(...swap) : null,
        peakUnifiedMemoryBytes: null,
        limitations: [
          'RSS is sampled per-process resident memory and may double-count shared pages; it is not a unified-memory high-water mark.',
          'Free memory is not available-for-model memory. GPU allocations, caches and memory pressure require additional instrumentation.',
          'vm_stat and swap describe system-wide activity, not causal attribution to the model.',
          'Sampling itself has overhead; transient peaks between samples may be missed.',
        ],
      };
      return result;
    },
  };
}
