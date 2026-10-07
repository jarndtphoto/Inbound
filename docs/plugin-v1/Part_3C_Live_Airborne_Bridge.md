# Part 3C — Live airborne Inbound bridge

Status: **in progress, plugin-only**. Starting branch: `plugin-v1-live-airborne`, rebased by port onto current main after Part 3B.4 host approval.

## Scope

This stage moves the approved fixture transport toward real aircraft while deliberately **excluding ground aircraft**. The current Inbound application still has ground-position/stage work in draft PR #81; none of that draft ground logic is imported here.

The live architecture is:

`ChatGPT MCP -> Inbound live source service -> Inbound private engine / resolver -> permitted aviation sources`

The ChatGPT MCP must never call ADS-B, FR24, FlightAware, FlightStats/Cirium, or another aviation provider directly. The source service returns only the already bounded public V1 DTOs.

Three read-only source operations are frozen for this stage:

- `POST /nearby` — public airborne Nearby response for Chicago / ORD / MDW.
- `POST /resolve` — resolve an opaque Nearby selection.
- `POST /flight` — read an exact/choice/explicit flight through Inbound.

Every source response is `Cache-Control: no-store` and carries `X-Inbound-Live-Source: airborne-v1`. The MCP client rejects direct aviation-provider origins and rejects responses that do not carry the Inbound source marker.

## Airborne-only gate

Public Nearby motion is limited to climb, cruise, descent and approach. Taxi and parked rows are invalid. A resolved detailed flight must contain a position with `onGround: false`; ground stages, ground motion and landed/taxi/gate arrival states fail closed.

This is intentional. A flight that lands while selected becomes temporarily unavailable to this stage rather than exposing known-imperfect ground state.

## Provider / release boundary

The source protocol itself performs no provider selection or provider fetches. Real source activation remains separate from MCP activation.

Current official checks on October 6, 2026 still require caution:

- adsb.fi public data is personal, non-commercial only and requires attribution; commercial/higher-rate use requires contact.
- ADSB.lol publishes its public API/data under ODbL and asks production users to contact the project.
- Airplanes.live exposes an API, but the current public API page does not by itself establish redistribution terms for this plugin.

Therefore this commit does **not** activate public real-data redistribution or deploy a live connector. The next implementation step is to wire the private Inbound Nearby engine behind this source boundary in an isolated/private environment, with provider choice and attribution explicitly reviewed before live host testing.

## Preserved work

Part 3B.4's fixture connector and deployed fixture remain unchanged. Main, Production and the current Inbound app UI are unchanged. The new branch carries current-main airborne fusion plus the host-approved plugin code; unfinished ground work is excluded.
