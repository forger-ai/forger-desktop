---
name: forger-frontend-patterns
description: Use when creating or changing Forger app frontend code, UX, routed views, forms, responsive layouts, visual systems, Tailwind/shadcn components, interaction states, motion, accessibility, and final UI review.
---

## Frontend Default

- Forger app frontends use Tailwind CSS, shadcn/ui copied components, and Radix primitives by default.
- Apply these rules before creating or changing any app UI. Keep `forger-dev-backend-development` separate for FastAPI route contracts, server-state reads, mutations, MCP writes, realtime refresh, polling, migrations, and cache behavior.
- Use feature-first structure: `frontend/src/app` for shell, router, providers, and root wiring; `frontend/src/features/<area>` for domain views and feature-local components; `frontend/src/components` for shared app components; `frontend/src/components/ui` for shadcn primitives; `frontend/src/api` for backend contracts; `frontend/src/lib` for pure helpers; `frontend/src/i18n` for visible copy; `frontend/src/styles` or `frontend/src/design-system` for tokens.
- Keep `App.tsx` thin. Visual components render state and intent; backend persistence, validation, privileged Forger access, imports, scripts, MCP tools, and secrets stay in backend routes, app contracts, or API modules.

## Design Read

- Before designing, read the app purpose, audience, workflow, existing app state, visual direction, data density, privacy boundary, and mobile expectation.
- Infer the app kind, target person, daily workflow, privacy sensitivity, expected data density, mobile use, and visual direction before choosing layout, color, components, or motion.
- Choose the aesthetic from the job the app does and the person using it. A private operations app, a personal tracker, a review workflow, and a social sharing surface should not all get the same layout rhythm or visual polish.
- State the design read internally before coding: app kind, audience, workflow mood, density, visual language, and which defaults you are intentionally avoiding.
- Do not default to generic AI-purple gradients, decorative card grids, centered hero layouts, glass everywhere, identical feature rows, repeated eyebrows, badges for every attribute, or status dots on every row.
- Choose visual dials deliberately: design variance, motion intensity, and visual density. Operational apps usually need higher density, clearer hierarchy, visible workflow state, and fewer decorative surfaces than marketing pages.
- Lock consistency early: one radius logic, one accent logic, one density level, one icon family, one hierarchy system, and complete loading, empty, error, success, saving, disabled, and stale states.

## Routes And Screen Structure

- Use TanStack Router for new routed Forger apps unless the existing app already has a different router.
- Apps with more than one primary destination need visible navigation. Desktop/tablet uses a persistent side rail or drawer. Mobile uses bottom navigation for three to five destinations, or a visible menu trigger with drawer for larger navigation sets.
- Build a single app shell that owns viewport height, primary navigation, and the main content slot. The main content slot scrolls; navigation stays visible.
- Dashboards summarize and route. They do not contain all forms, full tables, every action, every badge, or every chart.
- Each primary model, workflow, or domain area gets its own route or dedicated view with list, create action, edit flow, delete action, detail state, empty state, loading state, error state, and success feedback when those behaviors exist.
- Use tabs only for peer subviews inside one destination. Do not use tabs as global navigation.
- Short create/edit forms, quick filters, confirmations, and secondary panels may use dialogs, sheets, or drawers. Long forms, imports, multi-step flows, bulk edits, and review/apply flows need a dedicated route or view.

## Component-First shadcn

- Before writing custom JSX, identify the behavior needed: form field, date input, time input, select, combobox, dialog, sheet, drawer, dropdown, popover, tabs, tooltip, accordion, command menu, toast, table, badge, alert, skeleton, empty state, card, separator, or navigation control.
- First list local components already implemented in `frontend/src/components/ui`, `components.json`, `frontend/package.json`, lockfile, local shared components, and existing `@radix-ui/*` dependencies.
- Then list components available from the online shadcn registry, because a new or local app workspace may not have every useful component copied yet: `cd "$APP_ROOT/frontend" && npm exec --yes shadcn@latest -- list @shadcn --limit 200 --cwd .`.
- Search the registry for the concrete need before deciding it is unavailable: `cd "$APP_ROOT/frontend" && npm exec --yes shadcn@latest -- search @shadcn --query "date" --limit 50 --cwd .`. Use targeted queries such as `date`, `time`, `calendar`, `dialog`, `popover`, `select`, `combobox`, `form`, `table`, or `command`.
- Prefer existing app primitives from `@/components/ui/*` first; if the primitive is missing but exists in the registry, install or copy it with `cd "$APP_ROOT/frontend" && npm exec --yes shadcn@latest -- add <component> --cwd .`, then review the copied code before using it.
- After adding or copying a shadcn component, verify `frontend/src/styles/globals.css` defines every semantic Tailwind token referenced by that component. Common required tokens include `background`, `foreground`, `card`, `popover`, `input`, `ring`, `accent`, and foreground pairs. Fix missing tokens before using the component.
- Keep direct `@radix-ui/*` imports inside reusable `frontend/src/components/ui/*` primitives. Feature views import local wrappers from `@/components/ui/*`.
- Forms must prefer shadcn/Radix for complex controls. For date and time fields, check `calendar`, `popover`, `input`, `select`, `form`, `dialog`, `sheet`, `command`, and related dependencies such as `react-day-picker` before building a custom control.
- Use `Select` for choosing exactly one value from a known subset. Use `DropdownMenu` for command/action menus. Do not use an action dropdown as a form selector when the value should remain visible.
- Do not hand-roll selects, menus, dialogs, popovers, drawers, focus traps, keyboard navigation, toasts, tooltips, date inputs, time inputs, or calendars when local components or online shadcn/Radix components cover the behavior.
- Only create custom UI when local primitives and the online shadcn/Radix registry cannot cover the concrete need. Prefer composition over new primitives and keep custom behavior narrow.

## Anti-Overload Rules

- Pills and badges are for compact status, category, priority, count, or permission labels. Do not turn ordinary attributes into pills.
- Do not use decorative status dots, repeated colored indicators, or badge clusters unless each indicator communicates real semantic state.
- Cards are for repeated items, focused summaries, isolated tools, or one coherent decision surface. If a surface does not need separation as a real unit of work, decision, summary, or repeated item, use rows, sections, tables, dividers, labels, headings, spacing, or split panes instead.
- Do not put cards inside cards. If hierarchy is unclear, use headings, sections, spacing, dividers, tabs, accordions, description lists, tables, or split panes.
- Do not use Card, Sheet, Dialog, or framed surfaces as generic padding containers for whole pages.
- Use plain rows, sections, tables, description lists, and grouped forms for readable operational data. Dense views should stay scannable, not decorative.
- Avoid one-note palettes, unrelated accent colors, and mixed shape systems. Choose semantic tokens and keep accent, radius, spacing, and surface rules consistent across the app.

## Responsiveness

- Mobile responsive is required unless the person explicitly says it is not required.
- Define mobile behavior before coding: navigation, primary actions, lists/tables, forms, validation, empty/loading/error/success states, destructive confirmations, and remote-session controls.
- Use Tailwind responsive variants, `min-h-dvh`, `min-h-0`, explicit content scrollers, grid/flex layouts, stable dimensions, and container constraints.
- Keep touch targets at least 44 px tall on mobile.
- Collapse wide tables into cards, grouped rows, or focused detail views when phone width cannot support the table. Avoid horizontal scrolling unless side-by-side comparison is essential.
- Verify around 390 px mobile width and 1280 px desktop width with realistic data, long labels, loading states, empty states, errors, success states, and destructive confirmations.

## Motion And Feedback

- Use motion for view transitions, route changes, drawers, dialogs, toasts, empty-state swaps, expanding panels, and elements that appear or disappear.
- Keep operational motion fast and purposeful. Use transitions to clarify continuity, not to decorate every card.
- Respect reduced-motion preferences. Disable or simplify nonessential motion when reduced motion is active.
- Every mutation or long-running task needs visible pending, success, error, disabled, stale, and retry states. Assistant work should show queued, running, applying, complete, failed, or canceled states when relevant.

## Final Review

- Review the app as a private local tool, not a public marketing site. Ignore SEO, signup funnels, public analytics, remote stock imagery, and SaaS landing-page assumptions unless the app explicitly needs them.
- Check that navigation remains visible while long content scrolls.
- Check that dashboards route to work views instead of becoming the whole app.
- Check that local shadcn components and the online shadcn registry were listed before custom controls were created.
- Check that forms, date inputs, time inputs, dialogs, selects, popovers, and calendars use shadcn/Radix components when available locally or online.
- Check that visible copy is localized when the app has i18n and avoids implementation terms unless the person asks for technical detail.
- Check that no generic AI-default visual pattern, unnecessary pill, nested card, hidden primary action, stale data state, or mobile overlap remains.
