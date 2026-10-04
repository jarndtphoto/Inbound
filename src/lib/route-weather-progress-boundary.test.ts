import assert from "node:assert/strict";
import { test } from "node:test";
import { haversineNm, interpolateGreatCircle } from "./geo.ts";
import { routeWeatherSegments, type RouteWeatherSegment } from "./route-weather-segments.ts";
import { routeWeatherEvents, weatherEventMarker } from "./weather-events.ts";
import type { RouteSample } from "./types.ts";

function sample(frac: number, overrides: Partial<RouteSample> = {}): RouteSample {
  return { lat: 20 + frac * 20, lon: -158 + frac * 70, frac, distNm: frac * 4000, remainingNm: (1 - frac) * 4000,
    etaMin: frac * 480, chop: "smooth", cloud: false, convective: false, note: null, fix: false, ...overrides };
}
function assertCutoff(segments: RouteWeatherSegment[], progress: number) {
  for (const segment of segments) for (const point of segment.points) {
    assert.ok(segment.past ? point.frac <= progress : point.frac >= progress,
      `${segment.past ? "Flown" : "Projected"} point ${point.frac} crossed progress ${progress}`);
  }
}

test("Sparse route edges stop gray at progress and share an interpolated great-circle boundary", () => {
  const start = sample(0.2), end = sample(0.8);
  const samples = [end, start], original = structuredClone(samples);
  const progress = 0.45, segments = routeWeatherSegments(samples, progress);
  assertCutoff(segments, progress);
  assert.equal(segments.length, 2);
  const boundary = segments[0].points.at(-1)!;
  assert.equal(segments[0].past, true); assert.equal(segments[1].past, false);
  assert.equal(boundary, segments[1].points[0]); assert.equal(boundary.frac, progress);
  const t = (progress - start.frac) / (end.frac - start.frac), expected = interpolateGreatCircle(start, end, t);
  assert.ok(haversineNm(boundary, expected) < 1e-9);
  assert.ok(Math.abs(boundary.lat - (start.lat + (end.lat - start.lat) * t)) > 0.1, "Boundary uses great-circle geometry");
  assert.equal(boundary.distNm, 1800); assert.equal(boundary.remainingNm, 2200); assert.equal(boundary.etaMin, 216);
  assert.deepEqual(samples, original, "Rendering never mutates accepted route samples");
});

test("An exact observed aircraft anchor remains the shared boundary without moving its coordinates", () => {
  const anchor = sample(0.45, { lat: 29.1234567, lon: -132.7654321, fix: true });
  const segments = routeWeatherSegments([sample(0), anchor, sample(1)], anchor.frac);
  assertCutoff(segments, anchor.frac);
  assert.equal(segments[0].points.at(-1), anchor); assert.equal(segments[1].points[0], anchor);
  assert.equal(segments[0].points.at(-1)!.lat, anchor.lat);
  assert.equal(segments[1].points[0].lon, anchor.lon);
  assert.equal(segments.flatMap(s => s.points).filter(p => p.frac === anchor.frac).length, 2);
});

test("Collocated endpoints still split fractions and metrics without reusing entry progress", () => {
  const start = sample(0.2, { lat: 25, lon: -140, fix: true }), end = sample(0.8, { lat: 25, lon: -140 });
  const segments = routeWeatherSegments([start, end], 0.5), boundary = segments[0].points.at(-1)!;
  assertCutoff(segments, 0.5);
  assert.equal(boundary.frac, 0.5); assert.equal(boundary, segments[1].points[0]);
  assert.equal(boundary.lat, 25); assert.equal(boundary.lon, -140); assert.equal(boundary.fix, false);
  assert.ok(Math.abs(boundary.distNm - 2000) < 1e-8);
  assert.ok(Math.abs(boundary.remainingNm - 2000) < 1e-8);
  assert.ok(Math.abs(boundary.etaMin - 240) < 1e-8);
});

test("An interpolated progress boundary keeps entry weather until the original weather transition", () => {
  const entry = sample(0.2, { chop: "moderate", cloud: true, convective: true, note: "PIREP LGT-MOD turbulence", fix: true });
  const transition = sample(0.6, { chop: "severe", note: "MOD-SEV turbulence" }), end = sample(1);
  const segments = routeWeatherSegments([entry, transition, end], 0.4);
  assertCutoff(segments, 0.4);
  const boundary = segments[0].points.at(-1)!;
  assert.equal(boundary, segments[1].points[0]);
  for (const key of ["chop", "cloud", "convective", "note"] as const) assert.equal(boundary[key], entry[key]);
  assert.equal(boundary.fix, false, "Interpolated geometry does not invent a named fix");
  assert.equal(segments[1].intensity, "light-moderate"); assert.equal(segments[1].band, "light");
  assert.equal(segments[1].points.at(-1), transition);
  assert.equal(segments[2].points[0], transition); assert.equal(segments[2].intensity, "moderate-severe");
  const event = routeWeatherEvents([entry, transition, end], 0.4)[0];
  assert.equal(event.startFrac, 0.4);
  assert.deepEqual(weatherEventMarker(event), { lat: boundary.lat, lon: boundary.lon, frac: 0.4, etaMin: boundary.etaMin });
});

test("Progress splitting preserves skipped date-line gaps and never creates a world-spanning stroke", () => {
  const samples = [sample(0, { lon: 170 }), sample(0.4, { lon: 179 }), sample(0.6, { lon: -179 }), sample(1, { lon: -170 })];
  for (const progress of [0.2, 0.4, 0.5, 0.6, 0.8]) {
    const segments = routeWeatherSegments(samples, progress);
    assertCutoff(segments, progress);
    for (const segment of segments) for (let i = 1; i < segment.points.length; i++) {
      assert.ok(Math.abs(segment.points[i].lon - segment.points[i - 1].lon) <= 180);
    }
    if (progress === 0.5) assert.ok(segments.every(s => s.points.every(p => p.frac !== progress)), "No boundary is invented inside the disconnected gap");
  }
});

test("Progress endpoints and duplicate fractions preserve the cutoff without extra interpolation", () => {
  const samples = [sample(0), sample(0.5), sample(0.5, { chop: "light" }), sample(1)];
  for (const progress of [0, 0.25, 0.5, 0.75, 1]) assertCutoff(routeWeatherSegments(samples, progress), progress);
  assert.ok(routeWeatherSegments(samples, 0).every(s => !s.past));
  assert.ok(routeWeatherSegments(samples, 1).filter(s => !s.past).every(s => s.points.every(p => p.frac === 1)));
  const uncut = routeWeatherSegments(samples);
  assert.ok(uncut.every(s => !s.past));
  assert.ok(uncut.flatMap(s => s.points).every(p => samples.includes(p)), "Default forecast mode adds no boundary samples");
});
