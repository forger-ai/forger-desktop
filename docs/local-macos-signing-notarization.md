# Local macOS signing and notarization

This documents the local state verified on 2026-05-01.

## What works

The Developer ID certificate exists locally as a password-protected p12:

```sh
/Users/felipepezoa/Forger/signing/forger-developer-id.p12
/Users/felipepezoa/Forger/signing/forger-developer-id.p12.password
```

Importing it into a temporary keychain exposes this identity:

```text
Developer ID Application: Felipe Pezoa (Q58U66S52T)
```

A local macOS build can be signed with:

```sh
CSC_LINK=/Users/felipepezoa/Forger/signing/forger-developer-id.p12 \
CSC_KEY_PASSWORD="$(tr -d '\r\n' < /Users/felipepezoa/Forger/signing/forger-developer-id.p12.password)" \
npm run release:local:mac -- --allow-dirty --skip-notarize
```

That signs `release/mac-arm64/Forger.app` with Developer ID. `release-local` also signs the DMG explicitly after `electron-builder` creates it:

```sh
codesign --force --timestamp \
  --sign "Developer ID Application: Felipe Pezoa (Q58U66S52T)" \
  release/forger-desktop-macos-arm64.dmg

shasum -a 256 release/forger-desktop-macos-arm64.dmg > release/forger-desktop-macos-arm64.dmg.sha256
```

After this, `codesign --display --verbose=4 release/forger-desktop-macos-arm64.dmg` reports the Developer ID authority and secure timestamp.

## Current blocker

Notarization credentials are not configured locally.

Local checks found no stored `notarytool` profile:

```sh
security find-generic-password -s com.apple.gke.notary.tool
```

The available App Store Connect key files are:

```text
/Users/felipepezoa/Downloads/AuthKey_69QTQ3DBHK.p8
/Users/felipepezoa/Downloads/AuthKey_KGXXL653H6.p8
/Users/felipepezoa/Downloads/AuthKey_NBAJTS7U52.p8
```

Testing those keys without an issuer returned `401 Unauthenticated`, so they are either not Individual API keys, are revoked, or require the App Store Connect issuer UUID. No local `APPLE_API_ISSUER` value was found.

Until a valid `notarytool` credential is available, Gatekeeper reports:

```text
source=Unnotarized Developer ID
origin=Developer ID Application: Felipe Pezoa (Q58U66S52T)
```

## Needed to complete notarization

Use one of these credential options:

```sh
# App Store Connect team API key
xcrun notarytool submit release/forger-desktop-macos-arm64.dmg \
  --key /path/to/AuthKey_KEYID.p8 \
  --key-id KEYID \
  --issuer APP_STORE_CONNECT_ISSUER_UUID \
  --wait \
  --timeout 30m
```

Individual API keys use the same command without `--issuer`.

or:

```sh
# Apple ID app-specific password
xcrun notarytool store-credentials forger-notary \
  --apple-id APPLE_ID \
  --team-id Q58U66S52T \
  --password APP_SPECIFIC_PASSWORD

xcrun notarytool submit release/forger-desktop-macos-arm64.dmg \
  --keychain-profile forger-notary \
  --wait \
  --timeout 30m
```

If Apple returns `Accepted`, staple the ticket:

```sh
xcrun stapler staple release/forger-desktop-macos-arm64.dmg
xcrun stapler validate -v release/forger-desktop-macos-arm64.dmg
spctl -a -vvv -t open --context context:primary-signature release/forger-desktop-macos-arm64.dmg
```

Expected final Gatekeeper result:

```text
accepted
source=Notarized Developer ID
```
