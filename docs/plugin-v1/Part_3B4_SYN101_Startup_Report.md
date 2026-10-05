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

Deployment and actual ChatGPT host verification remain pending. Keep the
existing `evm5eupb3` preview and its protection exception unchanged. Stop after
preparing the corrected preview and receiving the manual host retest result.
