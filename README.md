# Inbound

## Flight-data providers

Inbound keeps open ADS-B fusion as its no-credential fallback and can add official providers server-side:

- `FLIGHTAWARE_AEROAPI_KEY`: AeroAPI flight instance, operational times, gates, filed route, and track.
- `FR24_API_TOKEN`: FR24 live position and aircraft identity.
- `FR24_ENABLE_TRACKS=1`: opt in to the additional paid FR24 track request.
- `FR24_ENABLE_SUMMARY=1`: opt in to the additional paid FR24 full-summary request (takeoff, landing, and runway fields).

Provider secrets must be configured in Vercel and must never use a `VITE_` prefix. Live responses are held only in short in-memory caches. FR24 data is not persisted; if persistence is added later, its raw API data must be deleted within the provider's 30-day limit.

Flight information app — inbound aircraft, delays, taxi, ride, arrival, and the gate.

Built with Grok. Track a flight number (AA 1, UA 2401, WN 2711).
