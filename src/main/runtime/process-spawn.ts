import type { ChildProcessWithoutNullStreams, SpawnOptions } from 'node:child_process';
import crossSpawn from 'cross-spawn';

export type SpawnProcessOptions = SpawnOptions;

export const spawnProcess = (
  command: string,
  args: string[] = [],
  options: SpawnProcessOptions = {},
): ChildProcessWithoutNullStreams =>
  crossSpawn(command, args, {
    ...options,
    shell: false,
  }) as ChildProcessWithoutNullStreams;

export type SpawnProcess = typeof spawnProcess;

export const mergePathEntries = (
  env: NodeJS.ProcessEnv,
  pathEntries: string[],
  delimiter: string,
): NodeJS.ProcessEnv => {
  const merged = { ...env };
  const pathKey = Object.keys(merged).find((key) => key.toLowerCase() === 'path') ?? 'PATH';
  merged[pathKey] = [...pathEntries, merged[pathKey] ?? ''].filter(Boolean).join(delimiter);
  if (pathKey !== 'PATH') {
    delete merged.PATH;
  }
  return merged;
};

export const mergePathEntry = (
  env: NodeJS.ProcessEnv,
  pathEntry: string,
  delimiter: string,
): NodeJS.ProcessEnv => mergePathEntries(env, [pathEntry], delimiter);
