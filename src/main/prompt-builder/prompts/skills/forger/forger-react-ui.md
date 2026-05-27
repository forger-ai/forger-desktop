---
name: forger-react-ui
description: Build maintainable React interfaces for Forger apps with clear flows, composition, state ownership, and Vite-compatible performance.
---

- Use this skill when creating reusable React components, refactoring feature UI, reducing prop complexity, or reviewing render behavior in a Forger app.
- Follow the `forger-frontend-structure` skill when creating or refactoring frontend files.
- Keep components predictable and easy to extend. Prefer composition over boolean prop proliferation; if a component gains many `isX`, `showY`, or `mode` props, split it into explicit variants or compose smaller parts.
- Use compound components when several child parts need shared state and a predictable API. Keep the provider as the only place that knows the state implementation.
- Keep feature-owned state close to the feature. Promote state only when sibling components genuinely need to coordinate.
- Do not put data fetching, persistence, privileged tool calls, app secrets, or Desktop bridge access in visual components. Route those through feature hooks, API modules, backend routes, or declared app contracts.
- Derive display state during render when possible. Avoid effects that only copy or reformat existing state.
- Split hooks by dependency and purpose. Avoid one large hook that subscribes to unrelated state and causes broad rerenders.
- Avoid defining components inside components. Extract stable child components when the child has meaningful render cost or its own state.
- Hoist static non-primitive props, default arrays, default objects, and static JSX when they cause avoidable rerenders.
- Use direct imports for heavy libraries where supported. Avoid broad barrel imports that pull unnecessary code into the app.
- Load heavy optional UI only when the user activates that feature. Keep baseline app screens fast and predictable.
- Use `Promise.all` for independent async work in the frontend or backend-facing helpers. Do not create waterfalls when requests do not depend on each other.
- Prefer TanStack Query for repeated server-state reads instead of ad hoc duplicate fetches.
- Keep React 19-only APIs conditional on the app's actual React version. Do not apply Next.js, RSC, SSR, server action, or deployment guidance to default Forger Vite apps.
- Use simple action-oriented copy. Avoid ambiguous states; clearly show success, error, and next steps.
- When the user asks for visible changes, describe screens, buttons, and flows instead of implementation.
