# Part 3B.4 — exact flight handoff

Part 3B.4 is complete and stopped. Nothing after Part 3B.4 was started.

## Source and deployment identity

- Repository: `jarndtphoto/Inbound`
- Branch: `plugin-v1-flight-handoff`
- Exact base: `fc16849f9eed685fd63dda1f8a8fa4ec9db50a57`
- Core remote commit: `77ccd7c08e90e619531a17d5b9e10c59e77afe95`
- Deployed Inbound source commit: `4eec3ecef91ee5cfe15d34a3278c78a06508ccde`
- Deployed Inbound tree: `1a6900ce996c7bae964d608e5aecd3c3c6c80366`
- Fixture repository/branch: `jarndtphoto/inbound-live-fixture-dev` / `part-3b4-flight-handoff-20261005`
- Fixture commit: `dd76a0ac6b517e9e465b569683659a52e0605fdd`
- Fixture tree: `366ce7d4850a4993560e4690518540c87f3d6bd5`
- Deployment ID: `dpl_GxXjUvWECRnRsyV8YRLgWEk8eTLS`
- Preview hostname: `inbound-live-fixture-pdqumlqfx-jarndtphoto.vercel.app`
- MCP URL: `https://inbound-live-fixture-pdqumlqfx-jarndtphoto.vercel.app/mcp`

Vercel deployment metadata identifies the fixture branch and commit above. That fixture commit contains exactly `api/mcp.js`, `package.json`, and `vercel.json`; those blobs came from the audited Inbound tree. The generated build audit records the compiled server SHA-256 as `ff420f30b7c411d80e7db87dce550f759b7b3378833e7fde3cd073fe3b59d773` and the widget SHA-256 as `e66b3647bddc40a3c1099d418d470bbb8ad40c30758e5bd84f9fb8a8e05ebd7a`.

## Implemented surface

The MCP surface contains exactly three read-only tools:

1. `get_nearby_flights`
2. `resolve_nearby_flight`
3. `get_flight`

Radar and Featured rows carry opaque 43-character selection handles. Callsigns cannot resolve a Nearby selection. SYN101 resolves directly to one dated occurrence. SYN105 returns two opaque dated candidates and never chooses automatically. Exact instance and candidate reads return the same strict `InboundFlightV1` envelope.

The failure surface covers expired/invalid tokens, unconfirmed identity, identity change, unsupported aircraft/query, missing date, route unavailable, backend unavailable, and not found. No mutation tool exists.

## Persistence and concurrency

Incremental migration `0008_flight_handoff.sql` follows only 0006 and 0007. It adds four current-state tables:

- `occurrence_registry`
- `selection_handle`
- `candidate_choice`
- `detail_snapshot`

Public token values are never stored; only SHA-256 hashes are stored. Selection/candidate lifetime is bounded to 90 seconds and cannot exceed 120 seconds after the observation. Occurrence/detail retention is capped at 14 days. Resolution and detail work use leases, fencing generations, backoff, cleanup, and a maximum of three attempts.

PGlite applied 0006→0007→0008 and found exactly eight plugin tables. Application/store tests proved one resolver under 100 contenders and one detail builder under 100 contenders. A fresh schema-only Neon branch independently proved exactly one selection-lease winner across 29 simultaneous real PostgreSQL backends, stale-writer fencing, and zero claims after attempt three. The production Neon branch was untouched.

## Test and build totals

- Focused Part 3B.4/plugin tests: 145 total, 145 passed, 0 failed.
- Full `npm run check`: 967 tests, 966 passed, 0 failed, 1 pre-existing held/todo test.
- `npm run build` with `DATABASE_URL` and `NEARBY_VERIFY_DATABASE_URL` unset: passed; migration correctly skipped.
- Generated fixture: 3 files; server 398,866 bytes; widget 175,305 bytes.
- Build isolation: provider calls 0; production API calls 0; production DB access 0.

## Deployment protection

One exception was added for exactly:

`inbound-live-fixture-pdqumlqfx-jarndtphoto.vercel.app`

The final Vercel settings audit shows Require Log In still checked and Standard Protection still selected. No wildcard, project-wide bypass, production-domain exception, or other hostname change was made. Existing exceptions and old previews were left untouched.

## Public verification

Public MCP verification made 31 requests across 13 assertion groups with 0 failures. It passed:

- initialize with protocol `2025-11-25`
- exact three-tool listing and read-only annotations
- resource listing and self-contained widget retrieval
- Chicago, ORD, and MDW Nearby responses
- the public fixture's 40→39 retirement sequence
- Radar ≤100, Featured ≤5, and full Nearby payload ≤64 KiB
- SYN101 direct resolution and exact-instance reread
- SYN105 two-choice ambiguity and explicit choice detail
- unconfirmed, identity-changed, unsupported, backend-unavailable, missing-date, unsupported-query, invalid-token, and expired-token behavior
- callsign-only resolve rejection
- mutation/unknown-method rejection
- hostile-origin rejection and `https://chatgpt.com` acceptance
- `X-Inbound-Fixture-Only: true`, `Cache-Control: no-store`, and `X-Inbound-Egress: static-isolation`

Totals: provider calls 0; production API calls 0; production DB access 0.

## Public browser proof

The public widget was exercised for 96.432 seconds without pressing manual Refresh. It covered Chicago→ORD→MDW, selection immediately after MDW, multiple selections, Radar→Flights→Radar, direct SYN101 detail, SYN105 ambiguity/choice/detail, and Back to Radar.

At T+51.849 the accepted anchors truthfully reached their 25-second bound and the widget reported that bounded motion had stopped. Without user action, the automatic watchdog accepted the next trajectory by T+64.202 and visible marker positions continued changing through T+96.409. Manual Refresh was not required. Browser errors: 0.

## ChatGPT host retest

1. In ChatGPT, open **Settings → Apps & Connectors → Advanced settings** and enable **Developer mode**.
2. Choose **Create app** (or **Create connector** in older UI).
3. Name it `Inbound Live Part 3B.4`.
4. Set the MCP server URL to `https://inbound-live-fixture-pdqumlqfx-jarndtphoto.vercel.app/mcp`.
5. Select **No authentication**, save, and connect.
6. Start a new chat and select `Inbound Live Part 3B.4` from the tools/apps menu.
7. Ask: `Open the invented Inbound Live Radar near Chicago.`
8. Confirm aircraft move; select several aircraft without pressing Refresh.
9. Select SYN101, choose **Track flight**, confirm one exact detail, then choose **Back to Radar**.
10. Select SYN105, choose **Track flight**, confirm two dated choices, choose one, confirm detail, then return.
11. Switch Chicago→ORD, then ORD→MDW around 30 seconds; immediately select an aircraft.
12. Switch Radar→Flights→Radar and make more selections.
13. Wait through 20, 40, 60, and 90 seconds. Do not use manual Refresh. Confirm any bounded stop recovers automatically during healthy fixture operation and there is no persistent collective freeze.
14. Use Pause only as the safety control: moving targets must stop at the unchanged 25-second extrapolation bound rather than drift indefinitely.

Stop after this host test and report the result. Do not start work after Part 3B.4.
