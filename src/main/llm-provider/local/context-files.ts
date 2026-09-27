import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';

const SOURCE_EXTENSION = /\.(?:py|[cm]?js|jsx|tsx?|css|html|vue|svelte|rs|go|java|c|h|cpp|sql)$/i;
const EXCLUDED = /^(?:tests?|__tests__|fixtures?|evaluator|node_modules|vendor|deps|dependencies|dist|build|coverage|__pycache__|venv|commons)$/i;
const SENSITIVE_NAME = /(?:secret|credential|password|private[-_]?key|api[-_]?key|access[-_]?token|id_rsa|id_ed25519)/i;
const TEST_SOURCE = /(?:^test[_-]|[_-]test\.|\.(?:test|spec)\.)/i;
const MAX_VISITS = 2000;
const MAX_SOURCE_BYTES = 256 * 1024;

export interface ContextFile {
  id: string;
  path: string;
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
}

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('local_cancelled');
}

function allowedName(name: string): boolean {
  return /^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/.test(name) && !EXCLUDED.test(name) && !SENSITIVE_NAME.test(name);
}

/** Canonical workspace root is the boundary; all descendants must remain ordinary files/directories. */
async function validatePath(root: string, relative: string, finalKind: 'file' | 'directory', signal?: AbortSignal): Promise<void> {
  const parts = relative.split('/');
  if (!parts.length || parts.some((part) => !allowedName(part) || part === '..')) throw new Error('local_context_file_changed');
  let current = root;
  for (const [index, part] of parts.entries()) {
    checkAbort(signal);
    current = path.join(current, part);
    const stat = await fs.lstat(current);
    const directory = index < parts.length - 1 || finalKind === 'directory';
    if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) throw new Error('local_context_file_changed');
  }
  if (await fs.realpath(current) !== path.join(root, ...parts)) throw new Error('local_context_file_changed');
}

export async function inventoryContextFiles(workingDir: string, signal?: AbortSignal) {
  const root = await fs.realpath(workingDir);
  const files: ContextFile[] = [];
  let bytes = 2;
  let visits = 0;
  let truncated = false;
  const walk = async (relative: string, depth: number): Promise<void> => {
    checkAbort(signal);
    if (depth > 12 || visits >= MAX_VISITS || files.length >= 80) { truncated = true; return; }
    if (relative) await validatePath(root, relative, 'directory', signal);
    const directory = await fs.opendir(path.join(root, relative));
    const entries = [];
    for await (const entry of directory) {
      if (++visits > MAX_VISITS) { truncated = true; break; }
      entries.push(entry);
    }
    entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const entry of entries) {
      checkAbort(signal);
      if (!allowedName(entry.name) || entry.isSymbolicLink()) continue;
      const next = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { await walk(next, depth + 1); continue; }
      if (!entry.isFile() || !SOURCE_EXTENSION.test(entry.name) || TEST_SOURCE.test(entry.name)) continue;
      if (files.length >= 80) { truncated = true; break; }
      await validatePath(root, next, 'file', signal);
      const stat = await fs.lstat(path.join(root, next));
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > MAX_SOURCE_BYTES) continue;
      const file = { id: `f${files.length + 1}`, path: next, dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs };
      const addition = Buffer.byteLength(JSON.stringify({ id: file.id, path: next })) + (files.length ? 1 : 0);
      if (bytes + addition > 6 * 1024) { truncated = true; break; }
      files.push(file);
      bytes += addition;
    }
  };
  await walk('', 0);
  return { root, files, bytes, truncated };
}

/** Heuristic defense for obvious inline credentials; this is not a proof that source contains no secrets. */
function sensitiveContent(text: string): boolean {
  return /-----BEGIN (?:[A-Z ]*PRIVATE KEY|OPENSSH PRIVATE KEY)-----|\b(?:sk-(?:proj-)?[a-zA-Z0-9_-]{12,}|AKIA[A-Z0-9]{16}|gh[pousr]_[a-zA-Z0-9]{20,})\b/i.test(text)
    || /\b(?:api[_-]?key|access[_-]?token|client[_-]?secret|password|secret[_-]?key)\s*[:=]\s*["'][^"'\r\n]{4,}["']/i.test(text);
}

export async function readContextExcerpt(root: string, file: ContextFile, searchTerms: string[], byteBudget: number, signal?: AbortSignal) {
  try {
    checkAbort(signal);
    await validatePath(root, file.path, 'file', signal);
    // Nonblocking open prevents a last-moment replacement with a FIFO from outliving cancellation.
    // Descriptor validation below still rejects every non-regular file before reading.
    const handle = await fs.open(path.join(root, file.path), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = await handle.stat();
      const same = (stat: typeof before): boolean => stat.isFile() && stat.nlink === 1 && stat.dev === file.dev
        && stat.ino === file.ino && stat.size === file.size && stat.mtimeMs === file.mtimeMs;
      if (!same(before) || before.size > MAX_SOURCE_BYTES) throw new Error('local_context_file_changed');
      await validatePath(root, file.path, 'file', signal);
      const buffer = Buffer.alloc(before.size + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      await validatePath(root, file.path, 'file', signal);
      if (!same(await handle.stat()) || !same(await fs.lstat(path.join(root, file.path))) || bytesRead !== before.size) throw new Error('local_context_file_changed');
      checkAbort(signal);
      const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead));
      if (text.includes('\0')) throw new Error('local_context_file_changed');
      if (sensitiveContent(text)) throw new Error('local_context_sensitive_content');
      const lines = text.split('\n');
      const lowered = searchTerms.map((term) => term.toLowerCase());
      const match = lines.findIndex((line) => lowered.some((term) => line.toLowerCase().includes(term)));
      const start = Math.max(0, match - 20);
      const selected = lines.slice(start, start + 120);
      let excerpt = selected.map((line, i) => `${start + i + 1}: ${line}`).join('\n');
      const originalBytes = Buffer.byteLength(excerpt);
      if (originalBytes > byteBudget) excerpt = new TextDecoder().decode(Buffer.from(excerpt).subarray(0, byteBudget), { stream: true });
      return { text: excerpt, bytes: Buffer.byteLength(excerpt), lines: excerpt ? excerpt.split('\n').length : 0,
        truncated: start !== 0 || start + selected.length < lines.length || originalBytes > byteBudget };
    } finally { await handle.close(); }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('local_')) throw error;
    throw new Error('local_context_file_changed');
  }
}
