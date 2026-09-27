import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCatalog, selectTasks } from './catalog.mjs';
import { digest, prepareFixture, snapshotTree, verifyProtectedFiles } from './fixtures.mjs';
import { applyReferenceSolution } from './references.mjs';
import { acceptancePassed, capture, checkEvaluatorPrerequisites, evaluateInDocker } from './runner.mjs';

const rootDir = fileURLToPath(new URL('../../', import.meta.url));
export const expectedRejection = {
  'template-01': 'task_acceptance',
  'crud-01': 'backend_regression',
  'modify-01': 'task_acceptance',
  'bug-01': 'task_acceptance',
  'multi-01': 'runtime_health',
};

export function classifyControl({ kind, taskId, evaluation }) {
  if (kind === 'reference') return { status: acceptancePassed(evaluation) ? 'passed' : 'failed', expectedApplicationStatus: 'passed', reason: acceptancePassed(evaluation) ? 'reference_satisfies_all_groups' : 'reference_solution_or_evaluator_failed' };
  if (kind !== 'initial' || !(taskId in expectedRejection)) throw new Error('unknown_control');
  if (acceptancePassed(evaluation)) return { status: 'failed', expectedApplicationStatus: 'failed', reason: 'initial_fixture_unexpectedly_accepted' };
  const checks = evaluation.checks ?? [];
  const index = checks.findIndex((check) => check.name === expectedRejection[taskId]);
  const expected = index >= 0 && checks[index].passed === false && checks.slice(0, index).every((check) => check.passed === true);
  return { status: expected ? 'passed' : 'failed', expectedApplicationStatus: 'failed', expectedRejectionGroup: expectedRejection[taskId], reason: expected ? 'known_requirement_missing' : 'unexpected_failure_does_not_validate_negative_control' };
}

export async function runControls({ evaluatorImage, output, taskIds, kinds = ['reference', 'initial'], evaluate = evaluateInDocker }) {
  if (kinds.some((kind) => !['reference', 'initial'].includes(kind)) || new Set(kinds).size !== kinds.length || !kinds.length) throw new Error('invalid_control_kind');
  const catalog = await loadCatalog(rootDir);
  const tasks = selectTasks(catalog, { suite: 'all', taskIds });
  const pin = JSON.parse(await fs.readFile(path.join(rootDir, 'benchmarks/local-development/skeleton-pin.json'), 'utf8'));
  const revision = await capture('git', ['rev-parse', 'HEAD'], { cwd: rootDir });
  const report = {
    schemaVersion: 1, protocol: 'forger-evaluator-controls-v1', evidenceClass: 'evaluator_control', modelUsed: false,
    startedAt: new Date().toISOString(), state: 'running', evaluatorImage, forgerRevision: revision.stdout.trim(),
    harnessHash: (await snapshotTree(path.join(rootDir, 'scripts/local-development'))).digest,
    acceptanceHash: (await snapshotTree(path.join(rootDir, 'benchmarks/local-development/evaluator'))).digest,
    skeletonHash: pin.digest, controls: [],
  };
  const persist = async () => { if (output) await fs.writeFile(output, `${JSON.stringify(report, null, 2)}\n`); };
  if (output) { await fs.mkdir(path.dirname(path.resolve(output)), { recursive: true }); await fs.writeFile(output, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' }); }
  report.prerequisites = await checkEvaluatorPrerequisites({ evaluatorImage }, rootDir);
  if (!report.prerequisites.ready) { report.state = 'blocked'; await persist(); return report; }
  for (const task of tasks) {
    for (const kind of kinds) {
      const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'forger-evaluator-control-'));
      const control = { taskId: task.id, taskHash: digest(JSON.stringify(task)), kind, startedAt: new Date().toISOString(), status: 'failed' };
      try {
        const fixture = await prepareFixture({ sourceRoot: path.join(rootDir, 'resources/app-skeletons/vite-fastapi-sqlite'), workspace: path.join(temporary, 'app'), pin, task });
        control.initialStateHash = fixture.snapshot.digest;
        control.fixturePreparation = fixture.preparation;
        if (kind === 'reference') control.reference = await applyReferenceSolution({ workspace: fixture.workspace, taskId: task.id });
        const changedProtected = await verifyProtectedFiles(fixture.workspace, fixture.protectedFiles);
        if (changedProtected.length) throw new Error(`protected_reference_file_changed: ${changedProtected.join(',')}`);
        control.evaluation = await evaluate({ config: { evaluatorImage }, task, fixture, rootDir });
        if ((await snapshotTree(path.join(rootDir, 'benchmarks/local-development/evaluator'))).digest !== report.acceptanceHash) throw new Error('acceptance_changed_during_control_run');
        Object.assign(control, classifyControl({ taskId: task.id, kind, evaluation: control.evaluation }));
      } catch (error) { control.error = error.message; }
      finally { control.finishedAt = new Date().toISOString(); await fs.rm(temporary, { recursive: true, force: true }); }
      report.controls.push(control);
      console.error(`${task.id} ${kind}: ${control.status}${control.error ? ` (${control.error})` : ''}`);
      await persist();
    }
  }
  report.finishedAt = new Date().toISOString();
  report.summary = {
    selected: report.controls.length, passed: report.controls.filter((control) => control.status === 'passed').length,
    failed: report.controls.filter((control) => control.status !== 'passed').length,
    positivePassed: report.controls.filter((control) => control.kind === 'reference' && control.status === 'passed').length,
    negativeCorrectlyRejected: report.controls.filter((control) => control.kind === 'initial' && control.status === 'passed').length,
  };
  report.state = report.summary.failed ? 'failed' : 'completed';
  report.allFiveFamiliesValidated = tasks.length === 5 && kinds.length === 2 && report.summary.passed === 10;
  await persist();
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = {};
    for (let index = 2; index < process.argv.length; index += 2) {
      const key = process.argv[index]; const value = process.argv[index + 1];
      if (!['--evaluator-image', '--output', '--tasks', '--kind'].includes(key) || !value || key in options) throw new Error('Usage: node scripts/local-development/controls.mjs --evaluator-image sha256:IMAGE --output NEW_REPORT.json [--tasks template-01] [--kind reference|initial]');
      options[key] = value;
    }
    if (!options['--evaluator-image'] || !options['--output']) throw new Error('An installed immutable evaluator image and a new output path are required.');
    const report = await runControls({ evaluatorImage: options['--evaluator-image'], output: options['--output'], taskIds: options['--tasks']?.split(','), kinds: options['--kind'] ? [options['--kind']] : undefined });
    console.log(JSON.stringify({ state: report.state, summary: report.summary, allFiveFamiliesValidated: report.allFiveFamiliesValidated, output: options['--output'] }, null, 2));
    process.exitCode = report.state === 'completed' ? 0 : 2;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
