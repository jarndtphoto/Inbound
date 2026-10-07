# Part 3B.2 — private route enrichment

Completed October 3, 2026, America/Chicago (October 4 UTC). Implementation and fake-provider verification are complete. Approval is pending. The full application check remains red because of two reproduced baseline date failures; no unrelated date fix was included.

## Source and delivery

| Item | Result |
|---|---|
| Repository | `jarndtphoto/Inbound` |
| Starting SHA | `d6ef464a4d5c80fe70aa8191e3d1d664e759ac5b` |
| Branch | `plugin-v1-route-enrichment` |
| Implementation commit | `11abfb4896658f22525433a40d3e1ac637e2cecb` |
| Implementation parent | Exact starting SHA above |
| Excluded commit | `df2082de76ad6f0c05153419154a702320236ba0` is not an ancestor |
| Delivery | Local commits only; no push, merge or deployment |
| Report/evidence commit | The following local commit on this branch contains this report and the logs; its SHA is supplied in the delivery response |

Changed implementation files:

- `src/lib/nearby-v1/engine.server.ts`
- `src/lib/nearby-v1/route-hints.ts`
- `src/lib/nearby-v1/route-hints.test.ts`
- `src/lib/nearby-v1/route-hint-store.server.ts`
- `src/lib/nearby-v1/route-hint-store.test.ts`
- `src/lib/nearby-v1/route-enrichment.ts`
- `src/lib/nearby-v1/route-enrichment.test.ts`
- `src/lib/nearby-v1/route-engine.test.ts`
- `docs/plugin-v1/migrations/0007_route_hint.sql`
- `docs/plugin-v1/Part_3B2_Route_Source_Review.md`

This report and `verification/part-3b2/` evidence are the only additional tracked files. Existing ranking, stability, normalization, phase logic, collection coordination, accepted-snapshot storage, motion, fixture sources and application story/provider code are unchanged from the starting SHA.

## Private contract and shared storage

`NearbyRouteHint` contains the normalized **observed** callsign, nullable origin/destination IATA, nullable bounded airline label, positive/negative outcome, checked/expiry timestamps, private source classification and `hint`/`unknown` verification. Strict validation rejects extra fields, raw payloads, malformed IATA, detailed occurrence bindings, unsafe labels and excessive TTLs. A positive result needs at least one endpoint; a negative result contains no route or airline information. A generic lookup cannot declare `confirmed`.

| Policy | Value |
|---|---|
| Positive maximum TTL | 30 minutes / 1,800,000 ms |
| Negative and lookup-failure maximum TTL | 60 seconds / 60,000 ms |
| Construction pool | 12 eligible aircraft: retain up to five incumbents, then route-neutral challengers |
| New lookup budget | At most two per accepted collection cycle and six per rolling 60 seconds |
| Rolling window | `(now − 60 seconds, now]`; exact 60-second boundary is eligible |
| Lookup timeout | Two seconds, with an abort signal |
| Shared lease | Ten seconds, UUID owner plus fencing generation |
| Crash retry protection | Sixty seconds |
| Current cache cap | 192 rows per environment, including pending leases |

Migration **`docs/plugin-v1/migrations/0007_route_hint.sql`** is incremental after `0006_nearby_collection.sql`. Only disposable local PGlite databases received these two migrations for the new tests. No Neon connection or migration occurred. The new migration stays outside automatic application migration discovery.

The migration adds exactly:

- `inbound_plugin_v1.route_hint`: one overwritten current row per environment/observed callsign, with bounded route fields, TTL constraints, lease/fencing and retry state.
- `inbound_plugin_v1.route_construction_budget`: one mutable row per environment/shared Chicago collection. It holds collection version plus accepted-snapshot time, a two-start cycle counter and at most six recent start timestamps.

Two private SQL helpers atomically claim work and clean expired rows. No existing table is altered or dropped. There are no user rows, raw-response columns, aircraft-history tables, route archives or append-only minute ledgers. The bounded recent-start array is overwritten quota state.

Claims require the exact current, successful, active collection and a snapshot no older than 45 seconds. SQL rechecks database time after budget and callsign lock waits. Cache hits and losing contenders consume no quota. Publication uses the database clock, owner/generation fencing and an unexpired lease; duplicate or stale publication fails. Cleanup takes budget then hint locks, matching claim order, and retains quota protection across collection deletion/recreation.

## Construction and read behavior

The route service requires an injected lookup implementation. There is no default live route adapter. Construction is an **explicit private task**, `constructRouteHints`; viewer requests neither invoke a route provider nor start background work. No scheduler or public endpoint was added.

Construction ranks eligible aircraft with route evidence neutralized, selects the bounded pool, reads shared positive/negative hints, and claims only missing keys under the shared SQL budget. It overlays hints on private copies for final Featured ranking. Accepted telemetry remains unchanged in SQL.

`requestRadar` reads accepted telemetry without awaiting route-cache reads, construction or lookups. The combined Featured request may await shared-cache reads; it never awaits a route provider. Its Radar selection, motion and byte accounting use accepted telemetry, with the returned Featured board supplying matching `featured` flags. Cache errors preserve the accepted aircraft.

Hints checked after the collection publication are displayed when current but are not backdated to obtain ranking points. Their score contribution takes effect on a subsequent successful collection. Re-reading the same collection version cannot consume another competitive board replacement.

## Instrumented fake-provider results

These are 100 separately created engine/store instances against shared disposable PGlite SQL, **not 100 independent real Postgres sessions**. Real Neon certification of the new migration remains a later approval step.

| Scenario | Exact result |
|---|---|
| 100 simultaneous cold Chicago viewers | One fake aircraft acquisition; 99 warming contenders; zero route lookups |
| 100 warm viewers | No additional acquisition and zero route lookups; all receive the same Featured board |
| 100 explicit construction workers, first collection | Exactly two fake route lookups, one each for `UAL1` and `UAL2`; two publications |
| Successful collection cycles at 20 and 40 seconds | Two new lookups each; six cumulative fake lookups |
| Workers at 59 seconds | Zero new lookups; six cumulative |
| Exact 60-second boundary with a new collection | Two new lookups; eight cumulative; never more than six in the open rolling window |
| Positive/negative reuse in that scenario | Positive `UAL1` looked up once; negative `UAL2` looked up twice after expiry |
| Cache occupancy after eight lookups | Seven current rows; refreshing `UAL2` overwrites its row |
| 100 same-callsign SQL claim contenders | One lease winner and one charged start; cache hits charge zero |
| Separate failure scenario, 100 workers | Two fake failures initially; zero immediate retries; two retries at 60 seconds, four fake calls cumulative |
| Chicago / ORD / MDW | One shared collection and route cache; one fake acquisition and two fake route lookups |
| Live aviation-provider calls | **Zero**, including aircraft and route providers |

Store tests additionally cover expired leases, crash cooldown, stale-owner rejection, duplicate publication, environment isolation, maximum row occupancy, cleanup after inactivity, concurrent cleanup/claim operations, collection recreation, strict TTL bounds and caller-clock protection. Concurrent cleanup/recreation still produces exactly two winners and two charged starts. Eventual cleanup removes hints and the expired budget; repeat cleanup is idempotent.

## Verification, ranking, stability and privacy

Existing `currentRoute` rules are reused without alteration. Confirmation needs matching session/callsign, a valid service date and a current valid confirmation timestamp. Missing, stale, future or mismatched bindings downgrade to hint; missing/unusable route fields downgrade to unknown. Existing usable Inbound route evidence wins disagreements with generic cache data. A generic hint never gains a dated binding.

Normalization preserves operating identity and does not fold marketing aliases: `EDV123` and `DAL123`, or `UA` and `UAL`, remain separate route keys. Callsign changes require fresh evidence for the new key. Existing Radar continuity rules remain unchanged; cache evidence does not establish aircraft continuity.

| Check | Result |
|---|---|
| Generic hint ranking weight | Existing **+5** only |
| Confirmed route ranking weight | Existing **+15** |
| Airport association | Existing **+5**, only for confirmed route |
| Unknown route | Remains Featured-eligible and Radar-eligible |
| Featured | Five-slot board; four default / five maximum |
| Stability | Existing 90-second hold, 20-point challenger margin, deterministic ties and at most one competitive replacement per newer successful collection |
| Transitions | Unknown→hint, hint→confirmed, expiry, negative→positive, callsign/session change, disagreement and outage covered |
| Radar | 125 invented observations exercised; capped at 100 and at **49,152 UTF-8 JSON bytes** |
| Motion | Accepted ground track retained; no track invention; existing 25-second extrapolation bound unchanged |
| Renderer route projection | Only origin/destination IATA, verification, checkedAt and an optional validated matching airline label |
| Private fields | Provider/source, endpoint/raw response, aircraft/session identity, cache/database keys, budget state, occurrence IDs and phaseEvidence excluded from the renderer projections |

The combined private `NearbyView` still contains private ranked candidates for internal coordination. It is **not** a public DTO and remains unmounted. `featuredRouteDisplay` prepares an explicit route allowlist for the future renderer; Radar uses the existing explicit telemetry allowlist. No full single-flight/story resolver is imported or called by route construction.

## Official future-source review

See [Part_3B2_Route_Source_Review.md](Part_3B2_Route_Source_Review.md) for official references, pricing, quotas, attribution and cache restrictions.

- **ADSBDB:** route-data copying/publication/database incorporation requires explicit rightsholder permission. Its software license does not grant those data rights. A generic callsign response supplies no dated confirmation.
- **FR24:** current API terms prohibit supplementing/backfilling another provider's near-time or real-time data. The proposed ADS-B enrichment needs explicit written terms; a paid API subscription alone does not resolve this restriction.
- **FlightStats/Cirium:** official FlightStats policy forbids scraping. The published paid API agreement restricts sharing one query across devices, permits only three-day caching and requires written permission for real-time mixing, plus public attribution. The default terms do not establish permission for this shared plugin architecture.

No reviewed source was approved or implemented. Public official documentation was read; aviation-data endpoints were not called, credentials were not requested and providers were not contacted.

## Sequential application gates

Both commands ran with `DATABASE_URL` and `NEARBY_VERIFY_DATABASE_URL` unset, without a clock workaround or source edits:

1. `npm run check`
2. `npm run build`

| Gate | Exact result |
|---|---|
| Typecheck | Passed |
| Full test run | **907 tests, 88 suites; 904 passed, 2 failed, 1 TODO, 0 skipped, 0 cancelled**; 60,587.940 ms; check exit 1 |
| Added route tests | **51 passed, zero failed**: 17 model, 12 SQL store, 17 enrichment, five integrated engine tests |
| Existing TODO | `flight-audit-regression.test.mjs`: “loads an exact route from a FlightStats-style public status page”; held unknown-airport route-support bug |
| Build | Passed, exit 0 |
| Production migrator | Explicitly skipped: `DATABASE_URL not set` |

The two failing tests are `scripts/route-memory-replay.test.mjs` and `scripts/takeoff-floor-replay.test.mjs`. The same two fail on unchanged certified application code after the UTC date rolled to October 4. They replace `Date.now()`, while application schedule-date construction also uses `new Date()`. Their October 2 mocked FlightStats response is therefore missed by the real-date search window. The baseline reproduction had two tests, zero passes, two failures, zero TODO/skipped/cancelled, exit 1. No other-chat fix, including `df2082`, was imported, and the unrelated date logic was not changed.

Complete check/build/baseline logs and their hashes are in [verification/part-3b2/](verification/part-3b2/). The normal application gate is **not claimed green**.

## Safety and next approval

- Inbound main and the nearby-acquisition branch were not changed by this work. The route branch descends directly from exact `d6ef464`.
- Neon main, all production data and existing production tables were neither read nor written. No live database connection was used for Part 3B.2.
- Fixture MCP, `inbound-live-fixture-dev` and Inbound Live Radar Dev were untouched. The unchanged local fixture-build script generated only an ignored test artifact; nothing was published.
- No live aircraft or route provider calls, credential requests, provider contact, continuous polling, public real-data endpoint or real aircraft exposure occurred.
- No push, merge, production deployment, Track flight, Part 3B.3 or Part 3B.4 was started.

Before proceeding: obtain the user's approval; resolve the known application-check failures through separately approved work; and, when authorized, certify `0007` and shared route coordination on a fresh schema-only isolated Neon branch. Explicit production route-data rights, approved limits, attribution and retention terms are required before any real source is activated. This delivery stops for approval.
