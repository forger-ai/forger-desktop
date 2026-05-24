---
name: forger-mobile-responsive-frontend
description: Build React/MUI app frontends that work well on mobile and desktop.
---

- Use this skill before creating or changing visible screens, navigation, dashboards, forms, tables, modals, or repeated item layouts in a Forger app.
- Forger apps can be opened from Desktop, a desktop browser, a phone on the local network, or a phone through a remote tunnel. Keep the same workflow usable in all of those contexts.
- Before coding, define the mobile behavior for primary actions, navigation, lists or tables, forms, validation, empty/loading/error/success states, and destructive confirmations.
- Use MUI and the existing app theme. Do not add Tailwind CSS.
- Use MUI breakpoints or `useMediaQuery`; keep touch targets at least 44 px tall on mobile.
- Collapse wide tables into cards, grouped rows, or a focused detail view when a phone viewport cannot support the table.
- Avoid horizontal scrolling unless the data itself is inherently tabular.
- Keep fixed toolbars, bottom actions, and floating remote-session controls from covering primary actions.
- Do not put UI cards inside other cards.
- Preserve desktop density when wider screens benefit repeated work.
- Use the app localization pattern for visible text when one exists.
- Verify at mobile width around 390 px and desktop width around 1280 px. Check that realistic data, long labels, loading states, empty states, errors, and success states fit without overlap.
