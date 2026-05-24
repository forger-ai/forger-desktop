---
name: forger-app-shell-layout
description: Use this when creating or changing a Forger app shell, primary navigation, top bars, or page-level scrolling behavior.
---

## Goal

Keep app navigation and primary actions visible while only the main content region scrolls. A Forger app should feel stable when the person reads long pages, switches views, resizes the window, or uses the app on a narrow screen.

## Material Design Basis

- Material responsive navigation uses bottom navigation on compact widths, a navigation rail on medium widths, and a persistent navigation drawer or rail on expanded widths.
- Navigation elements occupy persistent space on the leading edge on wider layouts and may move to the bottom edge on compact layouts.
- Navigation rail destinations remain visible while on-screen content scrolls vertically.
- Navigation drawers are appropriate for many top-level destinations, two or more navigation hierarchy levels, or quick movement between unrelated destinations.
- Bottom navigation is primarily for compact screens with three to five top-level destinations. On larger displays, use side navigation instead.
- Content destinations should adapt to window size without treating resize as a navigation event or destroying the person's current state.

## MUI Implementation Basis

- Use MUI breakpoints and `useMediaQuery` to switch shell presentation at `xs`, `sm`, `md`, `lg`, and `xl` widths instead of hardcoding unrelated media queries.
- Use `theme.breakpoints` in `sx` for layout-only responsive changes. Use `useMediaQuery` only when the rendered component tree must change, such as switching a permanent drawer to a modal drawer or bottom navigation.
- Use MUI `AppBar` and `Toolbar` for top bars. If an `AppBar` uses `position="fixed"`, add an offset with a second `<Toolbar />`, `theme.mixins.toolbar`, or use `position="sticky"` so content is not hidden behind it.
- Use MUI `Drawer` variants deliberately: temporary for modal mobile navigation, persistent for toggled side navigation, mini variant for compact quick-access desktop sections, and permanent for desktop navigation that must always stay visible.
- Use permanent drawers as the default desktop pattern when navigation is part of the page structure. Use clipped-under-app-bar drawers for productivity layouts that need balanced content space.
- Use MUI `BottomNavigation` and `BottomNavigationAction` for compact-width primary destinations. Keep it fixed outside the content scroller and reserve content padding for its height.
- Use `SwipeableDrawer` only when the gesture value is worth its extra complexity and performance cost on mobile.

## Navigation Selection Matrix

- Compact width with three to five peer destinations: fixed `BottomNavigation`.
- Compact width with many destinations or hierarchy: temporary `Drawer` opened from a visible menu button.
- Medium width with three to seven primary destinations: fixed rail-style side navigation.
- Expanded width with many destinations or grouped hierarchy: permanent `Drawer`.
- Expanded productivity app with a top app bar: clipped permanent or mini-variant `Drawer` under the app bar.
- Expanded focused app with few destinations: rail-style side navigation plus content pane.

## Required App Shell Structure

- Build a single app shell that owns the viewport height, primary navigation, top app bar if present, and the main content slot.
- Put scrolling on the main content slot, not on the document body and not on the whole shell.
- Keep side navigation, bottom navigation, primary tabs, and persistent top bars outside the main content scroller.
- Use stable shell dimensions: `height: 100dvh`, `min-height: 0` on flex/grid children that contain scrollers, and explicit `overflow: auto` only on the content pane that should scroll.
- Use a CSS grid or flex layout that separates navigation from content. Do not create page-level wrappers that accidentally make navigation scroll away with content.
- Add dividers, elevation, or surface contrast when content scrolls under or next to fixed navigation so the boundary stays legible.
- Preserve scroll position and selected navigation state when resizing between mobile, tablet, and desktop layouts.

## Desktop And Tablet Patterns

- For three to seven primary destinations on medium and expanded widths, prefer a fixed navigation rail on the leading edge.
- For many primary destinations, grouped destinations, or deeper hierarchy, prefer a persistent navigation drawer on expanded widths.
- Keep desktop/tablet side navigation visible during vertical content scrolling.
- Place secondary navigation inside the current content destination only when it belongs to that destination. Do not mix secondary destinations into the global shell.
- Avoid combining multiple primary navigation systems at the same breakpoint. Do not show a permanent drawer and bottom navigation for the same destinations at the same time.

## Compact Mobile Patterns

- For three to five peer top-level destinations, use bottom navigation fixed to the bottom of the viewport.
- For many destinations or hierarchical navigation, use a modal drawer opened from a clear menu button.
- Keep bottom navigation outside the content scroller and reserve safe spacing so content is not hidden behind it.
- Avoid horizontal scrolling shells on compact screens. Reflow content into one-column or task-focused layouts.
- Keep touch targets comfortable and make active, focus, pressed, disabled, and loading states visible.

## Implementation Checks

- At desktop width, scrolling a long page leaves the rail or drawer and app bar visible.
- At compact width, scrolling a long page leaves bottom navigation or the drawer trigger visible.
- The browser or webview body does not become the primary scroller unless there is no app shell.
- Navigation does not disappear, resize unpredictably, or overlap content during scrolling.
- Resizing the app changes layout presentation but does not reset the selected destination, lose form state, or jump to unrelated screens.
- Long labels, translated copy, empty states, loading states, and error banners fit without pushing fixed navigation off-screen.
