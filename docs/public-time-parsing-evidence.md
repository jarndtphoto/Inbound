# Shared-date public actual-time parsing follow-up

Base: cleanup PR #32 (`7beeeb3`). This PR changes only held #7 and its
regressions. It does not include the FR24 fusion fix.

The public FlightStats parser associates each time label with the closest
preceding explicit date in its departure or arrival section. One date can now
serve Scheduled, Estimated and Actual labels. A later explicit date starts a
new context, including midnight/month rollover. No date is inferred from the
requested service date, another section, or a later date.

## Evidence

- Original AA536 fixture: `01-Oct-2026 Scheduled 17:38 CDT Actual 17:31 CDT`.
  Before: actual gate time null. After: `1790893860` (22:31 UTC), the reported
  actual value. Scheduled and actual remain separate fields.
- Added regressions cover all three labels sharing a date, distinct departure
  and arrival dates, explicit midnight/month rollover, absent preceding dates,
  invalid clocks, and unknown timezone abbreviations.
- `npm run check`: 580 tests, 578 passed, 0 failed, 0 skipped, 2 TODOs; typecheck
  0 errors. Original #7 TODO is re-enabled; #6 and #24 remain TODO.

This can expose previously omitted provider-reported actual event times to the
existing story logic. It does not turn estimates into actuals, infer missing
dates, alter stage rules, or add provider requests. No polling, shared-cache,
cruise-polling, fusion, or unknown-airport support changes. Leave Preview-first
and unmerged.
