---
name: forger-frontend-product-patterns
description: Use when creating or changing Forger app dashboards, CRUD screens, forms, data views, assistant task surfaces, multi-step workflows, or screen structure before choosing stack-specific UI skills.
---

## Product Flow First

- Start with the person's workflow: what they need to load, review, create, edit, delete, import, export, approve, or ask an app assistant to do.
- Define the first useful version as screens and flows before component details: dashboard, feature views, list/detail/edit flows, destructive confirmations, and result feedback.
- Prefer dedicated views for each primary feature or data model. A useful default is dashboard plus feature views, with each feature owning its list, create action, edit flow, delete action, details, empty state, and error state.
- Do not overload dashboards with every form, table, badge, and action. Dashboards summarize and route; feature views let the person do the work.
- Use pills and badges sparingly for compact status, category, priority, count, or permission labels. Do not turn every attribute into a pill; use rows, sections, labels, tables, or detail panels when the information needs comparison or reading.
- Keep primary actions visible, consistent, and close to the object they affect. Destructive actions need clear confirmation and a recovery path when the data is important.
- Show explicit loading, empty, error, success, saving, disabled, and stale-data states. Long-running work needs progress or step feedback, not a frozen button.
- When changing views, revalidate or reload data when the underlying feature can change outside the current screen, after mutations, or after assistant work completes. Preserve local draft form state unless the user intentionally leaves or resets it.
- For agent threads, promptTemplate tasks, imports, exports, and background jobs, show intermediate steps visually: queued, running, waiting for approval, applying result, complete, failed, or canceled.
- Keep user-facing copy localized when the app has i18n. Avoid hard-coded UI text inside feature components.
- The frontend sends user intent and renders state. Validation, persistence, privileged Forger access, imports, MCP tools, scripts, and secrets stay in the backend or declared app contracts.

## Detect The Frontend Stack

- Inspect the real app before selecting implementation guidance: `manifest.json`, `frontend/package.json`, lockfile, `components.json`, Tailwind config or CSS token files, theme setup, imports, `frontend/src/components/ui`, and existing app shell files.
- For all React app UI work, reference `forger-frontend-structure`, `forger-react-ui`, and `forger-app-shell-layout`.
- When visible text changes, reference `forger-localization` and update every supported app locale together.
- When the work touches fetching, mutations, cache refresh, polling, or status data, reference `forger-tanstack-query-patterns`.

## Tailwind, shadcn, And Radix Apps

- Detect this stack from `components.json`, `frontend/src/components/ui`, Tailwind config or `@theme` CSS, `tailwindcss`, `@tailwindcss/vite`, `class-variance-authority`, `tailwind-merge`, `@radix-ui/*`, or manifest `frontend.ui` values such as `tailwind-shadcn-radix`.
- Reference `forger-tailwind-design-patterns` before changing tokens, layout styling, colors, spacing, radii, shadows, dark mode, or reusable Tailwind patterns.
- Reference `forger-tailwind-shadcn-patterns` before creating controls, forms, dialogs, popovers, selects, tabs, dropdowns, tooltips, cards, alerts, skeletons, empty states, or copied `components/ui` primitives.
- Reference `forger-tailwind-responsive-frontend` for mobile and desktop layout behavior in Tailwind/shadcn apps.
- Do not use MUI APIs, Emotion themes, `sx`, or MUI examples in Tailwind/shadcn apps unless the user explicitly asks for a stack migration.

## MUI Apps

- Detect this stack from `@mui/material`, `@mui/icons-material`, `@mui/x-*`, Emotion theme setup, MUI imports, Desktop UI files, or manifest `frontend.ui` values such as `mui`.
- Reference `forger-mui-design-patterns` before changing MUI layout, density, surfaces, theme use, or interaction patterns.
- Reference `forger-mui-component-patterns` before hand-rolling forms, searchable tables, charts, cards, panels, dialogs, accordions, tabs, menus, or snackbars in MUI surfaces.
- Reference `forger-mui-date-pickers` for date, time, schedule, due-date, reporting-period, or temporal filter inputs.
- Reference `forger-mui-consistency` before final UI review on Desktop or MUI apps.
- Do not introduce Tailwind, shadcn/ui, Radix, or Headless UI into MUI surfaces unless the user explicitly asks for a stack migration.

## Responsive And Review Checks

- Reference `forger-mobile-responsive-frontend` for stack-agnostic mobile/desktop constraints and `forger-web-interface-review` before accepting a visible UI result.
- Verify realistic data, long labels, loading, empty, error, success, disabled, and destructive-confirmation states at mobile and desktop widths.
