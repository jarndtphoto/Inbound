import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import pack from "./data/chicago-airport-surfaces.json" with { type: "json" };
import { getAirportSurfaceSnapshot } from "./airport-surface-snapshot.server.ts";
import { loadAirportSurface } from "./airport-surface.server.ts";

const expected = {
  KORD: { count: 1436, runway: 8, taxiway: 782, terminal: 19, bounds: [41.94, 42.01, -87.95, -87.87] },
  KMDW: { count: 304, runway: 10, taxiway: 191, terminal: 7, bounds: [41.77, 41.80, -87.77, -87.73] },
};

test("Chicago snapshot contains only ORD/MDW and retains source geometry/provenance", () => {
  assert.deepEqual(Object.keys(pack.surfaces).sort(), ["KMDW", "KORD"]);
  for (const code of ["KORD", "KMDW"] as const) {
    const surface = pack.surfaces[code], info = pack.provenance[code], e = expected[code];
    assert.equal(surface.airport, code);
    assert.equal(surface.features.length, e.count);
    assert.equal(createHash("sha256").update(JSON.stringify(surface)).digest("hex"), info.surfaceSha256);
    assert.match(info.rawSha256, /^[a-f0-9]{64}$/);
    assert.equal(surface.checkedAt, Date.parse(surface.snapshot.retrievedAt));
    assert.ok(Number.isFinite(Date.parse(surface.snapshot.osmBaseAt)));
    assert.equal(surface.snapshot.licenseUrl, "https://www.openstreetmap.org/copyright");
    assert.ok(surface.boundary.length > 0);
    for (const kind of ["runway", "taxiway", "terminal"] as const) {
      assert.equal(surface.features.filter(f => f.kind === kind).length, e[kind]);
    }
    assert.equal(new Set(surface.features.map(f => `${f.kind}:${f.id}`)).size, e.count);
    for (const points of [...surface.boundary, ...surface.features.map(f => f.points)]) {
      assert.ok(points.length >= 2 && points.length <= 800);
      for (const p of points) {
        assert.ok(Number.isFinite(p.lat) && Number.isFinite(p.lon));
        assert.ok(p.lat >= e.bounds[0]! && p.lat <= e.bounds[1]! && p.lon >= e.bounds[2]! && p.lon <= e.bounds[3]!, `${code}: ${JSON.stringify(p)}`);
      }
    }
  }
  const ordIds = new Set(pack.surfaces.KORD.features.map(f => f.id));
  assert.ok(pack.surfaces.KMDW.features.every(f => !ordIds.has(f.id)));
});

test("snapshot aliases are exact and wrong airport coordinates never substitute a Chicago map", () => {
  assert.equal(getAirportSurfaceSnapshot({ airport: "ord", ...pack.provenance.KORD.field })?.airport, "ORD");
  assert.equal(getAirportSurfaceSnapshot({ airport: "MDW", ...pack.provenance.KMDW.field })?.airport, "MDW");
  assert.equal(getAirportSurfaceSnapshot({ airport: "KORD", ...pack.provenance.KMDW.field }), null);
  assert.equal(getAirportSurfaceSnapshot({ airport: "KMDW", ...pack.provenance.KORD.field }), null);
  assert.equal(getAirportSurfaceSnapshot({ airport: "KSFO", ...pack.provenance.KORD.field }), null);
  assert.equal(getAirportSurfaceSnapshot({ airport: "KORD", lat: NaN, lon: -87.9 }), null);
});

test("cold ORD/MDW requests return detailed geometry without any runtime provider requests", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error("all providers offline"); };
  try {
    for (const airport of ["KORD", "KMDW"] as const) {
      const surface = await loadAirportSurface({ airport, ...pack.provenance[airport].field });
      assert.equal(surface.features.length, expected[airport].count);
      assert.equal(surface.snapshot?.retrievedAt, pack.surfaces[airport].snapshot.retrievedAt);
    }
    assert.equal(calls, 0);
  } finally { globalThis.fetch = originalFetch; }
});
