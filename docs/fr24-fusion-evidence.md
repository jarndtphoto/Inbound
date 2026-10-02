# Stale FR24 surface fusion follow-up

Base: cleanup PR #32 (`7beeeb3`). This PR changes only the held #24 fix and
its regressions. It does not include the public-time parsing fix.

FR24 ground positions now expire at 30 seconds, matching the existing story
wrapper. The previous fusion window retained ground fixes up to 60 seconds,
preferred FR24 through 45 seconds, and could restrict scoring to a stale ground
fix instead of a fresh airborne fix. Other ground providers retain their
60-second window; airborne candidates retain their 45-second window. Fresh
identity-compatible FR24 surface positions remain preferred.

## Evidence

- Original repro: FR24 ground age 50 seconds, ADS-B airborne age 1 second,
  matching registration/hex. Before: chosen FR24. After: chosen ADS-B.
- Boundary regression: FR24 ages 29 and 30 remain eligible; ages 30.01, 40,
  45, 50, and 60 lose to fresh airborne data in either input order.
- With no usable airborne fix, stale FR24 ground cannot be resurrected. Wrong
  identity and stale airborne candidates remain rejected; alternate ground
  providers retain their existing freshness rules.
- The actual `applyFr24GroundExperiment`, `preserveDepartureProgress`, and
  `preferFreshAirborneState` functions are exercised together. With saved Taxi
  progress and a fresh airborne position at 3,000 feet/180 kt, the fixed result
  is `ride` (In flight), `times.airborne=true`, chosen ADS-B. The counterfactual
  old stale-ground selection remains `taxi`, `times.airborne=false`.
- This is an intended stage effect from corrected position selection. Stage
  thresholds and progression rules are unchanged. The regression throws on
  any fetch, proving this path makes no provider calls.
- `npm run check`: 579 tests, 577 passed, 0 failed, 0 skipped, 2 TODOs; typecheck
  0 errors. Build passes. Original #24 TODO is re-enabled; #6 and #7 remain TODO.

No polling, shared-cache, cruise-polling, schedule parsing, or unknown-airport
support changes. Leave Preview-first and unmerged.
