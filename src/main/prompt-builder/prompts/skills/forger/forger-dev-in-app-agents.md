---
name: forger-dev-in-app-agents
description: Use when designing, implementing, reviewing, or explaining in-app AI flows, including manifest agent threads, promptTemplate tasks, Desktop runtime bridge calls, resumable conversations, progress UI, polling, cancellation, and app-visible results.
---

## Flow Types
- App agents are app-declared conversational coworkers that can hold a thread, resume prior context, accept follow-up steering, and keep working with the person over multiple turns.
- Use app agents when an app needs an advisor, reviewer, orchestrator, specialist, or AI-powered chat flow that benefits from ongoing conversation state.
- Prompt template tasks are app-declared one-shot jobs with a bounded input form and one clear result.
- Use prompt template tasks for imports, reviews, conversions, classifications, summaries, document extraction, recommendations, and other work that should finish without an ongoing conversation.
- Use an app agent instead of a prompt template task when the work needs back-and-forth discussion, steering, or resume.

## Desktop Runtime Bridge
- The current `vite-fastapi-sqlite` stack provides the backend helper in `commons/backend/forger_desktop.py`.
- Keep the frontend browser-safe. The frontend calls the app backend over normal HTTP routes; it must not call Desktop directly, use Electron APIs, read Desktop secrets, or depend on `window.forgerApp`.
- The app backend owns validation, size limits, file preprocessing, argument shaping, error mapping, and calls to `forger_desktop.py`.
- Forger Desktop injects `FORGER_DESKTOP_RUNTIME_URL`, `FORGER_DESKTOP_RUNTIME_APP_ID`, and `FORGER_DESKTOP_RUNTIME_SECRET` into app services. Do not hard-code or expose those values.
- App locale/context also travels through this signed HTTP bridge. For stack apps, expose it to the frontend through the app backend route `GET /api/forger/context` and the shared locale module; do not revive `window.forgerApp`.
- Treat this bridge as an internal app mechanism. Explain visible progress and results, not runtime URLs, signatures, routes, or secrets.
- This bridge is not how an agent opens an app for the person. Opening, launching, starting, running, or bringing up an installed app means using Forger Desktop app controls through the Forger MCP app tools: use `forger_open_app` to open the app and `forger_get_app_runtime_status` to check whether Forger has it running when needed. Do not manually start Python, uvicorn, npm, Vite, FastAPI, or localhost services just so the person can access the app.

## Prompt Template Tasks
- Backend routes should describe the visible app flow, not Desktop internals. Common route shapes include `/api/assistant/status`, `/api/assistant/tasks/<task-name>`, `/api/assistant/tasks/{run_id}`, and `/api/assistant/tasks/{run_id}/cancel`.
- From the backend, import `get_agent_task_status`, `start_agent_task`, `get_agent_task`, `cancel_agent_task`, and optionally `wait_for_task` from `app.forger_desktop`.
- Start a task with `start_agent_task(template_id="<manifest-template-id>", locale=locale, arguments=arguments)`.
- `arguments` must match the prompt template argument names. Use typed objects such as `{ "type": "string", "value": "..." }` for text values and `{ "type": "file", "name": "...", "mimeType": "...", "dataBase64": "..." }` for file values when the app passes files through the backend.
- Validate allowed template ids in the backend instead of trusting arbitrary frontend input.
- Poll task state with `get_agent_task(run_id)` and expose only safe public fields to the frontend.
- Cancel task state with `cancel_agent_task(run_id)`.
- Map `ForgerDesktopRuntimeUnavailable` to a user-facing unavailable state or HTTP 503. Map `ForgerDesktopRuntimeError` to a controlled HTTP error without leaking secrets.
- Finance OS is the reference pattern: `frontend/src/api/assistant.ts` calls `/api/assistant/...`; `backend/src/app/routes/assistant.py` validates files, preprocesses documents, calls `start_agent_task`, and exposes polling/cancel routes.

## Manifest Agent Threads
- Manifest agent threads are resumable coworkers declared in `manifest.agents`, such as advisors, reviewers, or orchestrators that continue across messages.
- From the backend, import `start_manifest_agent_thread`, `resume_manifest_agent_thread`, `steer_manifest_agent_run`, `get_agent_thread`, `get_agent_run`, `cancel_agent_run`, and optionally `wait_for_run` from `app.forger_desktop`.
- Start a manifest agent thread with `start_manifest_agent_thread(agent_id="<manifest-agent-id>", title=..., variables={...}, metadata=..., workspace_path=...)`. The `variables` object must match that agent's `prompts.initial.variables` declaration.
- Resume a manifest agent thread with `resume_manifest_agent_thread(desktop_thread_id=thread_id, variables={...}, workspace_path=...)`. The `variables` object must match that agent's `prompts.resume.variables` declaration.
- Steer an active manifest agent run with `steer_manifest_agent_run(desktop_thread_id=thread_id, desktop_run_id=run_id, variables={...}, workspace_path=...)`. The `variables` object must match that agent's `prompts.steer.variables` declaration.
- For grant-aware flows, pass a `workspace` object instead of raw folder paths: `workspace={ "cwdGrantId": "...", "additionalFolderGrantIds": ["..."] }`. `cwdGrantId` selects the approved working folder for the run. `additionalFolderGrantIds` lists other Forger-approved folders the run may reference.
- `workspace_path` is legacy and constrained to app-private paths inside the installed app workspace. Use it only for app-owned subdirectories, never for arbitrary external folders, home directories, mounted drives, or paths supplied directly by a person.
- External folder access belongs to Forger folder grants. The app backend should store and pass grant ids, validate that each grant belongs to the current app/workflow, and let Desktop resolve approved filesystem scope. The returned full paths may be stored or placed in prompts as user-visible context, but they are descriptive data only; the grant ids remain the permission handles.
- Do not start new agent work with the removed freeform endpoints `POST /agent-threads` or `POST /agent-threads/{thread_id}/runs`. Those endpoints return a removed-bridge error in current Desktop builds.
- Poll with `get_agent_run(thread_id, run_id)` and cancel with `cancel_agent_run(thread_id, run_id)`.
- Store Desktop thread ids and run ids in app tables only when the app needs resumable visible state. Use explicit relational columns, not JSON blobs, unless the metadata is genuinely schemaless.
- Keep app-owned data and app validations in the app backend. Desktop agent runs should call app MCP tools or app APIs to perform structured data changes instead of bypassing validations.

## App UI And Refresh
- App agents and task agents should use the app's MCP tools or app APIs to interact with app data through app-owned validation.
- MCP writes, assistant task completion, and agent-generated changes should trigger an app-visible refresh so the person can see what the agent is doing while it works.
- Design React applications with TanStack Query for live server-state refresh, targeted invalidation, polling, or realtime event handling around the affected feature.
- Agent-facing UI should make the run state visible. Show whether the agent is queued, running, waiting for permission, completed, failed, canceled, or ready for another round.
- Progress updates should be clear to the person. Ephemeral progress is fine, but persist progress when the user needs to leave the view and return later.
- When the person changes views or reloads an agent-thread conversation, maintain consistent state: show whether the agent is still thinking, resume live updates when available, and show the final output when the run is done.
- Keep task output product-facing: what was reviewed, produced, changed, rejected, or needs confirmation.

## Manifest And Permission Fit
- Use `forger-manifest-authoring` when writing the exact `manifest.json` shape for agents or prompt templates.
- Choose `permissionMode` consciously for each app agent and prompt template. Use `"safe"` unless that specific agent or task has a concrete need for elevated filesystem access.
- `permissionMode` does not create folder grants. If an app agent or conversation flow needs external folders, the manifest must declare `platformCapabilities.workspaceFolders`, the user must grant folders through Forger, and the run should receive `workspace.cwdGrantId` plus any `workspace.additionalFolderGrantIds`.
- Keep final product behavior clear: what the AI flow helps with, what inputs it expects, and what result it should produce.

## Implementation Checklist
- Confirm the manifest declares the prompt template or agent id before wiring UI controls to it.
- Add backend routes and schemas that describe the visible app flow, not Desktop internals.
- Add frontend API helpers that call the app backend and poll terminal statuses: `completed`, `failed`, and `canceled`.
- Add BDD/spec coverage for available runtime, unavailable runtime, Desktop runtime errors, input validation, polling, cancellation, and visible refresh after writes.
- Keep progress copy functional: queued, running, needs permission, completed, failed, canceled.
- Do not ask the person to run commands, know template ids, or understand Desktop runtime routes.
