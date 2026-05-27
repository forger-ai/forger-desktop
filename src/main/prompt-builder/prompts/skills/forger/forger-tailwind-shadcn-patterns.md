---
name: forger-tailwind-shadcn-patterns
description: Use shadcn/ui copied components and Radix primitives correctly in Tailwind Forger apps.
---

- Use this skill when creating, changing, reviewing, or debugging copied shadcn/ui components, Radix primitives, component registries, or any app with `components.json`.
- shadcn/ui components are copied app code, not an opaque runtime UI kit. Keep generic primitives in `frontend/src/components/ui` and app-specific compositions in `frontend/src/features/<area>` or reusable wrappers in `frontend/src/components`.
- Prefer existing app primitives before hand-rolling buttons, inputs, selects, dialogs, sheets, drawers, dropdown menus, popovers, tabs, tooltips, accordions, cards, badges, alerts, tables, skeletons, command menus, charts, empty states, and toast surfaces.
- Use Radix-backed shadcn components for interaction-heavy controls. Do not add Headless UI to the baseline app unless Radix/shadcn cannot cover a concrete need and the dependency is documented.
- Inspect local app facts before adding or importing a component: `components.json`, aliases, Tailwind version, CSS token file, installed UI files, icon library, and the app's current package manager.
- Do not assume Next.js or React Server Components. Forger apps on the current stack are Vite React apps unless the manifest or app files prove otherwise.
- Use semantic tokens and component variants for visual meaning. Avoid raw Tailwind status colors such as `text-green-600` for domain state unless the app has explicit semantic tokens for that state.
- Use `cn()` with `clsx` and `tailwind-merge` for conditional classes. Avoid complex string concatenation and duplicated class piles.
- Use `gap-*` for spacing in flex/grid layouts. Avoid `space-x-*` and `space-y-*` in reusable components because they are fragile when content wraps or changes direction.
- Use `size-*` when width and height are equal. Use `truncate` instead of manually combining overflow, ellipsis, and whitespace classes.
- For forms, use semantic labels, helper text, validation messages, disabled states, loading states, and submit feedback. Do not rely on placeholder text as the only label.
- Dialog, sheet, drawer, and alert-dialog surfaces need a title. Use a visually hidden title only when the visual design already has an equivalent heading.
- Keep Card composition explicit when the card has structured content: header/title/description/content/footer. Do not dump unrelated content into one generic card body.
- Use Badge, Alert, Separator, Skeleton, Empty, and toast primitives instead of custom decorative `div` markup when those primitives already fit.
- Icons inside buttons should be predictable and consistently sized by the component. Use the app's chosen icon library, usually `lucide-react`, unless local config says otherwise.
- When using shadcn CLI or registries, treat the command as an internal implementation tool. Preview with dry-run or diff where possible, read added files, and preserve app-local modifications.
- Never overwrite copied components, presets, CSS variables, or config without an explicit decision and a saved app version.
- After adding a third-party registry component, read the added files and fix hardcoded imports, missing subcomponents, unexpected dependencies, icon-library mismatches, and token violations before considering the work complete.
