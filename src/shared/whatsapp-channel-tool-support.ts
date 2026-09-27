import { CONNECTION_ACTION_PREFIXES } from './connection-catalog';

/** Platform operations with an explicit, bounded contract for a shared chat. */
const SUPPORTED_PLATFORM_TOOLS = new Set([
  'forger_list_catalog',
  'forger_list_installed_apps',
  'forger_list_app_prompts',
  'forger_test_app_prompt',
  'forger_get_app_runtime_status',
  'forger_get_app_view_snapshot',
  'forger_get_app_runtime_diagnostics',
  'forger_open_app',
  'forger_stop_app',
  'forger_restart_app',
  'forger_refresh_app_view',
  'forger_list_agent_peers',
  'forger_ask_agent',
  'forger_read_agent_thread',
  'forger_connection_list',
  'forger_connection_status',
]);

export const isWhatsAppChannelToolSupported = (tool: string): boolean =>
  SUPPORTED_PLATFORM_TOOLS.has(tool)
  || tool.startsWith('forger_chrome_extension.')
  || Object.keys(CONNECTION_ACTION_PREFIXES).some(prefix => tool.startsWith(prefix));
