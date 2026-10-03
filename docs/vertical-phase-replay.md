# Sustained vertical phase replay

Base: main `3ceca9ab0baf504b68042fdad69cf1e0023eb3c3`.

Raw provider vertical rate stays a display measurement (null if absent). Phase uses a net altitude change across 30–120 seconds of existing, nearby airborne observations, or consistent same-sign provider rates spanning at least 30 seconds when altitude evidence is unavailable. Repeated timestamps, extrapolated/stale current fixes, opposing altitude evidence and ±400 fpm cruise jitter cannot confirm a trend. Existing tracks provide cold-start evidence; a bounded 1,000-key/64-sample warm cache supplements them. Without track history a new phase waits for the evidence window; no extra requests or shared-state schema are introduced.

A sustained rate ≥300 fpm gives climb; ≤−300 gives descent. Approach additionally needs <8,000 ft AGL and arrival geometry. A low departure level-off near origin remains climb. Arrival requires being outside the origin surface area (or closer to destination on a short leg) and either within 40 nm of destination or within 100 nm and closer to destination than origin. Final approach retains the existing 12 nm/7.5 nm, altitude and speed gates and now consumes the confirmed trend, rather than an individual raw rate.

## Reader audit

| Reader | Handling |
| --- | --- |
| `normalizedToLive` | Raw rate retained; shared phase helper with route/elevation context. |
| `liveFromTracePt`, `liveFromAware`, `fa-track` | Same helper; existing trace altitude/time samples provide ≥30s cold-start trends. FlightAware has no established explicit vertical-rate field here. |
| `currentStageOf`, `finalApproachEvidence` | Sustained rate and destination geometry; departure descent cannot enter arrival. |
| `asOnGround`, inbound surface taxi/parked logic | Ground labels and their existing speed thresholds retained. |
| Story wrapper FR24 replacement, movement-map fast fix | Ground behavior retained; airborne display uses the shared helper. |
| `sky.toTraffic`, traffic rows, aircraft detail | Shared sustained phase, raw baro/geom rate; phase label remains visible beside airline/type; detail shows real ±fpm. |
| Arrival projection | Algorithm/store unchanged; existing independent raw/altitude evidence retained. Captured replay states are identical to main. |
| Confirmed takeoff, position fusion | Rules unchanged; existing UA219/MDW and fusion regression suites run in `npm run check`. |

## Exact-main comparison

`node --experimental-strip-types --import ./scripts/test-imports.mjs scripts/compare-phase-replays.mjs /absolute/path/to/clean-main-worktree` builds each worktree's real classifier/normalizer and asserts the baseline is exactly the commit above. It makes no provider requests.

| Replay | Main | PR | Earlier |
| --- | --- | --- | --- |
| Synthetic 6,000-ft departure with level-off/brief −400 | Ride | Ride; climb phase | None |
| Synthetic cruise ±400 jitter | Ride/cruise | Ride/cruise; raw jitter retained | None |
| Synthetic descent starting at 80 nm, −1,500 fpm, 5 nm/min | Arrival at minute 9 | Arrival at minute 0 | **9 minutes** |
| Synthetic base-to-final, 11.5 nm, −600 fpm, 70° heading offset, ~0.8 nm/min radial closure | Final approach at minute 5 | Final approach at minute 0 | **5 minutes** |
| Captured AA662 ORD arrival | 58 fixes | All projection states/reasons/distances identical | No projection change |
| Captured UAL2207 ORD arrival | 17 fixes | All projection states/reasons/distances identical | No projection change |

The two earlier-stage numbers are threshold results for these synthetic fixtures, not timing measurements from live flights. A 60-second lookback precedes minute zero to establish descent. UAL2207 already qualified via heading geometry; AA662's level downwind remains unchanged before sustained descent.

AA662 provenance: `PR30_Followup_Evidence.zip/pr30-followup-aa662-evidence.json`, capture head `510418042644550e9d95ae2c8d953804e7879857`, 2026-10-02. The new fixture contains actual ADS-B position records for airborne events with both telemetry and projection records, including repeated near-threshold fixes. No coordinates were reconstructed. UAL2207 uses the original PR #30 checked-in capture.

## Display verification

`node scripts/verify-aircraft-phase.mjs` builds the actual traffic/detail components with local adapter fixtures and browser-checks phone (390×844) and desktop (1280×800): Descending/Climbing remain visible with airline/type, details show −900/+900 fpm, no Cruise label during confirmed descent, no page errors or external requests. Set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` when using a separately installed Chromium; `PHASE_SCREENSHOT_DIR` selects the output directory.
