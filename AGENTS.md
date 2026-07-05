# AGENTS

This repository implements the Forger desktop application. Desktop is the main experience for non-technical users: it installs local apps, opens them, prepares their private environment, and connects chat with an agent that can understand, operate, and adapt those apps.

## Repo Role

- Maintains the Electron + React interface for Forger Desktop.
- Installs apps from the catalog and runs them in a private user workspace.
- Prepares agent context for installed apps.
- Orchestrates chat tasks over installed apps.
- Maintains platform memory that can be injected into Forger chat, app agents, and automations when relevant.
- Maintains local versioning of installed apps when the user asks for functional updates.

## Security Rules

- Keep Electron security as a priority.
- Do not enable `nodeIntegration` in the renderer.
- Keep `contextIsolation` enabled.
- Expose privileged capabilities only through `preload` and `contextBridge`.
- Do not grant access to files outside the private workspace unless the user explicitly shares them.
- Do not present paths, commands, scripts, commits, branches, or manifests as part of the user's normal experience.

## Visual Stack

- The desktop interface uses MUI / Material Design.
- Do not use Tailwind CSS in desktop.
- Communicate actions in simple, functional language.
- For visible changes, talk about screens, buttons, data, flows, and versions.

## Agent Playbooks

The agent internally classifies each user request before acting. If a message contains tasks from different categories, work on one per turn and briefly explain which one is handled first.

## Platform Memory

- Memory is a Desktop platform layer, not an app manifest capability and not an optional official tool.
- Desktop may inject relevant global or app-scoped memories into prompts before the current user message.
- Treat injected memories as context that can guide defaults, wording, and workflow choices; verify current app state before making factual claims.
- Save memory only for durable preferences, stable profile details, recurring workflow choices, constraints, and useful facts that should help future Forger work.
- Do not save secrets, credentials, tokens, private keys, raw sensitive documents, medical or legal inferences, or delicate personal inferences.
- Before creating a memory, fetch existing relevant memory and update or skip duplicates when the new information matches, corrects, or narrows an existing entry.
- Store app-specific information as app-scoped memory. Store cross-Forger preferences and facts as global memory when the current memory access allows a global write.
- When talking to the person, say Forger can remember, update, or forget the preference or fact. Do not describe storage files, tool names, schemas, or prompt injection unless technical detail is requested.

### resolver_dudas

- Review documentation, manifest, and real capabilities of the selected app before responding.
- Answer only with user-visible capabilities.
- If there is no evidence for a capability, say so clearly.
- Do not create versions or modify the app.

### trabajar_datos

- Use only internal app data or files explicitly shared by the user.
- When an installed app declares MCP tools, prefer those tools for structured data operations before scripts, direct database access, or ad hoc endpoint calls.
- Validate consistency before loading, correcting, or transforming data.
- Confirm before destructive or irreversible actions.
- Communicate what was loaded, reviewed, corrected, or left pending.
- Do not create code versions unless the task also requires updating the app; in that case, split turns.

### interactuar_con_aplicacion

- Operate the app using available internal tools when appropriate.
- Prefer app MCP tools when the task needs to read, expose, create, edit, delete, import, or validate app data.
- Translate the result into functional language: what opened, what was reviewed, what happened, and what remains.
- Do not ask the user to run commands or navigate internal folders.
- Do not create code versions.

### actualizar_aplicacion

- Applies when the user asks to change the interface, behavior, functionality, or flow of an installed app.
- Before changing, always ground the scope in Visual + Flow terms.
- Work on one functional change at a time.
- Review the real state of the app before deciding implementation.
- Implementation is up to the agent and is not exposed to the final user.
- Before modifying, verify that the installed app is on a clean version.
- If there are unsaved changes, stop and ask whether the user wants to save that version before continuing.
- On the first user change, create or reuse the internal `user-modified` line of work.
- Each confirmed change creates a saved version.
- The agent auto-applies the change and finally reports what changed visually and which flow the user can test.
- After applying, offer to adjust the result or return to the previous version.
- If the result is far from the request, return to the previous version and redo from the confirmed scope.

## Local Versioning of Installed Apps

- The initial installation of an app creates a local Git repository if one does not exist.
- The installed base version lives on `main`.
- The first installed state is saved as the initial commit.
- User changes live on `user-modified`.
- Technical history is internal. To the user, talk about saved versions and the previous version.

## Installed App Update Playbook

This playbook applies when Forger detects a new published version of an already installed app.

- When refreshing `My Apps`, desktop also checks the published catalog.
- If the catalog version is newer than the installed version, desktop shows an update-available notice.
- If the catalog exposes a changelog, the notice shows the summary and visible changes for that version.
- Opening the installed app remains available while an update is merely available.
- The user can keep their current local version and skip an available update.
- The update is not applied without user action.
- Before updating, the app must be stopped and the user branch must be clean.
- Before modifying files or database, desktop creates a verifiable backup of the installed app local database.
- The backup is associated with the update attempt and is used only for recovery, comparison, or loading data if migration cannot complete.
- Desktop rejects ZIPs that contain Git metadata (`.git` at any level) or unsafe paths.
- Desktop internally switches to `main`, applies the new version while preserving local `.git`, and saves that base as the new published version.
- If the new version declares database migrations, desktop runs them on a controlled copy or after a confirmed backup exists.
- If a migration fails, the app remains stopped and is not presented as updated.
- When migration errors occur, Forger attempts to correct them if the problem is solvable without losing data or inventing information.
- Migration fixes must preserve existing user data and remain associated with the update attempt.
- If the database cannot be safely ported to the new version, Forger explains that the update cannot be completed with the current data.
- In that case, Forger offers three paths: start with a fresh database on the new version, manually load data from the backup, or return to the previous version.
- Then it switches to `user-modified` and attempts to merge `main`.
- If the automatic merge succeeds, the app remains installed on the new version with user customizations preserved.
- If the merge fails, the app enters `conflict` state.
- In `conflict` state, the app cannot be opened because an update attempt is partially applied.
- In `conflict` state, the user can restore their previous version or ask Forger to resolve the conflict.
- Restoring returns to the user state before the update attempt.
- When resolving with the agent, the agent preserves as much as possible from the new version and from the user's customizations.
- If a part cannot be integrated maintainably, the agent leaves it out and communicates the functional impact.
- When a resolution is complete, the agent finishes the merge and saves a new version.

## Workflows

Desktop includes a Flujos (Workflows) module. A workflow is a directed acyclic graph of nodes connected by edges; each node does one unit of work and hands a structured JSON output to the next nodes.

Node types:

- `llm_agent`: runs a one-shot agent with the configured provider (codex, claude, or antigravity), a prompt, enabled platform tools, and enabled apps. Enabling an app starts that app's MCP for the node run. The node prompt supports `{{nodes.<id>.output.<path>}}` and `{{trigger.<path>}}` templates resolved against upstream outputs.
- `forger_agent`: runs a personal agent defined in Forger with that agent's own runtime, instructions, app grants, and tool grants.
- `connector`: executes one official tool action deterministically without an LLM, with template-resolved JSON input.
- `condition`: evaluates an expression over upstream outputs and produces `{ result: boolean }`.

Every node except workflow roots accepts an optional `forEach` reference to a list produced by a previous node: the node runs once per item (sequentially, capped at 100), iteration templates use `{{item.<field>}}` and `{{itemIndex}}`, agent iterations receive the current item in their input context, and the node output becomes `{ items: [...results], count }`. Condition nodes iterating a list also aggregate a top-level `result` that is true only when every item passed, so their branching edges keep working. Iteration stops at the first failing item. A node cannot receive edges from two independent forEach nodes (their iterations cannot be aligned); nested loops are allowed because the inner forEach node is downstream of the outer one.

Edges carry a condition: `success`, `error`, or `always`. On condition nodes, `success` is the true branch and `error` the false branch. A failed node counts as handled when an outgoing `error` or `always` edge routes the failure; unhandled failures fail the run. Independent branches execute in parallel. Nodes marked `requiresApproval` pause the run in `waiting_approval` until the person approves or rejects the step from the Workflows view.

Triggers are manual or scheduled with the same frequency and missed-run policies as automations. Runs persist per-node status, input, output, summary, and a transcript under the metadata root. A single node can also run in isolation as a step run: upstream context is seeded from the latest stored outputs, other nodes are recorded as skipped, and approval pauses are bypassed because the person triggers the step explicitly.

Node inputs and outputs follow one contract: every node produces a JSON object, and every input field accepts a fixed value or a `{{nodes.<id>.output.<path>}}` reference. Connector actions declare an input schema (rendered as a form in the editor) and an output schema; condition nodes always produce `{ result: boolean }`; agent nodes use their declared output schema or the `{ text: string }` fallback. The editor offers upstream fields for mapping from the declared schemas plus the sampled outputs of the latest run, and agent prompts render references as pills with an autocomplete that opens when the person types `{{`.

Agent nodes report their result through Forger MCP tools available only inside workflow node sessions: `workflow_get_context`, `workflow_complete_node` (validates the node's declared output schema), and `workflow_fail_node`. If an agent finishes without reporting, Desktop falls back to the agent's final message as the node output. Chat and personal agents manage workflows through `forger_workflow_list`, `forger_workflow_get`, `forger_workflow_upsert`, and `forger_workflow_run`.

Local connectors (Slack, Trello) are official tools whose credentials are plain tokens the person pastes once; tokens are stored in the local secrets store and validated against the service API. There is no cloud OAuth in this connector layer. New connectors are added with a `TokenConnectorDefinition` in `src/main/tools`.

## Final-User Communication

- Do not mention implementation, files, paths, endpoints, commands, commits, or branches unless explicitly requested.
- Explain functional impact: what changes, where it appears, how to test it, and what remains pending.
- If information is missing, ask about intent, scope, data, or expected behavior.
- If there is a technical blocker, translate it into product language.
