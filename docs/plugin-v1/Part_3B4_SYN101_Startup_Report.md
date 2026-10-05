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
locally tested build. Public unauthenticated access returned HTTP 302 and
`Protected by Vercel Authentication`. Public MCP verification and the actual
ChatGPT host retest remain pending.

No protection settings were changed. The connector can read this deployment
but lacks an exact-host exception action. Browser fallback permission is needed
before adding an exception only for
`inbound-live-fixture-ngc64c094-jarndtphoto.vercel.app` in the isolated project,
while retaining global Standard Protection / Require Log In. The existing
`evm5eupb3` preview and all previous exceptions remain unchanged.

Do not proceed beyond Part 3B.4. After that one hostname exception is authorized
and confirmed, verify the public MCP and obtain the manual ChatGPT host retest.
