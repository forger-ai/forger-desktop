import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  computeRunOutcome,
  isFailureHandled,
  lookupContextPath,
  resolveNodeReadiness,
} = require('../../dist-electron/main/workflow/engine.js');
const { hasValidLegacyWorkflows, isValidLegacyWorkflow } = require('../../dist-electron/main/workflow/legacy.js');
const { validateOutputAgainstSchema } = require('../../dist-electron/main/workflow/output-schema.js');
const { WorkflowStore, toWorkflowRunSummary } = require('../../dist-electron/main/workflow/store.js');

const node = (id, overrides = {}) => ({
  id,
  name: `Node ${id}`,
  type: 'llm_agent',
  prompt: 'Work',
  toolIds: [],
  appIds: [],
  connectionGrants: [],
  ...overrides,
});

const workflow = (overrides = {}) => ({
  id: 'workflow-1',
  name: 'Daily report',
  trigger: { type: 'manual' },
  nodes: [node('start')],
  edges: [],
  enabled: true,
  running: false,
  nextRunAt: null,
  createdAt: '2026-08-10T10:00:00.000Z',
  updatedAt: '2026-08-10T10:00:00.000Z',
  ...overrides,
});

test('legacy workflow validation accepts only sanitized, named, acyclic workflows', () => {
  assert.equal(isValidLegacyWorkflow(null), false);
  assert.equal(isValidLegacyWorkflow('workflow'), false);
  assert.equal(isValidLegacyWorkflow({}), false);
  assert.equal(isValidLegacyWorkflow({ id: '   ' }), false);
  assert.equal(isValidLegacyWorkflow(workflow({ name: '   ' })), false);
  assert.equal(isValidLegacyWorkflow(workflow({
    nodes: [node('a'), node('b')],
    edges: [
      { from: 'a', to: 'b', condition: 'success' },
      { from: 'b', to: 'a', condition: 'success' },
    ],
  })), false);
  assert.equal(isValidLegacyWorkflow(workflow()), true);
  assert.equal(hasValidLegacyWorkflows({}), false);
  assert.equal(hasValidLegacyWorkflows([null, workflow()]), true);
  assert.equal(hasValidLegacyWorkflows([null, { id: '' }]), false);
});

test('workflow readiness and run outcome preserve missing-source and fallback error semantics', () => {
  const nodes = [node('source'), node('target')];
  const edges = [{ from: 'source', to: 'target', condition: 'success' }];
  assert.deepEqual(resolveNodeReadiness(nodes, edges, {
    target: { status: 'pending' },
  }), { ready: [], skipped: [] });
  assert.equal(isFailureHandled('source', [{ from: 'source', to: 'target', condition: 'always' }]), true);
  assert.deepEqual(computeRunOutcome(nodes, [], {
    source: { status: 'failed' },
    target: { status: 'skipped' },
  }), { status: 'failed', error: 'workflow_node_failed:source' });
  assert.equal(lookupContextPath({ trigger: {}, nodes: { source: { status: 'succeeded', output: { values: [1] } } } }, 'nodes.source.output.values.invalid'), undefined);
});

test('output schemas treat absent required and properties declarations as empty contracts', () => {
  assert.deepEqual(validateOutputAgainstSchema({}, { type: 'object' }), []);
  assert.deepEqual(validateOutputAgainstSchema({}, { type: 'object', required: 'id', properties: [] }), []);
});

test('workflow store persists definitions, bounded indexes, summaries, and transcripts safely', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forger-b28-workflow-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new WorkflowStore({ metadataRoot: root });
  const definition = workflow();
  const run = {
    id: 'run-1',
    workflowId: definition.id,
    trigger: 'manual',
    status: 'succeeded',
    startedAt: '2026-08-10T10:00:00.000Z',
    finishedAt: '2026-08-10T10:00:01.000Z',
    nodeRuns: [{ nodeId: 'start', nodeName: 'Node start', nodeType: 'llm_agent', status: 'succeeded' }],
    transcript: 'Completed safely',
  };

  await store.initialize();
  assert.deepEqual(await store.readWorkflows(), []);
  await store.saveWorkflows([definition]);
  assert.deepEqual(await store.readWorkflows(), [definition]);
  assert.deepEqual(toWorkflowRunSummary(run), {
    id: run.id,
    workflowId: run.workflowId,
    trigger: run.trigger,
    status: run.status,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    error: undefined,
    pendingApprovalNodeId: undefined,
    nodeRuns: run.nodeRuns,
  });

  await store.writeRun(run);
  assert.deepEqual(await store.readRun(run.id), run);
  assert.equal(await fs.readFile(store.runTranscriptPath(run.id), 'utf8'), run.transcript);
  await store.writeRun({ ...run, id: 'run-empty', transcript: '' });
  assert.equal((await store.readRun('run-empty')).transcript, '');
  assert.equal(await store.readRun('missing'), null);

  await fs.writeFile(path.join(root, 'workflows.json'), '{', 'utf8');
  assert.deepEqual(await store.readWorkflows(), []);
  await fs.writeFile(path.join(root, 'workflows.json'), '{}', 'utf8');
  assert.deepEqual(await store.readWorkflows(), []);
  await fs.writeFile(path.join(root, 'workflow-runs', 'broken.json'), '{', 'utf8');
  assert.equal(await store.readRun('broken'), null);

  await store.appendRunId('workflow-1', 'run-1');
  await store.appendRunId('workflow-1', 'run-2');
  await store.appendRunId('workflow-1', 'run-1');
  assert.deepEqual(await store.readRunIds('workflow-1'), ['run-1', 'run-2']);
  for (let index = 0; index < 205; index += 1) {
    await store.appendRunId('bounded', `run-${index}`);
  }
  assert.equal((await store.readRunIds('bounded')).length, 200);
  const indexPath = path.join(root, 'workflow-runs', 'mixed.index.json');
  await fs.writeFile(indexPath, JSON.stringify(['run', 7, null]), 'utf8');
  assert.deepEqual(await store.readRunIds('mixed'), ['run']);
  await fs.writeFile(indexPath, '{}', 'utf8');
  assert.deepEqual(await store.readRunIds('mixed'), []);
  await fs.writeFile(indexPath, '{', 'utf8');
  assert.deepEqual(await store.readRunIds('mixed'), []);
  assert.deepEqual(await store.readRunIds('missing'), []);

  assert.throws(() => store.runTranscriptPath('../outside'), /workflow_run_path_outside_storage/);
});
