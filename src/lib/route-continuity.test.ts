import { test } from "node:test";
import assert from "node:assert/strict";
import { keepRouteGeometry, lastKnownProgressLabel } from "./route-continuity.ts";
import type { FlightStory } from "./types.ts";
const now = Date.parse("2026-10-03T21:00:00Z");
const story = (source: "filed" | "direct" | "track", progress = .65) => ({
  stateKey: "leg:v1:UAL219|2026-10-03|ORD|HNL", query: "UA219", currentStage: "ride", fetchedAt: now,
  origin: { iata: "ORD" }, dest: { iata: "HNL" }, times: {}, aircraft: null,
  route: { source, totalNm: 4000, remainingNm: 1400, progress, observedFlownNm: 2600,
    progressSource: "observed", progressObservedAt: now - 3 * 60_000, etaMin: 120,
    samples: [{ lat: 42, lon: -88, frac: 0 }, { lat: 35, lon: -120, frac: .4 }, { lat: 28, lon: -140, frac: .75 }, { lat: 21, lon: -158, frac: 1 }],
    filedFixes: [{ lat: 35, lon: -120, label: "FILED" }], filedRouteFingerprint: "filed-a", filedRouteObservedAt: now - 1000 },
} as unknown as FlightStory);
test("filed-only and track holds keep geometry, last known progress and age together across provider IDs", () => {
  for (const source of ["filed", "track"] as const) {
    const saved = story(source), incoming = story("direct", .03);
    saved.flightId = "provider-old"; incoming.flightId = "provider-new";
    incoming.route.filedRouteFingerprint = null; incoming.route.filedRouteObservedAt = null;
    incoming.route.remainingNm = 3880;
    incoming.route.etaMin = 11;
    incoming.fetchedAt = saved.fetchedAt + 30_000;
    saved.route.etaMin = 2;
    const held = keepRouteGeometry(incoming, saved);
    assert.equal(held.route.source, source); assert.deepEqual(held.route.samples, saved.route.samples);
    assert.equal(held.route.progress, .65); assert.equal(held.route.remainingNm, 1400);
    assert.equal(held.route.etaMin, 1.5, "held progress carries the prior live ETA forward instead of fallback ETA");
    assert.equal(held.route.progressSource, "last_known"); assert.equal(held.route.progressObservedAt, saved.route.progressObservedAt);
    assert.equal(lastKnownProgressLabel(held, now), "Last known progress · 3 min ago");
  }
});
test("holds guard stateKey, service date and route; validated reroutes and landing own the new geometry", () => {
  const saved = story("filed");
  for (const incoming of [
    { ...story("direct"), stateKey: "leg:v1:UAL219|2026-10-04|ORD|HNL" },
    { ...story("direct"), dest: { ...saved.dest, iata: "SFO" } },
    { ...story("direct"), currentStage: "gate" as const },
    { ...story("filed"), route: { ...story("filed").route, filedRouteFingerprint: "new-reroute", filedRouteObservedAt: now } },
  ]) assert.equal(keepRouteGeometry(incoming, saved), incoming);
});
test("fresh recovery projects the new real fix on held geometry instead of freezing old progress", () => {
  const saved = story("track"), incoming = story("direct", .03);
  incoming.route.filedRouteFingerprint = null;
  incoming.aircraft = { lat: 28, lon: -140, seenSec: 1, onGround: false } as FlightStory["aircraft"];
  const held = keepRouteGeometry(incoming, saved);
  assert.equal(held.route.source, "track"); assert.equal(held.route.progressSource, "observed");
  assert(held.route.progress > saved.route.progress); assert.equal(held.route.progressObservedAt, now - 1000);
});
test("a runway change or deactivated arrival plan cannot reapply the previous approach", () => {
  const saved = story("track"); saved.route.arrivalPatternKind = "downwind-base";
  saved.route.expectedArrival = { runway: "10R" } as FlightStory["route"]["expectedArrival"];
  for (const runway of [null, { runway: "10C" }]) {
    const incoming = story("direct"); incoming.route.arrivalPatternKind = runway ? "straight-in" : null;
    incoming.route.expectedArrival = runway as FlightStory["route"]["expectedArrival"];
    assert.equal(keepRouteGeometry(incoming, saved), incoming);
  }
});
