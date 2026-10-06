import test from "node:test";
import assert from "node:assert/strict";
import { assembleAirportGeography, type GeoPoint, type SurfaceBounds } from "./airport-coastline.ts";

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
  const geography = assembleAirportGeography({ bounds, coastlineWays: [island], waterPolygons: [] });
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
