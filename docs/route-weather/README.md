# Route weather consistency

Baseline captures were made on 2026-10-02 before changing rendering. The JSON files contain every `frac`, `chop`, `convective`, and `cloud` sample, current visible events, and reconstructed full-route events from unchanged main's event builder.

| Flight | Observed samples | Full-route reconstruction |
| --- | --- | --- |
| AA5012 ORD–LEX | 5 moderate, 5 smooth, 1 cloud-only | Moderate begins at frac 0.187677; cloud-only at 0.830488. The old line is teal for the cloud-only event, although the event builder numbers it. |
| AA3959 ORD–MEM | 75 moderate, 32 light, 87 smooth | Moderate begins at 0.102059, smooth resumes at 0.469829, light begins at 0.677285, smooth resumes at 0.828496. The old classifier makes both turbulence intensities red. The full-route reconstruction merges them, including the smooth gap, into one light–moderate event. |

At capture AA5012 had landed and AA3959 was already beyond both turbulence stretches. Neither had upcoming numbered events. The reconstruction explains structural mismatches; it cannot prove the exact earlier marker positions the user saw. Past samples have clamped ETA, which can merge an artificially large gap when reconstructing all historical samples. Current main had also already gained entry-marker and continuous-intensity grouping fixes in PR25; this revision preserves those improvements.

## Rendering choices

- Line strokes and events are built from the same `routeWeatherSegments` output. An edge inherits the condition at its entry sample. Every marker uses the first coordinate of its segment. Shared exit coordinates keep geometry and alert duration consistent.
- Smooth gaps split events, including gaps of five minutes or less. Continuous light then moderate remains one numbered event, with yellow then red strokes.
- Only turbulence gets numbers. Storms and clouds use labeled lightning/cloud icons and their own atmosphere color. Their route can remain smooth colored because the icon explains the separate condition.
- Light and explicit light-to-moderate samples use yellow; moderate, moderate-to-severe and severe use red. Dedicated tokens keep these separate from flight-category colors. Existing normalized providers currently emit four chop levels; retained explicit range wording in sample notes is honored for presentation, without changing providers.
- Mixed event intensity labels use each intensity's color. Explicit light-to-moderate range labels stay yellow. The background-colored route outline is widened to maintain separation from radar.
- Existing flown-track dimming remains; numbers cover upcoming weather only.

## Verification

Seven unit tests cover bands, mixed events, short-gap splitting, storm/cloud numbering, exact marker/segment coordinates, explicit range labels and theme contrast. Full regression and typecheck comparisons retain existing main failures. Preview uses live provider data. Mobile screenshots replay an unmodified real AA28 LAX–JFK predeparture forecast captured from Preview on 2026-10-02; no mock values or fixtures are bundled into the app.

No flight stage, ETA, polling, caching or provider code is modified. Temporary capture logging is removed from the final build.
