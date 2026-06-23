export const CHROME_EXTENSION_TOOL_ID = 'forger_chrome_extension';
export const CHROME_EXTENSION_NATIVE_HOST_NAME = 'com.forger.chrome_extension';
export const CHROME_EXTENSION_DEV_ID = 'kidpoeebnnmcdiodakpdedmebbfhnaba';
export const CHROME_EXTENSION_DEFAULT_TIMEOUT_MS = 10_000;
export const CHROME_EXTENSION_MAX_WAIT_TIMEOUT_MS = 60_000;
export const CHROME_EXTENSION_WAIT_COMMAND_TIMEOUT_PADDING_MS = 5_000;

export type ChromeExtensionChannel = 'dev' | 'production';

export interface ChromeExtensionSession {
  sessionId: string;
  windowId: number;
  tabId: number;
  extensionChannel: ChromeExtensionChannel;
  createdAt: string;
  updatedAt: string;
}

export interface ChromeExtensionConnectionStatus {
  configured: boolean;
  connected: boolean;
  activeChannel: ChromeExtensionChannel | null;
  connectedExtensions: Array<{
    extensionId: string;
    channel: ChromeExtensionChannel;
    connectedAt: string;
    lastHeartbeatAt: string;
  }>;
  devExtensionId: string;
  productionExtensionId: string | null;
  nativeHostName: string;
  nativeHostManifestPath?: string;
  sessions: ChromeExtensionSession[];
}

export interface ChromeExtensionCommandEnvelope {
  requestId: string;
  action: string;
  sessionId?: string;
  payload?: Record<string, unknown>;
}

export interface ChromeExtensionCommandResponse {
  requestId: string;
  success: boolean;
  data?: unknown;
  error?: {
    message?: string;
    code?: string;
  };
}

export interface ChromeExtensionNativeMessage {
  type?: string;
  requestId?: string;
  action?: string;
  sessionId?: string;
  payload?: Record<string, unknown>;
  success?: boolean;
  data?: unknown;
  error?: {
    message?: string;
    code?: string;
  };
  extensionId?: string;
  channel?: ChromeExtensionChannel;
}
