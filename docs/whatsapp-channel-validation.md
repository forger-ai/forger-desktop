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

## Personal-account follow-up (2026-09-27)

The owner designated their self-chat for a controlled live test. QR renewal/expiry handling is corrected and linking succeeds. A phone/LID identity mismatch initially prevented routing; the selected self-chat was corrected without replaying earlier messages. One subsequent live task completed and delivered the exact requested answer in about seven seconds, and the owner confirmed receipt. No group was activated during this test.

The next local build adds a deterministic agent reply header, optional `@` invocation, and owner/selected/all-group-member access. It preserves legacy access in a transactional relational migration, resolves authenticated phone/LID identity for routing and participant authorization, and retains original transport references. Equivalent message copies and outbound echoes do not duplicate execution. Concurrent attempts to activate equivalent bindings cannot both succeed. Configuration summaries, conflict review and available-chat selection preserve names and access modes while searching.

- Complete Electron suite: 2,227 tests pass, 100% statements, branches, functions and lines.
- Complete renderer suite: 861 tests in 94 files pass, 100% in all four metrics. Focused picker/access flows also pass after integration.
- TypeScript, repository ESLint, renderer build and Electron build pass.
- Packaged arm64 `0.5.19-pr163.2`: native SQLite, parser, reply formatter, access persistence, WhatsApp module import and 460 production package dependency checks pass. Ad-hoc signature verification passes.
- Independent review identified a concurrent equivalent-chat activation race; the fix includes concurrent save and ON-command regression tests.

After installing the update, the owner sent `@kupita responde: NUEVO FORMATO OK` in the designated self-chat. One request completed and its delivery was marked sent. The local transport record contains `🤖 Kupita: ` followed by a newline and `NUEVO FORMATO OK`; the owner confirmed that format on the phone. The connection remained available after the update/restart, with the self-chat still owner-only.

## Searchable Chat follow-up (2026-09-27)

The separate conversation search and select controls are replaced by one searchable Chat dropdown. It displays saved contact names and phone numbers, distinguishes same-name contacts, preserves selection across asynchronous search, and keeps group subjects without inventing phone numbers. The transport stores saved contact names separately from profile/message names and migrates existing databases without reclassifying old titles. Search supports formatted phone numbers and account-scoped verified phone/LID equivalents.

- Transport regression suites: 89 tests pass with 100% statements, branches, functions and lines across manager, normalizer and store.
- Focused renderer flows: 49 tests pass with 100% in all four metrics across the affected editor modules.
- Complete renderer suite: 867 tests pass with 100% statements, branches, functions and lines.
- TypeScript, repository ESLint, renderer build and Electron build pass.
- Existing contact titles remain a fallback until WhatsApp supplies saved-contact metadata. This update does not trigger a full contact resynchronization or modify chat access.
- Local arm64 `0.5.19-pr163.3` installs successfully; native SQLite, saved-contact normalization, channel behavior, WhatsApp import, all 460 production package dependencies and ad-hoc signature checks pass. Installed UI verification finds conversations by phone digits and by name in the single dropdown. The migrated database passes integrity checking, and existing bindings, allowed participants and aliases match the pre-update backup.

## Release boundary

Automated tests use synthetic transport/provider doubles and do not contact real recipients. Controlled self-chat tests confirm delivery, `@` invocation, reply formatting and connection recovery after the local update. Live group authorization and pause/resume still need their own controlled account checks. The local package is ad-hoc signed, not notarized or published; this change does not merge the PR or deploy to production. Codex and Claude support the isolated channel contract; Antigravity is rejected for this channel.
