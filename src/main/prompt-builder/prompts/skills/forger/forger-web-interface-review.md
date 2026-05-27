---
name: forger-web-interface-review
description: Use when reviewing Forger app dashboards, CRUD flows, forms, data views, assistant task surfaces, mobile/desktop layouts, visual clarity, copy, empty states, and action feedback.
---

- Do not fetch remote guideline documents during normal Forger app work. Use this stable Forger-owned checklist.
- Review the app as a local private tool, not a public marketing website. Ignore SEO, landing-page conversion, public navigation, Vercel deployment, analytics, and SaaS signup assumptions unless the app explicitly needs them.
- Start from the user's workflow: what they are trying to load, review, create, edit, delete, import, export, approve, or ask the app assistant to do.
- Check that each primary feature has a clear view, visible create action where relevant, list/detail/edit/delete behavior, empty state, loading state, error state, and success feedback.
- Dashboards should summarize and route. They should not become the only place where every form and table lives.
- Confirm primary actions are close to the object they affect and destructive actions have clear confirmation and recovery when important data is involved.
- Verify long labels, realistic records, empty values, validation messages, loading placeholders, error copy, and success states without overlap.
- Check mobile and desktop separately. On mobile, navigation, actions, tables/lists, forms, and remote-session controls must remain usable.
- Dense operational screens should remain scannable: restrained headings, predictable spacing, consistent controls, and no decorative card nesting.
- Visible copy should be functional, localized when the app has i18n, and free of implementation terms unless the user asks for technical detail.
- Confirm frontend/backend ownership: the frontend renders state and intent; validation, persistence, privileged Forger access, imports, scripts, and secrets stay in backend or app contracts.
- Findings should be actionable and tied to a visible screen or flow. Prefer "Move delete confirmation into the item row flow" over vague design critique.
