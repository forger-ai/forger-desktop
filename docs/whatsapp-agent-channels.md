# Personal agents in WhatsApp

Desktop binds one personal agent to an observed chat on a configured WhatsApp account. The owner selects who may submit tasks and which data and actions the chat can use. Replies are visible to everyone in the chat, including members who cannot submit tasks. Desktop and the account connection must remain available for processing and delivery.

## Requests and recovery

A task starts with the configured activation word, optionally preceded by `@`. Matching ignores letter case: `Kupita resume esto` and `@kupita resume esto` invoke the same agent. The alias must be followed by whitespace, a colon, or a comma; a longer name containing the alias does not match. This is a typed prefix and does not require a native WhatsApp contact mention. Independent tasks enter a durable FIFO queue for that binding; another participant's task does not cancel the current task. ON and OFF are owner commands, including with the `@` prefix. Desktop can pause the binding without a network connection. Canceling a request or pausing a chat does not undo completed external actions.

Replies have a transport-owned header: `🤖 <activation word>: ` followed by a newline and the response. This wrapper does not depend on the language model following formatting instructions. Activity keeps the complete original answer; the delivery formatter includes the header when applying the message length limit and on delivery retries.

## Conversation selection and people

The owner selects available conversations in the agent's WhatsApp settings. Each conversation has its own paused/active state, purpose, shared information, and access mode:

- **Only me:** only the linked account can assign tasks. This is the default for new conversations.
- **Selected people:** the linked account and at least one explicitly selected person can assign tasks.
- **All group members:** any sender in that configured group can assign tasks, including people who join afterward. This option is restricted to group conversations.

The **Chat** dropdown includes search by contact name or phone number. Direct conversations show the saved contact name supplied by WhatsApp and the actual phone number when available; groups show their subject. Existing cached titles provide a fallback until WhatsApp supplies saved-contact metadata. A profile name or incoming message does not replace a saved contact name. Search preserves the selected chat and its draft permissions, and equivalent phone/LID identities appear once without changing the stored binding. Names and phone labels do not establish identity or grant access.

The linked account always retains control of ON/OFF. Being allowed to assign tasks does not grant access to another conversation or to the agent's private files and memories. Everyone in the group can see replies. The editor shows the access mode and reply preview before applying changes and preserves drafts during configuration conflicts. Existing bindings retain owner-only access when their participant list is empty and selected-person access otherwise.

**Allow web searches** is an explicit per-conversation choice, off for new chats. It also requires **Allow internet** in the agent's general settings. The editor preserves the saved chat choice when the general permission is off and explains why search is unavailable. Review and conflict comparison show the selected setting. Queries can be sent to the search provider; responses cite their sources. This permission covers public web search and does not share private files, memories or browser sessions.

A correction explicitly identifies its request and requires its author or the account owner. `Ana CORREGIR MI ULTIMA <text>` corrects only that sender's latest active or queued task; it never targets another participant's task. `ÚLTIMA` is also accepted. The owner can identify another request explicitly with `Ana CORREGIR <requestId> <text>`. Activity shows the request identifier, full request and response, creation/update times, execution state, delivery state and recovery actions. WhatsApp conversations also appear in the agent's history. The alias belongs to the account/agent pair; editing it shows all affected chats and preserves active work.

Configuration versions are independent of execution generations. Editing configuration invalidates old authority and cancels work with the obsolete scope. A queued request rechecks its author's permission before admission. Drafts remain available after configuration conflicts.

The channel records request/run correlation before the runner starts. Admission has accepted, rejected and unknown outcomes. Startup reconciles AgentStore runs before resuming unstarted requests. Runs that lost their process become interrupted; they are not re-executed automatically. A persisted completed response can be recovered without re-running the agent. Legacy ambiguous admissions become interrupted activity records, retaining deduplication without replaying effects.

Execution and delivery are separate. The account outbox persists full response text and spaces sends by at least 1,500 milliseconds. A confirmed rejection before sending can be retried; temporary offline/rate-limit rejections stay queued. An unconfirmed send is never automatically retried. The local recovery action retries only a known failed delivery, not the agent execution. Activity can dismiss an uncertain delivery after the owner reviews the chat.

## Data and action boundaries

A channel starts with no shared apps, connections, peer agents, memories or files. Its policy intersects the personal agent's current permissions. Removing an agent grant therefore removes channel access too. The old broad capabilities switch does not grant access on its own.

Each request starts a new provider session in a separate channel workspace. The prompt includes the agent's identity/instructions, selected memories and the current request, not personal conversation history or the private workspace bootstrap. Selected files resolve through host-owned imported file IDs; renderer-supplied filesystem paths have no authority. File tools list and read only the channel's shared/output directories, reject traversal and symlinks, and recheck authority after reading. Text reads are paginated; binary files require an explicitly shared app capable of interpreting them.

Codex uses a filesystem allowlist and disables native shell, image, JavaScript, subagent, plugin and memory tools. Its local network remains blocked; the effective search permission selects hosted live web search or disables it. Claude disables ambient project documents and automatic memory, uses a strict MCP configuration, and exposes only native WebSearch when the effective search permission allows it. Claude WebFetch and other native tools remain unavailable. Antigravity channel execution is rejected because this integration does not enforce the required isolation for that runtime. Channel sessions never inherit a provider thread, private image attachments or extra filesystem roots.

Forger tools check the current binding and run before each action and again after a permission prompt. Chat history is fixed to the originating account/chat. Peer thread reads are fixed to the originating conversation and selected peers. Private platform memory, unscoped file/audio tools and configuration-changing platform tools are unavailable. App-scoped tools require a selected app. Apps' MCP servers use a per-run proxy credential; shared upstream credentials stay in Desktop. The proxy checks current access before requests and before emitting responses, including streamed chunks.

Sharing an app, a connection action or another agent authorizes the data available through that capability. In particular, explicitly shared WhatsApp connection actions may access other chats of the selected account. The review screen explains this scope. Those selected capabilities are separate from the public web-search permission. Revoking the chat policy cancels work under the old revision; revoking the agent's global internet permission stops active web-enabled channel runs. Queued work checks current permissions before execution. Revocation cannot undo a search already sent to the provider.

## Implementation boundaries

- `personal-agents/whatsapp-channel/`: parser, coordinator, relational request/policy stores and account outbox.
- `personal-agents/whatsapp-channel-service.ts`: WhatsApp transport and conversation adapters, startup reconciliation and local control surface.
- `personal-agents/whatsapp-channel-policy.ts` and `whatsapp-channel-context.ts`: permission intersection, prompt and file boundaries.
- `forger-mcp/whatsapp-channel-*` and `channel-app-proxy.ts`: live authorization and scoped tools.
- `views/whatsapp-agent-channel/`: MUI policy review, drafts, connection state and activity/recovery controls.

## Verification and limits

Integration tests use real SQLite stores, AgentStore, ConversationManager and channel service with external runner/transport doubles. They cover restart gaps, concurrent completion/correction, queue authorization, deduplication, rate limiting, unconfirmed delivery, policy changes, local pause and migration. HTTP tests exercise live MCP revocation and streaming proxies. A native Codex sandbox test reads a shared fixture and rejects reads/writes to a private sibling without contacting a model. Renderer tests cover configuration, conflicts, activity, reconnect navigation and history.

These checks do not contact a real WhatsApp recipient or publish a release. A controlled real-account test of authorization, reconnect and delivery remains a release prerequisite. The trigger consumes supported message text/captions; this feature does not automatically interpret voice notes or unshared attachments.
