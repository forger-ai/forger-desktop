import type { BrowserWindow } from 'electron';

import type {
  AgentToolSettings,
  AppCodexConversationEvent,
  AppCodexTaskEvent,
  CatalogApp,
  ChatCreatedAppRequest,
  ChatQuestion,
  ChatQuestionRequest,
} from '../../shared/types';
import type { DesktopErrorReporter } from '../error-reporting';
import type { StoredForgerAccount } from '../forger-account-store';
import type { SelfOAuthCallbackServiceLike } from '../oauth-callback/types';
import type { SpeechToTextServiceManager } from '../speech-to-text-service';
import type { TextToSpeechServiceManager } from '../text-to-speech-service';
import type { WakeWordServiceManager } from '../wake-word-service';
import type { AppRegistry } from './main-process-types';

export type ServiceConstructor<T = unknown> = new (...args: any[]) => T;
export type AsyncFn<T = unknown> = (...args: any[]) => Promise<T>;
export type SyncFn<T = unknown> = (...args: any[]) => T;
export type ToolAccess = { appId: string; caller: string; locale?: string };
export type PermissionDecision = unknown;
export type PermissionRequest = unknown;
export type ForgerMcpSessionOptions = { caller: string; appIds: string[]; locale?: string };
export type RunEventLike = {
  run: { status: string; appId: string; runId: string; errorCode?: string; userMessage?: string };
};
export type TaskEventLike = AppCodexTaskEvent;
export type ConversationEventLike = AppCodexConversationEvent;
export type LlmRunsService = {
  recordChatRunEvent: (event: any, context?: { appName?: string }) => unknown;
  recordAppAgentConversationEvent: (event: ConversationEventLike, context?: { appName?: string }) => unknown;
  recordAppPromptTaskEvent: (event: TaskEventLike, context?: { appName?: string }) => unknown;
  recordWorkflowNodeActivity: (activity: any, context?: { appName?: string }) => unknown;
};
export type AutomationEventLike = {
  automation: { id: string; selectedAppIds: string[] };
  run?: { id: string; status?: string; error?: unknown; userMessage?: string };
  diagnosticTranscript?: string;
};
export type ForgerMcpToolFailure = { appId: string; runId: string; toolName?: unknown; error: unknown };
export type ForgerMcpHttpFailure = { error: unknown; appId?: string; runId?: string };

export interface LifecycleService {
  [key: string]: any;
}

export interface MemoryMaintenanceService {
  initialize: () => Promise<void>;
  dispose: () => void;
}

export interface ChatOrchestratorService extends LifecycleService {
  recordCreatedAppFromMcp: (runId: string, createdApp: ChatCreatedAppRequest) => void;
  registerQuestionFromMcp: (
    runId: string,
    input: { questions: ChatQuestion[] },
  ) => Promise<ChatQuestionRequest>;
}

export type ServiceWithLoad<T> = Omit<LifecycleService, 'load'> & { load: () => Promise<T> };

export interface MainLifecycleState {
  agentToolSettings: AgentToolSettings;
  appAgentConversationManager: LifecycleService | null;
  appAgentTaskManager: LifecycleService | null;
  appMcpManager: LifecycleService | null;
  automationManager: LifecycleService | null;
  workflowManager: LifecycleService | null;
  catalogApps: CatalogApp[];
  chatOrchestrator: ChatOrchestratorService | null;
  cloudDeviceManager: LifecycleService | null;
  cloudIdentityStore: LifecycleService | null;
  connectionsService: LifecycleService | null;
  desktopErrorReporter: DesktopErrorReporter | null;
  desktopRuntimeBridge: LifecycleService | null;
  devCatalogService: LifecycleService | null;
  fileLibrary: (LifecycleService & { cleanupStagedFilesForChat?: () => Promise<void> }) | null;
  forgerAccount: StoredForgerAccount;
  forgerAccountStore: ServiceWithLoad<StoredForgerAccount> | null;
  forgerBackendClient: LifecycleService | null;
  forgerMcpServer: LifecycleService | null;
  localCatalogJsonUrl: string | undefined;
  localNetworkShareManager: { stopAll?: () => Promise<void> } | null;
  llmRunsStore?: LlmRunsService;
  remoteNetworkShareManager: { stopAll?: () => Promise<void> } | null;
  remoteAgentSessionService: { stopAll?: () => Promise<void> } | null;
  mainWindow: BrowserWindow | null;
  memoryMaintenanceManager: MemoryMaintenanceService | null;
  memoryStore: LifecycleService | null;
  officialToolsService: LifecycleService | null;
  selfOAuthCallbackService: SelfOAuthCallbackServiceLike | null;
  speechToTextService: SpeechToTextServiceManager | null;
  textToSpeechService: TextToSpeechServiceManager | null;
  wakeWordService: WakeWordServiceManager | null;
  pendingDeepLink: unknown;
  pendingDeepLinkFlushScheduled: boolean;
  registry: AppRegistry;
  secretsStore: LifecycleService | null;
}
