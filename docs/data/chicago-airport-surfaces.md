# ORD / MDW durable surface snapshots

`src/lib/data/chicago-airport-surfaces.json` contains only KORD and KMDW. This targeted outage fallback is independent of the held general airport/coastline pack. No aircraft positions or inferred geometry are included.

Source: © OpenStreetMap contributors, [ODbL 1.0 attribution/license](https://www.openstreetmap.org/copyright). Retrieved 2026-10-07 from https://overpass-api.de/api/interpreter, sequentially, one request per airport. The complete exact-airport query, capture timestamp, OSM database timestamp, raw-response SHA-256, parsed-surface SHA-256, source element count and parsed feature count are embedded in the pack.

The existing `exactAirportSurfaceOverpassQuery` was used, with only the offline query timeout increased from 7 to 25 seconds (40-second HTTP deadline). The existing `parseAirportSurfaceElements` preserved target aerodrome boundaries and full runway/taxiway/terminal coordinates. No simplification, invented geometry, hand-edited coordinates, or unrelated-airport reuse was applied. OSM tagging is preserved: MDW's 10 runway-tagged features include threshold/overrun geometry, not 10 distinct operational runways.

- KORD: 1,436 features; 8 runway features, 782 taxiways, 223 taxilanes, 42 aprons, 19 terminals, 362 parking positions; 12 boundary rings.
- KMDW: 304 features; 10 runway-tagged features, 191 taxiways, 25 taxilanes, 15 aprons, 7 terminals, 56 parking positions; 20 boundary rings.

The server imports this versioned data into its build and returns it before any provider calls. It does not require writable deployment storage, browser caches, Overpass availability, or live FAA discovery. Other airports keep the existing retrieval behavior. `checkedAt` remains the capture time; this is static map data, never a fresh aircraft-position claim. Refresh by explicitly capturing a new bounded public response, passing it through the same query/parser, updating provenance/hashes, and revalidating the pack. No periodic network refresh is enabled.

Validation: `src/lib/airport-surface-snapshot.server.test.ts` checks exact feature counts, hashes, bounds, identity isolation, aliases, finite geometry, provenance, and cold requests with every network provider disabled. Runtime coordinate guards prevent ORD geometry being returned for MDW coordinates or the reverse. UI attribution links accompany rendered OSM surfaces.
