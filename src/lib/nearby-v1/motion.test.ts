import { test } from "node:test";
import assert from "node:assert/strict";
import { haversineNm } from "../geo";
import { NEARBY_POLICY } from "./model";
import { deriveNearbyDisplayPosition, type NearbyMotionAnchor } from "./motion";

const NOW = Date.UTC(2026, 9, 3, 22, 42);
function anchor(overrides: Partial<NearbyMotionAnchor> = {}): NearbyMotionAnchor {
  return { latitude: 0, longitude: 0, altitudeFt: 10_000, groundspeedKt: 360, groundTrackDeg: 90,
    observedAt: new Date(NOW).toISOString(), onGround: false, positionKind: "observed", acceptedPosition: true, ...overrides };
}
function at(seconds: number, overrides: Partial<NearbyMotionAnchor> = {}) {
  const result = deriveNearbyDisplayPosition(anchor(overrides), NOW + seconds * 1_000); assert.ok(result); return result;
}
function distanceFromStart(position: { latitude: number; longitude: number }) {
  return haversineNm({ lat: 0, lon: 0 }, { lat: position.latitude, lon: position.longitude });
}
test("Nearby display motion uses accepted ground track and knots with spherical distance", () => {
  const east = at(10); assert.equal(east.kind, "extrapolated"); assert.equal(east.extrapolatedSeconds, 10);
  assert.ok(Math.abs(distanceFromStart(east) - 1) < 1e-9);
  assert.ok(Math.abs(east.latitude) < 1e-9); assert.ok(east.longitude > 0);
  const north = at(10, { groundTrackDeg: 0 }); assert.ok(north.latitude > 0); assert.ok(Math.abs(north.longitude) < 1e-9);
  const south = at(10, { groundTrackDeg: 180 }); assert.ok(south.latitude < 0);
  const west = at(10, { groundTrackDeg: 270 }); assert.ok(west.longitude < 0);
});
test("Spherical extrapolation remains bounded and wraps the antimeridian at high latitude", () => {
  const input = anchor({ latitude: 80, longitude: 179.99, groundspeedKt: 450 });
  const result = deriveNearbyDisplayPosition(input, NOW + 25_000)!;
  assert.ok(result.longitude < -179); assert.ok(result.latitude < 80);
  assert.ok(Math.abs(haversineNm({ lat: input.latitude, lon: input.longitude }, { lat: result.latitude, lon: result.longitude }) - 3.125) < 1e-8);
  assert.ok(result.latitude >= -90 && result.latitude <= 90 && result.longitude >= -180 && result.longitude <= 180);
});
test("Prediction stops at 25 seconds and stays fixed through stale and expired telemetry", () => {
  assert.equal(NEARBY_POLICY.maxExtrapolationMs, 25_000);
  assert.equal(at(24.999).stopped, false);
  const stopped = at(25); assert.equal(stopped.stopped, true); assert.equal(stopped.freshness.state, "fresh");
  for (const seconds of [30, 45, 45.001, 120, 120.001, 1_000_000]) {
    const result = at(seconds); assert.equal(result.stopped, true); assert.equal(result.extrapolatedSeconds, 25);
    assert.equal(result.latitude, stopped.latitude); assert.equal(result.longitude, stopped.longitude);
  }
  assert.equal(at(45.001).freshness.state, "stale"); assert.equal(at(120.001).freshness.state, "expired");
  assert.equal(at(45.001).freshness.ageSeconds, 45.001);
});
test("Missing or invalid motion, unknown ground state and derived anchors never extrapolate", () => {
  const invalid: Partial<NearbyMotionAnchor>[] = [
    { groundspeedKt: null }, { groundspeedKt: 0 }, { groundspeedKt: -1 }, { groundspeedKt: NaN }, { groundspeedKt: Infinity }, { groundspeedKt: 1_501 },
    { groundTrackDeg: null }, { groundTrackDeg: -1 }, { groundTrackDeg: 360 }, { groundTrackDeg: NaN }, { groundTrackDeg: Infinity },
    { onGround: true }, { onGround: null }, { acceptedPosition: false }, { positionKind: "synthetic" }, { positionKind: "extrapolated" },
  ];
  for (const override of invalid) {
    const result = at(20, override); assert.equal(result.kind, "accepted", JSON.stringify(override));
    assert.equal(result.latitude, 0); assert.equal(result.longitude, 0); assert.equal(result.extrapolatedSeconds, 0); assert.equal(result.stopped, true);
  }
});
test("Invalid anchor/time has no display position and tolerated clock skew cannot move backward", () => {
  for (const override of [{ latitude: 91 }, { longitude: NaN }, { observedAt: "invalid" }, { observedAt: new Date(NOW + 1_001).toISOString() }]) {
    assert.equal(deriveNearbyDisplayPosition(anchor(override), NOW), null);
  }
  assert.equal(deriveNearbyDisplayPosition(anchor(), NaN), null);
  const future = deriveNearbyDisplayPosition(anchor({ observedAt: new Date(NOW + 1_000).toISOString() }), NOW)!;
  assert.equal(future.extrapolatedSeconds, 0); assert.equal(future.latitude, 0); assert.equal(future.longitude, 0);
});
test("A new authoritative fix replaces a large prediction disagreement without mutation or vertical invention", () => {
  const input = anchor(); const original = structuredClone(input); Object.freeze(input);
  const predicted = deriveNearbyDisplayPosition(input, NOW + 25_000)!;
  assert.deepEqual(input, original); assert.equal(predicted.altitudeFt, input.altitudeFt);
  const corrected = anchor({ latitude: 42, longitude: -88, observedAt: new Date(NOW + 30_000).toISOString(), groundspeedKt: null, altitudeFt: null });
  const display = deriveNearbyDisplayPosition(corrected, NOW + 35_000)!;
  assert.equal(display.latitude, 42); assert.equal(display.longitude, -88); assert.equal(display.kind, "accepted"); assert.equal(display.altitudeFt, null);
  assert.ok(haversineNm({ lat: predicted.latitude, lon: predicted.longitude }, { lat: display.latitude, lon: display.longitude }) > 1_000);
});
