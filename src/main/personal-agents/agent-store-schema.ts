import { PERSONAL_AGENT_ROUTINE_SCHEMA_SQL } from './agent-store-routines';

export const PERSONAL_AGENT_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS personal_agents (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    purpose TEXT NOT NULL DEFAULT '',
    instructions TEXT NOT NULL DEFAULT '',
    permission_mode TEXT NOT NULL DEFAULT 'safe',
    network_access INTEGER NOT NULL DEFAULT 0,
    runtime_provider TEXT,
    runtime_model TEXT,
    runtime_effort TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS personal_agent_permissions (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES personal_agents(id) ON DELETE CASCADE,
    kind TEXT NOT NULL DEFAULT 'legacy',
    target_id TEXT NOT NULL DEFAULT '',
    permission TEXT NOT NULL,
    mode TEXT NOT NULL DEFAULT 'safe',
    granted INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(agent_id, kind, target_id)
  );
  CREATE TABLE IF NOT EXISTS personal_agent_conversations (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES personal_agents(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    origin TEXT NOT NULL DEFAULT 'user',
    read_only INTEGER NOT NULL DEFAULT 0,
    initiator_agent_id TEXT REFERENCES personal_agents(id) ON DELETE SET NULL,
    peer_thread_id TEXT,
    routine_id TEXT,
    sidekick_id TEXT,
    draft_message TEXT NOT NULL DEFAULT '',
    provider TEXT,
    provider_thread_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_personal_agent_conversations_agent ON personal_agent_conversations(agent_id, updated_at);
  CREATE TABLE IF NOT EXISTS personal_agent_messages (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES personal_agents(id) ON DELETE CASCADE,
    conversation_id TEXT NOT NULL REFERENCES personal_agent_conversations(id) ON DELETE CASCADE,
    run_id TEXT REFERENCES personal_agent_runs(id) ON DELETE SET NULL,
    role TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'message',
    author_type TEXT NOT NULL DEFAULT 'human',
    author_agent_id TEXT REFERENCES personal_agents(id) ON DELETE SET NULL,
    source TEXT NOT NULL DEFAULT 'human',
    routine_id TEXT,
    wakeup_id TEXT,
    source_locale TEXT,
    content TEXT NOT NULL,
    reasoning TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_personal_agent_messages_conversation ON personal_agent_messages(conversation_id, created_at);
  CREATE TABLE IF NOT EXISTS personal_agent_message_files (
    id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL REFERENCES personal_agent_messages(id) ON DELETE CASCADE,
    agent_id TEXT NOT NULL REFERENCES personal_agents(id) ON DELETE CASCADE,
    conversation_id TEXT NOT NULL REFERENCES personal_agent_conversations(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    path TEXT NOT NULL,
    relative_path TEXT NOT NULL,
    size_bytes INTEGER,
    source TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_personal_agent_message_files_message ON personal_agent_message_files(message_id, created_at);
  CREATE TABLE IF NOT EXISTS personal_agent_peer_grants (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES personal_agents(id) ON DELETE CASCADE,
    peer_agent_id TEXT NOT NULL REFERENCES personal_agents(id) ON DELETE CASCADE,
    criteria TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(agent_id, peer_agent_id)
  );
  CREATE INDEX IF NOT EXISTS idx_personal_agent_peer_grants_agent ON personal_agent_peer_grants(agent_id, updated_at);
  CREATE TABLE IF NOT EXISTS personal_agent_peer_threads (
    id TEXT PRIMARY KEY,
    caller_agent_id TEXT NOT NULL REFERENCES personal_agents(id) ON DELETE CASCADE,
    target_agent_id TEXT NOT NULL REFERENCES personal_agents(id) ON DELETE CASCADE,
    source_conversation_id TEXT NOT NULL REFERENCES personal_agent_conversations(id) ON DELETE CASCADE,
    target_conversation_id TEXT NOT NULL REFERENCES personal_agent_conversations(id) ON DELETE CASCADE,
    parent_thread_id TEXT REFERENCES personal_agent_peer_threads(id) ON DELETE SET NULL,
    root_thread_id TEXT REFERENCES personal_agent_peer_threads(id) ON DELETE SET NULL,
    created_by_run_id TEXT REFERENCES personal_agent_runs(id) ON DELETE SET NULL,
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(target_conversation_id)
  );
  CREATE INDEX IF NOT EXISTS idx_personal_agent_peer_threads_source ON personal_agent_peer_threads(source_conversation_id, updated_at);
  CREATE INDEX IF NOT EXISTS idx_personal_agent_peer_threads_target ON personal_agent_peer_threads(target_agent_id, updated_at);
  CREATE INDEX IF NOT EXISTS idx_personal_agent_peer_threads_parent ON personal_agent_peer_threads(parent_thread_id, updated_at);
  CREATE INDEX IF NOT EXISTS idx_personal_agent_peer_threads_root ON personal_agent_peer_threads(root_thread_id, updated_at);
  CREATE TABLE IF NOT EXISTS personal_agent_runs (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES personal_agents(id) ON DELETE CASCADE,
    conversation_id TEXT NOT NULL REFERENCES personal_agent_conversations(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'queued',
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_personal_agent_runs_conversation ON personal_agent_runs(conversation_id, updated_at);
  CREATE TABLE IF NOT EXISTS personal_agent_run_progress (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES personal_agents(id) ON DELETE CASCADE,
    conversation_id TEXT NOT NULL REFERENCES personal_agent_conversations(id) ON DELETE CASCADE,
    run_id TEXT NOT NULL REFERENCES personal_agent_runs(id) ON DELETE CASCADE,
    message TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_personal_agent_run_progress_run ON personal_agent_run_progress(run_id, created_at);
  ${PERSONAL_AGENT_ROUTINE_SCHEMA_SQL}
  CREATE TABLE IF NOT EXISTS personal_agent_memories (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES personal_agents(id) ON DELETE CASCADE,
    remember_when TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS personal_agent_journal_entries (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES personal_agents(id) ON DELETE CASCADE,
    conversation_id TEXT REFERENCES personal_agent_conversations(id) ON DELETE SET NULL,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
`;
