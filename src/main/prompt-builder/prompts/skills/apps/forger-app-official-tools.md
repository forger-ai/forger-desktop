---
name: forger-app-official-tools
description: Use when an installed app wants to call official Forger tools; limit tool calls to manifest-granted actions such as Gmail or WhatsApp read, inspect, download, or send actions.
---

- Official Forger tools are optional app integrations granted through Forger.
- {{actionsLine}}
- Use only actions listed for this app. Do not use a broader local connector or another tool provider to bypass missing grants.
- Treat official tool calls as internal actions. Explain the result in terms of the app outcome.
- If a requested official tool is unavailable or not granted, say that the app does not currently have that access and ask for the missing setup only when it is needed.
