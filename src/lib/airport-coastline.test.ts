import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildAirportHydrography,
  clipPolygonToBounds,
  pointInSurfaceRing,
  type SurfaceBounds,
} from "./airport-coastline.ts";

const bounds: SurfaceBounds = { south: 0, west: 0, north: 1, east: 1 };
const p = (lat: number, lon: number) => ({ lat, lon });

test("coastline crossing the airport box closes along the correct edge with land on the left", () => {
  const hydro = buildAirportHydrography({
    bounds,
    coastlines: [{ id: 1, points: [p(-0.5, 0.4), p(1.5, 0.4)] }],
    water: [],
  });
  assert.equal(hydro.fallback, false);
  assert.equal(hydro.ocean, true);
  assert.equal(hydro.land.length, 1);
  assert.equal(pointInSurfaceRing(p(0.5, 0.2), hydro.land[0]!.outer), true, "west side is land");
  assert.equal(pointInSurfaceRing(p(0.5, 0.8), hydro.land[0]!.outer), false, "east side remains water");
  assert.ok(hydro.waterFraction > 0.5 && hydro.waterFraction < 0.7);
});

test("closed coastline island keeps the island as land", () => {
  const island = [p(0.3, 0.3), p(0.3, 0.7), p(0.7, 0.7), p(0.7, 0.3), p(0.3, 0.3)];
  const hydro = buildAirportHydrography({
    bounds,
    coastlines: [{ id: 2, points: island }],
    water: [],
  });
  assert.equal(hydro.fallback, false);
  assert.equal(hydro.ocean, true);
  assert.equal(pointInSurfaceRing(p(0.5, 0.5), hydro.land[0]!.outer), true);
  assert.ok(hydro.waterFraction > 0.7);
});

test("reversed closed coastline treats the interior as water instead of flipping the whole map", () => {
  const island = [p(0.3, 0.3), p(0.3, 0.7), p(0.7, 0.7), p(0.7, 0.3), p(0.3, 0.3)].reverse();
  const hydro = buildAirportHydrography({
    bounds,
    coastlines: [{ id: 3, points: island }],
    water: [],
  });
  assert.equal(hydro.fallback, false);
  assert.equal(hydro.ocean, false);
  assert.equal(hydro.land.length, 0);
  assert.equal(hydro.water.length, 1);
  assert.equal(pointInSurfaceRing(p(0.5, 0.5), hydro.water[0]!.outer), true);
  assert.ok(hydro.waterFraction > 0.1 && hydro.waterFraction < 0.3);
});

test("inland water clips to the airport box while the base stays land", () => {
  const lake = [p(-0.2, 0.2), p(-0.2, 0.8), p(0.6, 0.8), p(0.6, 0.2), p(-0.2, 0.2)];
  const clipped = clipPolygonToBounds(lake, bounds);
  assert.ok(clipped.every(point => point.lat >= 0 && point.lat <= 1 && point.lon >= 0 && point.lon <= 1));
  const hydro = buildAirportHydrography({
    bounds,
    coastlines: [],
    water: [{ outer: lake }],
  });
  assert.equal(hydro.fallback, false);
  assert.equal(hydro.ocean, false);
  assert.equal(hydro.water.length, 1);
  assert.ok(hydro.waterFraction > 0.2 && hydro.waterFraction < 0.5);
});

test("safety net falls back when detailed water covers a runway or nearly the whole box", () => {
  const lake = [p(-1, -1), p(-1, 2), p(2, 2), p(2, -1), p(-1, -1)];
  const runway = buildAirportHydrography({
    bounds,
    coastlines: [],
    water: [{ outer: [p(0.4, 0.4), p(0.4, 0.6), p(0.6, 0.6), p(0.6, 0.4), p(0.4, 0.4)] }],
    runwayChecks: [p(0.5, 0.5)],
  });
  assert.equal(runway.fallback, true);
  assert.equal(runway.fallbackReason, "water-over-runway");

  const flooded = buildAirportHydrography({ bounds, coastlines: [], water: [{ outer: lake }] });
  assert.equal(flooded.fallback, true);
  assert.equal(flooded.fallbackReason, "water-over-95-percent");
  assert.ok(flooded.waterFraction > 0.95);
});

test("dry inland airport keeps plain land without inventing water", () => {
  const hydro = buildAirportHydrography({ bounds, coastlines: [], water: [] });
  assert.equal(hydro.fallback, false);
  assert.equal(hydro.ocean, false);
  assert.equal(hydro.land.length, 0);
  assert.equal(hydro.water.length, 0);
  assert.equal(hydro.waterFraction, 0);
});
