import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyRouteMemory, freshRouteObservation, mergeObservedTrack, mergeRouteMemory, routeProgress, type RouteObservation } from "./route-memory.ts";
const now = Date.parse("2026-10-03T21:00:00Z");
const leg = { origin: "ORD", destination: "HNL", date: "2026-10-03" };
const path = [{ lat: 41.98, lon: -87.9 }, { lat: 33, lon: -130 }, { lat: 21.32, lon: -157.92 }];
test("UA219 oceanic gap retains last observed progress and clock; fresh recovery resumes", () => {
  const observation = { lat: 33, lon: -130, seenAt: now };
  const observed = routeProgress(path, null, observation, true, false);
  const memory = emptyRouteMemory(leg); memory.track = [{ ...path[0]!, seenAt: now - 4 * 3600_000 }, observation];
  memory.lastObserved = { ...observation, ...observed };
  const held = routeProgress(path, memory, null, true, false);
  assert.equal(held.source, "last_known"); assert.equal(held.progress, observed.progress);
  assert.equal(held.remainingNm, observed.remainingNm); assert.equal(held.observedAt, now);
  const recovered = routeProgress(path, memory, { lat: 28, lon: -140, seenAt: now + 3600_000 }, true, false);
  assert.equal(recovered.source, "observed"); assert(recovered.progress > held.progress);
  assert.equal(routeProgress(path, memory, null, true, true).progress, 1);
  assert.equal(routeProgress(path, null, null, true, false).source, "unknown", "no first observation means no guessed position/progress");
  const old = mergeRouteMemory(memory, { ...emptyRouteMemory(leg), lastObserved: { ...memory.lastObserved, seenAt: now - 1, progress: 0.03 } });
  assert.equal(old.lastObserved!.progress, observed.progress);
});
test("fresh progress accepts only real, timed airborne fixes within 90 s", () => {
  const fix = { lat: 30, lon: -140, seenAt: now / 1000 - 1 };
  assert(freshRouteObservation(fix, now));
  for (const rejected of [{ ...fix, seenAt: now / 1000 - 91 }, { ...fix, extrapolated: true }, { ...fix, onGround: true }, { lat: 30, lon: -140 }])
    assert.equal(freshRouteObservation(rejected, now), null);
  assert.equal(freshRouteObservation(null, now), null);
});
test("large tracks stay bounded and preserve the first and latest real observation", () => {
  const track: RouteObservation[] = Array.from({ length: 2000 }, (_, i) => ({ lat: 40, lon: -100 + i * .02, seenAt: now + i * 30_000 }));
  const held = mergeObservedTrack([], track);
  assert(held.length <= 512); assert.deepEqual(held[0], track[0]); assert.deepEqual(held.at(-1), track.at(-1));
});
