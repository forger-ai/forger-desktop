---
name: forger-app-agents-authoring
description: Use when creating or updating app-owned AGENTS.md files from verified UI, manifest, scripts, tools, models, services, routes, skills, limits, and current capabilities.
---

- Start from current app facts: real UI, manifest, scripts, tools, models, services, routes, and existing skills.
- Describe current capabilities only. Do not present planned or imagined features as available.
- Keep the file app-specific. Avoid a generic Forger introduction unless the app is distributed as a Forger app and that fact matters to the app contract.
- Separate user-visible capabilities from internal agent tools.
- Document what must not be assumed when the app could be confused with a broader product category.
- Keep turn-specific tone, response language, and one-off task instructions out of app `AGENTS.md`; those belong in the message that starts the task or agent run.
- When an app documents a visible model, provider, or effort selector for prompt-template tasks or manifest-agent runs, verify that its manifest declares `platformCapabilities.agentRuntimeControl` and state that dynamic runtime selection is limited to supported Desktop runtimes. Without that capability, app-owned `AGENTS.md` must describe the configured app agent behavior, not per-request runtime overrides.
- Mention internal files, scripts, commands, or paths only when they are necessary for agent operation.
- When the app has structured tools for data access, document that those tools are preferred before scripts or direct data edits.
- When changing an existing app-owned `AGENTS.md`, preserve true app facts and remove stale or unverified claims.
