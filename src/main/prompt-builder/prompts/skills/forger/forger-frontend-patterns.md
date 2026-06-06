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
- TasteSkill-inspired short rules: "Read the Room Before Anything Else"; "Anti-Default Discipline"; "The audience picks the aesthetic, not your taste."
- State the design read internally before coding: app kind, audience, workflow mood, density, and visual language.
- Do not default to generic AI-purple gradients, decorative card grids, centered hero layouts, glass everywhere, identical feature cards, or status dots on every row.
- Choose visual dials deliberately: design variance, motion intensity, and visual density. Operational apps usually need higher density, clearer hierarchy, and fewer decorative surfaces than marketing pages.

## Routes And Screen Structure

- Use TanStack Router for new routed Forger apps unless the existing app already has a different router.
- Apps with more than one primary destination need visible navigation. Desktop/tablet uses a persistent side rail or drawer. Mobile uses bottom navigation for three to five destinations, or a visible menu trigger with drawer for larger navigation sets.
- Build a single app shell that owns viewport height, primary navigation, and the main content slot. The main content slot scrolls; navigation stays visible.
- Dashboards summarize and route. They do not contain all forms, full tables, every action, every badge, or every chart.
- Each primary model, workflow, or domain area gets its own route or dedicated view with list, create action, edit flow, delete action, detail state, empty state, loading state, error state, and success feedback when those behaviors exist.
- Use tabs only for peer subviews inside one destination. Do not use tabs as global navigation.
- Short create/edit forms, quick filters, confirmations, and secondary panels may use dialogs, sheets, or drawers. Long forms, imports, multi-step flows, bulk edits, and review/apply flows need a dedicated route or view.

## Component-First shadcn

- Before writing custom JSX, list the existing components available in `frontend/src/components/ui`, `components.json`, package dependencies, and local shared components.
- Prefer existing shadcn primitives and local wrappers. Use and modify copied shadcn components as the normal pattern.
- If a needed primitive is missing, add the matching shadcn component through the app package manager and shadcn CLI or registry, then review the copied code before using it.
- Keep direct `@radix-ui/*` imports inside reusable `frontend/src/components/ui/*` primitives. Feature views import local wrappers from `@/components/ui/*`.
- Do not hand-roll selects, menus, dialogs, popovers, drawers, focus traps, keyboard navigation, toasts, tooltips, or date inputs when shadcn/Radix covers the behavior.
- Only create custom UI when local components and shadcn/Radix cannot cover the concrete behavior. Prefer composition over new primitives.

## Anti-Overload Rules

- Pills and badges are for compact status, category, priority, count, or permission labels. Do not turn ordinary attributes into pills.
- Do not use decorative status dots, repeated colored indicators, or badge clusters unless each indicator communicates real semantic state.
- Cards are for repeated items, focused summaries, isolated tools, or one coherent decision surface. TasteSkill-inspired rule: "Use cards ONLY when elevation communicates real hierarchy."
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
- Check that shadcn components were listed and reused before custom controls were created.
- Check that visible copy is localized when the app has i18n and avoids implementation terms unless the person asks for technical detail.
- Check that no generic AI-default visual pattern, unnecessary pill, nested card, hidden primary action, stale data state, or mobile overlap remains.
