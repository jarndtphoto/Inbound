# Part 3B.2.1 — real Postgres certification and application gates passed

All certification and final application gates pass. The authorized files are committed locally, but feature-branch push is blocked by missing authenticated Git transport. There is **no new pushed remote SHA**. The exact final local SHA is reported separately with a verified Git bundle. This stage remains Part 3B.2.1 only.

Repository: `jarndtphoto/Inbound`. Branch: `plugin-v1-route-enrichment`. Verified worktree source HEAD: `cd9dbf611ed95e5a734d7173c9aefea93285b88d`, with the accepted test-only clock fix. Runtime implementation: `11abfb4896658f22525433a40d3e1ac637e2cecb`, directly descended from certified `d6ef464a4d5c80fe70aa8191e3d1d664e759ac5b`. All 158 runtime files and migrations 0006/0007 remain unchanged from the approved implementation. Excluded `df2082de76ad6f0c05153419154a702320236ba0` is not an ancestor. No main rebase/merge or other chat's work was imported.

## Reproduction and cause

Before edits, both failing tests were run separately on exact `d6ef464` and exact `11abfb4` in detached verification worktrees. All four commands failed with one failing test each. The failures were identical across the two implementations.

The historical fixture clock was `2026-10-02T23:27:31.844Z`. The partial mock changed `Date.now()` only; zero-argument `new Date()` still returned October 4 UTC. Application schedule search therefore used October 4/3/5, excluding the mocked FlightStats response for October 2. The intended replay search is October 2/1/3.

`scripts/test-clock.mjs` now freezes `Date.now()`, no-argument `new Date()` and `Date()` consistently, following each replay's original advancing timestamp. Explicit Date arguments, statics, subclasses, instanceof, timers and performance remain intact. Every installation restores the original clock in finally/test cleanup. Fixture dates and assertions are unchanged.

Every existing test file changed:

- `scripts/route-memory-replay.test.mjs`
- `scripts/takeoff-floor-replay.test.mjs`
- `scripts/route-memory-write-replay.test.mjs`
- `scripts/flight-identity-replay.test.mjs`
- `scripts/flight-resilience.test.mjs`
- `scripts/fr24-usage-reduction.test.mjs`
- `scripts/flight-audit-regression.test.mjs` — nine story/calendar clock sites; its pure motion clock remains unchanged.

The latter five files contain equivalent partial clock mocks that reach actual calendar construction. Already-complete scheduled-original/app-data clocks, pure phase/fusion/presentation mocks, fixture expiry mocks and explicit timestamp/injected-clock cases remain unchanged. Added `scripts/test-clock.test.mjs` contains two focused helper regression tests.

## Application gates

Both database URLs were unset for all normal test/build commands. Check ran before build; no clock override was applied to either command externally.

| Run | Result |
|---|---|
| Targeted changed tests | 116 tests, 24 suites; 115 passed, zero failed, one existing TODO, zero skipped/cancelled; exit 0 |
| `npm run check` | Typecheck passed; 909 tests, 88 suites; 908 passed, zero failed, one existing TODO, zero skipped/cancelled; exit 0 |
| `npm run build` | Passed, exit 0; production migrator explicitly skipped because DATABASE_URL was unset |

The unchanged TODO is held unknown-airport FlightStats public-route support in `flight-audit-regression.test.mjs`. Nothing was converted to skip or weakened. Exact diagnostic, reproduction, targeted, check and build logs, hashes and clock-scope audit are in [verification/part-3b2-1/test-clock-results.json](verification/part-3b2-1/test-clock-results.json).

## Fresh Neon branch and quota resolution

Neon explicitly rejected creation with **“Request failed: root branches limit exceeded.”** The user then authorized deletion of two exact completed disposable verification branches. Both name/ID pairs were verified in the control plane. Only `plugin-v1-3b1-5-verification-20261003` / `br-calm-star-aualangq` was deleted. The completed Part 3B.1.6 branch `br-cold-resonance-aud9ey98` was retained. Production main and the active Preview branch were neither deleted nor substituted for verification.

| Item | Verified value |
|---|---|
| Project | `inbound-db` / `withered-water-48367194` |
| Fresh branch | `plugin-v1-3b2-1-verification-20261004` |
| Branch ID | `br-fragrant-sun-auv7swsu` |
| Database | `neondb` |
| Direct endpoint | `ep-long-silence-auec2kal.c-10.us-east-1.aws.neon.tech` |
| Excluded production branch | `br-late-forest-au7csk9x` |
| Mode | Schema only; no production row data copied |
| Selected schema source | Isolated `preview/plugin-v1-3b1-5-verification` / `br-round-breeze-augnsxmu` |
| Created | October 3, 2026, 9:33:04 p.m. CDT / `2026-10-04T02:33:04Z` |
| Automatic deletion | October 4, 2026, 9:33:04 p.m. CDT / `2026-10-05T02:33:04Z` |
| Postgres | `18.6 (4e955f5)` |

The branch's authoritative ID and direct endpoint were confirmed before SQL. The harness rejected generic DATABASE_URL and pinned the dedicated URI to this metadata, explicitly excluding main. The protected connection file was removed after verification; credentials are absent from all committed evidence.

Only `0006_nearby_collection.sql` then `0007_route_hint.sql` were applied, in that order. Fresh setup had zero plugin tables; afterward the plugin schema contained exactly:

- `inbound_plugin_v1.current_collection`
- `inbound_plugin_v1.ranked_view`
- `inbound_plugin_v1.route_hint`
- `inbound_plugin_v1.route_construction_budget`

No 0004 migration or application migration was applied. Other application table catalog entries remained unchanged; no application row data was read or written. There are no additional plugin traffic-history, route-history, phase-history or per-user tables.

## Real independent-session certification

**14/14 suites passed.** One hundred separate Postgres Client connections reported 100 distinct backend PIDs before concurrency barriers; a separate control session was also used. The official Neon WebSocket transport uses actual Postgres sessions, not a local simulator. Transport provenance and the complete PID list are included in evidence.

| Gate | Result |
|---|---|
| 100 simultaneous normal viewers | Exactly **1 fake aircraft acquisition**, **1 lease winner**, 99 cold contenders, **0 fake route lookups**; warm requests caused 0 extra acquisitions |
| 100 simultaneous explicit constructors | Exactly **2 initial fake lookups / 2 publications**; no worker multiplication |
| Same callsign, 100 independent claims | Exactly **1 lease winner / 1 charged start**; cached claims charged 0 |
| Shared construction budget | Maximum **2 starts per actual collection cycle / 6 per rolling 60 seconds** |
| Exact rolling boundary | Blocked at 59,999 ms; two winners at 60,000 ms |
| Positive cache | Reused; valid hits charged 0; expires exactly; maximum TTL **1,800 seconds** |
| Negative/failure cache | Reused; valid hits charged 0; expires exactly; maximum TTL **60 seconds** |
| Failure lookup outage | Two initial fake failures, 0 immediate/before-expiry retries, two after expiry; aircraft/Featured remain usable |
| Lease/fencing | 10-second lease, crash cooldown 60 seconds; generation 1→2; expired/stale owners and duplicate publication/failure rejected |
| Collection eligibility and environment isolation | Missing/stale/failed/inactive collection rejected; exact 45-second freshness accepted; environments and cleanup remain separate |
| Concurrent cleanup/recreation | 100 independent cleanup/claim workers, exactly two winners and two charges; old owner rejected after recreation; live cycle quota preserved |
| Logical cleanup | Budget retained 1 ms before its actual expiry; deleted exactly at expiry; expired hints removed; repeated cleanup idempotent |
| Row cap | 191 positive rows + 1 pending = **192**; overflow rejected without charge; expired rows pruned |
| SQL/runtime constraints | 14 invalid hint cases and 4 invalid budget cases rejected; callsign/IATA/label/TTL enforced; positive requires endpoint, negative holds no route data; generic confirmed/raw payload/mismatched publication rejected |
| Database clock | Forged caller time cannot expire lease/cache; SQL stamps actual TTL; real budget/hint row-lock waits resample time and reject queued expiry with 0 charges |

No provider endpoint, raw provider payload, detailed occurrence binding, arbitrary confirmed route, per-user key or route archive is stored in route-hint/budget rows. Construction timestamps are a bounded six-entry quota window, not aircraft traffic history.

Successful full run hook counts: **7 fake aircraft acquisitions / 12 fake route lookups / 0 provider API calls**. These include refresh, boundary and outage scenarios; the 100-viewer/initial-100-constructor counts are the narrower 1/0/2 values above. Across both actual runs including the preserved harness-error attempt: **11 fake acquisitions / 20 fake lookups / 0 provider API calls**. Direct invented fixture publications are recorded separately and are not counted as acquisition/lookup callbacks.

Final cleanup left **0 rows in all four plugin tables**. The schema can be removed with the isolated branch's automatic deletion. Production database connections and production rows read/written remained **0**. No unexpected store SQL errors occurred.

## Radar, Featured and route verification

The integration suite cold-read 125 accepted invented observations from real SQL. Radar returns **100**, serialized at **45,900 bytes**, below the configured **49,152-byte** maximum. It makes no route-cache read or route construction call, does not wait for enrichment, and remains usable without route hints. Chicago/ORD/MDW reuse one shared acquisition collection. Accepted groundTrackDeg remains available; missing track is not invented; bounded display extrapolation still stops at **25 seconds**.

Featured remains **4 default / 5 maximum**. Generic hints contribute the existing **+5**; confirmed routes contribute the existing **+15**; airport association **+5** requires confirmed dated route evidence. Generic cache data cannot become confirmed. Seven stale/mismatched dated binding cases downgrade safely. Changed observed callsigns require new route evidence; EDV/DAL cache evidence does not transfer blindly. Normalization also keeps UA/UAL separate in the passing application tests. Same-version enrichment preserved the Featured board revision and the accepted snapshot; existing 90-second hold / 20-point challenger margin remain unchanged.

The route/private renderer allowlist excludes phaseEvidence, dated occurrence bindings, private aircraft/session identity, provider provenance/endpoints, cache keys and budget state. Only normalized display route fields cross that boundary.

## Harness accuracy correction

The first actual run passed eight suites, then a combined cleanup test expected a budget deleted 20 seconds before retention ended. Recreation was at `2030-01-15T18:02:00Z`, extending retention to `19:02:00Z`; the reused cleanup constant tested `19:01:40Z`. Returning zero deleted budgets was correct. The original PGlite cleanup and concurrent-recreation cases were separate; the combined harness copied the earlier fixture's clock.

Only the harness was corrected. It now derives the clock from the actual stored retention and checks both sides of the expiry boundary. A narrowly validated same-branch failed-checkpoint mode reused the already applied, hash-verified 0006/0007 schema, executed **zero additional migration statements**, and cleared only fully inventoried invented verify321 environments. It then reran every suite with a new set of 100 independent connections. The original failed result/log and the explanation are retained. No application or migration fix was made, and no real implementation discrepancy was observed.

## Final application gates and delivery scope

After real Neon certification, `npm run check` ran and exited 0, then `npm run build` ran and exited 0. Both DATABASE_URL and NEARBY_VERIFY_DATABASE_URL were unset for both commands.

- Check: **909 tests / 88 suites; 908 passed, 0 failed, 1 existing TODO, 0 skipped/cancelled**; typecheck passed; test duration 78,973.104946 ms.
- Build: **PASS**, with the migrator explicitly reporting DATABASE_URL not set and skipping migration.
- Existing TODO: Held #6, “loads an exact route from a FlightStats-style public status page” / unknown-airport public-route support. It was not weakened, hidden or converted to skip.

Authorized delivery contains only the seven accepted test-clock replacements, shared helper/helper tests, and private verification harness/report/evidence. Application code, route implementation, migrations, packages and fixture source are unchanged.

Production Neon main, Inbound main, nearby-acquisition, fixture MCP, inbound-live-fixture-dev and Inbound Live Radar Dev were not modified by this work. No provider credentials were requested; no live provider calls, provider contact, public real-data endpoint, real aircraft exposure, PR, merge or production deployment occurred. Part 3B.3 and Part 3B.4 were not started.

Evidence index: [verification/part-3b2-1/final-gates.json](verification/part-3b2-1/final-gates.json), [postgres-results.json](verification/part-3b2-1/postgres-results.json), [neon-branch.json](verification/part-3b2-1/neon-branch.json), [harness-accuracy-correction.json](verification/part-3b2-1/harness-accuracy-correction.json), complete before/after/final logs, and control-plane screenshots.

## Delivery blocker

After all gates passed, the accepted test-clock fixes and verification files were committed locally. Native push of only `plugin-v1-route-enrichment` failed with exit 128:

> fatal: could not read Username for 'https://github.com': terminal prompts disabled

The workspace has no configured authenticated Git transport for this repository. GitHub connector commit-creation tools cannot preserve the exact approved local commit objects and ancestry, so the approved implementation/source history was not recreated with different SHAs. No remote feature SHA is claimed. No PR, merge or deployment followed. The final local branch is preserved in a verified Git bundle with certified `d6ef464` as its prerequisite; it contains the original `11abfb4` / `cd9dbf6` ancestry and the completed certification commit. See [verification/part-3b2-1/delivery.json](verification/part-3b2-1/delivery.json).

A follow-up resume verified the clean local certification commit and retried the authorized feature-branch push once. It failed with the same exit 128 authentication error; the remote feature branch remains absent. A read-only audit also identified a stale pre-certification connection count in `status.json`. Only that metadata was corrected to **101 connections in the successful run (100 independent workers plus separate control)**, with production connections still **0**. Runtime, migrations, accepted clocks, real Postgres results and final application gate logs remain unchanged.
