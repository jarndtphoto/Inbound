# UA1532 and AA3008 audit — September 12, 2026

This is a bounded audit of the flight-story data path, not certification of live surface-position accuracy.

| Flight | Observation | Corrected behavior |
| --- | --- | --- |
| UA1532, ORD–MSY | At 16:52 UTC the app showed a synthetic live position near Chicago, airborne=true and measured taxi-out. FlightAware supplied gate-out 16:43 UTC, an airborne status, no position fix, and estimated takeoff 17:03 UTC with no actual takeoff. | At 16:56 UTC the updated app retained actual gate-out, showed the push stage, airborne=false, live=false, and estimated/posted taxi duration. |
| AA3008, ORD–LAX | At 16:52 UTC no actual departure or live fix was supplied. On the later query, FlightAware supplied actual gate-out 16:56 UTC. | At 16:58 UTC the updated app registered the 11:56 AM CDT pushback, kept takeoff unconfirmed, and supplied no invented live position. |
| Pilot weather reports | The unbounded PIREP endpoint returned HTTP 400: bounding box or station/radius required. | A route-bounded ORD–LAX request returned HTTP 200. Requests now use route bounds and a two-minute cache, including a dateline split. |

Sources queried:
- [FlightAware UA1532](https://www.flightaware.com/live/flight/UAL1532)
- [FlightAware AA3008](https://www.flightaware.com/live/flight/AAL3008)
- [Flightradar24 UA1532](https://www.flightradar24.com/data/flights/ua1532): listed ORD–MSY and later MSY–IAH as distinct legs on September 12. The app selected ORD–MSY for this audit.
- [Flightradar24 AA3008](https://www.flightradar24.com/data/flights/aa3008): listed ORD–LAX, but its search snapshot was older; it did not independently confirm current surface movement.
- [Aviation Weather Center API](https://aviationweather.gov/data/api/)

The sanitized operational fixtures in `scripts/fixtures` replay the earlier provider records with a fixed clock. Two integration tests verify both flights' routes, the lack of synthetic fixes, pushback semantics, unmeasured taxi estimates, and bounded weather queries. Another 32 focused fusion, weather, and FlightAware tests pass. `npm run build` and `npm run typecheck` pass.

The dev server starts using an environment-only fallback for unavailable network-interface enumeration. Browser render verification remains blocked: Chromium is absent and its download timed out. The broader npm test suite previously failed in platform/PWA metadata tests; npm ci also reported a pre-existing lockfile mismatch. No dependency or runtime workaround was committed.

Remaining limits: all three ADS-B providers timed out in this environment; exact live coordinates and pushback/taxi detection latency are unverified. Some first loads exceed the story's 12-second deadline and recover on retry. Full route/altitude/time validity of the weather briefing needs further review. The PR must remain draft until browser and live-telemetry validation are complete.
