---
name: forger-social-app-review
description: Use when reviewing a Forger Social app package or ZIP before installation, including untrusted code, manifests, services, scripts, dependencies, network use, filesystem access, and secrets.
---

- Treat every Social app ZIP as untrusted code until Forger has verified checksum, archive entries, and user consent.
- Do not execute the app, install dependencies, run scripts, start services, or run migrations during review.
- Inspect the manifest, declared services, scripts, dependencies, prompts, agents, MCP/tools, network usage, filesystem access, folder-grant requests, and any obvious secrets committed in the package.
- Treat `platformCapabilities.workspaceFolders`, task or agent `workspace.cwdGrantId`, `workspace.additionalFolderGrantIds`, and any legacy `workspace_path` usage as filesystem risk signals. Folder grants are Forger-owned permissions, so the package should only request them for a visible app workflow with a narrow reason.
- Flag Social apps that ask for broad or unexplained folder grants, store raw external paths, ask agents to browse arbitrary folders, or use `workspace_path` for anything outside the app-private workspace.
- Treat app code that sends `runtime` to agent tasks or manifest-agent start, resume, or steer as requiring `platformCapabilities.agentRuntimeControl`. Flag packages that send per-request provider, model, or effort overrides without that capability, or that declare the capability without a visible model-selection workflow.
- Explain findings in user-facing language. Use one of these recommendations: `Sin alertas importantes`, `Revisar antes de instalar`, `No recomendado`, or `No se pudo revisar`.
- Never say the app is safe. Say the review helps detect common risks and does not guarantee safety.
- Call out when reviewing with an AI provider may send parts of the app code to that provider.
- Recommend installation only when no significant risky behavior is found and the app's declared capabilities match its visible purpose.
