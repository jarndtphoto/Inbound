# Part 3B.3 manual ChatGPT host test

This is a new, isolated preview using invented aircraft and invented route evidence through Inbound's existing private Nearby engine. It is not live flight information. Local and direct MCP verification do not establish ChatGPT host approval; the checks below must be performed in the user's authenticated ChatGPT account.

## Connection details

| Setting | Value |
| --- | --- |
| Suggested name | Inbound Live Radar Transport Preview |
| Suggested description | Engine-backed Radar transport preview with 40 invented aircraft around Chicago, ORD and MDW. Demonstrates shared Nearby snapshots, Featured cards and bounded local aircraft movement. No live aviation data. |
| Preview hostname | `inbound-live-fixture-d6eedvyfd-jarndtphoto.vercel.app` |
| MCP URL | `https://inbound-live-fixture-d6eedvyfd-jarndtphoto.vercel.app/mcp` |
| Current access status | Public MCP verified: 25/25 request outcomes and 297/297 assertions; exact-host exception active; Standard Protection remains enabled globally |
| Proof window | Ends 2026-10-11T23:59:59Z |
| Authentication | No authentication for this isolated fake-data preview |
| Access prerequisite | Direct MCP inspection passed and a Deployment Protection Exception applies only to this exact preview hostname; Standard Protection stays enabled globally |

Add this as a separate development connection using ChatGPT's custom MCP/developer-mode connection flow. Use the MCP URL above, not the preview homepage or `/widget` path. Do not delete, rename or replace the existing Inbound Live Radar Dev connection or any personal plugin. If the host displays a development-connection confirmation, verify the exact hostname and invented-data description before accepting it.

If the connection is blocked by Vercel protection, record that failure and stop the host test. Do not disable protection globally or use a production endpoint as a substitute. No provider credentials or production database credentials are required.

## Supported tool inputs

The only tool is `get_nearby_flights`. Inputs are exactly the approved area ID, an optional supported display radius, and an optional Featured limit:

```json
{"area":"preset:chicago","radiusNm":38,"limit":4}
```

Other approved areas are `airport:KORD` and `airport:KMDW`. Supported radii are 12, 25 and 38 nautical miles. Featured defaults to four and accepts one through five; this limit does not limit Radar to five aircraft. Arbitrary coordinates and exact-user-location inputs are unavailable.

## Start the host test

Use this new connection and ask:

> Open Inbound Live Radar Transport Preview for Chicago.

If ChatGPT offers more than one Inbound connection, choose this new preview explicitly. Confirm the rendered widget identifies its aircraft as invented. Keep the proof open for at least two authoritative update cycles, then test Pause and expiry as described below.

For the specific lifecycle regression, perform this focused sequence before the broader checklist:

1. Open Chicago and confirm directional aircraft are visibly moving.
2. Click any aircraft. Watch both the selected aircraft and several unselected aircraft for at least five seconds; all directional aircraft must continue moving.
3. Change Chicago → ORD while the result is loading. The accepted Chicago board must remain visible and moving until ORD is accepted.
4. Change ORD → MDW, then select a different aircraft. Movement must continue through both actions without a page reload.
5. Leave the widget open through the next two approximately 20-second authoritative updates. New fixes must replace/correct trajectories and movement must continue. If an accepted fix receives no replacement, local movement may stop only at the certified 25-second bound; a new fix must resume it.

The fake shared snapshot contains 40 invented aircraft on its initial acquisition. One older observation, `SYN140`, retires from subsequent acquisitions, so the normal refreshed snapshot contains 39. A previously warmed preview may already show 39 when the host test begins. Distances, crop and ordering change with area; an area or radius may show fewer targets. None of these counts is a claim about real air traffic.

## Host checklist

| Check | Action | Expected behavior |
| --- | --- | --- |
| Inline default | Open Chicago in the conversation. | The inline view starts on Flights with four Featured cards. Radar and Flights tabs have a visible selected state. |
| Expanded default | Use the host-supported Expand/fullscreen control. | Expanded view starts on Radar. Fullscreen is offered only when the host advertises it. |
| Many aircraft | Inspect Radar in Chicago at the default radius. | Approximately 40 initial symbols, then 39 after the retiring observation is omitted. Radar remains independent of four Featured cards. |
| Featured maximum | Ask for five Featured flights in Chicago. | At most five Featured cards; Radar continues to contain many aircraft. |
| Selection | Click or tap a symbol, then switch to Flights and back to Radar. | The same aircraft remains selected, highlighted, and represented in the compact detail panel. Selection does not silently switch to another aircraft. |
| Selection after refresh | Keep the selected aircraft through two refreshes. | Its safe Radar ID remains selected while new authoritative fixes replace its trajectory. The panel shows the new observation age. |
| Label readability | Inspect the dense ORD/MDW portions and select an unlabeled symbol. | Selected aircraft is labeled; Featured and a small bounded set of other aircraft may be labeled. Most targets are symbols only, with no wall of overlapping labels. |
| Area switching | Change Chicago → ORD → MDW → Chicago using the area selector. | Center, reference distance/bearing, display crop and Featured order may change. Shared collection version is reused when switching within the same acquisition cycle; crossing a normal 20-second cycle may advance it. |
| Confirmed route | Inspect `SYN101` or `SYN102` where present. | Independently invented dated evidence can display `ORD → BOS` or `MDW → DEN` as Confirmed route. No provider source or detailed flight-occurrence data appears. |
| Generic route hint | Inspect a Featured card marked Route hint. | Generic fake lookup evidence is explicitly labeled Route hint and never automatically becomes Confirmed route. |
| Unknown route | Select an aircraft without a route. | The aircraft remains visible and selectable; its panel says Route unavailable. Missing route does not remove Radar aircraft. |
| Smooth movement | Watch tracked aircraft between updates around T0, T+20 and T+40 seconds. | Symbols move continuously along accepted ground track and groundspeed. New authoritative fixes correct/replace the trajectory. Altitude remains the accepted measurement. |
| Missing track | Find `SYN139` when present, using marker focus/aria text if necessary. | It has a neutral symbol and no invented directional motion, destination pointing or heading. Text refers to Track when track is available. |
| Bounded movement | Press Pause immediately after an update and watch for more than 25 seconds. | Automatic Nearby requests stop. Local motion reaches the certified maximum of 25 seconds from the accepted fix and stops; there is no endless drift. |
| Stale observation | Keep Pause enabled for more than 45 seconds from the accepted fix. | Observation age advances; the widget clearly identifies delayed/stale observations and aircraft remain stopped. Resume obtains a current shared result when available. |
| Retired selection | If the initial `SYN140` is present, select it before the next update, then wait for its retirement and absolute expiry. | The selection remains on that aircraft. The panel explains that no current observation is available and later that its last observation expired; another aircraft is not substituted. The original observation begins approximately 40 seconds old, so it expires after roughly 80 more seconds. |
| Paused selected expiry | If the retiring aircraft is already absent, select any target and keep Pause enabled until its observation is older than 120 seconds. | The target leaves the current Radar while the selected panel retains its last observation with a clear expired status. Resume does not silently select a different aircraft. |
| Track flight | Inspect the selected-aircraft detail panel. | Track flight is disabled and explicitly unavailable in this stage. |
| Mobile layout | Test at approximately 375px width or on a phone. | Tabs, controls, cards and selected details fit without horizontal scrolling. Symbol selection remains usable. |
| Keyboard/accessibility | Focus the Radar/Flights tabs, switch using keyboard controls, and focus/select an aircraft. | Selected tab semantics, aircraft aria labels, selection state and visible focus remain clear. |
| Host-controlled PiP | Inspect the host capability state and any PiP control. | PiP stays disabled unless the host advertises it. No browser-window simulation or claim of working PiP is made. Record the actual host result. |
| Health display | Observe normal and paused/aging data, plus any genuinely unavailable response encountered. | Normal data remains useful; partial coverage is a subtle note; stale motion stops; unavailable explicitly describes lack of current data rather than empty sky. Automated proof scenarios separately exercise all four health states. |

Automatic host refresh uses approximately the existing 20-second cadence. Smooth movement is local animation between responses, not a one-second MCP polling loop. Manual Refresh is a separate user action. The UI does not send new chat messages to animate symbols.

## Isolation and interpretation

- Aircraft, identities, phase evidence and route evidence are invented. Aviation-provider calls, production Inbound API calls and production database access are zero.
- The isolated proof uses an injected memory store to exercise the actual engine, route layer, serializer, MCP and widget path. Its 100-viewer test demonstrates one shared fake acquisition within that proof instance. It is not a new certification of multi-instance memory coordination and does not replace the previously certified Postgres coordination.
- Chicago, ORD and MDW reuse a shared Chicago collection; area controls change view geometry and ranking rather than creating per-viewer acquisitions.
- A serverless cold start or separate preview instance can restart the invented timeline. Record a visible instance/timeline reset if it occurs; do not interpret it as live flight behavior.
- The public response excludes provider identifiers/endpoints, private aircraft/session identity, registration, phase evidence, route-cache keys, budget state, database row IDs, occurrence IDs and selection handoff tokens.
- The existing approved fixture deployment and Inbound Live Radar Dev connection remain unchanged. This test does not approve activation of a real aviation provider.

## Record the result

Record the connection name, exact preview hostname, host display mode, device/viewport, aircraft count, selected aircraft, actual PiP capability, and each checklist outcome. Capture short screen recordings for movement/new-fix correction and screenshots for layout or selection failures if convenient. Describe failures using observed behavior rather than declaring overall host approval prematurely.

Stop after the manual host test and report the results for approval. Do not merge, deploy production, activate live aircraft or route sources, replace existing connections, or begin Part 3B.4.
