import assert from "node:assert/strict";
import { test } from "node:test";
import { ADMIN1_RINGS } from "./admin1-lines.ts";
import { HAWAII_COASTLINES } from "./hawaii-coastlines.ts";
import { WORLD_COUNTRY_RINGS } from "./world-country-lines.ts";

type Ring = [number, number][];
function hawaiianRings(rings: Ring[]): Ring[] {
  return rings.filter(ring => ring.some(([lon, lat]) => lon >= -161 && lon <= -154 && lat >= 18 && lat <= 23));
}
function bounds(ring: Ring) {
  return { west: Math.min(...ring.map(p => p[0])), east: Math.max(...ring.map(p => p[0])),
    south: Math.min(...ring.map(p => p[1])), north: Math.max(...ring.map(p => p[1])) };
}
function matchingIsland(ring: Ring): string {
  // Natural Earth's coarse outlines can extend slightly beyond the detailed
  // shorelines. Every vertex must still belong to the same island's bounds.
  const tolerance = 0.06;
  const islands = HAWAII_COASTLINES.filter(island => {
    const box = bounds(island.ring);
    return ring.every(([lon, lat]) => lon >= box.west - tolerance && lon <= box.east + tolerance
      && lat >= box.south - tolerance && lat <= box.north + tolerance);
  });
  assert.equal(islands.length, 1, `Expected one island, got ${islands.map(i => i.name)} for ${JSON.stringify(ring)}`);
  assert.deepEqual(ring[0], ring.at(-1), "Island coastline remains a closed ring");
  return islands[0].name;
}

test("Hawaii state outlines keep six islands separate without an ocean-spanning envelope", () => {
  const rings = hawaiianRings(ADMIN1_RINGS);
  assert.equal(rings.length, 6);
  assert.deepEqual(rings.map(matchingIsland).sort(), HAWAII_COASTLINES.map(i => i.name).sort());
});

test("World land fills and outlines do not join different Hawaiian islands", () => {
  const rings = hawaiianRings(WORLD_COUNTRY_RINGS);
  assert.deepEqual(rings.map(matchingIsland).sort(), ["Hawaiʻi", "Maui", "Oʻahu", "Kauaʻi"].sort());
});

test("Detailed Hawaiian coastlines retain one closed shape per island", () => {
  assert.equal(HAWAII_COASTLINES.length, 6);
  for (const island of HAWAII_COASTLINES) {
    assert.equal(matchingIsland(island.ring), island.name);
    assert.ok(island.ring.length >= 15, `${island.name} retains coastline detail`);
  }
});
