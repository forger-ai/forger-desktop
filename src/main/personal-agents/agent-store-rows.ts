export interface AgentRow {
  id: string;
  name: string;
  description: string;
  purpose: string;
  instructions: string;
  permission_mode: string;
  network_access: number;
  runtime_provider?: string | null;
  runtime_model?: string | null;
  runtime_effort?: string | null;
  created_at: string;
  updated_at: string;
}

export interface PermissionRow {
  id: string;
  agent_id: string;
  kind?: string;
  target_id?: string;
  permission: string;
  mode: string;
  granted: number;
  created_at: string;
  updated_at: string;
}

export interface ConversationRow {
  id: string;
  agent_id: string;
  title: string;
  status: string;
  origin?: string;
  read_only?: number;
  initiator_agent_id?: string | null;
  peer_thread_id?: string | null;
  routine_id?: string | null;
  sidekick_id?: string | null;
  draft_message?: string | null;
  provider_thread_id?: string | null;
  provider?: string | null;
  created_at: string;
  updated_at: string;
}

export interface MessageRow {
  id: string;
  agent_id: string;
  conversation_id: string;
  run_id: string | null;
  role: string;
  kind: string;
  author_type?: string | null;
  author_agent_id?: string | null;
  source?: string | null;
  routine_id?: string | null;
  wakeup_id?: string | null;
  source_locale?: string | null;
  content: string;
  created_at: string;
}

export interface MessageFileRow {
  id: string;
  message_id: string;
  agent_id: string;
  conversation_id: string;
  name: string;
  path: string;
  relative_path: string;
  size_bytes: number | null;
  source: string | null;
  created_at: string;
}

export interface PeerGrantRow {
  id: string;
  agent_id: string;
  peer_agent_id: string;
  criteria: string;
  created_at: string;
  updated_at: string;
  peer_name?: string | null;
  peer_description?: string | null;
}

export interface PeerThreadRow {
  id: string;
  caller_agent_id: string;
  target_agent_id: string;
  source_conversation_id: string;
  target_conversation_id: string;
  parent_thread_id: string | null;
  root_thread_id: string | null;
  created_by_run_id: string | null;
  title: string;
  status: string;
  created_at: string;
  updated_at: string;
  caller_name?: string | null;
  target_name?: string | null;
}

export interface RunRow {
  id: string;
  agent_id: string;
  conversation_id: string;
  status: string;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface RunProgressRow {
  id: string;
  agent_id: string;
  conversation_id: string;
  run_id: string;
  message: string;
  created_at: string;
}

export interface MemoryRow {
  id: string;
  agent_id: string;
  remember_when: string;
  title: string;
  content: string;
  created_at: string;
  updated_at: string;
}

export interface JournalEntryRow {
  id: string;
  agent_id: string;
  conversation_id: string | null;
  body: string;
  created_at: string;
}
