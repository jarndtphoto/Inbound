import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { emptyArrivalState, updateArrivalProjection } from "./arrival-projection-state.ts";
import { arrivalPattern } from "./arrival-pattern.ts";
import { runwayCoordinates, type ExpectedArrivalRunway } from "./arrival-runway.ts";
import { destPoint, haversineNm, polylineLengthNm } from "./geo.ts";
import { arrivalFuturePoints, arrivalPointBehind, projectArrivalSegment } from "./arrival-path.ts";

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

const fixture = JSON.parse(readFileSync(new URL("./fixtures/ual2207-arrival-2026-10-02.json", import.meta.url), "utf8")) as {
  date: string; runway: ExpectedArrivalRunway; destination: { lat: number; lon: number; elevationFt: number };
  fixes: Array<{ time: string; lat: number; lon: number; track: number; altFt: number; seenSec: number; originalRemainingNm: number }>;
};
function replayUal2207() {
  let state = emptyArrivalState();
  return fixture.fixes.map(fix => {
    const aircraft = { ...fix, vertFpm: null, phase: "cruise", onGround: false };
    const previous = JSON.parse(JSON.stringify(state)); // fresh/cold instance each poll
    const result = updateArrivalProjection(previous, { live: aircraft, runway: fixture.runway, dest: fixture.destination,
      landed: false, approachEvidence: true, now: Date.parse(`${fixture.date}T${fix.time}Z`) });
    state = result.state;
    const points = [{ lat: aircraft.lat, lon: aircraft.lon }, ...arrivalFuturePoints(state.points, aircraft)];
    return { ...result, aircraft, previous, displayPoints: points, remainingNm: polylineLengthNm(points), directNm: haversineNm(aircraft, fixture.runway.threshold) };
  });
}
test("UAL2207 observed final fixes consume steadily instead of growing and snapping", () => {
  const polls = replayUal2207();
  assert.ok(fixture.fixes.some((fix, i) => i > 0 && fix.originalRemainingNm > fixture.fixes[i - 1].originalRemainingNm + .2), "fixture demonstrates the original defect");
  for (let i = 1; i < polls.length; i++) assert.ok(polls[i].remainingNm <= polls[i - 1].remainingNm + .2,
    `${fixture.fixes[i].time}: ${polls[i - 1].remainingNm} → ${polls[i].remainingNm}`);
});
test("UAL2207 straight-in remaining path stays within 1nm of the threshold distance", () => {
  for (const poll of replayUal2207()) assert.ok(Math.abs(poll.remainingNm - poll.directNm) < 1,
    `${poll.aircraft.time}: path ${poll.remainingNm}, direct ${poll.directNm}`);
});
test("UAL2207 displayed planned points never lie behind the observed aircraft", () => {
  for (const poll of replayUal2207()) {
    assert.ok(poll.displayPoints.length >= 2);
    for (const point of poll.displayPoints.slice(1)) assert.equal(arrivalPointBehind(poll.aircraft, point), false, poll.aircraft.time);
    assert.equal(poll.state.points.some(p => p.lat === poll.aircraft.lat && p.lon === poll.aircraft.lon), false, "no current live fix persisted in planned points");
  }
});
test("UAL2207 cursor never moves backward across JSON cold-instance reloads", () => {
  for (const poll of replayUal2207()) {
    assert.ok(poll.state.cursorNm >= poll.previous.cursorNm);
    assert.ok(poll.state.pointAlongNm.every(n => n > poll.state.cursorNm));
    assert.equal(poll.state.pointAlongNm.length, poll.state.points.length);
  }
});
test("passing the threshold keeps a consumed projection at zero until landing", () => {
  const last = replayUal2207().at(-1)!;
  const aircraft = { ...last.aircraft, ...destPoint(fixture.runway.threshold, 90, .2), track: 90 };
  const result = updateArrivalProjection(JSON.parse(JSON.stringify(last.state)), { live: aircraft, runway: fixture.runway,
    dest: fixture.destination, landed: false, now: Date.parse(`${fixture.date}T17:14:00Z`) });
  assert.equal(result.state.active, true);
  assert.deepEqual(result.state.points, []);
  assert.equal(result.pattern!.lengthNm, 0, "an empty suffix is consumed, not missing");
  assert.equal(polylineLengthNm([aircraft, ...arrivalFuturePoints(result.state.points, aircraft)]), 0);
  assert.equal(updateArrivalProjection(result.state, { ...input, live: { ...aircraft, onGround: true } }).pattern, null);
});
test("short planned legs use perpendicular distance, not distance to their start", () => {
  const a = runway.threshold, b = destPoint(a, 270, .5), midpoint = destPoint(a, 270, .25);
  const p = projectArrivalSegment(midpoint, a, b);
  assert.ok(p.distanceNm < .001); assert.ok(Math.abs(p.fraction - .5) < .001);
});
test("level low downwind enters without vertical rate or a stage approach phase; cruise fly-over does not", () => {
  const dest = { ...runway.threshold, elevationFt: 672 };
  const downwind = { ...destPoint(dest, 270, 12), track: 270, seenSec: 1, altFt: 4000, vertFpm: null, phase: "cruise" };
  const first = updateArrivalProjection(emptyArrivalState(), { ...input, dest, live: downwind });
  assert.equal(first.reason, "started"); assert.equal(first.state.kind, "downwind-base");
  const flyover = { ...downwind, ...destPoint(dest, 270, 30), altFt: 35000 };
  assert.equal(updateArrivalProjection(emptyArrivalState(), { ...input, dest, live: flyover }).reason, "entry-gate");
  assert.equal(updateArrivalProjection(emptyArrivalState(), { ...input, dest, live: { ...flyover, vertFpm: -600 } }).state.active, false);
});
test("altitude delta persists before runway entry, then derives arrival-only descent on a cold instance", () => {
  const dest = { ...runway.threshold, elevationFt: 672 };
  const high = { ...live, altFt: 11000, vertFpm: null, phase: "cruise", seenSec: 0 };
  const first = updateArrivalProjection(emptyArrivalState(), { ...input, runway: null, dest, live: high, now: 100_000 });
  assert.equal(first.state.lastAltitudeFt, 11000); assert.equal(first.state.active, false);
  const next = updateArrivalProjection(JSON.parse(JSON.stringify(first.state)), { ...input, dest, live: { ...high, altFt: 10800 }, now: 120_000 });
  assert.equal(next.reason, "started"); assert.equal(next.vertFpm, -600); assert.equal(next.verticalRateSource, "altitude-delta");
  assert.equal(high.phase, "cruise"); assert.equal(high.vertFpm, null);
  const stale = updateArrivalProjection(next.state, { ...input, dest, live: { ...high, altFt: 9000, extrapolated: true }, now: 140_000 });
  assert.equal(stale.state.lastAltitudeFt, 10800); assert.equal(stale.state.lastAltitudeAt, 120_000);
});
test("nearby parallel final cannot consume base while the aircraft is still on downwind", () => {
  const initial = started();
  const nextFix = { ...live, ...destPoint(live, 270, .4), vertFpm: 0 };
  const next = updateArrivalProjection(initial, { ...input, live: nextFix, now: 120_000 });
  assert.equal(next.state.kind, "downwind-base");
  assert.ok(next.state.cursorNm < 2, "do not jump to the final leg across the pattern");
  assert.ok(next.pattern!.lengthNm > haversineNm(nextFix, runway.threshold) + 5);
});
test("old durable jsonb rows upgrade without losing runway, side or activation", () => {
  const oldPattern = arrivalPattern(live, runway);
  const old = { runway, side: oldPattern.side, active: true, startedAt: 100_000, points: oldPattern.points,
    kind: oldPattern.kind, offPathStreak: 0, lastFixAt: 98_000 };
  const result = updateArrivalProjection(old as ReturnType<typeof emptyArrivalState>, { ...input, now: 120_000 });
  assert.equal(result.state.runway!.runway, "10R"); assert.equal(result.state.side, old.side);
  assert.equal(result.state.active, true); assert.equal(result.state.pathVersion, 2);
  assert.equal(result.state.points.some(p => p.lat === live.lat && p.lon === live.lon), false);
});
