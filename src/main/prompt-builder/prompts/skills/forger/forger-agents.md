---
name: forger-agents
description: Use when designing, reviewing, or explaining app-declared conversational agents for advisors, reviewers, orchestrators, specialists, resume flows, or multi-turn app work.
---

- App agents are app-declared coworkers that can hold a conversation, resume prior context, and keep working with the person over multiple turns.
- Use them when an app needs an advisor, reviewer, orchestrator, or specialist that benefits from ongoing chat state.
- Use `forger-manifest-authoring` when writing the exact `manifest.json` shape for agents.
- Choose `permissionMode` consciously for each app agent. Use `"safe"` unless that agent has a concrete need for elevated filesystem access.
- Keep the final product behavior clear: what the agent helps with, what inputs it expects, and what result it should produce.
