# Inbound

## Flight-data providers

Inbound uses FR24 as its primary live provider and keeps open ADS-B fusion as the no-credential fallback.

- `FR24_API_TOKEN`: primary live position and aircraft identity.
- `FR24_ENABLE_TRACKS=1`: opt in to the additional paid FR24 track request.
- `FR24_ENABLE_SUMMARY=1`: opt in to the additional paid FR24 full-summary request (takeoff, landing, and runway fields).
- Paid FlightAware AeroAPI calls are disabled by default, even if a key is present.
- `FLIGHTAWARE_PAID_API_ENABLED=1`: explicit opt in to paid FlightAware AeroAPI calls.
- `FLIGHTAWARE_AEROAPI_KEY` or `FLIGHTAWARE_API_KEY`: paid FlightAware credential, used only when the explicit opt-in flag is enabled.
- The existing public schedule fallback remains available for pre-departure flight identity/schedule data while paid FlightAware is off.

Provider secrets must be configured in Vercel and must never use a `VITE_` prefix. Free ADS-B requests use shared database leases, provider cooldowns, and a short-lived cache (five seconds fresh, at most 120 seconds usable). Cached responses preserve their original observation age; they are never relabeled as fresh on reread. Deployed builds require the configured database and migrations `0008_adsb_acquisition.sql` and `0009_adsb_dispatch_spacing.sql`; if coordination is unavailable, acquisition fails closed instead of multiplying provider requests across viewers. FR24 data is not stored in this shared cache.

Free API/trace requests in the same provider family share a dispatch lease, held through response completion, followed by at least a 1,250 ms gap. HTTP 429 cooldowns escalate from 60 to 120 to 300 seconds, retaining their streak through intermittent successful responses; 15 minutes without another 429 permits recovery. A longer `Retry-After` is always honored. HTTP 403 access backoff stays scoped to the denied service. These safeguards reduce request pressure; they cannot guarantee upstream coverage or account for unrelated traffic sharing an outbound IP.

Flight information app — inbound aircraft, delays, taxi, ride, arrival, and the gate.

Built with Grok. Track a flight number (AA 1, UA 2401, WN 2711).
