---
name: forger-frontend-product-patterns
description: Use this before creating or changing Forger app screens so product flows stay clear across any frontend UI stack.
---

- Use this skill before building dashboards, CRUD views, forms, data views, assistant task surfaces, or multi-step workflows in a Forger app.
- Prefer dedicated views for each primary feature or data model. A useful default is dashboard plus feature views, with each feature owning its list, create action, edit flow, delete action, details, empty state, and error state.
- Do not overload dashboards with every form, table, badge, and action. Dashboards summarize and route; feature views let the person do the work.
- Use pills and badges sparingly for compact status, category, priority, count, or permission labels. Do not turn every attribute into a pill; use rows, sections, labels, tables, or detail panels when the information needs comparison or reading.
- Keep primary actions visible, consistent, and close to the object they affect. Destructive actions need clear confirmation and a recovery path when the data is important.
- Show explicit loading, empty, error, success, saving, disabled, and stale-data states. Long-running work needs progress or step feedback, not a frozen button.
- When changing views, revalidate or reload data when the underlying feature can change outside the current screen, after mutations, or after assistant work completes. Preserve local draft form state unless the user intentionally leaves or resets it.
- For agent threads, promptTemplate tasks, imports, exports, and background jobs, show intermediate steps visually: queued, running, waiting for approval, applying result, complete, failed, or canceled.
- Keep user-facing copy localized when the app has i18n. Avoid hard-coded UI text inside feature components.
- The frontend sends user intent and renders state. Validation, persistence, privileged Forger access, imports, MCP tools, scripts, and secrets stay in the backend or declared app contracts.
