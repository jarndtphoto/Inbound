import { test } from "node:test";
import assert from "node:assert/strict";
import { displayArrivalProjection } from "./arrival-display.ts";
import { emptyArrivalState, updateArrivalProjection } from "./arrival-projection-state.ts";
import { destPoint } from "./geo.ts";
import type { ExpectedArrivalRunway } from "./arrival-runway.ts";
const runway: ExpectedArrivalRunway = { runway: "10R", source: "ATIS", estimated: true, threshold: { lat: 41.9572, lon: -87.9279 }, heading: 90 };
const live = { lat: 41.877462, lon: -88.199775, track: 267.67, seenSec: 1, vertFpm: -1000, phase: "descent" };
const input = { live, runway, dest: runway.threshold, landed: false, now: 100_000 };
const observation = { lat: live.lat, lon: live.lon, seenAt: 99_000 };
const started = () => updateArrivalProjection(emptyArrivalState(), input).state;
test("one missing-position poll holds the durable plan from the last real fix, explicitly stale", () => {
  const state = started();
  const before = displayArrivalProjection(state, { live, observation, lastObserved: null, landed: false })!;
  const gap = updateArrivalProjection(JSON.parse(JSON.stringify(state)), { ...input, live: null, now: 130_000 });
  assert.equal(gap.reason, "held-no-reliable-fix");
  const held = displayArrivalProjection(gap.state, { live: null, observation: null, lastObserved: observation, landed: false })!;
  assert.deepEqual(held.points, before.points); assert.equal(held.stale, true);
  assert.equal(held.geometrySource, "last_known_fix"); assert.equal(held.lengthNm, before.lengthNm);
  assert(held.points.length > 2);
});
test("legacy held cursor can render geometry without claiming a real aircraft observation", () => {
  const display = displayArrivalProjection(started(), { live: null, observation: null, lastObserved: null, landed: false })!;
  assert.equal(display.geometrySource, "held_cursor"); assert.equal(display.stale, true);
});
test("landing and two distinct off-path fixes still stop rendering a held plan", () => {
  const state = started();
  assert.equal(displayArrivalProjection(state, { live, observation, lastObserved: observation, landed: true }), null);
  const off = { ...live, ...destPoint(runway.threshold, 0, 30) };
  const first = updateArrivalProjection(state, { ...input, live: off, now: 130_000 });
  const second = updateArrivalProjection(first.state, { ...input, live: off, now: 150_000 });
  assert.equal(second.reason, "off-path-twice");
  assert.equal(displayArrivalProjection(second.state, { live: null, observation: null, lastObserved: observation, landed: false }), null);
});
test("runway change resets geometry and entry gate still prevents a new plan", () => {
  const state = started();
  const changed = updateArrivalProjection(state, { ...input, runway: { ...runway, runway: "10C", threshold: { ...runway.threshold, lat: 41.97 } }, live: null, now: 130_000 });
  assert.equal(changed.reason, "no-position");
  assert.equal(changed.state.active, false); assert.deepEqual(changed.state.points, []);
  assert.equal(displayArrivalProjection(changed.state, { live: null, observation: null, lastObserved: observation, landed: false }), null);
  const high = { ...live, altFt: 35000, vertFpm: null, ...destPoint(runway.threshold, 270, 80) };
  assert.equal(updateArrivalProjection(emptyArrivalState(), { ...input, live: high }).state.active, false);
});
