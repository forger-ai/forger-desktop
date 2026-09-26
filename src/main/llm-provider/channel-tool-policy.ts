/**
 * A channel never inherits a desktop user's ambient filesystem or plugins.
 * Codex's filesystem profile is an allowlist, enforced by its tool runtime;
 * disabling shell alone does not remove apply_patch. The profile therefore
 * remains required even with native read/exec tools disabled.
 */
export const codexChannelToolArgs = (workingDir: string): string[] => {
  const disabled = ['shell_tool', 'view_image', 'js_repl', 'multi_agent', 'multi_agent_v2', 'plugins', 'apps', 'memories', 'request_permissions_tool'];
  return [
    ...disabled.flatMap(feature => ['--config', `features.${feature}=false`]),
    '--config', 'web_search="disabled"',
    '--config', 'approval_policy="never"',
    '--config', 'default_permissions="forger_channel"',
    '--config', `permissions.forger_channel.filesystem={":minimal"="read",${JSON.stringify(workingDir)}="write"}`,
    '--config', 'permissions.forger_channel.network.enabled=false',
    '--config', 'project_doc_max_bytes=0',
  ];
};
