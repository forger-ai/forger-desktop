# AGENTS

{{forgerContractMarker}}

## App Context

This folder contains the installed local application `{{appId}}`.

This app may be installed and operated through Forger, but this file is app context first. Use it to understand the app folder, the app's current capabilities, and the internal tools available for app work.

## Source Of Truth

- This generated `AGENTS.md` is a fallback context file used when the app does not ship its own app-owned `AGENTS.md`.
- If the app later ships its own `AGENTS.md`, that file should own app-specific product and operational facts.
- `manifest.json` describes installation, services, stack, prompt templates, app agents, official tool declarations, app secret declarations, scripts, and skills. It is not a complete list of visible app features.
- `.agents/skills` contains internal agent playbooks. Use relevant skills before doing work covered by them.
- Review the real app files before claiming a capability exists.

## Visible Capabilities

- A visible capability is something the person can ask the app to do or inspect in the app experience.
- Do not infer visible capabilities only from scripts, services, prompt templates, app agents, internal tools, or stack metadata.
- If the app has no app-owned `AGENTS.md`, verify capabilities from the current interface, routes, copy, models, services, and documented app skills before describing them.
- If evidence is missing, say that the capability does not appear to be available.

## Shared Files

- Shared files are task inputs only when they are attached in the current message or explicitly mentioned.
- Use only the shared files listed in the current message.
- Do not search for unrelated external files.
- If a shared file is used, report the functional result: what was reviewed, loaded, changed, skipped, or still needs confirmation.

## Forger Memory

- Forger may inject relevant global memory or memory for this installed app into the agent context.
- Memories without `read_when` are always-injected when available. Conditional memories include a `read_when` condition and should be fetched only when that condition fits the task.
- Treat injected memory as platform continuity, not as app documentation or proof of current app data.
- Use the `forger-memory` skill before reading, saving, updating, deduplicating, deleting, or explaining memory.
- Save app-specific stable preferences, facts, workflows, or constraints as app-scoped memory when they should guide future work in this app.
- Do not save secrets, credentials, raw sensitive data, or delicate personal inferences in memory.

## Internal Tools

- Internal tools are resources for completing app work: app tools, scripts, skills, temporary files, validations, and structured app data access.
- Internal tools are not automatically visible app features.
- Prefer structured app tools when they exist because they usually preserve app validation and app language.
- Use scripts only when the app documents them or when no safer structured tool exists.
- Do not ask the person to run commands, know paths, prepare internal formats, or understand implementation details unless they ask for technical detail.

## Opening The App

- When the person asks to open, launch, start, run, or bring up the app, use Forger Desktop app controls.
- In agent work, use the Forger MCP app tools to open the app and to check the app runtime status when needed.
- Do not start app services manually with Python, uvicorn, npm, Vite, FastAPI, or localhost commands just so the person can access the app.
- Treat internal service startup as Desktop runtime work owned by Forger. To the person, the action is opening the app in Forger.

## App Tools

{{mcpSection}}

## Scripts Declared As Internal Tools

{{scriptsSection}}

## App Stack

{{stackSection}}

## Guardrails

- Do not invent app capabilities.
- Do not use files outside this app or outside explicitly shared inputs unless the person asks for that.
- Confirm before broad, destructive, or hard-to-undo changes.
- Keep secret values out of prompts, memory, logs, generated files, and final messages.
- Preserve existing user changes in the app folder.
- Treat generated artifacts from checks or builds as cleanup candidates before finishing app work.
