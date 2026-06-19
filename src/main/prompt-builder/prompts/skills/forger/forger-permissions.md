---
name: forger-permissions
description: Use when official Forger tools, Gmail, file access, destructive actions, secrets, or app operations may require visible permission prompts or user approval.
---

- Forger, not Codex, owns visible approval for sensitive tools.
- `permissionMode` controls provider filesystem scope for a manifest-declared prompt template or app agent. It is separate from Forger-owned approvals.
- Folder grants are Forger-owned filesystem permissions. They are separate from `permissionMode`, official tools, app secrets, scripts, MCP tools, and app catalog copy.
- Apps that need external folders declare `platformCapabilities.workspaceFolders` with a real user-visible reason. That declaration only allows the app to ask Forger for grants; it does not authorize any folder by itself.
- A grant-aware prompt-template task or agent run should receive `workspace.cwdGrantId` for the approved working folder and `workspace.additionalFolderGrantIds` for extra approved folders. Treat these ids as permission handles. Apps may keep the returned full paths for display, saved workflow context, and prompt context, but raw paths are never the access authority and must not be used to bypass grant validation.
- App backends should request grants through the Desktop bridge helpers, rediscover approved grants through `list_folder_grants`, and revoke obsolete grants through `revoke_folder_grant`. Do not create custom filesystem approval records that skip Desktop's app-owned grant store.
- Legacy `workspace_path` inputs are limited to app-private workspace paths. Do not use `workspace_path` to smuggle access to folders outside the installed app.
- Desktop Chat network access is a Desktop setting. Do not infer chat internet access from app manifests.
- Elevated permissions do not bypass Forger MCP approvals, Gmail grants, secret handling, destructive-action confirmations, or tool allowlists.
- Use `permissionMode: "safe"` by default in manifests. Use `"unsafe"` only for a concrete task or agent that needs broad filesystem access and explain the user-visible reason.
- When a Forger tool returns a permission denial, cancellation, or unavailable approval result, do not retry through another connector.
- Continue only after the Forger MCP broker reports that approval was granted.
- Explain permission outcomes in user-facing language.
