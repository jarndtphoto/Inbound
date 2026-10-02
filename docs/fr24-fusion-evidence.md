# Stale FR24 surface fusion follow-up

Base: main after cleanup #32 and public-time parsing #34 merged (`97bc36c`).
This PR changes only #24 and its regressions; the public-time fix is inherited
from main. ZRH/unknown-airport route support remains on hold.

FR24 ground positions now expire at 30 seconds, matching the existing story
wrapper. The previous fusion window retained ground fixes up to 60 seconds,
preferred FR24 through 45 seconds, and could restrict scoring to a stale ground
fix instead of a fresh airborne fix. Other ground providers retain their
60-second window; airborne candidates retain their 45-second window. Fresh
identity-compatible FR24 surface positions remain preferred unless an
identity-compatible airborne fix is more than 10 seconds newer and is above
500 feet AGL or above 80 kt. Airport elevation is taken from the nearer origin
or destination, rather than treating MSL altitude as AGL.

That guard also bypasses ground-only scoring and excludes the superseded FR24
surface position from scoring (retaining it in diagnostics). The story wrapper
uses the same guard, so it cannot overwrite the chosen airborne fix again.

## Evidence

- Original repro: FR24 ground age 50 seconds, ADS-B airborne age 1 second,
  matching registration/hex. Before: chosen FR24. After: chosen ADS-B.
- Review reproduction before the change: a 25-second FR24 ground fix still
  beat a 1-second airborne fix; both the fusion and stage regressions failed.
- FR24 ages 25 and 29 now lose to matching airborne data aged 1 second in both
  input orders. FR24 ground age 3 seconds versus airborne age 1 second still
  chooses ground. An exactly 10-second advantage does not override ground.
- FR24 ages 29 and 30 remain eligible when no qualifying newer airborne fix
  exists; ages 30.01, 40, 45, 50, and 60 remain expired.
- A high-elevation airport regression distinguishes MSL from AGL and covers
  each altitude/speed trigger, wrong identities (including no saved identity
  lock), and a second ground provider that must not restore stale FR24.
- With no usable airborne fix, stale FR24 ground cannot be resurrected. Wrong
  identity and stale airborne candidates remain rejected; alternate ground
  providers retain their existing freshness rules.
- The actual `applyFr24GroundExperiment`, `preserveDepartureProgress`, and
  `preferFreshAirborneState` functions are exercised together. With saved Taxi
  progress and a fresh airborne position at 3,000 feet/180 kt, FR24 ground ages
  25, 29 and 50 produce `ride` (In flight), `times.airborne=true`, chosen ADS-B.
  A ground age of 3 still produces `taxi`, `times.airborne=false`, chosen FR24.
  The counterfactual old ground selection remains `taxi`, `airborne=false`.
- This is an intended stage effect from corrected position selection. Stage
  thresholds and progression rules are unchanged. The regression throws on
  any fetch, proving this path makes no provider calls.
- `npm run check` after retargeting: 586 tests, 585 passed, 0 failed, 0 skipped,
  1 TODO; typecheck 0 errors. #24 is re-enabled; only #6 remains TODO, because
  #7 is already fixed on main.
  `npm run build` also passes.

No polling, shared-cache, cruise-polling, schedule parsing, or unknown-airport
support changes. Leave Preview-first and unmerged.
