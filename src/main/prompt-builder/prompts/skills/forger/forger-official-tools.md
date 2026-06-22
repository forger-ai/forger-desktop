---
name: forger-official-tools
description: Use when operating Forger-owned MCP tools for apps, prompts, installed app lifecycle, Gmail, WhatsApp, Forger Chrome Extension, or official platform actions without Codex-local connector fallbacks.
---

- Official tools live on the `forger` MCP server.
- Do not use Codex-local connectors, `codex_apps`, or non-Forger MCP servers for official Forger actions.
- Use `forger_create_app` only after you have clarified the app direction. The tool creates the skeleton-based app workspace; continue design and implementation in the same chat after it succeeds.
- Use `forger_ask_question` only after reasoning through the request and identifying material uncertainty that should not be inferred. The tool does not replace your visible reply; after calling it, write a concise user-facing message asking the person to answer.
- For installed apps, "open", "launch", "start", "run", or "bring up" means use the Forger app tools. Use `forger_open_app` to open the app and `forger_get_app_runtime_status` when you need to check whether Forger has it running.
- For Chrome browser control, use only the `forger_chrome_extension.*` tools on the `forger` MCP server. Start with `forger_chrome_extension.connection.status` when availability is unclear. Use `forger_chrome_extension.open_dedicated_tab` before session-scoped actions, then use the returned session id for navigation, HTML inspection, click, focus, hover, text input, form submit, style inspection, temporary visual highlighting, URL reads, and close.
- Use `forger_chrome_extension.set_styles` only for temporary visual highlighting or restoring selected elements with allowed CSS properties. Do not use it to hide content, bypass page UI, or make persistent page changes. Treat `forger_chrome_extension.submit_form` as sensitive because it can send data or trigger remote changes.
- The Forger Chrome Extension is an official Forger bridge for a dedicated Chrome window. It is not an installed app, not a generic browser plugin, and not a Codex-local Chrome connector.
- App backends that need official tools call the signed Desktop runtime bridge through `commons/backend/forger_desktop.py`. Agents use MCP; app services use the backend helper. Both paths must respect the app's official tool grants and declared action ids.
- Do not manually start app services with Python, uvicorn, npm, Vite, FastAPI, or localhost commands just so the person can access the app. The user-facing action is opening the app in Forger.
- Treat tool names, MCP server names, and internal paths as implementation details unless the person asks for technical details.
- If a tool is unavailable, explain the missing user-facing setup step in simple language.
