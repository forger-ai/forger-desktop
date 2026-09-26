# PR 163 refactor validation

Date: 2026-09-26. Baseline reviewed: `57bc694f9baa3c75c27eda2c76a47bb7e09b89aa`. Scope: Desktop implementation and synthetic local verification.

## Review findings addressed

| Finding | Implementation and acceptance evidence |
| --- | --- |
| Restart blocks the next task | Reconcile authoritative AgentStore runs, recover durable completed replies, interrupt orphaned executions and preserve unstarted queue entries. Real SQLite/ConversationManager restart tests. |
| Completion races with a correction | Independent FIFO requests and explicit author-scoped corrections; durable admission identity; atomic request/turn settlement. Concurrent completion, correction and denied-author tests. |
| Restricted chat receives private context | Separate workspace, explicit memories/files, fresh provider sessions and enforced runtime restrictions. Canary prompt tests and a native Codex sandbox read/write denial test. |
| Account rate limit loses a reply | Persistent account outbox, proven pre-send failure markers, conservative uncertain delivery. Real WhatsApp manager with synthetic socket exercises offline → rate-limited → sent. |
| Unrelated completions exhaust the buffer | Correlation persists before execution; no global early-event buffer. More than 100 unrelated events and immediate completion tests. |
| History and recovery are inaccessible | WhatsApp history, activity with full text, safe explanations, local pause/cancel/retry/dismiss and reconnect navigation. Renderer flow tests and visual inspection. |
| Global alias and edit conflicts are misleading | Explicit global alias operation and affected-chat review, stable configuration version and retained draft comparison. Active runs continue across alias edits. |
| Capability changes are not enforced during a run | Current grant intersection and host authorization on each MCP action, after approval, and during app MCP response streaming. HTTP tests verify revocation. |
| Participant labels or chat options become stale | Metadata/contact names retain stable authorization IDs; account changes invalidate chats and shared-file selection. Manager-to-renderer tests. |

The independent final review found two additional defects: saving policy could leave the queue idle, and an authorized peer thread could not be continued using only its thread ID. Both have regression tests and fixes. A fresh-session test also found and fixed explicit null session clearing in AgentStore.

## Checks

- Electron suite: 2,194 tests pass, no skipped tests on this host; 100% statements, branches, functions and lines.
- Renderer suite: 848 tests in 93 files pass; 100% statements, branches, functions and lines.
- TypeScript and repository ESLint pass.
- Production renderer/Electron build passes.
- Real Electron smoke: both tests pass using a temporary isolated user profile; renderer isolation and unsafe child-window denial remain intact.
- Python resource suite: five tests pass in a temporary modern Python environment with the repository's pinned test requirements.
- Visual inspection covers desktop and narrow layouts with synthetic data.
- Coverage thresholds and exclusions remain unchanged. The memory-maintenance clock test explicitly covers both sides of 03:00 to eliminate dependence on CI wall-clock time.

## Release boundary

No model API or real WhatsApp recipient is contacted during these checks. A controlled real-account test of authorization, pause, reconnection and delivery still requires an explicitly designated account and chat. This change is not a release or production deployment, and the PR must not be merged on the assumption that live delivery has been tested. Codex and Claude support the isolated channel contract; Antigravity is rejected for this channel.
