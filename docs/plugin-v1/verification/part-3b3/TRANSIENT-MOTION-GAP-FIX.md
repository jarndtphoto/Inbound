# Part 3B.3 transient motion-gap fix

Scope: the isolated, invented-aircraft Part 3B.3 Radar preview only. Part 3B.4 is not started.

## Proven cause

The animation loop did not stop. A client poll whose deadline was armed at T+0 could run at T+20 just before a shared collection published at T+0.8 became eligible for its next backend acquisition at T+20.8. That request returned the same collection and accepted anchors. The previous scheduler then armed the next request for T+40. At T+25.8 the unchanged directional anchors reached the unchanged 25-second motion limit, so every directional marker stopped even though RAF, the one-second age timer, and the one polling timer remained alive.

The pre-fix capture in `transient-gap-before-fix.json` records:

- T+20: version 2 returned again, sampled live age 19.2 seconds, RAF scheduled, next poll T+40.
- T+25.9: RAF frame count advanced from 1,443 to 1,618, while all sampled directional targets reported `extrapolatedSeconds: 25` and `stopped: true`.
- The scripted fresh T+23 result remained unused.

This is a cadence-phase race, not the previously fixed stale `toolOutput` regression and not a stopped RAF.

## Chosen policy

Normal client cadence remains 20 seconds. When an accepted refresh returns the same authoritative trajectory and the newest directional anchors are within seven seconds of their 25-second motion limit, the client may arm exactly one three-second retry for that trajectory. A second unchanged result returns to the normal 20-second cadence; it cannot create a rapid retry loop. A new collection/anchor epoch clears the one-retry guard and returns to normal cadence.

The retry is a viewer request through the same shared Nearby acquisition path. It does not bypass backend eligibility, change the acquisition cadence, or create additional provider polling. If the backend is due, the shared lease/acquire path publishes once; if it is not due, the request reuses the current collection.

Using a permanent 21–22 second client interval was rejected because it delays every successful correction, still permits phase locking after latency or cold-isolate shifts, and does not directly distinguish a genuinely fresh result from an unchanged near-cap result. The 20-second cadence plus one conditional three-second retry preserves the normal latency and request economics while covering the measured edge.

## Preserved invariants

- The 25-second safety bound is unchanged.
- Stale and unavailable boards stop motion; missing track remains neutral.
- Monotonic `generatedAt` acceptance, same-timestamp collection regression rejection, and area matching remain intact.
- Selection and widget-state echoes do not reset `nextPollAt`.
- Area reprojection for the same collection is not treated as an authoritative trajectory update and preserves a future meaningful deadline.
- One RAF loop, one polling timer, and one aging timer remain the maximum.
- Manual refresh, area refresh, visibility lifecycle, out-of-order requests, and stale retained output retain their prior generation/epoch protections.

## Deterministic proof

`npm run plugin:radar-transient-proof` covers:

- the T+0.8 publication / T+20 same / T+23 fresh / T+25.8 cap timeline;
- same-version young anchors with no retry;
- exactly one short retry for an unchanged near-cap result;
- an unchanged retry returning to normal cadence with no rapid loop;
- selections at T+19 and T+24 preserving the deadline;
- the required 65-second host-like sequence at T+5, T+12, T+18, T+27, T+34, T+42, and T+48;
- advancing authoritative versions, no collective cap caused by the cadence edge, and singleton timers;
- the original 25-second stop when backend updates are deliberately paused;
- zero aviation-provider calls, zero production API calls, and zero production database access.
