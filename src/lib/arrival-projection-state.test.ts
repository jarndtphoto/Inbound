import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyArrivalState, updateArrivalProjection } from "./arrival-projection-state.ts";
import { arrivalPattern } from "./arrival-pattern.ts";
import { runwayCoordinates, type ExpectedArrivalRunway } from "./arrival-runway.ts";
import { destPoint, haversineNm } from "./geo.ts";

const runway: ExpectedArrivalRunway = { runway: "10R", source: "ATIS", estimated: true, threshold: { lat: 41.95719909667969, lon: -87.92790222167969 }, heading: 90 };
const live = { lat: 41.877462, lon: -88.199775, track: 267.67, seenSec: 2, vertFpm: -1000, phase: "descent" };
const input = { live, runway, dest: runway.threshold, landed: false, now: 100_000 };
const started = () => updateArrivalProjection(emptyArrivalState(), input).state;
test("level downwind keeps the started pattern even without approach phase", () => {
  const r = updateArrivalProjection(started(), { ...input, now: 120_000, live: { ...live, vertFpm: 0, phase: "cruise" } });
  assert.equal(r.state.active, true); assert.equal(r.reason, "continued");
  assert.ok(r.pattern!.lengthNm > haversineNm(live, runway.threshold));
});
test("one extrapolated or 120-second fix holds the exact last pattern", () => {
  const s = started();
  for (const fix of [{ ...live, extrapolated: true }, { ...live, seenSec: 120 }]) {
    const r = updateArrivalProjection(s, { ...input, now: 130_000, live: fix });
    assert.deepEqual(r.state.points, s.points); assert.equal(r.state.active, true);
  }
});
test("held side survives crossing centerline, and base/final consume rather than redraw the loop", () => {
  let s = started();
  const side = s.side;
  const endOfBase = s.points.findIndex((p, i) => i > 10 && Math.abs(runwayCoordinates(p, { ...runway.threshold, ident: runway.runway, heading: runway.heading }).y) < .1);
  const base = s.points[endOfBase - 2];
  s = updateArrivalProjection(s, { ...input, now: 140_000, live: { ...live, ...base, track: 45, vertFpm: 0, phase: "cruise" } }).state;
  const crossing = { ...destPoint(runway.threshold, 270, 9), lat: runway.threshold.lat + .002 };
  s = updateArrivalProjection(s, { ...input, now: 160_000, live: { ...live, ...crossing, track: 90 } }).state;
  assert.equal(s.side, side); assert.equal(s.active, true); assert.ok(s.points.length < started().points.length);
  assert.deepEqual(s.points.at(-1), runway.threshold);
});
test("real AA5012 past-FAF downwind extends base beyond the aircraft", () => {
  const p = arrivalPattern(live, runway);
  const local = (point: {lat:number;lon:number}) => runwayCoordinates(point, { ...runway.threshold, ident: runway.runway, heading: runway.heading });
  const x = local(live).x;
  assert.ok(x < -9);
  assert.ok(local(p.points[1]).x <= x + .02, "first projected leg cannot point back east");
  assert.ok(Math.min(...p.points.map(c => local(c).x)) < x - 2, "base extends beyond the current aircraft");
  assert.deepEqual(p.points.at(-1), runway.threshold);
});
test("two distinct fresh fixes more than 8nm off path reject, one or duplicate fix does not", () => {
  const off = { ...live, ...destPoint(runway.threshold, 0, 30), vertFpm: -1000 };
  const first = updateArrivalProjection(started(), { ...input, live: off, now: 130_000 });
  assert.equal(first.state.active, true); assert.equal(first.state.offPathStreak, 1);
  assert.equal(updateArrivalProjection(first.state, { ...input, live: off, now: 130_000 }).state.offPathStreak, 1);
  const second = updateArrivalProjection(first.state, { ...input, live: off, now: 150_000 });
  assert.equal(second.pattern, null); assert.equal(second.reason, "off-path-twice");
  assert.equal(updateArrivalProjection(second.state, { ...input, live: off, now: 170_000 }).pattern, null);
});
test("new reported runway resets side; landing ends the projection", () => {
  const r = updateArrivalProjection(started(), { ...input, now: 120_000, runway: { ...runway, runway: "10C", source: "provider" }, live: { ...live, vertFpm: 0, phase: "cruise" } });
  assert.equal(r.reason, "runway-changed"); assert.equal(r.state.runway!.runway, "10C");
  assert.equal(updateArrivalProjection(r.state, { ...input, landed: true }).pattern, null);
});
