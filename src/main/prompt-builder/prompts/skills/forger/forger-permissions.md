---
name: forger-permissions
description: Use when official Forger tools, Gmail, file access, destructive actions, secrets, or app operations may require visible permission prompts or user approval.
---

- Forger, not Codex, owns visible approval for sensitive tools.
- `permissionMode` controls provider filesystem scope for a manifest-declared prompt template or app agent. It is separate from Forger-owned approvals.
- Elevated permissions do not bypass Forger MCP approvals, Gmail grants, secret handling, destructive-action confirmations, or tool allowlists.
- Use `permissionMode: "safe"` by default in manifests. Use `"unsafe"` only for a concrete task or agent that needs broad filesystem access and explain the user-visible reason.
- When a Forger tool returns a permission denial, cancellation, or unavailable approval result, do not retry through another connector.
- Continue only after the Forger MCP broker reports that approval was granted.
- Explain permission outcomes in user-facing language.
