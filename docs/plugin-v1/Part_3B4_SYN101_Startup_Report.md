# Part 3B.4 — SYN101 startup motion correction

Scope: plugin fixture only. No work after Part 3B.4, no merge, and no production
or Inbound app source change.

The user reported that SYN101 froze immediately. No actual-host trace was
available, so the precise cause of that particular host observation is not
claimed as proven. The following matching startup failure was reproduced in
the exact deployed compiled artifact from source `05a48b619568f1a3953f9f68a008141c2dc48ee8`.

## Reproduction

The proof retrieves the real MCP resource HTML, preserves it, advances both
the server and browser clocks by 30 seconds, and opens that resource in a
simulated host with a retained SYN101 result and selection. The old widget
correctly ignores the retained flight result, but SYN101 is already stopped
at its 25-second extrapolation bound. No Nearby read occurs at launch; the
widget waits another full 20-second poll interval.

Evidence: `verification/part-3b4/startup-before-compiled.json`.

## Correction

When a callable host bridge becomes available, aged resource snapshots trigger
one immediate read through the existing read-only Nearby transport. Standalone
and legacy callable bridges use the same startup decision. Fresh launches keep
their ordinary polling deadline. Startup preserves the selected aircraft and
uses the existing singleton timers and bounded motion recovery.

The change neither alters observation timestamps nor extends the 25-second
motion bound. Retained detail results remain unable to navigate. Track flight,
explicit dated choice, and Back to Radar retain request correlation.

## Verification

- Startup source and compiled proofs: fresh, 30-second-old, and 130-second-old
  resources; automatic recovery and visible SYN101 movement; explicit Track
  and Back; retained result rejection; singleton poll and age timers.
- Compiled replay proof: 5 assertion groups, zero failures/errors.
- Compiled 90-second lifecycle proof: 20 groups, zero external requests/errors.
- Full `npm run check`: 967 tests, 966 passed, zero failed, one existing todo.
- Application build: passed with database URLs unset; migration skipped.
- Isolated fixture build: exactly `api/mcp.js`, `package.json`, `vercel.json`;
  zero provider calls, production API calls, or production database access.
- Mobile Radar and desktop detail screenshots visually inspected.

## Corrected deployment

- Source branch: `plugin-v1-syn101-freeze`.
- Source SHA: `3a20e1b13549d125fdd0ff85d9d393442bb7bb17`.
- Fixture branch: `part-3b4-syn101-startup-20261005`.
- Fixture commit: `4202436783dfcb4ce5b7684b3f635d7403464036`.
- Fixture tree: `3630e9cf727b32019356f3beb64d334960a6959d`.
- Deployment: `dpl_EtX8PXtHdHpQ3pss9S8LXn7uMvUA`, READY, Preview.
- MCP URL: `https://inbound-live-fixture-ngc64c094-jarndtphoto.vercel.app/mcp`.

The remote fixture tree was checked: exactly the same three permitted files;
the server blob is `d076a19d864c1e8a1fb6f7df36123f7662caa03d`, matching the
locally tested build. An initial public request returned HTTP 302 and
`Protected by Vercel Authentication`. The user then authorized the Vercel
dashboard fallback and an exception for this exact hostname.

## Public verification and protection

The dashboard now lists only the new exact hostname in addition to the eight
pre-existing exceptions. Require Log In is checked and Standard Protection
remains selected. The connector independently confirms SSO protection is
enabled with `all_except_custom_domains`. No wildcard, project-wide automation
bypass, production exception, or other hostname change was made. The existing
`evm5eupb3` preview and all previous exceptions remain unchanged.

Evidence: `verification/part-3b4/startup-protection-exception.jpg` and
`verification/part-3b4/startup-protection-verification.json`.

Public MCP verification completed at 2026-10-05T13:39:43Z:

- 30 RPC requests; 13 assertion groups; zero failures.
- Public unauthenticated MCP GET returns the expected 405, without an SSO
  redirect. Initialization, exact three-tool listing, and widget retrieval pass.
- Chicago, ORD, and MDW pass; Radar is bounded at 100 and Featured at five.
  This run observed the healthy 39-aircraft post-retirement board and a later
  authoritative collection refresh.
- SYN101 resolves to one exact dated occurrence. SYN105 returns two dated
  candidates and resolves only through an explicit opaque candidate choice.
- Invalid and expired tokens, callsign-only resolution, mutation attempts,
  unknown methods, unsupported inputs, and hostile origins are rejected.
- `Cache-Control: no-store`, `X-Inbound-Fixture-Only: true`, and
  `X-Inbound-Egress: static-isolation` pass. Provider calls, production API
  calls, and production database access remain zero.

Evidence: `verification/part-3b4/startup-public-verification.json`.
The deployed widget script exactly matches the tested compiled widget script;
SHA-256 `5d10191549e675f42f3fa62cf785bf8254a5bc41dbbc66870571c31943441487`.
Evidence: `verification/part-3b4/startup-public-artifact.json`.

## Manual ChatGPT host retest

This correction is publicly verified, but is not yet host-approved. Stop
within Part 3B.4 until the actual ChatGPT retest is reported.

1. Create a brand-new connector named `Inbound Live Part 3B.4 Startup Fix`,
   using the new MCP URL above and No authentication. Start a new chat with
   that connector.
2. Ask `Open the invented Inbound Live Radar near Chicago.` Initialization
   must remain on Radar; SYN101 must resume motion automatically when the
   embedded resource is aged.
3. Select SYN101 and wait. Detail must open only after Track flight. Press
   Back to Radar, wait, and reselect SYN101; old detail must not replay.
4. Select SYN105, press Track flight, confirm two dated choices, choose one,
   and return to Radar. Old chooser/detail must not replay.
5. Around T+30 switch Chicago → ORD → MDW and immediately select an aircraft.
   Exercise Radar → Flights → Radar and multiple selections.
6. Wait through 20, 40, 60, and 90 seconds without manual Refresh. Healthy
   operation must recover automatically, while a genuine outage still stops
   motion at 25 seconds.

Production, main, the Inbound app, and all previous deployments are untouched.
No merge or subsequent stage has been started.
