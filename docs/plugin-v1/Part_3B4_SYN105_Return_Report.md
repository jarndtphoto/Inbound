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

### Actual host re-entry failure — 2026-10-05

The next real ChatGPT host retest confirmed that Back itself now returns to
Radar and SYN101 Track -> Back stays on Radar. Automatic Nearby refresh also
continued without manual Refresh, with visible aircraft updates arriving at
irregular intervals.

SYN105 exposed a separate local-state regression. The first Track action showed
two dated choices, the selected date opened correctly, and Back returned to
Radar. After selecting SYN105 and pressing Track again, the widget skipped the
two-date chooser and reopened the previously chosen exact occurrence. About
this preview reported `Host bridge connected`, `Last action: track-flight`, and
`Last UI error: none`, so this was not a host-bridge exception or retained
host replay.

Root cause: every resolved handoff was written into `resolvedInstances`,
including a response produced by an explicit ambiguity `choice`. The next Track
action therefore used `get_flight(kind: instance)` instead of resolving the
Nearby selection again, silently promoting one dated choice into a sticky
default for that aircraft.

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

Candidate-choice responses are now deliberately non-sticky. Choosing a SYN105
date clears any stale exact-instance cache for that aircraft, and the resolved
choice is used only for the current detail view. Only direct unambiguous
resolution / exact-instance reads may populate `resolvedInstances`. Therefore,
after Back to Radar, reselecting SYN105 and pressing Track must resolve the
Nearby selection again and present both dated choices.

The 25-second motion limit, maximum three short retries per trajectory, and
singleton RAF/poll/age loops remain in place. A 38-nm narrow Radar view moves
subtly at real-time fixture speeds; a stopped-motion notice is a failed or
delayed refresh, not an animation speed setting.

## Verification

- Independent-worker unit coverage: both SYN105 dated choices, SYN101 direct
  resolution, cold-worker exact instances, explicit date/route lookup,
  tampering, request-kind substitution, deployment isolation, and expiry.
- The prior compiled return proof passed seven assertion groups with zero
  browser errors. The proof script now adds the actual-host regression: after
  choosing a SYN105 date and returning to Radar, a fresh Track action must show
  both dated choices again rather than reuse the previous exact occurrence.
  This updated proof must be rerun for the corrected deployment.
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

The initial unauthenticated probe returned HTTP 302 / Protected by Vercel
Authentication at 2026-10-05T14:21:10Z. That historical result remains in
`verification/part-3b4/syn105-public-access.json`.

The user subsequently approved the exact new hostname exception with `yes`.
Only `inbound-live-fixture-ra6kolsml-jarndtphoto.vercel.app` was added. The
dashboard confirms all nine previous exceptions remain intact (ten total),
Require Log In is checked, and Standard Protection remains selected. The
connector independently confirms SSO enabled with `all_except_custom_domains`.
No wildcard, project-wide automation bypass, production exception, global
setting, previous hostname, or previous deployment was changed. Evidence:
`verification/part-3b4/syn105-protection.json` and
`verification/part-3b4/syn105-protection-exception.jpg`.

The completed public MCP run passed at 2026-10-05T15:13:07Z: 29 RPC requests,
13 assertion groups, zero final failures, plus the public GET check (405).
Initialize, exactly three read-only tools, resource retrieval, Chicago/ORD/MDW,
SYN101 direct and exact-instance resolution, SYN105 two dated choices and
explicit choice, closed-input and hostile-origin rejection, authoritative
refresh, and actual observation-handle expiry passed. Radar remained at 39
after retirement; bounds are Radar <=100 and Featured <=5. Responses confirm
`no-store`, fixture-only, and static-isolation headers. Provider calls,
production API calls, and production DB access remain zero.

One preliminary run failed its initial healthy-board assertion, consistent
with the fixture's intentional stale pre-retirement interval. A follow-up confirmed the
healthy 39-aircraft collection before the complete run passed. That preliminary
result is retained in `verification/part-3b4/syn105-public-preliminary.json`;
the completed run is `verification/part-3b4/syn105-public-verification.json`.
The deployed widget script also exactly matches the tested compiled artifact:
SHA-256 `7b737d25e3193ab7be2dac8db6691125e40080b4294e42ceac40b6047d55b73f`.
Evidence: `verification/part-3b4/syn105-public-artifact.json`.

## Actual-host chooser re-entry correction deployment

The host re-entry bug above is patched without touching the Inbound app,
`main`, or production. Candidate-choice detail is no longer cached as the
next default occurrence, and the return proof now contains the exact host
regression sequence.

- Source branch at deployment: `plugin-v1-flight-handoff`.
- Source head at deployment: `a970e6cc9b1de978f8c7762cbbe077960cb095fe`.
- Source deploy blob: `4dc7d3bdcc3c0cb521dcbb5c9ea25c91357d208d`.
- Fixture branch: `part-3b4-syn105-return-20261005`.
- Fixture commit: `0db4be2b342dbcb1316dfdc1f8969f054df887ac`.
- Fixture tree: `7b91f772cff3eb06b8bf0a148234511ff7d57349`.
- Fixture server blob: `4dc7d3bdcc3c0cb521dcbb5c9ea25c91357d208d`.
- Deployment: `dpl_A6qfuUj1MLWbUG9uV3w9xjX1Mnnm`, READY, Preview.
- Exact hostname: `inbound-live-fixture-eqhshvwuc-jarndtphoto.vercel.app`.
- MCP: `https://inbound-live-fixture-eqhshvwuc-jarndtphoto.vercel.app/mcp`.

The protected deployment responds correctly through authenticated Vercel
access (GET `/mcp` -> 405 with `Allow: POST`, `no-store`, fixture-only and
static-isolation headers). Project SSO / Require Log In remains enabled with
`all_except_custom_domains`. No protection setting has been changed for this
new deployment. A new exact-host exception is required before public MCP and
actual ChatGPT host verification can resume.

## Required actual ChatGPT retest

Public verification is complete; actual host approval is still pending.
Create a brand-new connector named `Inbound Live Part 3B.4 SYN105 Return Fix`,
using No authentication and the exact MCP URL above. Start a new chat, select
that connector, and ask `Open the invented Inbound Live Radar near Chicago.`

1. Initialization must remain on Radar. Select SYN101 and wait; it must stay
   on Radar until Track flight is pressed.
2. Track SYN101, return using Back to Radar, and wait. Detail must not reopen.
   Select SYN101 again; navigation must require a fresh Track flight action.
3. Select SYN105, wait, then press Track flight. Confirm two dated choices.
   Choose the first option, press Back to Radar, and confirm the map returns.
4. After Back, reselect SYN105 and press Track again. The two dated choices
   must appear again; the previously chosen exact occurrence must not reopen
   automatically. Choose the other date, then Back to Radar. Back must also
   work from an unavailable-flight panel if one occurs.
5. Around T+30, switch Chicago -> ORD -> MDW and immediately select an aircraft.
   Exercise Radar -> Flights -> Radar and several selections.
6. Wait through 20, 40, 60, and 90 seconds without manual Refresh. Healthy
   operation must refresh automatically; a genuine outage must still stop
   bounded motion at 25 seconds. Movement is subtle in the narrow 38-nm view.
7. If a control fails, expand About this preview and capture the current view,
   last UI action, and last UI error along with the visible failure.

Stop for this manual host retest. Part 3B.4 is not host-approved, and no
subsequent stage has started. The Inbound application, main, and production
remain untouched.

## 2026-10-06 resumed verification checkpoint

Work remains plugin-only. The corrected SYN105 chooser re-entry Preview is still
the isolated `inbound-live-fixture-dev` deployment
`dpl_A6qfuUj1MLWbUG9uV3w9xjX1Mnnm` at
`inbound-live-fixture-eqhshvwuc-jarndtphoto.vercel.app`.

The exact deployment URL now has an alias-protection override for host testing.
Project-wide Vercel Authentication / Require Log In was not disabled. An
authenticated GET to `/mcp` returned HTTP 405 with `Allow: POST`,
`Cache-Control: no-store`, `x-inbound-fixture-only: true`, and
`x-inbound-egress: static-isolation`.

An isolated fresh clone at branch head
`79f1fc5724eaa4f2ebaa0f30cbfb5e598a65d131` regenerated both fixture and Radar
Preview artifacts. Handoff/service coverage passed, including independent
workers, both SYN105 dated choices, exact-instance reconstruction, tamper/kind
rejection, expiry, Radar deployment isolation, and MCP read-only boundaries.
The broad plugin test run reached 146 passing tests; its only remaining failure
was a sandbox `SIGKILL` while running the fixture-preview isolation file, not
an assertion failure. The browser return-proof could not be rerun in that
disposable Vercel sandbox because its minimal Linux image lacks Chromium runtime
libraries and has no package manager. No repository or production workaround
was made for that infrastructure limitation.

The authoritative next gate remains the real ChatGPT host retest against the
exact MCP endpoint below. Part 3B.4 remains unapproved until that passes.

