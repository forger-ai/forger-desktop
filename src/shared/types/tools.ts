import type { AppAgent, AppPromptTemplate } from './prompts';
import type { PlatformCapabilities } from '../platform-capabilities';

export type AgentToolId =
  | 'forger_list_catalog'
  | 'forger_list_installed_apps'
  | 'forger_check_updates'
  | 'forger_create_app'
  | 'forger_add_app_to_personal_agent'
  | 'forger_request_app_tool_grant'
  | 'forger_ask_question'
  | 'forger_list_app_prompts'
  | 'forger_test_app_prompt'
  | 'forger_update_app_prompt'
  | 'forger_restore_app_prompt'
  | 'memory_list'
  | 'memory_create'
  | 'memory_update'
  | 'memory_delete'
  | 'forger_speech_to_text_status'
  | 'forger_transcribe_audio'
  | 'forger_translate_audio'
  | 'forger_text_to_speech_status'
  | 'forger_text_to_speech_voices'
  | 'forger_synthesize_speech'
  | 'forger_get_app_runtime_status'
  | 'forger_open_app'
  | 'forger_stop_app'
  | 'forger_restart_app'
  | 'forger_refresh_app_view'
  | 'forger_update_app'
  | 'forger_finish_social_app_install'
  | 'forger_delete_quarantined_social_app'
  | 'gmail.connection.status'
  | 'gmail.search_messages'
  | 'gmail.read_thread'
  | 'gmail.read_attachment'
  | 'gmail.send_email'
  | 'forger_chrome_extension.connection.status'
  | 'forger_chrome_extension.open_dedicated_tab'
  | 'forger_chrome_extension.get_current_url'
  | 'forger_chrome_extension.navigate'
  | 'forger_chrome_extension.get_html'
  | 'forger_chrome_extension.wait_for_selector'
  | 'forger_chrome_extension.click'
  | 'forger_chrome_extension.focus'
  | 'forger_chrome_extension.hover'
  | 'forger_chrome_extension.input_text'
  | 'forger_chrome_extension.submit_form'
  | 'forger_chrome_extension.get_styles'
  | 'forger_chrome_extension.set_styles'
  | 'forger_chrome_extension.close_window'
  | 'forger_chrome_extension.close_session'
  | 'whatsapp.connection.status'
  | 'whatsapp.start_pairing'
  | 'whatsapp.list_chats'
  | 'whatsapp.read_messages'
  | 'whatsapp.download_attachment'
  | 'whatsapp.send_message'
  | 'whatsapp.get_chat_details'
  | 'workflow_get_context'
  | 'workflow_complete_node'
  | 'workflow_fail_node'
  | 'forger_workflow_list'
  | 'forger_workflow_get'
  | 'forger_workflow_upsert'
  | 'forger_workflow_run'
  | 'slack.connection.status'
  | 'slack.list_channels'
  | 'slack.read_messages'
  | 'slack.send_message'
  | 'trello.connection.status'
  | 'trello.list_boards'
  | 'trello.list_lists'
  | 'trello.list_cards'
  | 'trello.create_card';

export type AgentToolCategory = 'consulta' | 'app' | 'actualizacion' | 'vista' | 'memoria';

export type AgentToolRisk = 'bajo' | 'medio' | 'alto';

export interface AgentToolDefinition {
  id: AgentToolId;
  packageId: string;
  name: string;
  description: string;
  category: AgentToolCategory;
  risk: AgentToolRisk;
  defaultRequiresApproval: boolean;
}

export interface AgentToolPackageDefinition {
  id: string;
  name: string;
  description: string;
  icon: 'forger';
  tools: AgentToolDefinition[];
}

export type AgentToolApprovalSettings = Partial<Record<AgentToolId, boolean>>;

export interface AgentToolSettings {
  approvals: AgentToolApprovalSettings;
}

export interface UpdateAgentToolApprovalInput {
  toolId: AgentToolId;
  requiresApproval: boolean;
}

export type OfficialToolRuntime = 'node' | 'python' | 'builtin';

export type OfficialToolInstallState =
  | 'available'
  | 'installed'
  | 'configured'
  | 'error';

export type OfficialToolRisk = 'low' | 'medium' | 'high';

export interface OfficialToolActionDefinition {
  id: string;
  name: string;
  description: string;
  risk: OfficialToolRisk;
  inputSchema?: Record<string, unknown>;
}

export interface OfficialToolSecretDefinition {
  name: string;
  label: string;
  required: boolean;
  usage: string;
  /** True when the user provides this secret manually (local token connectors). */
  manual?: boolean;
}

export interface OfficialToolDefinition {
  id: string;
  name: string;
  description: string;
  version: string;
  runtime: OfficialToolRuntime;
  actions: OfficialToolActionDefinition[];
  secrets: OfficialToolSecretDefinition[];
  changelog?: string[];
  official: true;
}

export interface InstalledOfficialToolRecord {
  id: string;
  version: string;
  status: Exclude<OfficialToolInstallState, 'available'>;
  installDir?: string;
  configured: boolean;
  installedAt: string;
  updatedAt: string;
  error?: string;
  grantedAppIds?: string[];
}

export interface OfficialToolSummary extends OfficialToolDefinition {
  status: OfficialToolInstallState;
  installedVersion?: string;
  configured: boolean;
  error?: string;
}

export interface OfficialToolsState {
  tools: OfficialToolSummary[];
}

export type OfficialToolRuntimePhase =
  | 'starting'
  | 'connecting'
  | 'qr_available'
  | 'pairing_code_ready'
  | 'connected'
  | 'history_sync'
  | 'messages_ingested'
  | 'chats_ingested'
  | 'contacts_ingested'
  | 'sync_ready'
  | 'disconnected'
  | 'reconnecting'
  | 'stopped'
  | 'reset'
  | 'error';

export interface OfficialToolRuntimeEvent {
  toolId: string;
  phase: OfficialToolRuntimePhase;
  timestamp: string;
  message?: string;
  reason?: string;
  counts?: {
    messages?: number;
    chats?: number;
    contacts?: number;
    attachments?: number;
  };
  status?: {
    connected?: boolean;
    configured?: boolean;
    qrAvailable?: boolean;
    needsReconnect?: boolean;
    lastDisconnectReason?: string;
  };
}

export interface ToolMutationResult {
  success: boolean;
  userMessage: string;
  technicalCode?: string;
  tool?: OfficialToolSummary;
}

export interface ConfigureOfficialToolInput {
  toolId: string;
  locale?: string;
  /** Values for manual secrets declared by the tool, keyed by secret name. */
  secrets?: Record<string, string>;
}

export interface CallOfficialToolInput {
  toolId: string;
  actionId: string;
  input?: Record<string, unknown>;
}

export interface CallOfficialToolResult {
  success: boolean;
  userMessage?: string;
  technicalCode?: string;
  data?: unknown;
}

export interface AppToolDeclaration {
  toolId: string;
  actions: string[];
  reason: string;
}

export interface AppToolRequirementState {
  declaration: AppToolDeclaration;
  required: boolean;
  tool?: OfficialToolSummary;
  resolvedActions: OfficialToolActionDefinition[];
  allActions: boolean;
  granted: boolean;
  hasStoredGrant: boolean;
  available: boolean;
  configured: boolean;
}

export interface GetAppToolsInstallGateOptions {
  defaultOptionalGrants?: boolean;
}

export interface AppToolsInstallGate {
  appId: string;
  appName: string;
  platformCapabilities: PlatformCapabilities;
  required: AppToolRequirementState[];
  optional: AppToolRequirementState[];
  agents: AppAgent[];
  promptTemplates: AppPromptTemplate[];
  canInstall: boolean;
}

export interface SetAppToolGrantInput {
  appId: string;
  toolId: string;
  granted: boolean;
}

export interface AppToolGrantRequestPreview {
  success: boolean;
  userMessage: string;
  technicalCode?: string;
  appId: string;
  appName?: string;
  declaration?: AppToolDeclaration;
  tool?: OfficialToolSummary;
  alreadyGranted?: boolean;
  warning?: string;
}

export interface AppToolGrantRequestResult extends AppToolGrantRequestPreview {
  gate?: AppToolsInstallGate | null;
}
