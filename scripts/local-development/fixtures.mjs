import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const excluded = new Set(['.git', '.gitmodules', '.DS_Store', '.venv', 'node_modules', '__pycache__', '.pytest_cache', '.ruff_cache', 'dist', 'build', 'coverage', 'data']);
const overlays = fileURLToPath(new URL('../../benchmarks/local-development/fixtures/', import.meta.url));
export const digest = (content) => createHash('sha256').update(content).digest('hex');
const skip = (name) => excluded.has(name) || (name.startsWith('.env') && name !== '.env.example') || name.endsWith('.pyc');

// Explicit, pinned stack contract, not a general Compose interpreter. The source
// digest and mount declarations both fail closed if the skeleton changes.
const commonsMounts = [
  ...['database.py', 'background_jobs.py', 'health.py', 'cors.py', 'forger_desktop.py', 'forger_context.py', 'desktop_events.py', 'desktop_task_jobs.py', 'desktop_agent_jobs.py', 'realtime.py'].map((name) => ({ source: `commons/backend/${name}`, destination: `backend/src/app/${name}`, container: `/app/src/app/${name}` })),
  ...['client.ts', 'locale.ts', 'forgerBrand.ts', 'remoteTunnel.ts'].map((name) => ({ source: `commons/frontend/${name}`, destination: `frontend/src/api/${name}`, container: `/app/src/api/${name}` })),
];

async function materializeCommons(workspace, source) {
  if (!source.files['docker-compose.yml']) return [];
  const compose = await fs.readFile(path.join(workspace, 'docker-compose.yml'), 'utf8');
  const declarations = compose.split('\n').map((line) => line.trim()).filter((line) => line.startsWith('- ./commons/'));
  if (declarations.length !== commonsMounts.length) throw new Error('commons_mount_contract_changed');
  for (const { source: relative, destination, container } of commonsMounts) {
    if (!declarations.includes(`- ./${relative}:${container}`) || !source.files[relative]) throw new Error(`commons_mount_contract_changed: ${relative}`);
    await fs.mkdir(path.dirname(path.join(workspace, destination)), { recursive: true });
    await fs.copyFile(path.join(workspace, relative), path.join(workspace, destination));
  }
  return commonsMounts.map(({ source: relative, destination }) => ({ source: relative, destination, sha256: source.files[relative] }));
}

export async function snapshotTree(root) {
  const files = {};
  async function visit(directory, prefix = '') {
    for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      if (skip(entry.name)) continue;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`symlink_not_allowed: ${relative}`);
      if (entry.isDirectory()) await visit(full, relative);
      else if (entry.isFile()) files[relative] = digest(await fs.readFile(full));
      else throw new Error(`unsupported_fixture_entry: ${relative}`);
    }
  }
  await visit(root);
  return { algorithm: 'sha256', digest: digest(JSON.stringify(files)), files };
}

export async function verifyProtectedFiles(workspace, protectedFiles) {
  const changed = [];
  for (const [relative, expected] of Object.entries(protectedFiles)) {
    try {
      const file = path.join(workspace, relative);
      const stat = await fs.lstat(file);
      if (!stat.isFile() || digest(await fs.readFile(file)) !== expected) changed.push(relative);
    } catch { changed.push(relative); }
  }
  return changed;
}

export function isEditable(relative) {
  return /^(backend\/src\/app\/|frontend\/src\/)/.test(relative) && !/(^|\/)(tests|testing)\//.test(relative) && !/\.(test|spec)\.[^.]+$/.test(relative);
}

export async function prepareFixture({ sourceRoot, workspace, pin, task }) {
  const source = await snapshotTree(sourceRoot);
  if (source.digest !== pin.digest) throw new Error(`skeleton_pin_mismatch: expected ${pin.digest}, observed ${source.digest}`);
  await fs.mkdir(workspace, { recursive: false });
  for (const relative of Object.keys(source.files)) {
    const target = path.join(workspace, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(path.join(sourceRoot, relative), target);
  }
  const commonsOverlays = await materializeCommons(workspace, source);
  if (task.fixture !== 'template') {
    const overlay = await snapshotTree(path.join(overlays, 'notes'));
    for (const relative of Object.keys(overlay.files)) {
      await fs.mkdir(path.dirname(path.join(workspace, relative)), { recursive: true });
      await fs.copyFile(path.join(overlays, 'notes', relative), path.join(workspace, relative));
    }
    const main = path.join(workspace, 'backend/src/app/main.py');
    const content = await fs.readFile(main, 'utf8');
    await fs.writeFile(main, content.replace('from app.health import', 'from app.notes import router as notes_router\nfrom app.health import').replace('    app.include_router(health_router)', '    app.include_router(notes_router)\n    app.include_router(health_router)'));
    if (task.fixture === 'crud') {
      const target = path.join(workspace, 'backend/src/app/notes.py');
      const notes = await fs.readFile(target, 'utf8');
      await fs.writeFile(target, notes.slice(0, notes.indexOf('@router.post')));
    }
    if (task.fixture === 'bug') {
      const target = path.join(workspace, 'backend/src/app/notes.py');
      await fs.writeFile(target, (await fs.readFile(target, 'utf8')).replace('return value.strip()', 'return value'));
    }
  }
  const snapshot = await snapshotTree(workspace);
  const stackOwned = new Set(commonsOverlays.map((overlay) => overlay.destination));
  const protectedFiles = Object.fromEntries(Object.entries(snapshot.files).filter(([relative]) => !isEditable(relative) || stackOwned.has(relative)));
  const preparation = { recipe: 'compose-commons-and-task-overlay-v1', sourceSha256: source.digest, recipeSha256: digest(await fs.readFile(fileURLToPath(import.meta.url))), fixture: task.fixture, commonsOverlays, preparedStateSha256: snapshot.digest };
  preparation.sha256 = digest(JSON.stringify(preparation));
  return { workspace, snapshot, protectedFiles, preparation };
}
