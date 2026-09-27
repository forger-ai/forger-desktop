import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { digest, snapshotTree } from './fixtures.mjs';

const benchmarkRoot = fileURLToPath(new URL('../../benchmarks/local-development/', import.meta.url));
const referenceRoot = path.join(benchmarkRoot, 'references');
const overlays = {
  'template-01': ['template'],
  'crud-01': ['notes'],
  'modify-01': ['notes', 'shared', 'search'],
  'bug-01': ['notes'],
  'multi-01': ['notes', 'shared', 'archive'],
};

function replaceOnce(content, before, after) {
  if (content.indexOf(before) === -1 || content.indexOf(before) !== content.lastIndexOf(before)) throw new Error('reference_initial_state_mismatch');
  return content.replace(before, after);
}

/** Applies reviewed source only to a disposable, pinned initial fixture. No model runs. */
export async function applyReferenceSolution({ workspace, taskId }) {
  if (!(taskId in overlays)) throw new Error(`reference_not_available: ${taskId}`);
  const initial = await snapshotTree(workspace);
  const baseNotes = await fs.readFile(path.join(benchmarkRoot, 'fixtures/notes/backend/src/app/notes.py'));
  if (['crud-01', 'bug-01'].includes(taskId)) await fs.writeFile(path.join(workspace, 'backend/src/app/notes.py'), baseNotes);
  for (const name of overlays[taskId]) {
    const source = path.join(referenceRoot, name);
    for (const relative of Object.keys((await snapshotTree(source)).files)) {
      await fs.mkdir(path.dirname(path.join(workspace, relative)), { recursive: true });
      await fs.copyFile(path.join(source, relative), path.join(workspace, relative));
    }
  }
  if (taskId === 'template-01') {
    const main = path.join(workspace, 'backend/src/app/main.py');
    let content = await fs.readFile(main, 'utf8');
    content = replaceOnce(content, 'from app.health import router as health_router', 'from app.health import router as health_router\nfrom app.desk import router as desk_router');
    content = replaceOnce(content, '    app.include_router(health_router)\n', '    app.include_router(health_router)\n    app.include_router(desk_router)\n');
    await fs.writeFile(main, content);
  }
  const finished = await snapshotTree(workspace);
  const changedFiles = Object.keys(finished.files).filter((file) => initial.files[file] !== finished.files[file]);
  return {
    taskId, changedFiles, addedTests: changedFiles.filter((file) => file.startsWith('backend/tests/') && !(file in initial.files)),
    referenceHash: digest(JSON.stringify({ references: (await snapshotTree(referenceRoot)).digest, recipe: digest(await fs.readFile(fileURLToPath(import.meta.url))), baseNotes: digest(baseNotes) })),
    stateHash: finished.digest,
  };
}
