# Optional campaign measurement

Forger asks for separate, explicit permission before sending campaign measurements to the dedicated Forger project in PostHog US Cloud. The default is off. Downloading, onboarding, creating apps, and using Forger do not require permission. An older usage-analytics preference and consent on the website do not authorize this recipient.

## Ownership and boundaries

- `src/main/campaign-measurement-owner.ts` creates a lazy owner for each main IPC composition. It performs no profile access, capture, or lifecycle registration until first use. It registers application-quit cleanup once. There is no process-global singleton that shares state between independent compositions.
- `src/main/campaign-measurement.ts` owns consent, eligibility, local state, the bounded outbox, cancellation, and retries.
- `src/main/campaign-measurement-transport.ts` sends manually constructed events to the fixed `https://us.i.posthog.com/i/v0/e/` endpoint. The project token is a public write-only ingest token, not a personal credential. Redirects are rejected. Each attempt is bounded to five seconds.
- `src/main/ipc/campaign-measurement-handlers.ts` permits only the main frame of the primary Desktop window. Installed-app frames, friend-chat windows, other frames, absent frames, and arbitrary payload fields cannot grant consent or emit milestones.
- Preload exposes narrow typed operations. The renderer cannot supply an identifier, event payload, endpoint, or arbitrary event name.
- `src/renderer/campaign-measurement.ts` captures preexisting-profile evidence before startup can create legal or onboarding markers. The main process independently checks the installed-app registry. Missing or unreadable evidence is handled conservatively.
- The MUI panel is available in Welcome and Settings → Privacy & security → Optional measurement. A valid campaign link opens a separate optional dialog; it does not change consent.

Capture is enabled only in a packaged production build, never in development, unpackaged builds, `NODE_ENV=test`, or an isolated E2E profile. Tests use explicit service options and mocked transports; a deliberately authorized receiver test uses `environment: test` and disposable synthetic state.

## Eligibility and event meaning

The only event names are `forger_campaign_first_open` and `forger_campaign_first_app_created`.

First opening means a conservatively identified new local profile that gives permission in its initial process session. Existing profiles, unknown profiles, and later opt-ins do not become new acquisitions. The first-app milestone requires that same eligible first-open cohort and an explicitly signaled successful user creation. Startup detection, catalog downloads, failures, and earlier activity are not backfilled. If a first app exists before permission or its observation cannot be preserved safely, a later app is not relabeled as the first.

The first-open and first-app events share one random local-profile identifier. The identifier is created only when permission and event eligibility permit enqueueing. Clearing both local profile and workspace can make a new profile; the measure is not a verified unique person. These events are an incomplete consenting sample, not total installations or total users. Failed delivery can undercount.

Payloads include only a known campaign code or `unattributed`, `surface: desktop`, schema version, production/test environment, Desktop version, platform, and the privacy flags `$process_person_profile: false` and `$geoip_disable: true`. Event UUID and timestamp are separate deduplication fields. No account, email, app identifier or name, external URL/referrer, file path, file contents, prompt, chat, credential, advertising click identifier, or hardware fingerprint is included. No analytics SDK, session recording, automatic interaction capture, identity merging, or person-profile processing is used.

The old usage collector is inert in both renderer and main IPC. Compatibility exports do not generate identifiers or event history. Legal acknowledgements remain separate from optional measurement.

## Campaign handoff

`forger://campaign?code=<known-code>` accepts only the strict campaign shape and the ten codes declared in `src/shared/campaign-measurement.ts`. Pages owns the matching public UTM-to-code registry in its separate repository. The shared code list must stay synchronized across both repositories.

The link carries no browser identifier or permission. It does not provide deferred attribution from a downloaded installer. Users can enter the public code manually before allowing measurement. Unknown, malformed, duplicated, or extra parameters do not grant permission or become free-form telemetry.

Attribution and the entire payload freeze when an event is queued, before its first send attempt. A timeout can occur after server receipt, so retries keep the same UUID, timestamp, version, platform, environment and campaign. Later links cannot rewrite earlier events.

## Local storage, failure and withdrawal

The versioned state file is private to the Desktop profile. It stores non-identifying eligibility flags before permission, and a random identifier and at most two queued events only after permission. Pending events have at most five attempts and expire after seven days. Capture failures never block the user's app work.

Declining or withdrawing pauses sending, aborts pending transport, clears the local identifier and outbox, and permanently makes that profile ineligible for acquisition milestones. Re-enabling does not replay first opening or split a first-open/first-app cohort across new identifiers. Only non-identifying lifecycle state remains.

A separate withdrawal marker overrides stale enabled state if an atomic state write fails. Cleanup is limited to measurement-owned files. If withdrawal cannot be saved, the current process stays paused and the panel explicitly asks the user to retry before closing. It does not falsely promise persistence. Withdrawal does not delete events already received by PostHog.

PostHog necessarily processes a network request. The dedicated project discards stored client IPs, and events disable GeoIP enrichment. These controls do not mean requests stay local or that the receiver never handles connection metadata.

## Verification and reporting

Behavioral tests cover fresh/existing/unknown cohorts, refusal, withdrawal and disk failure, pre-consent creation, restarts, stable retry payloads, bounds and expiry, malicious IPC senders, strict links, owner lifecycle and renderer composition. Real Electron smoke uses an isolated profile and verifies visible choices, handoff, Settings access and disabled test-build capture without using an installed user profile.

Receiver verification sends only expressly authorized synthetic events. Campaign dashboards require `environment: production`; QA dashboards require `environment: test`. Web and Desktop identifiers are separate, so no cross-device person-level funnel is claimed. Download-button clicks and requests to open the protocol are not completed downloads or installations.

Publication requires full regression checks and the existing signed/notarized release workflow. Website handoff publication follows availability of the corresponding Desktop release.
