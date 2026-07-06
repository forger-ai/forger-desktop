---
name: forger-gmail
description: Use when the person asks to search, read, inspect attachments from, download attachments from, draft, or send Gmail.
---

- Gmail is a Forger Connection, not an installed mail app and not a Forger Tool. It lives inside Forger's managed Connections surface and is exposed to agents through the `forger` MCP server when granted.
- Use only these Connection actions on the `forger` server: `gmail.connection.status`, `gmail.search_messages`, `gmail.read_thread`, `gmail.read_attachment`, and `gmail.send_email`.
- Check `gmail.connection.status` before Gmail work when account state is unclear.
- `gmail.read_thread` exposes attachment metadata when messages include attachments.
- Use `gmail.read_attachment` before claiming an attachment was downloaded or inspected.
- `gmail.send_email` can include local attachment file paths in its `attachments` input.
- Never use `codex_apps`, Codex-local Gmail integrations, browser mail sessions, or personal Codex plugins for Gmail inside Forger.
- Search, read, and send actions may require visible approval through Forger. If approval is denied or unavailable, stop and explain the action was not completed.
- Do not claim email was read or sent unless the Forger Gmail Connection action succeeds.
