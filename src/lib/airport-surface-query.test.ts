import { test } from "node:test";
import assert from "node:assert/strict";
import { airportSurfaceQueryOptions } from "./airport-surface-query.ts";

test("shared airport surface query does not repeat the full provider fallback chain", () => {
  const options = airportSurfaceQueryOptions({ icao: "KSAN", lat: 32.7338, lon: -117.1933 });
  assert.equal(options.retry, false);
  assert.equal(options.retryOnMount, false);
  assert.equal(options.queryKey[0], "airport-surface-v7");
  assert.equal(options.queryKey[1], "KSAN");
});

test("Chicago queries cannot reuse pre-snapshot React Query entries", () => {
  for (const icao of ["KORD", "ORD", "KMDW", "MDW"]) {
    const options = airportSurfaceQueryOptions({ icao, lat: 41.9, lon: -87.9 });
    assert.equal(options.queryKey[0], "airport-surface-chicago-2026-10-07-v1");
  }
});
