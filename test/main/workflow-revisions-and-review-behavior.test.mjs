import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { WorkflowManager } = require('../../dist-electron/main/workflow-manager.js');
const { workflowAppActionContractHash } = require('../../dist-electron/main/workflow/revisions.js');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const waitFor = async (predicate, timeoutMs = 5_000) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = await predicate();
    if (value) return value;
    await wait(20);
  }
  throw new Error('waitFor_timeout');
};

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const actionDefinition = (overrides = {}) => {
  const action = {
    toolName: 'contacts.create',
    title: 'Create contact',
    description: 'Creates one contact.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    },
    effect: 'write',
    risk: 'medium',
    idempotent: true,
    ...overrides,
  };
  return {
    ...action,
    contractHash: overrides.contractHash ?? workflowAppActionContractHash(action.toolName, action),
  };
};

const actionNode = (name = 'Original name') => ({
  id: 'create-contact',
  name: 'Create contact',
  type: 'app_action',
  appId: 'contacts',
  toolName: 'contacts.create',
  input: { name },
  action: actionDefinition(),
  requiresApproval: true,
});

const scheduledInput = (overrides = {}) => ({
  name: 'Daily contacts',
  description: 'Create one contact',
  trigger: { type: 'scheduled', frequency: { type: 'daily', timeOfDay: '09:00' } },
  nodes: [actionNode()],
  edges: [],
  ...overrides,
});

const createHarness = async ({ metadataRoot: suppliedRoot, beforeInitialize, ...overrides } = {}) => {
  const metadataRoot = suppliedRoot ?? await mkdtemp(join(tmpdir(), 'forger-workflow-revisions-'));
  const ownsRoot = !suppliedRoot;
  const calls = {
    appActions: [],
    connectors: [],
    providers: [],
    preflights: [],
    releases: [],
  };
  if (beforeInitialize) await beforeInitialize(metadataRoot);
  const manager = new WorkflowManager({
    forgerHomeRoot: metadataRoot,
    metadataRoot,
    codexHome: join(metadataRoot, 'codex'),
    getAgentRuntime: async (request) => {
      calls.providers.push(request);
      return { provider: 'codex', model: 'gpt-test', effort: 'medium' };
    },
    getInstalledApps: () => [],
    getCodexCliPath: async () => null,
    getClaudeCliPath: async () => null,
    getCodexPathEntries: async () => [],
    getCodexAuthenticated: async () => false,
    getClaudeAuthenticated: async () => false,
    listAppActions: async () => [actionDefinition()],
    callAppAction: async (input) => {
      calls.appActions.push(input);
      return { id: `contact-${calls.appActions.length}` };
    },
    callConnectorAction: async (input) => {
      calls.connectors.push(input);
      return { success: true, data: {} };
    },
    preflightAppActions: async (nodes, operationId) => {
      calls.preflights.push({ nodes, operationId });
    },
    releaseAppActions: async (operationId) => {
      calls.releases.push(operationId);
    },
    getPersonalAgent: async () => null,
    onWorkflowUpdated: () => {},
    ...overrides,
  });
  await manager.initialize();
  return {
    manager,
    metadataRoot,
    calls,
    cleanup: async () => {
      await manager.dispose();
      if (ownsRoot) await rm(metadataRoot, { recursive: true, force: true });
    },
  };
};

const reviewAndApply = async (manager, workflow) => {
  const review = await manager.review(workflow.id);
  assert.equal(review.status, 'ready');
  assert.equal(review.issues.length, 0);
  assert.equal(typeof review.definitionHash, 'string');
  assert.ok(review.definitionHash.length > 0);
  const applied = await manager.apply(workflow.id, {
    definitionHash: review.definitionHash,
    expectedRevision: workflow.revision,
  });
  return { review, applied };
};

test('review is a zero-effect readiness report and apply requires that exact ready review', async () => {
  const harness = await createHarness();
  try {
    const workflow = await harness.manager.upsert(scheduledInput({ enabled: true }));
    assert.equal(workflow.revision, 1);
    assert.equal(workflow.enabled, false, 'saving cannot activate a schedule');
    assert.equal(workflow.appliedRevision ?? null, null);
    assert.equal(workflow.appliedRevisionId ?? null, null);
    assert.equal(workflow.nextRunAt, null, 'a draft must not arm a timer');
    assert.equal(workflow.running, false);
    assert.deepEqual(await harness.manager.listRuns(workflow.id), []);
    const draftRevisions = await harness.manager.listRevisions(workflow.id);
    assert.equal(draftRevisions.length, 1);
    assert.equal(draftRevisions[0].revision, 1);
    assert.equal(draftRevisions[0].applied, false);

    const beforeReview = structuredClone(harness.calls);
    const review = await harness.manager.review(workflow.id);

    assert.deepEqual(Object.keys(review).sort(), ['definitionHash', 'issues', 'status']);
    assert.equal(review.status, 'ready');
    assert.equal(typeof review.definitionHash, 'string');
    assert.deepEqual(review.issues, []);
    assert.deepEqual(harness.calls.appActions, beforeReview.appActions);
    assert.deepEqual(harness.calls.connectors, beforeReview.connectors);
    assert.deepEqual(harness.calls.providers, beforeReview.providers);
    assert.deepEqual(harness.calls.preflights, beforeReview.preflights);
    assert.deepEqual(await harness.manager.listRuns(workflow.id), []);

    await assert.rejects(
      harness.manager.apply(workflow.id, { definitionHash: 'stale', expectedRevision: 1 }),
      /workflow_review_(?:required|stale)|workflow_definition_hash_mismatch/,
    );
    const applied = await harness.manager.apply(workflow.id, {
      definitionHash: review.definitionHash,
      expectedRevision: 1,
    });
    assert.equal(harness.calls.preflights.length, 1, 'apply performs authoritative app preflight');
    assert.equal(applied.appliedRevision, 1);
    assert.equal(typeof applied.appliedRevisionId, 'string');
    assert.deepEqual(applied.appliedTrigger, workflow.trigger);
    assert.equal(applied.enabled, false, 'apply does not activate');
    assert.equal(applied.nextRunAt, null);
    assert.deepEqual(await harness.manager.listRuns(workflow.id), []);

    const revisions = await harness.manager.listRevisions(workflow.id);
    assert.equal(revisions.length, 1);
    assert.equal(revisions[0].revision, 1);
    assert.equal(revisions[0].applied, true);
    assert.equal(revisions[0].definitionHash, review.definitionHash);
  } finally {
    await harness.cleanup();
  }
});

test('apply rejects a canonically valid live app contract that differs from the reviewed snapshot', async () => {
  let liveAction = actionDefinition();
  const harness = await createHarness({
    listAppActions: async () => [liveAction],
  });
  try {
    const workflow = await harness.manager.upsert(scheduledInput({ trigger: { type: 'manual' } }));
    const review = await harness.manager.review(workflow.id);
    liveAction = actionDefinition({ risk: 'high' });

    await assert.rejects(
      harness.manager.apply(workflow.id, {
        definitionHash: review.definitionHash,
        expectedRevision: workflow.revision,
      }),
      /workflow_app_action_contract_changed/,
    );
    assert.equal(harness.manager.get(workflow.id).appliedRevision ?? null, null);
  } finally {
    await harness.cleanup();
  }
});

test('a later save invalidates review while preserving the immutable applied snapshot and active schedule', async () => {
  const harness = await createHarness();
  try {
    const first = await harness.manager.upsert(scheduledInput());
    await reviewAndApply(harness.manager, first);
    const active = await harness.manager.setEnabled(first.id, true);
    assert.equal(active.enabled, true);
    assert.ok(active.nextRunAt);

    const second = await harness.manager.upsert(scheduledInput({
      id: first.id,
      expectedRevision: first.revision,
      name: 'Changed draft',
      trigger: { type: 'manual' },
      nodes: [actionNode('New draft name')],
    }));
    assert.equal(second.revision, 2);
    assert.equal(second.appliedRevision, 1);
    assert.equal(second.trigger.type, 'manual');
    assert.equal(second.appliedTrigger.type, 'scheduled');
    assert.equal(second.enabled, true);
    assert.equal(second.nextRunAt, active.nextRunAt, 'draft edits do not re-arm the applied schedule');
    assert.equal(second.review ?? null, null, 'saving a new draft invalidates its prior review');

    const revisions = await harness.manager.listRevisions(first.id);
    assert.deepEqual(revisions.map((entry) => entry.revision), [2, 1]);
    assert.equal(revisions.find((entry) => entry.revision === 1).applied, true);
    assert.equal(revisions.find((entry) => entry.revision === 1).workflow.name, 'Daily contacts');
    assert.equal(revisions.find((entry) => entry.revision === 2).applied, false);
  } finally {
    await harness.cleanup();
  }
});

test('runNow executes the applied snapshot and stamps its immutable revision identity on the run', async () => {
  const harness = await createHarness();
  try {
    const first = await harness.manager.upsert(scheduledInput());
    const { review } = await reviewAndApply(harness.manager, first);
    await harness.manager.upsert(scheduledInput({
      id: first.id,
      expectedRevision: first.revision,
      name: 'Unapplied edit',
      nodes: [actionNode('New draft name')],
    }));

    const queued = await harness.manager.runNow(first.id);
    assert.equal(queued.workflowRevision, 1);
    assert.equal(typeof queued.workflowRevisionId, 'string');
    assert.equal(queued.definitionHash, review.definitionHash);

    const waiting = await waitFor(async () => {
      const run = await harness.manager.getRun(queued.id);
      return run?.status === 'waiting_approval' ? run : null;
    });
    await harness.manager.approveNode({
      runId: waiting.id,
      nodeId: waiting.pendingApprovalNodeId,
      approved: true,
    });
    const finished = await waitFor(async () => {
      const run = await harness.manager.getRun(queued.id);
      return run?.status === 'succeeded' ? run : null;
    });

    assert.equal(harness.calls.appActions.length, 1);
    assert.deepEqual(harness.calls.appActions[0].input, { name: 'Original name' });
    assert.equal(finished.workflowRevision, 1);
    assert.equal(finished.workflowRevisionId, queued.workflowRevisionId);
    assert.equal(finished.definitionHash, review.definitionHash);
  } finally {
    await harness.cleanup();
  }
});

test('restoring history creates a new draft and never changes the applied or active schedule', async () => {
  const harness = await createHarness();
  try {
    const first = await harness.manager.upsert(scheduledInput());
    await reviewAndApply(harness.manager, first);
    const active = await harness.manager.setEnabled(first.id, true);
    const second = await harness.manager.upsert(scheduledInput({
      id: first.id,
      expectedRevision: first.revision,
      name: 'Revision two',
      nodes: [actionNode('Second')],
    }));
    const beforeRestore = await harness.manager.listRevisions(first.id);
    const revisionOne = beforeRestore.find((entry) => entry.revision === 1);

    const restored = await harness.manager.restoreRevision(first.id, {
      revisionId: revisionOne.id,
      expectedRevision: second.revision,
    });
    assert.equal(restored.revision, 3);
    assert.equal(restored.name, 'Daily contacts');
    assert.equal(restored.appliedRevision, 1);
    assert.equal(restored.enabled, true);
    assert.equal(restored.nextRunAt, active.nextRunAt);
    assert.equal(restored.review ?? null, null);

    const afterRestore = await harness.manager.listRevisions(first.id);
    assert.deepEqual(afterRestore.map((entry) => entry.revision), [3, 2, 1]);
    assert.notEqual(afterRestore[0].id, revisionOne.id, 'restore is a new draft, not pointer rollback');
    assert.equal(afterRestore.filter((entry) => entry.applied).length, 1);
    assert.equal(afterRestore.find((entry) => entry.applied).revision, 1);
  } finally {
    await harness.cleanup();
  }
});

test('activation requires an applied revision and only scheduled workflows can arm', async () => {
  const harness = await createHarness();
  try {
    const scheduled = await harness.manager.upsert(scheduledInput());
    await assert.rejects(
      harness.manager.setEnabled(scheduled.id, true),
      /workflow_applied_revision_required/,
    );
    assert.equal(harness.manager.get(scheduled.id).nextRunAt, null);

    await reviewAndApply(harness.manager, scheduled);
    const activated = await harness.manager.setEnabled(scheduled.id, true);
    assert.equal(activated.enabled, true);
    assert.ok(activated.nextRunAt);

    const manual = await harness.manager.upsert(scheduledInput({
      name: 'Manual only',
      trigger: { type: 'manual' },
    }));
    await reviewAndApply(harness.manager, manual);
    await assert.rejects(
      harness.manager.setEnabled(manual.id, true),
      /workflow_manual_cannot_activate|workflow_schedule_required/,
    );
    assert.equal(harness.manager.get(manual.id).enabled, false);
    assert.equal(harness.manager.get(manual.id).nextRunAt, null);
  } finally {
    await harness.cleanup();
  }
});

test('legacy persisted workflows migrate idempotently to applied revision 1 and preserve activation', async () => {
  const metadataRoot = await mkdtemp(join(tmpdir(), 'forger-workflow-legacy-'));
  const legacy = {
    id: 'legacy-workflow',
    name: 'Legacy schedule',
    trigger: { type: 'scheduled', frequency: { type: 'daily', timeOfDay: '09:00' } },
    nodes: [actionNode()],
    edges: [],
    enabled: true,
    running: false,
    nextRunAt: '2099-01-01T09:00:00.000Z',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  await writeFile(join(metadataRoot, 'workflows.json'), JSON.stringify([legacy]), 'utf8');

  const first = await createHarness({ metadataRoot });
  try {
    const migrated = first.manager.get(legacy.id);
    assert.equal(migrated.revision, 1);
    assert.equal(migrated.appliedRevision, 1);
    assert.deepEqual(migrated.appliedTrigger, legacy.trigger);
    assert.equal(migrated.enabled, true);
    assert.equal((await first.manager.listRevisions(legacy.id)).length, 1);
    await first.manager.dispose();

    const second = await createHarness({ metadataRoot });
    try {
      const reloaded = second.manager.get(legacy.id);
      assert.equal(reloaded.revision, 1);
      assert.equal(reloaded.appliedRevision, 1);
      assert.equal(reloaded.enabled, true);
      assert.equal((await second.manager.listRevisions(legacy.id)).length, 1);
      const persisted = JSON.parse(await readFile(join(metadataRoot, 'workflows.json'), 'utf8'));
      assert.equal(persisted.length, 1);
    } finally {
      await second.cleanup();
    }
  } finally {
    await first.manager.dispose();
    await rm(metadataRoot, { recursive: true, force: true });
  }
});

test('retryRun permits only preflight failures before effects and links the retry', async () => {
  let preflightCount = 0;
  const harness = await createHarness({
    preflightAppActions: async (nodes, operationId) => {
      harness.calls.preflights.push({ nodes, operationId });
      preflightCount += 1;
      if (preflightCount >= 2) throw new Error('app_preflight_unavailable');
    },
  });
  try {
    const workflow = await harness.manager.upsert(scheduledInput({ trigger: { type: 'manual' } }));
    await reviewAndApply(harness.manager, workflow);
    const failedSummary = await harness.manager.runNow(workflow.id);
    const failed = await waitFor(async () => {
      const run = await harness.manager.getRun(failedSummary.id);
      return run?.status === 'failed' ? run : null;
    });
    assert.equal(harness.calls.appActions.length, 0);
    assert.match(failed.error, /app_preflight_unavailable/);

    const retry = await harness.manager.retryRun(failed.id);
    assert.equal(retry.retryOfRunId, failed.id);
    assert.equal(retry.workflowRevisionId, failed.workflowRevisionId);
    assert.equal(retry.definitionHash, failed.definitionHash);
    await waitFor(async () => (await harness.manager.getRun(retry.id))?.status === 'failed');
  } finally {
    await harness.cleanup();
  }
});

test('retryRun rejects failures after an action may have produced effects', async () => {
  const harness = await createHarness({
    callAppAction: async (input) => {
      harness.calls.appActions.push(input);
      throw new Error('transport_lost_after_dispatch');
    },
  });
  try {
    const workflow = await harness.manager.upsert(scheduledInput({ trigger: { type: 'manual' } }));
    await reviewAndApply(harness.manager, workflow);
    const queued = await harness.manager.runNow(workflow.id);
    const waiting = await waitFor(async () => {
      const run = await harness.manager.getRun(queued.id);
      return run?.status === 'waiting_approval' ? run : null;
    });
    await harness.manager.approveNode({ runId: waiting.id, nodeId: waiting.pendingApprovalNodeId, approved: true });
    const failed = await waitFor(async () => {
      const run = await harness.manager.getRun(queued.id);
      return run?.status === 'failed' ? run : null;
    });
    assert.equal(harness.calls.appActions.length, 1);
    await assert.rejects(
      harness.manager.retryRun(failed.id),
      /workflow_retry_not_safe|workflow_run_effects_uncertain/,
    );
    assert.equal((await harness.manager.listRuns(workflow.id)).length, 1, 'rejected retry creates no run');
  } finally {
    await harness.cleanup();
  }
});

test('two simultaneous runNow calls reserve running atomically and only one executes', async () => {
  const harness = await createHarness();
  try {
    const workflow = await harness.manager.upsert(scheduledInput({ trigger: { type: 'manual' } }));
    await reviewAndApply(harness.manager, workflow);

    const summaries = await Promise.all([
      harness.manager.runNow(workflow.id),
      harness.manager.runNow(workflow.id),
    ]);
    const queued = summaries.find((summary) => summary.status !== 'skipped');
    const skipped = summaries.find((summary) => summary.status === 'skipped');
    assert.ok(queued);
    assert.equal(skipped?.error, 'workflow_already_running');

    const waiting = await waitFor(async () => {
      const run = await harness.manager.getRun(queued.id);
      return run?.status === 'waiting_approval' ? run : null;
    });
    await harness.manager.approveNode({
      runId: waiting.id,
      nodeId: waiting.pendingApprovalNodeId,
      approved: true,
    });
    await waitFor(async () => (await harness.manager.getRun(queued.id))?.status === 'succeeded');
    assert.equal(harness.calls.appActions.length, 1);
  } finally {
    await harness.cleanup();
  }
});

test('two stale upserts serialize so exactly one advances the expected revision', async () => {
  const harness = await createHarness();
  try {
    const workflow = await harness.manager.upsert(scheduledInput({ trigger: { type: 'manual' } }));
    const updates = await Promise.allSettled([
      harness.manager.upsert(scheduledInput({
        id: workflow.id,
        expectedRevision: workflow.revision,
        name: 'Concurrent A',
      })),
      harness.manager.upsert(scheduledInput({
        id: workflow.id,
        expectedRevision: workflow.revision,
        name: 'Concurrent B',
      })),
    ]);
    assert.equal(updates.filter((result) => result.status === 'fulfilled').length, 1);
    const rejected = updates.find((result) => result.status === 'rejected');
    assert.match(String(rejected?.reason), /workflow_revision_conflict/);
    assert.equal(harness.manager.get(workflow.id).revision, 2);
    assert.equal((await harness.manager.listRevisions(workflow.id)).length, 2);
  } finally {
    await harness.cleanup();
  }
});

test('editing an existing workflow requires the revision that the caller read', async () => {
  const harness = await createHarness();
  try {
    const workflow = await harness.manager.upsert(scheduledInput({ trigger: { type: 'manual' } }));
    await assert.rejects(
      harness.manager.upsert(scheduledInput({
        id: workflow.id,
        trigger: { type: 'manual' },
        name: 'Blind overwrite',
      })),
      /workflow_expected_revision_required/,
    );
    assert.equal(harness.manager.get(workflow.id).name, workflow.name);
    assert.equal(harness.manager.get(workflow.id).revision, workflow.revision);
  } finally {
    await harness.cleanup();
  }
});

test('an upsert completed during apply preflight invalidates that apply before it persists', async () => {
  const entered = deferred();
  const release = deferred();
  const harness = await createHarness({
    preflightAppActions: async (nodes, operationId) => {
      harness.calls.preflights.push({ nodes, operationId });
      if (operationId.startsWith('workflow-apply-')) {
        entered.resolve();
        await release.promise;
      }
    },
  });
  try {
    const workflow = await harness.manager.upsert(scheduledInput({ trigger: { type: 'manual' } }));
    const review = await harness.manager.review(workflow.id);
    const applying = harness.manager.apply(workflow.id, {
      definitionHash: review.definitionHash,
      expectedRevision: workflow.revision,
    });
    await entered.promise;
    const saved = await harness.manager.upsert(scheduledInput({
      id: workflow.id,
      expectedRevision: workflow.revision,
      trigger: { type: 'manual' },
      name: 'Saved while apply waited',
    }));
    release.resolve();

    await assert.rejects(applying, /workflow_(?:review_stale|revision_conflict)/);
    assert.equal(saved.revision, 2);
    assert.equal(harness.manager.get(workflow.id).appliedRevision ?? null, null);
  } finally {
    release.resolve();
    await harness.cleanup();
  }
});

test('dispose rejects a pending approval, waits for terminal persistence, and releases the run', async () => {
  const harness = await createHarness();
  try {
    const workflow = await harness.manager.upsert(scheduledInput({ trigger: { type: 'manual' } }));
    await reviewAndApply(harness.manager, workflow);
    const queued = await harness.manager.runNow(workflow.id);
    await waitFor(async () => (await harness.manager.getRun(queued.id))?.status === 'waiting_approval');

    await harness.manager.dispose();

    const canceled = await harness.manager.getRun(queued.id);
    assert.equal(canceled.status, 'canceled');
    assert.equal(harness.manager.get(workflow.id).running, false);
    assert.ok(harness.calls.releases.includes(queued.id));
    assert.equal((await harness.manager.approveNode({
      runId: queued.id,
      nodeId: 'create-contact',
      approved: true,
    })).technicalCode, 'workflow_approval_not_pending');
  } finally {
    await harness.cleanup();
  }
});

test('cancel during the waiting-approval transition cannot leave a new resolver behind', async () => {
  const enteredWrite = deferred();
  const releaseWrite = deferred();
  const harness = await createHarness();
  const writeRun = harness.manager.store.writeRun.bind(harness.manager.store);
  harness.manager.store.writeRun = async (run) => {
    if (run.nodeRuns.some((nodeRun) => nodeRun.status === 'waiting_approval')) {
      enteredWrite.resolve();
      await releaseWrite.promise;
    }
    await writeRun(run);
  };
  try {
    const workflow = await harness.manager.upsert(scheduledInput({ trigger: { type: 'manual' } }));
    await reviewAndApply(harness.manager, workflow);
    const queued = await harness.manager.runNow(workflow.id);
    await enteredWrite.promise;

    assert.equal((await harness.manager.cancelRun(queued.id)).success, true);
    releaseWrite.resolve();

    const outcome = await waitFor(async () => {
      const run = await harness.manager.getRun(queued.id);
      if (run?.status === 'canceled') return 'canceled';
      const resolverWasRegisteredAfterCancel = harness.manager.activeRuns
        .get(queued.id)?.approvalResolvers.has('create-contact');
      return resolverWasRegisteredAfterCancel ? 'resolver_registered_after_cancel' : null;
    });
    assert.equal(outcome, 'canceled');
    assert.equal(harness.calls.appActions.length, 0);
  } finally {
    releaseWrite.resolve();
    await harness.cleanup();
  }
});

test('dispose during the running transition prevents an app action from starting', async () => {
  const enteredWrite = deferred();
  const releaseWrite = deferred();
  const harness = await createHarness();
  const writeRun = harness.manager.store.writeRun.bind(harness.manager.store);
  harness.manager.store.writeRun = async (run) => {
    if (run.nodeRuns.some((nodeRun) => nodeRun.status === 'running')) {
      enteredWrite.resolve();
      await releaseWrite.promise;
    }
    await writeRun(run);
  };
  try {
    const workflow = await harness.manager.upsert(scheduledInput({ trigger: { type: 'manual' } }));
    await reviewAndApply(harness.manager, workflow);
    const queued = await harness.manager.runNow(workflow.id);
    const waiting = await waitFor(async () => {
      const run = await harness.manager.getRun(queued.id);
      return run?.status === 'waiting_approval' ? run : null;
    });
    await harness.manager.approveNode({
      runId: queued.id,
      nodeId: waiting.pendingApprovalNodeId,
      approved: true,
    });
    await enteredWrite.promise;

    const disposing = harness.manager.dispose();
    releaseWrite.resolve();
    await disposing;

    assert.equal(harness.calls.appActions.length, 0);
    assert.equal((await harness.manager.getRun(queued.id)).status, 'canceled');
  } finally {
    releaseWrite.resolve();
    await harness.cleanup();
  }
});

test('dispose aborts an in-flight app action and waits for its release', async () => {
  const entered = deferred();
  let aborted = false;
  const harness = await createHarness({
    callAppAction: async (input) => {
      harness.calls.appActions.push(input);
      entered.resolve();
      return await new Promise((_resolve, reject) => {
        input.signal.addEventListener('abort', () => {
          aborted = true;
          reject(new Error('aborted'));
        }, { once: true });
      });
    },
  });
  try {
    const workflow = await harness.manager.upsert(scheduledInput({ trigger: { type: 'manual' } }));
    await reviewAndApply(harness.manager, workflow);
    const queued = await harness.manager.runNow(workflow.id);
    const waiting = await waitFor(async () => {
      const run = await harness.manager.getRun(queued.id);
      return run?.status === 'waiting_approval' ? run : null;
    });
    await harness.manager.approveNode({
      runId: queued.id,
      nodeId: waiting.pendingApprovalNodeId,
      approved: true,
    });
    await entered.promise;

    await harness.manager.dispose();

    assert.equal(aborted, true);
    assert.equal((await harness.manager.getRun(queued.id)).status, 'canceled');
    assert.equal(harness.manager.get(workflow.id).running, false);
    assert.ok(harness.calls.releases.includes(queued.id));
  } finally {
    await harness.cleanup();
  }
});

test('pausing while a due schedule advances cannot persistently reactivate it or start work', async () => {
  const enteredSave = deferred();
  const releaseSave = deferred();
  const harness = await createHarness();
  try {
    const workflow = await harness.manager.upsert(scheduledInput());
    await reviewAndApply(harness.manager, workflow);
    await harness.manager.setEnabled(workflow.id, true);
    harness.manager.get(workflow.id).nextRunAt = new Date(Date.now() - 1_000).toISOString();

    const saveWorkflows = harness.manager.saveWorkflows.bind(harness.manager);
    let gateNextSave = true;
    harness.manager.saveWorkflows = async () => {
      if (gateNextSave) {
        gateNextSave = false;
        enteredSave.resolve();
        await releaseSave.promise;
      }
      await saveWorkflows();
    };

    const due = harness.manager.handleDueScheduledRun(workflow.id);
    await enteredSave.promise;
    let pauseSettled = false;
    const pause = harness.manager.setEnabled(workflow.id, false).finally(() => {
      pauseSettled = true;
    });
    await wait(20);
    assert.equal(pauseSettled, false, 'pause waits behind the atomic due decision');
    releaseSave.resolve();
    await Promise.all([due, pause]);
    await wait(20);

    const current = harness.manager.get(workflow.id);
    assert.equal(current.enabled, false);
    assert.equal(current.nextRunAt, null);
    assert.equal(harness.calls.appActions.length, 0);
    assert.deepEqual(await harness.manager.listRuns(workflow.id), []);
    const persisted = JSON.parse(await readFile(join(harness.metadataRoot, 'workflows.json'), 'utf8'));
    assert.equal(persisted.find((entry) => entry.id === workflow.id).enabled, false);
    assert.equal(persisted.find((entry) => entry.id === workflow.id).nextRunAt, null);
  } finally {
    releaseSave.resolve();
    await harness.cleanup();
  }
});

test('deleting while a due schedule advances cannot recreate the persisted workflow', async () => {
  const enteredSave = deferred();
  const releaseSave = deferred();
  const harness = await createHarness();
  try {
    const workflow = await harness.manager.upsert(scheduledInput());
    await reviewAndApply(harness.manager, workflow);
    await harness.manager.setEnabled(workflow.id, true);
    harness.manager.get(workflow.id).nextRunAt = new Date(Date.now() - 1_000).toISOString();

    const saveWorkflows = harness.manager.saveWorkflows.bind(harness.manager);
    let gateNextSave = true;
    harness.manager.saveWorkflows = async () => {
      if (gateNextSave) {
        gateNextSave = false;
        enteredSave.resolve();
        await releaseSave.promise;
      }
      await saveWorkflows();
    };

    const due = harness.manager.handleDueScheduledRun(workflow.id);
    await enteredSave.promise;
    const deleting = harness.manager.delete(workflow.id);
    releaseSave.resolve();
    const [, deleted] = await Promise.all([due, deleting]);
    assert.equal(deleted.success, true);
    await wait(20);

    assert.equal(harness.manager.get(workflow.id), null);
    assert.equal(harness.calls.appActions.length, 0);
    const persisted = JSON.parse(await readFile(join(harness.metadataRoot, 'workflows.json'), 'utf8'));
    assert.equal(persisted.some((entry) => entry.id === workflow.id), false);
  } finally {
    releaseSave.resolve();
    await harness.cleanup();
  }
});
