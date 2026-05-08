# Local macOS signing and notarization

This documents the local macOS release flow verified on 2026-05-08.

## Release command

The local macOS release uses `release-local.mjs` as the single signing and notarization path:

```sh
cd /Users/felipepezoa/Projects/forger-workspace/desktop

CSC_LINK=/Users/felipepezoa/Forger/signing/forger-developer-id.p12 \
CSC_KEY_PASSWORD="$(tr -d '\r\n' < /Users/felipepezoa/Forger/signing/forger-developer-id.p12.password)" \
npm run release:local:mac:wait -- --allow-dirty --tag=forger-desktop/vX.Y.Z
```

Use `--allow-dirty` only when unrelated local changes are present and have been reviewed. The release changes themselves must still be committed before tagging.

The command performs these steps:

1. Imports the Developer ID certificate into a temporary keychain.
2. Temporarily signs macOS runtime archives that require Forger signing.
3. Builds the macOS DMG through `electron-builder`.
4. Restores the runtime archives in the working tree.
5. Signs the DMG with the Developer ID identity.
6. Submits the DMG with `xcrun notarytool submit --keychain-profile forger-notary --wait`.
7. Staples the accepted notarization ticket.
8. Writes checksums and uploads the DMG assets to the GitHub Release.

## Runtime signing policy

The script signs only macOS archives under these runtime roots:

```text
resources/runtimes/python
resources/runtimes/git
```

The script does not sign or repack archives under:

```text
resources/runtimes/node
```

Node archives are distributed with their upstream signature and entitlements. Re-signing Node replaces those entitlements and can cause macOS to reject the runtime when Desktop launches installed apps.

Runtime archive changes are temporary during the build. `release-local.mjs` backs up the original archive and checksum files before signing, builds the DMG with the signed copies, then restores the original files before upload.

## Notarization path

`electron-builder` is configured with `mac.notarize = false`. The build does not rely on Electron Builder notarization or a second manual notarization path after a failed attempt.

Notarization is handled directly by the release script:

```sh
xcrun notarytool submit release/forger-desktop-macos-arm64.dmg \
  --keychain-profile forger-notary \
  --wait \
  --timeout 30m \
  --output-format json
```

The expected accepted response contains:

```json
{
  "status": "Accepted",
  "message": "Processing complete"
}
```

When Apple returns a non-accepted status, the script writes the submission metadata to:

```text
release/notarization-submission.json
```

If a submission id is available, it also writes the Apple notarization log to:

```text
release/notarization-log.json
```

The script stops on notarization failure. Do not continue with a manual DMG-only path unless the script itself is being repaired.

## Validation

After a successful notarization, the script staples the DMG. Validate the final artifact with:

```sh
spctl -a -vvv -t open --context context:primary-signature release/forger-desktop-macos-arm64.dmg
```

Expected result:

```text
accepted
source=Notarized Developer ID
origin=Developer ID Application: Felipe Pezoa (Q58U66S52T)
```

The final release asset checksum must match the checksum published in the desktop metadata after the Pages metadata refresh.
