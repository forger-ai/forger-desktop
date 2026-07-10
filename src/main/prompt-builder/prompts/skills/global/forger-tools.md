---
name: forger-tools
description: Use when designing, reviewing, or explaining Forger Tools, Connections, app-scoped grants, agent grant requests, UI grants, app-owned structured tools, Gmail or WhatsApp access, or manifest tool and connection declarations.
---

## Capability Types
- Forger Tools are platform-owned capabilities that apps and agents can request, such as the Forger Chrome Extension, Memory, Workflows, app lifecycle actions, and future Forger-owned services.
- Connections are external accounts, workspaces, services, or sessions that the person connects, such as Gmail, Google Calendar, Google Sheets, Google Drive, Google Docs, GitHub, Notion, WhatsApp, Slack, and Trello.
- App-owned structured tools remain the preferred way to read or change app data. They belong to the installed app and should reflect the app's own validation and domain language.
- Agents call Forger Tools and Connections through the `forger` MCP server. App services call app-granted actions through the signed Desktop runtime bridge helper.

## Manifest Grants
- Use `manifest.tools.required[]` and `manifest.tools.optional[]` only for Forger Tools. Forger Chrome Extension actions belong here.
- Use `manifest.connections.required[]` and `manifest.connections.optional[]` for registered Connections such as Gmail, Google Calendar, Google Sheets, Google Drive, Google Docs, GitHub, Notion, WhatsApp, Slack, and Trello.
- Required entries mean the app cannot fully perform the declared capability without that Forger Tool or Connection. Optional entries mean the app works without it but a visible workflow unlocks after the person grants it.
- Every Forger Tool entry must include `toolId`, `reason`, and `actions`. Every Connection entry must include `type`, `reason`, `actions`, and `multiple`.
- Request only the actions needed by the visible workflow. Do not request broad external account access just because a Connection exists.
- `actions: ["*"]` is broad. Desktop treats it as every current and future action for that same Forger Tool or Connection type, never for another type.

## App-Scoped Access
- App agents may call Forger Tool and Connection actions only when the selected app context and grants allow the requested action.
- App backends may call granted Forger Tool and Connection actions through the signed Desktop runtime bridge helpers in `commons/backend/forger_desktop.py`. They may also call connection setup helpers when the app declared that Connection. Optional grants are managed by manifest review surfaces during install/download or later from Forger's app access UI.
- App-scoped grants do not create global access for every app. Treat each app's grants as local to that app and its declared workflows.
- If an app lacks a grant for a Forger Tool or Connection action, do not use a broader local integration or another provider to bypass the missing grant.
- For Chrome grants, request `set_styles` only for temporary visual highlighting or restoring selected elements. Do not use it to hide content, bypass page UI, or make persistent page changes. Treat `submit_form` as sensitive because it can send data or trigger remote changes.
- For Connection grants, check status before optional external account work and handle unavailable or missing accounts with a functional app state.

## Agent Grant Requests And UI Grants
- Agent-facing grant requests go through Forger MCP and Desktop-owned approval or grant surfaces when the platform exposes them. Do not invent a separate app permission dialog, hidden setting, or local integration fallback.
- UI grant toggles are for the person to allow or deny optional app access. Required access should be presented as an install or setup requirement with the functional reason and the blocked workflow.
- Approval for an individual action and granting an app access to a Forger Tool or Connection are different boundaries. A granted app may still need visible approval for sensitive actions when approval is enabled.
- Permission copy should explain what the person gets from the access. Do not expose MCP server names, manifests, endpoints, tokens, secrets, or internal paths unless technical detail is requested.

## Failure Handling
- Explain failures in product language: missing access, missing setup, missing data, invalid input, duplicates, permission denial, unsupported action, unavailable integration, or ambiguous account/session.
- If access is unavailable or denied, explain what part of the workflow cannot continue and what safe next step is available.
- Use `forger-manifest-authoring` when writing the exact `manifest.json` shape for Forger Tool and Connection grants.
