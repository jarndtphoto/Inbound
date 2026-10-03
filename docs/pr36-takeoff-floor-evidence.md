# PR B: confirmed-takeoff floor

PR #36 remains draft and unmerged. It starts from PR #35's merge
`9ac2af497177ebf06a4d0258be8447cb4d8adb0c`. Each authorized step was pushed
before starting the next: midnight recovery `f1bdad1`, durable state `0faad1c`,
server floor `ee1c47f`, presentation/resume floor `ca1a1ce`, then final regressions.

## Behavior and identity

Confirmation belongs to the exact canonical dated leg (or its separate
unvalidated fallback row). Provider IDs remain attributes. A schedule-less
fallback based on the current UTC date may fold the previous same-ident/route
UTC day's row only if updated within 18 hours. Device-only resumes neither fold
nor save shared rows; legacy rows are retained.

`0004_confirmed_takeoff.sql` adds nullable `confirmed_takeoff` JSONB with
`time`, `source` (`provider_actual` or `observed_airborne`), and `confirmedAt`.
CAS merges never erase confirmation; provider actual supplies the event time
in preference to observation, and the first confirmation is retained. Ordinary
uncontended push reconciliation keeps its existing behavior.

A provider actual must pass canonical route/service-date validation, be in the
selected departure window, and not be in the future. Observation requires
compatible positively matched identity, a fresh non-extrapolated fix (45 s),
`onGround=false`, and altitude >500 ft AGL or speed >80 kt. Scheduled/estimated
clocks, Departed status, surface acceleration, and device claims do not confirm.

The floor is `ride` (In flight). Landing, taxi-in, gate and go-around classification
remain available. The server, wrappers, resumes, displayStage and flightAirborne
retain the floor. Diagnostic fields include `confirmedTakeoff` source/at,
`stateKey`, `candidateStage`, `selectedStageReason`, and `takeoffFloorApplied`;
`providers.canonicalKey` exposes the canonical key. Observation's `at` stays null.
Known provider actual time survives partial responses; position, source, age and
speed remain honest. The floor adds no provider endpoint or request.

Device checkpoints are explicitly stripped of takeoff evidence before the server
wrapper pipeline. Client continuity uses a prior server story only with the exact
same dated key; it cannot write shared confirmation. The existing two-hour resume
expiry is unchanged; durable confirmation survives longer gaps independently.

## UA219 replay evidence

Fixture: `scripts/fixtures/ua219-provider-handoff.json`, reconstructed from the
reported Preview telemetry and published clocks, rather than a verbatim captured
provider payload. All upstream responses are mocked; no live provider traffic.

FlightAware actual + position -> FlightStats Departed with no takeoff/position ->
FlightAware again all use `leg:v1:UAL219|2026-10-02|ORD|HNL`, with one phase row.
Across a cold start, a second client, and a 3-hour gap (expired device resume):

| Field | Partial-response result |
|---|---|
| currentStage | ride / In flight |
| times.airborne | true |
| takeoffUnix | 1790957520 |
| takeoffKind | actual |
| resume.takeoff.actual | 1790957520 |
| aircraft | null |
| chosenPosition | fallback |
| chosenPositionAgeSec | null |
| selectedStageReason | confirmed_takeoff_floor |
| takeoffFloorApplied | true |

The observed-airborne replay stores a null actual time, then keeps ride/airborne
through the same gap without inventing a clock. The real FlightHead, TimesStrip
and RouteMap render In flight, preserve actual elapsed time and omit the aircraft
marker. nextStep contains no runway instruction; composeBrief retains Took off
and appends no new pre-departure stage.

## All 11 investigation cases

| Case | Verification |
|---|---|
| 1. Exact UA219 handoff | Real cold SSR loadFlightStory and wrappers in takeoff-floor-replay.test.mjs |
| 2. Observed proof without actual | Real SSR replay + confirmed-takeoff.test.ts; null actual remains null |
| 3. Cold start, second client, >2 h | Real replay with new server module instances, no client resume, 3-hour gap |
| 4. ID/fallback/back, different date/route | Replay + flight-identity.server.test.ts with durable confirmation isolation |
| 5. Concurrent stale Taxi writes | PGlite CAS/merge tests, including same-version omission and conflicting saves |
| 6. Missing/stale/conflicting surface | Server surface replays + all wrappers/display guards; existing #33 25 s/1 s and 3 s/1 s tests pass |
| 7. No false confirmation | Scheduled/estimated/overdue/status-only tests and aborted-roll wrapper check |
| 8. Reject invalid evidence/devices | Future/date/route/identity unit tests; real forged normal/device-only resume replay, no shared confirmation writes |
| 9. Arrival and go-around | Existing landing suites + confirmed classifier taxi-in/gate/go-around checks; presentation guards |
| 10. DB read/write failure | Real PGlite failure injection: warm server/client continuity, current provider proof, explicit cold/no-proof limit |
| 11. Passenger UI and history | Real FlightHead/TimesStrip/RouteMap rendering, nextStep, elapsedFlight, rideFacts/composeBrief |

DB limitation: a cold server with neither readable durable state nor current
validated evidence cannot infer a confirmed takeoff. It reports persistence
failure. An existing client with a prior same-key server response retains its
floor. No guessed confirmation or new provider request repairs that absence.

Two old MDW tests expected valid provider actual takeoff to be overridden by
surface fixes. Those expectations now assert ride, retained actual time and
confirmation, as required by the approved behavior. Unconfirmed fusion remains
unchanged. Held #6 (ZRH/unknown-airport route support) remains TODO.

## Validation and Preview database

`npm run check`: typecheck green; 620 tests, 619 pass, 0 failures, 1 existing held
TODO. `npm run build`: green. Local db:migrate skips because DATABASE_URL is unset;
that local skip is not Preview migration evidence.

Neon Preview branch: `preview/codex/confirmed-takeoff-floor`
(`br-wandering-cherry-aubqe2k7`), database `neondb`.
A read-only SQL Editor query returned:

```
_migrations.name       = 0004_confirmed_takeoff.sql
_migrations.applied_at = 2026-10-03 02:26:26.321606+00
flight_phase_state.confirmed_takeoff data_type = jsonb
```

The final deployment's exact head/READY evidence is recorded in the PR description
once that final push finishes. No merge is authorized for PR #36.
