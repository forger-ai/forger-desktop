---
name: forger-tailwind-responsive-frontend
description: Use when making Tailwind/shadcn app screens responsive on mobile and desktop, including navigation, dashboards, forms, tables, dialogs, lists, cards, repeated items, and touch targets.
---

- Apply these rules only to Tailwind/shadcn Forger apps. Use `forger-mobile-responsive-frontend` for stack-agnostic responsive guidance.
- Forger apps can be opened from Desktop, a desktop browser, a phone on the local network, or a phone through a remote tunnel. Keep the same workflow usable in all of those contexts.
- Before coding, define the mobile behavior for primary actions, navigation, lists or tables, forms, validation, empty/loading/error/success states, and destructive confirmations.
- Use Tailwind responsive variants and stable container constraints. Keep touch targets at least 44 px tall on mobile.
- Use CSS grid or flex layouts with `min-h-dvh`, `min-h-0`, and explicit content scrollers when an app shell has fixed navigation or action bars.
- Collapse wide tables into cards, grouped rows, or focused detail views when a phone viewport cannot support the table.
- Avoid horizontal scrolling unless the data itself is inherently tabular and the user needs side-by-side comparison.
- Keep fixed toolbars, bottom actions, and floating remote-session controls from covering primary actions.
- Preserve desktop density when wider screens benefit repeated work.
- Use the app localization pattern for visible text when one exists.
- Verify at mobile width around 390 px and desktop width around 1280 px. Check that realistic data, long labels, loading states, empty states, errors, and success states fit without overlap.
