# Part 3B.2 — possible future route sources

Reviewed October 3, 2026, America/Chicago (October 4 UTC), using public official documentation only. Starting source: `d6ef464a4d5c80fe70aa8191e3d1d664e759ac5b`.

**No reviewed source is approved here for enriching the shared ADS-B Nearby collection.** Part 3B.2 uses invented route results through a private provider-independent interface. No aviation-data endpoint was requested, credentials obtained, provider contacted, live implementation added, or existing provider behavior changed.

## Current source inventory

This inventory comes from a read-only inspection of the certified commit, not from network calls or credential inspection.

| Existing Inbound source | Current code and access path | Treatment in Part 3B.2 |
|---|---|---|
| ADSBDB callsign routes | `story.server.ts` `loadRoute`; `https://api.adsbdb.com/v0/callsign/{callsign}`; existing 30-minute process cache | Do not import or call this helper for Nearby |
| FR24 API | `fr24.server.ts`; `/api/live/flight-positions/full`; optional `/api/flight-summary/full` and `/api/flight-tracks` | Do not use FR24 to enrich independent ADS-B Nearby observations |
| FlightStats public schedules | `story.server.ts` `loadFlightStatsPublic`; `/v2/flight-tracker/{carrier}/{number}?year=…&month=…&date=…`; existing 60-second cache | Do not reuse the HTML-fetching path for Nearby |
| FlightAware API/public pages | Existing official-flight/story helpers contain these paths | Explicitly excluded; no review or integration proposed |

The presence of a helper or an existing cache in the application does not establish permission for a new shared public plugin use.

## ADSBDB

| Question | Published position / unresolved detail |
|---|---|
| Public/commercial route display | **Explicit permission required.** The official site and repository identify David Taylor and Jim Mason as the route-data creators and prohibit copying, publishing, or database incorporation without David J Taylor's explicit permission. [A1][A2] |
| Combine with ADS-B positions | No affirmative mixing right found. Persisting/displaying route hints would engage the stated data restrictions; permission must cover this use. |
| Attribution | Credit is shown on the official pages, but no independent attribution-only reuse grant or prescribed production display wording was found. Permission must specify attribution. |
| Limits | Rolling 60-second window: **512+ requests → 60-second block; 1024+ → 300-second block**. These thresholds are not an availability commitment. [A1] |
| Cache/redistribution | Explicit permission gate applies; no general cache-duration exception found. |
| Pricing/access | Public API documented; no production price, service guarantee, or commercial route-data grant found. Ask the operator/rightsholder before activation. |

The repository documents a versioned callsign endpoint and origin/destination response, without a dated occurrence binding. Such a response can support only a **hint**, never automatic confirmation. Its MIT **software** license does not license the route dataset. [A2]

## FR24 API

FR24's terms, updated June 23, 2026, permit commercial API use and derivative works subject to restrictions. They prohibit raw-data redistribution, transferring enriched datasets containing raw FR24 data, obscuring data origins, competing products, and removing proprietary notices. Crucially, clause **6.3.1.1.3 prohibits supplementing or backfilling other providers' near-time or real-time flight data**, for commercial or noncommercial use. Clause 6.3.2's value-added permission does not remove that prohibition. [F1]

**Inference for Inbound:** adding FR24 route fields to independent ADS-B Nearby positions falls within the mixing concern; public terms do not authorize this configuration. Obtain a separate express written agreement before proposing it for production. Confirm also that ChatGPT tool DTO delivery, public aircraft cards, shared snapshots, and the product's competitive scope are licensed. [F1]

No universal public attribution format was found in the reviewed pages. Preserve existing source/proprietary notices and obtain approved wording; a sanitized DTO is not evidence of redistribution permission. [F1]

| Item | Official API documentation |
|---|---|
| Explorer | **$9/month**, **30,000 credits**, **10 queries/minute** |
| Essential | **$90/month**, **333,000 credits**, **30 queries/minute** |
| Advanced | **$900/month**, **4,050,000 credits**, **90 queries/minute** |
| Relevant credit costs | Per returned live flight: live positions full **8**, flight summary full **2**, summary light **1**; an empty response still costs **1** credit |
| Cache | Accumulated API data must be permanently deleted within **30 days of first receipt**, across all endpoints |
| Access | Dedicated paid API subscription; website/app subscriptions do not confer API access |

These published figures come from [F2][F3][F4]. A query-per-minute limit and per-result credit cost are different constraints. A small route lookup budget may fit throttling yet still consume significant credits; no future volume or spend is promised.

FR24 documents `/flight-summary/light` and `/flight-summary/full`, with flight-leg identifiers, date-range filters, and route information. The full variant includes IATA airports. These are technical possibilities only, pending permission. FR24 currently says its API does **not** supply scheduled departure information; live means currently tracked. [F5][F6]

## Existing FlightStats public schedule path / Cirium

FlightStats' official scraping-policy page expressly forbids scraping and points users toward licensed APIs. Its public Trip Center terms restrict use to personal, internal, noncommercial purposes and prohibit republishing/distribution. That Trip Center document is not claimed to be a complete contract for the separate `/v2/flight-tracker` path; the official scraping restriction is independently sufficient to reject reusing Inbound's HTML-fetching path for this stage. No public-display grant, cache allowance, or authorized automated quota for that path was found. [C1][C2]

The published **paid FlightStats API** agreement permits third-party presentation but prohibits reuse of one query across multiple devices, limits caching to **three days**, requires written permission to combine real-time data with another real-time provider, and prohibits removal of proprietary notices. Public Cirium-data pages require a linked **Powered by Cirium** or similar logo. **Inference:** the default paid agreement does not authorize our shared snapshot architecture; a specifically negotiated contract is needed. [C3]

The evaluation agreement forbids caching and redistributing a single query to multiple devices; it is not a production workaround. [C4]

Official getting-started material says the legacy platform is being replaced by Cirium Sky. The schedule documentation distinguishes by-flight access from premium by-airport/by-route access. Commercial use is usage-based; custom needs require a contract. Current numeric production pricing and applicable route-lookup throttles were not publicly verifiable here: the legacy pricing page requires sign-in. Do not borrow an unrelated feed endpoint's limits. [C5][C6][C7]

## Decision before production activation

Keep the Part 3B.2 provider interface fake-only. Before enabling one real route source, obtain terms that explicitly cover shared caching, many viewers reusing one result, combining with an approved ADS-B position feed, public ChatGPT cards/tool delivery, potential monetization, attribution, retention/deletion, quotas, and prices. No new paid provider or provider outreach is proposed in this stage.

Existing validated, current, dated route evidence may be passed through the small private adapter without triggering network work, subject to the original evidence source's rights. Generic callsign route hints remain unconfirmed, regardless of proximity or heading.

## Official references

- **A1:** [ADSBDB official site — route notice and rate limits](https://www.adsbdb.com/)
- **A2:** [ADSBDB operator's repository — route notice, callsign response, software license](https://github.com/mrjackwills/adsbdb)
- **F1:** [FR24 Terms of Service — sections 2 and 6.3](https://www.flightradar24.com/terms-of-service)
- **F2:** [FR24 Credit Overview](https://fr24api.flightradar24.com/docs/credit-overview)
- **F3:** [FR24 Storage Rules](https://fr24api.flightradar24.com/docs/storage-rules)
- **F4:** [FR24 Getting Started](https://fr24api.flightradar24.com/docs/getting-started)
- **F5:** [FR24 Flight Summary documentation](https://fr24api.flightradar24.com/docs/endpoints/flight-summary)
- **F6:** [FR24 FAQ — schedules and API product boundaries](https://fr24api.flightradar24.com/docs/faq)
- **C1:** [FlightStats official Scraping Policy](https://static.flightstats.com/termsofuseviolation.html)
- **C2:** [FlightStats Trip Center Terms of Use](https://trip.flightstats.com/page/terms)
- **C3:** [Cirium/FlightStats Terms for Paid Accounts](https://developer.flightstats.com/about/terms_for_paid_accounts)
- **C4:** [Cirium/FlightStats Evaluation Agreement](https://developer.flightstats.com/signup)
- **C5:** [FlightStats Getting Started — legacy platform notice and plans](https://developer.flightstats.com/getting-started)
- **C6:** [Cirium Developer Studio — Schedules](https://developer.studios.cirium.io/apis/flightstats-apis/schedules)
- **C7:** [FlightStats Pricing — authenticated page](https://developer.flightstats.com/getting-started/pricing)
