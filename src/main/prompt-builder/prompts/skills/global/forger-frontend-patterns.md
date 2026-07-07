---
name: forger-frontend-patterns
description: Use this skill before any change that affects how a Forger app looks, feels, moves, routes, collects input, displays data, handles agent work, uses UI UX Pro Max design guidance, needs visual identity, persists a visual contract in Forger memory, or behaves on mobile.
---

# Forger Frontend Patterns

Approach Forger app UI as the design lead for a private local tool. The app is not a generic SaaS dashboard, not a landing page, and not a demo. It is a real local workspace for one person, with their data, their routines, and agent-assisted workflows.

The interface must feel intentional, useful, robust, and specific to the app's job. Do not produce a technically valid layout that wastes space, hides work behind decorative surfaces, or breaks under realistic interaction.

## Ground The Design In The App

Before designing or coding, identify:

- The app's concrete job.
- The person using it.
- The primary workflow.
- The expected data density.
- Whether the app is minimalist, operational, chat-first, review-heavy, mobile-heavy, or dashboard-like.
- What should be visible immediately after opening the app.
- What must persist after reload, restart, or route changes.

Choose layout, density, navigation, color, components, and motion from those answers.

## Design Direction

Before coding, use `ui-ux-pro-max` to generate concrete design intelligence for the app. Run its design-system search with a query that names the app's actual job, user, workflow, density, and React/Tailwind/shadcn stack. Search shadcn or UX domains when components, forms, tables, charts, motion, or accessibility are central to the change.

Do not use the upstream `--persist` flag unless the person explicitly asks for design-system files in the app. Forger persists the selected visual contract through memory, not through a `design-system/` folder in the app repository.

Make a compact design plan before coding. Include both the UI UX Pro Max recommendation and the Forger-specific decision:

- `Mode`: minimalist utility, operational panel, chat-first assistant, review workflow, data manager, creative tool, or mobile companion.
- `Density`: sparse, balanced, dense, or high-throughput.
- `Layout`: the shell, routes, main panes, scrolling regions, and persistent controls.
- `Palette`: semantic colors for background, surface, border, primary, accent, destructive, success, warning, and focus.
- `Typography`: heading, body, numeric/data text, label scale, and long-label behavior.
- `Components`: the primitive rules for buttons, forms, tables, cards, dialogs, drawers, charts, and agent progress.
- `Motion`: the exact transitions that support route changes, overlays, task progress, or state changes.
- `Signature`: one specific visual or interaction choice that fits the app and avoids generic template output.
- `Rejected defaults`: name the generic patterns you are intentionally avoiding.

Only start coding after the plan fits the app's actual workflow.

## Persist The Visual Contract

After choosing the design direction, use `forger-memory` and save or update an app-scoped memory for the selected app. Use `memory_list` first to avoid duplicates, then `memory_update` or `memory_create`.

Use this memory shape:

- `scope`: `app`
- `kind`: `constraint`
- `title`: `Visual system`
- `read_when`: `Before creating, editing, reviewing, or visually QAing UI in this app.`
- `body`: the compact visual contract: product pattern, palette tokens, typography, density, layout, component rules, motion, and rejected defaults.

Keep the memory short and future-facing. Do not save screenshots, raw HTML, logs, user data, secrets, or one-off observations.

## General Layout Direction

Minimalist apps should use fewer surfaces, strong hierarchy, direct actions, and calm spacing.

Operational apps should use density, tables, split panes, persistent filters, compact summaries, and visible workflow state.

Chat-first apps should use the available height, a persistent composer, visible run state, and durable message and result history.

Review workflows should emphasize before and after states, pending decisions, apply and undo actions, and clear confirmations.

Do not center a narrow `max-w` container on wide desktop screens when the workflow benefits from comparison, scanning, or side-by-side work.

## Color, Typography, And Visual Identity

Use semantic tokens, not scattered raw colors.

Choose palettes deliberately. Gradients are allowed only when they reinforce product identity or state. Avoid generic purple or blue AI gradients, glow blobs, random dark mode, and one-note palettes.

Typography should support the app's work. Operational tools need readable labels, dense tables, tabular numbers, and restrained headings. More expressive typography is allowed when the app subject benefits from personality, but it must not reduce clarity.

## Anti-Slop Rules

Reject the UI if it has:

- Cards inside cards.
- Cards used as the only page structure.
- Large unused desktop space.
- Repeated headers that restate navigation.
- Pills for ordinary attributes.
- Badge clusters that do not add meaning.
- Decorative status dots everywhere.
- Hero-style typography inside compact tools.
- Hidden primary actions.
- Placeholder-only labels.
- Empty states with no next action.
- Layouts that pass build but fail realistic use.

## Navigation And Views

Use a real router for multi-view apps.

Use persistent side navigation for desktop operational apps. Use top navigation for focused apps with few destinations. Use bottom navigation on mobile only for three to five top-level destinations.

Dashboards summarize and route. They do not contain every form, table, badge, and action.

Each primary model or workflow should have a dedicated view when it needs list, detail, create, edit, delete, review, empty, loading, error, and success states.

## App Shell And Scrolling

Build one shell that owns viewport height, navigation, and the main content slot.

Only the main content pane should scroll. Navigation, sticky composers, app bars, bottom nav, and persistent filters should stay reachable.

Use `100dvh`, `min-h-0`, explicit grid or flex tracks, and reserved space for sticky controls.

Do not let mobile bottom navigation, remote-session controls, or sticky composers cover important actions.

## Forms

Use dialogs for short create or edit forms, quick filters, confirmations, and focused secondary actions.

Use dedicated routes, drawers, or full-page panels for long forms, multi-step flows, imports, bulk edits, review/apply flows, and forms with many selects or dates.

Protect long drafts from accidental dismissal. Destructive actions need confirmation and recovery when possible.

## Overlays And Interactive Components

Use shadcn/Radix primitives for dialogs, selects, dropdowns, popovers, sheets, tooltips, command menus, calendars, and date or time inputs.

Do not hand-roll focus traps, keyboard navigation, outside-click behavior, or custom dropdowns.

When a select, dropdown, popover, calendar, or command menu appears inside a dialog, verify the portalled layer does not close the parent dialog. Solve overlay conflicts in reusable primitives, not with feature-level hacks.

Use `Select` for a known single value. Use `Combobox` for searchable long lists. Use `DropdownMenu` for actions, not form values.

## Data Display And Live Updates

Use readable rows, tables, description lists, split panes, and grouped sections for operational data.

After mutations, imports, agent runs, refresh actions, or background updates, invalidate or refetch affected views.

Persist workflow state in the database when the screen must rehydrate after reload, route changes, service restart, or app reopen.

Show stale, refreshing, saving, success, error, retry, disabled, and empty states.

## Agent Chats

Agent chat screens should not be trapped in small cards.

Use available height. Keep the message list scrollable and the composer sticky. Make the composer visually clear and always reachable.

For Tailwind/shadcn apps, use the local chat primitives when building assistant chats: `Message`, `MessageScroller`, `Attachment`, and `Marker` when the flow needs messages, sticky scrolling, uploaded files, progress markers, or tool/status rows.

Distinguish user messages, assistant messages, tool/progress messages, errors, and system/result states.

Show when the agent is queued, thinking, using tools, applying changes, waiting for approval, complete, failed, or canceled.

Persist messages, active run IDs, proposals, results, cancellation state, and selected conversation so the UI rehydrates correctly.

## Agent Tasks

Agent task screens need:

- A clear form.
- Validation before start.
- Queued, running, and progress state.
- Intermediate output when useful.
- Result display.
- Error recovery.
- Cancellation when available.
- Persisted task history when the result matters after reload.

Never leave a long-running agent task as only a disabled button or spinner.

## Responsive Behavior

Design mobile and desktop as different compositions of the same workflow.

On mobile, use single-column flows, touch targets at least 44px, reachable navigation, safe-area-aware sticky controls, and focused detail screens.

On desktop, use width for comparison, tables, side panels, split views, filters, summaries, and persistent context.

Verify 390px mobile, tablet, and wide desktop with realistic data and long translated labels.

## Motion

Use motion for continuity: route changes, dialogs, drawers, expanding sections, loading-to-result transitions, chat/task progress, and item insertion/removal.

Keep motion subtle and fast. Prefer opacity and transform. Respect reduced motion.

One purposeful animated moment is better than scattered decorative motion.

## Localization And Local Formats

All visible copy belongs in i18n when the app has locale files.

Use the person's or computer's locale for dates, times, numbers, currencies, relative timestamps, and sorting when applicable.

Keep action names consistent across button, toast, dialog, and result text.

Avoid implementation words in visible UI unless the person asks for technical detail.

## Build, Critique, Verify

Work in two passes:

- First pass: build the intended structure and interactions.
- Second pass: critique the UI against the app's workflow and remove generic or decorative choices.

Visual QA is mandatory for visual UI work.

Open, restart, or bring up the installed app through Forger Desktop tools such as `forger_open_app`, `forger_restart_app`, and `forger_get_app_runtime_status`. Do not manually start Python, uvicorn, npm, Vite, FastAPI, or localhost services just to inspect the app.

Use available Forger browser or Chrome Extension actions to inspect the real rendered app: open a dedicated tab when available, wait for selectors, inspect HTML/styles, interact with navigation, forms, dialogs, dropdowns, drawers, and agent progress states, and verify desktop plus narrow mobile behavior when the tool supports it.

Do not substitute `curl`, `/health`, a frontend HTTP response, build, lint, typecheck, or tests for visual QA. Those checks can prove services and code health; they do not prove visual quality.

If browser or visual inspection tools are unavailable, state that visual QA could not be completed and explain which non-visual checks passed. Do not claim the UI is polished or visually verified.

Before finishing, verify:

- Desktop uses space well.
- Mobile is usable.
- No card nesting remains.
- Dialogs with dropdowns and selects behave correctly.
- Loading, empty, error, success, disabled, and stale states exist.
- Agent chat and task states rehydrate from persisted state when required.
- Copy is localized.
- Primary actions are visible.
- The result does not look like a generic generated dashboard.
- The UI UX Pro Max visual contract is reflected in real tokens, layout, components, and motion.
