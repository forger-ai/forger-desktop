# WhatsApp conversation web search

## Scope and behavior

Forger Desktop exposes **Allow web searches** in each WhatsApp conversation. New conversations default to off. Search is available only when both the saved chat policy and the agent's global internet permission allow it. The editor retains the saved choice, explains a global restriction, and shows web access in configuration review and conflict comparison.

The provider exposes hosted public web search for the effective permission. Codex keeps its filesystem isolation and blocked local network, shell, plugins and ambient tools. Claude exposes only its hosted WebSearch tool alongside authorized Forger tools. Search does not grant access to private browser sessions or local files. Queries may be sent to the provider; prompts request minimal relevant queries, cited sources and distrust of page instructions.

## Ownership and verification

- Renderer agent: localized toggle, saved/global permission state, review/conflict summaries, and tests for default off, save/reopen and global restriction.
- Runtime agent: provider launch paths, effective permission propagation, revocation/cancellation, prompt and runtime integration tests.
- Orchestrator: review isolation and revocation boundaries, integrate documentation, run relevant coverage/type/lint/build checks, package and verify a local update.

Tests precede implementation. They cover both permission gates, launch/resume/fallback arguments, stale queued requests, active revocation, retained drafts, and unchanged private-data isolation. Existing conversations are not automatically opted in. Packaging preserves the installed app and its configuration for rollback; no production release or real chat activation is part of this change.
