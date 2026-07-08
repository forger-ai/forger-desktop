import fs from 'node:fs/promises';
import path from 'node:path';

import type { PersonalAgentWorkspaceEntry } from '../../shared/types';
import {
  MAX_WORKSPACE_TREE_DEPTH,
  MAX_WORKSPACE_TREE_ENTRIES,
} from './agent-store-normalizers';

interface ReadWorkspaceEntriesInput {
  workspaceRoot: string;
  ensureContained: (workspaceRoot: string, candidatePath: string) => Promise<string>;
}

export const readPersonalAgentWorkspaceEntries = async ({
  workspaceRoot,
  ensureContained,
}: ReadWorkspaceEntriesInput): Promise<PersonalAgentWorkspaceEntry[]> => {
  let count = 0;
  const readEntries = async (currentRoot: string, depth: number): Promise<PersonalAgentWorkspaceEntry[]> => {
    if (depth > MAX_WORKSPACE_TREE_DEPTH || count >= MAX_WORKSPACE_TREE_ENTRIES) {
      return [];
    }
    const entries = await fs.readdir(currentRoot, { withFileTypes: true });
    const visibleEntries = entries
      .filter((entry) => !entry.name.startsWith('.'))
      .sort((left, right) => {
        if (left.isDirectory() !== right.isDirectory()) {
          return left.isDirectory() ? -1 : 1;
        }
        return left.name.localeCompare(right.name);
      });
    const tree: PersonalAgentWorkspaceEntry[] = [];
    for (const entry of visibleEntries) {
      if (count >= MAX_WORKSPACE_TREE_ENTRIES) break;
      const absolutePath = path.join(currentRoot, entry.name);
      const relativePath = path.relative(workspaceRoot, absolutePath);
      if (entry.isDirectory()) {
        const containedPath = await ensureContained(workspaceRoot, absolutePath);
        count += 1;
        tree.push({
          name: entry.name,
          relativePath,
          kind: 'directory',
          children: await readEntries(containedPath, depth + 1),
        });
      } else if (entry.isFile()) {
        count += 1;
        tree.push({
          name: entry.name,
          relativePath,
          kind: 'file',
        });
      }
    }
    return tree;
  };

  return readEntries(workspaceRoot, 0);
};
