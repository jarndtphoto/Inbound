import { test } from "node:test";
import assert from "node:assert/strict";
import { browserSurfaceKey, loadCachedAirportSurface } from "./airport-surface-cache.ts";
import { airportSurfaceCacheVersion } from "./airport-surface-cache-version.ts";

test("reopening ORD/MDW ignores fresh partial v7 cache and retains the new snapshot", async () => {
  const entries = new Map<string, Response>();
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const originalCaches = Object.getOwnPropertyDescriptor(globalThis, "caches");
  const storage = { open: async () => ({ match: async (key: string) => entries.get(key)?.clone(), put: async (key: string, value: Response) => { entries.set(key, value); } }) };
  Object.defineProperty(globalThis, "window", { configurable: true, value: { caches: storage } });
  Object.defineProperty(globalThis, "caches", { configurable: true, value: storage });
  try {
    for (const airport of ["KORD", "KMDW", "ORD", "MDW"]) {
      const input = { airport, lat: 41.9, lon: -87.9 };
      const oldKey = `https://inbound.local/airport-surface/${airport}/41.900/-87.900`;
      entries.set(oldKey, new Response(JSON.stringify({ airport, features: [] }), { headers: { "x-inbound-saved-at": String(Date.now()) } }));
      let loads = 0;
      const snapshot = { airport, snapshot: { retrievedAt: "2026-10-07" }, features: [{ id: 1 }] };
      const load = async () => { loads++; return snapshot; };
      assert.notEqual(browserSurfaceKey(input), oldKey);
      assert.deepEqual(await loadCachedAirportSurface(input, load), snapshot);
      assert.deepEqual(await loadCachedAirportSurface(input, load), snapshot);
      assert.equal(loads, 1, "reopen should reuse the new cache without another server request");
    }
    assert.equal(browserSurfaceKey({ airport: "KSAN", lat: 32.7, lon: -117.2 }), "https://inbound.local/airport-surface/KSAN/32.700/-117.200");
    assert.equal(airportSurfaceCacheVersion("KSAN"), "airport-surface-v7");
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow); else Reflect.deleteProperty(globalThis, "window");
    if (originalCaches) Object.defineProperty(globalThis, "caches", originalCaches); else Reflect.deleteProperty(globalThis, "caches");
  }
});
