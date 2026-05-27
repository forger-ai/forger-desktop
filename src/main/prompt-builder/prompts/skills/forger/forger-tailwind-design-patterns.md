---
name: forger-tailwind-design-patterns
description: Use when changing Tailwind app styling, semantic tokens, CSS variables, palettes, spacing, radii, shadows, layout utilities, dark mode, or shadcn/Radix-compatible visual patterns.
---

- Apply these rules to Forger Vite React apps whose frontend uses Tailwind CSS, shadcn/ui copied components, and Radix primitives.
- Do not use MUI component APIs, `sx`, Emotion themes, or MUI breakpoint helpers in Tailwind/shadcn apps.
- Inspect the app's Tailwind version before changing tokens or config. Tailwind v4 uses CSS-first `@theme`; Tailwind v3 usually uses `tailwind.config.*`.
- Keep design tokens in one explicit location such as `frontend/src/styles/globals.css`, `frontend/src/design-system`, or the app's existing equivalent.
- Model tokens by purpose: brand tokens inform semantic tokens, and semantic tokens inform component styles. Avoid scattering one-off colors, radii, shadows, and animation values across feature files.
- Use semantic color roles such as background, foreground, card, muted, border, ring, primary, secondary, accent, destructive, and app-specific status tokens.
- Avoid one-note palettes dominated by a single hue family unless the user explicitly chose that identity.
- Use Tailwind utilities for layout, spacing, responsive behavior, state styles, and token references. Extract repeated class sets into small reusable components when repeated patterns become hard to scan.
- Use `cn()` for conditional class composition. Keep class strings readable and focused on layout or state rather than ad hoc restyling of primitives.
- Prefer shallow page structure: full-width app sections and unframed layouts for page organization, cards for repeated items or focused summaries, and dialogs for interruptive decisions.
- Define stable dimensions with responsive constraints for boards, grids, toolbars, counters, tiles, and repeated controls so loading, hover, and long text do not shift the layout.
- Dark mode is allowed only when tokens, backgrounds, borders, charts, forms, loading states, focus states, and contrast are handled as a complete mode. Do not sprinkle `dark:` classes as patches.
- Keep touch targets at least 44 px on mobile and use focus-visible rings for keyboard users.
- Use motion sparingly for state transitions and feedback. Do not add decorative animation that makes operational apps harder to scan.
- Verify realistic data, long labels, loading, empty, error, success, and disabled states at mobile and desktop widths.
