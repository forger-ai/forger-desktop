import { act, render, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Sidebar } from '@renderer/components/Sidebar';
import { en } from '@renderer/i18n/en';
import type { AppDictionary } from '@renderer/i18n';
import type { WindowControlState } from '@shared/types';

vi.hoisted(() => {
  Object.defineProperty(navigator, 'platform', { configurable: true, value: 'MacIntel' });
});

const t = en as unknown as AppDictionary;
const windowed: WindowControlState = { isMaximized: false, isFullScreen: false, usesCustomFrame: false };
const fullScreen: WindowControlState = { ...windowed, isFullScreen: true };

const installForger = (getWindowState: ReturnType<typeof vi.fn>) => {
  let listener: ((state: WindowControlState) => void) | undefined;
  const removeListener = vi.fn();
  const api = {
    getWindowState,
    onWindowStateChanged: vi.fn((next: (state: WindowControlState) => void) => {
      listener = next;
      return removeListener;
    }),
    getAgentProviderUsage: vi.fn().mockResolvedValue({ success: true, checkedAt: '2026-08-10T10:00:00.000Z', providers: [] }),
  };
  Object.defineProperty(window, 'forger', { configurable: true, value: api });
  return { api, removeListener, emit: (state: WindowControlState) => listener?.(state) };
};

const renderSidebar = () => render(
  <Sidebar
    currentView="apps"
    onNavigate={vi.fn()}
    t={t}
    desktopUpdateState={{ status: 'idle', currentVersion: '1.0.0' }}
    pinnedViews={[]}
    workflowsEnabled={false}
    showForumNav={false}
  />,
);

describe('Sidebar macOS window spacing', () => {
  it('tracks full-screen changes and removes the desktop listener', async () => {
    const desktop = installForger(vi.fn().mockResolvedValue(windowed));
    const view = renderSidebar();
    await waitFor(() => expect(desktop.api.getWindowState).toHaveBeenCalledOnce());
    await act(async () => desktop.emit(fullScreen));
    view.unmount();
    expect(desktop.removeListener).toHaveBeenCalledOnce();
  });

  it('ignores an unavailable initial window state', async () => {
    const desktop = installForger(vi.fn().mockRejectedValue(new Error('window unavailable')));
    renderSidebar();
    await waitFor(() => expect(desktop.api.getWindowState).toHaveBeenCalledOnce());
  });

  it('does not update state after unmounting during the initial read', async () => {
    const deferred = Promise.withResolvers<WindowControlState>();
    const desktop = installForger(vi.fn().mockReturnValue(deferred.promise));
    const view = renderSidebar();
    view.unmount();
    deferred.resolve(windowed);
    await deferred.promise;
    expect(desktop.removeListener).toHaveBeenCalledOnce();
  });
});
