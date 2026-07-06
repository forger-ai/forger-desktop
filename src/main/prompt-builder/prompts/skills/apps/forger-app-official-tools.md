---
name: forger-app-official-tools
description: Use when an installed app wants to call manifest-granted Forger Tool or registered Connection actions such as Forger Chrome Extension browser-control actions or external account/workspace actions.
---

- Forger Tools are platform-owned actions. Connections are external accounts, workspaces, services, or sessions.
- {{actionsLine}}
- App backends call granted Forger Tool and Connection actions through the signed Desktop runtime bridge helper in `commons/backend/forger_desktop.py`. Do not call Desktop directly from frontend code and do not expose runtime secrets.
- Use only actions listed for this app. Do not use a broader local integration or another tool provider to bypass missing grants.
- For Connection actions, list or check status before optional account work when availability is unclear. If more than one account/session can be used and the intended account is ambiguous, ask for the intended account/session instead of guessing.
- For Forger Chrome Extension actions, use `set_styles` only for temporary highlighting or restoring selected elements with allowed CSS properties. Treat `submit_form` as sensitive because it can send data or trigger remote changes.
- Treat Forger Tool and Connection calls as internal actions. Explain the result in terms of the app outcome.
- If a requested Forger Tool or Connection is unavailable or not granted, say that the app does not currently have that access and ask for the missing setup only when it is needed.
