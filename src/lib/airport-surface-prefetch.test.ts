import { test } from "node:test";
import assert from "node:assert/strict";
import { prefetchFlightAirportSurfacesOnce } from "./airport-surface-prefetch.ts";
import type { FlightStory } from "./types.ts";

function story(): FlightStory {
  return {
    origin: { icao: "KBWI", iata: "BWI", lat: 39.1754, lon: -76.6684 },
    dest: { icao: "KORD", iata: "ORD", lat: 41.9742, lon: -87.9073 },
  } as FlightStory;
}

test("airport surface prefetch fires once per airport for one flight open and not again on story polls", async () => {
  const calls: readonly unknown[][] = [];
  const client = {
    prefetchQuery(options: { queryKey: readonly unknown[] }) {
      (calls as unknown[][]).push([...options.queryKey]);
      return Promise.resolve();
    },
  };
  const prefetched = new Set<string>();
  const first = story();

  await prefetchFlightAirportSurfacesOnce(client as never, first, prefetched);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map(call => call[0]), ["airport-surface-v7", "airport-surface-v7"]);
  assert.deepEqual(calls.map(call => call[1]), ["KBWI", "KORD"]);

  // A routine story poll creates a new story object/fetchedAt, but must not
  // issue another surface prefetch for either airport.
  await prefetchFlightAirportSurfacesOnce(client as never, { ...first, fetchedAt: Date.now() } as FlightStory, prefetched);
  assert.equal(calls.length, 2);
});

test("airport surface prefetch finishes origin before starting destination", async () => {
  const calls: string[] = [];
  let releaseOrigin!: () => void;
  const originDone = new Promise<void>((resolve) => { releaseOrigin = resolve; });
  const client = {
    async prefetchQuery(options: { queryKey: readonly unknown[] }) {
      const airport = String(options.queryKey[1]);
      calls.push(airport);
      if (airport === "KBWI") await originDone;
    },
  };
  const work = prefetchFlightAirportSurfacesOnce(client as never, story(), new Set());
  await Promise.resolve();
  assert.deepEqual(calls, ["KBWI"]);
  releaseOrigin();
  await work;
  assert.deepEqual(calls, ["KBWI", "KORD"]);
});

test("airport surface prefetch deduplicates a same-airport leg", async () => {
  let calls = 0;
  const client = { prefetchQuery() { calls += 1; return Promise.resolve(); } };
  const first = story();
  await prefetchFlightAirportSurfacesOnce(client as never, { ...first, dest: first.origin } as FlightStory, new Set());
  assert.equal(calls, 1);
});
