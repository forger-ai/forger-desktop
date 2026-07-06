---
name: forger-memory
description: Use when reading, saving, updating, deduplicating, deleting, or explaining Forger platform memory, including injected memories, app-scoped memory, global preferences, privacy, and safe user-facing language.
---

## read_when

- The request asks Forger to remember, forget, update, reuse, or stop using a preference, fact, workflow, constraint, or profile detail.
- The prompt includes an injected memory section, such as `Memoria de Forger:`.
- A task would benefit from a durable preference or fact that applies to future Forger work.
- The agent is about to call `memory_list`, `memory_create`, `memory_update`, or `memory_delete`.

## Platform Contract

- Memory is a Forger platform layer. It is not an installed app feature, app manifest grant, or optional Forger Tool.
- Forger injects relevant memory context when available. Treat injected memories as already available context, not as a reason to call a tool again.
- Memories without `read_when` are always-injected when their scope is available to the current run. Their body is already in context.
- Memories with `read_when` are registered in context by title and condition. Read the body with `memory_list` only when the condition applies to the current task or when you need an id for update or delete.
- Use memory to guide defaults, wording, workflow choices, and continuity. Verify current app state, current files, current messages, and explicit user choices before making factual claims or changing data.
- Memory can be global or app-scoped. Global memory is for preferences and facts that apply across Forger. App memory is for stable context about one installed app.

## Fetching Memory

- Read existing memory before saving when the new information may duplicate, refine, contradict, or replace something already remembered.
- Do not fetch memory just to restate always-injected memories. Fetch only when you need conditional memory details, need an id for update/delete, or need to check for duplicates.
- In app-agent context, expect access to global memory and memory for the selected app. Do not assume access to another app's memory unless the platform context explicitly includes that app.
- App agents write app-scoped memory for their selected app. They do not force global writes through app context.
- In automations, use only memories relevant to the selected apps and the automation task.

## Saving And Updating

- Save durable, reusable information: stable preferences, profile details the person intentionally shares, recurring workflow choices, constraints, and facts that should guide future Forger work.
- Prefer `memory_update` when an existing memory is stale, narrower than the new information, or should be corrected.
- Use `memory_create` only when no equivalent memory exists.
- Keep memory short, plain, and future-facing. Write what should guide future behavior, not a transcript of the conversation.
- Save app-specific information with app scope and the relevant app id.
- Save cross-Forger preferences with global scope when the current memory access allows a global write.
- If the current memory access rejects a global write, explain the outcome in simple terms and do not retry through another integration or storage path.
- Do not save one-off instructions, temporary state, unresolved guesses, broad summaries, raw file contents, logs, or implementation details that are only useful for the current turn.

## Deduplication

- Treat two memories as duplicates when they would cause the same future behavior.
- If a new statement contradicts an old memory, update the old memory instead of adding a second conflicting entry.
- If a new statement is more specific, update the old memory to the specific version when that better reflects the person's preference.
- If the user asks Forger to forget something, delete the relevant memory rather than adding a negating memory.

## Privacy And Secrets

- Never save secrets, credentials, tokens, private keys, recovery codes, local credentials, raw sensitive documents, or exact private identifiers unless the platform explicitly provides a dedicated secure secret store for that purpose.
- Do not save medical, legal, financial, political, religious, relationship, identity, or other delicate personal inferences unless the person explicitly asks Forger to remember a safe preference-level statement.
- Do not save sensitive details from shared files, email content, logs, screenshots, or app data unless the person clearly asks Forger to remember a safe summary and that summary is necessary for future Forger work.
- When the person asks to remember something unsafe, offer a safer version such as a workflow preference or non-secret constraint.

## User-Facing Language

- Say "I can remember that for next time", "I updated what Forger remembers", or "I forgot that" when memory changes.
- Explain memory outcomes in functional terms: the preference or fact remembered, updated, skipped as already remembered, or forgotten.
- Do not mention `memory.json`, schemas, tool names, scopes, ids, prompt injection, or MCP unless the person asks for technical detail.
- If memory is used to guide an answer, do not over-explain it. A short phrase such as "I used what Forger remembers about your preference" is enough when helpful.
