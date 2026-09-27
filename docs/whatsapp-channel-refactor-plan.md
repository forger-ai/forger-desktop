# WhatsApp agent channel implementation plan

Goal: authorized WhatsApp users can submit independent tasks, correct their own tasks explicitly, inspect results, and recover from local restarts or transport failures without exposing unrelated personal data or duplicating side effects.

Scope: Desktop only; PR #163. No production deployment or changes to user data. Source findings: workspace docs/reviews/pr-163-whatsapp-review.md, review head 57bc694f.

## Accepted behavior and tests first

- New requests persist in FIFO order. A correction identifies a request and requires its author or owner. OFF/desktop pause works locally while disconnected.
- Startup reconciles actual persisted runs and channel state. Rejected admissions release reservations; uncertain admission resolves by durable request identity. Terminal events cannot be lost due to unrelated activity.
- Configuration versions are independent of run generations. Alias remains account/agent-wide with an explicit operation and visible scope.
- Execution and delivery are separate. Per-account durable delivery queue handles pre-send retryable failure; uncertain delivery never automatically resends. Activity retains full request/result/timestamps/reasons.
- Channel policy intersects current agent permissions. Private memories are excluded unless explicitly shared. Chat execution has a separate workspace and enforced runtime boundary. Changed policy/audience does not reuse privileged provider context.
- History shows WhatsApp. UI exposes connection availability, activity, cancel/pause/retry/dismiss, recoverable drafts and configuration errors.

BDD integration tests use SQLite, AgentStore, ConversationManager and channel service; doubles are limited to external runners/transports. Add failing reproductions before changing behavior. Test authorization and IPC/preload composition. Target repository's 100% coverage requirement without relaxing thresholds or excluding new code.

## Parallel ownership

- implement_channel: channel coordinator/store/service, ConversationManager and AgentStore admission changes, main integration tests.
- implement_privacy: policy/context/isolation modules and provider boundary tests. Coordinate hooks with the sole ConversationManager owner.
- implement_ui: MUI panel/components/hooks/history/i18n and renderer flow tests.
- root: shared contracts, IPC/preload wiring, connection transport typing, live authorization wiring, CI coverage reliability, integration and final review.

Sequence: shared contracts -> red BDD -> parallel implementation -> sequential integration -> security/behavior review -> checks and fixes -> commit/push PR branch. Each edit stays in this Desktop worktree. No worker reverts another's changes.

## Verification

Build Electron before main tests. Run focused BDD first; lint, typecheck, full Electron and renderer coverage, resource tests, builds, then Electron smoke with synthetic state. Inspect migration/restart paths and cross-surface regressions (personal chat, routine, Sidekick). A real WhatsApp send needs a user-specified controlled recipient and is not silently performed by validation.
