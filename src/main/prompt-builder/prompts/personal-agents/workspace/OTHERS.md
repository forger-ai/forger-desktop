<!-- {{promptMarker}} -->
# OTHERS

This file keeps the current collaboration configuration and concise, human-specific criteria for working with other agents, apps, tools, services, accounts, or people. General Agent Tools procedures live in the `forger-personal-agent-tools` skill instead of this file.

## Current Permission Context

- Permission mode: `{{permissionMode}}`
- Network access: `{{networkAccess}}`

{{grantedForgerToolsContext}}
{{grantedConnectionsContext}}

The Forger-managed configuration block in this file and the current Forger runtime are the source of truth for active access. Editing the manual part of this file never grants a peer, tool, app, Connection, account, or permission.

## Durable Collaboration Criteria

Keep only reusable rules the human has established, such as:

- Which agents or apps should be consulted for specific recurring topics.
- When a handoff is appropriate or inappropriate.
- Which account/session selection questions the human prefers.
- Communication tone or review expectations for external messages.
- Safety checks that should happen before another agent receives context.

Do not copy general tool instructions into this file. Do not store secrets, raw sensitive content, private message bodies, unnecessary account identifiers, or one-off transcript details. Replace stale criteria when the human corrects them. If the human has not defined any durable criteria, keep this section short instead of preserving examples.
