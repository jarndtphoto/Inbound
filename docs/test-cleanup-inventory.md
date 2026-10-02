# Inbound test cleanup: Phase 1 inventory

Repository: `jarndtphoto/Inbound`
Requested base: main `6d66a8d` (includes PR #31)
Date: October 2, 2026

## Current status

Phase 1 inventory was reported before repository changes. The table records the original failures and proposed categories; the cleanup outcome follows below.

The FR24 failure is a **REAL BUG**: fusion chose a 50-second-old FR24 ground position over a one-second-old airborne ADS-B position in a deterministic reproduction. The 30-second check in `applyFr24GroundExperiment()` does not remove an FR24 position already selected by fusion. That fix would affect visible positions and possibly stages, so the cleanup instructions require holding it for approval.

The existing verification logs contain **21 script failures, 3 library failures, and 5 type errors**. This inventory uses those logs and the corresponding source. These are not fresh cleanup verification results.

## Inventory

| # | Problem / file:line | What it checks | Classification | Evidence and proposed fix |
|---|---|---|---|---|
| 1 | Baggage suite — `scripts/baggage.test.mjs:1` | Exact-leg baggage matching and isolated upstream failures. | ENVIRONMENT | Suite cannot load extensionless `env.server` import. Add consistent test import resolution; preserve assertions. |
| 2 | Diversion suite — `scripts/diversion.test.mjs:1` | Diversion records remain tied to the correct flight. | ENVIRONMENT | Suite cannot load extensionless `weather-events` import. Use the same test import resolution. |
| 3 | Sustained movement → Taxi — `scripts/flight-audit-regression.test.mjs:552` | Sustained movement advances departure progress. | STALE TEST | Fixture supplies neither `taxiHint` nor a taxi latch, which the classifier requires. `8c14328` introduced first-movement protection. Test first movement and subsequent confirmed taxi separately. |
| 4 | UA219 detected push — `scripts/flight-audit-regression.test.mjs:587` | Estimates stay non-actual; observed push remains recorded. | STALE TEST | Failure is old passenger wording. `bdcfb70` simplified departure messaging. Update copy assertion while preserving time/source assertions. |
| 5 | UA3600 monotonic taxi — `scripts/flight-audit-regression.test.mjs:674` | Taxi never regresses to Pushback. | STALE TEST | Same obsolete wording from before `bdcfb70`. Preserve stage progression checks; update copy. |
| 6 | UA3 public route — `scripts/flight-audit-regression.test.mjs:788` | Public status parsing resolves ORD→ZRH. | REAL BUG | Parser requires both airports in its local directory; ZRH is absent, so this fixture returns null. Hold route-support change for approval; document TODO. |
| 7 | Public actual gate times — `scripts/flight-audit-regression.test.mjs:797` | Public scheduled and actual times retain correct timestamps. | REAL BUG | Parser added in `426d889` requires the date immediately before each time label. Fixture gives one date followed by Scheduled and Actual, so Actual becomes null. Hold visible timing change; document TODO. |
| 8 | No invented route — `scripts/flight-resilience.test.mjs:117` | Missing schedule cannot borrow an unrelated ADS-B route. | STALE TEST | Correct rejection occurs, but test expects `HTTP 402` instead of current route-unavailable message. Assert the current rejection contract. |
| 9 | Invalid saved context — `scripts/flight-resilience.test.mjs:120` | Wrong-flight, expired, and future-event context is rejected. | STALE TEST | Same error-text mismatch. Keep each invalid-context case and update expected message. |
| 10 | Cache isolation/recovery — `scripts/flight-resilience.test.mjs:134` | Device context stays isolated and providers can recover. | STALE TEST | Stops at the same obsolete `HTTP 402` assertion. Update it, then execute remaining recovery checks. |
| 11 | Schedule expiry — `scripts/flight-resilience.test.mjs:161` | Partial refreshes cannot extend the original schedule lifetime. | STALE TEST | Expiry rejection occurs with the current route-unavailable message. Update assertion; retain expiry checks. |
| 12 | Flight shell suite — `scripts/flight-shell.test.mjs:1` | Shell layout and hidden-page polling behavior. | REAL BUG | Test file itself has an invalid, overescaped regular expression. Repair test syntax and run all five previously blocked tests; no polling changes. |
| 13 | Share metadata overwrite — `scripts/grok-pwa-plugin.test.mjs:105` | Injected share metadata follows title precedence. | ENVIRONMENT | Test reads Inbound’s real site identity from its working directory. Use an isolated fixture directory. |
| 14 | Host-title fallback — `scripts/grok-pwa-plugin.test.mjs:246` | Published hostname supplies a fallback title. | ENVIRONMENT | Inbound’s site title overrides the hostname. Isolate filesystem context. |
| 15 | Placeholder/custom image — `scripts/grok-pwa-plugin.test.mjs:305` | Custom artwork wins only when present. | ENVIRONMENT | Real `public/og.jpg` contaminates the placeholder case. Use empty/custom fixture directories. |
| 16 | Placeholder color — `scripts/grok-pwa-plugin.test.mjs:326` | Valid hex color enters the placeholder image URL. | ENVIRONMENT | Real custom artwork bypasses placeholder generation. Isolate filesystem context. |
| 17 | Title entity escaping — `scripts/grok-pwa-plugin.test.mjs:349` | Document title entities are escaped once. | ENVIRONMENT | Real site title replaces the fixture’s document title. Supply isolated context. |
| 18 | Headless document injection — `scripts/grok-pwa-plugin.test.mjs:365` | Metadata is inserted when `<head>` is absent. | ENVIRONMENT | Expected fixture title is replaced by Inbound’s identity. Isolate context; retain injection checks. |
| 19 | Uppercase streaming head — `scripts/grok-pwa-plugin.test.mjs:372` | Streaming injection handles `</HEAD>`. | ENVIRONMENT | Fixture title assertion is contaminated by workspace identity. Isolate context; retain streaming checks. |
| 20 | Injected app title — `scripts/grok-pwa-plugin.test.mjs:397` | Injected title uses the supplied app name. | ENVIRONMENT | Real site identity overrides supplied fixture name. Isolate filesystem context. |
| 21 | Apple standalone metadata — `scripts/inbound-pwa.test.mjs:25` | iPhone metadata and safe-area support remain present. | STALE TEST | `d98073d` uses `black-translucent`; test expects `default`. Update status-bar expectation and retain other PWA checks. |
| 22 | Overview disclosures — `src/lib/brief-copy.test.ts:390` | Live priorities remain visible alongside secondary details. | STALE TEST | `d2208e1`/`fee9a69` changed Overview ordering and timing presentation. Assert the current visible priorities and disclosures. |
| 23 | Live altitude/speed placement — `src/lib/brief-copy.test.ts:408` | Airborne altitude/speed remain visible near refresh controls. | STALE TEST | Redesign moved the controls and telemetry; old `TimesStrip` structure no longer applies. Check current rendered placement and visibility conditions. |
| 24 | Stale FR24 surface fusion — `src/lib/flight-data.test.ts:60` | Fresh airborne data supersedes stale surface data. | REAL BUG | Reproduced stale FR24 selection; `65876d8` introduced the ground-only fallback pool. Hold position/stage change; document TODO linked to the reason. |
| 25 | Query identity argument — `src/components/filed-app.tsx:521` | Returned story can be checked against the requested flight. | TYPE-ONLY | Server-function serialization error makes result `unknown`. Fix provider serialization types at the source. |
| 26 | Story merge argument — `src/components/filed-app.tsx:525` | Returned story is accepted by client merging helpers. | TYPE-ONLY | Same cascading `unknown` result. Fix source types without casts that conceal the error. |
| 27 | Normalized aircraft phase — `src/lib/story.ts:40` | Normalized aircraft satisfies `LiveAircraft`. | TYPE-ONLY | `normalizedToLive()` widens `phase` to `string`. Give it a properly checked return type. |
| 28 | Resume departure stage — `src/lib/story.ts:168` | Persisted departure stage stays within allowed checkpoints. | TYPE-ONLY | Intermediate object widens `departureStage` to `string`. Explicitly type the checkpoint/resume construction. |
| 29 | Server result serialization — `src/lib/story.ts:246` | FlightStory is serializable across the server boundary. | TYPE-ONLY | `providers` has an unrestricted `unknown` index signature. Define its serializable diagnostic payload properly. |

## Fixes held for approval

Three app behavior bugs are held:

- ZRH public-route support.
- Public actual-time parsing.
- Stale FR24 surface fusion.

The malformed shell-test regex is a test-code bug that can be fixed within the cleanup. No tests need deletion based on this inventory.

## Cleanup verification

- Original script suite: 327 tests, 306 passed, 21 failed.
- Original separate library suite: 213 tests, 210 passed, 3 failed.
- Original typecheck: 5 errors. Build passed.
- Cleanup: 576 tests, 573 passed, 0 failed, 0 skipped, 3 executable TODO regressions.
- Typecheck: 0 errors. Build passed.
- No tests deleted. Restored imports and shell syntax expose additional tests.
- Restoring the baggage suite exposed a stale no-fetch assertion: FlightStats public fallback now covers airports beyond dedicated boards. The updated test checks invalid flights make no calls, valid public fallback is attempted, and offline failures remain isolated.
- Restoring the shell suite exposed an obsolete prohibition on the redesigned flight identity header; its assertion now checks the current header, appearance control, and Home navigation.
- npm test uses one Node runner with both disjoint globs. New src/**/*.test.ts files are discovered automatically; no file is selected twice.
- npm run check runs typecheck and all tests. Existing lint is excluded: 17 errors and 43 warnings. Unrelated lint changes are outside this PR.
- Runtime values, stages, positions, polling, and provider calls are unchanged by this cleanup.

The three held app regressions are documented in [test-cleanup-held-bugs.md](test-cleanup-held-bugs.md). Follow-up fixes for #24 and #7 are separately approved; #6 remains on hold.
