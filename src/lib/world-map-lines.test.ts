import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ADMIN1_RINGS } from "./admin1-lines.ts";
import { GREAT_LAKES } from "./great-lakes.ts";
import { WORLD_COUNTRY_RINGS } from "./world-country-lines.ts";

function hits(
  rings: [number, number][][],
  minLon: number,
  maxLon: number,
  minLat: number,
  maxLat: number,
) {
  return rings.filter((ring) => {
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

function noWrap(rings: [number, number][][]) {
  for (const ring of rings) {
    for (let i = 1; i < ring.length; i++) {
      assert.ok(Math.abs(ring[i][0] - ring[i - 1][0]) <= 170, `jump ${ring[i - 1]} -> ${ring[i]}`);
    }
  }
}

describe("world country rings", () => {
  it("covers major landmasses", () => {
    assert.ok(WORLD_COUNTRY_RINGS.length > 80);
    const cover = (lon: number, lat: number) => hits(WORLD_COUNTRY_RINGS, lon - 1, lon + 1, lat - 1, lat + 1).length > 0;
    assert.equal(cover(-150, 64), true, "Alaska");
    assert.equal(cover(-100, 55), true, "Canada");
    assert.equal(cover(-2, 53), true, "UK");
    assert.equal(cover(138, 36), true, "Japan");
    assert.equal(cover(-99, 19), true, "Mexico");
  });

  it("does not scribble across the antimeridian", () => {
    noWrap(WORLD_COUNTRY_RINGS);
  });

  it("shows countries on overseas route boxes", () => {
    assert.ok(hits(WORLD_COUNTRY_RINGS, -80, 5, 38, 55).length >= 3, "JFK-LHR");
    assert.ok(hits(WORLD_COUNTRY_RINGS, -125, -70, 24, 50).length >= 1, "CONUS");
    assert.ok(hits(WORLD_COUNTRY_RINGS, -155, -120, 45, 65).length >= 1, "SEA-ANC");
  });
});

describe("admin1 rings", () => {
  it("includes US states, Canada provinces, Mexico states, Hawaii", () => {
    assert.ok(ADMIN1_RINGS.length > 80);
    const cover = (lon: number, lat: number) => hits(ADMIN1_RINGS, lon - 1.5, lon + 1.5, lat - 1.5, lat + 1.5).length > 0;
    assert.equal(cover(-99, 31), true, "Texas");
    assert.equal(cover(-79, 45), true, "Ontario");
    assert.equal(cover(-103.4, 20.7), true, "Jalisco");
    assert.equal(cover(-150, 64), true, "Alaska");
    assert.equal(cover(-157.8, 21.3), true, "Hawaii");
  });

  it("does not scribble across the antimeridian", () => {
    noWrap(ADMIN1_RINGS);
  });
});

function inside(ring: [number, number][], lon: number, lat: number) {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!, b = ring[j]!;
    if ((a[1] > lat) !== (b[1] > lat) && lon < ((b[0] - a[0]) * (lat - a[1])) / (b[1] - a[1]) + a[0]) hit = !hit;
  }
  return hit;
}

describe("Great Lakes shoreline", () => {
  it("distinguishes Lake Michigan from Michigan land and preserves its islands", () => {
    const lake = GREAT_LAKES.find((l) => l.name === "Lake Michigan");
    assert.ok(lake);
    const water = (lon: number, lat: number) => lake.rings.reduce((hit, ring) => hit !== inside(ring, lon, lat), false);
    assert.equal(water(-87, 44), true, "Lake Michigan water");
    assert.equal(water(-85.5, 44), false, "lower peninsula land");
    assert.ok(lake.rings.length > 1, "lake islands retained");
  });
});
