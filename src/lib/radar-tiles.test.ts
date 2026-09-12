import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { pickRadarTiles, tileXToLon, tileYToLat } from "./radar-tiles.ts";

function coversLon(tiles: { z: number; x: number }[], lon: number) {
  return tiles.some((t) => {
    const west = tileXToLon(t.x, t.z);
    const east = tileXToLon(t.x + 1, t.z);
    return lon >= west && lon <= east;
  });
}

describe("radar tiles", () => {
  it("covers HNL through ORD, including Utah and the Midwest", () => {
    // Typical padded HNL→ORD view
    const tiles = pickRadarTiles(-162, -82, 12, 52);
    assert.ok(tiles.length > 4);
    assert.ok(tiles.length <= 36);
    assert.equal(coversLon(tiles, -157.9), true, "Honolulu");
    assert.equal(coversLon(tiles, -111.9), true, "Utah");
    assert.equal(coversLon(tiles, -97.5), true, "Midwest");
    assert.equal(coversLon(tiles, -87.9), true, "Chicago");
    const zs = new Set(tiles.map((t) => t.z));
    assert.equal(zs.size, 1);
  });

  it("still covers a short domestic hop at a tighter zoom", () => {
    const tiles = pickRadarTiles(-88.5, -86.5, 41.2, 42.4);
    assert.ok(tiles.length >= 1);
    assert.ok(tiles[0]!.z >= 4);
    assert.equal(coversLon(tiles, -87.6), true);
  });

  it("does not starve the east side of a wide box", () => {
    const tiles = pickRadarTiles(-125, -70, 25, 49);
    const east = Math.max(...tiles.map((t) => tileXToLon(t.x + 1, t.z)));
    assert.ok(east > -80, `east edge ${east}`);
  });
});
