import type { AgentDefaults, AgentModelOptions } from './agent-runtime';
import type { AppAgent } from './prompts';
import type { AppAiSubscriptionStatus } from './runtime';
import type { AppExternalFolderSelection } from './data';
import type { OfficialToolSummary, CallOfficialToolInput, CallOfficialToolResult } from './tools';
import type { CloudMessage, CloudSendMessageInput } from './social';
import type { AppAgentThreadCreateInput, AppAgentThreadSummary, AppAgentThreadRunStartInput, AppAgentRunSummary, AppAgentThreadRunControlInput, AppAgentThreadRunSteerInput, AppAgentThreadSteerResult, AppAgentThreadEvent, AppManifestAgentStartInput, AppManifestAgentResumeInput, AppManifestAgentSteerInput, AppManifestAgentStopInput, AppCodexTaskStartInput, AppCodexTaskSummary, AppCodexTaskEvent, AppCodexConversationCreateInput, AppCodexConversation, AppCodexConversationSendMessageInput, AppCodexConversationEvent } from './app-agents';

export interface ForgerAppApi {
  getContext: () => Promise<{
    locale?: string;
    agents?: AppAgent[];
    agentModelOptions?: AgentModelOptions;
    agentDefaults?: AgentDefaults;
  }>;
  getAiSubscriptionStatus: () => Promise<AppAiSubscriptionStatus>;
  selectExternalFolder: () => Promise<AppExternalFolderSelection>;
  tools: {
    listAvailable: () => Promise<OfficialToolSummary[]>;
    getStatus: (toolId: string) => Promise<OfficialToolSummary | null>;
    call: (input: CallOfficialToolInput) => Promise<CallOfficialToolResult>;
  };
  messages: {
    sendMessage: (input: CloudSendMessageInput) => Promise<CloudMessage>;
    listMessages: (friendUserId: number) => Promise<CloudMessage[]>;
    onMessage: (listener: (message: CloudMessage) => void) => () => void;
  };
  agentRuns: {
    /** @deprecated Use forgerApp.agents.start/resume/steer/stop with manifest-declared prompts. */
    createAgentThread: (input: AppAgentThreadCreateInput) => Promise<AppAgentThreadSummary>;
    /** @deprecated Use forgerApp.agents.resume with manifest-declared prompts. */
    startAgentThreadRun: (input: AppAgentThreadRunStartInput) => Promise<AppAgentRunSummary>;
    getAgentThread: (desktopThreadId: string) => Promise<AppAgentThreadSummary | null>;
    getAgentRun: (desktopThreadId: string, desktopRunId: string) => Promise<AppAgentRunSummary | null>;
    /** @deprecated Use forgerApp.agents.stop. */
    cancelAgentThreadRun: (input: AppAgentThreadRunControlInput) => Promise<{ success: boolean }>;
    /** @deprecated Use forgerApp.agents.steer with manifest-declared prompts. */
    steerAgentThreadRun: (input: AppAgentThreadRunSteerInput) => Promise<AppAgentThreadSteerResult>;
    onAgentThreadEvent: (listener: (event: AppAgentThreadEvent) => void) => () => void;
  };
  agents: {
    start: (input: AppManifestAgentStartInput) => Promise<AppAgentThreadSummary>;
    resume: (input: AppManifestAgentResumeInput) => Promise<AppAgentRunSummary>;
    steer: (input: AppManifestAgentSteerInput) => Promise<AppAgentThreadSteerResult>;
    stop: (input: AppManifestAgentStopInput) => Promise<{ success: boolean }>;
    getThread: (threadId: string) => Promise<AppAgentThreadSummary | null>;
    getRun: (threadId: string, runId: string) => Promise<AppAgentRunSummary | null>;
    onEvent: (listener: (event: AppAgentThreadEvent) => void) => () => void;
  };
  startAgentTask: (input: AppCodexTaskStartInput) => Promise<AppCodexTaskSummary>;
  getAgentTask: (runId: string) => Promise<AppCodexTaskSummary | null>;
  cancelAgentTask: (runId: string) => Promise<{ success: boolean }>;
  onAgentTaskUpdated: (listener: (event: AppCodexTaskEvent) => void) => () => void;
  createAgentConversation: (input?: AppCodexConversationCreateInput) => Promise<AppCodexConversation>;
  sendAgentConversationMessage: (input: AppCodexConversationSendMessageInput) => Promise<AppCodexConversation>;
  getAgentConversation: (conversationId: string) => Promise<AppCodexConversation | null>;
  listAgentConversations: () => Promise<AppCodexConversation[]>;
  deleteAgentConversation: (conversationId: string) => Promise<{ success: boolean }>;
  cancelAgentConversationRun: (
    conversationId: string,
    runId: string,
  ) => Promise<{ success: boolean }>;
  onAgentConversationEvent: (listener: (event: AppCodexConversationEvent) => void) => () => void;
  approveAgentTaskPermission: (
    runId: string,
    requestId: string,
    decision: 'allow' | 'deny',
  ) => Promise<{ success: boolean }>;
  approveAgentConversationPermission: (
    conversationId: string,
    runId: string,
    requestId: string,
    decision: 'allow' | 'deny',
  ) => Promise<{ success: boolean }>;
  startCodexTask: (input: AppCodexTaskStartInput) => Promise<AppCodexTaskSummary>;
  getCodexTask: (runId: string) => Promise<AppCodexTaskSummary | null>;
  cancelCodexTask: (runId: string) => Promise<{ success: boolean }>;
  onCodexTaskUpdated: (listener: (event: AppCodexTaskEvent) => void) => () => void;
  createCodexConversation: (input?: AppCodexConversationCreateInput) => Promise<AppCodexConversation>;
  sendCodexConversationMessage: (input: AppCodexConversationSendMessageInput) => Promise<AppCodexConversation>;
  getCodexConversation: (conversationId: string) => Promise<AppCodexConversation | null>;
  listCodexConversations: () => Promise<AppCodexConversation[]>;
  deleteCodexConversation: (conversationId: string) => Promise<{ success: boolean }>;
  cancelCodexConversationRun: (
    conversationId: string,
    runId: string,
  ) => Promise<{ success: boolean }>;
  onCodexConversationEvent: (listener: (event: AppCodexConversationEvent) => void) => () => void;
  approveCodexTaskPermission: (
    runId: string,
    requestId: string,
    decision: 'allow' | 'deny',
  ) => Promise<{ success: boolean }>;
  approveCodexConversationPermission: (
    conversationId: string,
    runId: string,
    requestId: string,
    decision: 'allow' | 'deny',
  ) => Promise<{ success: boolean }>;
}
