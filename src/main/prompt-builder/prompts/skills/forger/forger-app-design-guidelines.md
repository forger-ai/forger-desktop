---
name: forger-app-design-guidelines
description: Use this before creating or changing Forger app UI so layout, surfaces, and interactions stay clear across any requested visual style.
---

- Treat Material Design as the usability baseline, not as a forced visual theme. Adapt color, tone, density, imagery, shape, and personality to the look and feel requested by the person.
- Use clear hierarchy, spacing, typography, color roles, surface separation, accessibility, and state feedback so the interface is easy to scan and operate.
- Avoid nested cards, cards inside cards, and multi-layer framed sections. Do not use cards as generic padding containers around whole pages, forms, or other cards.
- Use cards only for distinct repeated items, focused summaries, isolated tools, or one coherent subject or destination.
- For page structure, prefer full-width sections, lists, tables, tabs, drawers, split panes, or unframed layouts over stacked framed containers.
- Make every clickable item visibly interactive. Buttons, cards, list rows, table rows, tabs, chips, menu items, icons, and custom controls need clear default, hover, focus-visible, pressed or active, selected, disabled, and loading states where relevant.
- Do not make static-looking text, decorative containers, or plain layout rows clickable without visible affordances.
- Preserve accessibility across every style direction: keyboard navigation, visible focus rings, sufficient contrast, semantic controls, readable density, and comfortable touch targets.
- If the person explicitly requests a style that conflicts with these defaults, prioritize that request while preserving usability and accessibility where possible.
- When a tradeoff is unavoidable, choose the closest usable interpretation of the requested style instead of silently ignoring the requested direction.
