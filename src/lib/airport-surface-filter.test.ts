import assert from "node:assert/strict";
import { test } from "node:test";
import { filterAirportSurfaceFeatures } from "./airport-surface-filter.ts";
import type { SurfaceFeature } from "./airport-surface.server";

const line = (id: number, kind: SurfaceFeature["kind"], points: Array<[number, number]>): SurfaceFeature => ({
  id, kind, points: points.map(([lat, lon]) => ({ lat, lon })),
});

test("SAN surface filtering keeps SAN and rejects nearby North Island", () => {
  const san = { lat: 32.7338, lon: -117.1933 };
  const features: SurfaceFeature[] = [
    // SAN runway 09/27 and connected taxi/apron geometry.
    line(1, "runway", [[32.7334, -117.2160], [32.7338, -117.1680]]),
    line(2, "taxiway", [[32.7340, -117.2050], [32.7370, -117.1900]]),
    line(3, "apron", [[32.7370, -117.1950], [32.7385, -117.1900], [32.7370, -117.1850], [32.7370, -117.1950]]),
    // KNZY/North Island is close enough for the broad SAN OSM box but is a
    // separate runway complex across the bay.
    line(101, "runway", [[32.6990, -117.2220], [32.6990, -117.1900]]),
    line(102, "runway", [[32.6920, -117.2080], [32.7100, -117.2080]]),
    line(103, "taxiway", [[32.6990, -117.2080], [32.7020, -117.2040]]),
  ];

  const filtered = filterAirportSurfaceFeatures(features, san);
  assert.deepEqual(filtered.map((feature) => feature.id).sort((a, b) => a - b), [1, 2, 3]);
});

test("connected taxiway network keeps separated runways belonging to one large airport", () => {
  const airport = { lat: 28.4312, lon: -81.3081 };
  const features: SurfaceFeature[] = [
    line(1, "runway", [[28.430, -81.325], [28.430, -81.295]]),
    line(2, "taxiway", [[28.431, -81.310], [28.440, -81.310], [28.447, -81.310]]),
    line(3, "runway", [[28.447, -81.325], [28.447, -81.295]]),
    line(4, "terminal", [[28.438, -81.313], [28.440, -81.313], [28.440, -81.307], [28.438, -81.307], [28.438, -81.313]]),
  ];

  const filtered = filterAirportSurfaceFeatures(features, airport);
  assert.deepEqual(filtered.map((feature) => feature.id).sort((a, b) => a - b), [1, 2, 3, 4]);
});
