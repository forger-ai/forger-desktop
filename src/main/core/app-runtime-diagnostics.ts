import type { BrowserWindow } from 'electron';
import fs from 'node:fs/promises';
import { join } from 'node:path';

import type { RuntimeStatus } from '../../shared/types';
import type { RunningAppProcess } from './main-process-types';

interface AppRuntimeDiagnosticsDeps {
  appWindows: Map<string, BrowserWindow>;
  runningApps: Map<string, RunningAppProcess>;
  getForgerMetadataRoot: () => string;
  getRuntimeStatus: (appId: string) => RuntimeStatus;
  serializeErrorForInstallLog: (error: unknown) => Record<string, unknown>;
}

export const createAppRuntimeDiagnostics = ({
  appWindows,
  runningApps,
  getForgerMetadataRoot,
  getRuntimeStatus,
  serializeErrorForInstallLog,
}: AppRuntimeDiagnosticsDeps) => {
  const getAppViewSnapshot = async (
    appId: string,
    input: { selector?: string; includeHtml?: boolean; maxChars?: number },
  ): Promise<Record<string, unknown>> => {
    const appWindow = appWindows.get(appId);
    if (!appWindow || appWindow.isDestroyed()) {
      return {
        success: false,
        appId,
        userMessage: 'La app no esta abierta en Forger.',
        technicalCode: 'app_window_not_open',
      };
    }
    const snapshotInput = {
      selector: typeof input.selector === 'string' && input.selector.trim() ? input.selector.trim() : 'body',
      includeHtml: input.includeHtml === true,
      maxChars: clampNumber(input.maxChars, 12000, 1000, 50000),
    };
    try {
      const snapshot = await appWindow.webContents.executeJavaScript(`
        (() => {
          const input = ${JSON.stringify(snapshotInput)};
          const truncate = (value, max) => {
            const text = String(value || '').replace(/\\s+/g, ' ').trim();
            return text.length > max ? text.slice(0, max) + '...' : text;
          };
          let element = null;
          try {
            element = document.querySelector(input.selector);
          } catch (error) {
            return {
              success: false,
              selector: input.selector,
              userMessage: 'El selector de la vista no es valido.',
              technicalCode: 'app_view_selector_invalid',
              error: error instanceof Error ? error.message : String(error),
            };
          }
          const rect = element ? element.getBoundingClientRect() : null;
          const style = element ? window.getComputedStyle(element) : null;
          const activeElement = document.activeElement;
          return {
            success: true,
            url: window.location.href,
            title: document.title,
            readyState: document.readyState,
            viewport: {
              width: window.innerWidth,
              height: window.innerHeight,
              devicePixelRatio: window.devicePixelRatio,
            },
            selector: input.selector,
            found: Boolean(element),
            visible: Boolean(
              rect
              && rect.width > 0
              && rect.height > 0
              && style
              && style.display !== 'none'
              && style.visibility !== 'hidden'
              && Number(style.opacity || '1') !== 0
            ),
            rect: rect ? {
              x: Math.round(rect.x),
              y: Math.round(rect.y),
              width: Math.round(rect.width),
              height: Math.round(rect.height),
            } : null,
            text: element ? truncate(element.innerText || element.textContent || '', input.maxChars) : '',
            html: input.includeHtml && element ? truncate(element.outerHTML || '', input.maxChars) : undefined,
            activeElement: activeElement ? {
              tagName: activeElement.tagName,
              id: activeElement.id || '',
              className: typeof activeElement.className === 'string' ? activeElement.className : '',
              text: truncate(activeElement.textContent || '', 500),
            } : null,
          };
        })()
      `, true) as Record<string, unknown>;
      return {
        success: snapshot.success !== false,
        appId,
        snapshot,
      };
    } catch (error) {
      return {
        success: false,
        appId,
        userMessage: 'No se pudo leer la vista de la app en Forger.',
        ...serializeErrorForInstallLog(error),
        technicalCode: 'app_view_snapshot_failed',
      };
    }
  };

  const getAppRuntimeDiagnostics = async (
    appId: string,
    input: { recentLines?: number },
  ): Promise<Record<string, unknown>> => {
    const appWindow = appWindows.get(appId);
    const running = runningApps.get(appId);
    const recentLines = clampNumber(input.recentLines, 80, 10, 200);
    const logsDirectory = join(getForgerMetadataRoot(), 'logs');
    const desktopLogPath = join(logsDirectory, 'forger-desktop.jsonl');
    const appWindowState = appWindow && !appWindow.isDestroyed()
      ? {
          open: true,
          url: appWindow.webContents.getURL(),
          title: appWindow.webContents.getTitle(),
          loading: appWindow.webContents.isLoading(),
        }
      : { open: false };

    return {
      success: true,
      appId,
      status: getRuntimeStatus(appId),
      appWindow: appWindowState,
      runningProcess: running
        ? {
            backendPid: running.backend.pid,
            frontendPid: running.frontend.pid,
            backendUrl: running.backendUrl,
            frontendUrl: running.frontendUrl,
            locale: running.locale,
          }
        : null,
      logsDirectory,
      logs: [
        await readRecentLogLines(desktopLogPath, appId, recentLines),
      ],
    };
  };

  return {
    getAppRuntimeDiagnostics,
    getAppViewSnapshot,
  };
};

const clampNumber = (value: unknown, fallback: number, min: number, max: number): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.floor(value)));
};

const redactLogLine = (line: string): string => line
  .replace(/((?:authorization|token|secret|password|api[_-]?key)\s*[:=]\s*)("[^"]+"|'[^']+'|[^\s,}]+)/gi, '$1[redacted]')
  .slice(0, 4000);

const readRecentLogLines = async (filePath: string, appId: string, recentLines: number): Promise<Record<string, unknown>> => {
  try {
    const stat = await fs.stat(filePath);
    const maxBytes = 256 * 1024;
    const start = Math.max(0, stat.size - maxBytes);
    const length = stat.size - start;
    const handle = await fs.open(filePath, 'r');
    try {
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, start);
      const text = buffer.toString('utf8');
      const lines = text
        .split(/\r?\n/)
        .filter((line) => line.includes(appId))
        .slice(-recentLines)
        .map(redactLogLine);
      return {
        path: filePath,
        available: true,
        scannedTailBytes: length,
        lines,
      };
    } finally {
      await handle.close();
    }
  } catch (error) {
    return {
      path: filePath,
      available: false,
      technicalCode: (error as { code?: string })?.code ?? 'log_read_failed',
    };
  }
};
