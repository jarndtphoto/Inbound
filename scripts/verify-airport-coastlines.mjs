import { loadAirportSurface } from "../src/lib/airport-surface.server.ts";
import { airportGeographyIsWater, airportGeographyWaterFraction } from "../src/lib/airport-coastline.ts";
import { toJSONAsync, fromCrossJSON } from "seroval";
import { createDefaultSerovalPlugins } from "@tanstack/router-core/ssr/client";
import { writeFile } from "node:fs/promises";

const preview = process.env.AIRPORT_COASTLINE_PREVIEW_URL;
const functionId = process.env.AIRPORT_COASTLINE_SERVER_FN_ID;
if (preview && !functionId) throw new Error("Preview verification requires AIRPORT_COASTLINE_SERVER_FN_ID from its build manifest");
async function loadSurface(input) {
  if (!preview) return loadAirportSurface(input);
  const response = await fetch(`${preview}/_serverFn/${functionId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", "x-tsr-serverFn": "true", Origin: preview },
    body: JSON.stringify(await toJSONAsync({ data: input })),
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`Preview surface request failed (${response.status})`);
  const payload = fromCrossJSON(await response.json(), { plugins: createDefaultSerovalPlugins() });
  if (payload.error) throw payload.error;
  return payload.result;
}

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
const surfaces = {};
for (const [airport, lat, lon, expectation] of airports) {
  const started = Date.now();
  try {
    const surface = await loadSurface({ airport, lat, lon });
    surfaces[airport] = surface;
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
      airportInWater: geography ? airportGeographyIsWater(geography, { lat, lon }) : null,
      waterFraction: geography ? airportGeographyWaterFraction(geography) : null,
      verification: geography?.fallback ? "fallback-only" : "detailed",
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
if (process.env.AIRPORT_COASTLINE_CAPTURE_PATH) {
  await writeFile(process.env.AIRPORT_COASTLINE_CAPTURE_PATH, JSON.stringify({ preview: preview ?? null, results, surfaces }));
}

const hardFailures = results.filter((row) => row.error);
for (const row of results) {
  // The 60-mile DEN view contains real reservoirs. Verify the airport stays
  // dry instead of requiring its entire surrounding region to have no water.
  if (!row.fallback && (row.airportInWater || row.waterFraction > 0.95)) {
    hardFailures.push({ airport: row.airport, error: "detailed water safety check failed" });
  }
}
if (hardFailures.length) process.exitCode = 1;
