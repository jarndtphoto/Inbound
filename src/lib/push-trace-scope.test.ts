import test from "node:test";
import assert from "node:assert/strict";
import { currentOriginPushTraceScope, pushLatchWithinScope, pushParkWithinScope, type PushTracePoint } from "./push-trace-scope.ts";

const origin = { lat: 41.9786, lon: -87.9048, elevationFt: 672 };
const oldParkUnix = 1791373997.829;
const oldPushUnix = 1791374036.419;
const actualUnix = 1791394560;
const currentParkUnix = actualUnix - 600;
const point = (t: number, extra: Partial<PushTracePoint> = {}): PushTracePoint => ({
  ...origin, t, ground: true, alt: 672, ...extra,
});
const visits = [
  point(oldParkUnix),
  point(oldPushUnix, { lon: -87.9031 }),
  point(oldPushUnix + 40, { lon: -87.902 }),
  point(oldPushUnix + 1800, { lat: 42.3, lon: -89.2, ground: false, alt: 12000 }),
  point(currentParkUnix),
  point(actualUnix - 5, { lon: -87.9031 }),
  point(actualUnix + 25, { lon: -87.902 }),
];

test("UA561 rejects the 11:53 origin visit and retains the current stand before 17:36 push", () => {
  const scope = currentOriginPushTraceScope(visits, origin);
  assert.equal(scope.notBeforeUnix, currentParkUnix);
  assert.equal(scope.boundaryReason, "return_to_origin");
  assert.deepEqual(scope.points, visits.slice(4));
  assert.equal(pushParkWithinScope({ ...origin, at: oldParkUnix * 1000 }, scope), null);
  assert.equal(pushLatchWithinScope({ unix: oldPushUnix, source: "track_detected" }, scope), null);
  const witnessed = { unix: oldPushUnix, source: "live_detected" };
  assert.equal(pushLatchWithinScope(witnessed, scope), witnessed, "a contemporaneous same-leg detection is not an unscoped tail trace");
});

test("current visit preserves the parked baseline and earlier physical push before provider OUT", () => {
  const scope = currentOriginPushTraceScope(visits, origin);
  const park = { ...origin, at: currentParkUnix * 1000 };
  const track = { unix: actualUnix - 5, source: "track_detected", live: true };
  assert.equal(pushParkWithinScope(park, scope), park);
  assert.equal(pushLatchWithinScope(track, scope), track);
  assert.equal(scope.points[0]!.t, currentParkUnix);
});

test("flight-specific provider actual survives a later observed trace boundary", () => {
  const actual = { unix: actualUnix, source: "provider_actual" };
  assert.equal(pushLatchWithinScope(actual, { notBeforeUnix: actualUnix + 600 }), actual);
});

test("an unanchored receiver gap cannot prove another origin visit", () => {
  const points = visits.filter(p => p.ground);
  const scope = currentOriginPushTraceScope(points, origin);
  assert.equal(scope.notBeforeUnix, null);
  assert.equal(scope.boundaryReason, null);
  assert.deepEqual(scope.points, points);
  const prior = { unix: oldPushUnix, source: "live_detected" };
  assert.equal(pushLatchWithinScope(prior, scope), prior);
});

test("observed departure and return separate close visits even inside the gap threshold", () => {
  const trace = [
    point(1000), point(1050, { lon: -87.9031 }),
    point(1200, { lat: 42.2, ground: false, alt: 2000 }),
    point(1500), point(1560, { lon: -87.9031 }),
  ];
  const scope = currentOriginPushTraceScope(trace, origin);
  assert.equal(scope.notBeforeUnix, 1500);
  assert.deepEqual(scope.points, trace.slice(3));
});

test("an airborne circuit followed by surface fixes proves a new visit within airport radius", () => {
  const trace = [point(1000), point(1200, { ground: false, alt: 1500 }), point(1500)];
  assert.equal(currentOriginPushTraceScope(trace, origin).notBeforeUnix, 1500);
});

test("continuous same-visit taxi and holds keep their earliest physical evidence", () => {
  const trace = Array.from({ length: 9 }, (_, index) => point(1000 + index * 1200, { lon: -87.9 + index * 0.001 }));
  const scope = currentOriginPushTraceScope(trace, origin);
  const latch = { unix: 900, source: "track_detected" };
  assert.equal(scope.notBeforeUnix, null);
  assert.equal(pushLatchWithinScope(latch, scope), latch);
  assert.deepEqual(scope.points, trace);
});

test("a later airborne trace gap does not erase an already observed departure", () => {
  const trace = [point(1000), point(1060), point(1200, { lat: 43, ground: false, alt: 15000 }),
    point(12000, { lat: 44, ground: false, alt: 30000 })];
  const scope = currentOriginPushTraceScope(trace, origin);
  const latch = { unix: 1050, source: "track_detected" };
  assert.equal(scope.notBeforeUnix, null);
  assert.equal(pushLatchWithinScope(latch, scope), latch);
});

test("sorts source timestamps, supports normalized provider points, and ignores invalid observations", () => {
  const trace = [
    { ...origin, seenAt: actualUnix, onGround: true },
    { ...origin, seenAt: oldParkUnix, onGround: true },
    { ...origin, seenAt: NaN, onGround: true },
    { ...origin, seenAt: oldParkUnix + 1200, lat: NaN },
    { ...origin, seenAt: oldParkUnix + 1500, lat: 42.4, onGround: false, altFt: 5000 },
  ];
  const scope = currentOriginPushTraceScope(trace, origin);
  assert.equal(scope.notBeforeUnix, actualUnix);
  assert.deepEqual(scope.points, [trace[0]]);
  assert.equal(pushParkWithinScope({ seenAt: actualUnix }, scope)?.seenAt, actualUnix);
  assert.equal(pushParkWithinScope({ at: actualUnix - 1 }, scope), null, "cached at values use milliseconds");
});

test("an empty trace cannot revoke a valid park or latch", () => {
  const scope = currentOriginPushTraceScope([], origin);
  const park = { at: oldParkUnix * 1000 };
  const latch = { unix: oldPushUnix, source: "track_detected" };
  assert.equal(scope.notBeforeUnix, null);
  assert.equal(pushParkWithinScope(park, scope), park);
  assert.equal(pushLatchWithinScope(latch, scope), latch);
});

test("UA561 provider OUT associates fresh airborne history instead of the disconnected 11:53 push", () => {
  const airborneUnix = 1791395917.658;
  const trace = [
    ...visits.slice(0, 3),
    point(airborneUnix, { lat: 42.04, ground: false, alt: 1600 }),
  ];
  const scope = currentOriginPushTraceScope(trace, origin, { anchorUnix: actualUnix });
  assert.equal(scope.notBeforeUnix, oldPushUnix + 40 + 0.001);
  assert.equal(scope.boundaryReason, "anchor_segment");
  assert.deepEqual(scope.points, trace.slice(3));
  assert.equal(pushParkWithinScope({ at: oldParkUnix * 1000 }, scope), null);
  assert.equal(pushLatchWithinScope({ unix: oldPushUnix, source: "track_detected" }, scope), null);
  const actual = { unix: actualUnix, source: "provider_actual" };
  assert.equal(pushLatchWithinScope(actual, scope), actual, "the flight actual remains valid before the first fresh trace fix");
  const earlierPhysicalPush = { unix: actualUnix - 360, source: "track_detected" };
  assert.equal(pushLatchWithinScope(earlierPhysicalPush, scope), earlierPhysicalPush,
    "17:30 physical push is not disproved by a trace starting airborne at 17:58");
  const earlierPark = { at: (actualUnix - 900) * 1000 };
  assert.equal(pushParkWithinScope(earlierPark, scope), earlierPark);
  assert.equal(pushLatchWithinScope({ unix: oldPushUnix + 40, source: "track_detected" }, scope), null,
    "the final excluded observation is also rejected");
});

test("anchoring retains a genuine earlier physical push in the actual's continuous segment", () => {
  const trace = [
    ...visits.slice(0, 3),
    point(actualUnix - 3600),
    point(actualUnix - 1800, { lon: -87.9031 }),
    point(actualUnix - 600, { lon: -87.902 }),
    point(actualUnix + 1200, { ground: false, alt: 1500 }),
  ];
  const scope = currentOriginPushTraceScope(trace, origin, { anchorUnix: actualUnix });
  assert.equal(scope.notBeforeUnix, oldPushUnix + 40 + 0.001);
  assert.deepEqual(scope.points, trace.slice(3));
  const track = { unix: actualUnix - 1800, source: "track_detected" };
  assert.equal(pushLatchWithinScope(track, scope), track);
  assert.equal(pushParkWithinScope({ t: actualUnix - 3600 }, scope)?.t, actualUnix - 3600);
});

test("a later disconnected tail segment cannot displace the segment spanning the flight actual", () => {
  const trace = [
    point(actualUnix - 900), point(actualUnix + 300, { lon: -87.9031 }),
    point(actualUnix + 4 * 3600), point(actualUnix + 4 * 3600 + 120),
  ];
  const scope = currentOriginPushTraceScope(trace, origin, { anchorUnix: actualUnix });
  assert.deepEqual(scope.points, trace.slice(0, 2));
  assert.equal(scope.notBeforeUnix, null, "no older competing segment was discarded");
});

test("a distant actual or validated observation cannot associate the only old trace segment", () => {
  for (const anchorUnix of [actualUnix, 1791395917.658]) {
    const scope = currentOriginPushTraceScope(visits.slice(0, 3), origin, { anchorUnix });
    assert.deepEqual(scope.points, []);
    assert.equal(scope.notBeforeUnix, null, "missing observations do not invent an origin visit");
    assert.equal(scope.boundaryReason, null);
  }
});

test("validated current-flight observation can associate the current segment without provider OUT", () => {
  const observedUnix = 1791395917.658;
  const observation = point(observedUnix, { ground: false, alt: 1600 });
  const scope = currentOriginPushTraceScope([...visits.slice(0, 3), observation], origin, { anchorUnix: observedUnix });
  assert.deepEqual(scope.points, [observation]);
  assert.equal(scope.notBeforeUnix, oldPushUnix + 40 + 0.001);
  assert.equal(pushLatchWithinScope({ unix: oldPushUnix, source: "track_detected" }, scope), null);
});

test("association accepts the endpoint gap limit and rejects an anchor just beyond it", () => {
  const trace = [point(1000), point(1100)];
  assert.deepEqual(currentOriginPushTraceScope(trace, origin, { anchorUnix: 3800 }).points, trace);
  assert.deepEqual(currentOriginPushTraceScope(trace, origin, { anchorUnix: 3801 }).points, []);
});

test("future trace and anchor times cannot poison the persistent push scope", () => {
  const nowUnix = actualUnix + 1200;
  const baseline = [point(actualUnix - 100), point(actualUnix, {lon:-87.9031})];
  const future = [point(nowUnix + 60, {lat:43,ground:false,alt:10000}), point(nowUnix + 120)];
  const scoped = currentOriginPushTraceScope([...baseline,...future], origin, {nowUnix,anchorUnix:nowUnix+120});
  assert.deepEqual(scoped.points,baseline); assert.equal(scoped.notBeforeUnix,null);
});
