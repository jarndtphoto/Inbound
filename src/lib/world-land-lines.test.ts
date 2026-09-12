import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { WORLD_LAND_RINGS } from "./world-land-lines.ts";

function hits(
  minLon: number,
  maxLon: number,
  minLat: number,
  maxLat: number,
) {
  return WORLD_LAND_RINGS.filter((ring) => {
    let a = 180, b = -180, c = 90, d = -90;
    for (const [lo, la] of ring) {
      if (lo < a) a = lo;
      if (lo > b) b = lo;
      if (la < c) c = la;
      if (la > d) d = la;
    }
    return b >= minLon && a <= maxLon && d >= minLat && c <= maxLat;
  });
}

describe("world land rings", () => {
  it("has major landmasses", () => {
    assert.ok(WORLD_LAND_RINGS.length > 80);
    const bboxes = WORLD_LAND_RINGS.map((ring) => {
      const lons = ring.map((p) => p[0]);
      const lats = ring.map((p) => p[1]);
      return { minLon: Math.min(...lons), maxLon: Math.max(...lons), minLat: Math.min(...lats), maxLat: Math.max(...lats) };
    });
    const covers = (lon: number, lat: number) =>
      bboxes.some((b) => lon >= b.minLon && lon <= b.maxLon && lat >= b.minLat && lat <= b.maxLat);
    assert.equal(covers(-150, 64), true, "Alaska");
    assert.equal(covers(-100, 55), true, "Canada");
    assert.equal(covers(-2, 53), true, "UK");
    assert.equal(covers(138, 36), true, "Japan");
    assert.equal(covers(134, -25), true, "Australia");
    assert.equal(covers(-157.8, 21.3), true, "Hawaii");
  });

  it("does not scribble across the antimeridian", () => {
    for (const ring of WORLD_LAND_RINGS) {
      for (let i = 1; i < ring.length; i++) {
        assert.ok(Math.abs(ring[i][0] - ring[i - 1][0]) <= 170, `jump ${ring[i - 1]} -> ${ring[i]}`);
      }
    }
  });

  it("shows land in overseas route bboxes", () => {
    assert.ok(hits(-80, 5, 38, 55).length >= 3, "JFK-LHR");
    assert.ok(hits(-155, -120, 45, 65).length >= 1, "SEA-ANC alaska");
    assert.ok(hits(-125, 145, 30, 45).length >= 1, "SFO-NRT wide bbox still has land");
    assert.ok(hits(-125, -70, 24, 50).length >= 1, "CONUS");
  });
});
