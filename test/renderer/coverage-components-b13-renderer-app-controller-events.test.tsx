import { act, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  installControllerBridge,
  renderControllerHarness,
  resetControllerHarness,
} from './helpers/renderer-app-controller-harness';

beforeEach(resetControllerHarness);

describe('RendererAppController error, runtime, and reactive event variants', () => {
  it('handles report preparation rejection, stale completion, and non-Error global failures', async () => {
    const first = Promise.withResolvers<Record<string, unknown>>();
    let preparation = 0;
    const bridge = installControllerBridge({
      prepareDesktopErrorReport: (report: Record<string, unknown>) => {
        preparation += 1;
        if (preparation === 1) return first.promise;
        if (preparation === 3) return Promise.reject(new Error('prepare failed'));
        return Promise.resolve(report);
      },
    });
    const { result } = await renderControllerHarness(bridge);
    act(() => bridge.emit('onDesktopErrorReportRequested', { source: 'desktop', operation: 'first', occurredAt: 'first', message: 'First', technicalCode: 'first_failure' }));
    act(() => bridge.emit('onDesktopErrorReportRequested', { source: 'desktop', operation: 'second', occurredAt: 'second', message: 'Second', technicalCode: 'second_failure' }));
    await waitFor(() => expect(result.current.errorReportDialog.report?.occurredAt).toBe('second'));
    first.resolve({ source: 'desktop', operation: 'first', occurredAt: 'first', message: 'Prepared first', technicalCode: 'first_failure' });
    await act(async () => { await first.promise; });
    expect(result.current.errorReportDialog.report?.occurredAt).toBe('second');

    act(() => window.dispatchEvent(new ErrorEvent('error', { message: '', filename: '', lineno: 0, colno: 0 })));
    await waitFor(() => expect(result.current.errorReportDialog.userMessage).toBeTruthy());
    const rejection = new Event('unhandledrejection') as PromiseRejectionEvent;
    Object.defineProperty(rejection, 'reason', { value: undefined });
    act(() => window.dispatchEvent(rejection));
    await waitFor(() => expect(result.current.errorReportDialog.busy).toBe(false));
    expect(bridge.call('prepareDesktopErrorReport')).toHaveBeenCalledTimes(4);
  });

  it('filters unrelated Antigravity sessions and handles optional status, text, stream, and logging failures', async () => {
    const bridge = installControllerBridge({
      desktopLog: () => Promise.reject(new Error('logging disabled')),
      getSettings: () => Promise.reject(new Error('settings unavailable')),
    });
    const { result } = await renderControllerHarness(bridge);
    act(() => bridge.emit('onAntigravityAuthSessionEvent', { sessionId: 'active', type: 'started', text: 'Started' }));
    act(() => bridge.emit('onAntigravityAuthSessionEvent', { sessionId: 'other', type: 'output', text: 'Ignore me', stream: 'stderr' }));
    expect(result.current.antigravityAuthLines.some((line) => line.text === 'Ignore me')).toBe(false);
    act(() => bridge.emit('onAntigravityAuthSessionEvent', { sessionId: 'active', type: 'output', text: 'Default stream' }));
    act(() => bridge.emit('onAntigravityAuthSessionEvent', { sessionId: 'active', type: 'completed' }));
    act(() => bridge.emit('onAntigravityAuthSessionEvent', { sessionId: 'active', type: 'failed' }));
    act(() => bridge.emit('onAntigravityAuthSessionEvent', { sessionId: 'active', type: 'canceled', text: 'Canceled' }));
    expect(result.current.antigravityAuthLines.map((line) => line.text)).toEqual(expect.arrayContaining(['Started', 'Default stream', 'Canceled']));
  });

  it('sorts and replaces background tasks and covers runtime banner fallbacks', async () => {
    const bridge = installControllerBridge();
    const { result } = await renderControllerHarness(bridge);
    const task = (id: string, updatedAt: string) => ({
      id, source: 'automation', title: id, status: 'running', statusUpdates: [],
      relatedEntity: { kind: 'automation-run', id }, createdAt: updatedAt, updatedAt,
    });
    act(() => bridge.emit('onBackgroundTaskUpdated', { task: task('older', '2026-08-01') }));
    act(() => bridge.emit('onBackgroundTaskUpdated', { task: task('newer', '2026-08-03') }));
    act(() => bridge.emit('onBackgroundTaskUpdated', { task: task('older', '2026-08-04') }));
    expect(result.current.backgroundTasks.map((entry) => entry.id)).toEqual(['older', 'newer']);

    act(() => bridge.emit('onRuntimeStatusChanged', { appId: 'planner', status: 'running', localNetworkShare: { active: true, appId: 'planner', connectedAt: '2026-08-10' } }));
    expect(result.current.bannerSeverity).toBe('success');
    act(() => bridge.emit('onRuntimeStatusChanged', { appId: 'planner', status: 'error' }));
    expect(result.current.bannerSeverity).toBe('error');
    act(() => bridge.emit('onRuntimeStatusChanged', { appId: 'planner', status: 'installed' }));
    expect(result.current.bannerSeverity).toBe('info');
  });

  it('preserves hydrated automation-task history when the first live update arrives', async () => {
    const existing = {
      id: 'automation:run-1', source: 'automation', title: 'Daily', status: 'running',
      statusUpdates: [{ message: 'Already working', status: 'running', createdAt: '2026-08-09' }],
      relatedEntity: { kind: 'automation-run', id: 'run-1', secondaryId: 'automation-1' },
      createdAt: '2026-08-09', updatedAt: '2026-08-09',
    };
    const bridge = installControllerBridge({ backgroundTasksList: [existing], backgroundTasksUpsert: undefined });
    await renderControllerHarness(bridge);
    act(() => bridge.emit('onAutomationUpdated', {
      automation: { id: 'automation-1', name: 'Daily', enabled: true, selectedAppIds: [], createdAt: '2026-08-09', updatedAt: '2026-08-10' },
      run: { id: 'run-1', automationId: 'automation-1', status: 'running', userMessage: 'Still working', startedAt: '2026-08-09', updatedAt: '2026-08-10' },
    }));
    await waitFor(() => expect(bridge.call('backgroundTasksUpsert')).toHaveBeenCalled());
    expect(bridge.call('backgroundTasksUpsert')).toHaveBeenLastCalledWith(expect.objectContaining({
      createdAt: '2026-08-09',
      statusUpdates: expect.arrayContaining([expect.objectContaining({ message: 'Already working' })]),
    }));
  });

  it('skips a repeated startup update check and tolerates authenticated forum and update failures', async () => {
    window.localStorage.setItem('forger-desktop-startup-update-check-v1', new Date().toISOString().slice(0, 10));
    const bridge = installControllerBridge({
      getForgerAccount: { authenticated: true, user: { id: 1, email: 'user@example.com', confirmed: true } },
      getForumParticipation: () => Promise.reject(new Error('forum offline')),
      checkDesktopUpdates: () => Promise.reject(new Error('update offline')),
    });
    await renderControllerHarness(bridge);
    expect(bridge.call('checkDesktopUpdates')).not.toHaveBeenCalled();
  });

  it('selects the first installed data app and recovers reactive backup, secret, detail, and gate loads', async () => {
    const bridge = installControllerBridge({
      listInstalledApps: [{ id: 'planner', name: 'Planner', category: 'productivity', status: 'running' }],
      listBackups: () => Promise.reject(new Error('backups offline')),
      listUserSecrets: () => Promise.reject(new Error('secrets offline')),
      getAppDetails: { app: { id: 'planner', name: 'Planner', category: 'productivity', status: 'not_installed' }, installed: false, status: 'not_installed', operations: [] },
      getAppToolsInstallGate: () => Promise.reject(new Error('gate offline')),
    });
    const { result } = await renderControllerHarness(bridge);
    act(() => result.current.setCurrentView('datos'));
    await waitFor(() => expect(result.current.selectedDataAppId).toBe('planner'));
    act(() => result.current.setCurrentView('backups'));
    await waitFor(() => expect(result.current.bannerSeverity).toBe('error'));
    act(() => result.current.setCurrentView('secrets'));
    await waitFor(() => expect(result.current.bannerMessage).toBe('No pudimos cargar tus secretos.'));
    await act(async () => result.current.openAppDetails('planner'));
    expect(result.current.selectedAppDetails?.installed).toBe(false);
  });
});
