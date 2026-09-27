import fs from 'node:fs/promises';
import path from 'node:path';

export async function loadCatalog(rootDir) {
  const catalog = JSON.parse(await fs.readFile(path.join(rootDir, 'benchmarks/local-development/tasks.json'), 'utf8'));
  if (catalog.schemaVersion !== 1 || new Set(catalog.tasks.map((task) => task.id)).size !== catalog.tasks.length) throw new Error('invalid_task_catalog');
  return { ...catalog, tasks: catalog.tasks.map((task) => task.state === 'executable' ? { ...catalog.defaults, ...task } : task) };
}

export function selectTasks(catalog, { suite = 'development', taskIds } = {}) {
  if (!['development', 'holdout', 'all'].includes(suite)) throw new Error('invalid_suite');
  if (taskIds) {
    return taskIds.map((id) => {
      const task = catalog.tasks.find((entry) => entry.id === id);
      if (!task) throw new Error(`unknown_task: ${id}`);
      if (task.state !== 'executable') throw new Error(`task not executable: ${id}`);
      return task;
    });
  }
  return catalog.tasks.filter((task) => task.state === 'executable' && (suite === 'all' || task.partition === suite));
}

function statistics(values) {
  if (!values.length) return { n: 0, mean: null, min: null, max: null, sampleStandardDeviation: null };
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return { n: values.length, mean, min: Math.min(...values), max: Math.max(...values), sampleStandardDeviation: values.length > 1 ? Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1)) : null };
}

export function summarizeResults(results) {
  const attempted = results.filter((result) => result.attempted);
  const passed = attempted.filter((result) => result.status === 'passed');
  const autonomous = passed.filter((result) => !result.intervention);
  return {
    selected: results.length, attempted: attempted.length, blocked: results.filter((result) => result.status === 'blocked').length,
    failed: attempted.length - passed.length, passed: passed.length, autonomousPassed: autonomous.length,
    assistedPassed: passed.length - autonomous.length,
    successRate: attempted.length ? passed.length / attempted.length : null,
    autonomousSuccessRate: attempted.length ? autonomous.length / attempted.length : null,
    denominator: 'Every task attempt, including failures, timeouts and resource errors. Preflight blockers are reported separately.',
    solvedTimeMs: statistics(passed.map((result) => result.elapsedMs)),
    allAttemptTimeMs: statistics(attempted.map((result) => result.elapsedMs)),
    byTask: Object.fromEntries([...new Set(results.map((result) => result.taskId))].map((id) => {
      const trials = results.filter((result) => result.taskId === id);
      return [id, { trials: trials.length, attempted: trials.filter((result) => result.attempted).length, passed: trials.filter((result) => result.status === 'passed').length, allAttemptTimeMs: statistics(trials.filter((result) => result.attempted).map((result) => result.elapsedMs)) }];
    })),
  };
}
