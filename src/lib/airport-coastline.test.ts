import test from "node:test";
import assert from "node:assert/strict";
import { assembleAirportGeography, airportGeographyIsWater, airportGeographyWaterFraction, type GeoPoint, type SurfaceBounds } from "./airport-coastline.ts";

const bounds: SurfaceBounds = { south: 0, west: 0, north: 10, east: 10 };

function hasPoint(ring: GeoPoint[], lat: number, lon: number) {
  return ring.some((point) => Math.abs(point.lat - lat) < 1e-6 && Math.abs(point.lon - lon) < 1e-6);
}

test("eastbound coastline crossing the box closes on the north land side", () => {
  const geography = assembleAirportGeography({
    bounds,
    coastlineWays: [[{ lat: 5, lon: -2 }, { lat: 5, lon: 12 }]],
    waterPolygons: [],
  });
  assert.equal(geography.fallback, false);
  assert.equal(geography.base, "water");
  assert.equal(geography.land.length, 1);
  assert.ok(hasPoint(geography.land[0]!, 10, 10));
  assert.ok(hasPoint(geography.land[0]!, 10, 0));
  assert.equal(hasPoint(geography.land[0]!, 0, 0), false);
  assert.equal(hasPoint(geography.land[0]!, 0, 10), false);
});

test("reversing the coastline reverses the land side instead of applying a 180-degree workaround", () => {
  const geography = assembleAirportGeography({
    bounds,
    coastlineWays: [[{ lat: 5, lon: 12 }, { lat: 5, lon: -2 }]],
    waterPolygons: [],
  });
  assert.equal(geography.fallback, false);
  assert.equal(geography.base, "water");
  assert.ok(hasPoint(geography.land[0]!, 0, 0));
  assert.ok(hasPoint(geography.land[0]!, 0, 10));
  assert.equal(hasPoint(geography.land[0]!, 10, 10), false);
  assert.equal(hasPoint(geography.land[0]!, 10, 0), false);
});

test("closed counter-clockwise coastline inside the box remains an island", () => {
  const island = [
    { lat: 4, lon: 4 },
    { lat: 4, lon: 6 },
    { lat: 6, lon: 6 },
    { lat: 6, lon: 4 },
    { lat: 4, lon: 4 },
  ];
  const geography = assembleAirportGeography({ bounds: { south: 3, west: 3, north: 7, east: 7 }, coastlineWays: [island], waterPolygons: [] });
  assert.equal(geography.fallback, false);
  assert.equal(geography.base, "water");
  assert.equal(geography.land.length, 1);
  assert.ok(geography.land[0]!.length >= 5);
  assert.ok(geography.land[0]!.every((point) => point.lat >= 4 && point.lat <= 6 && point.lon >= 4 && point.lon <= 6));
});

test("inland airport defaults to land and keeps clipped lake polygons", () => {
  const lake = {
    outer: [
      { lat: 2, lon: 2 }, { lat: 2, lon: 4 }, { lat: 4, lon: 4 }, { lat: 4, lon: 2 }, { lat: 2, lon: 2 },
    ],
  };
  const geography = assembleAirportGeography({ bounds, coastlineWays: [], waterPolygons: [lake] });
  assert.equal(geography.fallback, false);
  assert.equal(geography.base, "land");
  assert.equal(geography.water.length, 1);
});

test("clockwise closed coastline encloses water with land outside", () => {
  const ring = [{ lat: 3, lon: 3 }, { lat: 7, lon: 3 }, { lat: 7, lon: 7 }, { lat: 3, lon: 7 }, { lat: 3, lon: 3 }];
  const geography = assembleAirportGeography({ bounds, coastlineWays: [ring], waterPolygons: [] });
  assert.equal(geography.fallback, false);
  assert.equal(geography.base, "land");
  assert.equal(geography.water.length, 1);
  assert.equal(airportGeographyIsWater(geography, { lat: 5, lon: 5 }), true);
  assert.equal(airportGeographyIsWater(geography, { lat: 1, lon: 1 }), false);
  assert.equal(assembleAirportGeography({ bounds, coastlineWays: [ring], waterPolygons: [],
    runwaySamples: [{ lat: 5, lon: 5 }] }).fallbackReason, "water-covers-runways");
});

test("clockwise water inside a counter-clockwise island retains ocean and inland water", () => {
  const island = [{ lat: 1, lon: 1 }, { lat: 1, lon: 9 }, { lat: 9, lon: 9 }, { lat: 9, lon: 1 }, { lat: 1, lon: 1 }];
  const lake = [{ lat: 3, lon: 3 }, { lat: 7, lon: 3 }, { lat: 7, lon: 7 }, { lat: 3, lon: 7 }, { lat: 3, lon: 3 }];
  const geography = assembleAirportGeography({ bounds, coastlineWays: [island, lake], waterPolygons: [] });
  assert.equal(geography.fallback, false);
  assert.equal(geography.base, "water");
  assert.equal(airportGeographyIsWater(geography, { lat: 0, lon: 0 }), true);
  assert.equal(airportGeographyIsWater(geography, { lat: 2, lon: 2 }), false);
  assert.equal(airportGeographyIsWater(geography, { lat: 5, lon: 5 }), true);
});

test("sub-tolerance closed islands and ponds stay polygons without rejecting the whole shoreline", () => {
  const tiny = [{ lat: 32.85, lon: -117.27 }, { lat: 32.85, lon: -117.26995 },
    { lat: 32.850025, lon: -117.26995 }, { lat: 32.85005, lon: -117.26995 },
    { lat: 32.85005, lon: -117.27 }, { lat: 32.85, lon: -117.27 }];
  const geography = assembleAirportGeography({ bounds: { south: 32.28, west: -117.73, north: 33.18, east: -116.66 },
    coastlineWays: [[{ lat: 32, lon: -117.1 }, { lat: 33.5, lon: -117.1 }], tiny],
    waterPolygons: [{ outer: tiny }], runwaySamples: [{ lat: 32.73, lon: -117.19 }] });
  assert.equal(geography.fallback, false);
  assert.equal(geography.land.length, 2);
  assert.ok(geography.land.every((ring) => ring.length >= 4));
  assert.equal(geography.water.length, 1);
  assert.equal(airportGeographyIsWater(geography, { lat: 32.850025, lon: -117.269975 }), true);
});

test("water over 95 percent of the box falls back to plain land", () => {
  const geography = assembleAirportGeography({
    bounds,
    coastlineWays: [],
    waterPolygons: [{ outer: [
      { lat: 0, lon: 0 }, { lat: 0, lon: 10 }, { lat: 10, lon: 10 }, { lat: 10, lon: 0 }, { lat: 0, lon: 0 },
    ] }],
  });
  assert.equal(geography.fallback, true);
  assert.equal(geography.fallbackReason, "water-over-95-percent");
  assert.equal(geography.base, "land");
  assert.deepEqual(geography.water, []);
});

test("water covering runway samples falls back to plain land", () => {
  const geography = assembleAirportGeography({
    bounds,
    coastlineWays: [],
    waterPolygons: [{ outer: [
      { lat: 4, lon: 4 }, { lat: 4, lon: 6 }, { lat: 6, lon: 6 }, { lat: 6, lon: 4 }, { lat: 4, lon: 4 },
    ] }],
    runwaySamples: [{ lat: 5, lon: 5 }],
  });
  assert.equal(geography.fallback, true);
  assert.equal(geography.fallbackReason, "water-covers-runways");
  assert.equal(geography.base, "land");
});

test("one submerged runway triggers fallback even when most runway samples are dry", () => {
  const geography = assembleAirportGeography({ bounds, coastlineWays: [], waterPolygons: [{ outer: [
    { lat: 4, lon: 4 }, { lat: 4, lon: 6 }, { lat: 6, lon: 6 }, { lat: 6, lon: 4 }, { lat: 4, lon: 4 },
  ] }], runwaySamples: [{ lat: 5, lon: 5 }, { lat: 1, lon: 1 }, { lat: 2, lon: 2 }] });
  assert.equal(geography.fallbackReason, "water-covers-runways");
});

test("coastline fragments sharing a start or end cannot assemble contradictory land sides", () => {
  for (const coastlineWays of [
    [[{ lat: 0, lon: 0 }, { lat: 10, lon: 5 }], [{ lat: 0, lon: 0 }, { lat: 5, lon: 10 }]],
    [[{ lat: 10, lon: 5 }, { lat: 0, lon: 0 }], [{ lat: 5, lon: 10 }, { lat: 0, lon: 0 }]],
  ]) {
    const geography = assembleAirportGeography({ bounds, coastlineWays, waterPolygons: [] });
    assert.equal(geography.fallbackReason, "coastline-direction-conflict");
  }
});

test("ocean inferred from a coastline also obeys the 95-percent water guard", () => {
  const geography = assembleAirportGeography({ bounds,
    coastlineWays: [[{ lat: -1, lon: 0.2 }, { lat: 11, lon: 0.2 }]],
    waterPolygons: [],
  });
  assert.equal(geography.fallback, true);
  assert.equal(geography.fallbackReason, "water-over-95-percent");
});

test("overlapping water polygons count once and retain island holes", () => {
  const outer = [{ lat: 0, lon: 0 }, { lat: 0, lon: 10 }, { lat: 6, lon: 10 }, { lat: 6, lon: 0 }, { lat: 0, lon: 0 }];
  const hole = [{ lat: 2, lon: 2 }, { lat: 2, lon: 4 }, { lat: 4, lon: 4 }, { lat: 4, lon: 2 }, { lat: 2, lon: 2 }];
  const polygon = { outer, holes: [hole] };
  const geography = assembleAirportGeography({ bounds, coastlineWays: [], waterPolygons: [polygon, polygon] });
  assert.equal(geography.fallback, false);
  assert.ok(Math.abs(airportGeographyWaterFraction(geography) - 0.56) < 0.01);
});
