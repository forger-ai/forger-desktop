---
name: forger-personal-agent-tools
description: Use when a Forger personal agent needs to create or communicate with other personal agents, continue an inter-agent thread, or inspect an allowed agent conversation.
---

# Personal Agent Tools

This skill explains how personal agents create and communicate with other personal agents. It does not grant access. The Forger-managed configuration block in `OTHERS.md` states whether creating agents is enabled and which peer agents are allowed. The MCP tool list is the final runtime check.

## Create A Personal Agent

Use `forger_create_personal_agent` only when all of these are true:

- The current configuration in `OTHERS.md` says `Create other agents: enabled`.
- The tool is present in the current MCP tool list.
- The human made an explicit request or authorization to create the agent.

Do not create an agent speculatively, merely to delegate ordinary work, or as a way to bypass missing permissions.

Call `forger_create_personal_agent` with:

- `name`: required visible name.
- `description`: optional short visible description.
- `purpose`: optional durable responsibility.
- `instructions`: optional specific working instructions.
- `groupId`: optional existing group. If omitted, the new agent inherits the creator's group when the creator has one.

The new agent inherits the creator's runtime but starts with safe permissions, no internet, no apps, no tools, no connections, and no permission to create more agents. The creator receives permission to contact the new agent. The new agent does not automatically receive reciprocal access to the creator.

After creation, report the new agent's functional role and group. Do not expose internal ids unless the human asks for technical detail.

## Discover Allowed Agents And Threads

Use `forger_list_agent_peers` before starting a new inter-agent conversation when the current configuration or the correct specialist is unclear. It returns allowed peers, their usage criteria, and recent threads.

Only contact agents listed as allowed in the managed `OTHERS.md` configuration and runtime result. Respect each peer's criteria; permission to contact an agent is not permission to send unrelated private context.

Contact another agent when the human explicitly asks for the collaboration or when that agent owns information, state, tools, or a responsibility required for the current task. Do not involve another agent merely because it is convenient, and do not use inter-agent calls to avoid inspecting current local state first.

## Start Or Continue A Conversation

Use `forger_ask_agent` with:

- `targetAgentId` and `message` to start a new thread with an allowed agent.
- `threadId` and `message` to continue an existing thread.

When `threadId` is present, treat it as the continuation target and omit `targetAgentId`. Reuse the returned `threadId` for later turns in the same collaboration. The call waits for the other agent's response, so use that response before continuing the task or reporting the result.

Keep the message scoped to the information and responsibility the peer needs. Do not forward secrets, unnecessary raw documents, unrelated conversation history, or sensitive context merely because the peer is allowed.

Peer access is directional. Seeing an agent in the current allowlist means the current agent may contact that peer; it does not mean the peer can contact the current agent. Ask the human before sharing private user data or materially expanding what another agent receives.

## Read A Thread

Use `forger_read_agent_thread` with `threadId` when you need to inspect an allowed thread without sending another message. Reading is not permission to continue a thread that is not available to the current agent.

## Missing Access

If creation is disabled, a peer is not allowed, or a tool is absent, explain the missing configuration in functional language. Do not claim the action succeeded, edit workspace notes to simulate a grant, or route through unrelated tools.
