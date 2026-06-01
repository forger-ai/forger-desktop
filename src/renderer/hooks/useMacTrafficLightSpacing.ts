import type { WindowControlState } from '@shared/types';
import { useEffect, useState } from 'react';

const isMacOs = navigator.platform.toLowerCase().includes('mac');

export function useMacTrafficLightSpacing() {
  const [windowState, setWindowState] = useState<WindowControlState | null>(null);

  useEffect(() => {
    if (!isMacOs) {
      return undefined;
    }

    let mounted = true;
    const desktopApi = window.forger;

    void desktopApi
      .getWindowState()
      .then((state) => {
        if (mounted) {
          setWindowState(state);
        }
      })
      .catch(() => undefined);

    const removeListener = desktopApi.onWindowStateChanged((state) => {
      setWindowState(state);
    });

    return () => {
      mounted = false;
      removeListener();
    };
  }, []);

  return isMacOs && !windowState?.isFullScreen;
}
