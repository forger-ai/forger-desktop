---
name: forger-mui-consistency
description: Use when reviewing or polishing MUI Desktop or MUI app UI for visual consistency, accessibility, shell layout, tables, charts, navigation, focus states, and interaction patterns.
---

- Apply these rules only to Forger Desktop or apps whose manifest declares a MUI frontend. Do not use them for Tailwind, shadcn/ui, Radix, Headless UI, or plain CSS app frontends.
- Reuse MUI components before creating ad hoc variants.
- For shell-level navigation, prefer MUI `AppBar`, `Drawer`, `NavigationRail`-style layouts, `BottomNavigation`, `Tabs`, `List`, and `Toolbar` patterns over custom clickable containers.
- Keep fixed shell regions outside the content scroller and make the MUI `Box`, `Stack`, or `Grid` that owns main content use `minHeight: 0` and `overflow: auto` when it is the scroll container.
- For sortable, searchable tables, prefer MUI X Community `DataGrid` before custom table logic. For charts, prefer MUI X Community Charts before custom chart rendering. Do not use MUI X Pro or Premium APIs without an explicit license.
- Keep visual hierarchy simple and messages easy to understand.
- Do not introduce styles that make maintenance harder.
