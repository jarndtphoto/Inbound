# Part 3B.3 motion-cap refresh watchdog fix

Scope: the isolated, invented-aircraft Part 3B.3 Radar preview only. Part 3B.4 is not started.

## Proven T+30 cause

The animation loop did not stop. The one-retry-per-trajectory guard was exhausted after the T+20 normal request and T+23 short retry both returned the same authoritative anchors. It then scheduled the next normal request at T+43. At T+25 the directional targets reached the unchanged 25-second extrapolation limit. The T+30 ORD-to-MDW request accepted the same shared trajectory and preserved that late deadline; the immediately following selection changed no scheduling state.

`motion-watchdog-before-fix.json` records the exact old behavior at T+30.5:

- RAF remained scheduled and `frameCount` advanced to 1,906.
- All sampled targets reported `extrapolatedSeconds: 25` and `stopped: true`.
- `shortRetryTrajectoryKey` equaled the unchanged current `trajectoryKey`.
- `nextPollAt` was still 12.5 seconds in the future.
- Manual Refresh accepted collection 101 with zero-age anchors and immediately restored motion.

That proves a coarse, exhausted retry guard plus a postponed deadline—not selection, area projection, or RAF lifecycle—caused the collective stop.

## Bounded watchdog policy

Normal cadence remains 20 seconds and the 25-second extrapolation limit is unchanged. For an `ok` or `partial` board whose earliest valid directional anchor is within seven seconds of the motion limit, scheduling uses the earlier of the normal/preserved deadline and a trajectory-owned watchdog deadline.

- The first watchdog retry is three seconds after the unchanged near-cap response.
- Later watchdog retries are four seconds apart, so the final bounded opportunity remains available through the reproduced T+30 area transition.
- At most three short retries may start for one authoritative trajectory.
- A fresh trajectory immediately resets count and timing state.
- A same-trajectory area response preserves the earlier watchdog deadline.
- Area changes and selection neither reset nor consume the budget. A retry cancelled by a polling-generation change is not charged.
- Once all three retries are exhausted, rapid retries stop and normal cadence resumes. Aircraft remain truthfully stopped at 25 seconds if the backend never advances.

Retry identity is `[collectionVersion, newest observedAt]`; it deliberately excludes `areaId`, selected aircraft, displayed map, and widget-state echo because Chicago, ORD, and MDW may project the same shared authoritative trajectory.

## Preserved invariants

- Stale tool-output rejection, monotonic `generatedAt`, same-timestamp collection regression rejection, and area matching remain intact.
- Selection persistence and polling-generation/epoch protections remain intact.
- Selection does not change `nextPollAt` or the watchdog budget.
- Area reprojection cannot postpone an earlier useful deadline.
- One RAF, one polling timer, and one age timer remain the maximum.
- Stale/unavailable truth, neutral missing-track behavior, and the 25-second motion bound remain unchanged.
- Manual Refresh remains available but is not required for the reproduced healthy recovery.

## Deterministic and browser proof

`npm run plugin:radar-transient-proof` covers the reported timeline: T0 fresh; T+20 unchanged; T+23 unchanged retry; T+25 capped motion; T+27 second retry; T+30 ORD-to-MDW with the same trajectory; T+30.5 selection; and T+31 automatic fresh acceptance. The area request and selection retain retry count 2, remaining budget 1, and the same T+31 deadline. Version 101 then resets the budget and resumes all sampled targets at 0.1 seconds of extrapolation without manual Refresh.

The same real-browser proof continues for 90.1 simulated seconds through Chicago-to-ORD, ORD-to-MDW, multiple selections, Radar-to-Flights-to-Radar, normal T+51 and T+90 updates, and a T+70 manual-refresh control. Maximum pending RAF, polling-timer, and age-timer counts are each one.

The outage branch returns the same trajectory for all three watchdog retries. Targets stop at exactly 25 seconds, the budget reaches zero, no request occurs in the next five seconds, and the next deadline returns to normal cadence. Both source and compiled application proofs pass 19 assertion groups with zero external requests and zero browser errors. Provider calls, production API calls, and production database access are all zero.
