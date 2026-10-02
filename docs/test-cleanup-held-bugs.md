# App behavior bugs held outside the test cleanup

These regressions retain their executable assertions with explicit `todo`
reasons. They count separately from passing tests. No test was deleted.

## 6: ZRH / unknown-airport public route support

`scripts/flight-audit-regression.test.mjs` — "loads an exact route from a
FlightStats-style public status page" returns null for ORD→ZRH because the
parser requires both airports in the local airport directory, which lacks ZRH.
Route support remains on hold. Changing its fixture to a supported airport
would hide this failure.

## 7: One date followed by multiple public time labels

`scripts/flight-audit-regression.test.mjs` — "parses public scheduled and
actual gate times when FlightStats exposes them" has one date followed by
Scheduled and Actual labels. `flightStatsTimeUnix` only accepts a date
immediately before each label, so Actual becomes null. A separate approved
Preview-first, unmerged follow-up will fix this. Cleanup does not change times.

## 24: Stale FR24 surface fusion

`src/lib/flight-data.test.ts` — "does not use a stale FR24 surface fix and
resumes normal fusion once airborne" supplies a 50-second-old FR24 ground fix
and a one-second-old ADS-B airborne fix. Fusion selects FR24: it retains ground
fixes up to 60 seconds, then restricts scoring to ground candidates even after
the 45-second FR24 preference expires. `applyFr24GroundExperiment` checks 30
seconds but does not remove an already-selected FR24 position.

A separate approved Preview-first, unmerged follow-up will ensure fresh airborne
positions win over stale FR24 surface fixes and report stage effects. Cleanup
does not change position selection, stages, polling, or provider calls.
