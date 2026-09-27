import type { PersonalAgentWhatsAppChannelPolicy } from '../../../shared/types/whatsapp-agent-channel';
import type { SqliteDatabase } from '../sqlite';
import type { WhatsAppAgentBindingKey } from './types';
const args = (key: WhatsAppAgentBindingKey) => [key.connectionId, key.chatId, key.agentId];
export class WhatsAppChannelPolicyStore {
  constructor(private readonly db: SqliteDatabase) {
    db.exec(`CREATE TABLE IF NOT EXISTS whatsapp_agent_policy_grants (
      connection_id TEXT NOT NULL,chat_id TEXT NOT NULL,agent_id TEXT NOT NULL,
      category TEXT NOT NULL,value TEXT NOT NULL,detail TEXT NOT NULL DEFAULT '',
      PRIMARY KEY(connection_id,chat_id,agent_id,category,value,detail),
      FOREIGN KEY(connection_id,chat_id,agent_id) REFERENCES whatsapp_agent_bindings ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS whatsapp_agent_policy_files (
      connection_id TEXT NOT NULL,chat_id TEXT NOT NULL,agent_id TEXT NOT NULL,
      file_id TEXT NOT NULL,file_path TEXT NOT NULL,file_name TEXT,
      PRIMARY KEY(connection_id,chat_id,agent_id,file_id),
      FOREIGN KEY(connection_id,chat_id,agent_id) REFERENCES whatsapp_agent_bindings ON DELETE CASCADE);`);
  }
  put(key: WhatsAppAgentBindingKey, policy: PersonalAgentWhatsAppChannelPolicy): void {
    this.db
      .prepare('DELETE FROM whatsapp_agent_policy_grants WHERE connection_id=? AND chat_id=? AND agent_id=?')
      .run(...args(key));
    this.db
      .prepare('DELETE FROM whatsapp_agent_policy_files WHERE connection_id=? AND chat_id=? AND agent_id=?')
      .run(...args(key));
    const insert = this.db.prepare('INSERT OR IGNORE INTO whatsapp_agent_policy_grants VALUES(?,?,?,?,?,?)');
    const add = (category: string, value: string, detail = '') => insert.run(...args(key), category, value, detail);
    for (const [category, values] of [
      ['app', policy.appIds],
      ['tool', policy.toolIds],
      ['peer', policy.peerAgentIds],
      ['memory', policy.sharedMemoryIds],
    ] as const) {
      for (const value of values) add(category, value);
    }
    if (policy.networkAccess) add('network', 'enabled');
    for (const grant of policy.connectionGrants) {
      for (const action of grant.actions) add('action', grant.type, action);
      if (grant.multiple) add('multiple', grant.type);
      if (grant.connectionIds) {
        add('scoped_accounts', grant.type);
        for (const id of grant.connectionIds) add('account', grant.type, id);
      }
    }
    for (const file of policy.sharedFiles ?? []) {
      if (!file.id) throw new Error('whatsapp_agent_shared_file_id_required');
      this.db
        .prepare('INSERT INTO whatsapp_agent_policy_files VALUES(?,?,?,?,?,?)')
        .run(...args(key), file.id, file.path, file.name ?? null);
    }
  }
  get(key: WhatsAppAgentBindingKey): PersonalAgentWhatsAppChannelPolicy {
    const rows = this.db
      .prepare(
        'SELECT category,value,detail FROM whatsapp_agent_policy_grants WHERE connection_id=? AND chat_id=? AND agent_id=?',
      )
      .all(...args(key)) as Array<{ category: string; value: string; detail: string }>;
    const values = (category: string) => rows.filter((r) => r.category === category).map((r) => r.value);
    const types = [...new Set(values('action'))];
    const files = this.db
      .prepare(
        'SELECT file_id,file_path,file_name FROM whatsapp_agent_policy_files WHERE connection_id=? AND chat_id=? AND agent_id=?',
      )
      .all(...args(key)) as Array<{ file_id: string; file_path: string; file_name: string | null }>;
    return {
      appIds: values('app'),
      toolIds: values('tool') as PersonalAgentWhatsAppChannelPolicy['toolIds'],
      peerAgentIds: values('peer'),
      sharedMemoryIds: values('memory'),
      networkAccess: values('network').includes('enabled'),
      connectionGrants: types.map((type) => ({
        type: type as PersonalAgentWhatsAppChannelPolicy['connectionGrants'][number]['type'],
        actions: rows.filter((r) => r.category === 'action' && r.value === type).map((r) => r.detail),
        multiple: values('multiple').includes(type),
        ...(values('scoped_accounts').includes(type)
          ? { connectionIds: rows.filter((r) => r.category === 'account' && r.value === type).map((r) => r.detail) }
          : {}),
      })),
      sharedFiles: files.map((f) => ({
        id: f.file_id,
        path: f.file_path,
        ...(f.file_name ? { name: f.file_name } : {}),
      })),
    };
  }
}
