# Part 3B.3: fake aircraft Radar transport proof

The new engine → public serializer → MCP → widget path is implemented on `plugin-v1-radar-transport`, directly from approved remote source `7277994ccbb921382849c5e1e30cae8388ee68bd`. Changes are new proof, transport, widget, test, build or evidence files, plus an exact-branch deployment-disable entry in root `vercel.json`. The certified Nearby/route engine and existing fixture implementation are unchanged. `df2082de76ad6f0c05153419154a702320236ba0` is excluded.

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

Final sequential gates, both database URLs unset: `npm run check` **957 tests / 92 suites / 956 passed / 0 failed / 1 existing TODO** (exit 0), followed by `npm run build` **PASS** (exit 0). The production migrator explicitly skipped because DATABASE_URL was unset. The existing TODO is Held #6, unknown-airport FlightStats-style public route support. All **48 new tests** pass.

Source and compiled Playwright proofs each pass **17 assertion groups** with zero external requests and zero console/page errors. They exercise 40 initial symbol-center pointer selections, 39 refreshed mobile selections at 375 px, immutable anchors, visible RAF movement, bounded stop, new authoritative fixes, retained expiry, all areas, health/route display, declutter, selection, host capability handling and teardown. The host messages are explicitly simulated. Actual ChatGPT and actual PiP are **not verified**.

An initial full-check run had four child-process failures with no assertion detail. The unchanged four files passed a detailed focused TAP rerun (7/7). The shared workspace reached its 8 GiB memory limit while another project was also testing; memory pressure is plausible, but the original spec log cannot prove the processes' exit signals. The final check uses a three-CPU affinity to reduce Node's default test workers, without changing tests, assertions or application code. The browser harness also now waits for explicit simulated display-request replies, removing a mock-host timing race without relaxing assertions.

Evidence includes `build-audit.json`, `sample-response-summary.json`, source/compiled browser JSON, desktop/mobile screenshots, and the sanitized application/deployment summaries. The complete changed-file inventory is recorded in `changed-files.json`.

## Preview and manual approval

The new isolated Preview is **READY**, deployment `dpl_3QCUsdCSpiqfk3DvppKqkdbQ42Rz`, hostname `inbound-live-fixture-rf27hpb80-jarndtphoto.vercel.app`, MCP URL `https://inbound-live-fixture-rf27hpb80-jarndtphoto.vercel.app/mcp`. Delivery branch `part-3b3-radar-proof-20261004` points to `b3151e0b019fceaee336b044f362e13204b0c0fe`, with exact audited three-file tree `0c968066097514d6047a4ed95fc016c79be0fb39`. It has zero configured environment variables. Standard Protection is enabled; old fixture refs, the approved qfln deployment, and existing aliases remain unchanged.

The owner-assisted widget inspection returned HTTP 200 with 40 invented Radar targets, four Featured cards, collection version 1 and a CSP header. **Unauthenticated public MCP initialization returns HTTP 401**, so full public JSON-RPC certification is pending. No exact-host protection exception has been added. Automatic approval review rejected the subsequent protected `/mcp` fetch because its temporary authentication-bypass link is a security-control change not explicitly authorized by inspection. It was not retried or worked around. The browser-control tool also requires approval before falling back from an insufficient connector; the available Vercel connector has no exact-host exception operation. The remaining action is therefore explicit browser fallback for an exception only on this immutable hostname, then direct public MCP inspection.

Use the separate **Inbound Live Radar Transport Preview** connection described in [manual-chatgpt-setup.md](../../radar-proof/manual-chatgpt-setup.md). The exact checklist covers inline/expanded views, many aircraft, selection, readable labels, area switching, route verification, smooth motion/new fixes, stale/expired stop, mobile layout, keyboard behavior and accurate PiP capability reporting.

Do not replace the existing Inbound Live Radar Dev connection. Direct public MCP inspection and the exact-host protection exception must pass before that new connection is ready. No real host approval is claimed. No PR, merge or production deployment is performed. Part 3B.4 remains unstarted.
