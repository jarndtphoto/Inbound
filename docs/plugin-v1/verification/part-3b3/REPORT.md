# Part 3B.3: fake aircraft Radar transport proof

The new engine → public serializer → MCP → widget path is implemented on `plugin-v1-radar-transport`. This host-lifecycle repair is based exactly on published remote baseline `b35959a924ea7ec2b4f18b26740b339a66608aea` (tree `d112b544f58befae651d4d5dc857482d67be27f2`). The certified Nearby/route engine and existing fixture implementation are unchanged. `df2082de76ad6f0c05153419154a702320236ba0` remains excluded.

This is an invented-data proof. It does not activate a live aircraft or route source, certify a real ChatGPT host session, or start Part 3B.4. The published feature branch/commit identifies the complete source checkpoint; publication through GitHub Git Data can give an equivalent commit a different SHA while preserving its exact tree and approved parent.

## Public transport and behavior

| Requirement | Result |
| --- | --- |
| Response | Strict `InboundNearbyResponse`: area, collectionVersion, health, generatedAt, radarTargets, featuredFlights, optional status/warning |
| Radar fields | Opaque public radarId, displayIdent, latitude/longitude, observedAt, altitude, groundspeed, ground track, vertical rate, positionKind, motion, freshness, Featured flag, optional typeCode |
| Featured fields | Public card/radar IDs, display ident, route endpoints/verification/checkedAt, distance/bearing, altitude, motion/freshness, optional airline label |
| Private fields | Explicitly excluded: provider IDs/endpoints/payload, registration, private aircraft/session identity, phaseEvidence, route cache/budget, database/occurrence IDs and selection handoff tokens |
| Byte bounds | Final public DTO and outer MCP tool response: 65,536 UTF-8 JSON bytes maximum. Radar array also remains within the existing 49,152-byte bound |
| Measured initial proof | 40 Radar targets / 4 Featured; DTO 19,540 bytes, Radar array 17,498 bytes at the recorded fake epoch |
| Capacity | 125 invented accepted observations exercise the independent 100 Radar / 4 default / 5 maximum Featured bounds |
| Motion | Reuses unchanged `deriveNearbyDisplayPosition`; immutable accepted anchors, accepted track/speed, maximum 25 seconds, stale stop, no invented missing-track direction, authoritative altitude |
| Refresh | Authoritative deterministic fake fixes every 20 seconds; continuous local RAF movement between responses; no one-second MCP loop |
| Direction | Directional aircraft symbol rotates to ground track; neutral missing-track symbol. Text says Track |
| Labels | Deterministic selected-first collision policy, then Featured/other targets; maximum 8 desktop / 5 mobile labels; remaining aircraft symbols only |
| Selection | Synchronized Flights/Radar/refresh state; retained stale/expired selected panel; no automatic replacement. Pointer selects nearest symbol center in overlapping hit areas; keyboard preserves the focused target |
| Cached routes | Exact display-ident affinity prevents EDV/DAL or UA/UAL changes from inheriting retained route evidence; hints remain hints |
| Health | ok usable; partial coverage note; stale positions stop; unavailable explains missing current coverage rather than empty sky |
| Routes | Invented ORD → BOS and MDW → DEN dated confirmed evidence, explicit fake generic hint, and unknown route. Existing route guard downgrades stale/mismatched evidence |
| Areas | Chicago / ORD / MDW reuse one accepted Chicago collection version; geometry, crop, distances and ranking change by view |
| MCP | Exactly `get_nearby_flights`; strict three-area input, optional radius 12/25/38 and Featured limit 1–5. One resource: `ui://inbound/radar-v1.html` |
| Host state | Inline defaults Flights; expanded defaults Radar; widgetState/sessionStorage fallback; fullscreen/PiP host capability gated. PiP remains unverified; Track flight disabled |

## Fake acquisition, requests and isolation

The default proof initializes 40 invented aircraft, with one older observation retiring on the next acquisition, leaving 39. Airport-area traffic and wider 9/13/17 nm overflight rings exercise dense layouts and visibly distinct symbols. Routes and phase samples are invented; classification, ranking, freshness, stability, route construction and motion remain the certified private engine's responsibility.

100 cold viewer requests in one injected proof instance produce **one fake aircraft acquisition and zero fake route lookups**. Explicit construction is tested separately against the existing two-start cycle and six-start rolling-minute rules. The host proof performs **two explicit fake route lookups during initialization** to populate hint/negative examples; viewer requests never initiate them. These counts are distinct from live-provider calls.

The proof uses bounded injected memory adapters to exercise the existing engine. Sharing here is within one process/proof instance. It is not a replacement for the previously certified multi-session Postgres storage or a claim that separate serverless instances share memory; cold starts may reset the invented timeline. No SQL connection is opened in this stage.

| Safety item | Result |
| --- | --- |
| Aviation-provider API calls | 0 |
| Production Inbound API calls | 0 |
| Production database reads/writes | 0 |
| Real aircraft exposed | 0 |
| Credentials | No provider/production database credentials requested or shipped |
| Deployed files | Exactly `api/mcp.js`, `package.json`, `vercel.json` |
| Isolation | Strict module/file allowlists, rejecting unused production constructors, no server outbound runtime, no external browser assets, only literal same-origin `/mcp` fallback |
| Preview guard | Requires isolated Vercel Preview host; refuses database/provider configuration and expires after 2026-10-11T23:59:59Z |
| Existing source | Certified `nearby-v1`, phase logic, ranking/stability, migrations and old fixture source/build/deployment files unchanged |
| Existing external state | No writes to Inbound main, nearby-acquisition or route-enrichment; no existing personal connection or old fixture ref/deployment replacement |

Root `vercel.json` preserves the existing foundation rule and disables Git deployment only for `plugin-v1-radar-transport`. Read-only control-plane inspection showed that the application project's Preview environment includes database configuration; publishing this feature branch must therefore not trigger its application build/migrator. This branch-scoped source guard changes no project setting, production branch or existing preview. The isolated proof delivery uses its own separate three-file configuration and credential-free project. Vercel documents the branch guard in its [Git configuration](https://vercel.com/docs/project-configuration/git-configuration).

## Verification

The reproduced host bug was a state-feedback regression, not a stopped RAF. Selection or area change persisted widget state; ChatGPT echoed `openai:set_globals` with that new state and the retained launch `toolOutput`; the old widget accepted that retained result unconditionally and wrote state again. The older accepted anchors then reached the certified 25-second bound, so every directional display position stopped even while RAF frames and polling continued.

The repaired widget treats selection as pure UI state, rejects retained/stale results by authoritative `generatedAt` ordering, owns polling independently from animation, and idempotently restores one RAF/poll/aging lifecycle after area, globals, visibility, page, display, initialization and remount events. Requests are generation-owned; timer epochs cancel only pre-fire work. Teardown cancels an actively armed lifecycle and late initialization cannot revive it.

Final sequential gates, with all database URL variants unset: `npm run check` **957 tests / 92 suites / 956 passed / 0 failed / 1 existing TODO** (exit 0), followed by `npm run build` **PASS** (exit 0). The production migrator explicitly skipped because `DATABASE_URL` was unset. Focused plugin tests pass **135/135**.

Source and compiled Playwright proofs each pass **19 assertion groups** and **22 lifecycle snapshots**, with zero external requests, zero console/page errors and maximum pending RAF, poll and aging counts of one. They cover the real host echo shape, selection persistence, Chicago/ORD/MDW changes while responses are held, T+20 authoritative fixes, the 25-second stop, new-fix motion resumption, stale replay, cold-isolate ordering, out-of-order request completion, deadline races, fullscreen/context changes, visibility, page suspension/resumption, remount and active teardown. The host messages are explicitly simulated. Actual ChatGPT and actual PiP remain **not verified** until the new public preview is host-tested.

Evidence includes `build-audit.json`, `sample-response-summary.json`, source/compiled browser JSON, desktop/mobile screenshots, and the sanitized application/deployment summaries. The complete changed-file inventory is recorded in `changed-files.json`.

## Preview and manual approval

The original isolated Preview remains deployment `dpl_3QCUsdCSpiqfk3DvppKqkdbQ42Rz`, hostname `inbound-live-fixture-rf27hpb80-jarndtphoto.vercel.app`, on delivery branch `part-3b3-radar-proof-20261004` at `b3151e0b019fceaee336b044f362e13204b0c0fe`. It is historical evidence and must not be replaced, promoted, aliased or modified.

The lifecycle repair is published as source commit `3bd726164b841d0b93b1df54b415268833d6408e` (tree `b6f74cf0f7d2b5f130c19dc78a3074852915a509`), directly parented to the required baseline. The new isolated fixture branch `part-3b3-radar-lifecycle-fix-20261004` points to `4edaa105a7340cd77ee47b9f0cf861134a7e1c53` with exact three-file tree `2630eafe287e40cb1fd9682ae51f3407cad9dd23`.

The new Preview is **READY** at deployment `dpl_3uW6ZF44aY6k8Nrb8RFn57ks4P5D`, hostname `inbound-live-fixture-d6eedvyfd-jarndtphoto.vercel.app`, MCP URL `https://inbound-live-fixture-d6eedvyfd-jarndtphoto.vercel.app/mcp`. It has zero configured environment variables. A Deployment Protection Exception was added only for that exact hostname. The same settings screen and API state confirm **Require Log In remains enabled**, mode **Standard Protection**, with `ssoProtection.enabled=true` and `deploymentType=all_except_custom_domains`. No wildcard, project-wide bypass, production-domain exception or other hostname exception was added.

Unauthenticated public MCP verification passes **25/25 request outcomes and 297/297 assertions**: 11 positive requests, 14 expected rejections, 21 MCP POSTs (20 HTTP 200 JSON plus one HTTP 202 notification), and 24/24 proof-handler responses with `no-store`, `x-inbound-fixture-only: true` and `x-inbound-egress: static-isolation`. Initialize, tool/resource listing, resource/widget retrieval, Nearby responses, 40→39 `SYN140` retirement, Radar ≤100, Featured ≤5, mutation rejection, absent production API, closed inputs/origins and the fixture-only isolation boundary all pass. Provider calls, production API calls and production DB access remain zero.

Control-plane reinspection confirms Inbound `main` remains `71515b65a5624822d33c1ba1869627c2cc521dc2`; the old Part 3B.3 `rf27…` deployment remains READY at its original commit; and the Part 3A.6 `qfln…` deployment remains READY at its original commit. No production deployment changed.

Use the separate **Inbound Live Radar Transport Preview** connection described in [manual-chatgpt-setup.md](../../radar-proof/manual-chatgpt-setup.md). The exact checklist covers inline/expanded views, many aircraft, selection, readable labels, area switching, route verification, smooth motion/new fixes, stale/expired stop, mobile layout, keyboard behavior and accurate PiP capability reporting.

Do not replace the existing Inbound Live Radar Dev connection. No PR, merge or production deployment is performed. Part 3B.4 remains unstarted.
