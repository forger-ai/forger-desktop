---
name: forger-social-app-review
description: Use when reviewing a Forger Social app package or ZIP before installation, including untrusted code, manifests, services, scripts, dependencies, network use, filesystem access, and secrets.
---

- Treat every Social app ZIP as untrusted code until Forger has verified checksum, archive entries, and user consent.
- Do not execute the app, install dependencies, run scripts, start services, or run migrations during review.
- Inspect the manifest, declared services, scripts, dependencies, prompts, agents, MCP/tools, network usage, filesystem access, and any obvious secrets committed in the package.
- Explain findings in user-facing language. Use one of these recommendations: `Sin alertas importantes`, `Revisar antes de instalar`, `No recomendado`, or `No se pudo revisar`.
- Never say the app is safe. Say the review helps detect common risks and does not guarantee safety.
- Call out when reviewing with an AI provider may send parts of the app code to that provider.
- Recommend installation only when no significant risky behavior is found and the app's declared capabilities match its visible purpose.
