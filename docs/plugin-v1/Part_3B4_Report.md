# Part 3B.4 — host tool-result replay fix

2026-10-05 follow-up: the user reported SYN101 froze immediately. A delayed
resource launch reproduces an immediate bounded-motion stop in the deployed
artifact. The startup refresh correction and its evidence are described in
`Part_3B4_SYN101_Startup_Report.md`. Actual ChatGPT host approval remains pending.

Part 3B.4 is fixed, deployed to a new isolated Preview, publicly verified, and stopped for a manual ChatGPT host retest. Nothing after Part 3B.4 was started.

## Proven cause

The old widget treated any schema-valid `FlightResultV1` as current navigation intent. Both generic host paths called `applyHandoff()` without request correlation:

- `openai:set_globals` → `globals.toolOutput` → `applyHandoff()`
- `ui/notifications/tool-result` → `message.params` → `applyHandoff()`

The pre-fix browser capture proved the exact failure. A retained SYN101 result changed Radar from `nearby` to `detail` without Track flight. Back to Radar changed the local mode to `nearby`, but replaying the same result through the generic notification changed it back to `detail`. RAF and Radar polling were not the cause.

## Correlation design and behavior

Every explicit handoff now creates one local `activeHandoffRequest` with a monotonic request ID, request type (`resolve`, `choice`, or `instance`), expected Radar ID, a non-exposed fingerprint of the selection/candidate/instance credential, and `startedAt`.

Only the direct awaited response from that exact request may navigate. Acceptance requires the same request generation, request type, selected Radar ID, and private credential fingerprint. Applying a response consumes the request. Selection changes, Back to Radar, and superseding handoffs cancel the old request.

Generic `openai:set_globals` and `ui/notifications/tool-result` payloads may still feed Nearby results through the existing monotonic board rules, but a replayed `FlightResultV1` never changes selection, handoff mode, handoff result, or the current view. Late request A cannot override newer request B. Back to Radar preserves the accepted board, area, selection, tab, RAF, poll timer, age timer, and motion-watchdog state.

Explicit behavior remains intact:

- Selecting SYN101 stays on Radar; Track flight opens its exact detail once.
- Back remains on Radar despite duplicate SYN101 globals and notification replays.
- A later Track flight creates a new request and may open detail again.
- Selecting SYN105 stays on Radar; Track flight opens its two-choice ambiguity UI.
- Only the correlated candidate response opens detail; old ambiguity/candidate results cannot reopen it.

## Browser and regression proof

The replay proof passed from both source and compiled artifact: 5 assertion groups each, 0 failures, and 0 browser errors. It covered stale SYN101 on initialization, duplicate replay after detail, duplicate replay after Back, stale SYN105 ambiguity, stale candidate detail, and request-A/request-B out-of-order completion.

The source and compiled host-like lifecycle proofs each passed 20 assertion groups over 90.5 simulated seconds with 40 invented aircraft, 0 external requests, and 0 browser errors. They covered Chicago→ORD→MDW, selection immediately after MDW, multiple selections, Radar→Flights→Radar, explicit handoff flows, and automatic T+90 motion recovery.

Part 3B.3 remained intact: 25-second extrapolation bound, at most 3 short retries per authoritative trajectory, at most 1 RAF, 1 poll timer, and 1 age timer. Fresh trajectories clear retry state; a genuine non-advancing backend exhausts the bounded budget and leaves aircraft safely stopped.

## Test and build totals

- Focused plugin tests: 145/145 passed.
- Full `npm run check`: 967 tests across 92 suites; 966 passed, 0 failed, 1 pre-existing held/todo.
- `npm run build` with database URL variants unset: passed; migration skipped because `DATABASE_URL` was unset.
- Isolated artifact: exactly 3 files; server 399,972 bytes; widget bundle 176,411 bytes.
- Provider calls: 0. Production API calls: 0. Production DB access: 0.

## Source and deployment identity

- Inbound source SHA: `05a48b619568f1a3953f9f68a008141c2dc48ee8`
- Inbound tree SHA: `190c40ad5e33a3dd397e59676fa316a49c266cf9`
- Fixture commit: `43e1f4ea0296ecd32d0cee38b21e3888e00d1804`
- Fixture tree: `488c9a841f2262b188a3a752445814f70ef319ab`
- Deployment ID: `dpl_8bevb2jMsXrfG5iuQdjgYPKSEwQG`
- Preview hostname: `inbound-live-fixture-evm5eupb3-jarndtphoto.vercel.app`
- MCP URL: `https://inbound-live-fixture-evm5eupb3-jarndtphoto.vercel.app/mcp`

Vercel reports the deployment READY from the fixture commit above. The fixture tree contains only `api/mcp.js`, `package.json`, and `vercel.json`. The compiled server SHA-256 is `d7277990585da323cb5e46993eacf21ff7ca9b9d02dc7f069baa3484e15a4de0`. Public resource retrieval confirmed the deployed widget contains the active-request, ignored-replay, ignored-response, applied-response, canceled-request, `openai:set_globals`, and generic tool-result code paths.

## Deployment protection

One exception was added for exactly:

`inbound-live-fixture-evm5eupb3-jarndtphoto.vercel.app`

The final settings audit shows Require Log In checked and Standard Protection selected globally. No wildcard, project-wide bypass, production-domain exception, or other hostname change was made. `pdqumlqfx`, `i51j9i7mu`, `mwgaf6eqv`, `d6eed`, and `rf27` remain untouched.

## Public MCP verification

The final run passed 31 requests across 13 assertion groups with 0 failures. It verified initialize, the exact three read-only tools, resource/widget retrieval, Chicago/ORD/MDW, SYN101 direct handoff, SYN105 two-choice ambiguity, exact candidate and instance retrieval, bounded Radar/Featured lists, closed inputs/origins, no mutation or production-like tools, expired/invalid token rejection, and fixture-only/no-store/static-isolation headers.

The first preliminary cold-window attempt reached the intentionally stale 40-aircraft board before its scheduled T+20 retirement and stopped on the verifier's narrow three-second warm-up assertion. Inspection proved this was the designed 40→39 lifecycle rather than a deployment failure. The complete clean run then passed and observed the 39-aircraft post-retirement board before and after another authoritative T+20 refresh.

Provider calls: 0. Production API calls: 0. Production DB access: 0.

## Exact ChatGPT host retest

1. Open **Settings → Apps & Connectors → Advanced settings** and enable **Developer mode**.
2. Create a brand-new app/connector; do not reuse the old cached connection.
3. Name it `Inbound Live Part 3B.4 Replay Fix`.
4. Set the MCP URL to `https://inbound-live-fixture-evm5eupb3-jarndtphoto.vercel.app/mcp`.
5. Choose **No authentication**, save, and connect.
6. Start a new chat, select the new connector, and ask: `Open the invented Inbound Live Radar near Chicago.`
7. Confirm Radar stays visible on initialization. Select SYN101 and wait: selection alone must not open detail.
8. Press **Track flight**. SYN101 detail may open once. Press **Back to Radar**, wait, and confirm retained/replayed results do not reopen detail.
9. Select SYN101 again and wait: it must remain Radar until **Track flight** is pressed again.
10. Select SYN105 and wait: it must remain Radar. Press **Track flight**, confirm two dated choices, choose one, then return to Radar. The old chooser/detail must not reappear.
11. Around T+30 switch Chicago→ORD→MDW and immediately select an aircraft. Switch Radar→Flights→Radar and make several more selections.
12. Wait through 20, 40, 60, and 90 seconds without manual Refresh. Confirm no persistent collective freeze and that automatic bounded recovery occurs during healthy fixture operation.
13. For the outage safety control, stop authoritative advancement and confirm motion stops at the unchanged 25-second bound; the bounded retry budget must exhaust without endless polling or drift.

Stop after this host test and report the result. Do not start anything after Part 3B.4.
