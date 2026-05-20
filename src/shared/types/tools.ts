import type { AppAgent, AppPromptTemplate } from './prompts';

export type AgentToolId =
  | 'forger_list_catalog'
  | 'forger_list_installed_apps'
  | 'forger_check_updates'
  | 'forger_list_app_prompts'
  | 'forger_update_app_prompt'
  | 'forger_restore_app_prompt'
  | 'memory_list'
  | 'memory_create'
  | 'memory_update'
  | 'memory_delete'
  | 'forger_get_app_runtime_status'
  | 'forger_open_app'
  | 'forger_stop_app'
  | 'forger_restart_app'
  | 'forger_refresh_app_view'
  | 'forger_update_app'
  | 'gmail.connection.status'
  | 'gmail.search_messages'
  | 'gmail.read_thread'
  | 'gmail.read_attachment'
  | 'gmail.send_email'
  | 'meta.connection.status'
  | 'meta.list_pages'
  | 'meta.list_lead_forms'
  | 'meta.sync_leads'
  | 'meta.get_lead';

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

export type AgentToolApprovalSettings = Record<AgentToolId, boolean>;

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

export interface ToolMutationResult {
  success: boolean;
  userMessage: string;
  technicalCode?: string;
  tool?: OfficialToolSummary;
}

export interface ConfigureOfficialToolInput {
  toolId: string;
  locale?: string;
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
  granted: boolean;
  available: boolean;
  configured: boolean;
}

export interface AppToolsInstallGate {
  appId: string;
  appName: string;
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
