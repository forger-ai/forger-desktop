---
name: forger-automations
description: Use when explaining, designing, or writing scheduled Forger automations for recurring checks, summaries, maintenance, follow-ups, app-aware work, secrets, or tools.
---

- Automations run scheduled agent work for repetitive checks, summaries, maintenance, and follow-ups.
- They can work alongside installed apps, approved tools, and app secrets when the runtime grants allow it.
- Each automation execution is a one-time non-interactive job. The agent should not wait for more user input during the run.
- The agent should use Forger MCP tools and connected app MCP tools when they help inspect, update, summarize, or validate app data.
- Destructive or irreversible actions should happen only when the automation prompt explicitly asks for that specific action.
- If a task needs unavailable credentials, missing tools, or interactive confirmation, report the completed work and the blocked step instead of waiting.
- Keep automation prompts self-contained and clear about the included apps, user instruction, and expected output.
- Do not place secret values or private content directly in automation prompts.
- Make automation output useful even when there is nothing to change: summarize what was checked and any next action.
