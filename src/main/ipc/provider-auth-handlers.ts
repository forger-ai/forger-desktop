import type fs from 'node:fs/promises';
import type path from 'node:path';
import type { BrowserWindow, IpcMain, Shell } from 'electron';
import type { IPC_CHANNELS as IpcChannels } from '../../shared/ipc';
import type {
  AntigravityAuthStatus,
  ClaudeAuthStatus,
  CodexAuthStatus,
  FailureDiagnosticFields,
  SetActiveLlmProviderProfileInput,
  UpdateLlmProviderProfileDefaultsInput,
} from '../../shared/types';
import { appendDesktopLog } from '../desktop-logger';
import { readClaudeOAuthToken } from '../claude-oauth';
import { getAgentProviderUsageSafely } from '../provider-usage';

interface ProviderAuthHandlersOptions {
  IPC_CHANNELS: typeof IpcChannels;
  CODEX_USAGE_DASHBOARD_URL: string;
  fs: typeof fs;
  ipcMain: IpcMain;
  path: typeof path;
  shell: Shell;
  getMainWindow: () => BrowserWindow | null;
  getForgerMetadataRoot: () => string;
  getCodexAuthStatus: () => Promise<CodexAuthStatus>;
  getClaudeAuthStatus: () => Promise<ClaudeAuthStatus>;
  getAntigravityAuthStatus: () => Promise<AntigravityAuthStatus>;
  listLlmProviderProfiles: () => Promise<unknown>;
  setActiveLlmProviderProfile: (input: SetActiveLlmProviderProfileInput) => Promise<unknown>;
  updateLlmProviderProfileDefaults: (input: UpdateLlmProviderProfileDefaultsInput) => Promise<unknown>;
  connectCodexAuth: () => Promise<unknown>;
  disconnectCodexAuth: () => Promise<unknown>;
  reinstallCodex: () => Promise<unknown>;
  confirmClaudeAuthConnection: () => Promise<unknown>;
  connectClaudeAuth: () => Promise<unknown>;
  disconnectClaudeAuth: () => Promise<unknown>;
  signOutClaudeAuth: () => Promise<unknown>;
  reinstallClaude: () => Promise<unknown>;
  connectAntigravityAuth: () => Promise<unknown>;
  startAntigravityAuthSession: (onEvent: (event: unknown) => void) => Promise<unknown>;
  writeAntigravityAuthSession: (sessionId: string, input: string) => Promise<unknown>;
  cancelAntigravityAuthSession: (sessionId: string) => Promise<unknown>;
  disconnectAntigravityAuth: () => Promise<unknown>;
  reinstallAntigravity: () => Promise<unknown>;
  failureDiagnostic: (error: unknown, fallbackCode: string) => FailureDiagnosticFields;
}

export const registerProviderAuthIpcHandlers = ({
  IPC_CHANNELS,
  CODEX_USAGE_DASHBOARD_URL,
  fs,
  ipcMain,
  path,
  shell,
  getMainWindow,
  getForgerMetadataRoot,
  getCodexAuthStatus,
  getClaudeAuthStatus,
  getAntigravityAuthStatus,
  listLlmProviderProfiles,
  setActiveLlmProviderProfile,
  updateLlmProviderProfileDefaults,
  connectCodexAuth,
  disconnectCodexAuth,
  reinstallCodex,
  confirmClaudeAuthConnection,
  connectClaudeAuth,
  disconnectClaudeAuth,
  signOutClaudeAuth,
  reinstallClaude,
  connectAntigravityAuth,
  startAntigravityAuthSession,
  writeAntigravityAuthSession,
  cancelAntigravityAuthSession,
  disconnectAntigravityAuth,
  reinstallAntigravity,
  failureDiagnostic,
}: ProviderAuthHandlersOptions): void => {
  ipcMain.handle(IPC_CHANNELS.getAgentProviderUsage, async () => await getAgentProviderUsageSafely({
    fs,
    path,
    codexUsageDashboardUrl: CODEX_USAGE_DASHBOARD_URL,
    getCodexAuthStatus,
    getClaudeAuthStatus,
    getAntigravityAuthStatus,
    failureDiagnostic,
    readClaudeOAuthToken,
    appendLog: async (event, context) => {
      await appendDesktopLog({
        metadataRoot: getForgerMetadataRoot(),
        service: 'agent-runtime',
        event,
        context,
      });
    },
  }));
  ipcMain.handle(IPC_CHANNELS.listLlmProviderProfiles, async () => await listLlmProviderProfiles());
  ipcMain.handle(IPC_CHANNELS.setActiveLlmProviderProfile, async (_event, input: SetActiveLlmProviderProfileInput) =>
    await setActiveLlmProviderProfile(input));
  ipcMain.handle(IPC_CHANNELS.updateLlmProviderProfileDefaults, async (_event, input: UpdateLlmProviderProfileDefaultsInput) =>
    await updateLlmProviderProfileDefaults(input));
  ipcMain.handle(IPC_CHANNELS.getCodexAuthStatus, async () => await getCodexAuthStatus());
  ipcMain.handle(IPC_CHANNELS.openCodexUsageDashboard, async () => {
    try {
      await shell.openExternal(CODEX_USAGE_DASHBOARD_URL);
      return { success: true };
    } catch (error) {
      return { success: false, ...failureDiagnostic(error, 'open_codex_usage_failed'), userMessage: 'No pudimos abrir el panel de uso de Codex.' };
    }
  });
  ipcMain.handle(IPC_CHANNELS.connectCodexAuth, async () => await connectCodexAuth());
  ipcMain.handle(IPC_CHANNELS.disconnectCodexAuth, async () => await disconnectCodexAuth());
  ipcMain.handle(IPC_CHANNELS.reinstallCodex, async () => await reinstallCodex());
  ipcMain.handle(IPC_CHANNELS.getClaudeAuthStatus, async () => await getClaudeAuthStatus());
  ipcMain.handle(IPC_CHANNELS.confirmClaudeAuthConnection, async () => await confirmClaudeAuthConnection());
  ipcMain.handle(IPC_CHANNELS.connectClaudeAuth, async () => await connectClaudeAuth());
  ipcMain.handle(IPC_CHANNELS.disconnectClaudeAuth, async () => await disconnectClaudeAuth());
  ipcMain.handle(IPC_CHANNELS.signOutClaudeAuth, async () => await signOutClaudeAuth());
  ipcMain.handle(IPC_CHANNELS.reinstallClaude, async () => await reinstallClaude());
  ipcMain.handle(IPC_CHANNELS.getAntigravityAuthStatus, async () => await getAntigravityAuthStatus());
  ipcMain.handle(IPC_CHANNELS.connectAntigravityAuth, async () => await connectAntigravityAuth());
  ipcMain.handle(IPC_CHANNELS.startAntigravityAuthSession, async () => await startAntigravityAuthSession((event) => {
    getMainWindow()?.webContents.send(IPC_CHANNELS.antigravityAuthSessionEvent, event);
  }));
  ipcMain.handle(IPC_CHANNELS.writeAntigravityAuthSession, async (_event, input: { sessionId?: unknown; input?: unknown }) => {
    if (typeof input?.sessionId !== 'string' || typeof input?.input !== 'string') {
      return { success: false, userMessage: 'Invalid Antigravity auth input.', technicalCode: 'invalid_antigravity_auth_input' };
    }
    return await writeAntigravityAuthSession(input.sessionId, input.input);
  });
  ipcMain.handle(IPC_CHANNELS.cancelAntigravityAuthSession, async (_event, sessionId: unknown) => {
    if (typeof sessionId !== 'string') {
      return { success: false, userMessage: 'Invalid Antigravity auth session.', technicalCode: 'invalid_antigravity_auth_session' };
    }
    return await cancelAntigravityAuthSession(sessionId);
  });
  ipcMain.handle(IPC_CHANNELS.disconnectAntigravityAuth, async () => await disconnectAntigravityAuth());
  ipcMain.handle(IPC_CHANNELS.reinstallAntigravity, async () => await reinstallAntigravity());
};
