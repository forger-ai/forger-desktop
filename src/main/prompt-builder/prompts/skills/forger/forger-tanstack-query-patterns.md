---
name: forger-tanstack-query-patterns
description: Use when adding or changing Forger React app server state, API reads, mutations, MCP write refresh, assistant task refresh, query keys, invalidation, polling, or cache behavior.
---

- Treat TanStack Query as the client-side server-state layer. Do not use it for local form draft state, purely visual UI state, or data that belongs in backend persistence.
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
- For local-network or remote-tunnel sessions, avoid prefetch patterns that create unnecessary backend traffic. Prefer intent-based loading only when it clearly improves the workflow.
- After MCP tools, assistant tasks, imports, exports, backend jobs, or scripts write app data, invalidate or refetch the exact list/detail/status queries that render the changed data.
- App MCP tools that mutate data should also emit or cause an app-visible refresh signal when the stack provides realtime/websocket support. Frontend handlers should invalidate the affected query keys as those events arrive so views update while agents work.
- Favor fresh operational views over stale data. Polling, websocket events, and task completion invalidation are all acceptable when scoped to the changed feature.
- Do not rely on a full app reload, browser refresh, or broad cache reset as the normal post-write update path. Use realtime events, mutation callbacks, task completion handlers, or explicit query invalidation tied to the changed feature.
