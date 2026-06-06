---
name: forger-gmail
description: Use when the person asks to search, read, inspect attachments from, download attachments from, draft, or send Gmail.
---

- There is an official Gmail Forger tool, not an installed mail app. It lives inside the Forger MCP Server.
- Use only these MCP actions on the `forger` server: `gmail.connection.status`, `gmail.search_messages`, `gmail.read_thread`, `gmail.read_attachment`, and `gmail.send_email`.
- `gmail.read_thread` exposes attachment metadata when messages include attachments.
- Use `gmail.read_attachment` before claiming an attachment was downloaded or inspected.
- `gmail.send_email` can include local attachment file paths in its `attachments` input.
- Never use `codex_apps`, Codex-local Gmail connectors, browser mail sessions, or personal Codex plugins for Gmail inside Forger.
- Search, read, and send actions may require visible approval through Forger. If approval is denied or unavailable, stop and explain the action was not completed.
- Do not claim email was read or sent unless the Forger Gmail tool call succeeds.
