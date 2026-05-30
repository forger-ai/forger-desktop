import os from 'node:os';
import path from 'node:path';
import { statSync } from 'node:fs';

import type { AgentPermissionMode } from '../shared/types';
import { normalizeAgentPermissionMode } from '../shared/agent-runtime-registry';

export const isUnsafePermissionMode = (value: unknown): boolean =>
  normalizeAgentPermissionMode(value) === 'unsafe';

export const codexUnsafeArgs = (permissionMode: AgentPermissionMode = 'safe'): string[] =>
  isUnsafePermissionMode(permissionMode) ? ['--dangerously-bypass-approvals-and-sandbox'] : [];

export const codexWorkspaceArgs = (permissionMode: AgentPermissionMode = 'safe'): string[] =>
  isUnsafePermissionMode(permissionMode) ? [] : ['--full-auto', '--sandbox', 'workspace-write'];

export const claudePermissionArgs = (permissionMode: AgentPermissionMode = 'safe'): string[] =>
  isUnsafePermissionMode(permissionMode)
    ? ['--permission-mode', 'bypassPermissions', ...claudeUnsafeRootArgs()]
    : [];

export const claudeUnsafeRootArgs = (platform = process.platform): string[] => {
  if (platform === 'win32') {
    return windowsMountedDriveRoots().flatMap((root) => ['--add-dir', root]);
  }
  return ['--add-dir', '/'];
};

export const windowsMountedDriveRoots = (): string[] => {
  const roots = new Set<string>();
  const systemRoot = process.env.SystemRoot || process.env.windir;
  const systemDrive = process.env.SystemDrive;
  const cwdRoot = path.parse(process.cwd()).root;
  const homeRoot = path.parse(os.homedir()).root;
  for (const candidate of [systemDrive, systemRoot ? path.parse(systemRoot).root : undefined, cwdRoot, homeRoot]) {
    if (candidate) {
      roots.add(normalizeWindowsDriveRoot(candidate));
    }
  }
  for (let code = 65; code <= 90; code += 1) {
    const root = `${String.fromCharCode(code)}:\\`;
    try {
      const stat = statSync(root);
      if (stat.isDirectory()) {
        roots.add(root);
      }
    } catch {
      // Ignore inaccessible or unmounted drive letters.
    }
  }
  return [...roots].filter(Boolean).sort();
};

const normalizeWindowsDriveRoot = (value: string): string => {
  const parsed = path.win32.parse(value);
  return parsed.root || value;
};
