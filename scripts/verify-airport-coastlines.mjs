import { loadAirportSurface } from "../src/lib/airport-surface.server.ts";

const airports = [
  ["KSAN", 32.7338, -117.1933, "bay"],
  ["KBOS", 42.3656, -71.0096, "coast"],
  ["KLGA", 40.7769, -73.8740, "coast"],
  ["KSFO", 37.6213, -122.3790, "bay"],
  ["KMIA", 25.7959, -80.2870, "coast"],
  ["KORD", 41.9742, -87.9073, "lake-michigan"],
  ["KMCO", 28.4312, -81.3081, "inland-lakes"],
  ["KDEN", 39.8561, -104.6737, "no-water"],
];

const results = [];
for (const [airport, lat, lon, expectation] of airports) {
  const started = Date.now();
  try {
    const surface = await loadAirportSurface({ airport, lat, lon });
    const geography = surface.geography;
    results.push({
      airport,
      expectation,
      durationMs: Date.now() - started,
      source: surface.source,
      featureCount: surface.features.length,
      boundaryRings: surface.boundary?.length ?? 0,
      base: geography?.base ?? null,
      landRings: geography?.land.length ?? 0,
      waterPolygons: geography?.water.length ?? 0,
      fallback: geography?.fallback ?? true,
      fallbackReason: geography?.fallbackReason ?? (geography ? null : "missing-geography"),
    });
  } catch (error) {
    results.push({
      airport,
      expectation,
      durationMs: Date.now() - started,
      error: error instanceof Error ? error.message : String(error),
      fallback: true,
      fallbackReason: "surface-load-failed",
    });
  }
}

console.log("AIRPORT_COASTLINE_VERIFY=" + JSON.stringify(results));

const byAirport = new Map(results.map((row) => [row.airport, row]));
const hardFailures = results.filter((row) => row.error);
const den = byAirport.get("KDEN");
if (den && !den.fallback && den.waterPolygons !== 0) {
  hardFailures.push({ airport: "KDEN", error: "expected no detailed water" });
}
if (hardFailures.length) process.exitCode = 1;
