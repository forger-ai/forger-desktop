---
name: forger-tailwind-shadcn-patterns
description: Use when building Tailwind/shadcn app UI controls, forms, dialogs, selects, comboboxes, popovers, dropdowns, tabs, tooltips, sheets, accordions, toasts, copied components, or Radix primitives; inspect existing components and install shadcn/Radix before hand-rolling interactive behavior.
---

## Component Selection Loop

- Identify the needed behavior before writing JSX: select, combobox, dialog, sheet, drawer, dropdown menu, popover, tabs, tooltip, accordion, command menu, toast, date input, table, form field, badge, alert, skeleton, empty state, card, separator, or navigation control.
- Inspect local app facts before adding or importing a component: `components.json`, `frontend/src/components/ui`, `frontend/package.json`, lockfile and package manager, Tailwind version, CSS token file, aliases, icon library, and existing `@radix-ui/*` dependencies.
- Prefer existing app primitives from `@/components/ui/*` before writing new markup.
- If the primitive is missing, add the matching shadcn component through the app package manager and shadcn CLI or registry, then review the diff before using it.
- Keep direct `@radix-ui/*` imports inside reusable `frontend/src/components/ui/*` primitives. Feature screens should import local wrappers from `@/components/ui/*`.
- Avoid native `<select>`, custom `div` menus, ad hoc popovers, manual focus traps, and hand-rolled keyboard behavior when shadcn/Radix covers the control.
- Only hand-roll behavior when existing local primitives and shadcn/Radix cannot cover the concrete need; document the reason in code only when the tradeoff would otherwise be unclear.

## shadcn And Radix Boundaries

- shadcn/ui components are copied app code, not an opaque runtime UI kit. Keep generic primitives in `frontend/src/components/ui`, app-specific compositions in `frontend/src/features/<area>`, and reusable app wrappers in `frontend/src/components`.
- Radix provides accessible headless behavior such as focus management, portals, keyboard navigation, Escape handling, and ARIA semantics. Tailwind and app tokens own visual styling.
- Do not add Headless UI or another headless component system to the baseline app unless Radix/shadcn cannot cover a concrete need and the dependency is documented.
- Do not assume Next.js or React Server Components. Forger apps on the current stack are Vite React apps unless the manifest or app files prove otherwise.

## After Copying Or Installing

- Read every added or changed component file before considering the component ready.
- Fix hardcoded imports, alias mismatches, missing subcomponents, unexpected dependencies, icon-library mismatches, token violations, keyboard/focus states, mobile layout, and localization gaps.
- Adapt copied styles to semantic tokens and component variants. Avoid raw Tailwind status colors such as `text-green-600` for domain state unless the app has explicit semantic tokens for that state.
- Verify the component works with realistic labels, translated copy, loading states, disabled states, errors, and mobile widths.

## Composition Rules

- Use `cn()` with `clsx` and `tailwind-merge` for conditional classes. Avoid complex string concatenation and duplicated class piles.
- Use `gap-*` for spacing in flex/grid layouts. Avoid `space-x-*` and `space-y-*` in reusable components because they are fragile when content wraps or changes direction.
- Use `size-*` when width and height are equal. Use `truncate` instead of manually combining overflow, ellipsis, and whitespace classes.
- For forms, use semantic labels, helper text, validation messages, disabled states, loading states, and submit feedback. Do not rely on placeholder text as the only label.
- Dialog, sheet, drawer, and alert-dialog surfaces need a title. Use a visually hidden title only when the visual design already has an equivalent heading.
- Keep Card composition explicit when the card has structured content: header/title/description/content/footer. Do not dump unrelated content into one generic card body.
- Use Badge, Alert, Separator, Skeleton, Empty, and toast primitives instead of custom decorative `div` markup when those primitives already fit.
- Icons inside buttons should be predictable and consistently sized by the component. Use the app's chosen icon library, usually `lucide-react`, unless local config says otherwise.
- Never overwrite copied components, presets, CSS variables, or config without an explicit decision and a saved app version.
