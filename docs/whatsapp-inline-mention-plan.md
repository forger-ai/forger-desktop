# Inline WhatsApp mentions

## User-visible goal

In an enabled, authorized WhatsApp conversation, a person can address the agent with `@alias` at the beginning, middle or end of a message. The agent receives the whole inline request and the bounded recent context of that same chat.

## Scope and behavior

- Repository: Forger Desktop. The parser, channel prompt guidance, existing channel integration tests and settings help are affected. No database migration or permission change is needed.
- Existing `Alias task` and `@Alias task` prefix behavior remains compatible. Case-insensitive inline `@alias` requires complete token boundaries, excluding email addresses, URLs and longer names.
- An inline invocation preserves text before and after the mention. Repeated mentions admit one request. A bare mention without a request remains ignored.
- ON/OFF and corrections remain explicit prefix commands with the existing ownership checks. Words after an inline mention cannot change configuration or correct an unrelated request.
- Existing participant permissions, pause state, deduplication, forwarding/echo safeguards and account/chat isolation apply to inline requests too.
- The existing bounded recent-chat context stays available, with live-authorized history for additional context. Context is supporting data; it cannot authorize another action or widen access.

## Execution and acceptance

1. Backend worker adds failing parser and channel-flow specifications, then implements token detection and any necessary context guidance. Include the user's weather/clothing example, final mention, Unicode boundaries, punctuation, multiple mentions, emails/URLs, command safety, participants and response-echo handling.
2. Frontend worker updates the Spanish and English settings help independently, without changing permissions.
3. Root reviews the changes, updates the current contract, runs the relevant integration and renderer checks, typecheck, lint and production builds. Strict coverage remains unchanged.
4. Root packages and verifies the local update, backs up the current installation and data, installs it without modifying chat grants, and updates the existing PR. A real WhatsApp test is left to the user; automated tests must not send to their contacts.
