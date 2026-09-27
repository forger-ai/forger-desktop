import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';

export interface LocalHardwareSnapshot {
  schemaVersion: 1;
  observedAt: string;
  os: { platform: string; architecture: string; release: string };
  cpu: { model: string | null; logicalCores: number | null };
  memory: {
    totalBytes: number | null;
    freeBytes: number | null;
    availableForModelBytes: null;
    unified: boolean | null;
  };
  gpu: {
    devices: { name: string; backendReported: 'metal' | null; usableMemoryBytes: null }[];
    accelerationTested: false;
  };
  disk: { availableBytes: number | null };
  performance: null;
  recommendation: { status: 'insufficient_evidence'; reason: string };
  unavailable: string[];
}

interface HardwareObservationDependencies {
  system?: Pick<typeof os, 'platform' | 'arch' | 'release' | 'totalmem' | 'freemem'> & {
    cpus: () => { model: string }[];
  };
  disk?: (directory: string) => Promise<{ bavail: bigint; bsize: bigint }>;
  displays?: () => Promise<string>;
  now?: () => string;
}

const positiveBytes = (value: number): number | null =>
  Number.isSafeInteger(value) && value > 0 ? value : null;

const nonnegativeBytes = (value: number): number | null =>
  Number.isSafeInteger(value) && value >= 0 ? value : null;

const readMacDisplays = (): Promise<string> => new Promise((resolve, reject) => {
  // The selected data type excludes hardware serial numbers and account information.
  execFile('/usr/sbin/system_profiler', ['SPDisplaysDataType', '-json'], {
    timeout: 5000, maxBuffer: 512 * 1024, encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'C' },
  }, (error, stdout) => error ? reject(error) : resolve(stdout));
});

/** A point-in-time observation, never a model suitability or performance prediction. */
export const collectLocalHardware = async (
  directory: string,
  dependencies: HardwareObservationDependencies = {},
): Promise<LocalHardwareSnapshot> => {
  const system = dependencies.system ?? os;
  const cpus = system.cpus();
  const cpuModel = cpus.find((cpu) => cpu.model.trim())?.model.trim() || null;
  const platform = system.platform();
  const architecture = system.arch();
  const unavailable = ['available_model_memory_not_measured', 'performance_not_measured'];
  const snapshot: LocalHardwareSnapshot = {
    schemaVersion: 1,
    observedAt: (dependencies.now ?? (() => new Date().toISOString()))(),
    os: { platform, architecture, release: system.release() },
    cpu: { model: cpuModel, logicalCores: cpus.length || null },
    memory: {
      totalBytes: positiveBytes(system.totalmem()),
      freeBytes: nonnegativeBytes(system.freemem()),
      // OS free memory excludes reclaimable caches; neither value is a safe LLM budget.
      availableForModelBytes: null,
      unified: platform === 'darwin' && architecture === 'arm64' && /^Apple\s/.test(cpuModel ?? '')
        ? true : null,
    },
    gpu: { devices: [], accelerationTested: false },
    disk: { availableBytes: null },
    performance: null,
    recommendation: {
      status: 'insufficient_evidence',
      reason: 'Hardware detection does not demonstrate app-development success. Run the measured task suite before recommending a configuration.',
    },
    unavailable,
  };

  try {
    const disk = await (dependencies.disk ?? ((target) => fs.statfs(target, { bigint: true })))(directory);
    snapshot.disk.availableBytes = nonnegativeBytes(Number(disk.bavail * disk.bsize));
    if (snapshot.disk.availableBytes === null) unavailable.push('disk_detection_invalid');
  } catch {
    unavailable.push('disk_detection_failed');
  }

  if (platform !== 'darwin') {
    unavailable.push('gpu_platform_probe_not_implemented');
    return snapshot;
  }
  try {
    const parsed: unknown = JSON.parse(await (dependencies.displays ?? readMacDisplays)());
    const displays = parsed && typeof parsed === 'object' && 'SPDisplaysDataType' in parsed
      ? parsed.SPDisplaysDataType : undefined;
    if (Array.isArray(displays)) {
      for (const value of displays) {
        if (!value || typeof value !== 'object' || typeof value.sppci_model !== 'string') continue;
        if (!value.sppci_model.trim()) continue;
        snapshot.gpu.devices.push({
          name: value.sppci_model.trim(),
          backendReported: typeof value.spdisplays_metal === 'string'
            && (value.spdisplays_metal === 'spdisplays_supported' || /^spdisplays_metal\d+$/.test(value.spdisplays_metal))
            ? 'metal' : null,
          // A display's reported VRAM is not necessarily available to the inference runtime.
          usableMemoryBytes: null,
        });
      }
    }
    if (!snapshot.gpu.devices.length) unavailable.push('gpu_detection_unavailable');
  } catch {
    unavailable.push('gpu_detection_failed');
  }
  return snapshot;
};
