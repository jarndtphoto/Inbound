# Part 3B.1.5 — Isolated Postgres verification and provider access plan

Date: October 3, 2026. Scope: **Part 3B.1.5 only**.

The real Postgres coordination gate **passed**. The production-provider access
plan is ready for review, but production permission/access is **not yet cleared**.
No provider was contacted. Approval of this report does not constitute a provider
grant or authorize real ChatGPT data activation.

The tested application source was approved commit
`d49d5ee0be3f63fe5bdd56e4d1badd8a5b693498` in `jarndtphoto/Inbound`, branch
`plugin-v1-nearby-acquisition`. A separate detached checkout preserved the existing
local main merge. During this work the remote source branch advanced through
`c3b843901f37836bc2d84d54662375934a933c14` to
`d6ef464a4d5c80fe70aa8191e3d1d664e759ac5b`, which changes the store/model/ranking and
renames the migration to `0006_nearby_collection.sql`. Those changes were not part
of the user's approved source for this stage and were not applied to the test
database. The report/harness commit therefore lives on a separate review branch,
`plugin-v1-3b1-5-verification`, based on **d49d5ee**. The source branch's newer work
is preserved without alteration. These results certify **d49d5ee**, not d6ef464;
any later source chosen for activation must receive its own coordination check.
No implementation from Part 3B.2 was added.

## Isolated Neon target and migration

| Item | Observed result |
| --- | --- |
| Project | `inbound-db` / `withered-water-48367194` |
| Development branch | `plugin-v1-3b1-5-verification-20261003` |
| Branch ID | `br-calm-star-aualangq` |
| Creation mode | Neon **Branch schema only**; no parent data copied |
| Database | `neondb` |
| PostgreSQL version reported by SQL | `18.6 (4e955f5)` |
| Dedicated endpoint | `ep-young-violet-au5o7j7r.c-10.us-east-1.aws.neon.tech` |
| Created | October 3, 2026, 23:33:54 UTC / 18:33:54 CDT |
| Automatic deletion | October 4, 2026, 23:33:54 UTC / 18:33:54 CDT |
| Production branch excluded | `main` / `br-late-forest-au7csk9x` |

The authenticated console showed schema-only selected before creation and the
successful new branch afterward. Its connection dialog supplied the branch's
direct endpoint with connection pooling disabled. The harness required this
endpoint and database to match the separately captured control-plane metadata;
it rejected the production branch ID/name and never used generic `DATABASE_URL`.
Credentials were kept outside the repository and are absent from these artifacts.

Applied **only** `docs/plugin-v1/migrations/0001_nearby_collection.sql`, inside an
explicit transaction on the isolated branch. SHA-256:
`45ca4563371c8e1effd6fa4cebc06620af157186d6c5ffab2dca6be9c99cbea7`.

Exactly these two plugin tables were present after application:

- `inbound_plugin_v1.current_collection`
- `inbound_plugin_v1.ranked_view`

No automatic root migrations ran. The staged `0004_plugin_v1_ephemeral.sql` was
not applied. All other table catalog entries matched before/after. No
`flight_phase_state`, arrival state or existing production table was modified.
Only catalog metadata was inspected outside the plugin schema; table contents
outside the plugin schema were never queried. Main's control-plane identity was
viewed to identify the excluded branch, but no SQL connection to main was made.

## Multiple independent connections — actual results

The workspace's raw TCP connection failed at hostname resolution (`EAI_AGAIN`).
Neon's supported HTTPS SQL transport and official WebSocket `Client` succeeded.
The harness therefore used `@neondatabase/serverless` **1.2.0**, with Node's
built-in WebSocket, through the existing environment's normal network path.
This was real Postgres, not PGlite, an in-memory store, a SQL mock or a pooled
single session.

**100 simultaneously live independent client sessions** had **100 distinct
`pg_backend_pid()` values**, plus a separate control connection. The JSON evidence
records every PID. Session establishment was batched; all sessions remained open
before the 100 service requests were launched together. The acquisition barrier
held the winner until all 99 cold contenders returned, proving cross-connection
coordination rather than merely relying on fast publication.

| Check | Actual result |
| --- | --- |
| 100 concurrent Chicago requests | Passed; **exactly 1 fake acquisition**, **1 lease winner**, 99 cold losers completed before acquisition release |
| Aviation provider calls | **0**, throughout the harness |
| Bounded acquisition/display | 125 invented accepted observations; Radar capped at **100**, **47,413 UTF-8 bytes**; 4 featured flights |
| Shared collection rows | Exactly 1 current row per verification environment/Chicago key |
| Successful version increment | Cold publication reached version **1**; duplicate/stale publication did not increment it again |
| Lease/fencing | Replacement generation advanced **1 → 2**; crash/expiry could not shorten minimum acquisition cadence |
| Stale writers | Expired publication, superseded publication, stale failure and duplicate publication all rejected |
| Cleanup/recreation ownership | Old owner UUID rejected after deleting and recreating the row with a fresh owner UUID |
| Ranked-view CAS | 20 simultaneous independent readers; initial revision **1**, next collection revision **2**; stale version and unpublished future version rejected |
| Outage ranked views | Existing slots preserved; a cold view could seed from the accepted last-safe snapshot |
| Failure backoff | 100 claimants per failure, one winner per retry; delays **20 / 40 / 80 / 120 / 120 seconds** |
| Last-safe | Snapshot/metadata retained across failure; usable at 120 seconds, hidden after 120 seconds; failures did not increment version |
| Recovery | Successful recovery reached version **2** and reset backoff to 20 seconds |
| Active/inactive | Active tick acquired; inactive tick did not; a user request renewed activity and acquired when due |
| Bounded preset views | At most **9** persisted views: three allowed areas × three allowed radii |
| Logical expiry | Expired collection/view hidden before physical deletion |
| Concurrent cleanup | 100 cleanup callers; exactly **1** collection row deleted; all nine views cascaded away; repeated cleanup deleted 0 |
| Database clock | Forged future caller time could not expire leases/collections; real-clock publication reached version 1 |
| Payload/database bounds | Over-cap publication, unaccepted position, per-viewer collection key and oversized array rejected; invalid writes did not increment version |
| Final state | **0 current_collection rows; 0 ranked_view rows**; only the two plugin tables retained for review |

All seven scenario groups passed, along with migration validation. The successful
run started `2026-10-03T23:39:35.067Z` and finished
`2026-10-03T23:41:20.006Z`. The store executed 1,974 queries. There was one earlier
pre-connection harness validation failure because its label matcher recognized
`verify` but not `verification`; the matcher was corrected before the successful
run. No migration or acquisition ran in that rejected attempt.

Time-boundary scenarios used the store's existing injected clock to test the
exact boundaries without continuous polling; all statements still ran against
the real database over independent connections. A separate real database-clock
scenario verified the production clock mode. The raw JSON's legacy `owner ABA`
label denotes rejection of the old owner after recreation with a different UUID;
it does not claim that reusing the same owner UUID was tested.

The allowed fixed key, primary keys, replace-in-place snapshot and bounded preset
view keys were verified. There are no per-user collection rows, historical
traffic tables, append-only aircraft records or application traffic archive. All
aircraft values were invented fixtures. Removing the disposable isolated branch
removes the migration and its test state without any rollback against main. The
branch is already configured to auto-delete after one day.

## Provider findings and configuration recommendation

The [provider review](Part_3B1_5_Provider_Review.md) contains the complete nine-field
comparison for each provider, current official sources, endpoint findings,
unresolved questions and **three full unsent email drafts**.

- **adsb.fi:** published open-data terms do not clear commercial use; obtain a
  separate grant. Its geographic v2 endpoint is deprecated in favor of v3.
- **ADSB.lol:** explicit ODbL public-data rights conditionally include commercial
  use. Production contact, a numeric access budget and normalized snapshot/notice
  obligations remain unresolved.
- **Airplanes.live:** current rendered documentation confirms the v2 point path.
  Current aircraft-data licensing, attribution, production-access terms and
  numeric quota could not be verified from substantive official terms.

Recommend **one approved primary**, with ADSB.lol the first permission candidate,
and **one separately approved standby backup only if needed**. Do not activate a
provider until its terms cover normalized public ChatGPT display, eventual
monetization, attribution, redistribution, API budget and pricing. Do not default
to three simultaneous feeds. FlightAware remains excluded; no new paid provider
or subscription was introduced. The plan establishes the next permission steps;
it does not claim that anyone has granted them.

## Evidence and reproduction

- [Successful real Postgres results](verification/part-3b1-5/postgres-results.json)
- [Control-plane metadata](verification/part-3b1-5/neon-target.json)
- [Schema-only setup screenshot](verification/part-3b1-5/schema-only-setup.jpg)
- [Isolated branch screenshot](verification/part-3b1-5/branch-proof.jpg)
- Harness: `scripts/nearby-v1-postgres-verify.mjs`

The harness defaults to the repository's `pg.Client`. When raw TCP is unavailable,
install the official driver in a temporary directory (outside repository
dependencies), pinning the version used here:

```sh
npm install --prefix /path/to/temp-runtime --ignore-scripts --no-audit --no-fund --package-lock=false @neondatabase/serverless@1.2.0
```

Create a temporary driver module exporting `Client`:

```js
import { Client, neonConfig } from "/path/to/temp-runtime/node_modules/@neondatabase/serverless/index.mjs";
neonConfig.webSocketConstructor = WebSocket;
export { Client };
```

On a newly inspected isolated schema-only Neon development branch, supply its
dedicated credential as `NEARBY_VERIFY_DATABASE_URL`, never generic
`DATABASE_URL`. Then run:

```sh
node --experimental-strip-types --import ./scripts/test-imports.mjs \
  scripts/nearby-v1-postgres-verify.mjs \
  --metadata /path/to/verified-isolated-target.json \
  --output /path/to/postgres-results.json \
  --driver-module /path/to/temp-driver.mjs
```

Do not reuse the recorded branch after it auto-deletes. Metadata must be newly
verified in the control plane and include its exact branch/database/endpoint,
the excluded production branch ID and explicit schema-only isolation proof.

## Changes and stop boundary

Changes are the verification harness, this report, the provider review/drafts and
non-secret evidence. The approved private Nearby implementation, provider code,
minimal migration and fixture files were unchanged. Harness syntax and whitespace
checks passed; an independent read-only review found no required SQL/test fix.

Confirmed for this work:

- Production Neon main untouched; no production Inbound row contents read or written.
- Fixture MCP, `Inbound Live Radar Dev` and `inbound-live-fixture-dev` untouched.
- No public real-data endpoint, private-engine exposure or real aircraft sent to ChatGPT.
- No production deployment or continuous real-provider polling.
- No provider outreach sent; drafts exist only in the review document.
- No route enrichment, Track flight implementation or Part 3B.2 started.

**Stopped for approval of Part 3B.1.5 and the provider access plan.** Production
provider access remains a prerequisite to later real-data activation.
