---
name: forger-tasks
description: Understand Forger app tasks, which let apps invoke an agentic coding tool for one-shot non-conversational work.
---

- Tasks are app-declared one-shot jobs with a bounded input form and one clear result.
- Use them for imports, reviews, conversions, classifications, summaries, and other work that should finish without an ongoing conversation.
- Use an app agent instead when the work needs back-and-forth discussion, steering, or resume.
- Use `forger-manifest-authoring` when writing the exact `manifest.json` shape for task prompt templates.
- Keep task output product-facing: what was reviewed, produced, changed, rejected, or needs confirmation.
