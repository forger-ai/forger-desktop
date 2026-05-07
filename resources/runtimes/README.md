# Bundled runtimes

Forger expects embedded runtime archives in this tree.

## Layout

- `node/22/<runtime-file>.zip|.tar.gz|.tgz`
- `node/22/<platform-arch>.sha256` (optional in dev, required in packaged builds)
- `python/3.12/<runtime-file>.zip|.tar.gz|.tgz`
- `python/3.12/<platform-arch>.sha256` (optional in dev, required in packaged builds)

Supported platform aliases for this release:

- `darwin_arm64` (also matches filenames containing `darwin-arm64` or `aarch64-apple-darwin`)
- `win32_x64` (also matches filenames containing `win-x64` or `x86_64-pc-windows-msvc`)

The runtime archive should extract to a folder containing:

- Node runtime: `bin/node` and `bin/npm` (or Windows equivalents)
- Python runtime: `bin/python` + `bin/pip` (or Windows equivalents)

Top-level wrappers are supported (for example, `node-v22.../` or `python/`), because Forger flattens a single top-level directory automatically after extraction.
