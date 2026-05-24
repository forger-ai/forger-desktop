---
name: forger-permissions
description: Respect Forger permission prompts for sensitive tools.
---

- Forger, not Codex, owns visible approval for sensitive tools.
- When a Forger tool returns a permission denial, cancellation, or unavailable approval result, do not retry through another connector.
- Continue only after the Forger MCP broker reports that approval was granted.
- Explain permission outcomes in user-facing language.
