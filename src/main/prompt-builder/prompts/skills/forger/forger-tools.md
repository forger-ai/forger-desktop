---
name: forger-tools
description: Use when designing, reviewing, or explaining Forger-approved tools, official MCP tool grants, required or optional app grants, app-scoped official tools, agent grant requests, UI grants, app-owned structured tools, Gmail or WhatsApp access, or manifest tool declarations.
---

## Tool Types
- Forger tools are approved platform capabilities that apps can request, such as Gmail and WhatsApp.
- Use official Forger tools when an app needs a platform-owned integration, not as a replacement for the app's own data model or visible feature list.
- App-owned structured tools remain the preferred way to read or change app data. They belong to the installed app and should reflect the app's own validation and domain language.
- Official Forger tools live on the `forger` MCP server and are separate from app MCP tools, Codex-local connectors, and provider-native tools.

## Required And Optional Grants
- Manifest `tools.required[]` means the app cannot perform its core purpose without that official tool. Required tools must be available and configured before the app can be installed or used for that declared capability.
- Manifest `tools.optional[]` means the app can work without the tool, but a specific workflow improves or becomes available when the person grants it.
- Required and optional entries must include `toolId`, `reason`, and `actions`. The `reason` describes the user-visible reason for access, not the implementation path.
- Request only the actions needed by the visible workflow. Do not request broad Gmail or WhatsApp access just because a tool exists.
- Optional grants remain off until the person grants them through Forger UI or the relevant app-scoped grant flow.

## App-Scoped Official Tools
- App agents may call official Forger tools only when the selected app context and grants allow the requested action.
- App-scoped grants do not create global tool access for every app. Treat each app's grants as local to that app and its declared workflows.
- If an app lacks a grant for an official tool action, do not use a broader local connector or another tool provider to bypass the missing grant.
- If an app requests Gmail or WhatsApp, use the current official action ids from `forger-manifest-authoring` and keep the grant reason tied to the visible workflow.

## Agent Grant Requests And UI Grants
- Agent-facing grant requests go through Forger MCP and Desktop-owned approval or grant surfaces when the platform exposes them. Do not invent a separate app permission dialog, hidden setting, or local connector fallback.
- UI grant toggles are for the person to allow or deny optional app access. Required access should be presented as an install or setup requirement with the functional reason and the blocked workflow.
- Approval for an individual tool call and granting an app access to an official tool are different boundaries. A granted app may still need visible approval for sensitive actions when approval is enabled.
- Permission copy should explain what the person gets from the access. Do not expose MCP server names, manifests, endpoints, tokens, secrets, or internal paths unless technical detail is requested.

## Failure Handling
- Explain tool failures in product language: missing access, missing setup, missing data, invalid input, duplicates, permission denial, unsupported action, or unavailable integration.
- If access is unavailable or denied, explain what part of the workflow cannot continue and what safe next step is available.
- Use `forger-manifest-authoring` when writing the exact `manifest.json` shape for official tool grants.
