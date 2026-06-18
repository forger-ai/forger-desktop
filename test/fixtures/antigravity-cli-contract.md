# Antigravity CLI command contract

Captured from an isolated macOS arm64 scratch install on 2026-06-17. This fixture documents the observed Antigravity CLI contract for future Desktop runtime integration tests. It does not imply Desktop support is implemented.

## Official install source

- Product/docs: https://antigravity.google/docs/cli-install
- Official Unix installer: `https://antigravity.google/cli/install.sh`
- Official macOS/Linux fast path: `curl -fsSL https://antigravity.google/cli/install.sh | bash`
- The installer supports a custom binary directory: `bash install.sh --dir <target-dir>`
- Default installer target from the script is `$HOME/.local/bin/agy`.

For the local probe, the installer was downloaded into `/tmp` and executed with a scratch `HOME` and scratch `--dir`. The installer queried:

```text
https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/darwin_arm64.json
```

The current `darwin_arm64` manifest resolved to:

```json
{
  "version": "1.0.9",
  "url": "https://storage.googleapis.com/antigravity-public/antigravity-cli/1.0.9-6003845613092864/darwin-arm/cli_mac_arm64.tar.gz",
  "sha512": "b57bcaf6ec92fb37ed89328951d948db20072739421fe5f51c8c23c2802a0be1ececf137990eada73462a2b39da12b12addbb3caf627f54c4c7b7040a9204b9c"
}
```

## Installed binary

- Binary name: `agy`
- Observed version: `1.0.9`
- macOS binary type: `Mach-O 64-bit executable arm64`
- `agy --version` exits `0` and prints only the version number.

## Root command help

`agy --help` and `agy help` both exit `0` and print the same root usage:

```text
Usage of agy:
  --add-dir                       Add a directory to the workspace (repeatable) (default [])
  -c                              Short alias for --continue
  --continue                      Continue the most recent conversation
  --conversation                  Resume a previous conversation by ID
  --dangerously-skip-permissions  Auto-approve all tool permission requests without prompting
  -i                              Short alias for --prompt-interactive
  --log-file                      Override CLI log file path
  --model                         Model for the current CLI session
  -p                              Short alias for --print
  --print                         Run a single prompt non-interactively and print the response
  --print-timeout                 Timeout for print mode wait (default 5m0s)
  --prompt                        Alias for --print
  --prompt-interactive            Run an initial prompt interactively and continue the session
  --sandbox                       Run in a sandbox with terminal restrictions enabled

Available subcommands:
  changelog       Show changelog and release notes
  help            Show help for subcommands
  install         Configure environment paths and shell settings
  models          List available models
  plugin          Manage plugins (install, uninstall, list, enable, disable)
  plugins         Alias for plugin
  update          Update CLI
```

## Subcommand help

`agy help install` exits `0`:

```text
Usage: agy install [flags]

Configure environment paths and shell settings

Flags:
  --dir           Custom directory target to configure PATH for
  -h              Show help
  --help          Show help
  --skip-aliases  Bypasses shell profile alias purging
  --skip-path     Bypasses shell profile PATH appending
```

`agy help models` and `agy models --help` both exit `0`:

```text
Usage: agy models [flags]

List available models

Flags:
  -h      Show help
  --help  Show help
```

`agy plugin --help` and `agy help plugin` both exit `0`:

```text
Usage: agy plugin <command> [arguments]

Commands:
  list                   List imported plugins
  import [source]        Import plugins from gemini or claude
  install <target>       Install a plugin (supports plugin@marketplace)
  uninstall <name>       Uninstall a plugin
  enable <name>          Enable a plugin
  disable <name>         Disable a plugin
  validate [path]        Validate a plugin
  link <mp> <target>     Generate link to a marketplace
  help                   Show this help
```

## Absent subcommands and flag-only surfaces

The following names are not standalone subcommands in `agy` 1.0.9:

- `auth`
- `conversation`
- `model`
- `config`

Observed behavior:

- `agy help auth` exits `1` with `Error: unknown subcommand: auth`.
- `agy help conversation` exits `1` with `Error: unknown subcommand: conversation`.
- `agy help model` exits `1` with `Error: unknown subcommand: model`.
- `agy help config` exits `1` with `Error: unknown subcommand: config`.
- `agy auth --help`, `agy conversation --help`, `agy model --help`, `agy config --help`, `agy --conversation --help`, and `agy --model --help` exit `0` and show root help because `--help` is handled globally.

Conversation and model selection are root flags:

- Continue most recent conversation: `agy --continue`
- Resume a conversation by ID: `agy --conversation <conversation-id>`
- Select model for current session: `agy --model <model-name>`
- List available models: `agy models`

Configuration is not exposed as a `config` CLI subcommand. Official Antigravity CLI product copy describes configuration through the interactive `/config` slash command, and official settings docs describe persistent settings at `~/.gemini/antigravity-cli/settings.json`.

## Auth boundary

No interactive auth command was run during this probe. The first real interactive session or non-interactive prompt is expected to require Google OAuth if no Antigravity CLI session exists.

Next command to continue manually in the same isolated scratch install:

```sh
HOME=/tmp/forger-antigravity-cli-probe.ljR1u2/home PATH=/tmp/forger-antigravity-cli-probe.ljR1u2/bin:$PATH agy
```

Do not run that command from automated Desktop tests because it can open or print an OAuth flow.
