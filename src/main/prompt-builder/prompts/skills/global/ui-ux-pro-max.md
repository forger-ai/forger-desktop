---
name: ui-ux-pro-max
description: Use for UI/UX design intelligence before planning, building, reviewing, fixing, or improving app interfaces, layouts, components, forms, tables, charts, responsive behavior, visual identity, color, typography, motion, accessibility, or shadcn/Tailwind React UI.
---

# UI UX Pro Max

Use this skill as the design-intelligence input for visual app work. It provides vendored search scripts and CSV data for product patterns, styles, palettes, typography, UX guidelines, charts, motion, React, and shadcn.

Forger app UI still follows `forger-frontend-patterns`. Use this skill first to get concrete design options, then apply the Forger-specific product, privacy, local-app, memory, and visual QA rules from `forger-frontend-patterns`.

## Run The Search

The scripts use only Python standard library modules and resolve `data/` relative to the script path.

Use the current skill directory as `<skill-dir>`:

```sh
python3 <skill-dir>/scripts/search.py "<app job, audience, workflow, stack>" --design-system -p "<App Name>" -f markdown
python3 <skill-dir>/scripts/search.py "<specific UI concern>" --stack shadcn -n 3
python3 <skill-dir>/scripts/search.py "<specific UI concern>" --domain ux -n 3
```

Build the query from the actual app, not a generic category. Include:

- The app's concrete job.
- The person using it.
- The primary workflow.
- The expected density.
- The stack: React, Tailwind, shadcn, FastAPI, SQLite when relevant.

Use optional dials when the product has a clear direction:

- `--density 8` for operational tools, tables, review queues, and dashboards.
- `--density 3` for focused single-purpose tools.
- `--variance 2` for quiet utility apps.
- `--variance 7` for branded or more expressive apps.
- `--motion 2` for dense work tools.
- `--motion 6` when transitions, route changes, drawers, or agent progress need clearer continuity.

## Convert Results Into A Design Contract

Do not paste search output directly into the app. Convert it into a short contract:

- Product pattern and why it fits.
- Palette tokens for background, surface, border, primary, accent, destructive, success, warning, and focus.
- Typography choice and scale.
- Density and spacing rules.
- Layout and navigation structure.
- Component rules for buttons, forms, tables, cards, dialogs, drawers, charts, and agent progress.
- Motion rules.
- Anti-patterns to reject.

When this is used in a Forger installed app, `forger-frontend-patterns` decides how to persist the final contract in Forger memory.

## Persistence Rule

Do not use the upstream `--persist` flag by default. It writes `design-system/` files into the working directory, which is not the Forger app contract.

Only use `--persist` when the person explicitly asks for design-system files in the app repository. Otherwise, keep the generated recommendation as working context and let `forger-frontend-patterns` persist the chosen visual contract through Forger memory.

## Source

Vendored from `nextlevelbuilder/ui-ux-pro-max-skill` commit `12b486b22e67f5d887962ef8351c1ac863bfaeb9`. The vendored scripts and CSV data are under this skill's resource folder.
