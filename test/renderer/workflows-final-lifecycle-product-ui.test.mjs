import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const paths = {
  module: new URL('../../src/renderer/views/workflows/WorkflowsModule.tsx', import.meta.url),
  editorPage: new URL('../../src/renderer/views/workflows/WorkflowEditorPage.tsx', import.meta.url),
  detailPage: new URL('../../src/renderer/views/workflows/WorkflowDetailPage.tsx', import.meta.url),
  runModal: new URL('../../src/renderer/views/workflows/WorkflowRunModal.tsx', import.meta.url),
  listView: new URL('../../src/renderer/views/workflows/WorkflowsListView.tsx', import.meta.url),
  desktopApi: new URL('../../src/shared/types/desktop-api.ts', import.meta.url),
  workflowsTypes: new URL('../../src/shared/types/workflows.ts', import.meta.url),
  english: new URL('../../src/renderer/i18n/locales/enSections.ts', import.meta.url),
  spanish: new URL('../../src/renderer/i18n/locales/esSections.ts', import.meta.url),
};

const readSources = async (...names) => Object.fromEntries(await Promise.all(names.map(async (name) => [
  name,
  await readFile(paths[name], 'utf8'),
])));

const assertContains = (source, fragments, label) => {
  for (const fragment of fragments) {
    assert.equal(source.includes(fragment), true, `${label} must include: ${fragment}`);
  }
};

test('draft save, zero-effect review, apply, and schedule activation are four separate product actions', async () => {
  const { module, editorPage, detailPage, desktopApi, english, spanish } = await readSources(
    'module', 'editorPage', 'detailPage', 'desktopApi', 'english', 'spanish',
  );

  assertContains(desktopApi, [
    'workflowsReview:',
    'workflowsApply:',
    'workflowsSetEnabled:',
  ], 'Desktop API lifecycle');
  assertContains(module, [
    'workflowsUpsert(',
    'workflowsReview(',
    'workflowsApply(',
    'workflowsSetEnabled(',
  ], 'WorkflowsModule lifecycle');
  assertContains(editorPage + detailPage, [
    'copy.saveDraft',
    'copy.review',
    'copy.applyReview',
  ], 'workflow editor actions');
  assertContains(detailPage, ['copy.activateSchedule'], 'scheduled activation action');

  assertContains(spanish, [
    "saveDraft: 'Guardar borrador'",
    "review: 'Revisar'",
    "applyReview: 'Aplicar revisión'",
    "activateSchedule: 'Activar horario'",
    'no ejecuta acciones',
    'no usa proveedores de IA',
    'no crea una ejecución',
  ], 'Spanish review and lifecycle copy');
  assertContains(english, [
    "saveDraft: 'Save draft'",
    "review: 'Review'",
    "applyReview: 'Apply review'",
    "activateSchedule: 'Activate schedule'",
    'does not execute actions',
    'does not use AI providers',
    'does not create a run',
  ], 'English review and lifecycle copy');
});

test('revision history restores an old snapshot as a new unapplied draft with an explicit warning', async () => {
  const { module, detailPage, desktopApi, workflowsTypes, english, spanish } = await readSources(
    'module', 'detailPage', 'desktopApi', 'workflowsTypes', 'english', 'spanish',
  );

  assertContains(workflowsTypes, ['WorkflowRevision'], 'workflow revision type');
  assertContains(desktopApi, ['workflowsListRevisions:', 'workflowsRestoreRevision:'], 'revision APIs');
  assertContains(module, ['workflowsListRevisions(', 'workflowsRestoreRevision('], 'revision orchestration');
  assertContains(detailPage, [
    'copy.revisions',
    'copy.restoreAsDraft',
    'copy.restoreRevisionWarning',
  ], 'revision panel');
  assertContains(spanish, [
    "revisions: 'Revisiones'",
    "restoreAsDraft: 'Restaurar como borrador'",
    'creará un borrador nuevo',
    'no cambiará la revisión aplicada',
    'no cambiará el horario activo',
  ], 'Spanish restore warning');
  assertContains(english, [
    "revisions: 'Revisions'",
    "restoreAsDraft: 'Restore as draft'",
    'creates a new draft',
    'does not change the applied revision',
    'does not change the active schedule',
  ], 'English restore warning');
});

test('the header exposes pending approval and failed-run recovery distinguishes safe retry from a new run', async () => {
  const { module, detailPage, runModal, desktopApi, workflowsTypes, english, spanish } = await readSources(
    'module', 'detailPage', 'runModal', 'desktopApi', 'workflowsTypes', 'english', 'spanish',
  );
  const recoveryUi = detailPage + runModal;

  assertContains(detailPage, [
    'pendingApprovalNodeId',
    'copy.pendingApproval',
  ], 'workflow detail header approval state');
  const headerEnd = detailPage.indexOf('</Stack>', detailPage.indexOf('return ('));
  const approvalCopy = detailPage.indexOf('copy.pendingApproval');
  assert.ok(approvalCopy >= 0 && approvalCopy < headerEnd, 'pending approval is rendered in the top header');

  assertContains(workflowsTypes, ['retryOfRunId', 'safeToRetry'], 'run recovery metadata');
  assertContains(desktopApi, ['workflowsRetryRun:'], 'safe retry API');
  assertContains(module, ['workflowsRetryRun('], 'safe retry orchestration');
  assertContains(recoveryUi, [
    'safeToRetry',
    'copy.retryRun',
    'copy.startNewRun',
    'copy.newRunEffectsWarning',
  ], 'failed run recovery UI');
  assertContains(spanish, [
    "pendingApproval: 'Aprobación pendiente'",
    "retryRun: 'Reintentar de forma segura'",
    "startNewRun: 'Iniciar una ejecución nueva'",
    'podría repetir efectos',
  ], 'Spanish run recovery copy');
  assertContains(english, [
    "pendingApproval: 'Approval pending'",
    "retryRun: 'Retry safely'",
    "startNewRun: 'Start a new run'",
    'may repeat effects',
  ], 'English run recovery copy');
});

test('manual workflows never expose activation while scheduled workflows use the explicit schedule action', async () => {
  const { detailPage, listView } = await readSources('detailPage', 'listView');
  const activationSurfaces = detailPage + listView;

  assertContains(activationSurfaces, [
    "workflow.trigger.type === 'scheduled'",
    'copy.activateSchedule',
  ], 'schedule-only activation');
  assert.equal(
    activationSurfaces.includes('onToggleEnabled={() =>') && !activationSurfaces.includes("trigger.type === 'scheduled'"),
    false,
    'activation is never unconditional for manual workflows',
  );
});

test('a handled failure is presented as completed with issues instead of green success', async () => {
  const { detailPage, workflowsTypes, english, spanish } = await readSources(
    'detailPage', 'workflowsTypes', 'english', 'spanish',
  );

  assertContains(workflowsTypes, ["'completed_with_issues'"], 'workflow run status');
  assertContains(detailPage, ["completed_with_issues: 'warning'"], 'handled incident color');
  assertContains(english, ["completed_with_issues: 'Completed with issues'"], 'English handled incident copy');
  assertContains(spanish, ["completed_with_issues: 'Completado con incidencias'"], 'Spanish handled incident copy');
});
