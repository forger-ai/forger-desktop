---
name: forger-official-tools
description: Use when operating Forger Tools, Connections, installed app lifecycle actions, app prompt actions, Forger Chrome Extension actions, or platform actions without non-Forger fallbacks.
---

- Forger Tools and Connections are exposed through the `forger` MCP server for agents.
- Forger Tools are platform-owned actions such as app lifecycle tools, prompt/app creation tools, Memory, Workflows, and the Forger Chrome Extension.
- Connections are external accounts, workspaces, services, or device sessions such as Gmail, Google Calendar, Google Sheets, Google Drive, Google Docs, GitHub, Notion, WhatsApp, Slack, and Trello.
- Do not use Codex-local integrations, `codex_apps`, provider-native tools, or non-Forger MCP servers to bypass missing Forger access.
- Use `forger_create_app` only after you have clarified the app direction. The tool creates the skeleton-based app workspace; continue design and implementation in the same chat after it succeeds.
- Personal agents can use `forger_add_app_to_personal_agent` after creating or selecting an installed app that should stay in that agent's configuration for future runs.
- Use `forger_ask_question` only after reasoning through the request and identifying material uncertainty that should not be inferred. The tool does not replace your visible reply; after calling it, write a concise user-facing message asking the person to answer.
- For installed apps, "open", "launch", "start", "run", or "bring up" means use the Forger app tools. Use `forger_open_app` to open the app and `forger_get_app_runtime_status` when you need to check whether Forger has it running.
- For Connection actions, check the matching `*.connection.status` action before account work when availability or selected account/session state is unclear.
- If multiple accounts or sessions are possible and the request does not identify which one to use, ask the person to choose instead of guessing.
- For Chrome browser control, use only the `forger_chrome_extension.*` tools on the `forger` MCP server. Start with `forger_chrome_extension.connection.status` when availability is unclear. Use `forger_chrome_extension.open_dedicated_tab` before session-scoped actions, then use the returned session id for navigation, HTML inspection, selector waits, click, focus, hover, text input, form submit, style inspection, temporary visual highlighting, URL reads, and close.
- Use `forger_chrome_extension.set_styles` only for temporary visual highlighting or restoring selected elements with allowed CSS properties. Do not use it to hide content, bypass page UI, or make persistent page changes. Treat `forger_chrome_extension.submit_form` as sensitive because it can send data or trigger remote changes.
- The Forger Chrome Extension is a Forger Tool for a dedicated Chrome window. It is not an installed app, not a generic browser plugin, and not a non-Forger browser integration.
- App backends call granted Forger Tool and Connection actions through the signed Desktop runtime bridge helpers in `commons/backend/forger_desktop.py`. Agents use MCP; app services use the backend helper. Both paths must respect the app's manifest declarations, grants, and declared action ids.
- Do not manually start app services with Python, uvicorn, npm, Vite, FastAPI, or localhost commands just so the person can access the app. The user-facing action is opening the app in Forger.
- Treat tool names, MCP server names, action ids, and internal paths as implementation details unless the person asks for technical details.
- If a Forger Tool or Connection is unavailable, explain the missing user-facing setup or permission step in simple language.
