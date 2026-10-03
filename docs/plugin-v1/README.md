# Part 3A: isolated V1 foundation

Starting approved main: `12887c6133a40b13d62973cb4e7541761da22333`.
Main advanced through approved PR #38 during this work; the unpublished branch
was rebased onto `151cee0cd790d5a19e81c12e448ee3eb125dfdf6` and verified again.
Branch: `plugin-v1-foundation`. No merge, push, deployment or production migration.
Authoritative design: completed Part 2 V1 Product and API Specification, with the
Part 3A amendments: “near Chicago/ORD/MDW”, ephemeral current-state storage,
fixture-only host proof before backend integration, and existing engine isolation.

## Scope and entry points

`src/lib/plugin-v1/` contains strict Zod contracts and exported TypeScript types,
deterministic invented fixtures, Inbound-owned area resolution, pure geographic
cropping, frozen ranking, and shared-view stability. None is mounted in the
existing app's routes or current UI. The only existing runtime source edit moves
the exact private `sky.ts` `phaseOf` body to `traffic-motion.ts` and imports it.
An equivalence test compares it with approved main and exercises 630 combinations
at the original thresholds. Provider selection, fusion, persistence, detailed
phases, arrival/departure calculations, and existing map behavior are unchanged.

`npm run plugin:test` runs the deterministic foundation tests. `npm run
plugin:proof` explicitly starts a loopback-only static fixture server with one
MCP tool, `fixture_get_nearby_flights`, and one self-contained UI resource,
`ui://inbound/fixture-live-v1.html`. Neither is a real business tool. The server
does not import the flight story, adapters, weather, baggage or DB runtime. The
proof does not resolve aircraft or return real flight occurrences. Its generated
UI and tokens are explicitly invented test data.

`npm run plugin:browser-proof` tests the standalone component and an explicitly
labeled simulated MCP Apps host in a local browser. Its twelve assertions cover
selection, named-reference area changes, refresh without resetting fix ages,
pause/resume, hidden/dismissed behavior, keyboard focus, bridge tool refresh,
state on remount and teardown acknowledgement. Both desktop and mobile rendering
checks pass with no horizontal overflow or browser errors. These are component
checks, not evidence of actual ChatGPT support. The browser CLI was unavailable
in the verification environment; these checks used Playwright instead.

No real `/api/public/v1/nearby-flights`, `/resolve`, or `/flights/get` route exists.
No acquisition, distributed lease implementation, enrichment worker, occurrence
resolver, public serializer for current provider data, or production auth is
included. Part 3B is not started.

## Contracts and limits

Every object uses `z.strictObject`; unknown nested properties are rejected.
Definitions include NearbyRequestV1, InboundNearbyFlight,
NearbyFlightsResponseV1, FlightCandidateV1, FlightResultV1, InboundFlightV1,
Fact<T>/factSchema, EventTimeV1, AirportV1, RunwayV1, DelayV1,
GetFlightRequestV1 and ResolveNearbyRequestV1. `publicJsonSchemas()` exports
structural JSON Schema. Cross-field status, provenance, freshness, selection and
UTF-8 payload checks remain executable Zod validations; JSON Schema alone does
not enforce these refinements.

Version is `1.0`; dates are valid calendar dates, instants are UTC with `Z`,
service zones use validated IANA names, missing facts remain null, and numeric
fields reject NaN/infinity. At most five cards/candidates, 128 map points,
32 KiB Nearby and 64 KiB detailed envelopes. Source attribution is an optional
small display allowlist, never provider IDs or request URLs. Display text rejects
control characters, HTML delimiters and URLs.

Supplemental defensive bounds (not engine limits) are: identifiers 16 chars,
airline/city/phase labels up to 64, airport/aircraft names 80, fact display values
40, status/error copy 160, observed altitude -2,000..200,000 ft (Nearby ≥500),
groundspeed 0..2,000 kt, vertical rate ±20,000 fpm, track [0,360), delay ±10,080
minutes, summary age ≤14 days. These do not add or change existing flight math.
Runtime validation allows one second of timestamp rounding/clock skew, without
resetting observation times. A cold warming contender has the explicitly
specified five-second retry; ordinary refresh/backoff is 20..120 seconds.

## Areas, ranking and stability

Only Chicago, ORD and MDW resolve. Aliases are owned by Inbound. Chicago's
reference is 41.90/-87.80; ORD/MDW coordinates come from the existing directory.
Radii are 12/25/38 nm; defaults are 38/25/25. Four cards default, five maximum.
No GPS, arbitrary point, provider geocoder or per-user geographic key.
The proposed 50 nm covering collection is configuration only; no provider
feasibility claim is made. All nine circles fit geometrically in offline tests.

Distances use existing `haversineNm` and are recalculated per view, ignoring
provider `dst`/`dir`. Statute miles are display conversion only. An offline test
found that existing `geo.initialBearing` uses `sin(lat2)` in the x expression
instead of the standard `cos(lat2)`. The existing function is untouched; the new
Nearby helper computes correct initial bearings in its own isolated scope. This
is an explicit implementation deviation from blindly reusing that helper, not a
fix to existing maps/arrival/departure math.

Ranking accepts private normalized, already-accepted Inbound candidates. It
does not perform fusion, extrapolation, identity matching or dated lookup.
An accepted extrapolation must have been approved within existing fusion limits.
Eligibility, integer scores (maximum 128), ties and separate ±250 fpm vertical
trend follow Part 2. Session-bound dated route evidence expires after 120 s;
hints never receive the airport-association bonus. Ground vehicles, on-ground,
missing/invalid fixes, telemetry and identities are filtered. Scores and private
identities are not public fields.

Stability holds five shared slots per area/radius, gives valid incumbents 90 s,
requires a 20-point challenger margin, replaces at most one competitive slot per
new collection version, preserves incumbent order, fills hard removals at once,
and returns limits 1..5 as prefixes. Outage reads retain prior order rather than
ranking stale observations. Response freshness/120 s serving still belongs to
the later serializer. Demand touches retention; expired states are discarded.

## Staged ephemeral DB design

`migrations/0004_plugin_v1_ephemeral.sql` **under this docs directory** is staged
for review. It is outside both automatic root `migrations/*.sql` discovery paths.
It has been exercised only in a disposable in-memory PGLite database through a
test adapter using the existing `Sql.query` surface, matching existing DB tests.
Do not move it into automatic migrations or apply to shared DBs without approval.

New schema `inbound_plugin_v1` contains ten bounded record types:
current collection (including last-safe metadata), ranked views, route hints,
current card sessions, selection handles, candidate choices, occurrence
registry, current public detail snapshot, normalized lookup work, and a bounded
construction-budget list. No historical traffic/replay table. Collection/detail
keys overwrite current state; no timestamp in the collection primary key.
Environment separation, unique keys, TTL fields, hashed handles, payload bounds
and fencing fields are prepared. TTL-aware reads/cleanup, atomic claims and
publication, shared-handle reuse, budgets and access control remain Part 3B work.
DDL alone does not establish distributed sharing or bounded upstream calls.

## Host proof and approval boundary

The widget contains four fixture cards, safe route/hint labels, altitude/trend,
server-owned motion, distance from the named reference and advancing local ages.
Selection is local; it preserves the selected card ID and area/pause/fixture-clock
state via `window.openai.setWidgetState` when supplied, otherwise session storage.
Refreshing the static fixture preserves its original fix time; rows age out at
120 s. Visible-only polling uses one 20 s timer; pause, visibility changes,
pagehide/dismiss and MCP `ui/resource-teardown` stop it. No chat message, model
sampling or unattended model turn is requested.

The self-contained component implements the small MCP Apps initialization,
tool-call, result, host-context, display-mode and teardown message surface using
published JSON-RPC messages. It declares inline/pip/fullscreen and checks the
host's available modes. A host may return another actual mode; the UI accepts
that result. Without a host, PiP/expanded controls stay disabled and inline
fallback is clearly labeled. The OpenAI compatibility globals are only used for
state/tool-result fallback and close, with feature detection.

**Actual ChatGPT PiP, remaining visible through conversation, host widget-state
retention, model-free host refresh, mobile/fullscreen and teardown delivery are
not confirmed.** No ChatGPT MCP connection or deployment was created.
The cloud browser rejects the local proof URL (`ERR_BLOCKED_BY_CLIENT`). A local
test harness, DOM tests or mock host can verify component behavior only; they
must never be reported as actual ChatGPT support.

Before Part 3B: complete a fixture-only test in the intended host, verify the
matrix in actual intended ChatGPT surfaces, resolve any host limitation openly,
review the staged DB design and defensive normalization bounds, then obtain the
user's explicit Part 3A approval. No release claim follows from this foundation.

## Verification at the rebased foundation

Typecheck and production build pass. Offline serialized regression checks report
734 tests: 733 pass, zero fail, one existing held TODO for FlightStats ZRH / an
unknown-airport public route. The 75 foundation tests all pass. The original
approved-main baseline also reproduced that same TODO before changes.
Existing welcome-screen dev and built-output checks pass at desktop and mobile,
with no browser errors, horizontal overflow, or detected baseline divergence.
Live end-to-end flight tracking is intentionally untested in this fixture stage.
The staged migration is tested only in disposable local PGLite; production
migrations were skipped with the production database URL unset.
