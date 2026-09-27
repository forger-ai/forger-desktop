/** Normalized collaboration state. Task history survives unlinking a repository. */
export const COLLABORATION_SCHEMA = `
PRAGMA foreign_keys=ON;
PRAGMA journal_mode=WAL;

CREATE TABLE IF NOT EXISTS collaboration_groups (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  title TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  activated_at INTEGER,
  UNIQUE(connection_id, chat_id)
);
CREATE TABLE IF NOT EXISTS collaboration_repositories (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES collaboration_groups(id),
  name TEXT NOT NULL,
  root TEXT NOT NULL,
  removed INTEGER NOT NULL DEFAULT 0,
  UNIQUE(group_id, id)
);
CREATE TABLE IF NOT EXISTS collaboration_participants (
  group_id TEXT NOT NULL REFERENCES collaboration_groups(id),
  participant_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  PRIMARY KEY(group_id, participant_id)
);
CREATE TABLE IF NOT EXISTS collaboration_grants (
  group_id TEXT NOT NULL,
  participant_id TEXT NOT NULL,
  repository_id TEXT NOT NULL,
  PRIMARY KEY(group_id, participant_id, repository_id),
  FOREIGN KEY(group_id, participant_id) REFERENCES collaboration_participants(group_id, participant_id),
  FOREIGN KEY(group_id, repository_id) REFERENCES collaboration_repositories(group_id, id)
);
CREATE TABLE IF NOT EXISTS collaboration_receipts (
  connection_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  PRIMARY KEY(connection_id, chat_id, message_id, sender_id)
);
CREATE TABLE IF NOT EXISTS collaboration_tasks (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES collaboration_groups(id),
  participant_id TEXT NOT NULL,
  participant_name TEXT NOT NULL,
  prompt TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  source_message_id TEXT NOT NULL,
  parent_task_id TEXT,
  conversation_id TEXT,
  result TEXT,
  error_code TEXT,
  UNIQUE(group_id, id),
  FOREIGN KEY(group_id, parent_task_id) REFERENCES collaboration_tasks(group_id, id)
);
CREATE TABLE IF NOT EXISTS collaboration_task_repositories (
  task_id TEXT NOT NULL,
  repository_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  PRIMARY KEY(task_id, repository_id),
  FOREIGN KEY(group_id, task_id) REFERENCES collaboration_tasks(group_id, id),
  FOREIGN KEY(group_id, repository_id) REFERENCES collaboration_repositories(group_id, id)
);
CREATE TABLE IF NOT EXISTS collaboration_outbox (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES collaboration_groups(id),
  task_id TEXT,
  participant_id TEXT NOT NULL,
  text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  message_id TEXT,
  reply_to_message_id TEXT,
  FOREIGN KEY(group_id, task_id) REFERENCES collaboration_tasks(group_id, id)
);
CREATE INDEX IF NOT EXISTS collaboration_tasks_queue ON collaboration_tasks(status, created_at);
CREATE INDEX IF NOT EXISTS collaboration_outbox_pending ON collaboration_outbox(status);
`;
