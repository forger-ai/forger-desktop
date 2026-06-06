---
name: forger-dev-backend-development
description: Use when creating or changing Forger app backend behavior, including FastAPI routes, SQLModel or SQLite persistence, migrations, validation, local data safety, API contracts, TanStack Query server-state refresh, MCP write refresh, polling, realtime updates, and backend tests.
---

## Backend Role
- Keep FastAPI as the local app service layer. Desktop owns app startup, ports, runtime environment, and installed-app lifecycle.
- Use the app's existing dependency manager and stack conventions, usually `uv` in `vite-fastapi-sqlite` apps. Do not replace service startup with ad hoc `pip install` or manual `fastapi dev` instructions.
- Keep domain validations before persisting data. Validate required fields, ranges, ownership, duplicates, state transitions, and destructive operations before writing to SQLite.
- Keep persistence and file work inside the app-private workspace unless the user explicitly shared a file for the task.
- Secrets are declarations and runtime-injected values. Do not add credentials to manifests, logs, tests, prompt text, memory, or committed files.
- Prefer clear, testable changes that are easy to revert.

## FastAPI Route Contracts
- Define typed Pydantic request and response models for route boundaries. Do not return raw database models directly to the frontend.
- Keep response fields stable once the frontend depends on them. If a field must change, update API types, feature hooks, UI states, and tests together.
- Use `response_model`, explicit status codes, and structured error responses where the app already has a response pattern.
- Raise `HTTPException` or the app's existing error helper for expected request errors. Do not leak stack traces, local paths, secrets, SQL details, or raw exception messages.
- Keep HTTP semantics consistent: use the right method, status code, idempotency expectation, and error shape for the workflow.
- Keep dependencies small and injectable: database sessions, current app context, file-library access, Desktop bridge helpers, and settings should be dependency-provided, not hidden globals.
- File routes may only read app-private workspace files or files explicitly shared by the user. Do not browse arbitrary external filesystem paths.
- CORS and remote access behavior must respect Forger Desktop local-network and remote-tunnel ownership. Do not expose independent tunnels or public services from the app backend.
- Use sync endpoints for sync work and async endpoints only when the implementation avoids blocking I/O. Do not run blocking database/file operations inside async code without the app's established pattern.

## SQLModel, SQLite, And Migrations
- Prefer explicit SQLModel/SQLite columns and relationships. Do not add JSON columns unless the data is genuinely schemaless and the reason is documented.
- Model app-owned data with relational tables, typed columns, indexes, and constraints that match the app workflow.
- Migrations must preserve existing user data. Back up or test against representative data when changing tables, columns, constraints, or indexes.
- Keep migration scripts deterministic and idempotent where the stack expects repeatable local app updates.
- Avoid breaking payload compatibility without explaining the impact and updating the matching frontend API types, route tests, and UI states.

## Frontend Server-State Contract
- Treat TanStack Query as the client-side server-state layer for FastAPI-backed data. Do not use it for local form draft state, purely visual UI state, or data that belongs in backend persistence.
- Keep API contracts in `frontend/src/api` or the app's existing API module. UI components should call feature hooks, not raw `fetch` scattered across screens.
- If the app already uses TanStack Query, do not add a parallel manual refresh system for the same server state. Invalidate or refetch the affected query keys.
- If an existing app does not use TanStack Query, do not migrate the whole app for a small change. For new server-state features, create feature-owned API modules, hooks, and stable query keys.
- Use array query keys only. Include every variable that changes the request result, including IDs, filters, search terms, date ranges, locale-sensitive values, and pagination state.
- Prefer query-key factories for non-trivial apps, for example `entriesKeys.all`, `entriesKeys.list(filters)`, and `entriesKeys.detail(id)`. Keep keys serializable.
- Set `staleTime` based on volatility. Static configuration can stay fresh longer; task status, imports, sync, and agent-generated results usually need shorter freshness or explicit invalidation.
- Use targeted invalidation after mutations. Invalidate the affected list/detail keys instead of broad cache resets unless the mutation changes many independent views.
- For mutations, model the full lifecycle: pending, success, error, rollback if optimistic, and the visible state after invalidation or refetch completes.
- Use optimistic updates only when the rollback is clear and data loss cannot occur. Prefer explicit pending states for destructive, expensive, or assistant-generated work.
- Cancel or ignore obsolete requests when filters, selected records, or app context change. Do not let stale responses overwrite newer user intent.
- Use `select` for cheap view-specific transforms, but keep domain normalization and persistence rules in the API/backend layer.
- Use `useMutationState` or equivalent feature-owned state when multiple components need to reflect the same mutation progress.
- Avoid default offline query persistence. It changes local data semantics and must be an explicit app-level decision.
- Do not apply SSR, SSG, dehydration, or server-component TanStack patterns to the default Forger Vite SPA stack.

## MCP Writes, Jobs, Polling, And Realtime
- After MCP tools, assistant tasks, imports, exports, backend jobs, or scripts write app data, invalidate or refetch the exact list/detail/status queries that render the changed data.
- App MCP tools that mutate data should also emit or cause an app-visible refresh signal when the stack provides realtime or websocket support. Frontend handlers should invalidate the affected query keys as those events arrive so views update while agents work.
- Favor fresh operational views over stale data. Polling, websocket events, and task completion invalidation are all acceptable when scoped to the changed feature.
- For local-network or remote-tunnel sessions, avoid prefetch patterns that create unnecessary backend traffic. Prefer intent-based loading only when it clearly improves the workflow.
- Do not rely on a full app reload, browser refresh, or broad cache reset as the normal post-write update path. Use realtime events, mutation callbacks, task completion handlers, or explicit query invalidation tied to the changed feature.

## Testing
- Test route behavior through realistic API flows, including validation errors, empty states, persistence, and frontend-compatible response shapes.
- Test realistic backend flows instead of only isolated helpers when routes, models, migrations, imports, or assistant-backed workflows change.
- Cover migration behavior for existing data, new installs, invalid inputs, duplicates, destructive operations, and failed writes when the change touches persistence.
- Cover server-state refresh when backend writes, MCP writes, assistant tasks, imports, exports, jobs, polling, or realtime events change the data displayed by the UI.
