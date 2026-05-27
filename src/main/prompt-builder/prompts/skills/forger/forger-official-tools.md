---
name: forger-official-tools
description: Use when operating Forger-owned MCP tools for apps, prompts, memory, installed app lifecycle, Gmail, or official platform actions without Codex-local connector fallbacks.
---

- Official tools live on the `forger` MCP server.
- Do not use Codex-local connectors, `codex_apps`, or non-Forger MCP servers for official Forger actions.
- For installed apps, "open", "launch", "start", "run", or "bring up" means use the Forger app tools. Use `forger_open_app` to open the app and `forger_get_app_runtime_status` when you need to check whether Forger has it running.
- Do not manually start app services with Python, uvicorn, npm, Vite, FastAPI, or localhost commands just so the person can access the app. The user-facing action is opening the app in Forger.
- Treat tool names, MCP server names, and internal paths as implementation details unless the person asks for technical details.
- If a tool is unavailable, explain the missing user-facing setup step in simple language.
