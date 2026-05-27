---
name: forger-mui-component-patterns
description: Use when choosing MUI Core or MUI X Community components for Desktop or MUI apps, including forms, dialogs, menus, tabs, tables, DataGrid, charts, cards, panels, and pickers.
---

## Package Boundaries

- Apply these rules only to Forger Desktop or apps whose manifest declares a MUI frontend. Do not use them for Tailwind, shadcn/ui, Radix, Headless UI, or plain CSS app frontends.
- Use Material UI Core components from `@mui/material` for common UI: forms, buttons, cards, paper surfaces, dialogs, tabs, lists, menus, snackbars, accordions, and layout primitives.
- Use MUI X Community packages for advanced free components when the app needs them: `@mui/x-data-grid`, `@mui/x-charts`, and `@mui/x-date-pickers`.
- Do not use MUI X Pro or Premium packages, imports, examples, or features unless the app explicitly has a paid license and the user asks for them.
- Before using an MUI X component in an app, verify the app dependency exists. Add only the needed Community package and required peer adapter, such as a date adapter for pickers.

## Forms And Inputs

- Prefer `TextField` for standard text, search, email, password, number, multiline, read-only, disabled, required, error, and helper-text states.
- Give every field a visible label or accessible name. Provide stable `id` values when label/helper associations matter.
- Use `helperText` for format guidance, validation details, and next steps. Do not rely on placeholder text as the only instruction.
- Use `FormControl`, `InputLabel`, `FormHelperText`, `RadioGroup`, `Checkbox`, `Switch`, and related MUI form components when composing custom controls.
- Use `Select` for choosing from a short bounded list. Use `Autocomplete` when the list is long, searchable, async, multi-select, creatable, or benefits from suggestions.
- For mobile-friendly simple lists, consider `NativeSelect` when platform-native selection gives a better experience.
- Make controlled vs uncontrolled state intentional. Use controlled values for persisted app data, validation, dependent fields, filters, and editable records.

## Dates, Times, And Calendar Inputs

- Use the `forger-mui-date-pickers` skill before implementing date, time, date-range, calendar, schedule, due-date, reporting-period, or temporal filter inputs.
- Use MUI X Community Date and Time Pickers for date, time, and date-time inputs instead of ad hoc text parsing.
- Use `DatePicker` when the person benefits from both typed input and calendar selection.
- Use `DateField`, `TimeField`, or `DateTimeField` when keyboard-only entry is enough and a popover calendar would add noise.
- Do not use `TextField type="date"` when the expected behavior is a MUI-styled calendar picker. `type="date"` opens the browser or operating-system native date picker and varies by platform.
- Use native `type="date"` only when the app intentionally wants a basic platform-native date input and the inconsistent picker UI is acceptable.
- Use responsive picker variants when the same component should adapt between pointer and touch environments.
- Keep date values typed and normalized at the app boundary. Do not store localized display strings as durable data.
- Show validation, min/max limits, disabled dates, empty states, and timezone assumptions explicitly when they affect user data.

## Tables And Data Grids

- Use MUI X Community `DataGrid` for sortable, searchable, pageable, selectable, or larger tabular data.
- Use `showToolbar` or a custom toolbar with Quick Filter for searchable tables.
- Use built-in single-column sorting by default. Do not depend on multi-column sorting because it is a Pro feature.
- Use built-in filtering and quick filtering for normal client-side datasets. Use server-side sorting, filtering, and pagination when the dataset is large or backend-owned.
- Use stable row ids, semantic column names, meaningful value formatters, empty states, loading states, error states, and clear row actions.
- Use MUI `Table` only for simple static tables, dense read-only summaries, or highly custom native-table layouts.
- On compact screens, replace wide grids with cards, grouped rows, a detail view, or a focused mobile table pattern. Do not force horizontal scrolling as the only usable path.

## Charts

- Use MUI X Community Charts for app charts instead of hand-rolled SVG/canvas chart code.
- Use line charts for trends over time, bar charts for category comparisons, area charts for cumulative or stacked trends, scatter charts for relationships, pie or donut charts only for simple parts-of-a-whole comparisons, gauges for single bounded metrics, and sparklines for compact trend previews.
- Include labels, legends, units, tooltips, accessible summaries, loading states, empty states, and error states.
- Keep chart colors tied to theme roles or a documented palette. Do not rely on color alone to distinguish meaning.
- Give chart data stable ids when data can update or reorder.
- Prefer responsive containers and fixed aspect ratios so charts do not collapse, overflow, or resize unpredictably inside panels.

## Cards, Panels, And Surfaces

- Use `Card` for content and actions about one subject or as an entry point to a more detailed view.
- Use `CardHeader`, `CardContent`, `CardMedia`, `CardActions`, and `CardActionArea` instead of custom card anatomy when those pieces fit.
- Keep supplemental card actions visually separate from the primary clickable area to avoid event overlap.
- Use `Paper` for elevated or outlined surfaces, side panels, tool panels, summary panels, and contained work areas.
- Use `Box`, `Stack`, `Grid`, or `Container` for generic layout. Do not use `Card` or `Paper` only to add padding around entire pages.
- Avoid nested cards and nested paper surfaces. If hierarchy is needed, use spacing, dividers, headings, tabs, accordions, or section layout instead.
- Use restrained elevation. Prefer `variant="outlined"` or low elevation for dense productivity apps.

## Dialogs, Drawers, Accordions, And Tabs

- Use `Dialog` for interruptive decisions, confirmations, and short focused forms. Use it sparingly because it blocks the rest of the app.
- Use `role="alertdialog"` semantics for urgent destructive or high-risk confirmations.
- Make dialogs responsive with `useMediaQuery` when they need to become full-screen on narrow widths.
- Use `Drawer` for navigation or secondary panels that must stay connected to the shell. Do not use dialogs as navigation.
- Use `Accordion` for sections of related content that can be expanded and collapsed. Keep heading levels and `aria-controls` correct.
- Use `Tabs` for peer views within one destination. Do not use tabs as a substitute for global app navigation when the app needs a shell-level nav pattern.
