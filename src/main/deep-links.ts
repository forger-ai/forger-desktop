/**
 * Deep-link support for the `forger://` URL scheme.
 *
 * Apps installed in Forger Desktop run inside their own BrowserWindow
 * with no IPC bridge to the main Desktop window. The deep-link gives
 * them (and any external trigger) a one-way way to "request something"
 * from the host: open the chat, prefill a message, focus a tab, etc.
 *
 * Today we only handle `forger://chat`, but the parser is intentionally
 * generic so adding `forger://app/<id>` or similar later is a small
 * addition rather than a redesign.
 *
 * Supported URLs:
 *   forger://chat                          → open global chat
 *   forger://chat?app=pyme-os              → open the chat scoped to an
 *                                            installed app
 *   forger://chat?app=pyme-os&prompt=<text>
 *                                          → also prefill the composer
 *                                            with the given text
 *
 * `app` accepts the app's manifest name (`pyme-os`) — the renderer
 * resolves it against the installed list (preferring `<name>-dev` when
 * the dev install is present).
 */

import { app, BrowserWindow } from 'electron';
import path from 'node:path';

export const FORGER_PROTOCOL = 'forger';

export type ForgerDeepLink =
  | {
      kind: 'chat';
      app: string | null;
      prompt: string | null;
      raw: string;
    }
  | {
      kind: 'social-app';
      code: string | null;
      id: number | null;
      raw: string;
    }
  | {
      kind: 'social-profile';
      username: string;
      raw: string;
    }
  | {
      kind: 'unknown';
      raw: string;
    };

/**
 * Parse a `forger://...` URL into a structured payload, or `null` if
 * the URL is not a Forger deep-link.
 */
export const parseForgerUrl = (rawUrl: string): ForgerDeepLink | null => {
  if (typeof rawUrl !== 'string') return null;
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== `${FORGER_PROTOCOL}:`) {
    return null;
  }
  // For URLs of the form `forger://chat?...` Node's URL parser puts
  // `chat` into the host, with `pathname` being empty. For
  // `forger://chat/foo` it goes to host + pathname. We normalise.
  const path = (parsed.host || '').toLowerCase().trim();
  if (path === 'chat') {
    return {
      kind: 'chat',
      app: parsed.searchParams.get('app')?.trim() || null,
      prompt: parsed.searchParams.get('prompt'),
      raw: rawUrl,
    };
  }
  if (path === 'social') {
    const action = parsed.pathname.replace(/^\/+/, '').toLowerCase();
    if (action === 'app') {
      const code = parsed.searchParams.get('code')?.trim();
      const idRaw = parsed.searchParams.get('id')?.trim();
      const id = idRaw && /^\d+$/.test(idRaw) ? Number(idRaw) : null;
      if (!code && !id) {
        return { kind: 'unknown', raw: rawUrl };
      }
      return {
        kind: 'social-app',
        code: code || null,
        id,
        raw: rawUrl,
      };
    }
    if (action === 'profile') {
      const username = parsed.searchParams.get('username')?.trim();
      if (!username) {
        return { kind: 'unknown', raw: rawUrl };
      }
      return {
        kind: 'social-profile',
        username,
        raw: rawUrl,
      };
    }
  }
  return { kind: 'unknown', raw: rawUrl };
};

/**
 * Pick the most likely Forger deep-link out of a process argv array.
 * Returns `null` when no candidate is found. Used both for the cold
 * boot (`process.argv`) and the single-instance re-entry payload.
 */
export const extractDeepLinkFromArgv = (argv: readonly string[]): ForgerDeepLink | null => {
  for (const arg of argv) {
    if (typeof arg !== 'string') continue;
    if (!arg.startsWith(`${FORGER_PROTOCOL}://`)) continue;
    const parsed = parseForgerUrl(arg);
    if (parsed) return parsed;
  }
  return null;
};

/**
 * Register `forger://` so the OS routes URLs to this process. Safe to
 * call multiple times. The dev-mode variant points at the Electron dev
 * binary + the current entry script, which is what Electron expects to
 * relaunch the dev app for protocol activations.
 */
export const registerForgerProtocol = (): void => {
  if (process.defaultApp) {
    // Running via `electron .` (dev). Pass the resolved entry script
    // so the relaunch invocation matches what the user typed.
    const entry = process.argv[1];
    if (entry) {
      app.setAsDefaultProtocolClient(FORGER_PROTOCOL, process.execPath, [
        path.resolve(entry),
      ]);
      return;
    }
  }
  app.setAsDefaultProtocolClient(FORGER_PROTOCOL);
};

/**
 * Bring `targetWindow` to the foreground. Restores minimised windows,
 * brings the app forward on macOS, and respects multi-display setups.
 */
export const focusWindow = (targetWindow: BrowserWindow | null): void => {
  if (!targetWindow || targetWindow.isDestroyed()) return;
  if (targetWindow.isMinimized()) targetWindow.restore();
  targetWindow.show();
  targetWindow.focus();
  if (process.platform === 'darwin') {
    app.focus({ steal: true });
  }
};
