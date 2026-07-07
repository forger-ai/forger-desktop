import fs from 'node:fs/promises';
import path from 'node:path';
import { BUILT_IN_CONNECTION_TYPES } from '../shared/connection-catalog';
import type { SecretMutationResult } from '../shared/types';

interface LegacyExternalToolCleanupOptions {
  metadataRoot: string;
  secretsStore: {
    deleteToolSecrets(toolId: string): Promise<SecretMutationResult>;
  };
  appendLog?: (event: string, payload?: Record<string, unknown>) => Promise<void>;
}

interface OfficialToolsRegistry {
  version?: unknown;
  installed?: Record<string, unknown>;
  appGrants?: Record<string, Record<string, unknown>>;
}

const LEGACY_EXTERNAL_TOOL_IDS = new Set<string>(BUILT_IN_CONNECTION_TYPES);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const readRegistry = async (registryPath: string): Promise<OfficialToolsRegistry | null> => {
  try {
    const raw = await fs.readFile(registryPath, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    return isRecord(parsed) ? parsed as OfficialToolsRegistry : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
};

const writeRegistry = async (
  registryPath: string,
  registry: OfficialToolsRegistry,
): Promise<void> => {
  const tempPath = `${registryPath}.tmp`;
  await fs.mkdir(path.dirname(registryPath), { recursive: true });
  await fs.writeFile(tempPath, JSON.stringify(registry, null, 2), { encoding: 'utf8', mode: 0o600 });
  await fs.rename(tempPath, registryPath);
  await fs.chmod(registryPath, 0o600).catch(() => undefined);
};

export const cleanupLegacyExternalToolState = async ({
  metadataRoot,
  secretsStore,
  appendLog,
}: LegacyExternalToolCleanupOptions): Promise<void> => {
  const registryPath = path.join(metadataRoot, 'official-tools.json');
  const registry = await readRegistry(registryPath);
  let changed = false;

  if (registry) {
    if (isRecord(registry.installed)) {
      for (const toolId of LEGACY_EXTERNAL_TOOL_IDS) {
        if (toolId in registry.installed) {
          delete registry.installed[toolId];
          changed = true;
        }
      }
    }

    if (isRecord(registry.appGrants)) {
      for (const grants of Object.values(registry.appGrants)) {
        if (!isRecord(grants)) {
          continue;
        }
        for (const toolId of LEGACY_EXTERNAL_TOOL_IDS) {
          if (toolId in grants) {
            delete grants[toolId];
            changed = true;
          }
        }
      }
    }

    if (changed) {
      await writeRegistry(registryPath, registry);
    }
  }

  await Promise.all([...LEGACY_EXTERNAL_TOOL_IDS].map(async (toolId) => {
    await secretsStore.deleteToolSecrets(toolId).catch((error) => {
      void appendLog?.('legacy_external_tools_cleanup:secret_delete_failed', {
        toolId,
        message: error instanceof Error ? error.message : 'unknown_error',
      });
    });
    await fs.rm(path.join(metadataRoot, 'official-tools', toolId), { recursive: true, force: true }).catch((error) => {
      void appendLog?.('legacy_external_tools_cleanup:metadata_delete_failed', {
        toolId,
        message: error instanceof Error ? error.message : 'unknown_error',
      });
    });
  }));

  if (changed) {
    await appendLog?.('legacy_external_tools_cleanup:registry_pruned');
  }
};
