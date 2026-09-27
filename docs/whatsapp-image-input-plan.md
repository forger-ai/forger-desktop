# WhatsApp caption image input

## Goal and scope

An authorized person sends a normal photo with `@alias` in its caption. The configured personal agent can inspect that exact photo and answer in the same chat when the effective WhatsApp attachment-download permission allows it. This Desktop change does not add a new grant or change existing chat configuration.

The user supplied [whatsapp-agents-bridge](https://github.com/otro-felipe/whatsapp-agents-bridge) as a reference. Its MCP fixes account/chat scope and separates attachment metadata from binary downloads. Its download tool returns a local path; Forger's isolated channel needs a dedicated multimodal result instead of broader native file access. The implementation uses Forger's existing transport and session authority.

## Behavior and boundaries

- A no-argument internal `whatsapp_channel_current_images` tool resolves the active run's durable originating message. The model cannot select an arbitrary path, account, chat, message or attachment.
- The image is returned as an MCP image block, with safe textual status and no local path, raw provider payload or binary logging.
- Current agent and chat download grants must both allow the originating account. Permission and active-turn checks occur before and after asynchronous work; stale or revoked requests return no image.
- The transport reads only images belonging to the stored originating message and authenticated equivalent chat identities. It limits count, incoming bytes, decoded dimensions and output size, validates actual format and returns clear failures for unsupported, unavailable or corrupt content.
- Native shell, filesystem readers, private browser access and arbitrary image-path tools remain disabled. No image is selected automatically from a different message, old quote or another chat. Existing photo-free invocations continue to work.

## Parallel implementation and verification

1. MCP worker owns the dedicated tool, runtime dispatch/listing, scoped prompt guidance, lifecycle wiring and HTTP security tests. Add failing specifications before code.
2. Transport worker owns the internal WhatsApp image reader, authoritative message lookup, ConnectionsService bridge, channel-service resolution and synthetic SQLite/transport integration tests. Add failing specifications before code; avoid unrelated attachment send/upload features.
3. Root reviews integration and permission boundaries, updates documentation/help, runs focused and strict checks, and verifies real Codex vision with a synthetic image and the existing connected account. Do not transmit real WhatsApp photos or send a message to contacts.
4. Root builds and verifies a local package, preserves the installed app and databases, installs without changing grants, and updates PR 163. The owner can then test a normal photo with an invoking caption.
