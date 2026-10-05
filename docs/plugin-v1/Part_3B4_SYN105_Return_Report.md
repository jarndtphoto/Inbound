# Part 3B.4 — SYN105 choice and return correction

Plugin fixture only. No merge, production change, real provider, database, or
work after Part 3B.4. The actual ChatGPT host retest of the startup correction
failed: the user chose a SYN105 option and could not return using Back to Radar.
The screenshot shows `The selection handle is invalid` and the bounded-motion
stop notice. This is not a host-approved checkpoint.

## Findings and limits

Two independent fixture handlers reproduce the exact selection-handle error:
a handle issued by worker A is absent from worker B's memory. A SYN105 candidate
issued by A is likewise invalid on B. Previously, public verification and
browser proofs used one warm worker and did not exercise that boundary.
Evidence: `verification/part-3b4/syn105-worker-before.json`.

The old compiled widget also recreates dated-choice buttons during every age
render, removing keyboard focus and an in-progress pointer target. Its Back
handler commits visibility only after rendering unrelated host controls.
Fault injection of null optional host-context fields reproduces a render error
that leaves the error panel visible after Back. The actual host's context or
console trace was not available, so that injected condition is not claimed as
the proven cause of the user's Back failure. The Vercel runtime-log request
timed out without returning logs.
Evidence: `verification/part-3b4/syn105-return-before.json`.

## Correction

Only the isolated Radar Preview uses the new fixture handoff service. It uses
authenticated 43-character handles containing a compact invented row index,
public observation times, collection version, and a fixture route-hint flag.
A build-specific authority and the exact deployment hostname scope each handle.
Workers reconstruct the same invented evidence, exact dated occurrence, and
explicit candidate choice without a shared database or provider request.
Selection and candidate validity end at observation time plus 90 seconds;
re-resolution, cold workers, and later reads cannot extend that deadline.
Tampering, wrong request kinds, and other deployment realms are rejected.

Exact instance IDs are deterministic within the fixture deployment. A cold
worker reconstructs them from the bounded invented catalog. Explicit fake
lookup dates are limited to the retained window (14 days before today through
tomorrow). This is a synthetic host proof, not a persistence or authentication
implementation for real aviation data. The SQL store and ordinary memory-store
semantics remain unchanged.

Back commits local visibility and cancels the active handoff before unrelated
rendering. It selects the Radar map even when detail was entered from Flights.
The Radar and Flights tabs also exit handoff locally. Retained, duplicate, or
late results still cannot navigate after Back. Optional host-context fields are
validated, and dated-choice buttons stay mounted across age updates.
The existing About-this-preview diagnostic now reports the current view,
last UI action, and last UI error for the next actual-host test.

The 25-second motion limit, maximum three short retries per trajectory, and
singleton RAF/poll/age loops remain in place. A 38-nm narrow Radar view moves
subtly at real-time fixture speeds; a stopped-motion notice is a failed or
delayed refresh, not an animation speed setting.

## Verification

- Independent-worker unit coverage: both SYN105 dated choices, SYN101 direct
  resolution, cold-worker exact instances, explicit date/route lookup,
  tampering, request-kind substitution, deployment isolation, and expiry.
- New compiled return proof: three alternating independent workers; seven
  assertion groups; zero browser errors. It covers stable candidate focus,
  invalid-choice Back, malformed optional context, replay rejection, late
  direct responses, Back from Flights, Radar tab exit, and automatic refresh.
- Existing compiled replay proof: five groups, zero failures/errors.
- Existing compiled startup proof: fresh, 30-second-old, and 130-second-old
  resources recover correctly.
- Existing compiled 90-second lifecycle proof: 20 groups, zero browser errors
  or external requests.
- Full `npm run check`: 971 tests; 970 passed, zero failed, one existing todo.
- Build passed with database URLs unset; database migration skipped.
- Isolated deployment payload: exactly `api/mcp.js`, `package.json`, and
  `vercel.json`; no database, provider, production API, or runtime egress.
- Narrow 273-pixel Radar and desktop detail screenshots visually inspected.

New evidence: `verification/part-3b4/syn105-return.json`,
`syn105-back-radar.png`, and `syn105-error.png`, plus the regenerated compiled
replay/startup/lifecycle and build-audit evidence in the same directory.

## Deployment and next gate

Source changes were fast-forwarded on the existing
`plugin-v1-flight-handoff` branch, whose automatic application deployment is
already disabled. The startup correction and its evidence remain in history.
Only the private `inbound-live-fixture-dev` repository received the three-file
fixture deployment.

- Code/source SHA: `6e4d1fc8dde3164c15f913bb6aa6428237f83b3a`.
- Fixture branch: `part-3b4-syn105-return-20261005`.
- Fixture commit: `3c92ffee0c1070287003569843ed3ab9f6264b03`.
- Fixture tree: `24c8aea7ab0de4f12fc618ecf1d7ccb9e43ea864`.
- Server blob: `11fa1b808535cc44f06a07f5e94cf648d3e0c30b`, 409,053 bytes.
- Deployment: `dpl_2UgGXdN3DxvvW3VZhb6iubd7SRar`, READY, Preview.
- Exact hostname: `inbound-live-fixture-ra6kolsml-jarndtphoto.vercel.app`.
- MCP: `https://inbound-live-fixture-ra6kolsml-jarndtphoto.vercel.app/mcp`.

The remote tree contains exactly the three audited files with byte-identical
blob SHAs. The dashboard independently shows READY, Preview, the expected
branch/commit, and the exact hostname. Evidence:
`verification/part-3b4/syn105-deployment-ready.jpg` and
`verification/part-3b4/syn105-deployment.json`.

The public unauthenticated MCP probe returned HTTP 302 / Protected by Vercel
Authentication at 2026-10-05T14:21:10Z. Evidence:
`verification/part-3b4/syn105-public-access.json`.
No new protection exception has been added. The user's previous exact-host
approval covered `ngc64c094`, not this new hostname. The connector confirms
SSO protection remains enabled with `all_except_custom_domains`; no global
setting, old exception, production domain, or previous deployment was changed.

Stop for approval of an exception only for the new exact hostname. After that
exception, complete public MCP verification and request a brand-new connector
and chat for the actual host retest. Do not start a subsequent stage.
