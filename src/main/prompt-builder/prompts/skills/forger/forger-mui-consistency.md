---
name: forger-mui-consistency
description: Use consistent MUI patterns to keep the experience stable.
---

- Reuse MUI components before creating ad hoc variants.
- For shell-level navigation, prefer MUI `AppBar`, `Drawer`, `NavigationRail`-style layouts, `BottomNavigation`, `Tabs`, `List`, and `Toolbar` patterns over custom clickable containers.
- Keep fixed shell regions outside the content scroller and make the MUI `Box`, `Stack`, or `Grid` that owns main content use `minHeight: 0` and `overflow: auto` when it is the scroll container.
- For sortable, searchable tables, prefer MUI X Community `DataGrid` before custom table logic. For charts, prefer MUI X Community Charts before custom chart rendering. Do not use MUI X Pro or Premium APIs without an explicit license.
- Keep visual hierarchy simple and messages easy to understand.
- Do not introduce styles that make maintenance harder.
