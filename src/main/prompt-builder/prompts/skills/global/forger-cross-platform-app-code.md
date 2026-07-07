---
name: forger-cross-platform-app-code
description: Use when creating or changing Forger app code that touches operating-system detection, filesystem paths, temp files, permissions, symlinks, processes, shell commands, runtime startup, ports, backend services, scripts, MCP helpers, or app-agent helpers.
---

## Platform Contract
- Forger apps run as local code on the person's machine. If `manifest.json` declares Windows, macOS, or Linux support, app code must work on those platforms or isolate platform-specific behavior behind explicit branches.
- Treat `catalog.supported_platforms` as a real compatibility contract for app code. If it includes `win32_x64`, review Windows behavior even when developing on macOS or Linux.
- Keep platform-specific code in small helpers with clear names. Callers should not need to know OS-specific details.
- Prefer standard-library cross-platform APIs over shell commands or POSIX-only modules.

## Python Rules
- Do not use `os.uname()` in Forger app code. It does not exist on Windows and can break app startup before `/health` responds.
- Use the API that matches the intent: `socket.gethostname()` or `platform.node()` for host identity, `platform.system()` for display-level OS names, `sys.platform` or `os.name` for branching.
- Use `pathlib.Path`, `tempfile`, `shutil`, and structured `subprocess` calls. Avoid string-built paths and avoid `shell=True` unless there is a concrete, documented reason.
- Do not assume `/tmp`, `/Users`, `/home`, POSIX permissions, Unix symlinks, executable files without extensions, or `:` as a safe filename character.
- Avoid POSIX-only modules and calls such as `pwd`, `grp`, `fcntl`, `termios`, `resource`, `os.getuid`, `os.chmod` mode assumptions, and Unix-only signals unless guarded by platform checks.

## Node And TypeScript Rules
- Use `os.platform()`, `os.hostname()`, `path.join`, `path.resolve`, `path.dirname`, and `process.platform` instead of hardcoded separators or platform strings.
- Do not hardcode `/tmp`, `/Users`, `/home`, backslash-only paths, or drive-letter paths unless the branch is explicitly platform-specific.
- Avoid shelling out to Unix commands such as `rm`, `cp`, `mv`, `which`, `grep`, `sed`, `awk`, `chmod`, or `kill`. Prefer Node APIs or Desktop-provided runtime helpers.
- When spawning child processes, pass command and args separately. Avoid shell-dependent quoting, glob expansion, pipes, redirects, and chained commands in app code.

## Final Review Checklist
- Search changed app code for risky platform APIs before finishing: `os.uname`, `pwd`, `grp`, `fcntl`, `termios`, `resource`, `/tmp`, `/Users`, `/home`, `shell=True`, `rm `, `cp `, `which `, `grep `, and raw path separators.
- Verify startup paths, background jobs, MCP helpers, and app-agent scripts do not execute platform-specific code at import time unless guarded.
- If an app intentionally supports only one platform, make that limitation explicit in `catalog.supported_platforms` instead of shipping code that silently fails elsewhere.
