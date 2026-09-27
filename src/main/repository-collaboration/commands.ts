import type { RepositoryCollaborationRepository } from '../../shared/types/repository-collaboration';
export type CollaborationCommand =
  | {
      kind: 'status' | 'cancel';
      taskId: string;
    }
  | {
      kind: 'work';
      text: string;
      taskId?: string;
    };
export function parseCollaborationCommand(
  text: string,
): CollaborationCommand | null {
  const match = text
    .trim()
    .match(/^(?:@Forger\b\s*[:,]?\s*|Forger\s*[:,]\s*)([\s\S]+)$/i);
  if (!match) return null;
  const content = match[1].trim();
  const control = content.match(
    /^(estado|status|cancelar|cancel)\s+#([a-zA-Z0-9-]+)\s*$/i,
  );
  if (control)
    return {
      kind: /^(estado|status)$/i.test(control[1]) ? 'status' : 'cancel',
      taskId: control[2],
    };
  const continuation = content.match(/^#([a-zA-Z0-9-]+)\s+([\s\S]+)$/);
  return continuation
    ? { kind: 'work', taskId: continuation[1], text: continuation[2].trim() }
    : { kind: 'work', text: content };
}
export function selectRepositories(
  text: string,
  repositories: Pick<RepositoryCollaborationRepository, 'id' | 'name'>[],
): {
  repositoryIds: string[];
  prompt: string;
} | null {
  const colon = text.indexOf(':');
  if (colon >= 0) {
    const selection = text
      .slice(0, colon)
      .replace(/^(en|in)\s+/i, '')
      .trim();
    const names = selection
      .split('+')
      .map((name) => name.trim().toLocaleLowerCase());
    const selected = names.map((name) =>
      repositories.find((repo) => repo.name.toLocaleLowerCase() === name),
    );
    if (!selected.every(Boolean) || !text.slice(colon + 1).trim()) return null;
    return {
      repositoryIds: [...new Set(selected.map((repo) => repo!.id))],
      prompt: text.slice(colon + 1).trim(),
    };
  }
  const explicit = text.match(/^(en|in)\s+(.+)$/i);
  if (explicit) {
    const candidates = repositories.filter((repo) =>
      explicit[2]
        .toLocaleLowerCase()
        .startsWith(`${repo.name.toLocaleLowerCase()} `),
    );
    if (candidates.length !== 1) return null;
    return {
      repositoryIds: [candidates[0].id],
      prompt: explicit[2].slice(candidates[0].name.length).trim(),
    };
  }
  return repositories.length === 1 && text.trim()
    ? { repositoryIds: [repositories[0].id], prompt: text.trim() }
    : null;
}
