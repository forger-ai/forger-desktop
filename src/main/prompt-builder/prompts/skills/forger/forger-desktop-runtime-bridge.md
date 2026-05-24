---
name: forger-desktop-runtime-bridge
description: Call Forger Desktop prompt templates and manifest agents from a local app backend.
---

- Use this skill when an app UI needs to start, poll, cancel, or resume Forger assistant work from inside the app.
- The current `vite-fastapi-sqlite` stack provides the backend helper in `commons/backend/forger_desktop.py`.
- Keep the frontend browser-safe. The frontend must call the app backend over normal HTTP routes; it must not call Desktop directly, use Electron APIs, read Desktop secrets, or depend on `window.forgerApp`.
- The app backend owns validation, size limits, file preprocessing, argument shaping, error mapping, and calls to `forger_desktop.py`.
- Forger Desktop injects `FORGER_DESKTOP_RUNTIME_URL`, `FORGER_DESKTOP_RUNTIME_APP_ID`, and `FORGER_DESKTOP_RUNTIME_SECRET` into app services. Do not hard-code or expose those values.
- Treat this bridge as an internal app mechanism. Explain visible progress and results, not runtime URLs, signatures, routes, or secrets.

## Prompt Template Tasks
- Use prompt template tasks for bounded, form-backed work declared in `manifest.promptTemplates`, such as reading uploaded statements, extracting rows, or producing a recommendation.
- Backend pattern: expose app routes like `/api/assistant/status`, `/api/assistant/tasks/<task-name>`, `/api/assistant/tasks/{run_id}`, and `/api/assistant/tasks/{run_id}/cancel`.
- From the backend, import `get_agent_task_status`, `start_agent_task`, `get_agent_task`, `cancel_agent_task`, and optionally `wait_for_task` from `app.forger_desktop`.
- Start a task with `start_agent_task(template_id="<manifest-template-id>", locale=locale, arguments=arguments)`.
- `arguments` must match the prompt template argument names. Use typed objects such as `{ "type": "string", "value": "..." }` for text values and `{ "type": "file", "name": "...", "mimeType": "...", "dataBase64": "..." }` for file values when the app passes files through the backend.
- Validate allowed template ids in the backend instead of trusting arbitrary frontend input.
- Poll task state with `get_agent_task(run_id)` and expose only safe public fields to the frontend.
- Cancel task state with `cancel_agent_task(run_id)`.
- Map `ForgerDesktopRuntimeUnavailable` to a user-facing unavailable state or HTTP 503. Map `ForgerDesktopRuntimeError` to a controlled HTTP error without leaking secrets.
- Finance OS is the reference pattern: `frontend/src/api/assistant.ts` calls `/api/assistant/...`; `backend/src/app/routes/assistant.py` validates files, preprocesses documents, calls `start_agent_task`, and exposes polling/cancel routes.

## Manifest Agent Threads
- Use manifest agent threads for resumable coworkers declared in `manifest.agents`, such as advisors, reviewers, or orchestrators that continue across messages.
- From the backend, import `create_agent_thread`, `start_agent_run`, `get_agent_thread`, `get_agent_run`, `cancel_agent_run`, and optionally `wait_for_run` from `app.forger_desktop`.
- Create a thread with `create_agent_thread(title=..., manifest_agent_id="<manifest-agent-id>", initial_prompt=..., metadata=..., workspace_path=...)`.
- Start work in that thread with `start_agent_run(desktop_thread_id=thread_id, message=..., context=..., workspace_path=...)`.
- Poll with `get_agent_run(thread_id, run_id)` and cancel with `cancel_agent_run(thread_id, run_id)`.
- Store Desktop thread ids and run ids in app tables only when the app needs resumable visible state. Use explicit relational columns, not JSON blobs, unless the metadata is genuinely schemaless.
- Keep app-owned data and app validations in the app backend. Desktop agent runs should call app MCP tools or app APIs to perform structured data changes instead of bypassing validations.

## Implementation Checklist
- Confirm the manifest declares the prompt template or agent id before wiring UI controls to it.
- Add backend routes and schemas that describe the visible app flow, not Desktop internals.
- Add frontend API helpers that call the app backend and poll terminal statuses: `completed`, `failed`, and `canceled`.
- Add BDD/spec coverage for available runtime, unavailable runtime, Desktop runtime errors, input validation, polling, and cancellation.
- Keep progress copy functional: queued, running, needs permission, completed, failed, canceled.
- Do not ask the person to run commands, know template ids, or understand Desktop runtime routes.
