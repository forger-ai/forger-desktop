# WhatsApp conversation access and reply identity

## Goal and scope

Forger Desktop lets the owner choose conversations and decide who can invoke a personal agent in each group. Replies identify the agent on a separate header line. Both plain activation words and a leading `@` work. Existing private data grants remain unchanged.

Only the Desktop repository changes. Affected boundaries are the transport identity resolver/index, channel parser and authorization coordinator, relational binding store, IPC validation, configuration editor, and local application package.

## Acceptance criteria

- Replies use `🤖 <configured alias>: ` followed by a newline and the response. Formatting happens during delivery, applies to retries once, and preserves a useful body under the transport size limit.
- `Kupita` and `@kupita` accept tasks and existing commands with strict alias boundaries. Owner-only activation/pause and author-bound correction remain enforced.
- Each configured conversation has explicit owner, selected-people, or all-group-members access. New chats default to owner and paused. All-members access is valid only for groups and includes new members. Selected access requires a selection.
- Legacy bindings retain their existing effective permissions. Configuration revisions invalidate stale work; queued requests recheck current authorization.
- Review, configured-chat summaries, and conflict comparison show the chosen access mode. Search and failed participant loading preserve the current chat, type and selections.
- Trusted phone/LID identity resolution connects the selected chat with live events and history without merging unrelated chats or delivering duplicates. Original transport references remain intact. Display names and arbitrary aliases never establish identity.

## Parallel ownership

1. Channel backend: behavior tests first, then shared contract, migration, parser, authorization, reply formatter and IPC validation.
2. Configuration UI: UX review, behavior tests first, then editor, mode selection, copy and reply preview.
3. Transport: identity tests first, authenticated identity resolver, indexing/history and phone-label normalization. Coordinate channel integration through an explicit resolver contract.
4. Orchestrator: integration review, docs, full checks, local packaging and installed-app verification.

## Sequential verification and delivery

1. Verify focused failing behavior tests before implementation and green afterward.
2. Integrate the shared contract and identity APIs; inspect security boundaries and migration behavior.
3. Run typecheck, lint, backend and renderer suites, with coverage checks; build the renderer and Electron output.
4. Package a local arm64 update with native dependency and signature checks, preserve the existing installed version for rollback, and retain the linked WhatsApp session.
5. Verify the installed settings UI and existing self-chat configuration. Real group activation requires the owner's choice of a specific group and access mode; development never enables arbitrary groups.

## Searchable chat picker follow-up

The Chat control combines conversation search and selection in one dropdown. Direct-contact options show the saved address-book name and real phone number when WhatsApp provides them; groups show their subject. Searching by name or number preserves the selected conversation and its access draft. Same-name contacts remain distinct, and authenticated phone/LID duplicates remain one choice.

Renderer ownership covers the picker, editor state and flow tests. Transport ownership covers saved-name provenance, a nullable relational contact-name field, metadata enrichment and store/manager regression tests. Saved contact names survive incoming profile-name updates; display metadata never grants access or establishes identity. The orchestrator integrates both, checks types/lint/builds and relevant coverage, then verifies the locally installed update without changing conversation permissions.
