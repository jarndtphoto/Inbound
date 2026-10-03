# Part 3B.1.5 — Production provider review and access plan

Review date: **October 3, 2026, America/Chicago**.

Repository: `jarndtphoto/Inbound`; approved source branch:
`plugin-v1-nearby-acquisition`; approved Part 3B.1 commit:
`d49d5ee0be3f63fe5bdd56e4d1badd8a5b693498`.

**Production provider access remains an activation gate.** This review establishes
the access plan; it does not claim permission has been obtained. Only current
official provider documentation and the official license text linked by ADSB.lol
support the findings below. No aircraft-data API calls or provider contact were
made for this review. No provider adapter, public endpoint, fixture MCP, or Radar
Dev changes are included.

## Official sources

- [adsb.fi official open-data README](https://github.com/adsbfi/opendata/blob/main/README.md)
  — public endpoints, geographic endpoint deprecation, limits and data terms.
- [ADSB.lol official API page](https://www.adsb.lol/docs/open-data/api/)
  — API availability and ODbL data license.
- [ADSB.lol current live OpenAPI document](https://api.adsb.lol/api/openapi.json)
  — explicit public-data licensing, production-contact request and documented
  geographic endpoints. This is a documentation request, not a live aircraft
  query.
- [ADSB.lol official API repository](https://github.com/adsblol/api)
  — current dynamic, load-dependent limit statement and future API-key policy.
- [Official ODbL 1.0 text](https://opendatacommons.org/licenses/odbl/1-0/)
  — the license expressly identified by ADSB.lol for its public data.
- [Airplanes.live current API documentation](https://airplanes.live/api-docs/)
  — current API base and documented v2 point operation, also checked in the
  rendered official documentation; its overview shows
  an Apache software/specification license, without clear aircraft-data terms.
- [Airplanes.live current terms URL](https://airplanes.live/terms-of-use/)
  — only heading/navigation were readable through retrieval, so its substantive
  data-use terms could not be verified.
- [Airplanes.live verified official GitHub organization](https://github.com/airplanes-live)
  — publishes `contact@airplanes.live`.
- [Airplanes.live archived official API repository](https://github.com/airplanes-live/api-archive)
  — archived April 29, 2026. It describes ADSB One at `api.adsb.one`; its old
  one-request/second limit is **not current proof** of Airplanes.live's quota.

## Production-use matrix

| Question | adsb.fi | ADSB.lol | Airplanes.live |
| --- | --- | --- | --- |
| Commercial/public plugin use clearly allowed? | **No:** public terms restrict use to personal/noncommercial purposes; obtain commercial permission. | **Conditional commercial data reuse allowed under ODbL.** Specific production API access still needs confirmation. | **Unverified:** the API specification's Apache license does not grant aircraft-data redistribution rights. |
| Production contact | Requested for commercial use/higher rates. | Live documentation asks production users to contact the maintainer for stability. This project treats confirmation as an activation requirement; it is not a blanket commercial-data ban. | No readable mandatory-contact clause verified. Clarification is necessary before activation. |
| Attribution | Cite adsb.fi and link its homepage. | Public output needs ADSB.lol/database and ODbL notices; preserve relevant notices on database redistribution. Confirm placement. | Current requirement unverified. |
| Current rate limit/quota | Public: **1 request/second**. Feeder: once/30 seconds. Daily cap unspecified; invalid requests count. | **Dynamic based on environment load.** No numeric guaranteed allowance or daily quota found. Future feeder-obtained API keys are announced. | **No current numeric quota verified** from accessible official documentation. |
| Redistribution restrictions | No licensing, sale, rental or leasing under public terms; seek display permission. | ODbL conditions apply. Public derivative databases can trigger share-alike and machine-readable access obligations; normalized snapshots and systematic extraction need clarification. | Current display, normalization, caching and redistribution rights unverified. |
| Geographic endpoint currently used by Inbound | `https://opendata.adsb.fi/api/v2/lat/{lat}/lon/{lon}/dist/{dist}` | `https://api.adsb.lol/v2/lat/{lat}/lon/{lon}/dist/{dist}` | `https://api.airplanes.live/v2/point/{lat}/{lon}/{dist}` |
| Endpoint recommended for new integrations | `https://opendata.adsb.fi/api/v3/lat/{lat}/lon/{lon}/dist/{dist}`; geographic v2 remains compatible but deprecated. | Current live OpenAPI documents v2 geographic and point paths. No newer version recommendation found. | Current rendered documentation confirms `https://api.airplanes.live/v2/point/{lat}/{lon}/{radius}`, maximum 250 NM. No newer version recommendation found; production access/key policy still needs clarification. |
| Proposed 20-second shared cadence acceptable based only on published limits? | **0.05/second fits** the geographic rate; licensing and aggregate-call headroom remain unresolved. | **Cannot certify a numeric budget** from published dynamic limits. Ask for approval of approximately 3 requests/minute while active. | **Cannot certify** without a current quota and access agreement. |
| Unresolved questions | Commercial normalized ChatGPT display/redistribution; serverless access; aggregate limits; pricing; v3 details. | Production stability and numeric budget; key policy; normalized database obligations and notice placement; compatible feed mixing; any pricing. | Public/free API availability; keys/feeder eligibility with serverless egress; daily/burst limits; commercial display/redistribution; attribution; pricing; endpoint policy. |

The current Inbound paths above were read from `src/lib/adsb-fusion.ts` at the
approved source. **No adapter was changed.** Any future adsb.fi v3 upgrade or
provider selection is a separately approved implementation step.

ADSB.lol's commercial-data finding comes from its explicit **data** licensing and
ODbL section 3.1, which includes commercial reuse/display. It does not come from
the API repository's BSD software license. ODbL sections 4.2–4.6 cover notices,
public derivative-database sharing and access. Whether Inbound's normalized,
short-lived collection is a derivative database, and what public outputs trigger
those conditions, remains a concrete question for production planning. An
ephemeral cache alone does not establish an exemption. Do not mix another feed
into an ODbL-derived collection until the grants and required treatment are
compatible.

Airplanes.live evidence limits are material: the terms page returned no substantive
terms through retrieval or in the rendered official page. The current rendered
API overview, point endpoint documentation and FAQ gave no numeric quota or
commercial aircraft-data grant. No live request was sent from the documentation.
The old official `/api-guide/` and field-description URLs
returned 404; `payapi.airplanes.live` retrieval failed. Third-party mentions of
500/day and 8,640/day were **excluded** as evidence of a current official quota.
No old limit, software license, successful access, or broad community mission is
treated as production permission.

## Cadence and provider configuration

The engineering calculation for one collection is **0.05 requests/second,
3/minute, 180/active hour**, with an ideal upper bound of **4,320 requests per
provider for 24 continuously active hours**. These are bounds, not predicted
traffic or a promise to providers. Actual active hours and user numbers are
unknown. The approved service's minimum cadence starts at successful publication,
so upstream latency reduces practical frequency. Many viewers reuse the same
snapshot instead of causing one query each.

Recommend **one approved primary provider**, then **one separately approved
standby backup** if observed coverage or outages justify it. ADSB.lol is the
strongest initial rights candidate because its published data license expressly
includes commercial use. Production access, numeric budget and normalized
snapshot/attribution obligations must be settled before choosing it for
activation.

The backup should be whichever of adsb.fi or Airplanes.live offers compatible
written rights and acceptable quota/cost. Query it on primary failure or
inadequate freshness under its own approved budget. Preserve source attribution
and freshness and use bounded last-safe behavior during outages. Default
simultaneous polling of three feeds is unnecessary until evidence demonstrates
a coverage benefit.

Multiple simultaneous feeds would be a later decision requiring compatible
rights, a measurable reliability improvement and understood cost. Existing
single-flight traffic must also be included when establishing each provider's
overall quota. **FlightAware remains excluded. No paid subscription or new paid
provider is introduced in Part 3B.1.5.**

Before production activation, obtain a written provider response or authoritative
published terms covering the public ChatGPT display, eventual monetization,
normalized snapshots, attribution, redistribution, API budget, endpoint and any
pricing. Record those terms and implement the approved provider selection in a
later authorized stage. This review does not start route enrichment or Part
3B.2.

## Unsent outreach drafts

These are reviewable text drafts only. **None was sent or created in a mail
account.** No recipient address was guessed for adsb.fi or ADSB.lol.

### adsb.fi

**Subject:** Production permission for Inbound's shared Chicago aircraft display

Hello adsb.fi team,

I'm developing Inbound, a flight-tracking application, with an optional ChatGPT
interface called Inbound Live.

We propose one shared Chicago geographic collection queried approximately every
20 seconds only while active. Many users would reuse that snapshot. We would
normalize the data and display nearby aircraft; we may eventually monetize the
product.

Your open-data terms restrict use to personal, noncommercial purposes. Could you
provide explicit permission and terms for this production use? Please clarify
required attribution, normalized-data display and redistribution rights, API
limits and pricing. We also understand new geographic integrations should use
v3.

We cannot yet predict user numbers or total active hours, so we are not committing
to a traffic volume.

Thank you,
Jon Arndt

### ADSB.lol

**Subject:** Inbound Live production API use and ODbL clarification

Hello ADSB.lol team,

I'm developing Inbound, a flight-tracking application, with an optional ChatGPT
interface called Inbound Live.

We propose one shared Chicago geographic collection queried approximately every
20 seconds only while active. Many users would reuse that snapshot. We would
normalize the data and display nearby aircraft; we may eventually monetize the
product.

Your documentation asks production users to contact you. Could you confirm
permission and terms for this use, including required attribution,
redistribution, API limits or keys, and any pricing? Please also clarify the ODbL
obligations for our normalized shared snapshot and its public display.

We cannot yet predict user numbers or total active hours, so we are not committing
to a traffic volume.

Thank you,
Jon Arndt

### Airplanes.live

**To:** contact@airplanes.live
**Subject:** Inbound Live production access and aircraft-data terms

Hello Airplanes.live team,

I'm developing Inbound, a flight-tracking application, with an optional ChatGPT
interface called Inbound Live.

We propose one shared Chicago geographic collection queried approximately every
20 seconds only while active. Many users would reuse that snapshot. We would
normalize the data and display nearby aircraft; we may eventually monetize the
product.

Could you provide explicit permission and terms for production use? Please
clarify attribution, normalized-data display and redistribution rights, current
API limits, keys or feeder requirements, server-hosted access, and pricing.

We cannot yet predict user numbers or total active hours, so we are not committing
to a traffic volume.

Thank you,
Jon Arndt
