# Bundled runtimes

Forger expects embedded runtime archives in this tree.

## Layout

- `node/22/<runtime-file>.zip|.tar.gz|.tgz`
- `node/22/<platform-arch>.sha256` (optional in dev, required in packaged builds)
- `python/3.12/<runtime-file>.zip|.tar.gz|.tgz`
- `python/3.12/<platform-arch>.sha256` (optional in dev, required in packaged builds)
- `git/2.54.0/<git-runtime-file>.zip|.tar.gz`
- `git/2.54.0/<git-runtime-file>.zip.sha256|.tar.gz.sha256`

Supported platform aliases for this release:

- `darwin_arm64` (also matches filenames containing `darwin-arm64` or `aarch64-apple-darwin`)
- `darwin_x64` (also matches filenames containing `darwin-x64` or `x86_64-apple-darwin`)
- `linux_x64` (also matches filenames containing `linux-x64` or `x86_64-unknown-linux-gnu`)
- `win32_x64` (also matches filenames containing `win-x64` or `x86_64-pc-windows-msvc`)

Bundled Git is included where a reviewed portable binary is available. macOS Intel and Linux x64 releases fall back to Git on `PATH` or the platform package manager when a bundled Git archive is not present.

The runtime archive should extract to a folder containing:

- Node runtime: `bin/node` and `bin/npm` (or Windows equivalents)
- Python runtime: `bin/python` + `bin/pip` (or Windows equivalents)
- Git runtime: `cmd/git.exe` from MinGit on Windows, or `bin/git` on macOS

Top-level wrappers are supported (for example, `node-v22.../` or `python/`), because Forger flattens a single top-level directory automatically after extraction.
