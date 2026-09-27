import fs from 'node:fs/promises';
import path from 'node:path';
import type { ConnectionsService } from '../connections-service';
import { RepositoryCollaborationService } from './service';
import { RepositoryCollaborationStore } from './store';
import { RepositoryCodexExecutor } from './codex-executor';
import { WhatsAppRepositoryTransport } from './whatsapp-transport';

let runtime:
  | {
      service: RepositoryCollaborationService;
      store: RepositoryCollaborationStore;
      connections: ConnectionsService;
    }
  | undefined;

export function getRepositoryCollaborationService(): RepositoryCollaborationService {
  if (!runtime) throw new Error('repository_collaboration_unavailable');
  return runtime.service;
}

export async function startRepositoryCollaborationRuntime(options: {
  metadataRoot: string;
  connections: ConnectionsService;
  sourceCodexHome: () => string;
  resolveRuntime: ConstructorParameters<
    typeof RepositoryCodexExecutor
  >[0]['resolveRuntime'];
}): Promise<void> {
  if (runtime) return;
  const root = path.join(options.metadataRoot, 'repository-collaboration');
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const store = new RepositoryCollaborationStore(
    path.join(root, 'collaboration.sqlite'),
  );
  const executor = new RepositoryCodexExecutor({
    root: path.join(root, 'runtime'),
    sourceCodexHome: options.sourceCodexHome,
    resolveRuntime: options.resolveRuntime,
  });
  const service = new RepositoryCollaborationService({
    store,
    executor,
    transport: new WhatsAppRepositoryTransport(options.connections),
  });
  runtime = { service, store, connections: options.connections };
  // Recover durable work and register intake before any connection begins listening.
  try {
    options.connections.setWhatsAppMessageHandler((message) =>
      service.routeMessage(message),
    );
    service.start();
  } catch (error) {
    options.connections.setWhatsAppMessageHandler(undefined);
    store.close();
    runtime = undefined;
    throw error;
  }
}

export async function stopRepositoryCollaborationRuntime(): Promise<void> {
  const current = runtime;
  if (!current) return;
  current.connections.setWhatsAppMessageHandler(undefined);
  try {
    // stop() synchronously revokes intake and signals running executors before either drain waits.
    await Promise.allSettled([
      current.service.stop(),
      current.connections.stop(),
    ]);
  } finally {
    try {
      current.store.close();
    } finally {
      runtime = undefined;
    }
  }
}
