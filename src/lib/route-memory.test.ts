import { test } from "node:test";
import assert from "node:assert/strict";
import { currentLegTrackBoundaryMs, emptyRouteMemory, freshRouteObservation, isolateCurrentLegTrack, mergeObservedTrack, mergeRouteMemory, routeProgress, type RouteObservation } from "./route-memory.ts";
import { polylineLengthNm } from "./geo.ts";
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

test("UA411 discards the prior EWR→MCO sector before flown miles and phase", () => {
  const mco = { lat: 28.4312, lon: -81.3081 };
  const trace: RouteObservation[] = [
    { lat: 40.6895, lon: -74.1745, seenAt: now - 7 * 3600_000 },
    { lat: 34.4, lon: -78.2, seenAt: now - 5 * 3600_000 },
    { ...mco, seenAt: now - 3 * 3600_000 },
    { lat: 28.55, lon: -81.20, seenAt: now - 2 * 3600_000 },
    { lat: 28.78, lon: -81.03, seenAt: now - 110 * 60_000 },
  ];
  const boundary = currentLegTrackBoundaryMs(trace, mco);
  const isolated = isolateCurrentLegTrack(trace, mco, boundary);
  assert.equal(boundary, trace[3]!.seenAt);
  assert.deepEqual(isolated[0], trace[3]);
  assert.ok(polylineLengthNm(isolated) < 50, `current leg was ${polylineLengthNm(isolated)} NM`);
  assert.ok(isolated.every(point => point.seenAt >= trace[3]!.seenAt));
});
